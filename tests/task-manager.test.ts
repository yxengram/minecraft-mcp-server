import test from 'ava';
import sinon from 'sinon';
import { z } from 'zod';
import { ActionArbiter, PRIORITY } from '../src/autopilot/action-arbiter.js';
import { BehaviorDefinition, TaskManager, delay } from '../src/autopilot/task-manager.js';
import { EventStore } from '../src/event-store.js';

interface Controls {
  finish?: (result: string) => void;
  fail?: (error: Error) => void;
}

// A behavior whose outcome each test controls; it reports progress and its current step.
function controllable(controls: Controls): BehaviorDefinition<{ label: string }, string> {
  return {
    name: 'demo',
    description: 'test behavior',
    schema: z.object({ label: z.string().default('x') }),
    summarize: params => `label ${params.label}`,
    prepare: (_bot, params) => (params.label === 'missing' ? { error: 'target missing' } : { value: params.label }),
    async run({ signal, setStep, report, isPaused, waitUntilRunning }) {
      setStep('working');
      report('started work');
      let settled = false;
      return new Promise<string>((resolve, reject) => {
        controls.finish = result => { settled = true; resolve(result); };
        controls.fail = error => { settled = true; reject(error); };
        signal.addEventListener('abort', () => { settled = true; reject(signal.reason); }, { once: true });
        void (async () => {
          while (!settled) {
            if (isPaused()) await waitUntilRunning().catch(() => {});
            await delay(50, signal).catch(() => {});
          }
        })();
      });
    }
  };
}

function setup() {
  const bot = { pathfinder: { stop: sinon.stub(), setGoal: sinon.stub() }, clearControlStates: sinon.stub() };
  const events = new EventStore();
  const arbiter = new ActionArbiter({ stopBody: sinon.stub() });
  const controls: Controls = {};
  const tasks = new TaskManager({
    getBot: () => bot as never,
    getArbiter: () => arbiter,
    events,
    behaviors: [controllable(controls)] as never
  });
  const types = () => events.query({ limit: 100 }).events.map(event => event.type);
  return { bot, events, arbiter, controls, tasks, types };
}

test('a task starts, reports and finishes with events in order', async (t) => {
  const { tasks, controls, types, events } = setup();

  const started = await tasks.start('demo', { label: 'a' });
  t.true(started.ok);
  if (!started.ok) return;
  t.is(started.task.id, 't1');
  t.is(tasks.currentTask()?.step, 'working');

  controls.finish!('all good');
  const final = await tasks.waitForEnd('t1');

  t.is(final.status, 'done');
  t.is(final.result, 'all good');
  t.deepEqual(types(), ['task_started', 'task_progress', 'task_done']);
  t.true(events.query({ limit: 100 }).events.at(-1)!.message.includes('t1 demo: all good'));
  t.is(tasks.currentTask(), null);
});

test('cancelling stops the bot, aborts the behavior and records the reason', async (t) => {
  const { tasks, bot, types } = setup();
  await tasks.start('demo', {});

  const cancelled = await tasks.cancel(undefined, 'cancelled by cancel-task');

  t.true(cancelled.ok);
  if (!cancelled.ok) return;
  t.is(cancelled.task.status, 'cancelled');
  t.true(bot.pathfinder.setGoal.calledWith(null));
  t.true(bot.clearControlStates.called);
  t.deepEqual(types(), ['task_started', 'task_progress', 'task_cancelled']);
  t.is(tasks.list().history[0].result, 'cancelled by cancel-task');
});

test('replace cancels the old task first, replace false refuses', async (t) => {
  const { tasks, events } = setup();
  await tasks.start('demo', { label: 'one' });

  const refused = await tasks.start('demo', { label: 'two' }, { replace: false });
  t.false(refused.ok);
  if (!refused.ok) t.regex(refused.error, /t1 \(demo\) is already running/);

  const replaced = await tasks.start('demo', { label: 'two' });
  t.true(replaced.ok);
  t.true(events.query({ types: ['task_cancelled'], limit: 10 }).events[0].message.includes('t1 demo: cancelled (replaced)'));
  t.is(tasks.currentTask()?.id, 't2');
  await tasks.cancelAll('test finished');
});

test('behavior errors fail the task', async (t) => {
  const { tasks, controls } = setup();
  await tasks.start('demo', {});

  controls.fail!(new Error('target lost'));
  const final = await tasks.waitForEnd('t1');

  t.is(final.status, 'failed');
  t.is(final.result, 'target lost');
});

