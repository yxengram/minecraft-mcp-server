import test from 'ava';
import sinon from 'sinon';
import { Vec3 } from 'vec3';
import { ActionArbiter, PRIORITY } from '../src/autopilot/action-arbiter.js';
import { TaskManager } from '../src/autopilot/task-manager.js';
import { followBehavior } from '../src/autopilot/behaviors/follow.js';
import { fleeBehavior } from '../src/autopilot/behaviors/flee.js';
import { returnHomeBehavior } from '../src/autopilot/behaviors/return-home.js';
import { EventStore } from '../src/event-store.js';

function world(entities: Record<number, Record<string, unknown>>) {
  const self = { id: 1, position: new Vec3(0, 64, 0) };
  const pathfinder: { goal: unknown; setGoal: sinon.SinonSpy; stop: sinon.SinonStub } = {
    goal: null,
    setGoal: sinon.spy((goal: unknown) => { pathfinder.goal = goal; }),
    stop: sinon.stub()
  };
  const bot = { entity: self, entities: { 1: self, ...entities }, players: {}, pathfinder, clearControlStates: sinon.stub() };
  const arbiter = new ActionArbiter({ stopBody: () => { pathfinder.goal = null; } });
  const events = new EventStore();
  const tasks = new TaskManager({ getBot: () => bot as never, getArbiter: () => arbiter, events, behaviors: [followBehavior, fleeBehavior] as never });
  return { bot, self, pathfinder, arbiter, events, tasks };
}

function steve(x: number) {
  return { id: 5, name: 'player', username: 'Steve', type: 'player', position: new Vec3(x, 64, 0), isValid: true };
}

test.serial('follow sets a dynamic follow goal right away and describes its step', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, pathfinder } = world({ 5: steve(5) });

  const started = await tasks.start('follow', { target: 'Steve', range: 4 });

  t.true(started.ok);
  t.true(pathfinder.setGoal.calledOnce);
  const [goal, dynamic] = pathfinder.setGoal.firstCall.args;
  t.is(goal.entity.username, 'Steve');
  t.is(goal.rangeSq, 16);
  t.true(dynamic);
  t.is(tasks.currentTask()?.step, 'following Steve (id 5) (distance 5.0)');
  t.is(tasks.currentTask()?.summary, 'target Steve, range 4');

  await clock.tickAsync(1000);
  t.true(pathfinder.setGoal.calledOnce, 'the goal is not re-applied while it is still in place');
  await tasks.cancel(undefined, 'done');
  t.is(pathfinder.goal, null);
});

test.serial('follow stops driving while paused and re-applies its goal when resumed', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, pathfinder, arbiter } = world({ 5: steve(5) });
  await tasks.start('follow', { entityId: 5 });

  const reflex = await arbiter.acquire({ holder: 'reflex creeper-evade', priority: PRIORITY.CRITICAL_REFLEX });
  await clock.tickAsync(1000);
  t.is(pathfinder.goal, null);
  t.true(pathfinder.setGoal.calledOnce);

  if (reflex.ok) reflex.lease.release();
  await clock.tickAsync(300);
  t.true(pathfinder.setGoal.calledTwice);
  t.not(pathfinder.goal, null);
  await tasks.cancel(undefined, 'done');
});

test.serial('follow fails after losing its target for 10 seconds and reports when it is seen again', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, bot, events } = world({ 5: steve(5) });
  await tasks.start('follow', { entityId: 5 });
  const entities = bot.entities as Record<number, unknown>;

  delete entities[5];
  await clock.tickAsync(3000);
  t.is(tasks.currentTask()?.step, 'Steve (id 5) out of sight');
  entities[5] = steve(6);
  await clock.tickAsync(2500);
  t.is(tasks.currentTask()?.status, 'running');

  delete entities[5];
  await clock.tickAsync(11000);
  const final = await tasks.waitForEnd('t1');
  t.is(final.status, 'failed');
  t.is(final.result, 'target lost: Steve (id 5) not seen for 10s');
  t.true(events.query({ types: ['task_progress'], limit: 10 }).events.some(event => event.message.includes('found Steve (id 5) again')));
});

test.serial('follow refuses to start without a visible target', async (t) => {
  const { tasks } = world({});

  const missing = await tasks.start('follow', { target: 'Steve' });
  const noTarget = await tasks.start('follow', {});

  t.false(missing.ok);
  if (!missing.ok) t.regex(missing.error, /No Steve found/);
  t.false(noTarget.ok);
  if (!noTarget.ok) t.regex(noTarget.error, /Provide entityId or target/);
});

