import { z } from "zod";
import mineflayer from 'mineflayer';
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { encodePng } from '../png.js';
import { findNearbyEntities, entityLabel, droppedItem, BotEntity } from './entity-utils.js';
import { mobHostility } from '../autopilot/threats.js';
import {
  AIR_COLOR, CAVE_AIR_COLOR, UNLOADED_COLOR, Rgb, blockColor, shade, toHex
} from './block-colors.js';
import {
  Column, SurfaceGrid, ViewMode, columnAt, compassDirection, describeOffset, isPassable,
  scanSurface, surfaceName, worldBounds
} from './terrain-utils.js';

const VIEW_MODES = ['auto', 'surface', 'current-level'] as const;
const MAX_SCAN_RADIUS = 64;
const MAX_MAP_RADIUS = 96;
const TARGET_IMAGE_SIZE = 512;
const MAX_PIXELS_PER_BLOCK = 16;
const STEEP_DROP = 4;
const WALL_SHADE = 0.45;
const NOTABLE_BLOCK_LIMIT = 2000;
const NOTABLE_PATTERN = /(_ore|^ancient_debris|chest|^barrel|shulker_box|^crafting_table|^furnace|^blast_furnace|^smoker|_bed|^spawner|^nether_portal|^end_portal_frame|^enchanting_table|^anvil|^brewing_stand|^bell|_log|_stem)$/;

const NO_SURFACE_COLOR: Rgb = [24, 20, 36];
const BOT_COLOR: Rgb = [255, 255, 255];
const OUTLINE_COLOR: Rgb = [0, 0, 0];
const ENTITY_COLORS: Record<string, Rgb> = {
  player: [0, 230, 255],
  hostile: [255, 32, 32],
  animal: [255, 216, 0],
  neutral: [255, 140, 0],
  mob: [255, 140, 0],
  other: [200, 200, 200]
};

const viewSchema = z.enum(VIEW_MODES).optional().describe(
  "'surface' looks down from the sky, 'current-level' shows the floor at the bot's own level (useful in caves and buildings), 'auto' picks current-level when there is a roof over the bot (default: auto)"
);

function entityCategory(bot: mineflayer.Bot, entity: BotEntity): keyof typeof ENTITY_COLORS {
  // Newer minecraft-data reports types the typings do not list yet, such as 'animal'.
  const type = entity.type as string;
  if (type === 'player') return 'player';
  // The autopilot's own lists first: minecraft-data calls zombified piglins hostile (E-017).
  const hostility = mobHostility(bot, entity);
  if (hostility) return hostility;
  if (type === 'hostile') return 'hostile';
  if (type === 'animal' || type === 'passive' || type === 'water_creature' || type === 'ambient') return 'animal';
  if (type === 'mob') return 'mob';
  return 'other';
}

function percent(part: number, total: number): string {
  const value = (part / total) * 100;
  return part > 0 && value < 1 ? '<1%' : `${Math.round(value)}%`;
}

function topCounts(counts: Map<string, number>, limit: number): [string, number][] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function signed(value: number): string {
  const rounded = Math.round(value);
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
}

function viewDescription(grid: SurfaceGrid): string {
  return grid.view === 'surface'
    ? `surface (looking down from y=${grid.startY})`
    : `current level (floor below y=${grid.startY}, the bot is under a roof)`;
}

/** In current-level view, a column that is solid at head height is a wall rather than walkable floor. */
function isWall(grid: SurfaceGrid, column: Column): boolean {
  return grid.view === 'current-level' && column.state === 'surface' && column.y >= grid.startY;
}

