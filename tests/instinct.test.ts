// Contract: docs/BLUEPRINT.md F-041. Checks F-036 to F-040 against their acceptance entries: hazards, the attention
// gate, the menu, the macros and the instinct engine. The decision client is a fake; nothing touches the network.
import test, { ExecutionContext } from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { z } from 'zod';
import { ActionArbiter, PRIORITY } from '../src/autopilot/action-arbiter.js';
import { PolicyStore } from '../src/autopilot/policy.js';
import { BehaviorDefinition, TaskManager, delay } from '../src/autopilot/task-manager.js';
import { EventStore } from '../src/event-store.js';
import { columnAbove, nearestAirPocket, nearestWater, safeToDigOut } from '../src/autopilot/hazards.js';
import { Attention, readCues } from '../src/autopilot/instinct/attention.js';
import { buildMenu } from '../src/autopilot/instinct/affordances.js';
import { MACROS } from '../src/autopilot/instinct/macros.js';
import { InstinctEngine, instinctQuestions } from '../src/autopilot/instinct/instinct-engine.js';
import { ReflexEngine } from '../src/autopilot/reflex-engine.js';
import type { DecisionResult } from '../src/decisions/openrouter-client.js';

// ---- a small block world ------------------------------------------------------------------------------------------

const EMPTY = new Set(['air', 'cave_air', 'water', 'lava', 'fire', 'seagrass']);
const UNDIGGABLE = new Set(['bedrock', 'barrier', 'water', 'lava', 'air']);

interface WorldOptions {
  /** Block name at x, y, z; anything not given is stone below y 64 and air above. */
  terrain?: (x: number, y: number, z: number) => string | undefined;
  blocks?: Record<string, string>;
  position?: Vec3;
  air?: number;
  burning?: boolean;
  onGround?: boolean;
}

function createWorld(options: WorldOptions = {}) {
  const blocks = new Map(Object.entries(options.blocks ?? {}));
  const name = (x: number, y: number, z: number) => blocks.get(`${x},${y},${z}`) ?? options.terrain?.(x, y, z) ?? (y < 64 ? 'stone' : 'air');
  const blockAt = (pos: Vec3) => {
    const p = pos.floored();
    const block = name(p.x, p.y, p.z);
    return { name: block, position: p, boundingBox: EMPTY.has(block) ? 'empty' : 'block', diggable: !UNDIGGABLE.has(block) };
  };
  const self = {
    id: 1, position: options.position ?? new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0, onGround: options.onGround ?? true,
    metadata: [options.burning ? 0x01 : 0, (options.air ?? 20) * 15] as unknown[]
  };
  const controls: Record<string, boolean> = {};
  const pathfinder = {
    goal: null as unknown,
    setGoal: sinon.spy((goal: unknown) => { pathfinder.goal = goal; }),
    stop: sinon.stub(),
    bestHarvestTool: sinon.stub().returns(null)
  };
  const bot = Object.assign(new EventEmitter(), {
    entity: self,
    entities: { 1: self },
    health: 20,
    food: 20,
    heldItem: null as { name: string } | null,
    pathfinder,
    blockAt,
    setControlState: sinon.spy((control: string, state: boolean) => { controls[control] = state; }),
    clearControlStates: sinon.spy(() => { for (const key of Object.keys(controls)) controls[key] = false; }),
    look: sinon.spy(async (yaw: number) => { self.yaw = yaw; }),
    equip: sinon.stub().resolves(),
    dig: sinon.stub().resolves(),
    stopDigging: sinon.stub()
  });
  const set = (x: number, y: number, z: number, block: string) => blocks.set(`${x},${y},${z}`, block);
  return { bot, self, controls, pathfinder, set };
}

type World = ReturnType<typeof createWorld>;

/**
 * A pool from x -3..3, z -3..3: water at y 64-65 under a ceiling at y 66. With `pocket`, the column x 3 is open at
 * y 66-67, so there is air to swim to at the east end. Outside the pool everything up to y 67 is stone.
 */
function pool({ pocket = false, ceiling = 'stone' } = {}) {
  return (x: number, y: number, z: number): string | undefined => {
    const inside = Math.abs(x) <= 3 && Math.abs(z) <= 3;
    if (y < 64 || y >= 68) return y < 64 ? 'stone' : 'air';
    if (!inside) return 'stone';
    if (y <= 65) return 'water';
    if (pocket && x === 3) return 'air';
    return y === 66 ? ceiling : 'stone';
  };
}

function useClock(t: ExecutionContext) {
  const clock = sinon.useFakeTimers({ now: 1.7e12 });
  t.teardown(() => clock.restore());
  return clock;
}

// ---- F-036 hazards ------------------------------------------------------------------------------------------------

