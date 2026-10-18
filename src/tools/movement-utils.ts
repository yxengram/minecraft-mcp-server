import mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';

type Goal = InstanceType<typeof pathfinderPkg.goals.Goal>;

// Blocks a player builds with. The pathfinder never digs through them to make a path (M11): without this it cut
// holes in the walls of the bot's own house to get in or out, because digging was cheaper than the door. Natural
// blocks (dirt, stone, logs, leaves) can still be dug on the way; dig-block and the other tools are not affected.
const BUILT_SUFFIXES = [
  '_planks', '_door', '_trapdoor', '_bed', '_fence', '_fence_gate', '_stairs', '_slab', '_wall', '_wool', '_carpet',
  '_bricks', '_glass', '_glass_pane', '_sign', '_hanging_sign', '_concrete', '_terracotta_bricks'
];
const BUILT_BLOCKS = new Set([
  'glass', 'glass_pane', 'chest', 'trapped_chest', 'barrel', 'crafting_table', 'furnace', 'blast_furnace', 'smoker',
  'torch', 'wall_torch', 'lantern', 'bookshelf', 'bricks', 'ladder', 'bed', 'stone_bricks'
]);

export function isBuiltBlock(name: string): boolean {
  return BUILT_BLOCKS.has(name) || BUILT_SUFFIXES.some(suffix => name.endsWith(suffix));
}

/** The fields of a block the pathfinder's Movements.getBlock returns that the door handling reads and sets. */
export interface PathBlock {
  name?: string;
  position?: { y: number };
  safe?: boolean;
  physical?: boolean;
  openable?: boolean;
  height?: number;
  getProperties?: () => Record<string, unknown>;
}

interface ConfigurableMovements {
  canOpenDoors: boolean;
  exclusionAreasBreak: ((block: { name: string }) => number)[];
  getBlock: (...args: never[]) => PathBlock;
}

/**
 * How the pathfinder should see a wooden door (iron doors need redstone): passable, open or closed; the door helper
 * (installDoorHelper) opens it as the bot walks up to it. mineflayer-pathfinder alone sees a closed door as a wall to
 * dig through, and its own "open the gate" step does not resume walking after a door (M11, seen live).
 */
export function adjustDoor(block: PathBlock): PathBlock {
  if (isWoodenDoor(block?.name)) {
    block.safe = true;
    block.physical = false;
    block.openable = false;
    // Its collision box would otherwise make it a step to jump onto. Only the pathfinder's own fields are changed;
    // the block's shapes stay as they are, because physics collides with them.
    if (block.position) block.height = block.position.y;
  }
  return block;
}

export function isWoodenDoor(name: string | undefined): boolean {
  return Boolean(name && name.endsWith('_door') && name !== 'iron_door');
}

function doorIsOpen(block: PathBlock | null | undefined): boolean {
  const open = block?.getProperties?.().open;
  return open === true || open === 'true';
}

const DOOR_LOOKAHEAD = [0.7, 1.3];
const DOOR_RETRY_MS = 1000;
// Closed again once the bot is this far from it: through the doorway, or gone another way.
const DOOR_CLOSE_DISTANCE = 2.2;

/**
 * While the pathfinder walks, opens a closed wooden door right ahead of the bot, and closes the doors it opened once
 * the bot is past them, so a house does not stay open at night (M11). Part of walking, not a behavior: it acts only
 * on doors in the bot's own path. Returns a function that removes it.
 */