function describeTerrain(grid: SurfaceGrid): string[] {
  const ground = grid.feetY - 1;
  const lines: string[] = [];
  const surfaces: { dx: number; dz: number; y: number; name: string }[] = [];
  let unloaded = 0;
  let walls = 0;

  for (let dz = -grid.radius; dz <= grid.radius; dz++) {
    for (let dx = -grid.radius; dx <= grid.radius; dx++) {
      const column = columnAt(grid, dx, dz)!;
      if (column.state === 'unloaded') unloaded++;
      else if (isWall(grid, column)) walls++;
      else if (column.state === 'surface') surfaces.push({ dx, dz, y: column.y, name: column.name });
    }
  }

  const total = grid.columns.length;
  if (surfaces.length === 0) {
    return [`No terrain data: ${unloaded === total ? 'the area is not loaded' : 'no ground found below the scan start'}`];
  }
  if (unloaded > 0) lines.push(`Not loaded: ${percent(unloaded, total)} of the area (beyond the server's view distance)`);
  if (grid.view === 'current-level') {
    lines.push(`Open space at this level: ${percent(surfaces.length, total)} of the area; ${percent(walls, total)} is solid at head height (walls or rock)`);
  }

  const heights = surfaces.map(column => column.y);
  lines.push(`Ground height: y=${Math.min(...heights)} to y=${Math.max(...heights)} (the bot stands on y=${ground})`);

  const composition = new Map<string, number>();
  surfaces.forEach(column => composition.set(column.name, (composition.get(column.name) ?? 0) + 1));
  lines.push(`${grid.view === 'surface' ? 'Surface' : 'Floor'}: ${topCounts(composition, 6)
    .map(([name, count]) => `${name} ${percent(count, surfaces.length)}`).join(', ')}`);

  const sectors = ['north', 'east', 'south', 'west'].map(name => ({
    name, deltas: [] as number[], names: new Map<string, number>(), water: 0
  }));
  surfaces.forEach(column => {
    if (Math.hypot(column.dx, column.dz) < 2) return;
    const angle = (Math.atan2(column.dx, -column.dz) * 180) / Math.PI;
    const sector = sectors[((Math.round(angle / 90) % 4) + 4) % 4];
    sector.deltas.push(column.y - ground);
    sector.names.set(column.name, (sector.names.get(column.name) ?? 0) + 1);
    if (column.name === 'water') sector.water++;
  });
  lines.push('By direction (height relative to the block the bot stands on):');
  sectors.forEach(sector => {
    if (sector.deltas.length === 0) {
      lines.push(`- ${sector.name}: no data`);
      return;
    }
    const average = sector.deltas.reduce((sum, value) => sum + value, 0) / sector.deltas.length;
    let line = `- ${sector.name}: average ${signed(average)} (${signed(Math.min(...sector.deltas))} to ${signed(Math.max(...sector.deltas))}), mostly ${topCounts(sector.names, 1)[0][0]}`;
    if (sector.water > 0) line += `, ${percent(sector.water, sector.deltas.length)} water`;
    lines.push(line);
  });

  const drops: { dx: number; dz: number; size: number; distance: number }[] = [];
  surfaces.forEach(column => {
    for (const [ox, oz] of [[1, 0], [0, 1]]) {
      const neighbor = columnAt(grid, column.dx + ox, column.dz + oz);
      if (neighbor?.state !== 'surface' || isWall(grid, neighbor)) continue;
      const size = Math.abs(neighbor.y - column.y);
      if (size >= STEEP_DROP) {
        drops.push({ dx: column.dx, dz: column.dz, size, distance: Math.hypot(column.dx, column.dz) });
      }
    }
  });
  drops.sort((a, b) => a.distance - b.distance);
  const reported: typeof drops = [];
  for (const drop of drops) {
    if (reported.length >= 3) break;
    if (reported.some(other => Math.hypot(other.dx - drop.dx, other.dz - drop.dz) < 6)) continue;
    reported.push(drop);
  }
  if (reported.length > 0) {
    lines.push(`Steep height changes (${STEEP_DROP}+ blocks): ${reported
      .map(drop => `${drop.size} blocks at (${grid.centerX + drop.dx}, ${grid.centerZ + drop.dz}), ${describeOffset(drop.dx, drop.dz)}`)
      .join('; ')}`);
  } else {
    lines.push('Steep height changes: none');
  }

  for (const liquid of ['water', 'lava']) {
    const matches = surfaces.filter(column => column.name === liquid);
    if (matches.length === 0) {
      lines.push(`${liquid === 'water' ? 'Water' : 'Lava'}: none on the ${grid.view === 'surface' ? 'surface' : 'floor'}`);
      continue;
    }
    const nearest = matches.reduce((a, b) => (Math.hypot(a.dx, a.dz) <= Math.hypot(b.dx, b.dz) ? a : b));
    lines.push(`${liquid === 'water' ? 'Water' : 'Lava'}: ${matches.length} columns, nearest at (${grid.centerX + nearest.dx}, ${nearest.y}, ${grid.centerZ + nearest.dz}), ${describeOffset(nearest.dx, nearest.dz)}`);
  }

  return lines;
}

