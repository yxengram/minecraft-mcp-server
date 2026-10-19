import mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';

type Block = NonNullable<ReturnType<mineflayer.Bot['blockAt']>>;

export type ViewMode = 'auto' | 'surface' | 'current-level';

export type Column =
  | { state: 'surface'; y: number; name: string }
  | { state: 'none' }
  | { state: 'unloaded' };

export interface SurfaceGrid {
  radius: number;
  centerX: number;
  centerZ: number;
  feetY: number;
  startY: number;
  view: Exclude<ViewMode, 'auto'>;
  columns: Column[];
}

const AIR_NAMES = new Set(['air', 'cave_air', 'void_air', 'light']);
const WATER_LIKE = new Set(['water', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass', 'bubble_column']);
const SURFACE_SCAN_ABOVE = 32;
// Surface scans reach well below the bot so the ground is still found when it stands on a tower or in the air.
const SURFACE_SCAN_BELOW = 128;
const LEVEL_SCAN_DEPTH = 64;
const ROOF_CHECK_HEIGHT = 12;

const DIRECTIONS_8 = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

export function surfaceName(name: string): string {
  return WATER_LIKE.has(name) ? 'water' : name;
}

/** Water, or a block the game treats as water (kelp, seagrass, bubble columns, waterlogged blocks). */
export function isWaterLike(block: { name: string; isWaterlogged?: boolean } | null | undefined): boolean {
  return Boolean(block && (WATER_LIKE.has(block.name) || block.isWaterlogged === true));
}

export function isLiquid(name: string): boolean {
  return name === 'water' || name === 'lava';
}

/** Blocks a column scan passes through: air, plants, torches and other blocks without a collision box. */
export function isPassable(block: Block): boolean {
  if (AIR_NAMES.has(block.name)) return true;
  if (WATER_LIKE.has(block.name) || block.name === 'lava') return false;
  return block.boundingBox === 'empty';
}

export function worldBounds(bot: mineflayer.Bot): { minY: number; maxY: number } {
  const game = bot.game as { minY?: number; height?: number } | undefined;
  const minY = typeof game?.minY === 'number' ? game.minY : -64;
  const height = typeof game?.height === 'number' ? game.height : 384;
  return { minY, maxY: minY + height - 1 };
}

/** True when there is a solid, non-leaf block within a few blocks above the bot's head. */
export function isUnderRoof(bot: mineflayer.Bot): boolean {
  const feet = bot.entity.position.floored();
  for (let dy = 2; dy <= ROOF_CHECK_HEIGHT; dy++) {
    const block = bot.blockAt(feet.offset(0, dy, 0), false);
    if (block && !isPassable(block) && !isLiquid(block.name) && !block.name.endsWith('_leaves')) {
      return true;
    }
  }
  return false;
}

export function resolveView(bot: mineflayer.Bot, view: ViewMode): Exclude<ViewMode, 'auto'> {
  if (view !== 'auto') return view;
  return isUnderRoof(bot) ? 'current-level' : 'surface';
}

export function scanSurface(bot: mineflayer.Bot, radius: number, view: ViewMode = 'auto'): SurfaceGrid {
  const feet = bot.entity.position.floored();
  const { minY, maxY } = worldBounds(bot);
  const resolvedView = resolveView(bot, view);
  const startY = resolvedView === 'surface'
    ? Math.min(maxY, feet.y + SURFACE_SCAN_ABOVE)
    : Math.min(maxY, feet.y + 1);
  const bottomY = Math.max(minY, resolvedView === 'surface' ? feet.y - SURFACE_SCAN_BELOW : startY - LEVEL_SCAN_DEPTH);
  const size = radius * 2 + 1;
  const columns: Column[] = new Array(size * size);
  const cursor = new Vec3(0, 0, 0);

  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const index = (dz + radius) * size + (dx + radius);
      cursor.x = feet.x + dx;
      cursor.z = feet.z + dz;

      let column: Column = { state: 'none' };
      for (let y = startY; y >= bottomY; y--) {
        cursor.y = y;
        const block = bot.blockAt(cursor, false);
        if (!block) {
          column = { state: 'unloaded' };
          break;
        }
        if (!isPassable(block)) {
          column = { state: 'surface', y, name: surfaceName(block.name) };
          break;
        }
      }
      columns[index] = column;
    }
  }

  return { radius, centerX: feet.x, centerZ: feet.z, feetY: feet.y, startY, view: resolvedView, columns };
}

export function columnAt(grid: SurfaceGrid, dx: number, dz: number): Column | undefined {
  if (Math.abs(dx) > grid.radius || Math.abs(dz) > grid.radius) return undefined;
  const size = grid.radius * 2 + 1;
  return grid.columns[(dz + grid.radius) * size + (dx + grid.radius)];
}