test('invalid params, unknown behaviors and failed preparation are refused without creating a task', async (t) => {
  const { tasks, events } = setup();

  const unknown = await tasks.start('dance', {});
  const invalid = await tasks.start('demo', { label: 5 });
  const unprepared = await tasks.start('demo', { label: 'missing' });

  t.false(unknown.ok);
  if (!unknown.ok) t.is(unknown.error, "Unknown behavior 'dance'. Available: demo");
  t.false(invalid.ok);
  if (!invalid.ok) t.regex(invalid.error, /Invalid params for demo: label: Expected string/);
  t.false(unprepared.ok);
  if (!unprepared.ok) t.is(unprepared.error, 'target missing');
  t.is(events.getLastId(), 0);
  t.is(tasks.currentTask(), null);
});

test('a reflex pauses the task and it resumes automatically', async (t) => {
  const { tasks, arbiter, types } = setup();
  await tasks.start('demo', {});

  const reflex = await arbiter.acquire({ holder: 'reflex creeper-evade', priority: PRIORITY.CRITICAL_REFLEX });
  t.is(tasks.currentTask()?.status, 'paused');
  t.is(tasks.currentTask()?.pauseReason, 'paused by reflex creeper-evade');
  t.false(tasks.resume().ok);

  if (reflex.ok) reflex.lease.release();
  t.is(tasks.currentTask()?.status, 'running');
  t.deepEqual(types().slice(-2), ['task_paused', 'task_resumed']);
  await tasks.cancelAll('test finished');
});

test('a manual command pauses the task until resume-task', async (t) => {
  const { tasks, arbiter, types } = setup();
  await tasks.start('demo', {});

  const manual = await arbiter.acquire({ holder: 'manual move-to-position', priority: PRIORITY.MANUAL });
  if (manual.ok) manual.lease.release();

  const paused = tasks.currentTask()!;
  t.is(paused.status, 'paused');
  t.is(paused.pauseReason, 'paused by manual command move-to-position (waiting for resume-task or cancel-task)');

  const resumed = tasks.resume('t1');
  t.true(resumed.ok);
  t.is(tasks.currentTask()?.status, 'running');
  t.true(arbiter.holder()?.holder.startsWith('task t1'));
  t.deepEqual(types().slice(-2), ['task_paused', 'task_resumed']);
  await tasks.cancelAll('test finished');
});

test('resume refuses running tasks, unknown ids and missing tasks', async (t) => {
  const { tasks } = setup();
  t.false(tasks.resume().ok);
  await tasks.start('demo', {});

  const running = tasks.resume();
  const wrongId = tasks.resume('t9');

  t.false(running.ok);
  if (!running.ok) t.is(running.error, 'Task t1 is running, not paused');
  t.false(wrongId.ok);
  await tasks.cancelAll('test finished');
});

test('a task started while a manual command runs waits for it', async (t) => {
  const { tasks, arbiter } = setup();
  const manual = await arbiter.acquire({ holder: 'manual dig-block', priority: PRIORITY.MANUAL });

  await tasks.start('demo', {});
  t.is(tasks.currentTask()?.status, 'paused');
  t.is(tasks.currentTask()?.pauseReason, 'waiting for manual dig-block');

  if (manual.ok) manual.lease.release();
  t.is(tasks.currentTask()?.status, 'running');
  await tasks.cancelAll('test finished');
});

test.serial('progress events are throttled and history keeps the last 20 tasks', async (t) => {
  const clock = sinon.useFakeTimers({ now: 100000 });
  t.teardown(() => clock.restore());
  const { tasks, controls, events } = setup();

  for (let i = 0; i < 22; i++) {
    await tasks.start('demo', { label: `run${i}` });
    controls.finish!(`done ${i}`);
    await clock.tickAsync(10);
  }

  t.is(tasks.list().history.length, 20);
  t.is(tasks.list().history[0].result, 'done 21');
  // Every task reports once at start; consecutive tasks start within 2 seconds, so most reports are throttled per task only.
  t.is(events.query({ types: ['task_progress'], limit: 100 }).events.length, 22);
});

test.serial('describe summarizes the task for interruption reports', async (t) => {
  const clock = sinon.useFakeTimers({ now: 0 });
  t.teardown(() => clock.restore());
  const { tasks } = setup();
  await tasks.start('demo', { label: 'a' });
  await clock.tickAsync(130000);

  t.is(tasks.describe(tasks.currentTask()!), 'task t1 demo (label a; running for 2m10s; step: working; started work)');
  await tasks.cancelAll('test finished');
});
