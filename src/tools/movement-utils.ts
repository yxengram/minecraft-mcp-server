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

// Built blocks the world generates where nobody built anything: moss carpets (lush caves, pale gardens), Nether
// fortresses, bastions and End cities. The pathfinder still never breaks them (M11), but scaffolding may go next to
// them and what they stand on may be dug; otherwise the bot could not bridge across a fortress deck (E-019 review).
const GENERATED_LOOKALIKE = /^(pale_)?moss_carpet$|nether_brick|polished_blackstone_brick|end_stone_brick/;

/** A built block that is most likely the player's: what scaffolding must not touch (E-019). */
export function isPlayerBuilt(name: string): boolean {
  return isBuiltBlock(name) && !GENERATED_LOOKALIKE.test(name);
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

type PositionedBlock = { name: string; position?: { x: number; y: number; z: number } };

interface ConfigurableMovements {
  canOpenDoors: boolean;
  exclusionAreasBreak: ((block: PositionedBlock) => number)[];
  // Added cost for placing a scaffolding block in a cell; 100 or more and the pathfinder does not place it.
  exclusionAreasPlace?: ((block: PositionedBlock) => number)[];
  // Added cost for each cell the bot would move through (mineflayer-pathfinder's exclusionStep).
  exclusionAreasStep?: ((block: { name: string; position?: unknown }) => number)[];
  getBlock: (...args: never[]) => PathBlock;
  // Block ids the pathfinder may place a scaffolding block into (it includes lava and water).
  replaceables?: Set<number>;
  // Real Movements keep the bot; test fakes may not.
  bot?: StateWorld;
}

/** Looks up the block at `pos` plus an offset, as mineflayer-pathfinder's Movements.getBlock does. */
type CellLookup = (pos: { x: number; y: number; z: number }, dx: number, dy: number, dz: number) => { name?: string } | null;
/** Whether the block at x, y, z is player-built (isPlayerBuilt). */
export type BuiltAt = (x: number, y: number, z: number) => boolean;

const AROUND: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
// A built block this far above a cell means the cell is under a roof: inside a house.
export const ROOF_CHECK = 4;

/**
 * Whether a cell touches something the player built (E-019): a built block in one of the 8 cells around it at the
 * same height, right below it, or up to ROOF_CHECK blocks above it. Scaffolding there stays behind as a step in a
 * fence ring (a cow jumped out twice in the task test), dirt in a wall, or a block in a room.
 */
export function nearBuilt(builtAt: BuiltAt, { x, y, z }: { x: number; y: number; z: number }): boolean {
  if (AROUND.some(([dx, dz]) => builtAt(x + dx, y, z + dz)) || builtAt(x, y - 1, z)) return true;
  for (let dy = 1; dy <= ROOF_CHECK; dy++) if (builtAt(x, y + dy, z)) return true;
  return false;
}

/**
 * nearBuilt for a cell or the cell below it, in one pass over the cells the two share. mineflayer-pathfinder 2.4.5
 * hands a bridging step (getMoveForward) the cell above the one it fills, so both are checked.
 */
export function placeNearBuilt(builtAt: BuiltAt, { x, y, z }: { x: number; y: number; z: number }): boolean {
  if (AROUND.some(([dx, dz]) => builtAt(x + dx, y, z + dz) || builtAt(x + dx, y - 1, z + dz))) return true;
  for (let dy = -2; dy <= ROOF_CHECK; dy++) if (builtAt(x, y + dy, z)) return true;
  return false;
}

interface StateWorld {
  registry?: { blocksArray?: { name: string; minStateId?: number; maxStateId?: number }[] };
  world?: { getBlockStateId?: (pos: Vec3) => number | null | undefined };
}

/**
 * A cheap isPlayerBuilt lookup for the planner, which asks about ~20 cells for every step it considers: block-state
 * ids from the world, without building a Block (the review measured planning 1.9x slower with full lookups). Falls
 * back to `lookup` when the bot has no world (test fakes).
 */
function builtLookup(bot: StateWorld | undefined, lookup: CellLookup): BuiltAt {
  const world = bot?.world;
  const blocks = bot?.registry?.blocksArray;
  if (typeof world?.getBlockStateId === 'function' && blocks) {
    const states = new Set<number>();
    for (const block of blocks) {
      if (!isPlayerBuilt(block.name) || block.minStateId === undefined) continue;
      for (let id = block.minStateId; id <= (block.maxStateId ?? block.minStateId); id++) states.add(id);
    }
    const at = new Vec3(0, 0, 0);
    return (x, y, z) => {
      at.set(x, y, z);
      const id = world.getBlockStateId!(at);
      return typeof id === 'number' && states.has(id);
    };
  }
  const origin = { x: 0, y: 0, z: 0 };
  return (x, y, z) => isPlayerBuilt(lookup(origin, x, y, z)?.name ?? '');
}

// Extra path cost for walking over a magma block: avoided, but still used when there is no other way (100 forbids).
export const MAGMA_STEP_COST = 20;
// Extra path cost for a cell with lava beside it, below it, or below a neighbour (E-018): the bot is 0.6 blocks wide
// and the pathfinder only looks at its column, so a way along a lava shore is taken only when there is no other. The
// last case is the live one: the lake's surface was level with the shore's floor, one below the bot's feet. A target
// on the shore itself stays reachable (100 would forbid it): in the lava-shore scenario the only way round is a 5-cell
// shore path, and the pathfinder still takes it.
export const LAVA_EDGE_COST = 40;
const LAVA_EDGE_OFFSETS: [number, number, number][] = [
  [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0],
  [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1]
];

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

/**
 * Pathfinder settings for the bot (E-013): walk through doors, never break built blocks or the blocks they stand on,
 * and never leave scaffolding next to built blocks (E-019).
 */
// How far down overLava looks for the lava under a cell.
const OVER_LAVA_DEPTH = 6;
const OPEN_AIR = new Set(['air', 'cave_air', 'void_air']);

/** Whether the first block under the cell (within OVER_LAVA_DEPTH) is lava: a fall from here lands in it. */
function overLava(lookup: CellLookup, cell: { x: number; y: number; z: number }): boolean {
  for (let dy = 1; dy <= OVER_LAVA_DEPTH; dy++) {
    const name = lookup(cell, 0, -dy, 0)?.name;
    if (name === 'lava') return true;
    if (!name || !OPEN_AIR.has(name)) return false;
  }
  return false;
}

export function configureMovements(movements: ConfigurableMovements): void {
  // Fence gates: the pathfinder's own "use" step. Doors are handled by adjustDoor and installDoorHelper.
  movements.canOpenDoors = true;
  const getRaw = movements.getBlock as unknown as CellLookup;
  const lookup: CellLookup = (pos, dx, dy, dz) => getRaw.call(movements, pos, dx, dy, dz);
  const builtAt = builtLookup(movements.bot, lookup);
  // A cost of 100 or more makes a block unbreakable for the pathfinder. A door drops when the block under it goes,
  // as it did in the task test, and a hole under a fence is a way out of the ring (E-019).
  movements.exclusionAreasBreak.push(block => {
    if (isBuiltBlock(block.name)) return 100;
    const cell = block.position;
    return cell && builtAt(cell.x, cell.y + 1, cell.z) ? 100 : 0;
  });
  movements.exclusionAreasPlace?.push(block => (block.position && placeNearBuilt(builtAt, block.position) ? 100 : 0));
  // Magma burns whoever walks on it (hot_floor), and the bot crossed it three times in the Nether (E-017). The step
  // exclusion sees the cells the bot moves through, so it looks at the block below each one.
  movements.exclusionAreasStep?.push(block =>
    (block.position && lookup(block.position as { x: number; y: number; z: number }, 0, -1, 0)?.name === 'magma_block' ? MAGMA_STEP_COST : 0));
  movements.exclusionAreasStep?.push(block => {
    const cell = block.position as { x: number; y: number; z: number } | undefined;
    return cell && LAVA_EDGE_OFFSETS.some(([dx, dy, dz]) => lookup(cell, dx, dy, dz)?.name === 'lava') ? LAVA_EDGE_COST : 0;
  });
  // Bridging a lava pool was the riskiest step seen while reproducing the lava death (E-018): the bot then walks over
  // the lava, safe only while every placement works. Without lava among the replaceables the pathfinder built the
  // bridge one level up instead, in the air above the pool (lava-shore scenario), so neither is allowed.
  const lava = (movements.bot as { registry?: { blocksByName?: Record<string, { id: number }> } } | undefined)?.registry?.blocksByName?.lava?.id;
  if (lava !== undefined) movements.replaceables?.delete(lava);
  // Forbidding only the cell right above the lava, the pathfinder built its bridge a level higher each time; a fall
  // from any height over the pool ends in the lava, so no block goes where the first thing below is lava.
  // (mineflayer-pathfinder passes the cell being filled when it jumps up but the cell above it when it steps forward
  // onto a placed block; looking down from either finds the same lava.)
  movements.exclusionAreasPlace?.push(block => {
    const cell = block.position as { x: number; y: number; z: number } | undefined;
    return cell && overLava(lookup, cell) ? 100 : 0;
  });
  const getBlock = movements.getBlock.bind(movements);
  movements.getBlock = ((...args: never[]) => adjustDoor(getBlock(...args))) as ConfigurableMovements['getBlock'];
}

interface EditBlock {
  name?: string;
  type?: number;
  position?: { x: number; y: number; z: number };
}

// Blocks listed per kind in a move's report; the rest are counted.
export const EDIT_LIST_LIMIT = 6;

function editList(edits: { name: string; at: string }[]): string {
  const shown = edits.slice(0, EDIT_LIST_LIMIT).map(edit => `${edit.name} at ${edit.at}`);
  if (edits.length > EDIT_LIST_LIMIT) shown.push(`and ${edits.length - EDIT_LIST_LIMIT} more`);
  return shown.join(', ');
}

function cellText(position: { x: number; y: number; z: number }): string {
  return `(${Math.floor(position.x)}, ${Math.floor(position.y)}, ${Math.floor(position.z)})`;
}

/**
 * Records the blocks the bot digs and places while a move runs, which during a move is the pathfinder's scaffolding
 * and the way it digs (E-019): in the task test it left blocks in a fence gap and in walls, and nothing said so.
 * Returns a function that stops recording and gives the suffix for the tool's reply ('' when nothing changed).
 */
export function watchPathEdits(bot: mineflayer.Bot): () => string {
  const dug: { name: string; at: string }[] = [];
  const placed: { name: string; at: string }[] = [];
  let stopped = false;
  // Digs are seen by wrapping bot.dig, which the pathfinder looks up on every dig: it removes every diggingCompleted
  // listener whenever it re-plans (removeAllListeners with a second argument, which Node ignores), so an event
  // listener heard only the first dig of a move (E-019 review, seen live).
  const originalDig = bot.dig;
  const wrappedDig = typeof originalDig === 'function'
    ? (function (this: unknown, block: EditBlock, ...rest: unknown[]) {
      const digging = (originalDig as (...args: unknown[]) => Promise<void>).call(bot, block, ...rest);
      return digging.then(result => {
        if (!stopped && block?.position) dug.push({ name: block.name ?? 'a block', at: cellText(block.position) });
        return result;
      });
    } as unknown as typeof bot.dig)
    : null;
  if (wrappedDig) bot.dig = wrappedDig;
  const onPlaced = (_oldBlock: EditBlock | null, newBlock: EditBlock | null) => {
    if (!stopped && newBlock?.position) placed.push({ name: newBlock.name ?? 'a block', at: cellText(newBlock.position) });
  };
  // Test fakes may have no event emitter.
  const listens = typeof bot.on === 'function';
  if (listens) bot.on('blockPlaced' as never, onPlaced as never);
  return () => {
    if (!stopped) {
      stopped = true;
      if (wrappedDig && bot.dig === wrappedDig) bot.dig = originalDig;
      if (listens) bot.removeListener('blockPlaced' as never, onPlaced as never);
    }
    const parts: string[] = [];
    if (dug.length > 0) parts.push(`dug ${dug.length} block(s): ${editList(dug)}`);
    if (placed.length > 0) parts.push(`placed ${placed.length} block(s): ${editList(placed)}`);
    return parts.length > 0 ? `; on the way the pathfinder ${parts.join('; ')}` : '';
  };
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

// The server sends a player standing in a Nether portal to the other dimension after about 4 s (E-017).
export const PORTAL_WAIT_MS = 10000;
// After a trip the server ignores the player in a portal for about 15 s, and touching it restarts that (live test).
export const PORTAL_COOLDOWN_S = 15;
const PORTAL_POLL_MS = 250;

export function inNetherPortal(bot: mineflayer.Bot): boolean {
  // Optional call: test fakes may have no world.
  return bot.blockAt?.(bot.entity.position.floored())?.name === 'nether_portal';
}

/**
 * After a move that ended in a Nether portal, waits for the dimension to change and says where the bot is now, as a
 * suffix for the tool's reply; '' when the bot is not in a portal. The live test stopped one block short of the portal
 * and nothing said so (E-017).
 */
export async function portalReport(bot: mineflayer.Bot, waitMs = PORTAL_WAIT_MS): Promise<string> {
  if (!inNetherPortal(bot)) return '';
  const start = bot.game?.dimension;
  for (let waited = 0; waited < waitMs && bot.game?.dimension === start; waited += PORTAL_POLL_MS) {
    await new Promise(resolve => setTimeout(resolve, PORTAL_POLL_MS));
  }
  // The server restarts a player's portal cooldown (about 15 s after a trip) on every tick it touches a portal.
  if (bot.game?.dimension === start) {
    return `; stood in the portal for ${Math.round(waitMs / 1000)} s; the dimension did not change ` +
      `(right after a trip, wait about ${PORTAL_COOLDOWN_S} s outside the portal before walking back in)`;
  }
  const { x, y, z } = bot.entity.position.floored();
  return `; went through the portal: now in ${bot.game?.dimension} at (${x}, ${y}, ${z})`;
}