test.serial('flee finishes after holding the distance for 2 seconds', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, self, pathfinder } = world({ 2: { id: 2, name: 'zombie', type: 'hostile', position: new Vec3(3, 64, 0), isValid: true } });

  await tasks.start('flee', { entityId: 2, distance: 10 });
  const goal = pathfinder.setGoal.firstCall.args[0];
  t.is(goal.goal.entity.id, 2);
  t.true(pathfinder.setGoal.firstCall.args[1]);

  self.position = new Vec3(-8, 64, 0);
  await clock.tickAsync(2600);
  const final = await tasks.waitForEnd('t1');
  t.is(final.status, 'done');
  t.is(final.result, 'Reached 11.0 blocks from zombie (id 2)');
});

test.serial('flee fails when it cannot get further away, ignoring time spent paused', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, arbiter } = world({ 2: { id: 2, name: 'zombie', type: 'hostile', position: new Vec3(3, 64, 0), isValid: true } });
  await tasks.start('flee', { entityId: 2, distance: 10 });

  await clock.tickAsync(3000);
  const manual = await arbiter.acquire({ holder: 'manual look-at', priority: PRIORITY.MANUAL });
  await clock.tickAsync(10000);
  if (manual.ok) manual.lease.release();
  t.true(tasks.resume().ok);
  await clock.tickAsync(3000);
  t.is(tasks.currentTask()?.status, 'running', 'paused time does not count as being stuck');

  await clock.tickAsync(3000);
  const final = await tasks.waitForEnd('t1');
  t.is(final.status, 'failed');
  t.is(final.result, 'cannot get further away from zombie (id 2) (stuck at 3.0 blocks)');
});

test.serial('flee finishes when the target disappears', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, bot } = world({ 2: { id: 2, name: 'zombie', type: 'hostile', position: new Vec3(3, 64, 0), isValid: true } });
  await tasks.start('flee', { entityId: 2 });

  (bot.entities as unknown as Record<number, { isValid: boolean }>)[2].isValid = false;
  await clock.tickAsync(300);
  const final = await tasks.waitForEnd('t1');

  t.is(final.status, 'done');
  t.is(final.result, 'zombie (id 2) is gone');
});

// ---- return-home (F-009) ----

interface SavedWaypoint { x: number; y: number; z: number; dimension?: string; createdAt: number }
interface FakeBed { name: string; position: Vec3 }
interface PendingGoto { goal: { x: number; y: number; z: number }; resolve: () => void; reject: (error: Error) => void }

const DAY = 6000;
const NIGHT = 18000;

function homeWorld({
  timeOfDay = DAY,
  dimension = 'overworld',
  waypoints = { home: { x: 20, y: 64, z: 0, dimension: 'overworld', createdAt: 0 } } as Record<string, SavedWaypoint>,
  beds = [] as FakeBed[]
} = {}) {
  const self = { id: 1, position: new Vec3(0, 64, 0) };
  const pending: PendingGoto[] = [];
  // When `holdGoto` is set, goto stays pending until `arrive()` or until the pathfinder is stopped.
  const control = { holdGoto: false };
  const moveTo = (goal: { x: number; y: number; z: number }) => { self.position = new Vec3(goal.x, goal.y, goal.z); };
  const pathfinder = {
    goal: null as unknown,
    goto: sinon.stub().callsFake((goal: PendingGoto['goal']) => {
      if (!control.holdGoto) {
        moveTo(goal);
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => pending.push({ goal, resolve, reject }));
    }),
    // Like mineflayer-pathfinder: stopping makes a running goto reject.
    stop: sinon.spy(() => {
      for (const entry of pending.splice(0)) entry.reject(new Error('Path was stopped before it could be completed!'));
    }),
    setGoal: sinon.spy((goal: unknown) => { pathfinder.goal = goal; })
  };
  const arrive = () => {
    const entry = pending.shift();
    if (!entry) throw new Error('no goto is pending');
    moveTo(entry.goal);
    entry.resolve();
  };
  const bot = {
    entity: self,
    entities: { 1: self },
    players: {},
    game: { dimension },
    time: { timeOfDay },
    thunderState: 0,
    isSleeping: false,
    pathfinder,
    clearControlStates: sinon.stub(),
    isABed: (block: FakeBed) => block.name.endsWith('_bed'),
    findBlock: sinon.stub().callsFake(({ point, matching, maxDistance }: { point: Vec3; matching: (block: FakeBed) => boolean; maxDistance: number }) =>
      beds.filter(bed => bed.position.distanceTo(point) <= maxDistance && matching(bed))
        .sort((a, b) => a.position.distanceTo(point) - b.position.distanceTo(point))[0] ?? null),
    sleep: sinon.stub().resolves(),
    wake: sinon.stub().resolves()
  };
  const store = {
    normalizeName: (name: string) => name.trim().toLowerCase(),
    get: (name: string) => waypoints[name.trim().toLowerCase()]
  };
  const arbiter = new ActionArbiter({ stopBody: () => { bot.pathfinder.stop(); bot.pathfinder.setGoal(null); } });
  const events = new EventStore();
  const tasks = new TaskManager({
    getBot: () => bot as never,
    getArbiter: () => arbiter,
    events,
    behaviors: [returnHomeBehavior] as never,
    services: { waypoints: store } as never
  });
  return { bot, self, pathfinder, control, arrive, arbiter, events, tasks };
}

