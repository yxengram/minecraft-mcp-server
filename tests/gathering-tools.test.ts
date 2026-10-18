import test from 'ava';
import sinon from 'sinon';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { registerGatheringTools } from '../src/tools/gathering-tools.js';
import { Autopilot } from '../src/autopilot/autopilot.js';
import { PRIORITY } from '../src/autopilot/action-arbiter.js';
import { EventStore } from '../src/event-store.js';
import { createFactory, createFakeWorld } from './_helpers.js';

const logId = minecraftData('1.20.4').blocksByName.oak_log.id;

function setup(initial: Record<string, string>) {
  const world = createFakeWorld(initial);
  const { factory, getTool } = createFactory();
  // collect-block runs as a gather task (BLUEPRINT E-004); the assertions below are about its unchanged replies.
  const events = new EventStore();
  const autopilot = new Autopilot({ events });
  autopilot.bind(world.bot as never);
  registerGatheringTools(factory, () => autopilot);

  world.bot.findBlocks.callsFake(({ matching, count }: { matching: number; count: number }) =>
    matching === logId
      ? [...world.blocks.entries()]
        .filter(([, name]) => name === 'oak_log')
        .map(([k]) => world.keyToVec(k))
        .sort((a, b) => a.distanceTo(world.bot.entity.position) - b.distanceTo(world.bot.entity.position))
        .slice(0, count)
      : []
  );
  return { ...world, getTool, autopilot, events };
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

// BLUEPRINT F-003 / fix 6: a start that is refused (here gather's unknown block) must leave the current task alone.
test.serial('collect-block with an unknown block type leaves a running follow task untouched', async (t) => {
  const clock = sinon.useFakeTimers({ now: 1.7e12 });
  t.teardown(() => clock.restore());
  const { bot, getTool, autopilot, events } = setup({});
  bot.entities = { 7: { id: 7, name: 'pig', type: 'animal', position: new Vec3(3, 64, 0), isValid: true } };

  const started = await autopilot.tasks.start('follow', { entityId: 7 });
  t.true(started.ok);
  const followId = started.ok ? started.task.id : '';
  await clock.tickAsync(500);

  const result = await getTool('collect-block')!.execute({ blockType: 'not_a_block' });

  t.true(result.isError);
  t.true(result.content[0].text.includes('Unknown block type'));
  const current = autopilot.tasks.currentTask();
  t.is(current?.id, followId);
  t.is(current?.behavior, 'follow');
  t.is(current?.status, 'running');
  t.deepEqual(autopilot.tasks.list().history, []);
  t.deepEqual(events.query({ types: ['task_cancelled'] }).events, []);
  t.false(bot.findBlocks.called);

  // The follow task keeps working afterwards.
  await clock.tickAsync(1000);
  t.is(autopilot.tasks.currentTask()?.status, 'running');
  await autopilot.tasks.cancel(followId, 'test over');
});

// E-004 / fix 9: the gather task only starts counting its time limit once it runs; collect-block must not wait forever.
for (const [label, priority] of [['critical reflex', PRIORITY.URGENT_INSTINCT], ['manual command', PRIORITY.MANUAL]] as const) {
  test.serial(`collect-block gives up after timeoutMs + 5s when a ${label} keeps its task queued`, async (t) => {
    const clock = sinon.useFakeTimers({ now: 1.7e12 });
    t.teardown(() => clock.restore());
    const { bot, getTool, autopilot } = setup({ '2,64,0': 'oak_log' });
    const holder = priority === PRIORITY.MANUAL ? 'manual goto' : 'reflex creeper-evade';
    const acquired = await autopilot.arbiter.acquire({ holder, priority });
    t.true(acquired.ok);
    if (!acquired.ok) return;

    let settled = false;
    const pending = getTool('collect-block')!.execute({ blockType: 'oak_log', timeoutMs: 1000 })
      .finally(() => { settled = true; });
    await clock.tickAsync(0);
    const queued = autopilot.tasks.currentTask();
    t.is(queued?.behavior, 'gather');
    t.is(queued?.status, 'paused');

    await clock.tickAsync(5900);
    t.false(settled, 'still waiting before timeoutMs + 5s');
    t.is(autopilot.tasks.currentTask()?.id, queued?.id);

    await clock.tickAsync(200);
    await clock.tickAsync(100);
    t.true(settled, 'returns shortly after timeoutMs + 5s');
    const result = await pending;

    t.true(result.isError);
    const text = result.content[0].text;
    t.true(text.includes('cancelled'), text);
    t.true(text.includes('time limit reached'), text);
    t.true(text.includes(String(queued?.id)), text);
    t.false(bot.dig.called);
    t.is(autopilot.tasks.currentTask(), null);
    const record = autopilot.tasks.list().history.find(r => r.id === queued?.id);
    t.is(record?.status, 'cancelled');
    t.is(record?.result, 'time limit reached');
    // The body still belongs to the holder that kept the task waiting (G1): cancelling the queued task must not stop it.
    t.true(acquired.lease.isActive());
    t.is(autopilot.arbiter.holder()?.holder, holder);
    t.false(bot.clearControlStates.called);
    t.false(bot.pathfinder.stop.called);
    acquired.lease.release();
  });
}

test('collect-block says which task it replaced', async (t) => {
  const { bot, getTool, autopilot, events } = setup({ '2,64,0': 'oak_log' });
  bot.entities = { 7: { id: 7, name: 'pig', type: 'animal', position: new Vec3(3, 64, 0), isValid: true } };
  const started = await autopilot.tasks.start('follow', { entityId: 7 });
  t.true(started.ok);

  const result = await getTool('collect-block')!.execute({ blockType: 'oak_log' });

  const text = result.content[0].text;
  t.true(text.startsWith('Mined 1 of 1 oak_log'), 'the usual reply comes first');
  t.regex(text, /\nReplaced task t1 follow \(target entity 7, range 3; running for \d+s.*\): it was cancelled\.$/);
  t.true(events.query({ types: ['task_cancelled'] }).events.some(event => event.message === 't1 follow: cancelled (replaced)'));
});
