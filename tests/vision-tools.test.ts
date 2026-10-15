import test from 'ava';
import zlib from 'node:zlib';
import { Vec3 } from 'vec3';
import { registerVisionTools } from '../src/tools/vision-tools.js';
import { AIR_COLOR, CAVE_AIR_COLOR, blockColor } from '../src/tools/block-colors.js';
import { asBot, createFactory } from './_helpers.js';
import { createVisionBot } from './_world.js';

type Content = { type: string; text?: string; data?: string };

const scaleFor = (blocks: number) => Math.max(1, Math.min(16, Math.floor(512 / blocks)));

function decodePng(base64: string) {
  const png = Buffer.from(base64, 'base64');
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    }
    if (type === 'IDAT') idat.push(data);
    offset += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const pixel = (x: number, y: number) => {
    const i = y * (width * 3 + 1) + 1 + x * 3;
    return [raw[i], raw[i + 1], raw[i + 2]];
  };
  return { width, height, pixel };
}

// Flat grass at y=63 with the bot standing at (0, 64, 0). East of x=6 the ground rises to y=70,
// there is a pond to the northwest, an exposed chest, a buried diamond ore and a cave pocket.
function terrain(x: number, y: number, z: number): string | null {
  if (Math.abs(x) > 30 || Math.abs(z) > 30) return null;
  if (x === 3 && y === 64 && z === 0) return 'chest';
  if (x === -2 && y === 50 && z === 0) return 'diamond_ore';
  if (x === 0 && z === 0 && y >= 55 && y <= 57) return 'air';
  const top = x >= 6 ? 70 : 63;
  if (x >= -5 && x <= -3 && z >= -5 && z <= -3) return y <= 61 ? 'sand' : y <= 63 ? 'water' : 'air';
  if (y > top) return 'air';
  if (y === top) return 'grass_block';
  return y >= top - 3 ? 'dirt' : 'stone';
}

function setup(options: Partial<Parameters<typeof createVisionBot>[0]> = {}) {
  const bot = createVisionBot({
    blockAt: terrain,
    entities: {
      2: { id: 2, name: 'zombie', type: 'hostile', position: new Vec3(-4.5, 64, 4.5) },
      3: { id: 3, name: 'player', username: 'Steve', type: 'player', position: new Vec3(2.5, 64, -6.5) }
    },
    ...options
  });
  const { factory, getTool } = createFactory();
  registerVisionTools(factory, asBot(bot));
  return { bot, getTool };
}

test('scan-area summarizes terrain, liquids, cliffs, blocks and entities', async (t) => {
  const { getTool } = setup();

  const text = (await getTool('scan-area')!.execute({ radius: 12 })).content[0].text;

  t.true(text.includes('around the bot at (0, 64, 0) in overworld, standing on grass_block'));
  t.true(text.includes('View: surface'));
  t.true(text.includes('Ground height: y=63 to y=70'));
  t.regex(text, /Surface: grass_block \d+%/);
  t.regex(text, /- east: average \+\d+/);
  t.regex(text, /- west: average 0 .*mostly grass_block, \d+% water/);
  t.true(text.includes('7 blocks at (5, 0), 5 blocks east'));
  t.true(text.includes('Water: 9 columns, nearest at (-3, 63, -3), 4 blocks northwest'));
  t.true(text.includes('Lava: none on the surface'));
  t.true(text.includes('- chest x1, nearest at (3, 64, 0), 3 blocks east'));
  t.false(text.includes('diamond_ore'));
  t.true(text.includes('1 player (Steve); 1 hostile (zombie)'));
});

test('scan-area with xray lists buried blocks', async (t) => {
  const { getTool } = setup();

  const text = (await getTool('scan-area')!.execute({ radius: 16, xray: true })).content[0].text;

  t.true(text.includes('including buried ones'));
  t.true(text.includes('- diamond_ore x1, nearest at (-2, 50, 0)'));
});

test('scan-area reports unloaded areas and missing terrain', async (t) => {
  const partial = setup({ blockAt: (x, y, z) => (x > 2 ? null : terrain(x, y, z)) });
  const partialText = (await partial.getTool('scan-area')!.execute({ radius: 8 })).content[0].text;
  t.regex(partialText, /Not loaded: \d+% of the area/);

  const empty = setup({ blockAt: () => null });
  const emptyText = (await empty.getTool('scan-area')!.execute({ radius: 4 })).content[0].text;
  t.true(emptyText.includes('No terrain data: the area is not loaded'));
});

