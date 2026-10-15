import { z } from "zod";
import type { Bot } from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import { describeEntity, entityLabel, findNearbyEntities, formatPosition, resolveTargetEntity } from './entity-utils.js';

type Entity = ReturnType<Bot['nearestEntity']>;

const MAX_ATTACK_REACH = 4.5;
const ATTACK_INTERVAL_MS = 650;
const ATTACK_SETTLE_MS = 400;
const MAX_ATTACKS = 20;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function registerEntityTools(factory: ToolFactory, getBot: () => Bot): void {
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
    "Attack an entity (by id from list-entities, or the nearest one matching a type/name). The target must be within reach; move closer first if needed",
    {
      entityId: z.coerce.number().int().optional().describe("Entity id from list-entities"),
      type: z.string().optional().describe("If no entityId is given, attack the nearest entity matching this type/name (e.g. 'zombie')"),
      times: z.coerce.number().int().min(1).max(MAX_ATTACKS).optional().describe(`Number of attacks, stops early if the target dies (default: 1, max: ${MAX_ATTACKS})`)
    },
    async ({ entityId, type = '', times = 1 }) => {
      const bot = getBot();

      const resolved = resolveTargetEntity(bot, { entityId, type, maxDistance: MAX_ATTACK_REACH });
      if ('error' in resolved) {
        return factory.createErrorResponse(
          entityId === undefined && type ? `${resolved.error}. Move closer first` : resolved.error
        );
      }
      const target = resolved.entity;

      const label = entityLabel(target);
      let attacks = 0;
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
        bot.attack(target);
        attacks++;

        if (i < times - 1) await sleep(ATTACK_INTERVAL_MS);
      }

      await sleep(ATTACK_SETTLE_MS);
      const defeated = target.isValid === false;
      return factory.createResponse(
        `Attacked ${label} (id ${target.id}) ${attacks} time(s); ${defeated ? 'target is gone (killed or out of range)' : 'target is still alive'}`
      );
    }
  );
}
