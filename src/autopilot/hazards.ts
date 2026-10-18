// Contract: docs/BLUEPRINT.md F-036. Pure reads of the bot's surroundings: fire, lava, water and the ways out of
// them. No movement, no decisions, no network; cheap enough to run on every tick.
import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { isPassable, isWaterLike } from '../tools/terrain-utils.js';

export type Block = NonNullable<ReturnType<mineflayer.Bot['blockAt']>>;

export const HAZARD_BLOCKS = new Set([
  'lava', 'fire', 'soul_fire', 'magma_block', 'campfire', 'soul_campfire', 'cactus', 'sweet_berry_bush',
  'wither_rose', 'powder_snow', 'pointed_dripstone'
]);
// Blocks that would fall back into the hole if the bot dug out under them.
export const FALLING_BLOCKS = new Set(['sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel', 'anvil']);

const WATER_SEARCH_RADIUS = 8;
const SAFE_SPOT_RADIUS = 5;
const WATER_SCAN_UP = 8;
const AIR_POCKET_RADIUS = 8;
const ON_FIRE_FLAG = 0x01;

export function isHazard(block: Block | null | undefined): boolean {
  return Boolean(block && HAZARD_BLOCKS.has(block.name));
}

export function isWater(block: Block | null | undefined): boolean {
  return isWaterLike(block ?? null);
}

/** Yaw that faces along a horizontal direction (mineflayer: 0 faces north, -z). */
export function yawToward(direction: Vec3): number {
  return Math.atan2(-direction.x, -direction.z);
}

export function headInWater(bot: mineflayer.Bot): boolean {
  return isWater(bot.blockAt(bot.entity.position.floored().offset(0, 1, 0)));
}

export function inLavaNow(bot: mineflayer.Bot): boolean {
  const feet = bot.entity.position.floored();
  return bot.blockAt(feet)?.name === 'lava' || bot.blockAt(feet.offset(0, 1, 0))?.name === 'lava';
}

export function burningNow(bot: mineflayer.Bot): boolean {
  const flags = (bot.entity.metadata as unknown[] | undefined)?.[0];
  return typeof flags === 'number' && (flags & ON_FIRE_FLAG) !== 0;
}

export function touchingFire(bot: mineflayer.Bot): boolean {
  const feet = bot.entity.position.floored();
  return [feet, feet.offset(0, 1, 0), feet.offset(0, -1, 0)].some(pos => {
    const block = bot.blockAt(pos);
    return isHazard(block) && block?.name !== 'cactus';
  });
}

// Water searches are cached per block the bot stands on: they may run every tick while the bot burns.
const WATER_CACHE_MS = 1000;
const waterCache = new WeakMap<mineflayer.Bot, { key: string; time: number; water: Vec3 | null }>();
// Water the bot just failed to reach (behind a wall, below the floor) is ignored for a while, so it is not offered
// again and again while the fire burns out.
const UNREACHABLE_WATER_MS = 15000;
const unreachableWater = new WeakMap<mineflayer.Bot, { position: Vec3; until: number }>();

/** The nearest water block within 8 blocks (a bounded scan; mineflayer's findBlock scans whole chunk sections). */
export function nearestWater(bot: mineflayer.Bot): Vec3 | null {
  const feet = bot.entity.position.floored();
  const key = feet.toString();
  const now = Date.now();
  const cached = waterCache.get(bot);
  if (cached && cached.key === key && now - cached.time < WATER_CACHE_MS) return cached.water;

  let best: Vec3 | null = null;
  let bestDistance = Infinity;
  const limit = WATER_SEARCH_RADIUS * WATER_SEARCH_RADIUS;
  const unreachable = unreachableWater.get(bot);
  const skip = unreachable && unreachable.until > now ? unreachable.position : null;
  for (let dy = -2; dy <= 1; dy++) {
    for (let dx = -WATER_SEARCH_RADIUS; dx <= WATER_SEARCH_RADIUS; dx++) {
      for (let dz = -WATER_SEARCH_RADIUS; dz <= WATER_SEARCH_RADIUS; dz++) {
        const distance = dx * dx + dy * dy + dz * dz;
        if (distance > limit || distance >= bestDistance) continue;
        const position = feet.offset(dx, dy, dz);
        if (skip && position.equals(skip)) continue;
        if (bot.blockAt(position, false)?.name === 'water') {
          best = position;
          bestDistance = distance;
        }
      }
    }
  }
  waterCache.set(bot, { key, time: now, water: best });
  return best;
}

/** Remembers that this water could not be reached, so nearestWater skips it for 15 s. */
export function markWaterUnreachable(bot: mineflayer.Bot, water: Vec3): void {
  unreachableWater.set(bot, { position: water, until: Date.now() + UNREACHABLE_WATER_MS });
  waterCache.delete(bot);
}