test('scan-area in a cave separates walls from walkable floor', async (t) => {
  const cave = (x: number, y: number, z: number) => {
    if (y === 63) return 'stone';
    if (y >= 64 && y <= 65) return Math.abs(x) <= 2 && Math.abs(z) <= 2 ? 'air' : 'stone';
    return y > 65 ? 'stone' : 'stone';
  };
  const { getTool } = setup({ blockAt: cave, entities: {} });

  const text = (await getTool('scan-area')!.execute({ radius: 4 })).content[0].text;

  t.true(text.includes('View: current level'));
  t.true(text.includes('Open space at this level: 31% of the area; 69% is solid at head height'));
  t.true(text.includes('Floor: stone 100%'));
  t.true(text.includes('Steep height changes: none'));
});

test('render-map top returns a PNG with the bot, entities and a legend', async (t) => {
  const { getTool } = setup();

  const result = await getTool('render-map')!.execute({ radius: 10 });
  const [image, caption] = result.content as Content[];

  t.is(image.type, 'image');
  t.is(caption.type, 'text');
  const png = decodePng(image.data!);
  const scale = scaleFor(21);
  t.is(png.width, 21 * scale);
  t.is(png.height, 21 * scale);

  const center = Math.floor(10.5 * scale);
  t.deepEqual(png.pixel(center, center), [255, 255, 255]);
  t.deepEqual(png.pixel(Math.floor((10 - 4 + 0.5) * scale), Math.floor((10 - 4 + 0.5) * scale)), blockColor('water'));
  t.deepEqual(png.pixel(Math.floor(5.5 * scale), Math.floor(14.5 * scale)), [255, 32, 32]);
  t.deepEqual(png.pixel(Math.floor(12.5 * scale), Math.floor(3.5 * scale)), [0, 230, 255]);

  const text = caption.text!;
  t.true(text.includes('North (-Z) is up'));
  t.true(text.includes('Top-left block (-10, -10), bottom-right block (10, 10)'));
  t.true(text.includes('facing north'));
  t.true(text.includes('(2 shown)'));
  t.regex(text, /Colors: grass_block #7FB238/);
});

test('render-map top can hide entities and darkens walls underground', async (t) => {
  const cave = (x: number, y: number, z: number) => (y >= 64 && y <= 65 && Math.abs(x) <= 2 && Math.abs(z) <= 2 ? 'air' : 'stone');
  const { getTool } = setup({ blockAt: cave });

  const result = await getTool('render-map')!.execute({ radius: 5, showEntities: false });
  const [image, caption] = result.content as Content[];
  const png = decodePng(image.data!);
  const scale = scaleFor(11);

  t.false(caption.text!.includes('shown)'));
  t.true(caption.text!.includes('Dark areas are solid at head height'));
  const floor = png.pixel(Math.floor(4.5 * scale), Math.floor(6.5 * scale));
  const wall = png.pixel(Math.floor(0.5 * scale), Math.floor(0.5 * scale));
  t.deepEqual(floor, blockColor('stone'));
  t.true(wall[0] < floor[0]);
});

test('render-map slice shows sky, ground and enclosed cave air', async (t) => {
  const { getTool } = setup();

  const result = await getTool('render-map')!.execute({ mode: 'slice', radius: 10 });
  const [image, caption] = result.content as Content[];
  const png = decodePng(image.data!);
  const scale = scaleFor(21);
  const rowFor = (y: number) => Math.floor((74 - y + 0.5) * scale);
  const colFor = (x: number) => Math.floor((x + 10 + 0.5) * scale);

  t.is(png.width, 21 * scale);
  t.is(png.height, 21 * scale);
  t.deepEqual(png.pixel(colFor(-8), rowFor(70)), AIR_COLOR);
  t.deepEqual(png.pixel(colFor(-8), rowFor(63)), blockColor('grass_block'));
  t.deepEqual(png.pixel(colFor(0), rowFor(56)), CAVE_AIR_COLOR);
  t.deepEqual(png.pixel(colFor(8), rowFor(70)), blockColor('grass_block'));
  t.deepEqual(png.pixel(colFor(0), rowFor(64)), [255, 255, 255]);

  const text = caption.text!;
  t.true(text.includes('cross-section along the X axis at z=0'));
  t.true(text.includes('Left is west (-X), right is east (+X)'));
  t.true(text.includes('from y=54 to y=74'));
});

test('render-map slice along Z uses north and south', async (t) => {
  const { getTool } = setup();

  const caption = ((await getTool('render-map')!.execute({ mode: 'slice', axis: 'z', radius: 6 })).content as Content[])[1].text!;

  t.true(caption.includes('along the Z axis at x=0'));
  t.true(caption.includes('Left is north (-Z), right is south (+Z)'));
});
