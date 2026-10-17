// Contract: docs/BLUEPRINT.md F-011. Melee against one target the caller picked; it never picks targets itself.
import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { checkTarget, CombatRules, DEFAULT_COMBAT_RULES, TargetRules } from './threats.js';
import type { Policy } from './policy.js';
import { delay } from './task-manager.js';
import { BotEntity, entityLabel, metadataValue, refreshEntity } from '../tools/entity-utils.js';
import { stopPathfinder } from '../tools/movement-utils.js';

export type CombatOutcome = 'killed' | 'lost' | 'out_of_range' | 'retreated' | 'cancelled' | 'illegal_target';

export interface CombatResult {
  outcome: CombatOutcome;
  attacks: number;
  durationMs: number;
  /** Why the fight ended, for progress reports. */
  detail: string;
  /** Where the target was last seen, e.g. to pick up its drops. */
  lastPosition: Vec3;
}

export interface EngageOptions {
  signal?: AbortSignal;
  /** Ends the fight early with outcome `cancelled`, e.g. when the task is paused. Checked every tick. */
  shouldStop?: () => boolean;
  /** The fight ends as `out_of_range` once the target is further than this from the anchor (default 16). */
  maxChase?: number;
  /** Where the chase distance is measured from, e.g. the guard post (default: where the bot stood when the fight began). */
  anchor?: () => Vec3;
  /** The fight ends as `retreated` once the bot's health is at or below this (default 6). */
  retreatHealth?: number;
  rules?: TargetRules;
}

export const ATTACK_REACH = 3;
export const DEFAULT_MAX_CHASE = 16;
// Tentative defaults until the scenario tests tune them (BLUEPRINT F-011). M3 reads them from the policy.
export const DEFAULT_RETREAT_HEALTH = 6;
const TICK_MS = 50;
const STUCK_MS = 5000;
const MIN_APPROACH_PROGRESS = 0.5;
const FOLLOW_RANGE = 2;
// A target that vanishes this close, soon after a hit, died; one that vanishes further away walked out of view.
const KILL_CONFIRM_DISTANCE = 6;
const KILL_CONFIRM_MS = 3000;
// Swinging at a target that never gets hurt (e.g. a creaking, or a protected mob) is given up on after this long.
const NO_DAMAGE_MS = 10000;
const BARE_HAND = { damage: 1, speed: 4 };
// A full-strength, grounded sword hit also sweeps everything within 1 block of the target (vanilla: the target's box
// grown by 1 x 0.25 x 1, and within 3 blocks of the attacker).
const SWEEP_MARGIN = 1;
const SWEEP_VERTICAL_MARGIN = 0.25;
const SWEEP_REACH = 3;
const NON_LIVING_TYPES = new Set(['object', 'orb', 'projectile', 'other', 'global']);

const SWORD_DAMAGE: Record<string, number> = { wooden: 4, golden: 4, stone: 5, copper: 5, iron: 6, diamond: 7, netherite: 8 };
const AXE_DAMAGE: Record<string, number> = { wooden: 7, golden: 7, stone: 9, copper: 9, iron: 9, diamond: 9, netherite: 10 };
const AXE_SPEED: Record<string, number> = { wooden: 0.8, golden: 1, stone: 0.8, copper: 0.8, iron: 0.9, diamond: 1, netherite: 1 };

/**
 * Attack damage and attacks per second of a held item. minecraft-data has no attack speed, so this is a table of
 * the vanilla values; anything that is not a sword, axe or trident hits like a bare hand.
 */
export function weaponStats(itemName: string | undefined): { damage: number; speed: number } {
  if (!itemName) return BARE_HAND;
  if (itemName === 'trident') return { damage: 9, speed: 1.1 };
  const match = /^(wooden|golden|stone|copper|iron|diamond|netherite)_(sword|axe)$/.exec(itemName);
  if (!match) return BARE_HAND;
  const [, material, kind] = match;
  return kind === 'sword'
    ? { damage: SWORD_DAMAGE[material], speed: 1.6 }
    : { damage: AXE_DAMAGE[material], speed: AXE_SPEED[material] };
}

/** Minimum time between two hits so each lands at full strength, rounded up to whole ticks. */
export function attackCooldownMs(itemName: string | undefined): number {
  return Math.ceil(1000 / weaponStats(itemName).speed / TICK_MS) * TICK_MS;
}

function dps(itemName: string | undefined): number {
  const { damage, speed } = weaponStats(itemName);
  return damage * speed;
}

/** The policy's combat settings, read fresh for each fight; the defaults when no policy is wired in. */
export function combatSettings(policy?: () => Policy): { retreatHealth: number; rules: CombatRules } {
  const combat = policy?.().combat;
  return {
    retreatHealth: combat?.retreatHealth ?? DEFAULT_RETREAT_HEALTH,
    rules: { attackPlayers: combat?.attackPlayers ?? DEFAULT_COMBAT_RULES.attackPlayers, avoidNeutral: combat?.avoidNeutral ?? DEFAULT_COMBAT_RULES.avoidNeutral }
  };
}