function isExposed(bot: mineflayer.Bot, pos: Vec3): boolean {
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const neighbor = bot.blockAt(pos.offset(dx, dy, dz), false);
    if (neighbor && (isPassable(neighbor) || surfaceName(neighbor.name) === 'water')) return true;
  }
  return false;
}

function describeNotableBlocks(bot: mineflayer.Bot, radius: number, xray: boolean): string[] {
  const mcData = minecraftData(bot.version);
  const ids = Object.values(mcData.blocksByName)
    .filter(block => NOTABLE_PATTERN.test(block.name))
    .map(block => block.id);
  if (ids.length === 0) return [];

  const origin = bot.entity.position;
  const found = bot.findBlocks({ point: origin, matching: ids, maxDistance: radius, count: NOTABLE_BLOCK_LIMIT });
  const groups = new Map<string, { count: number; nearest: Vec3; distance: number }>();

  for (const pos of found) {
    const block = bot.blockAt(pos, false);
    if (!block || (!xray && !isExposed(bot, pos))) continue;
    const name = /_(log|stem)$/.test(block.name) ? 'tree trunks (logs)' : block.name;
    const distance = pos.distanceTo(origin);
    const group = groups.get(name);
    if (!group) {
      groups.set(name, { count: 1, nearest: pos, distance });
    } else {
      group.count++;
      if (distance < group.distance) Object.assign(group, { nearest: pos, distance });
    }
  }

  const header = `Notable blocks within ${radius} blocks (${xray ? 'including buried ones' : 'only blocks exposed to air or water; set xray to include buried ones'}):`;
  if (groups.size === 0) return [header, '- none'];

  const feet = origin.floored();
  return [header, ...[...groups.entries()]
    .sort((a, b) => a[1].distance - b[1].distance)
    .slice(0, 15)
    .map(([name, { count, nearest }]) =>
      `- ${name} x${count}, nearest at (${nearest.x}, ${nearest.y}, ${nearest.z}), ${describeOffset(nearest.x - feet.x, nearest.z - feet.z, nearest.y - feet.y)}`)];
}

function describeEntities(bot: mineflayer.Bot, radius: number): string {
  const groups = new Map<string, Map<string, number>>();
  for (const { entity } of findNearbyEntities(bot, { maxDistance: radius })) {
    const category = entityCategory(bot, entity);
    const label = category === 'player' || droppedItem(entity) ? entityLabel(entity) : entity.name ?? entity.type;
    const names = groups.get(category) ?? new Map<string, number>();
    names.set(label, (names.get(label) ?? 0) + 1);
    groups.set(category, names);
  }
  if (groups.size === 0) return `Entities within ${radius} blocks: none`;

  const order = ['player', 'hostile', 'neutral', 'mob', 'animal', 'other'];
  const parts = order.filter(category => groups.has(category)).map(category => {
    const names = groups.get(category)!;
    const total = [...names.values()].reduce((sum, value) => sum + value, 0);
    return `${total} ${category === 'other' ? 'other' : category} (${[...names.entries()].map(([name, count]) => (count > 1 ? `${name} x${count}` : name)).join(', ')})`;
  });
  return `Entities within ${radius} blocks: ${parts.join('; ')}`;
}

class Canvas {
  readonly pixels: Uint8Array;

  constructor(readonly width: number, readonly height: number) {
    this.pixels = new Uint8Array(width * height * 3);
  }

