import { z } from "zod";
import type { Bot } from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import type { Autopilot } from '../autopilot/autopilot.js';
import { CombatRules, DEFAULT_COMBAT_RULES, TargetRules, checkTarget, isPlayer, isTamed } from '../autopilot/threats.js';
import { isSword, sweepBystanders } from '../autopilot/combat.js';
import { BotEntity, describeEntity, entityLabel, findNearbyEntities, formatPosition, resolveTargetEntity } from './entity-utils.js';

type Entity = ReturnType<Bot['nearestEntity']>;

const MAX_ATTACK_REACH = 4.5;
const ATTACK_INTERVAL_MS = 650;
const ATTACK_SETTLE_MS = 400;
const MAX_ATTACKS = 20;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function registerEntityTools(factory: ToolFactory, getBot: () => Bot, getAutopilot?: () => Autopilot | null): void {
  // Read at every hit, so a set-policy during a sequence applies to the next hit. Without the Autopilot (tests) the
  // defaults apply, which never attack players.
  const combatRules = (): CombatRules => getAutopilot?.()?.policy.get().combat ?? DEFAULT_COMBAT_RULES;

  // A target picked by id, or by a type that is its whole name (any case), is named explicitly, so passive and neutral
  // mobs of that type may be attacked (F-010, as hunt names its prey). 'mob', 'hostile' or part of a name ('piglin'
  // also matches zombified_piglin) names nothing: passive mobs are left alone and neutral ones follow avoidNeutral.
  // `type` is undefined for a target picked by id.
  const targetRules = (target: BotEntity, type: string | undefined): TargetRules => {
    const { attackPlayers, avoidNeutral } = combatRules();
    const name = target.name;
    const named = name !== undefined && name !== '' && (type === undefined || name.toLowerCase() === type.toLowerCase());
    return { attackPlayers, avoidNeutral, allowTypes: named ? [name] : [] };
  };

  // Invariant I1: players only when the policy turned attackPlayers on; tamed animals never, since checkTarget tests
  // that before the named types and there is no way to force it (E-022). The reason is checkTarget's own wording. A
  // target that is already gone is not refused: the sequence ends with "target is gone" as before.
  const targetRefusal = (bot: Bot, target: BotEntity, type: string | undefined): string | null => {
    if (target.isValid === false) return null;
    const check = checkTarget(bot, target, targetRules(target, type));
    return check.legal ? null : check.reason;
  };

  // A sword hit also sweeps whoever stands next to the target. Only players (even with attackPlayers on) and tamed
  // animals hold it back; neutral and passive mobs do not, unlike combat.ts. The tool never swaps the weapon.
  const sweepRefusal = (bot: Bot, target: BotEntity, type: string | undefined): string | null => {
    if (!isSword(bot.heldItem?.name)) return null;
    const hit = sweepBystanders(bot, target, targetRules(target, type))
      .filter(entity => {
        try {
          return isPlayer(entity) || isTamed(bot, entity);
        } catch {
          // Unreadable data could be a pet.
          return true;
        }
      })
      .sort((a, b) => a.position.distanceTo(target.position) - b.position.distanceTo(target.position))[0];
    return hit
      ? `${entityLabel(hit)} is next to ${entityLabel(target)}; a sword sweep would hit it too. Hold a non-sword item (equip-item) or wait until they move apart`
      : null;
  };

  // By type: the nearest match the bot may attack, so a pet or a player nearer the bot does not stand in for the target.
  // null when nothing matches (gone entities do not count), which leaves resolveTargetEntity's usual reply.
  const nearestLegal = (bot: Bot, type: string): { entity: BotEntity } | { error: string } | null => {
    let nearestReason: string | null = null;
    for (const { entity } of findNearbyEntities(bot, { type, maxDistance: MAX_ATTACK_REACH })) {
      if (entity.isValid === false) continue;
      const check = checkTarget(bot, entity, targetRules(entity, type));
      if (check.legal) return { entity };
      nearestReason ??= check.reason;
    }
    return nearestReason === null ? null : { error: `No ${type} the bot may attack within ${MAX_ATTACK_REACH} blocks: ${nearestReason}` };
  };

  factory.registerTool(
    "find-entity",
    "Find the nearest entity of a specific type",
    {
      type: z.string().optional().describe("Type of entity to find (empty for any entity)"),
      maxDistance: z.coerce.number().finite().optional().describe("Maximum search distance (default: 16)")
    },
    async ({ type = '', maxDistance = 16 }) => {
      const bot = getBot();
      const entityFilter = (entity: NonNullable<Entity>) => {
        if (!type) return true;
        if (type === 'player') return entity.type === 'player';
        if (type === 'mob') return entity.type === 'mob';
        return Boolean(entity.name && entity.name.includes(type.toLowerCase()));
      };

      const entity = bot.nearestEntity(entityFilter);

      if (!entity || bot.entity.position.distanceTo(entity.position) > maxDistance) {
        return factory.createResponse(`No ${type || 'entity'} found within ${maxDistance} blocks`);
      }

      return factory.createResponse(`Found ${entityLabel(entity)} at position (${Math.floor(entity.position.x)}, ${Math.floor(entity.position.y)}, ${Math.floor(entity.position.z)})`);
    }
  );

  factory.registerTool(
    "list-entities",
    "List entities near the bot (mobs, animals, players, dropped items), nearest first",
    {
      type: z.string().optional().describe("Filter: 'player', 'mob', 'hostile', or part of an entity name such as 'zombie' or 'item' (empty for all)"),
      maxDistance: z.coerce.number().finite().positive().optional().describe("Maximum search distance (default: 32)"),
      limit: z.coerce.number().int().min(1).max(100).optional().describe("Maximum number of entities to return (default: 20, max: 100)")
    },
    async ({ type = '', maxDistance = 32, limit = 20 }) => {
      const bot = getBot();
      const nearby = findNearbyEntities(bot, { type, maxDistance });

      if (nearby.length === 0) {
        return factory.createResponse(`No ${type || 'entity'} found within ${maxDistance} blocks`);
      }

      const shown = nearby.slice(0, limit);
      let output = `Found ${nearby.length} ${type || 'entity'}(s) within ${maxDistance} blocks`;
      output += shown.length < nearby.length ? ` (showing nearest ${shown.length}):\n\n` : ':\n\n';
      shown.forEach(item => {
        output += `- ${describeEntity(item)}\n`;
      });

      return factory.createResponse(output);
    }
  );

  factory.registerTool(
    "list-players",
    "List players currently online on the server, with distance for those within render range",
    {},
    async () => {
      const bot = getBot();
      const players = Object.values(bot.players ?? {}).filter(player => player.username !== bot.username);

      if (players.length === 0) {
        return factory.createResponse("No other players online");
      }

      let output = `${players.length} other player(s) online:\n\n`;
      players.forEach(player => {
        let line = `- ${player.username} (ping ${player.ping}ms)`;
        if (player.entity) {
          const distance = bot.entity.position.distanceTo(player.entity.position);
          line += `, at ${formatPosition(player.entity.position)}, ${distance.toFixed(1)} blocks away`;
        } else {
          line += ", not in range";
        }
        output += `${line}\n`;
      });

      return factory.createResponse(output);
    }
  );

  factory.registerTool(
    "attack-entity",
    "Attack an entity (by id from list-entities, or the nearest one matching a type/name). The target must be within reach; move closer first if needed. Never hits players (unless combat.attackPlayers is on) or tamed animals, and holds back a sword hit whose sweep would reach them",
    {
      entityId: z.coerce.number().int().optional().describe("Entity id from list-entities"),
      type: z.string().optional().describe("If no entityId is given, attack the nearest entity matching this type/name (e.g. 'zombie')"),
      times: z.coerce.number().int().min(1).max(MAX_ATTACKS).optional().describe(`Number of attacks, stops early if the target dies (default: 1, max: ${MAX_ATTACKS})`)
    },
    async ({ entityId, type = '', times = 1 }) => {
      const bot = getBot();
      // The type the target was picked by; undefined when it was picked by id (an id wins over a type, as before).
      const pickedBy = entityId === undefined && type ? type : undefined;

      const picked = pickedBy === undefined ? null : nearestLegal(bot, pickedBy);
      if (picked && 'error' in picked) return factory.createErrorResponse(picked.error);
      const resolved = picked ?? resolveTargetEntity(bot, { entityId, type, maxDistance: MAX_ATTACK_REACH });
      if ('error' in resolved) {
        return factory.createErrorResponse(
          entityId === undefined && type ? `${resolved.error}. Move closer first` : resolved.error
        );
      }
      const target = resolved.entity;
      // Before the reach check, so an illegal target out of reach is refused rather than sent closer.
      const refused = targetRefusal(bot, target, pickedBy);
      if (refused) return factory.createErrorResponse(`${refused}; attack-entity did not attack`);

      const label = entityLabel(target);
      let attacks = 0;
      let stopped = '';
      // A function, so the check after the awaited look is not narrowed away by the one at the top of the loop.
      const gone = () => target.isValid === false;
      for (let i = 0; i < times; i++) {
        if (target.isValid === false) break;

        const distance = bot.entity.position.distanceTo(target.position);
        if (distance > MAX_ATTACK_REACH) {
          if (attacks === 0) {
            return factory.createErrorResponse(`${label} is ${distance.toFixed(1)} blocks away, beyond reach (${MAX_ATTACK_REACH}). Move closer first`);
          }
          break;
        }

        await bot.lookAt(target.position.offset(0, (target.height ?? 1) * 0.9, 0), true);
        // A target that vanished during the look ends the sequence as before; it is not a refusal.
        if (gone()) break;
        // The policy may have changed since the last hit (or during the look), the target may have been tamed, or
        // someone may have stepped next to it: checked again right before each hit, as combat.ts does.
        const reason = targetRefusal(bot, target, pickedBy) ?? sweepRefusal(bot, target, pickedBy);
        if (reason) {
          if (attacks === 0) return factory.createErrorResponse(`${reason}; attack-entity did not attack`);
          stopped = `stopped: ${reason}; `;
          break;
        }
        bot.attack(target);
        attacks++;

        if (i < times - 1) await sleep(ATTACK_INTERVAL_MS);
      }

      await sleep(ATTACK_SETTLE_MS);
      const defeated = target.isValid === false;
      return factory.createResponse(
        `Attacked ${label} (id ${target.id}) ${attacks} time(s); ${stopped}${defeated ? 'target is gone (killed or out of range)' : 'target is still alive'}`
      );
    }
  );
}
