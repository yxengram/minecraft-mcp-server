import test from 'ava';
import sinon from 'sinon';
import { Vec3 } from 'vec3';
import { Autopilot } from '../src/autopilot/autopilot.js';
import { PRIORITY } from '../src/autopilot/action-arbiter.js';
import { EventStore } from '../src/event-store.js';
import { registerTaskTools } from '../src/tools/task-tools.js';
import { registerPositionTools } from '../src/tools/position-tools.js';
import { createFactory, arriveAtGoal } from './_helpers.js';

function setup({ bound = true } = {}) {
  const self = { id: 1, position: new Vec3(0, 64, 0) };
  const steve = { id: 5, name: 'player', username: 'Steve', type: 'player', position: new Vec3(4, 64, 0), isValid: true };
  const pathfinder: { goal: unknown; stop: sinon.SinonStub; goto: sinon.SinonStub; setGoal: sinon.SinonSpy } = {
    goal: null, stop: sinon.stub(), goto: sinon.stub().resolves(), setGoal: sinon.spy()
  };
  pathfinder.setGoal = sinon.spy((goal: unknown) => { pathfinder.goal = goal; });
  const bot = { entity: self, entities: { 1: self, 5: steve }, players: {}, pathfinder, clearControlStates: sinon.stub(), setControlState: sinon.stub() };
  // The pathfinder really gets the bot there; move-to-position checks the arrival (M7).
  pathfinder.goto = arriveAtGoal(bot);
  const events = new EventStore();
  const autopilot = new Autopilot({ events });
  if (bound) autopilot.bind(bot as never);
  const { factory, getTool } = createFactory();
  factory.setAutopilot(() => autopilot);
  registerTaskTools(factory, () => autopilot);
  registerPositionTools(factory, () => bot as never, () => autopilot);
  return { bot, events, autopilot, factory, getTool, pathfinder };
}

test('start-task returns at once, list-tasks shows it, cancel-task stops it', async (t) => {
  const { getTool, pathfinder } = setup();

  const started = await getTool('start-task')!.execute({ behavior: 'follow', params: { target: 'Steve' } });
  t.is(started.content[0].text, 'Started task t1: follow (target Steve, range 3)');
  t.true(pathfinder.setGoal.calledOnce);

  const listed = (await getTool('list-tasks')!.execute({})).content[0].text;
  t.regex(listed, /^Current: t1 follow \[running\]; target Steve, range 3; running for 0s; step: following Steve \(id 5\)/);

  const cancelled = await getTool('cancel-task')!.execute({});
  t.is(cancelled.content[0].text, 'Cancelled task t1: follow (target Steve, range 3)');
  const after = (await getTool('list-tasks')!.execute({})).content[0].text;
  t.true(after.startsWith('Current: none'));
  t.true(after.includes('- t1 follow [cancelled]; target Steve, range 3; cancelled by cancel-task'));
});

test('start-task reports invalid input, cancel-task and resume-task report missing tasks', async (t) => {
  const { getTool } = setup();

  const unknownTarget = await getTool('start-task')!.execute({ behavior: 'follow', params: { target: 'Alex' } });
  const noTask = await getTool('cancel-task')!.execute({});
  const noResume = await getTool('resume-task')!.execute({});

  t.true(unknownTarget.isError);
  t.regex(unknownTarget.content[0].text, /No Alex found/);
  t.true(noTask.isError);
  t.regex(noTask.content[0].text, /There is no running task/);
  t.true(noResume.isError);
});

test('start-task only accepts registered behaviors', async (t) => {
  const { getTool } = setup();

  const result = await getTool('start-task')!.execute({ behavior: 'dance' });

  t.true(result.isError);
  t.regex(result.content[0].text, /behavior: Invalid enum value\. Expected 'follow' \| 'flee'/);
});