test('columnAbove: a stone ceiling over the water, open water up to air, and deep water count as expected', (t) => {
  const trapped = createWorld({ terrain: pool() });
  t.deepEqual(columnAbove(trapped.bot as never), { open: false, ceiling: new Vec3(0, 66, 0) });

  const open = createWorld({ terrain: (x, y) => (y < 64 ? 'stone' : y <= 66 ? 'water' : 'air') });
  t.deepEqual(columnAbove(open.bot as never), { open: true, ceiling: null });

  const deep = createWorld({ terrain: (x, y) => (y < 64 ? 'stone' : 'water') });
  t.true(columnAbove(deep.bot as never).open, 'more than 8 blocks of water above still counts as open');
});

test('nearestAirPocket: air reachable through the water is found; air on the other side of a wall is not', (t) => {
  const reachable = createWorld({ terrain: pool({ pocket: true }) });
  t.deepEqual(nearestAirPocket(reachable.bot as never)?.toArray(), [3, 66, 0]);

  // Air right behind the pool wall (x -4 is stone up to y 67; here a room of air at y 64-65) does not count.
  const walled = createWorld({ terrain: (x, y, z) => (x === -5 && y >= 64 && y <= 65 && z === 0 ? 'air' : pool()(x, y, z)) });
  t.is(nearestAirPocket(walled.bot as never), null);
});

test('safeToDigOut: stone is safe; sand, bedrock, or lava above the ceiling are not', (t) => {
  const world = createWorld({ terrain: pool() });
  const ceiling = new Vec3(0, 66, 0);
  t.true(safeToDigOut(world.bot as never, ceiling));
  world.set(0, 66, 0, 'sand');
  t.false(safeToDigOut(world.bot as never, ceiling), 'sand would fall back into the hole');
  world.set(0, 66, 0, 'bedrock');
  t.false(safeToDigOut(world.bot as never, ceiling));
  world.set(0, 66, 0, 'stone');
  world.set(0, 67, 0, 'lava');
  t.false(safeToDigOut(world.bot as never, ceiling), 'lava would pour in');
});

// ---- F-037 attention ------------------------------------------------------------------------------------------------

const policy = () => new PolicyStore().get();

test('readCues: nothing on dry land; trapped under a ceiling even with full air; low air only in open water at or below lowAir', (t) => {
  t.deepEqual(readCues(createWorld().bot as never, policy()), []);

  const trapped = readCues(createWorld({ terrain: pool(), air: 20 }).bot as never, policy());
  t.deepEqual(trapped.map(cue => cue.kind), ['trapped_underwater']);
  t.is(trapped[0].detail, 'under water with a stone ceiling 1 block(s) above the head, 20 air left');

  const openWater = (air: number) => createWorld({ terrain: (x, y) => (y < 64 ? 'stone' : y <= 66 ? 'water' : 'air'), air });
  t.deepEqual(readCues(openWater(7).bot as never, policy()), [], '7 bubbles in open water is not a cue');
  t.deepEqual(readCues(openWater(6).bot as never, policy()).map(cue => cue.kind), ['low_air']);

  const lava = readCues(createWorld({ blocks: { '0,64,0': 'lava' }, burning: true }).bot as never, policy());
  t.deepEqual(lava.map(cue => cue.kind), ['in_lava', 'on_fire']);
});

test('Attention: asks once for a new cue, again after reaskMs, at once for another cue kind, after an action ends, and anew after the danger ends', (t) => {
  const attention = new Attention();
  const water = [{ kind: 'trapped_underwater' as const, detail: 'x' }];
  const both = [...water, { kind: 'on_fire' as const, detail: 'y' }];

  t.false(attention.shouldAsk([], 0, 1500), 'no cue, no request');
  t.true(attention.shouldAsk(water, 0, 1500));
  attention.noteAsked(water, 0);
  t.false(attention.shouldAsk(water, 1000, 1500), 'not again within 1.5 s');
  t.true(attention.shouldAsk(water, 1500, 1500), 're-asked after 1.5 s');
  attention.noteAsked(water, 1500);
  t.true(attention.shouldAsk(both, 1600, 1500), 'a new kind of cue is asked about at once');
  attention.noteAsked(both, 1600);
  t.false(attention.shouldAsk(both, 1700, 1500));
  attention.noteActionEnded();
  t.true(attention.shouldAsk(both, 1700, 1500), 'the action ended while the cues are still there');
  attention.noteAsked(both, 1700);

  const episode = attention.episode;
  t.false(attention.shouldAsk([], 1800, 1500));
  t.false(attention.inEpisode(), 'the danger is over');
  t.true(attention.shouldAsk(water, 1900, 1500), 'the same cue coming back is asked about at once');
  t.is(attention.episode, episode + 1);
});

// ---- F-038 menu ---------------------------------------------------------------------------------------------------

const ids = (menu: { id: string }[]) => menu.map(option => option.id);

