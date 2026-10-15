import test from 'ava';
import { registerRegionTools } from '../src/tools/region-tools.js';
import { asBot, createFactory, createFakeWorld } from './_helpers.js';

function setup(initial: Record<string, string>) {
  const world = createFakeWorld(initial);
  const { factory, getTool } = createFactory();
  registerRegionTools(factory, asBot(world.bot));
  return { ...world, getTool };
}

test('clear-region digs every block and reports empty ones', async (t) => {
  const { bot, blocks, getTool } = setup({ '1,64,0': 'stone', '2,64,0': 'dirt', '1,65,0': 'stone' });

  const result = await getTool('clear-region')!.execute({ x1: 1, y1: 64, z1: 0, x2: 2, y2: 65, z2: 0 });

  t.is(bot.dig.callCount, 3);
  t.is(blocks.size, 0);
  t.true(result.content[0].text.includes('dug 3, already empty 1'));
});

test('clear-region digs top to bottom', async (t) => {
  const { bot, getTool } = setup({ '1,64,0': 'stone', '1,65,0': 'stone', '1,66,0': 'stone' });

  await getTool('clear-region')!.execute({ x1: 1, y1: 64, z1: 0, x2: 1, y2: 66, z2: 0 });

  const ys = bot.dig.getCalls().map(call => call.args[0].position.y);
  t.deepEqual(ys, [66, 65, 64]);
});

test('clear-region skips unbreakable blocks and blocks next to lava', async (t) => {
  const { bot, getTool } = setup({ '1,64,0': 'bedrock', '3,64,0': 'stone', '4,64,0': 'lava', '1,65,0': 'stone' });

  const result = await getTool('clear-region')!.execute({ x1: 1, y1: 64, z1: 0, x2: 3, y2: 65, z2: 0 });

  const text = result.content[0].text;
  t.is(bot.dig.callCount, 1);
  t.true(text.includes('dug 1'));
  t.true(text.includes('unbreakable 1'));
  t.true(text.includes('skipped 1 next to lava'));
});

test('clear-region rejects regions that are too large', async (t) => {
  const { bot, getTool } = setup({});

  const result = await getTool('clear-region')!.execute({ x1: 0, y1: 0, z1: 0, x2: 20, y2: 20, z2: 20 });

  t.true(result.isError);
  t.true(result.content[0].text.includes('maximum is 512'));
  t.false(bot.dig.called);
});

test('clear-region counts failures, continues, and aborts after repeated failures', async (t) => {
  const { bot, getTool } = setup({ '1,64,0': 'stone', '2,64,0': 'stone' });
  bot.dig.onFirstCall().rejects(new Error('cannot reach'));

  const partial = await getTool('clear-region')!.execute({ x1: 1, y1: 64, z1: 0, x2: 2, y2: 64, z2: 0 });
  t.true(partial.content[0].text.includes('dug 1'));
  t.true(partial.content[0].text.includes('failed 1 (last error: cannot reach)'));

  const second = setup(Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`${i + 1},64,0`, 'stone'])));
  second.bot.dig.rejects(new Error('stuck'));
  const aborted = await second.getTool('clear-region')!.execute({ x1: 1, y1: 64, z1: 0, x2: 10, y2: 64, z2: 0 });
  t.is(second.bot.dig.callCount, 5);
  t.true(aborted.content[0].text.includes('Stopped early with 5 block(s)'));
});

test('clear-region equips the best harvesting tool', async (t) => {
  const { bot, getTool } = setup({ '1,64,0': 'stone' });
  const pickaxe = { name: 'iron_pickaxe' };
  bot.pathfinder.bestHarvestTool.returns(pickaxe);

  await getTool('clear-region')!.execute({ x1: 1, y1: 64, z1: 0, x2: 1, y2: 64, z2: 0 });

  t.true(bot.equip.calledOnceWith(pickaxe, 'hand'));
});

test('dig-tunnel digs a forward box of the requested size', async (t) => {
  const initial: Record<string, string> = {};
  for (let i = 1; i <= 3; i++) for (let y = 64; y <= 65; y++) initial[`${i},${y},0`] = 'stone';
  const { bot, blocks, getTool } = setup(initial);

  const result = await getTool('dig-tunnel')!.execute({ direction: 'east', length: 3 });

  t.is(bot.dig.callCount, 6);
  t.is(blocks.size, 0);
  t.true(result.content[0].text.includes('Dug east tunnel 3x1x2'));
});

