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
const MAX_SCAN_DEPTH = 64;
const ROOF_CHECK_HEIGHT = 12;

const DIRECTIONS_8 = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

export function surfaceName(name: string): string {
  return WATER_LIKE.has(name) ? 'water' : name;
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
  const bottomY = Math.max(minY, startY - MAX_SCAN_DEPTH);
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