export function installDoorHelper(bot: mineflayer.Bot): () => void {
  const removeView = flattenDoorsForPaths(bot);
  const opened = new Map<string, { position: Vec3; at: number }>();
  const tried = new Map<string, number>();
  const onTick = () => {
    try {
      const now = Date.now();
      const self = bot.entity?.position;
      if (!self) return;
      for (const [key, door] of opened) {
        if (self.distanceTo(door.position.offset(0.5, 0, 0.5)) < DOOR_CLOSE_DISTANCE || now - door.at < DOOR_RETRY_MS) continue;
        opened.delete(key);
        const block = bot.blockAt(door.position);
        if (block && isWoodenDoor(block.name) && doorIsOpen(block as PathBlock)) void bot.activateBlock(block).catch(() => {});
      }
      if (!bot.pathfinder?.isMoving?.()) return;
      const forward = new Vec3(-Math.sin(bot.entity.yaw), 0, -Math.cos(bot.entity.yaw));
      for (const ahead of DOOR_LOOKAHEAD) {
        const position = self.plus(forward.scaled(ahead)).floored();
        const block = bot.blockAt(position);
        if (!block || !isWoodenDoor(block.name) || doorIsOpen(block as PathBlock)) continue;
        // The lower half is what the game opens; both halves toggle together.
        const lower = (block as PathBlock).getProperties?.().half === 'upper' ? position.offset(0, -1, 0) : position;
        const key = lower.toString();
        if (now - (tried.get(key) ?? 0) < DOOR_RETRY_MS) continue;
        tried.set(key, now);
        const target = bot.blockAt(lower);
        if (!target) continue;
        opened.set(key, { position: lower, at: now });
        void bot.activateBlock(target).catch(() => {});
        break;
      }
    } catch {
      // Odd block or entity data: try again on the next tick.
    }
  };
  bot.on('physicsTick', onTick);
  return () => {
    bot.removeListener('physicsTick', onTick);
    removeView();
  };
}

/**
 * mineflayer-pathfinder moves every planned point onto the top of the collision shape of the block it is in
 * (getPositionOnTopOf, via bot.blockAt(pos)); for a door that is the top of the door, so the bot tried to climb onto
 * it and got stuck (M11, seen live). It reads blocks with the default extraInfos, while physics reads them with
 * bot.blockAt(pos, false); so wooden doors are shown without a collision shape only to callers that do not pass false.
 * Physics still collides with the real door, which the door helper opens just ahead of the bot.
 */
function flattenDoorsForPaths(bot: mineflayer.Bot): () => void {
  const original = bot.blockAt;
  if (typeof original !== 'function') return () => {};
  const wrapped = function (this: unknown, point: Vec3, extraInfos?: boolean) {
    const block = original.call(bot, point, extraInfos as boolean);
    if (extraInfos === false || !block || !isWoodenDoor(block.name)) return block;
    return Object.assign(Object.create(Object.getPrototypeOf(block)), block, { shapes: [] });
  } as typeof bot.blockAt;
  bot.blockAt = wrapped;
  return () => {
    if (bot.blockAt === wrapped) bot.blockAt = original;
  };
}

/** Pathfinder settings for the bot (E-013): walk through doors, and never break built blocks to get somewhere. */
export function configureMovements(movements: ConfigurableMovements): void {
  // Fence gates: the pathfinder's own "use" step. Doors are handled by adjustDoor and installDoorHelper.
  movements.canOpenDoors = true;
  // A cost of 100 or more makes a block unbreakable for the pathfinder.
  movements.exclusionAreasBreak.push(block => (isBuiltBlock(block.name) ? 100 : 0));
  const getBlock = movements.getBlock.bind(movements);
  movements.getBlock = ((...args: never[]) => adjustDoor(getBlock(...args))) as ConfigurableMovements['getBlock'];
}

// pathfinder.stop() only raises a flag that is cleared when the bot reaches its next path node.
// If no path is active the flag stays set and silently cancels the next goal, so clear it right away.
export function stopPathfinder(bot: mineflayer.Bot): void {
  bot.pathfinder.stop();
  bot.pathfinder.setGoal(null);
}

/**
 * Why the bot is not where it was sent, or null when it arrived within `range` (plus a block of slack). The
 * pathfinder can report success without having moved, e.g. when the bot is boxed in (M7).
 */
export function arrivalProblem(bot: mineflayer.Bot, target: { x: number; y: number; z: number }, range: number): string | null {
  const at = bot.entity.position.floored();
  const distance = Math.hypot(at.x - Math.floor(target.x), at.y - Math.floor(target.y), at.z - Math.floor(target.z));
  if (distance <= range + 1) return null;
  return `stopped at (${at.x}, ${at.y}, ${at.z}), ${distance.toFixed(1)} blocks from the target: the pathfinder found no way closer`;
}

export async function gotoWithTimeout(bot: mineflayer.Bot, goal: Goal, timeoutMs?: number): Promise<void> {
  const gotoPromise = bot.pathfinder.goto(goal);
  if (timeoutMs === undefined) {
    await gotoPromise;
    return;
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      reject(new Error(`Move timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    await Promise.race([gotoPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
    if (timedOut) {
      stopPathfinder(bot);
      gotoPromise.catch(() => {});
    }
  }
}
