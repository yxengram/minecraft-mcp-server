import test from 'ava';
import sinon from 'sinon';
import { Vec3 } from 'vec3';
import { ActionArbiter, PRIORITY } from '../src/autopilot/action-arbiter.js';
import { TaskManager } from '../src/autopilot/task-manager.js';
import { followBehavior } from '../src/autopilot/behaviors/follow.js';
import { fleeBehavior } from '../src/autopilot/behaviors/flee.js';
import { EventStore } from '../src/event-store.js';

// return-home is part of M2 and gets its tests then.

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