  set(x: number, y: number, [r, g, b]: Rgb): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 3;
    this.pixels[i] = r;
    this.pixels[i + 1] = g;
    this.pixels[i + 2] = b;
  }

  fill(x: number, y: number, w: number, h: number, color: Rgb): void {
    for (let py = y; py < y + h; py++) {
      for (let px = x; px < x + w; px++) this.set(px, py, color);
    }
  }

  marker(cx: number, cy: number, size: number, color: Rgb): void {
    const half = Math.floor(size / 2);
    this.fill(cx - half - 1, cy - half - 1, size + 2, size + 2, OUTLINE_COLOR);
    this.fill(cx - half, cy - half, size, size, color);
  }

  line(x0: number, y0: number, x1: number, y1: number, color: Rgb, thickness: number): void {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    const half = Math.floor(thickness / 2);
    for (let i = 0; i <= steps; i++) {
      const x = Math.round(x0 + ((x1 - x0) * i) / steps);
      const y = Math.round(y0 + ((y1 - y0) * i) / steps);
      this.fill(x - half, y - half, thickness, thickness, color);
    }
  }

  png(): Buffer {
    return encodePng(this.width, this.height, this.pixels);
  }
}

function pixelsPerBlock(blocks: number): number {
  return Math.max(1, Math.min(MAX_PIXELS_PER_BLOCK, Math.floor(TARGET_IMAGE_SIZE / blocks)));
}

function legend(counts: Map<string, number>): string {
  return topCounts(counts, 12).map(([name]) => `${name} ${toHex(blockColor(name))}`).join(', ');
}

function markerLegend(showEntities: boolean): string {
  const parts = ['bot = white square with a black outline'];
  if (showEntities) {
    parts.push(`players ${toHex(ENTITY_COLORS.player)}`, `hostile mobs ${toHex(ENTITY_COLORS.hostile)}`,
      `animals ${toHex(ENTITY_COLORS.animal)}`, `neutral and other mobs ${toHex(ENTITY_COLORS.mob)}`, `items and other entities ${toHex(ENTITY_COLORS.other)}`);
  }
  return parts.join(', ');
}

function renderTopMap(bot: mineflayer.Bot, radius: number, view: ViewMode, showEntities: boolean) {
  const grid = scanSurface(bot, radius, view);
  const size = radius * 2 + 1;
  const scale = pixelsPerBlock(size);
  const canvas = new Canvas(size * scale, size * scale);
  const counts = new Map<string, number>();

  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const column = columnAt(grid, dx, dz)!;
      let color: Rgb;
      if (column.state === 'unloaded') {
        color = UNLOADED_COLOR;
      } else if (column.state === 'none') {
        color = NO_SURFACE_COLOR;
      } else {
        counts.set(column.name, (counts.get(column.name) ?? 0) + 1);
        color = blockColor(column.name);
        const north: Column | undefined = columnAt(grid, dx, dz - 1);
        if (isWall(grid, column)) {
          color = shade(color, WALL_SHADE);
        } else if (north?.state === 'surface' && !isWall(grid, north) && column.name !== 'water') {
          if (column.y > north.y) color = shade(color, 1.12);
          else if (column.y < north.y) color = shade(color, 0.8);
        }
      }
      const worldX = grid.centerX + dx;
      if (scale >= 4 && ((worldX % 16) + 16) % 16 === 0) color = shade(color, 0.85);
      canvas.fill((dx + radius) * scale, (dz + radius) * scale, scale, scale, color);
      const worldZ = grid.centerZ + dz;
      if (scale >= 4 && ((worldZ % 16) + 16) % 16 === 0) {
        canvas.fill((dx + radius) * scale, (dz + radius) * scale, scale, 1, shade(color, 0.85));
      }
    }
  }

  const toPixel = (x: number, z: number) => [
    Math.floor((x - (grid.centerX - radius)) * scale), Math.floor((z - (grid.centerZ - radius)) * scale)
  ];
  const markerSize = Math.max(3, scale);
  let entityCount = 0;
  if (showEntities) {
    for (const { entity } of findNearbyEntities(bot, { maxDistance: radius * 1.5 })) {
      const [px, py] = toPixel(entity.position.x, entity.position.z);
      if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue;
      canvas.marker(px, py, markerSize, ENTITY_COLORS[entityCategory(bot, entity)]);
      entityCount++;
    }
  }

  const [bx, by] = toPixel(bot.entity.position.x, bot.entity.position.z);
  const yaw = bot.entity.yaw ?? 0;
  const length = scale * 3 + 4;
  canvas.line(bx, by, bx + Math.round(-Math.sin(yaw) * length), by + Math.round(-Math.cos(yaw) * length), OUTLINE_COLOR, Math.max(3, Math.floor(scale / 2) + 2));
  canvas.line(bx, by, bx + Math.round(-Math.sin(yaw) * length), by + Math.round(-Math.cos(yaw) * length), BOT_COLOR, Math.max(1, Math.floor(scale / 2)));
  canvas.marker(bx, by, Math.max(5, scale + 2), BOT_COLOR);

  const facing = compassDirection(Math.round(-Math.sin(yaw) * 100), Math.round(-Math.cos(yaw) * 100));
  const text = [
    `Top-down map, ${size}x${size} blocks, ${scale} px per block, view: ${viewDescription(grid)}`,
    `North (-Z) is up, east (+X) is right. Top-left block (${grid.centerX - radius}, ${grid.centerZ - radius}), bottom-right block (${grid.centerX + radius}, ${grid.centerZ + radius}).`,
    `Bot at (${grid.centerX}, ${grid.feetY}, ${grid.centerZ}) in the center, facing ${facing} (white line).`,
    ...(grid.view === 'current-level' ? ['Dark areas are solid at head height (walls or rock); normal colors are walkable floor.'] : []),
    `Brighter edges face uphill to the north, darker ones downhill. ${scale >= 4 ? 'Faint lines mark chunk borders (multiples of 16). ' : ''}Black = not loaded.`,
    `Markers: ${markerLegend(showEntities)}${showEntities ? ` (${entityCount} shown)` : ''}.`,
    `Colors: ${legend(counts)}`
  ];
  return { png: canvas.png(), text: text.join('\n') };
}