/** Compass direction of an offset; north is -Z and east is +X. */
export function compassDirection(dx: number, dz: number): string {
  if (dx === 0 && dz === 0) return 'here';
  const angle = (Math.atan2(dx, -dz) * 180) / Math.PI;
  return DIRECTIONS_8[((Math.round(angle / 45) % 8) + 8) % 8];
}

export function describeOffset(dx: number, dz: number, dy = 0): string {
  const blocks = (count: number) => `${count} block${count === 1 ? '' : 's'}`;
  const distance = Math.round(Math.hypot(dx, dz));
  if (distance === 0) {
    return dy === 0 ? 'right here' : `${blocks(Math.abs(dy))} ${dy > 0 ? 'above' : 'below'}`;
  }
  return `${blocks(distance)} ${compassDirection(dx, dz)}`;
}

const EYE_HEIGHT = 1.62;
const solid = (block: { boundingBox?: string } | null | undefined) => block?.boundingBox === 'block';
const at = (pos: Vec3) => `(${pos.x}, ${pos.y}, ${pos.z})`;

/**
 * The block the bot's eyes are in, if it has a collision box: the server deals suffocation (in_wall) damage then.
 * Null when the eyes are free or the world cannot be read.
 */
export function headInsideBlock(bot: mineflayer.Bot): Block | null {
  if (typeof bot.blockAt !== 'function' || !bot.entity?.position) return null;
  try {
    const block = bot.blockAt(bot.entity.position.offset(0, EYE_HEIGHT, 0).floored());
    return solid(block) ? block : null;
  } catch {
    return null;
  }
}

/**
 * Why waking up in this bed would put the bot's head in a block (E-014), or null. On waking, the server stands the
 * player on a free spot next to the bed, or on the bed itself when there is none; the bed is about 0.56 high, so
 * standing on it needs the 2 blocks above it free. Only a warning: an unreadable world gives null.
 */
export function bedWakeWarning(bot: mineflayer.Bot, bed: Block): string | null {
  try {
    return bedWakeProblem(bot, bed);
  } catch {
    return null;
  }
}

function bedWakeProblem(bot: mineflayer.Bot, bed: Block): string | null {
  if (typeof bot.blockAt !== 'function' || !bed?.position) return null;
  // mineflayer's bed plugin adds parseBedMetadata; the typings leave it out.
  const parse = (bot as unknown as { parseBedMetadata?: (block: Block) => { part: boolean; headOffset: Vec3 } }).parseBedMetadata;
  const meta = typeof parse === 'function' ? parse(bed) : null;
  const offset = meta?.headOffset ?? new Vec3(0, 0, 0);
  // The server keeps the head half as the sleeping position.
  const head = meta?.part ? bed.position : bed.position.plus(offset);
  const foot = head.minus(offset);

  const blocked = [head.offset(0, 1, 0), head.offset(0, 2, 0)].map(pos => bot.blockAt(pos)).find(solid);
  if (!blocked) return null;

  const isHalf = (pos: Vec3) => pos.equals(head) || pos.equals(foot);
  const canStand = (pos: Vec3) => {
    const cell = bot.blockAt(pos);
    const above = bot.blockAt(pos.offset(0, 1, 0));
    return Boolean(cell && above && isPassable(cell) && isPassable(above) && solid(bot.blockAt(pos.offset(0, -1, 0))));
  };
  const minX = Math.min(head.x, foot.x) - 1;
  const maxX = Math.max(head.x, foot.x) + 1;
  const minZ = Math.min(head.z, foot.z) - 1;
  const maxZ = Math.max(head.z, foot.z) + 1;
  for (let x = minX; x <= maxX; x++) {
    for (let z = minZ; z <= maxZ; z++) {
      const pos = new Vec3(x, head.y, z);
      if (!isHalf(pos) && canStand(pos)) return null;
    }
  }
  return `warning: no free 2-block-high spot next to the bed and ${blocked.name} at ${at(blocked.position)} above it: ` +
    'when the bot wakes up, the server stands it on the bed with its head in that block (suffocation damage); ' +
    'clear it or make room next to the bed';
}

/** What the woke_up event and the wake tool say when the bot woke up with its head in a block, or null. */
export function wokeUpInsideBlock(bot: mineflayer.Bot): string | null {
  const block = headInsideBlock(bot);
  return block
    ? `Woke up with the head inside ${block.name} at ${at(block.position)}: the bot takes suffocation damage until it moves out`
    : null;
}