test.serial('return-home in daytime walks to the waypoint, shows the distance left and finishes without sleeping', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, bot, self, control, arrive, pathfinder } = homeWorld({
    timeOfDay: DAY,
    beds: [{ name: 'red_bed', position: new Vec3(21, 64, 0) }]
  });
  control.holdGoto = true;

  const started = await tasks.start('return-home', {});
  t.true(started.ok, 'the default waypoint is home');
  await clock.tickAsync(100);
  t.true(pathfinder.goto.calledOnce);
  const step = tasks.currentTask()?.step ?? '';
  t.regex(step, /walking to/);
  t.regex(step, /home/);
  t.regex(step, /20\.0/, 'the step shows the distance left');

  arrive();
  await clock.tickAsync(100);
  const final = await tasks.waitForEnd('t1');
  t.is(final.status, 'done');
  t.regex(final.result ?? '', /arrived/i);
  t.regex(final.result ?? '', /daytime/i);
  t.true(self.position.distanceTo(new Vec3(20, 64, 0)) <= 3);
  t.true(bot.sleep.notCalled, 'no sleeping during the day');
});

test.serial('return-home at night sleeps in a bed next to the waypoint', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());
  const bed = { name: 'red_bed', position: new Vec3(21, 64, 0) };
  const { tasks, bot } = homeWorld({ timeOfDay: NIGHT, beds: [bed] });

  t.true((await tasks.start('return-home', { waypoint: 'home' })).ok);
  await clock.tickAsync(100);
  const final = await tasks.waitForEnd('t1');

  t.is(final.status, 'done');
  t.regex(final.result ?? '', /arrived/i);
  t.regex(final.result ?? '', /sleeping/i);
  t.true(bot.sleep.calledOnce);
  t.is(bot.sleep.firstCall.args[0], bed);
  const search = bot.findBlock.firstCall.args[0] as { point: Vec3; maxDistance: number };
  t.true(search.point.distanceTo(new Vec3(20, 64, 0)) <= 3, 'the bed is searched for near the waypoint');
  t.is(search.maxDistance, 8, 'bed search radius is 8 blocks');
});

test.serial('return-home at night walks over to a bed a few blocks from the waypoint before sleeping', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());
  const bed = { name: 'blue_bed', position: new Vec3(26, 64, 0) };
  const { tasks, bot, self, pathfinder } = homeWorld({ timeOfDay: NIGHT, beds: [bed] });

  t.true((await tasks.start('return-home', {})).ok);
  await clock.tickAsync(100);
  const final = await tasks.waitForEnd('t1');

  t.is(final.status, 'done');
  t.regex(final.result ?? '', /sleeping/i);
  t.true(pathfinder.goto.calledTwice);
  t.true(bot.sleep.calledOnce);
  t.true(self.position.distanceTo(bed.position) <= 3, 'sleep is only attempted once next to the bed');
});

test.serial('return-home at night without a bed nearby finishes as arrived, no bed', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, bot } = homeWorld({
    timeOfDay: NIGHT,
    beds: [{ name: 'red_bed', position: new Vec3(60, 64, 0) }]
  });

  t.true((await tasks.start('return-home', {})).ok);
  await clock.tickAsync(100);
  const final = await tasks.waitForEnd('t1');

  t.is(final.status, 'done');
  t.regex(final.result ?? '', /arrived/i);
  t.regex(final.result ?? '', /no bed/i);
  t.true(bot.sleep.notCalled);
});

test.serial('return-home with sleep: false at night only arrives', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, bot } = homeWorld({
    timeOfDay: NIGHT,
    beds: [{ name: 'red_bed', position: new Vec3(21, 64, 0) }]
  });

  t.true((await tasks.start('return-home', { sleep: false })).ok);
  await clock.tickAsync(100);
  const final = await tasks.waitForEnd('t1');

  t.is(final.status, 'done');
  t.regex(final.result ?? '', /arrived/i);
  t.notRegex(final.result ?? '', /sleeping/i);
  t.true(bot.findBlock.notCalled, 'no bed search when sleeping is not allowed');
  t.true(bot.sleep.notCalled);
});