function renderSlice(bot: mineflayer.Bot, radius: number, axis: 'x' | 'z', showEntities: boolean) {
  const feet = bot.entity.position.floored();
  const { minY, maxY } = worldBounds(bot);
  const topY = Math.min(maxY, feet.y + radius);
  const bottomY = Math.max(minY, feet.y - radius);
  const width = radius * 2 + 1;
  const height = topY - bottomY + 1;
  const scale = pixelsPerBlock(Math.max(width, height));
  const canvas = new Canvas(width * scale, height * scale);
  const counts = new Map<string, number>();
  const cursor = new Vec3(feet.x, 0, feet.z);

  for (let col = 0; col < width; col++) {
    const offset = col - radius;
    if (axis === 'x') cursor.x = feet.x + offset; else cursor.z = feet.z + offset;
    // Newer world generation fills caves with plain air, so treat air below the first solid block as enclosed.
    let underground = false;
    for (let row = 0; row < height; row++) {
      cursor.y = topY - row;
      const block = bot.blockAt(cursor, false);
      let color: Rgb;
      if (!block) {
        color = UNLOADED_COLOR;
      } else if (block.name === 'cave_air' || block.name === 'void_air' || (block.name === 'air' && underground)) {
        color = CAVE_AIR_COLOR;
      } else if (block.name === 'air') {
        color = AIR_COLOR;
      } else {
        if (!isPassable(block) && surfaceName(block.name) !== 'water') underground = true;
        const name = surfaceName(block.name);
        counts.set(name, (counts.get(name) ?? 0) + 1);
        color = blockColor(name);
      }
      canvas.fill(col * scale, row * scale, scale, scale, color);
    }
  }

  const toPixel = (horizontal: number, y: number) => [
    Math.floor((horizontal - ((axis === 'x' ? feet.x : feet.z) - radius)) * scale),
    Math.floor((topY + 1 - y) * scale)
  ];
  const markerSize = Math.max(3, scale);
  let entityCount = 0;
  if (showEntities) {
    for (const { entity } of findNearbyEntities(bot, { maxDistance: radius * 1.5 })) {
      const across = axis === 'x' ? entity.position.z - (feet.z + 0.5) : entity.position.x - (feet.x + 0.5);
      if (Math.abs(across) > 2) continue;
      const [px, py] = toPixel(axis === 'x' ? entity.position.x : entity.position.z, entity.position.y + 0.5);
      if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue;
      canvas.marker(px, py, markerSize, ENTITY_COLORS[entityCategory(bot, entity)]);
      entityCount++;
    }
  }

  const [bx, byFeet] = toPixel(axis === 'x' ? bot.entity.position.x : bot.entity.position.z, feet.y);
  canvas.fill(bx - Math.floor(scale / 2) - 1, byFeet - scale * 2 - 1, scale + 2, scale * 2 + 2, OUTLINE_COLOR);
  canvas.fill(bx - Math.floor(scale / 2), byFeet - scale * 2, scale, scale * 2, BOT_COLOR);

  const [left, right] = axis === 'x' ? ['west (-X)', 'east (+X)'] : ['north (-Z)', 'south (+Z)'];
  const fixed = axis === 'x' ? `z=${feet.z}` : `x=${feet.x}`;
  const text = [
    `Vertical cross-section along the ${axis.toUpperCase()} axis at ${fixed}, ${width} blocks wide from y=${bottomY} to y=${topY}, ${scale} px per block`,
    `Left is ${left}, right is ${right}, up is the sky. Left edge ${axis}=${(axis === 'x' ? feet.x : feet.z) - radius}, right edge ${axis}=${(axis === 'x' ? feet.x : feet.z) + radius}.`,
    `Bot at (${feet.x}, ${feet.y}, ${feet.z}) in the center, drawn 2 blocks tall.`,
    `Open sky ${toHex(AIR_COLOR)}, enclosed air below the ground or under overhangs (caves, rooms) ${toHex(CAVE_AIR_COLOR)}, black = not loaded.`,
    `Markers: ${markerLegend(showEntities)}${showEntities ? ` (${entityCount} within 2 blocks of the cut shown)` : ''}.`,
    `Colors: ${legend(counts)}`
  ];
  return { png: canvas.png(), text: text.join('\n') };
}

