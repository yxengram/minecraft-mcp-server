import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';

type Block = NonNullable<ReturnType<mineflayer.Bot['blockAt']>>;

const AIR_BLOCKS = new Set(['air', 'cave_air', 'void_air']);
const LIQUID_BLOCKS = new Set(['water', 'lava']);
const NEIGHBOR_OFFSETS = [
  new Vec3(0, -1, 0), new Vec3(0, 1, 0),
  new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
  new Vec3(0, 0, 1), new Vec3(0, 0, -1)
];

export type DigResult = 'dug' | 'air' | 'unbreakable' | 'lava';

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function isAir(block: { name: string } | null | undefined): boolean {
  return !block || AIR_BLOCKS.has(block.name);
}

export function isLiquid(block: { name: string } | null | undefined): boolean {
  return Boolean(block && LIQUID_BLOCKS.has(block.name));
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
export function digPrecheck(bot: mineflayer.Bot, pos: Vec3): Exclude<DigResult, 'dug'> | null {
  const block = bot.blockAt(pos);
  if (isAir(block) || isLiquid(block)) return 'air';
  if (!block!.diggable) return 'unbreakable';
  if (hasAdjacentLava(bot, pos)) return 'lava';
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

export async function placeBlockAt(bot: mineflayer.Bot, pos: Vec3): Promise<boolean> {
  for (const offset of NEIGHBOR_OFFSETS) {
    const reference = bot.blockAt(pos.plus(offset));
    if (isAir(reference) || isLiquid(reference)) continue;

    try {
      if (bot.entity.position.distanceTo(pos) > 4) {
        await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 3));
      }
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
