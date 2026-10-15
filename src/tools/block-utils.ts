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

export async function digBlockAt(bot: mineflayer.Bot, pos: Vec3): Promise<DigResult> {
  const block = bot.blockAt(pos);
  if (isAir(block) || isLiquid(block)) return 'air';
  if (!block!.diggable) return 'unbreakable';
  if (hasAdjacentLava(bot, pos)) return 'lava';

  if (!bot.canDigBlock(block!) || !bot.canSeeBlock(block!)) {
    await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2));
  }

  // The pathfinder may break blocks that are in its way, including the target itself.
  const current = bot.blockAt(pos);
  if (isAir(current)) return 'dug';

  await equipBestTool(bot, current!);
  await bot.dig(current!);
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
