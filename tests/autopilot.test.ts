import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { Autopilot, AutopilotNotReady } from '../src/autopilot/autopilot.js';
import { PRIORITY } from '../src/autopilot/action-arbiter.js';
import { EventStore } from '../src/event-store.js';

// Policy reset on rejoin and reflex wiring arrive with M3; this covers the M1 scope.

function mockBot() {
  const self = { id: 1, position: new Vec3(0, 64, 0) };
  const steve = { id: 5, name: 'player', username: 'Steve', type: 'player', position: new Vec3(4, 64, 0), isValid: true };
  const pathfinder: Record<string, unknown> = { goal: null, stop: sinon.stub() };
  pathfinder.setGoal = sinon.spy((goal: unknown) => { pathfinder.goal = goal; });
  return { entity: self, entities: { 1: self, 5: steve }, players: {}, pathfinder, clearControlStates: sinon.stub() };
}

test('services are unavailable until a bot is bound', (t) => {
  const autopilot = new Autopilot({ events: new EventStore() });

  t.false(autopilot.isReady());
  t.throws(() => autopilot.arbiter, { instanceOf: AutopilotNotReady });
});

test('binding the same bot twice keeps one arbiter; unbinding cancels the task as disconnected', async (t) => {
  const events = new EventStore();
  const autopilot = new Autopilot({ events });
  const bot = mockBot();
  autopilot.bind(bot as never);
  const arbiter = autopilot.arbiter;
  autopilot.bind(bot as never);
  t.is(autopilot.arbiter, arbiter);

  await autopilot.tasks.start('follow', { target: 'Steve' });
  autopilot.unbind('disconnected');
  await new Promise(resolve => setTimeout(resolve, 10));

  t.false(autopilot.isReady());
  const cancelled = events.query({ types: ['task_cancelled'], limit: 10 }).events;
  t.is(cancelled.length, 1);
  t.true(cancelled[0].message.includes('t1 follow: cancelled (disconnected)'));
});

test('binding a new bot replaces the old one and cancels its task', async (t) => {
  const events = new EventStore();
  const autopilot = new Autopilot({ events });
  autopilot.bind(mockBot() as never);
  const first = autopilot.arbiter;
  await autopilot.tasks.start('follow', { target: 'Steve' });

  autopilot.bind(mockBot() as never);
  await new Promise(resolve => setTimeout(resolve, 10));

  t.not(autopilot.arbiter, first);
  t.is(autopilot.currentTask(), null);
  t.true(events.query({ types: ['task_cancelled'], limit: 10 }).events[0].message.includes('rebound to a new bot'));
});

test('interruption reports describe the interrupted task and any wait', async (t) => {
  const autopilot = new Autopilot({ events: new EventStore() });
  autopilot.bind(mockBot() as never);
  await autopilot.tasks.start('follow', { target: 'Steve' });
  t.teardown(() => autopilot.tasks.cancelAll('test finished'));

  const report = autopilot.describeInterruption(
    [{ holder: 'task t1 follow', priority: PRIORITY.TASK }, { holder: 'reflex auto-eat', priority: PRIORITY.ROUTINE_REFLEX }],
    { holder: 'reflex creeper-evade', ms: 2400 }
  );

  t.truthy(report);
  const lines = report!.split('\n');
  t.is(lines[0], 'Waited 2.4s for reflex creeper-evade to finish before running this command.');
  t.regex(lines[1], /^Interrupted before this command: task t1 follow \(target Steve, range 3; running for 0s; step: following Steve \(id 5\) \(distance 4\.0\)\)\. It is paused: call resume-task t1 to continue or cancel-task t1 to drop it\.$/);
  t.is(lines[2], 'Interrupted before this command: reflex auto-eat.');
  t.is(autopilot.describeInterruption([]), null);
});

// ---- M3: reflex engine wiring (F-001, F-012; G2, G4) -----------------------------------------------------------

/** mockBot() as an EventEmitter, with the blocks, controls and looking the reflex engine and the reflexes read. */
function eventBot() {
  const base = mockBot();
  // Raw self metadata: index 0 is the flags byte (bit 0 = burning), index 1 the air supply in ticks (15 per bubble).
  const self = Object.assign(base.entity, { metadata: [] as unknown[] });
  // Block positions "x,y,z" that hold water; everything else is stone below y 64 and air above.
  const water = new Set<string>();
  const bot = Object.assign(new EventEmitter(), base, {
    health: 20,
    food: 20,
    inventory: { items: () => [] },
    setControlState: sinon.stub(),
    look: sinon.stub().resolves(),
    blockAt: (pos: Vec3) => {
      const p = pos.floored();
      const name = water.has(`${p.x},${p.y},${p.z}`) ? 'water' : p.y < 64 ? 'stone' : 'air';
      return { name, position: p, boundingBox: name === 'stone' ? 'block' : 'empty' };
    }
  });
  return { bot, self, water };
}