/** The melee weapon the bot would fight with (what equipBestWeapon picks), or 'bare hand'. */
export function bestWeaponName(bot: mineflayer.Bot): string {
  const names = [bot.heldItem?.name, ...bot.inventory.items().map(item => item.name)].filter((name): name is string => Boolean(name));
  const best = names.filter(name => dps(name) > dps(undefined)).sort((a, b) => dps(b) - dps(a))[0];
  return best ?? 'bare hand';
}

export function isSword(itemName: string | undefined): boolean {
  return Boolean(itemName?.endsWith('_sword'));
}

/**
 * Hold the best melee weapon in the inventory. With `allowSword: false` a held sword is swapped for the best
 * other weapon, or put away. Failing to equip is not an error: the bot fights with what it has.
 */
export async function equipBestWeapon(bot: mineflayer.Bot, { allowSword = true } = {}): Promise<void> {
  try {
    const held = bot.heldItem?.name;
    const best = bot.inventory.items()
      .filter(item => dps(item.name) > dps(undefined) && (allowSword || !isSword(item.name)))
      .sort((a, b) => dps(b.name) - dps(a.name))[0];
    const mustSwap = !allowSword && isSword(held);
    if (best && (mustSwap || dps(best.name) > dps(held))) {
      await bot.equip(best, 'hand');
    } else if (mustSwap) {
      await bot.unequip('hand');
    }
  } catch {
    // Keep fighting with whatever is in hand.
  }
}

// mineflayer keeps the base size from minecraft-data, but slimes and magma cubes grow with their size (1, 2 or 4).
function entitySize(bot: mineflayer.Bot, entity: BotEntity): { width: number; height: number } {
  let width = entity.width ?? 0.6;
  let height = entity.height ?? 1.8;
  if (entity.name === 'slime' || entity.name === 'magma_cube') {
    const size = metadataValue(bot, entity, 'size');
    if (typeof size === 'number' && size > 0) {
      width *= size;
      height *= size;
    }
  }
  return { width, height };
}

/** Entities other than legal targets that a sword sweep at `target` would also hit, e.g. the player being guarded. */
export function sweepBystanders(bot: mineflayer.Bot, target: BotEntity, rules?: TargetRules): BotEntity[] {
  const targetSize = entitySize(bot, target);
  const reachX = targetSize.width / 2 + SWEEP_MARGIN;
  const bottom = target.position.y - SWEEP_VERTICAL_MARGIN;
  const top = target.position.y + targetSize.height + SWEEP_VERTICAL_MARGIN;
  return Object.values(bot.entities ?? {}).filter(entity => {
    try {
      if (!entity?.position || entity === bot.entity || entity.id === target.id || entity.isValid === false) return false;
      if (NON_LIVING_TYPES.has(entity.type) || entity.name === 'item' || entity.name === 'experience_orb') return false;
      // Players are never acceptable sweep collateral, even with attackPlayers on: only the chosen target may be hit.
      if (checkTarget(bot, entity, { ...DEFAULT_COMBAT_RULES, ...rules, attackPlayers: false }).legal) return false;
      const size = entitySize(bot, entity);
      const half = size.width / 2;
      if (Math.abs(entity.position.x - target.position.x) > reachX + half) return false;
      if (Math.abs(entity.position.z - target.position.z) > reachX + half) return false;
      if (entity.position.y > top || entity.position.y + size.height < bottom) return false;
      return bot.entity.position.distanceTo(entity.position) < SWEEP_REACH;
    } catch {
      // Unknown data: assume it could be hit.
      return true;
    }
  });
}

// The entity each bot is fighting right now, so self-defense stays out of a fight a task is already having.
const activeTargets = new WeakMap<mineflayer.Bot, number>();

export function currentCombatTarget(bot: mineflayer.Bot): number | undefined {
  return activeTargets.get(bot);
}