test('buildMenu: under a stone ceiling with a reachable pocket → swim_to_air and dig_up, then the fixed options; suspend_task only with a task', (t) => {
  const world = createWorld({ terrain: pool({ pocket: true }) });
  const cues = readCues(world.bot as never, policy());
  const withTask = buildMenu(world.bot as never, cues, { hasTask: true });
  t.deepEqual(ids(withTask), ['swim_to_air', 'dig_up', 'continue', 'suspend_task', 'ask_llm', 'none']);
  t.deepEqual(withTask[0].target?.toArray(), [3, 66, 0]);
  t.regex(withTask[0].text, /3 east, 2 up/);
  t.regex(withTask[1].text, /stone ceiling 1 block\(s\) above the head with bare hands/);
  t.deepEqual(ids(buildMenu(world.bot as never, cues, { hasTask: false })), ['swim_to_air', 'dig_up', 'continue', 'ask_llm', 'none']);
});

test('buildMenu: no swim_to_air when the only air is behind a wall; no dig_up under sand', (t) => {
  const world = createWorld({ terrain: pool({ ceiling: 'sand' }) });
  const menu = buildMenu(world.bot as never, readCues(world.bot as never, policy()), { hasTask: false });
  t.deepEqual(ids(menu), ['continue', 'ask_llm', 'none'], 'nothing the bot can do itself: only the fixed options');
});

test('buildMenu: open water offers swim_up; fire next to water offers go_to_water and step_off_fire', (t) => {
  const open = createWorld({ terrain: (x, y) => (y < 64 ? 'stone' : y <= 66 ? 'water' : 'air'), air: 3 });
  t.deepEqual(ids(buildMenu(open.bot as never, readCues(open.bot as never, policy()), { hasTask: false })).slice(0, 1), ['swim_up']);

  const fire = createWorld({ blocks: { '0,64,0': 'fire', '3,64,0': 'water' }, burning: true });
  const menu = buildMenu(fire.bot as never, readCues(fire.bot as never, policy()), { hasTask: false });
  t.deepEqual(ids(menu).slice(0, 2), ['go_to_water', 'step_off_fire']);
  t.deepEqual(menu[0].target?.toArray(), [3, 64, 0]);
});

test('instinctQuestions: action is a choice over the menu (with none), urgent is a yes/no question', (t) => {
  const world = createWorld({ terrain: pool({ pocket: true }) });
  const questions = instinctQuestions(buildMenu(world.bot as never, readCues(world.bot as never, policy()), { hasTask: false }));
  t.is(questions.action.type, 'choice');
  t.deepEqual(Object.keys(questions.action.criteria as Record<string, string>), ['swim_to_air', 'dig_up', 'continue', 'ask_llm', 'none']);
  t.is(questions.urgent.type, 'noul');
  t.false('resume_task' in questions, 'no task: nothing to resume');
  t.is(instinctQuestions([], { hasTask: true }).resume_task.type, 'noul');
});

// ---- F-039 macros -------------------------------------------------------------------------------------------------

test.serial('swim_to_air steers toward the pocket by itself (look, forward, jump; never a pathfinder goal) and ends once the head is out', async (t) => {
  const clock = useClock(t);
  const world = createWorld({ terrain: pool({ pocket: true }), position: new Vec3(0.5, 64.2, 0.5) });
  const controller = new AbortController();
  const run = MACROS.swim_to_air.run({ bot: world.bot as never, signal: controller.signal, target: new Vec3(3, 66, 0) });
  await clock.tickAsync(100);
  t.true(world.controls.forward);
  t.true(world.controls.jump);
  t.true(world.bot.look.called);
  const yaw = world.bot.look.lastCall.args[0] as number;
  t.true(Math.abs(yaw - Math.atan2(-1, -0)) < 0.2, 'faces east (+x)');
  t.true(world.pathfinder.setGoal.neverCalledWith(sinon.match.object), 'no pathfinder goal');

  // Arrived: the head is in the air of the pocket.
  world.self.position = new Vec3(3.5, 65.4, 0.5);
  await clock.tickAsync(100);
  t.is(await run, 'swam to the air pocket (3 east, 2 up (block(s)))');
});

test.serial('swim_to_air gives up when it gets no closer for 4 s', async (t) => {
  const clock = useClock(t);
  const world = createWorld({ terrain: pool({ pocket: true }) });
  const run = MACROS.swim_to_air.run({ bot: world.bot as never, signal: new AbortController().signal, target: new Vec3(3, 66, 0) });
  const failed = t.throwsAsync(run, { message: /could not get closer to the air pocket/ });
  await clock.tickAsync(4300);
  await failed;
});