const ENGINE_EVENTS = ['physicsTick', 'death', 'spawn'];

test('the reflex engine follows physicsTick only while bound; rebinding and unbinding leave no listeners behind', (t) => {
  const autopilot = new Autopilot({ events: new EventStore() });
  const first = eventBot();
  autopilot.bind(first.bot as never);

  for (const name of ENGINE_EVENTS) t.is(first.bot.listenerCount(name), 1, `one ${name} listener after bind`);
  autopilot.bind(first.bot as never);
  for (const name of ENGINE_EVENTS) t.is(first.bot.listenerCount(name), 1, `a repeated bind adds no second ${name} listener`);

  const firstEngine = autopilot.reflexes;
  first.bot.emit('physicsTick');
  t.is(firstEngine.timing().ticks, 1, 'each physicsTick reaches the reflex engine');

  const second = eventBot();
  autopilot.bind(second.bot as never);
  t.deepEqual(first.bot.eventNames(), [], 'rebinding leaves no listener on the old bot');
  for (const name of ENGINE_EVENTS) t.is(second.bot.listenerCount(name), 1);
  const secondEngine = autopilot.reflexes;
  t.not(secondEngine, firstEngine);
  second.bot.emit('physicsTick');
  t.is(secondEngine.timing().ticks, 1);

  autopilot.unbind('disconnected');
  for (const name of ENGINE_EVENTS) t.is(second.bot.listenerCount(name), 0, `unbind removes the ${name} listener`);
  t.deepEqual(second.bot.eventNames(), []);
  first.bot.emit('physicsTick');
  second.bot.emit('physicsTick');
  t.is(firstEngine.timing().ticks, 1, 'an unbound engine no longer evaluates reflexes');
  t.is(secondEngine.timing().ticks, 1);
  t.throws(() => autopilot.reflexes, { instanceOf: AutopilotNotReady });
});

test.serial('unbinding while a reflex has the task paused cancels the task without resuming it first', async (t) => {
  const clock = sinon.useFakeTimers({ now: 1.7e12 });
  t.teardown(() => clock.restore());
  const events = new EventStore();
  const autopilot = new Autopilot({ events });
  const world = eventBot();
  autopilot.bind(world.bot as never);
  t.teardown(() => autopilot.unbind('test finished'));

  const started = await autopilot.tasks.start('follow', { target: 'Steve' });
  t.true(started.ok);
  await clock.tickAsync(300);
  t.is(autopilot.currentTask()?.status, 'running');

  // Head under water with 4 bubbles left (60 ticks, below the default lowAir of 6): hazard-escape swims up, and keeps
  // swimming because the fake air supply never refills.
  world.self.metadata[1] = 60;
  world.water.add('0,65,0');
  world.bot.emit('physicsTick');
  await clock.tickAsync(300);

  // Preconditions: the engine's own reflex holds the body and the task is paused under it.
  t.is(autopilot.reflexes.current()?.name, 'hazard-escape');
  t.is(autopilot.arbiter.holder()?.holder, 'reflex hazard-escape');
  t.is(autopilot.currentTask()?.status, 'paused');

  autopilot.unbind('disconnected');
  await clock.tickAsync(100);

  const log = events.query({ limit: 200 }).events;
  const paused = log.findIndex(event => event.type === 'task_paused' && event.message === 't1 follow: paused by reflex hazard-escape');
  const cancelled = log.findIndex(event => event.type === 'task_cancelled');
  t.true(paused >= 0, 'the task was paused by the reflex');
  t.true(cancelled > paused, 'the task was cancelled after the pause');
  t.is(log[cancelled]?.message, 't1 follow: cancelled (disconnected)');
  t.deepEqual(
    log.slice(paused + 1).filter(event => event.type === 'task_resumed').map(event => event.message),
    [],
    'stopping the reflex must not hand the body back to the task before it is cancelled'
  );
  t.deepEqual(log.filter(event => event.type.startsWith('task_')).map(event => event.type), ['task_started', 'task_paused', 'task_cancelled']);

  const reflexEvents = log.filter(event => event.type === 'reflex').map(event => event.message);
  t.is(reflexEvents.length, 1);
  t.regex(reflexEvents[0], /^hazard-escape: running out of air \(4 left\) → interrupted: disconnected \(\d+\.\ds\)$/);
  t.false(autopilot.isReady());
  t.is(autopilot.currentTask(), null);
  t.deepEqual(world.bot.eventNames(), []);
});