test.serial('return-home refuses to start for an unknown waypoint', async (t) => {
  const { tasks, pathfinder } = homeWorld();

  const started = await tasks.start('return-home', { waypoint: 'Castle' });

  t.false(started.ok);
  if (!started.ok) {
    t.regex(started.error, /castle/i, 'the error names the waypoint');
    t.regex(started.error, /no waypoint|not found|unknown/i);
  }
  t.is(tasks.currentTask(), null);
  t.true(pathfinder.goto.notCalled);
});

test.serial('return-home refuses to start for a waypoint in another dimension', async (t) => {
  const { tasks, pathfinder } = homeWorld({
    dimension: 'overworld',
    waypoints: { home: { x: 20, y: 64, z: 0, dimension: 'the_nether', createdAt: 0 } }
  });

  const started = await tasks.start('return-home', {});

  t.false(started.ok);
  if (!started.ok) {
    t.regex(started.error, /home/);
    t.regex(started.error, /the_nether/);
    t.regex(started.error, /overworld/);
  }
  t.is(tasks.currentTask(), null);
  t.true(pathfinder.goto.notCalled);
});

test.serial('return-home fails when the waypoint is unreachable', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, pathfinder, bot } = homeWorld();
  pathfinder.goto.rejects(Object.assign(new Error('No path to the goal!'), { name: 'NoPath' }));

  t.true((await tasks.start('return-home', {})).ok);
  await clock.tickAsync(100);
  const final = await tasks.waitForEnd('t1');

  t.is(final.status, 'failed');
  t.regex(final.result ?? '', /'home'/, 'the failure names the waypoint');
  t.true(bot.sleep.notCalled);
});

test.serial('return-home fails when its time limit passes while walking', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, control } = homeWorld();
  control.holdGoto = true;

  t.true((await tasks.start('return-home', { timeoutMs: 5000 })).ok);
  await clock.tickAsync(4000);
  t.is(tasks.currentTask()?.status, 'running', 'still walking before the limit');

  await clock.tickAsync(1200);
  const final = await tasks.waitForEnd('t1');
  t.is(final.status, 'failed');
  t.regex(final.result ?? '', /'home'/, 'the failure names the waypoint');
  t.true((final.endedAt ?? 0) - final.startedAt <= 5500);
});

test.serial('return-home waits out a manual command without failing and walks again after resume-task', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, control, arrive, arbiter, pathfinder } = homeWorld();
  control.holdGoto = true;
  t.true((await tasks.start('return-home', {})).ok);
  await clock.tickAsync(100);
  t.true(pathfinder.goto.calledOnce);

  const manual = await arbiter.acquire({ holder: 'manual go-to', priority: PRIORITY.MANUAL });
  t.true(manual.ok);
  t.true(pathfinder.stop.called, 'the preemption stopped the running goto');
  await clock.tickAsync(3000);
  t.is(tasks.currentTask()?.status, 'paused', 'an interrupted goto is not a failure');
  t.true(pathfinder.goto.calledOnce, 'no new pathfinding while paused');

  if (manual.ok) manual.lease.release();
  t.true(tasks.resume().ok);
  await clock.tickAsync(300);
  t.true(pathfinder.goto.calledTwice, 'walks again after resume');
  t.is(tasks.currentTask()?.status, 'running');

  arrive();
  await clock.tickAsync(100);
  const final = await tasks.waitForEnd('t1');
  t.is(final.status, 'done');
  t.regex(final.result ?? '', /arrived/i);
});

test.serial('return-home gets up again when cancelled while getting into bed', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, bot } = homeWorld({ timeOfDay: NIGHT, beds: [{ name: 'red_bed', position: new Vec3(21, 64, 0) }] });
  let finishSleeping!: () => void;
  bot.sleep.callsFake(() => new Promise<void>(resolve => { finishSleeping = resolve; }));

  t.true((await tasks.start('return-home', {})).ok);
  await clock.tickAsync(100);
  t.true(bot.sleep.calledOnce, 'getting into bed');

  const cancelling = tasks.cancel(undefined, 'stop');
  finishSleeping();
  await clock.tickAsync(100);
  const cancelled = await cancelling;
  const final = await tasks.waitForEnd('t1');

  t.true(cancelled.ok);
  t.is(final.status, 'cancelled');
  t.true(bot.wake.calledOnce, 'the bot gets out of bed after the cancel');
});