test.serial('dig_up sinks first, digs the ceiling only once on the floor and within reach, then holds jump; stops digging when cancelled', async (t) => {
  const clock = useClock(t);
  const world = createWorld({ terrain: pool(), onGround: false });
  const controller = new AbortController();
  const run = MACROS.dig_up.run({ bot: world.bot as never, signal: controller.signal, target: new Vec3(0, 66, 0) });
  run.catch(() => {});
  await clock.tickAsync(200);
  t.true(world.bot.dig.notCalled, 'not while floating (five times slower)');
  t.false(world.controls.jump, 'sinking: the ceiling is within reach of the floor');

  world.self.onGround = true;
  await clock.tickAsync(100);
  t.true(world.bot.dig.called, 'on the floor and within reach: digs');
  t.deepEqual(world.bot.dig.firstCall.args[0].position.toArray(), [0, 66, 0]);
  t.true(world.controls.jump, 'holds jump after digging');

  // Cancelled in the middle of the next dig: the dig is stopped and nothing more is dug.
  // Like mineflayer: a dig in progress rejects when stopDigging is called.
  world.bot.dig.callsFake(() => new Promise((_resolve, reject) => { world.bot.stopDigging.callsFake(() => reject(new Error('Digging aborted'))); }));
  await clock.tickAsync(100);
  controller.abort(new Error('cancelled'));
  await t.throwsAsync(run);
  t.true(world.bot.stopDigging.called);
  const digs = world.bot.dig.callCount;
  await clock.tickAsync(500);
  t.is(world.bot.dig.callCount, digs);
});

test.serial('dig_up reports the dig once the head is out of the water', async (t) => {
  const clock = useClock(t);
  const world = createWorld({ terrain: pool() });
  world.bot.dig.callsFake(async () => {
    world.set(0, 66, 0, 'air');
    world.set(0, 67, 0, 'air');
  });
  const run = MACROS.dig_up.run({ bot: world.bot as never, signal: new AbortController().signal, target: new Vec3(0, 66, 0) });
  await clock.tickAsync(200);
  world.self.position = new Vec3(0.5, 65.2, 0.5);
  world.set(0, 66, 0, 'air');
  await clock.tickAsync(100);
  t.is(await run, 'dug up through 1 block(s) and got to air');
});

test.serial('swim_up fails at once under a ceiling instead of pushing against it', async (t) => {
  useClock(t);
  const world = createWorld({ terrain: pool() });
  await t.throwsAsync(MACROS.swim_up.run({ bot: world.bot as never, signal: new AbortController().signal, target: null }), { message: /ceiling/ });
});

// Re-covers what the hazard-escape reflex tests checked before M8, now as cues and macros.

test('readCues: the head in kelp, seagrass, a bubble column or a waterlogged block counts as under water', (t) => {
  for (const block of ['kelp', 'seagrass', 'bubble_column']) {
    const world = createWorld({ blocks: { '0,64,0': 'water', '0,65,0': block }, terrain: (x, y) => (y < 64 ? 'stone' : y <= 67 ? 'water' : 'air'), air: 4 });
    t.deepEqual(readCues(world.bot as never, policy()).map(cue => cue.kind), ['low_air'], block);
  }
  const world = createWorld({ terrain: (x, y) => (y < 64 ? 'stone' : y <= 67 ? 'water' : 'air'), air: 4 });
  const ladder = world.bot.blockAt;
  world.bot.blockAt = (pos: Vec3) => {
    const block = ladder(pos);
    return pos.floored().equals(new Vec3(0, 65, 0)) ? { ...block, name: 'ladder', isWaterlogged: true } : block;
  };
  t.deepEqual(readCues(world.bot as never, policy()).map(cue => cue.kind), ['low_air'], 'waterlogged ladder');
});

test.serial('leave_lava steers by itself the whole time: never a pathfinder goal, forward, sprint and jump held; ends once out', async (t) => {
  const clock = useClock(t);
  const world = createWorld({ blocks: { '0,64,0': 'lava', '1,64,0': 'lava' } });
  const run = MACROS.leave_lava.run({ bot: world.bot as never, signal: new AbortController().signal, target: new Vec3(3, 64, 0) });
  await clock.tickAsync(300);
  t.true(world.controls.forward && world.controls.sprint && world.controls.jump);
  t.true(world.pathfinder.setGoal.neverCalledWith(sinon.match.object));
  world.self.position = new Vec3(3.5, 64, 0.5);
  await clock.tickAsync(100);
  t.is(await run, 'out of the lava');
});

test.serial('go_to_water walks into the water and ends once the fire is out', async (t) => {
  const clock = useClock(t);
  const world = createWorld({ blocks: { '3,64,0': 'water' }, burning: true });
  const run = MACROS.go_to_water.run({ bot: world.bot as never, signal: new AbortController().signal, target: new Vec3(3, 64, 0) });
  await clock.tickAsync(100);
  const goal = world.pathfinder.goal as { x: number; y: number; z: number };
  t.deepEqual([goal.x, goal.y, goal.z], [3, 64, 0]);
  world.self.position = new Vec3(3.5, 64, 0.5);
  await clock.tickAsync(100);
  t.true(world.bot.clearControlStates.called, 'stands still in the water');
  world.self.metadata[0] = 0;
  await clock.tickAsync(100);
  t.is(await run, 'the fire is out');
});

