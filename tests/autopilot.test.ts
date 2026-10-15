import test from 'ava';
import sinon from 'sinon';
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