export function registerVisionTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "scan-area",
    "Describe the terrain around the bot in text: ground height and slope in each direction, surface blocks, cliffs, water and lava, notable blocks (ores, chests, beds, trees, spawners) and nearby entities",
    {
      radius: z.coerce.number().int().min(4).max(MAX_SCAN_RADIUS).optional().describe(`Scan radius in blocks (default: 24, max: ${MAX_SCAN_RADIUS})`),
      view: viewSchema,
      xray: z.boolean().optional().describe("Also list notable blocks buried inside solid ground, such as hidden ores (default: false)")
    },
    async ({ radius = 24, view = 'auto', xray = false }: { radius?: number; view?: ViewMode; xray?: boolean }) => {
      const bot = getBot();
      const grid = scanSurface(bot, radius, view);
      const standingOn = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0), false)?.name ?? 'unknown';

      const lines = [
        `Area scan, radius ${radius}, around the bot at (${grid.centerX}, ${grid.feetY}, ${grid.centerZ}) in ${bot.game?.dimension ?? 'unknown dimension'}, standing on ${standingOn}`,
        `View: ${viewDescription(grid)}. North is -Z, east is +X.`,
        ...describeTerrain(grid),
        ...describeNotableBlocks(bot, radius, xray),
        describeEntities(bot, radius)
      ];
      return factory.createResponse(lines.join('\n'));
    }
  );

  factory.registerTool(
    "render-map",
    "Render a color map image of the area around the bot. 'top' is a top-down map (north up) with the bot, its facing direction, players and mobs marked; 'slice' is a vertical cross-section through the bot, useful for caves, cliffs and buildings",
    {
      radius: z.coerce.number().int().min(4).max(MAX_MAP_RADIUS).optional().describe(`Blocks from the bot to the map edge (default: 32, max: ${MAX_MAP_RADIUS})`),
      mode: z.enum(['top', 'slice']).optional().describe("'top' for a top-down map, 'slice' for a vertical cross-section (default: top)"),
      axis: z.enum(['x', 'z']).optional().describe("For slice mode: 'x' cuts west to east, 'z' cuts north to south (default: x)"),
      view: viewSchema,
      showEntities: z.boolean().optional().describe("Draw players, mobs and items (default: true)")
    },
    async ({ radius = 32, mode = 'top', axis = 'x', view = 'auto', showEntities = true }: {
      radius?: number; mode?: 'top' | 'slice'; axis?: 'x' | 'z'; view?: ViewMode; showEntities?: boolean;
    }) => {
      const bot = getBot();
      const { png, text } = mode === 'top'
        ? renderTopMap(bot, radius, view, showEntities)
        : renderSlice(bot, radius, axis, showEntities);
      return factory.createImageResponse(text, png);
    }
  );
}
