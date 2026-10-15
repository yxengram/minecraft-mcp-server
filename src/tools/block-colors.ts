export type Rgb = [number, number, number];

export const UNLOADED_COLOR: Rgb = [0, 0, 0];
export const AIR_COLOR: Rgb = [190, 220, 255];
export const CAVE_AIR_COLOR: Rgb = [58, 63, 74];

const EXACT_COLORS: Record<string, Rgb> = {
  grass_block: [127, 178, 56],
  dirt: [151, 109, 77],
  coarse_dirt: [119, 85, 59],
  rooted_dirt: [144, 103, 76],
  podzol: [106, 74, 42],
  mycelium: [111, 99, 112],
  farmland: [143, 107, 72],
  dirt_path: [148, 121, 63],
  mud: [60, 58, 62],
  moss_block: [89, 109, 46],
  sand: [247, 233, 163],
  red_sand: [217, 123, 46],
  sandstone: [216, 201, 139],
  red_sandstone: [186, 99, 29],
  gravel: [138, 131, 128],
  clay: [164, 168, 184],
  stone: [112, 112, 112],
  cobblestone: [122, 122, 122],
  mossy_cobblestone: [102, 120, 86],
  andesite: [136, 136, 137],
  diorite: [188, 188, 189],
  granite: [149, 103, 85],
  tuff: [108, 109, 102],
  calcite: [223, 224, 220],
  deepslate: [77, 77, 82],
  cobbled_deepslate: [80, 80, 84],
  bedrock: [51, 51, 51],
  obsidian: [27, 16, 40],
  snow: [255, 255, 255],
  snow_block: [255, 255, 255],
  powder_snow: [248, 253, 253],
  ice: [160, 160, 255],
  packed_ice: [141, 180, 250],
  blue_ice: [116, 167, 253],
  water: [63, 118, 228],
  lava: [255, 90, 0],
  netherrack: [111, 53, 53],
  soul_sand: [81, 64, 47],
  soul_soil: [75, 57, 46],
  basalt: [80, 81, 86],
  blackstone: [42, 36, 41],
  crimson_nylium: [130, 31, 31],
  warped_nylium: [43, 114, 101],
  end_stone: [219, 219, 158],
  terracotta: [152, 94, 67],
  pumpkin: [227, 141, 18],
  melon: [114, 146, 30],
  hay_block: [166, 136, 38],
  cactus: [85, 127, 43],
  bamboo: [93, 144, 19],
  sugar_cane: [148, 192, 101],
  crafting_table: [133, 89, 50],
  furnace: [96, 96, 96],
  chest: [160, 112, 42],
  trapped_chest: [160, 112, 42],
  barrel: [140, 102, 60],
  spawner: [30, 45, 60],
  nether_portal: [130, 40, 220],
  glowstone: [252, 222, 128],
  magma_block: [153, 60, 30],
  bookshelf: [117, 94, 59]
};

const DYE_COLORS: Record<string, Rgb> = {
  white: [233, 236, 236],
  orange: [240, 118, 19],
  magenta: [189, 68, 179],
  light_blue: [58, 175, 217],
  yellow: [248, 198, 39],
  lime: [112, 185, 25],
  pink: [237, 141, 172],
  gray: [62, 68, 71],
  light_gray: [142, 142, 134],
  cyan: [21, 137, 145],
  purple: [121, 42, 172],
  blue: [53, 57, 157],
  brown: [114, 71, 40],
  green: [84, 109, 27],
  red: [160, 39, 34],
  black: [20, 21, 25]
};

const ORE_COLORS: [string, Rgb][] = [
  ['diamond', [93, 236, 245]],
  ['emerald', [23, 221, 98]],
  ['gold', [252, 238, 75]],
  ['iron', [216, 175, 147]],
  ['copper', [224, 129, 90]],
  ['redstone', [255, 0, 0]],
  ['lapis', [37, 70, 176]],
  ['coal', [46, 46, 46]],
  ['quartz', [234, 228, 220]],
  ['ancient_debris', [96, 64, 56]]
];

function hashColor(name: string): Rgb {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) {
    hash = Math.imul(hash ^ name.charCodeAt(i), 16777619);
  }
  const hue = (hash >>> 0) % 360;
  const s = 0.45;
  const l = 0.55;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = hue < 60 ? [c, x, 0] : hue < 120 ? [x, c, 0] : hue < 180 ? [0, c, x]
    : hue < 240 ? [0, x, c] : hue < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

function ruleColor(name: string): Rgb | undefined {
  if (name.endsWith('_ore') || name === 'ancient_debris') {
    return ORE_COLORS.find(([key]) => name.includes(key))?.[1] ?? [176, 176, 176];
  }
  if (name.endsWith('_leaves')) {
    if (name.startsWith('cherry')) return [240, 168, 200];
    if (name.startsWith('azalea') || name.startsWith('flowering_azalea')) return [96, 130, 42];
    return [58, 125, 34];
  }
  if (/_(log|wood|stem|hyphae)$/.test(name)) return [107, 82, 51];
  if (name.endsWith('_planks') || name.endsWith('_slab') || name.endsWith('_stairs')) return [168, 134, 84];
  if (name.includes('glass')) return [192, 240, 255];
  if (name.endsWith('_bed')) return [200, 50, 50];
  if (name.endsWith('shulker_box')) return [150, 100, 150];
  if (name.includes('copper')) return [192, 107, 79];
  if (name.includes('deepslate')) return EXACT_COLORS.deepslate;
  if (name.includes('sandstone')) return EXACT_COLORS.sandstone;
  if (name.includes('stone_brick') || name.includes('stone_bricks')) return [122, 121, 122];
  if (name.includes('prismarine')) return [99, 156, 151];
  if (name.includes('coral')) return [220, 110, 140];
  if (name.includes('mushroom')) return [180, 120, 100];

  const dye = Object.keys(DYE_COLORS)
    .sort((a, b) => b.length - a.length)
    .find(color => name.startsWith(`${color}_`));
  if (dye && /(wool|concrete|terracotta|carpet|glazed)/.test(name)) return DYE_COLORS[dye];

  return undefined;
}

const cache = new Map<string, Rgb>();

export function blockColor(name: string): Rgb {
  let color = cache.get(name);
  if (!color) {
    color = EXACT_COLORS[name] ?? ruleColor(name) ?? hashColor(name);
    cache.set(name, color);
  }
  return color;
}

export function shade([r, g, b]: Rgb, factor: number): Rgb {
  const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
  return [clamp(r * factor), clamp(g * factor), clamp(b * factor)];
}

export function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map(value => value.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}