/** The nearest spot within a few blocks to stand on that is not in or next to fire or lava. */
export function nearestSafeSpot(bot: mineflayer.Bot): Vec3 | null {
  const feet = bot.entity.position.floored();
  let best: Vec3 | null = null;
  let bestDistance = Infinity;
  for (let dx = -SAFE_SPOT_RADIUS; dx <= SAFE_SPOT_RADIUS; dx++) {
    for (let dz = -SAFE_SPOT_RADIUS; dz <= SAFE_SPOT_RADIUS; dz++) {
      for (let dy = -1; dy <= 2; dy++) {
        const spot = feet.offset(dx, dy, dz);
        // Prefer the bot's own level and one up (climbing out); prefer closer spots.
        const distance = spot.distanceTo(feet) + (dy < 0 ? 1 : 0);
        if (distance >= bestDistance) continue;
        const body = bot.blockAt(spot);
        const head = bot.blockAt(spot.offset(0, 1, 0));
        const floor = bot.blockAt(spot.offset(0, -1, 0));
        if (!body || !head || !floor || !isPassable(body) || !isPassable(head) || isPassable(floor) || isHazard(floor) || floor.name === 'water') continue;
        const nearHazard = [[1, 0], [-1, 0], [0, 1], [0, -1], [0, 0]].some(([ox, oz]) =>
          isHazard(bot.blockAt(spot.offset(ox, 0, oz))) || isHazard(bot.blockAt(spot.offset(ox, -1, oz))));
        if (nearHazard) continue;
        best = spot;
        bestDistance = distance;
      }
    }
  }
  return best;
}

/** What is straight above the bot's head: open water up to air, or a solid ceiling (deep or unloaded counts as open). */
export function columnAbove(bot: mineflayer.Bot): { open: boolean; ceiling: Vec3 | null } {
  const head = bot.entity.position.floored().offset(0, 1, 0);
  for (let i = 1; i <= WATER_SCAN_UP; i++) {
    const position = head.offset(0, i, 0);
    const block = bot.blockAt(position);
    if (!block) return { open: true, ceiling: null };
    if (isWater(block)) continue;
    if (isPassable(block)) return { open: true, ceiling: null };
    return { open: false, ceiling: position };
  }
  // Deep open water: swimming up still works.
  return { open: true, ceiling: null };
}

/**
 * The nearest spot the bot can swim to (through water and open blocks, within 8 blocks) where it can stand or float
 * with its head in the air. A flood fill, so air on the other side of a wall does not count.
 */
export function nearestAirPocket(bot: mineflayer.Bot): Vec3 | null {
  const start = bot.entity.position.floored();
  const seen = new Set([start.toString()]);
  const queue = [start];
  const open = (block: Block | null) => !!block && (isWater(block) || isPassable(block)) && !isHazard(block);
  const breathable = (block: Block | null) => !!block && !isWater(block) && isPassable(block) && !isHazard(block);
  while (queue.length > 0) {
    const spot = queue.shift()!;
    const below = bot.blockAt(spot.offset(0, -1, 0));
    // Something to rest on: water to float in, or solid ground.
    if (breathable(bot.blockAt(spot)) && breathable(bot.blockAt(spot.offset(0, 1, 0))) && below && !isHazard(below) &&
        (isWater(below) || !isPassable(below))) {
      return spot;
    }
    for (const [dx, dy, dz] of [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]) {
      const next = spot.offset(dx, dy, dz);
      const key = next.toString();
      if (seen.has(key) || next.distanceTo(start) > AIR_POCKET_RADIUS) continue;
      seen.add(key);
      if (open(bot.blockAt(next))) queue.push(next);
    }
  }
  return null;
}

/** Whether the ceiling block can be dug out safely: diggable, not falling back in, nothing nasty right above it. */
export function safeToDigOut(bot: mineflayer.Bot, ceiling: Vec3): boolean {
  const block = bot.blockAt(ceiling);
  const above = bot.blockAt(ceiling.offset(0, 1, 0));
  if (!block || !block.diggable || FALLING_BLOCKS.has(block.name) || isHazard(block)) return false;
  return !above || (above.name !== 'lava' && !FALLING_BLOCKS.has(above.name));
}

/** "3 blocks east, 2 up" style description of an offset from the bot, for the decision model and events. */
export function describeSpot(bot: mineflayer.Bot, spot: Vec3): string {
  const self = bot.entity.position.floored();
  const dx = spot.x - self.x;
  const dy = spot.y - self.y;
  const dz = spot.z - self.z;
  const parts: string[] = [];
  if (dz) parts.push(`${Math.abs(dz)} ${dz < 0 ? 'north' : 'south'}`);
  if (dx) parts.push(`${Math.abs(dx)} ${dx < 0 ? 'west' : 'east'}`);
  if (dy) parts.push(`${Math.abs(dy)} ${dy < 0 ? 'down' : 'up'}`);
  return parts.length > 0 ? `${parts.join(', ')} (block(s))` : 'right here';
}