test('tools say so when the bot is not in the game yet', async (t) => {
  const { getTool } = setup({ bound: false });

  const result = await getTool('start-task')!.execute({ behavior: 'follow', params: { target: 'Steve' } });

  t.true(result.isError);
  t.regex(result.content[0].text, /not in the game yet/);
});

test('a body tool interrupts the task, reports it, and resume-task continues it', async (t) => {
  const { getTool, autopilot, events, pathfinder } = setup();
  await getTool('start-task')!.execute({ behavior: 'follow', params: { target: 'Steve' } });

  const moved = await getTool('move-to-position')!.execute({ x: 3, y: 64, z: 3 });

  t.falsy(moved.isError);
  t.is(moved.content[0].text, 'Successfully moved to position near (3, 64, 3)');
  t.regex(moved.content[1].text, /^Interrupted before this command: task t1 follow \(target Steve, range 3; running for 0s; step: following Steve \(id 5\)[^)]*\)\)\. It is paused: call resume-task t1 to continue or cancel-task t1 to drop it\.$/);
  t.is(autopilot.currentTask()?.status, 'paused');
  t.is(autopilot.arbiter.holder(), null, 'the manual lease is released after the command');
  t.true(events.query({ types: ['task_paused'], limit: 5 }).events[0].message.includes('paused by manual command move-to-position'));

  const listed = (await getTool('list-tasks')!.execute({})).content[0].text;
  t.true(listed.includes('[paused]'));

  const resumed = await getTool('resume-task')!.execute({ id: 't1' });
  t.is(resumed.content[0].text, 'Resumed task t1: follow (target Steve, range 3)');
  await new Promise(resolve => setTimeout(resolve, 300));
  t.not(pathfinder.goal, null);
  await autopilot.tasks.cancelAll('test finished');
});

test('a body tool without a task to interrupt adds nothing to its reply', async (t) => {
  const { getTool } = setup();

  const moved = await getTool('move-to-position')!.execute({ x: 3, y: 64, z: 3 });

  t.is(moved.content.length, 1);
});

test.serial('a body tool waits for a critical reflex and says so, or reports busy after 10 seconds', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());
  const { getTool, autopilot } = setup();
  const reflex = await autopilot.arbiter.acquire({ holder: 'reflex creeper-evade', priority: PRIORITY.CRITICAL_REFLEX });

  const pending = getTool('jump')!.execute({});
  await clock.tickAsync(1500);
  if (reflex.ok) reflex.lease.release();
  const jumped = await pending;
  t.is(jumped.content[1].text, 'Waited 1.5s for reflex creeper-evade to finish before running this command.');

  await autopilot.arbiter.acquire({ holder: 'reflex low-health-retreat', priority: PRIORITY.CRITICAL_REFLEX });
  const busyPending = getTool('jump')!.execute({});
  await clock.tickAsync(10000);
  const busy = await busyPending;
  t.true(busy.isError);
  t.is(busy.content[0].text, 'Failed: Busy: reflex low-health-retreat is controlling the bot (waited 10.0s). Try again shortly');
});

test('read-only tools never take the action lease', async (t) => {
  const { getTool, autopilot } = setup();
  await getTool('start-task')!.execute({ behavior: 'follow', params: { target: 'Steve' } });

  const position = await getTool('get-position')!.execute({});

  t.is(position.content.length, 1);
  t.is(autopilot.currentTask()?.status, 'running');
  await autopilot.tasks.cancelAll('test finished');
});

test('stop-pathfinding also cancels the current task', async (t) => {
  const { getTool, autopilot, events } = setup();
  await getTool('start-task')!.execute({ behavior: 'follow', params: { target: 'Steve' } });

  const stopped = await getTool('stop-pathfinding')!.execute({});

  t.is(stopped.content[0].text, 'Stopped all movement and cancelled task t1 (follow)');
  t.is(autopilot.currentTask(), null);
  t.true(events.query({ types: ['task_cancelled'], limit: 5 }).events[0].message.includes('stopped by stop-pathfinding'));
});