test.serial('go_to_water that gets no closer for 2 s fails and the water is skipped by nearestWater for a while', async (t) => {
  const clock = useClock(t);
  const world = createWorld({ blocks: { '3,64,0': 'water' }, burning: true });
  t.deepEqual(nearestWater(world.bot as never)?.toArray(), [3, 64, 0]);
  const run = MACROS.go_to_water.run({ bot: world.bot as never, signal: new AbortController().signal, target: new Vec3(3, 64, 0) });
  const failed = t.throwsAsync(run, { message: /could not reach the water/ });
  await clock.tickAsync(2300);
  await failed;
  t.is(nearestWater(world.bot as never), null, 'the unreachable water is not offered again');
  const menu = buildMenu(world.bot as never, readCues(world.bot as never, policy()), { hasTask: false });
  t.false(ids(menu).includes('go_to_water'));
});

test.serial('step_off_fire walks to the safe spot and reports that the bot still burns', async (t) => {
  const clock = useClock(t);
  const world = createWorld({ blocks: { '0,64,0': 'fire' }, burning: true });
  const run = MACROS.step_off_fire.run({ bot: world.bot as never, signal: new AbortController().signal, target: new Vec3(0, 64, -2) });
  await clock.tickAsync(100);
  t.truthy(world.pathfinder.goal);
  world.self.position = new Vec3(0.5, 64, -1.5);
  await clock.tickAsync(100);
  t.is(await run, 'off the fire (still burning; only water puts it out sooner)');
});

test('buildMenu: burning on safe ground with no water around offers only the fixed options', (t) => {
  const world = createWorld({ burning: true });
  t.deepEqual(ids(buildMenu(world.bot as never, readCues(world.bot as never, policy()), { hasTask: false })), ['continue', 'ask_llm', 'none']);
});

// ---- F-040 instinct engine ----------------------------------------------------------------------------------------

function answer(choice: string, p: number, urgent = 0.1, resume = 0.9): DecisionResult {
  return {
    ok: true,
    answers: {
      action: { type: 'choice', choice, confidence: p, probabilities: { [choice]: p } },
      urgent: { type: 'noul', noul: urgent },
      resume_task: { type: 'noul', noul: resume }
    },
    model: 'test/model',
    latencyMs: 600
  };
}

const idle: BehaviorDefinition<Record<string, never>, null> = {
  name: 'idle',
  description: 'runs until cancelled',
  schema: z.object({}),
  summarize: () => 'idle',
  async run({ signal, isPaused, waitUntilRunning }) {
    for (;;) {
      if (isPaused()) await waitUntilRunning();
      await delay(50, signal);
    }
  }
};

function createEngine(t: ExecutionContext, world: World, decide: sinon.SinonStub) {
  const events = new EventStore();
  const arbiter = new ActionArbiter({
    stopBody: () => {
      world.pathfinder.stop();
      world.pathfinder.setGoal(null);
      world.bot.clearControlStates();
    }
  });
  const store = new PolicyStore();
  const tasks = new TaskManager({ getBot: () => world.bot as never, getArbiter: () => arbiter, events, behaviors: [idle] as never });
  const engine = new InstinctEngine({ bot: world.bot as never, arbiter, tasks, getPolicy: () => store.get(), events, decide });
  engine.start();
  t.teardown(() => {
    engine.stop('test finished');
    void tasks.cancelAll('test finished');
  });
  const messages = () => events.query({ types: ['instinct'], limit: 200 }).events.map(event => event.message);
  const taskEvents = () => events.query({ limit: 200 }).events.map(event => event.type).filter(type => type.startsWith('task_'));
  return { engine, events, arbiter, store, tasks, messages, taskEvents, holder: () => arbiter.holder() };
}

test.serial('trapped under water: a confident swim_to_air runs at 15 and pauses the task; urgent runs at 30', async (t) => {
  const clock = useClock(t);
  for (const [urgent, priority] of [[0.2, PRIORITY.ROUTINE_REFLEX], [0.9, PRIORITY.CRITICAL_REFLEX]] as const) {
    const world = createWorld({ terrain: pool({ pocket: true }) });
    const decide = sinon.stub().resolves(answer('swim_to_air', 0.9, urgent));
    const { engine, tasks, holder, messages, taskEvents } = createEngine(t, world, decide);
    t.true((await tasks.start('idle', {})).ok);

    engine.tick();
    await clock.tickAsync(0);

    t.true(decide.calledOnce);
    const [state] = decide.firstCall.args as [Record<string, unknown>];
    t.deepEqual(state.danger, ['under water with a stone ceiling 1 block(s) above the head, 20 air left']);
    t.regex(String(state.doing_now), /task t1 idle/);
    t.is(state.ai_player_intent, 'none given');
    t.deepEqual(holder(), { holder: 'instinct swim_to_air', priority });
    t.is(tasks.currentTask()?.status, 'paused');
    t.deepEqual(taskEvents(), ['task_started', 'task_paused']);
    t.regex(messages()[0], new RegExp(`^under water .* → swim_to_air p=0\\.90, urgent p=${urgent.toFixed(2)}, resume task p=0\\.90 \\(test/model; 600ms\\) → started swim_to_air${urgent >= 0.6 ? ' \\(urgent\\)' : ''}$`));
    t.deepEqual(Object.keys(decide.firstCall.args[1] as object), ['action', 'urgent', 'resume_task'], 'with a task, the model is asked whether it may carry on');
    engine.stop('next case');
    await tasks.cancelAll('next case');
  }
});

