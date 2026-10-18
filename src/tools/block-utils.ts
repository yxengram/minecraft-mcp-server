import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import { gotoWithTimeout } from './movement-utils.js';

type Block = NonNullable<ReturnType<mineflayer.Bot['blockAt']>>;

const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air']);
const LIQUID_BLOCKS = new Set(['water', 'lava']);
const NEIGHBOR_OFFSETS = [
  new Vec3(0, -1, 0), new Vec3(0, 1, 0),
  new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
  new Vec3(0, 0, 1), new Vec3(0, 0, -1)
];

export type DigResult = 'dug' | 'air' | 'unbreakable' | 'lava' | 'water';

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function isAir(block: { name: string } | null | undefined): boolean {
  return !block || AIR_BLOCKS.has(block.name);
}

export function isLiquid(block: { name: string } | null | undefined): boolean {
  return Boolean(block && LIQUID_BLOCKS.has(block.name));
}

/** Water on any face: digging it would flood the hole, or it is under water (submerged stone, aquifer walls). */
export function hasAdjacentWater(bot: mineflayer.Bot, pos: Vec3): boolean {
  return NEIGHBOR_OFFSETS.some(offset => bot.blockAt(pos.plus(offset))?.name === 'water');
}

export function hasAdjacentLava(bot: mineflayer.Bot, pos: Vec3): boolean {
  return NEIGHBOR_OFFSETS.some(offset => bot.blockAt(pos.plus(offset))?.name === 'lava');
}

export async function equipBestTool(bot: mineflayer.Bot, block: Block): Promise<void> {
  const tool = bot.pathfinder?.bestHarvestTool?.(block);
  if (tool) {
    await bot.equip(tool, 'hand');
  }
}

export class DigInterrupted extends Error {
  constructor() {
    super('digging interrupted');
  }
}

/**
 * `shouldStop` lets a background task back off when it loses the body: it is checked before each step, and the
 * dig then uses a forced look so nothing can run between the last check and the start of digging.
 */
/** Why a block must not or cannot be dug, checked before walking to it; null when it can be dug. */
export function digPrecheck(bot: mineflayer.Bot, pos: Vec3, { avoidWater = false } = {}): Exclude<DigResult, 'dug'> | null {
  const block = bot.blockAt(pos);
  if (isAir(block) || isLiquid(block)) return 'air';
  if (!block!.diggable) return 'unbreakable';
  if (hasAdjacentLava(bot, pos)) return 'lava';
  if (avoidWater && hasAdjacentWater(bot, pos)) return 'water';
  return null;
}

export async function digBlockAt(bot: mineflayer.Bot, pos: Vec3, shouldStop?: () => boolean): Promise<DigResult> {
  const unsafe = digPrecheck(bot, pos);
  if (unsafe) return unsafe;
  const block = bot.blockAt(pos);

  if (!bot.canDigBlock(block!) || !bot.canSeeBlock(block!)) {
    await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2));
  }

  // The pathfinder may break blocks that are in its way, including the target itself.
  const current = bot.blockAt(pos);
  if (isAir(current)) return 'dug';

  if (shouldStop?.()) throw new DigInterrupted();
  await equipBestTool(bot, current!);
  if (!shouldStop) {
    await bot.dig(current!);
    return 'dug';
  }
  if (shouldStop()) throw new DigInterrupted();
  await bot.dig(current!, true);
  return 'dug';
}

// The server accepts a placement from about 4.5 blocks between the eyes and the clicked face.
export const PLACE_REACH = 4.5;
const APPROACH_TIMEOUT_MS = 20000;
const EYE_HEIGHT = 1.62;

/**
 * Walks to a spot from which a block can be placed at `pos` (E-013): within reach of a face of a neighbouring block,
 * with a clear line of sight to it, and not standing in `pos` (or with the head in it). "Within 3 blocks of the
 * target" is not that: for a roof edge no floor spot qualifies, so the pathfinder climbed onto the roof or dug through
 * a wall; and "within 2 blocks of the reference" can be the target cell itself. Does nothing when the bot can already
 * place from where it stands.
 */
export async function approachToPlace(bot: mineflayer.Bot, pos: Vec3, reference: Block | null): Promise<void> {
  const eyes = bot.entity.position.offset(0, EYE_HEIGHT, 0);
  const inReach = reference && eyes.distanceTo(reference.position.offset(0.5, 0.5, 0.5)) <= PLACE_REACH;
  if (inReach && bot.canSeeBlock(reference) && !overlapsBot(bot, pos)) return;
  // faces and facing are optional at runtime (all faces, any facing); the type marks them required.
  const options = { range: PLACE_REACH, LOS: true } as unknown as ConstructorParameters<typeof goals.GoalPlaceBlock>[2];
  // Bounded: an unreachable spot must fail this placement, not hang the tool (fill-region has no other limit per block).
  await gotoWithTimeout(bot, new goals.GoalPlaceBlock(pos, bot.world, options), APPROACH_TIMEOUT_MS);
}

export async function placeBlockAt(bot: mineflayer.Bot, pos: Vec3): Promise<boolean> {
  for (const offset of NEIGHBOR_OFFSETS) {
    const reference = bot.blockAt(pos.plus(offset));
    if (isAir(reference) || isLiquid(reference)) continue;

    try {
      await approachToPlace(bot, pos, reference);
      if (overlapsBot(bot, pos)) return false;
      await bot.lookAt(pos.offset(0.5, 0.5, 0.5), true);
      await bot.placeBlock(reference!, offset.scaled(-1));
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

export function overlapsBot(bot: mineflayer.Bot, pos: Vec3): boolean {
  const feet = bot.entity.position.floored();
  return pos.equals(feet) || pos.equals(feet.offset(0, 1, 0));
}
