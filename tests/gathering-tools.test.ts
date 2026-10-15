import test from 'ava';
import sinon from 'sinon';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { registerGatheringTools } from '../src/tools/gathering-tools.js';
import { asBot, createFactory, createFakeWorld } from './_helpers.js';

const logId = minecraftData('1.20.4').blocksByName.oak_log.id;

function setup(initial: Record<string, string>) {
  const world = createFakeWorld(initial);
  const { factory, getTool } = createFactory();
  registerGatheringTools(factory, asBot(world.bot));

  world.bot.findBlocks.callsFake(({ matching, count }: { matching: number; count: number }) =>
    matching === logId
      ? [...world.blocks.entries()]
        .filter(([, name]) => name === 'oak_log')
        .map(([k]) => world.keyToVec(k))
        .sort((a, b) => a.distanceTo(world.bot.entity.position) - b.distanceTo(world.bot.entity.position))
        .slice(0, count)
      : []
  );
  return { ...world, getTool };
}

test('collect-block mines the requested number of nearest blocks', async (t) => {
  const { bot, blocks, getTool } = setup({ '2,64,0': 'oak_log', '3,64,0': 'oak_log', '9,64,0': 'oak_log' });

  const result = await getTool('collect-block')!.execute({ blockType: 'oak_log', count: 2 });

  t.is(bot.dig.callCount, 2);
  t.deepEqual(bot.dig.getCalls().map(c => c.args[0].position.x), [2, 3]);
  t.is(blocks.size, 1);
  t.true(result.content[0].text.includes('Mined 2 of 2 oak_log'));
});

test('collect-block walks to dropped items after mining', async (t) => {
  const { bot, getTool } = setup({ '2,64,0': 'oak_log' });
  bot.entities = { 5: { name: 'item', position: new Vec3(2.5, 64, 0.5) } };

  await getTool('collect-block')!.execute({ blockType: 'oak_log' });

  t.true(bot.pathfinder.goto.calledOnce);
  t.is(bot.pathfinder.goto.firstCall.args[0].x, 2);
  t.is(bot.pathfinder.goto.firstCall.args[0].rangeSq, 0);
});

test('collect-block stops when no more blocks are found', async (t) => {
  const { getTool } = setup({ '2,64,0': 'oak_log' });

  const result = await getTool('collect-block')!.execute({ blockType: 'oak_log', count: 3 });

  t.falsy(result.isError);
  t.true(result.content[0].text.includes('Mined 1 of 3'));
  t.true(result.content[0].text.includes('no more oak_log found'));
});

test('collect-block errors when nothing could be mined', async (t) => {
  const { getTool } = setup({});

  const result = await getTool('collect-block')!.execute({ blockType: 'oak_log' });

  t.true(result.isError);
  t.true(result.content[0].text.includes('Mined 0 of 1'));
});

test('collect-block rejects unknown block names', async (t) => {
  const { bot, getTool } = setup({});

  const result = await getTool('collect-block')!.execute({ blockType: 'not_a_block' });

  t.true(result.isError);
  t.true(result.content[0].text.includes('Unknown block type'));
  t.false(bot.findBlocks.called);
});

test('collect-block skips blocks next to lava and unreachable blocks', async (t) => {
  const { bot, getTool } = setup({ '2,64,0': 'oak_log', '2,65,0': 'lava', '4,64,0': 'oak_log', '6,64,0': 'oak_log' });
  bot.dig.callsFake(async (block: { position: Vec3 }) => {
    if (block.position.x === 4) throw new Error('unreachable');
  });

  const result = await getTool('collect-block')!.execute({ blockType: 'oak_log', count: 1 });

  t.is(bot.dig.callCount, 2);
  t.true(result.content[0].text.includes('skipped 2'));
});

test('collect-block gives up after repeated failures', async (t) => {
  const initial = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`${i + 2},64,0`, 'oak_log']));
  const { bot, getTool } = setup(initial);
  bot.dig = sinon.stub().rejects(new Error('stuck'));

  const result = await getTool('collect-block')!.execute({ blockType: 'oak_log', count: 5 });

  t.is(bot.dig.callCount, 5);
  t.true(result.isError);
  t.true(result.content[0].text.includes('too many failures (last error: stuck)'));
});

test('collect-block counts target blocks the pathfinder cleared while walking to drops', async (t) => {
  const { bot, blocks, key, getTool } = setup({ '2,64,0': 'oak_log', '3,64,0': 'oak_log' });
  bot.entities = { 5: { name: 'item', position: new Vec3(2.5, 64, 0.5) } };
  bot.pathfinder.goto.callsFake(async () => { blocks.delete(key(new Vec3(3, 64, 0))); });

  const result = await getTool('collect-block')!.execute({ blockType: 'oak_log', count: 2 });

  t.is(bot.dig.callCount, 1);
  t.true(result.content[0].text.includes('Mined 2 of 2 oak_log'));
  t.falsy(result.isError);
});