test.serial('a command from the AI player is not interrupted unless the answer is urgent', async (t) => {
  const clock = useClock(t);
  const world = createWorld({ terrain: pool({ pocket: true }) });
  const decide = sinon.stub().resolves(answer('swim_to_air', 0.9, 0.2));
  const { engine, arbiter, store, holder, messages } = createEngine(t, world, decide);
  const manual = await arbiter.acquire({ holder: 'manual dig-block', priority: PRIORITY.MANUAL });
  t.true(manual.ok);

  engine.tick();
  await clock.tickAsync(0);
  t.is(holder()?.holder, 'manual dig-block');
  t.regex(messages().at(-1)!, /→ not interrupting the AI player's command \(not urgent\)$/);

  decide.resolves(answer('swim_to_air', 0.9, 0.9));
  await clock.tickAsync(store.get().instinct.reaskMs);
  engine.tick();
  await clock.tickAsync(0);
  t.deepEqual(holder(), { holder: 'instinct swim_to_air', priority: PRIORITY.CRITICAL_REFLEX }, 'urgent: takes over from the command');
  if (manual.ok) t.false(manual.lease.isActive());
});

test.serial('without a decision the bot does not act: one offline event per danger episode, no matter how often it re-asks', async (t) => {
  const clock = useClock(t);
  const world = createWorld({ terrain: pool({ pocket: true }) });
  const decide = sinon.stub().resolves({ ok: false, error: 'disabled', message: 'no OpenRouter API key is configured (OPENROUTER_API_KEY)', latencyMs: 0 });
  const { engine, tasks, holder, messages, store } = createEngine(t, world, decide);
  t.true((await tasks.start('idle', {})).ok);

  for (let i = 0; i < 4; i++) {
    engine.tick();
    await clock.tickAsync(store.get().instinct.reaskMs);
  }
  t.is(decide.callCount, 4, 'it keeps asking while the cue lasts');
  t.deepEqual(holder()?.holder, 'task t1 idle', 'the task keeps the body');
  t.is(tasks.currentTask()?.status, 'running');
  t.deepEqual(messages(), [
    'instinct offline (disabled: no OpenRouter API key is configured (OPENROUTER_API_KEY)): under water with a stone ceiling 1 block(s) above the head, 20 air left; the bot does not act on its own, decide what to do'
  ]);
  t.is(engine.status().offline, 'disabled: no OpenRouter API key is configured (OPENROUTER_API_KEY)');
});

test.serial('ask_llm and suspend_task stop the running action and hold the task; it does not resume until resume-task', async (t) => {
  const clock = useClock(t);
  for (const choice of ['ask_llm', 'suspend_task']) {
    const world = createWorld({ terrain: pool({ pocket: true }) });
    const decide = sinon.stub().resolves(answer('swim_to_air', 0.9));
    const { engine, tasks, holder, messages, taskEvents, store } = createEngine(t, world, decide);
    t.true((await tasks.start('idle', {})).ok);
    engine.tick();
    await clock.tickAsync(0);
    t.is(holder()?.holder, 'instinct swim_to_air');

    decide.resolves(answer(choice, 0.8));
    await clock.tickAsync(store.get().instinct.reaskMs);
    engine.tick();
    await clock.tickAsync(0);

    t.is(holder(), null, 'the action was stopped and nobody holds the body');
    const task = tasks.currentTask();
    t.is(task?.status, 'paused');
    t.regex(task?.pauseReason ?? '', new RegExp(`^paused by the instinct \\(${choice}\\): under water .* \\(waiting for resume-task or cancel-task\\)$`));
    t.true(messages().some(message => message.startsWith(`swim_to_air → interrupted: stopped: ${choice} (`)));
    t.regex(messages().at(-1)!, new RegExp(`→ ${choice} p=0\\.80, .* → paused task t1 and left it to the AI player$`));

    await clock.tickAsync(3000);
    t.deepEqual(taskEvents(), ['task_started', 'task_paused', 'task_paused'], 'never resumed, not even for a moment between stopping the action and holding the task');
    t.true(tasks.resume('t1').ok);
    t.is(tasks.currentTask()?.status, 'running');
    engine.stop('next case');
    await tasks.cancelAll('next case');
  }
});

test.serial('continue keeps the running action; the same action chosen again is not restarted; below the threshold nothing changes', async (t) => {
  const clock = useClock(t);
  const world = createWorld({ terrain: pool({ pocket: true }) });
  const run = sinon.spy(MACROS.swim_to_air, 'run');
  t.teardown(() => run.restore());
  const decide = sinon.stub().resolves(answer('swim_to_air', 0.9));
  const { engine, holder, store, messages } = createEngine(t, world, decide);
  // Re-ask quickly, so all three answers arrive before the (unmoving) swim gives up after 4 s.
  t.true(store.update({ instinct: { reaskMs: 500 } }, 'llm').ok);
  engine.tick();
  await clock.tickAsync(0);
  t.is(run.callCount, 1);

  for (const next of [answer('swim_to_air', 0.95), answer('continue', 0.7), answer('dig_up', 0.3)]) {
    decide.resolves(next);
    await clock.tickAsync(store.get().instinct.reaskMs);
    engine.tick();
    await clock.tickAsync(0);
  }
  t.is(run.callCount, 1, 'never restarted');
  t.is(holder()?.holder, 'instinct swim_to_air');
  const last = messages().slice(-3);
  t.regex(last[0], /→ kept swim_to_air running$/);
  t.regex(last[1], /→ continue p=0\.70, .* → no change$/);
  t.regex(last[2], /→ dig_up p=0\.30, .* → not confident enough \(below 0\.4\); no change$/);
});

test.serial('only one request is in flight; an answer that arrives after the danger ended is not acted on', async (t) => {
  const clock = useClock(t);
  const world = createWorld({ terrain: pool({ pocket: true }) });
  let reply: (result: DecisionResult) => void = () => {};
  const decide = sinon.stub().callsFake(() => new Promise<DecisionResult>(resolve => { reply = resolve; }));
  const { engine, holder, store, messages } = createEngine(t, world, decide);
  engine.tick();
  await clock.tickAsync(store.get().instinct.reaskMs * 2);
  engine.tick();
  t.true(decide.calledOnce, 'no second request while the first is open');

  // The bot got out meanwhile (e.g. the AI player moved it).
  world.self.position = new Vec3(10.5, 70, 10.5);
  engine.tick();
  reply(answer('swim_to_air', 0.9));
  await clock.tickAsync(0);
  t.is(holder(), null);
  t.regex(messages().at(-1)!, /→ arrived after the danger ended; not acted on$/);
});

test.serial('when the action finishes it reports the result, gives the body back to the task, and the gate asks again if a cue is left', async (t) => {
  const clock = useClock(t);
  const world = createWorld({ terrain: pool({ pocket: true }), position: new Vec3(0.5, 64.2, 0.5) });
  const decide = sinon.stub().resolves(answer('swim_to_air', 0.9));
  const { engine, tasks, holder, messages, taskEvents } = createEngine(t, world, decide);
  t.true((await tasks.start('idle', {})).ok);
  engine.tick();
  await clock.tickAsync(0);

  world.self.position = new Vec3(3.5, 65.4, 0.5);
  await clock.tickAsync(100);
  t.true(messages().some(message => /^swim_to_air → swam to the air pocket \(3 east, 2 up \(block\(s\)\)\) \(\d+\.\ds\)$/.test(message)));
  t.is(holder()?.holder, 'task t1 idle');
  t.deepEqual(taskEvents(), ['task_started', 'task_paused', 'task_resumed']);

  // Out of the water now: nothing to ask about.
  engine.tick();
  await clock.tickAsync(0);
  t.true(decide.calledOnce);

  // Sinks back under the ceiling: the gate asks again at once (the action ended).
  world.self.position = new Vec3(0.5, 64.2, 0.5);
  engine.tick();
  await clock.tickAsync(0);
  t.true(decide.calledTwice);
});

test.serial('earlier dangers under the same task are reported to the model (the escape → resume → back in loop), with the rounds asked', async (t) => {
  const clock = useClock(t);
  const world = createWorld({ terrain: pool({ pocket: true }), position: new Vec3(0.5, 64.2, 0.5) });
  const decide = sinon.stub().resolves(answer('swim_to_air', 0.9));
  const { engine, tasks } = createEngine(t, world, decide);
  t.true((await tasks.start('idle', {})).ok);
  const state = (call: number) => decide.getCall(call).args[0] as Record<string, unknown>;

  engine.tick();
  await clock.tickAsync(0);
  t.is(state(0).earlier_dangers, 'none');
  t.is(state(0).times_asked_about_this_danger, 1);

  // Escapes; the task resumes; out of the water the episode ends.
  world.self.position = new Vec3(3.5, 65.4, 0.5);
  await clock.tickAsync(100);
  world.self.position = new Vec3(10.5, 70, 10.5);
  engine.tick();
  await clock.tickAsync(20000);

  // The task leads it back under the ceiling.
  world.self.position = new Vec3(0.5, 64.2, 0.5);
  engine.tick();
  await clock.tickAsync(0);
  const earlier = state(1).earlier_dangers as string[];
  t.is(earlier.length, 1);
  t.regex(earlier[0], /^20s ago: trapped_underwater, ended with swim_to_air → done: swam to the air pocket .*; task t1 idle \(running\) afterwards$/);
  t.is(state(1).times_asked_about_this_danger, 1);

  await clock.tickAsync(1500);
  engine.tick();
  await clock.tickAsync(0);
  t.is(state(2).times_asked_about_this_danger, 2, 'rounds within the same danger are counted');
});

test.serial('the model says the task should not carry on (it keeps leading the bot back): after the escape the task is held, never resumed', async (t) => {
  const clock = useClock(t);
  const world = createWorld({ terrain: pool({ pocket: true }), position: new Vec3(0.5, 64.2, 0.5) });
  const decide = sinon.stub().resolves(answer('swim_to_air', 0.6, 0.5, 0.2));
  const { engine, tasks, holder, messages, taskEvents } = createEngine(t, world, decide);
  t.true((await tasks.start('idle', {})).ok);
  engine.tick();
  await clock.tickAsync(0);
  t.regex(messages()[0], /resume task p=0\.20 .* → started swim_to_air; the task will wait for the AI player afterwards$/);

  world.self.position = new Vec3(3.5, 65.4, 0.5);
  await clock.tickAsync(100);
  t.is(holder(), null, 'nobody drives: the task was held before the body was let go');
  t.is(tasks.currentTask()?.status, 'paused');
  t.regex(tasks.currentTask()?.pauseReason ?? '', /^held by the instinct after swim_to_air: the task kept leading the bot back into this danger \(waiting for resume-task or cancel-task\)$/);
  t.regex(messages().at(-1)!, /^swim_to_air → swam to the air pocket .* \(\d+\.\ds\); task t1 held for the AI player$/);
  await clock.tickAsync(3000);
  t.deepEqual(taskEvents(), ['task_started', 'task_paused', 'task_paused'], 'no task_resumed at any point');
});

test.serial('the intent the AI player set is passed to the decision model', async (t) => {
  const clock = useClock(t);
  const world = createWorld({ terrain: pool({ pocket: true }) });
  const decide = sinon.stub().resolves(answer('continue', 0.9));
  const { engine, store, holder } = createEngine(t, world, decide);
  t.true(store.update({ instinct: { intent: 'diving to the ocean monument on purpose' } }, 'llm').ok);
  engine.tick();
  await clock.tickAsync(0);
  t.is((decide.firstCall.args[0] as Record<string, unknown>).ai_player_intent, 'diving to the ocean monument on purpose');
  t.is(holder(), null, 'continue: nothing taken over');
});

test.serial('turned off in the policy: no requests and a running action stops', async (t) => {
  const clock = useClock(t);
  const world = createWorld({ terrain: pool({ pocket: true }) });
  const decide = sinon.stub().resolves(answer('swim_to_air', 0.9));
  const { engine, store, holder } = createEngine(t, world, decide);
  engine.tick();
  await clock.tickAsync(0);
  t.is(holder()?.holder, 'instinct swim_to_air');
  t.true(store.update({ instinct: { enabled: false } }, 'llm').ok);
  engine.tick();
  await clock.tickAsync(store.get().instinct.reaskMs * 3);
  engine.tick();
  t.is(holder(), null);
  t.true(decide.calledOnce);
});

test.serial('death: the reflex engine cancels the task first, then the instinct action is interrupted; nothing resumes', async (t) => {
  const clock = useClock(t);
  const world = createWorld({ terrain: pool({ pocket: true }) });
  const decide = sinon.stub().resolves(answer('swim_to_air', 0.9));
  const events = new EventStore();
  const arbiter = new ActionArbiter({ stopBody: () => world.bot.clearControlStates() });
  const store = new PolicyStore();
  const tasks = new TaskManager({ getBot: () => world.bot as never, getArbiter: () => arbiter, events, behaviors: [idle] as never });
  // Wired in the same order as autopilot.ts: the reflex engine first, then the instinct.
  const reflexes = new ReflexEngine({ bot: world.bot as never, arbiter, getPolicy: () => store.get(), events, reflexes: [], onDeath: () => void tasks.cancelAll('the bot died') });
  reflexes.start();
  const engine = new InstinctEngine({ bot: world.bot as never, arbiter, tasks, getPolicy: () => store.get(), events, decide });
  engine.start();
  t.teardown(() => {
    engine.stop('test finished');
    reflexes.stop('test finished');
  });
  t.true((await tasks.start('idle', {})).ok);
  engine.tick();
  await clock.tickAsync(0);
  t.is(arbiter.holder()?.holder, 'instinct swim_to_air');

  world.bot.health = 0;
  world.bot.emit('death');
  await clock.tickAsync(1000);

  t.is(arbiter.holder(), null);
  const types = events.query({ limit: 200 }).events.map(event => event.type).filter(type => type.startsWith('task_'));
  t.deepEqual(types, ['task_started', 'task_paused', 'task_cancelled']);
  t.true(events.query({ types: ['instinct'], limit: 200 }).events.some(event => event.message.startsWith('swim_to_air → interrupted: the bot died')));
});