export async function engage(bot: mineflayer.Bot, target: BotEntity, options: EngageOptions = {}): Promise<CombatResult> {
  const started = Date.now();
  const startPosition = bot.entity.position.clone();
  const anchor = options.anchor ?? (() => startPosition);
  const maxChase = options.maxChase ?? DEFAULT_MAX_CHASE;
  const retreatHealth = options.retreatHealth ?? DEFAULT_RETREAT_HEALTH;
  const label = `${entityLabel(target)} (id ${target.id})`;

  let attacks = 0;
  let lastAttackAt = -Infinity;
  let lastPosition = target.position.clone();
  let lastDistance = bot.entity.position.distanceTo(target.position);
  let bestDistance = lastDistance;
  let lastProgressAt = started;
  let goal: InstanceType<typeof goals.GoalFollow> | null = null;
  let died = false;
  // Only real bots report hurt events; without them the no-damage check stays off.
  const seesHurt = typeof bot.on === 'function';
  // When the current run of hits without the target getting hurt began; any hurt event or chase resets it.
  let unhurtSince: number | null = null;

  const onDead = (entity: BotEntity) => {
    if (entity?.id === target.id) died = true;
  };
  const onHurt = (entity: BotEntity) => {
    if (entity?.id === target.id) unhurtSince = null;
  };
  bot.on?.('entityDead', onDead);
  bot.on?.('entityHurt', onHurt);
  activeTargets.set(bot, target.id);

  const end = (outcome: CombatOutcome, detail: string): CombatResult => {
    if (activeTargets.get(bot) === target.id) activeTargets.delete(bot);
    bot.removeListener?.('entityDead', onDead);
    bot.removeListener?.('entityHurt', onHurt);
    // A cancelled fight no longer owns the body: after a pause it belongs to a manual command or reflex, and a
    // cancelled task is stopped by the task manager. Stopping here would break their pathfinder goal (G1, G4).
    if (outcome !== 'cancelled') {
      try {
        stopPathfinder(bot);
        bot.clearControlStates();
      } catch {
        // Nothing left to stop.
      }
    }
    return { outcome, attacks, durationMs: Date.now() - started, detail, lastPosition };
  };
  const stopped = () => Boolean(options.signal?.aborted || options.shouldStop?.());

  const first = checkTarget(bot, target, options.rules);
  if (!first.legal) return end('illegal_target', first.reason);

  const heldBefore = bot.heldItem?.name;
  await equipBestWeapon(bot, { allowSword: sweepBystanders(bot, target, options.rules).length === 0 });
  let cooldownMs = attackCooldownMs(bot.heldItem?.name);
  // Switching items resets the attack strength: the first hit waits a full cooldown too.
  if (bot.heldItem?.name !== heldBefore) lastAttackAt = Date.now();

  for (;;) {
    if (stopped()) return end('cancelled', `stopped fighting ${label}`);

    const live = refreshEntity(bot, target);
    if (!live) {
      const recentHit = attacks > 0 && Date.now() - lastAttackAt <= KILL_CONFIRM_MS && lastDistance <= KILL_CONFIRM_DISTANCE;
      return died || recentHit
        ? end('killed', `killed ${label} with ${attacks} hit(s)`)
        : end('lost', `lost sight of ${label}`);
    }
    lastPosition = live.position.clone();

    const legality = checkTarget(bot, live, options.rules);
    if (!legality.legal) return end('illegal_target', legality.reason);
    if (typeof bot.health === 'number' && bot.health <= retreatHealth) {
      return end('retreated', `health ${bot.health} is at or below ${retreatHealth}; disengaged from ${label}`);
    }
    if (live.position.distanceTo(anchor()) > maxChase) {
      return end('out_of_range', `${label} got more than ${maxChase} blocks away`);
    }

    const now = Date.now();
    const distance = bot.entity.position.distanceTo(live.position);
    lastDistance = distance;
    if (distance <= ATTACK_REACH) {
      if (now - lastAttackAt >= cooldownMs) {
        // Never sweep a player, a pet or a neutral mob standing next to the target: fight without a sword then.
        const crowded = sweepBystanders(bot, live, options.rules).length > 0;
        const before = bot.heldItem?.name;
        await equipBestWeapon(bot, { allowSword: !crowded });
        if (stopped()) return end('cancelled', `stopped fighting ${label}`);
        const held = bot.heldItem?.name;
        if (held !== before) {
          // Switching items resets the attack strength, so wait a full cooldown with the new item.
          cooldownMs = attackCooldownMs(held);
          lastAttackAt = Date.now();
          lastProgressAt = lastAttackAt;
          continue;
        }
        if (crowded && isSword(held)) {
          // The sword could not be put away; hold fire rather than sweep a bystander.
          await delay(TICK_MS, options.signal ?? new AbortController().signal).catch(() => {});
          continue;
        }
        try {
          await bot.lookAt(live.position.offset(0, (live.height ?? 1) * 0.9, 0), true);
        } catch {
          // Attack anyway; the server only checks the distance.
        }
        if (stopped()) return end('cancelled', `stopped fighting ${label}`);
        // Someone may have stepped next to the target while the equip or look was awaited.
        if (isSword(bot.heldItem?.name) && sweepBystanders(bot, live, options.rules).length > 0) continue;
        bot.attack(live);
        attacks++;
        lastAttackAt = Date.now();
        unhurtSince ??= lastAttackAt;
        lastProgressAt = lastAttackAt;
        // Knockback pushes the target away; measure the next approach from scratch.
        bestDistance = Infinity;
      }
    } else {
      unhurtSince = null;
      if (!goal || bot.pathfinder.goal !== goal) {
        goal = new goals.GoalFollow(live, FOLLOW_RANGE);
        bot.pathfinder.setGoal(goal, true);
      }
      if (distance < bestDistance - MIN_APPROACH_PROGRESS) {
        bestDistance = distance;
        lastProgressAt = now;
      }
    }
    // Neither hitting nor getting closer for a while means the pathfinder cannot reach the target.
    if (now - lastProgressAt > STUCK_MS) return end('lost', `could not reach ${label} (${distance.toFixed(1)} blocks away)`);
    if (seesHurt && unhurtSince !== null && now - unhurtSince > NO_DAMAGE_MS) {
      return end('lost', `${attacks} hit(s) did not hurt ${label}`);
    }

    try {
      await delay(TICK_MS, options.signal ?? new AbortController().signal);
    } catch {
      return end('cancelled', `stopped fighting ${label}`);
    }
  }
}