test('dig-tunnel with width covers both sides', async (t) => {
  const initial: Record<string, string> = {};
  for (const x of [-1, 0, 1]) for (const z of [-1, -2]) initial[`${x},64,${z}`] = 'stone';
  const { bot, blocks, getTool } = setup(initial);

  await getTool('dig-tunnel')!.execute({ direction: 'north', length: 2, width: 3, height: 1 });

  t.is(bot.dig.callCount, 6);
  t.is(blocks.size, 0);
});

test('dig-tunnel rejects tunnels that are too big', async (t) => {
  const { bot, getTool } = setup({});

  const result = await getTool('dig-tunnel')!.execute({ direction: 'south', length: 100, width: 9, height: 9 });

  t.true(result.isError);
  t.false(bot.dig.called);
});

test('fill-region places blocks bottom to top', async (t) => {
  const { bot, blocks, getTool } = setup({ '5,63,5': 'stone', '5,63,6': 'stone' });
  bot.inventory.items = () => [{ name: 'cobblestone', count: 10, type: 4 }];
  bot.equip.callsFake(async (item: { name: string }) => { bot.heldItem = item; });

  const result = await getTool('fill-region')!.execute({ x1: 5, y1: 64, z1: 5, x2: 5, y2: 65, z2: 6, blockName: 'cobblestone' });

  t.is(bot.placeBlock.callCount, 4);
  t.is(blocks.get('5,64,5'), 'cobblestone');
  t.is(blocks.get('5,65,6'), 'cobblestone');
  t.true(result.content[0].text.includes('placed 4'));
});

test('fill-region skips occupied spaces and the bot position', async (t) => {
  const { bot, getTool } = setup({ '1,63,0': 'stone', '1,64,0': 'dirt', '0,63,0': 'stone', '2,63,0': 'stone', '2,64,0': 'air' });
  bot.inventory.items = () => [{ name: 'cobblestone', count: 10, type: 4 }];
  bot.equip.callsFake(async (item: { name: string }) => { bot.heldItem = item; });

  const result = await getTool('fill-region')!.execute({ x1: 0, y1: 64, z1: 0, x2: 2, y2: 64, z2: 0, blockName: 'cobblestone' });

  const text = result.content[0].text;
  t.true(text.includes('placed 1'));
  t.true(text.includes('already occupied 1'));
  t.true(text.includes('skipped 1 where the bot stands'));
});

test('fill-region reports running out of blocks', async (t) => {
  const { bot, getTool } = setup({ '5,63,5': 'stone', '5,63,6': 'stone', '5,63,7': 'stone' });
  let stock = 2;
  bot.inventory.items = () => (stock > 0 ? [{ name: 'cobblestone', count: stock, type: 4 }] : []);
  bot.equip.callsFake(async (item: { name: string }) => { bot.heldItem = item; });
  bot.placeBlock.callsFake(async () => { stock--; if (stock === 0) bot.heldItem = null; });

  const result = await getTool('fill-region')!.execute({ x1: 5, y1: 64, z1: 5, x2: 5, y2: 64, z2: 7, blockName: 'cobblestone' });

  t.true(result.content[0].text.includes('placed 2'));
  t.true(result.content[0].text.includes('Ran out of cobblestone with 1 space(s) left'));
});

test('fill-region errors when the block is not in the inventory at all', async (t) => {
  const { bot, getTool } = setup({ '5,63,5': 'stone' });

  const result = await getTool('fill-region')!.execute({ x1: 5, y1: 64, z1: 5, x2: 5, y2: 64, z2: 5, blockName: 'cobblestone' });

  t.true(result.isError);
  t.true(result.content[0].text.includes('No cobblestone in inventory'));
  t.false(bot.placeBlock.called);
});

test('fill-region reports spaces with no support block', async (t) => {
  const { bot, getTool } = setup({});
  bot.inventory.items = () => [{ name: 'cobblestone', count: 10, type: 4 }];
  bot.equip.callsFake(async (item: { name: string }) => { bot.heldItem = item; });

  const result = await getTool('fill-region')!.execute({ x1: 5, y1: 80, z1: 5, x2: 5, y2: 80, z2: 5, blockName: 'cobblestone' });

  t.true(result.content[0].text.includes('failed 1 (no support block'));
});

test('clear-region counts a block the pathfinder already broke on the way as cleared', async (t) => {
  const { bot, blocks, key, getTool } = setup({ '5,64,0': 'oak_log' });
  bot.canDigBlock = () => false;
  bot.pathfinder.goto.callsFake(async () => { blocks.delete(key({ x: 5, y: 64, z: 0 } as never)); });

  const result = await getTool('clear-region')!.execute({ x1: 5, y1: 64, z1: 0, x2: 5, y2: 64, z2: 0 });

  t.false(bot.dig.called);
  t.true(result.content[0].text.includes('dug 1'));
});
