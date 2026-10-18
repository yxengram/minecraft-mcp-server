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

// A second behavior whose prepare is a spy, so tests can see whether it ran and make it refuse.
function setupWithPicky() {
  const base = setup();
  const prepare = sinon.spy((_bot: unknown, params: { target: string }) =>
    (params.target === 'nowhere' ? { error: 'Unknown waypoint nowhere' } : { value: params.target }));
  const picky: BehaviorDefinition<{ target: string }, string> = {
    name: 'picky',
    description: 'test behavior with a spied prepare',
    schema: z.object({ target: z.string() }),
    summarize: params => `target ${params.target}`,
    prepare,
    run: ({ signal }) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })
  };
  const tasks = new TaskManager({
    getBot: () => base.bot as never,
    getArbiter: () => base.arbiter,
    events: base.events,
    behaviors: [controllable(base.controls), picky] as never
  });
  return { ...base, tasks, prepare };
}

test('a start refused by prepare leaves the running task untouched', async (t) => {
  const { tasks, events, types, bot, arbiter } = setupWithPicky();
  await tasks.start('demo', { label: 'one' });
  const stopCalls = bot.pathfinder.setGoal.callCount + bot.pathfinder.stop.callCount + bot.clearControlStates.callCount;
  const lastId = events.getLastId();

  const refused = await tasks.start('picky', { target: 'nowhere' });
  const refusedSame = await tasks.start('demo', { label: 'missing' });

  t.false(refused.ok);
  if (!refused.ok) t.is(refused.error, 'Unknown waypoint nowhere');
  t.false(refusedSame.ok);
  if (!refusedSame.ok) t.is(refusedSame.error, 'target missing');
  const current = tasks.currentTask();
  t.is(current?.id, 't1');
  t.is(current?.status, 'running');
  t.is(events.getLastId(), lastId);
  t.false(types().includes('task_cancelled'));
  t.is(tasks.list().history.length, 0);
  t.true(arbiter.holder()?.holder.startsWith('task t1'));
  t.is(bot.pathfinder.setGoal.callCount + bot.pathfinder.stop.callCount + bot.clearControlStates.callCount, stopCalls);
  await tasks.cancelAll('test finished');
});

test('a start with invalid params leaves the running task untouched', async (t) => {
  const { tasks, events, types, prepare } = setupWithPicky();
  await tasks.start('demo', { label: 'one' });
  const lastId = events.getLastId();

  const invalid = await tasks.start('picky', { target: 7 });
  const missing = await tasks.start('picky', {});

  t.false(invalid.ok);
  if (!invalid.ok) t.regex(invalid.error, /Invalid params for picky: target: Expected string/);
  t.false(missing.ok);
  if (!missing.ok) t.regex(missing.error, /Invalid params for picky: target:/);
  t.false(prepare.called);
  t.is(tasks.currentTask()?.id, 't1');
  t.is(tasks.currentTask()?.status, 'running');
  t.is(events.getLastId(), lastId);
  t.false(types().includes('task_cancelled'));
  await tasks.cancelAll('test finished');
});

test('a valid replacement cancels the old task as replaced before the new one starts', async (t) => {
  const { tasks, events, prepare } = setupWithPicky();
  await tasks.start('demo', { label: 'one' });

  const replaced = await tasks.start('picky', { target: 'home' });

  t.true(replaced.ok);
  if (replaced.ok) t.is(replaced.task.id, 't2');
  t.true(prepare.calledOnce);
  const all = events.query({ limit: 100 }).events;
  const cancelled = all.find(event => event.type === 'task_cancelled');
  const started = all.find(event => event.type === 'task_started' && event.message.startsWith('t2 '));
  t.truthy(cancelled);
  t.truthy(started);
  t.true(cancelled!.message.includes('t1 demo: cancelled (replaced)'));
  t.true(started!.message.includes('t2 picky: started (target home'));
  t.true(cancelled!.id < started!.id);
  t.is(tasks.list().history[0].id, 't1');
  t.is(tasks.list().history[0].status, 'cancelled');
  t.is(tasks.currentTask()?.id, 't2');
  await tasks.cancelAll('test finished');
});

test('replace false refuses before calling prepare', async (t) => {
  const { tasks, events, prepare } = setupWithPicky();
  await tasks.start('demo', { label: 'one' });
  const lastId = events.getLastId();

  const refused = await tasks.start('picky', { target: 'home' }, { replace: false });
  const refusedBadTarget = await tasks.start('picky', { target: 'nowhere' }, { replace: false });

  t.false(refused.ok);
  if (!refused.ok) t.regex(refused.error, /Task t1 \(demo\) is already running/);
  t.false(refusedBadTarget.ok);
  if (!refusedBadTarget.ok) t.regex(refusedBadTarget.error, /Task t1 \(demo\) is already running/);
  t.false(prepare.called);
  t.is(tasks.currentTask()?.id, 't1');
  t.is(events.getLastId(), lastId);
  await tasks.cancelAll('test finished');
});

// A behavior that ignores its cancel signal for `ignoreMs` (like one stuck awaiting a pending promise),
// plus the controllable demo behavior. Every run records its label and signal so tests can spot orphans.
function setupWithStubborn(ignoreMs: number) {
  const base = setup();
  const runs: { label: string; signal: AbortSignal; finished: boolean }[] = [];
  const stubborn: BehaviorDefinition<{ label: string }, string> = {
    name: 'stubborn',
    description: 'test behavior that is slow to honour abort',
    schema: z.object({ label: z.string() }),
    summarize: params => `label ${params.label}`,
    run: async ({ params, signal }) => {
      const entry = { label: params.label, signal, finished: false };
      runs.push(entry);
      await new Promise(resolve => setTimeout(resolve, ignoreMs));
      entry.finished = true;
      return `stubborn ${params.label} finished`;
    }
  };
  const demo = controllable(base.controls);
  const tracked: BehaviorDefinition<{ label: string }, string> = {
    ...demo,
    run: context => {
      runs.push({ label: context.params.label, signal: context.signal, finished: false });
      return demo.run(context);
    }
  };
  const tasks = new TaskManager({
    getBot: () => base.bot as never,
    getArbiter: () => base.arbiter,
    events: base.events,
    behaviors: [tracked, stubborn] as never
  });
  return { ...base, tasks, runs };
}

test.serial('concurrent replacing starts while the old task is slow to stop leave only the last one running', async (t) => {
  const clock = sinon.useFakeTimers({ now: 1.7e12 });
  t.teardown(() => clock.restore());
  const { tasks, arbiter, events, runs } = setupWithStubborn(1000);
  const first = await tasks.start('stubborn', { label: 'A' });
  t.true(first.ok);

  // Neither start is awaited before the other is issued.
  const startB = tasks.start('demo', { label: 'B' });
  const startC = tasks.start('demo', { label: 'C' });
  await clock.tickAsync(3000);
  const [resultB, resultC] = await Promise.all([startB, startC]);

  t.true(resultB.ok);
  t.true(resultC.ok);
  if (!resultB.ok || !resultC.ok) return;
  t.is(resultB.task.id, 't2');
  t.is(resultC.task.id, 't3');

  const { current, history } = tasks.list();
  t.is(current?.id, 't3');
  t.is(current?.status, 'running');
  t.is(current?.summary, 'label C');
  t.deepEqual(history.map(record => [record.id, record.status, record.result]), [
    ['t2', 'cancelled', 'replaced'],
    ['t1', 'cancelled', 'replaced']
  ]);
  t.true(arbiter.holder()?.holder.startsWith('task t3 demo'));

  // Each old task was cancelled before its successor started.
  const all = events.query({ limit: 100 }).events;
  const idOf = (type: string, prefix: string) => all.find(event => event.type === type && event.message.startsWith(prefix))?.id ?? -1;
  t.true(idOf('task_cancelled', 't1 ') < idOf('task_started', 't2 '));
  t.true(idOf('task_cancelled', 't2 ') < idOf('task_started', 't3 '));
  t.is(all.filter(event => event.type === 'task_started').length, 3);

  // No behavior is left running without a task: only C's signal is still live.
  t.deepEqual(runs.map(run => [run.label, run.signal.aborted]), [['A', true], ['B', true], ['C', false]]);
  t.true(runs[0].finished);

  const cancelled = await tasks.cancel(undefined, 'cancelled by cancel-task');
  t.true(cancelled.ok);
  if (cancelled.ok) t.is(cancelled.task.id, 't3');
  t.is(tasks.currentTask(), null);
  t.is(arbiter.holder(), null);
  t.true(runs.every(run => run.signal.aborted));
  await clock.tickAsync(5000);
  t.is(tasks.currentTask(), null);
  t.is(arbiter.holder(), null);
});

test.serial('an old task that outlives the cancel grace period does not disturb the tasks started after it', async (t) => {
  const clock = sinon.useFakeTimers({ now: 1.7e12 });
  t.teardown(() => clock.restore());
  const { tasks, arbiter, bot, runs } = setupWithStubborn(5000);
  await tasks.start('stubborn', { label: 'A' });

  const startB = tasks.start('stubborn', { label: 'B' });
  const startC = tasks.start('stubborn', { label: 'C' });
  // A's cancel gives up after the 2 s grace, then B's cancel gives up after another 2 s.
  await clock.tickAsync(4500);
  const [resultB, resultC] = await Promise.all([startB, startC]);
  t.true(resultB.ok);
  t.true(resultC.ok);
  t.is(tasks.currentTask()?.id, 't3');
  t.true(arbiter.holder()?.holder.startsWith('task t3 stubborn'));
  const stopCalls = bot.clearControlStates.callCount;

  // A (at 5 s) and B (at about 7 s) finish late, after they were replaced; C (about 9 s) keeps the body and its status.
  await clock.tickAsync(3000);
  t.true(runs[0].finished);
  t.true(runs[1].finished);
  t.false(runs[2].finished);
  t.is(tasks.currentTask()?.id, 't3');
  t.is(tasks.currentTask()?.status, 'running');
  t.true(arbiter.holder()?.holder.startsWith('task t3 stubborn'));
  t.is(bot.clearControlStates.callCount, stopCalls);
  t.deepEqual(tasks.list().history.map(record => [record.id, record.status, record.result]), [
    ['t2', 'cancelled', 'replaced'],
    ['t1', 'cancelled', 'replaced']
  ]);

  // C also ignores the signal, so cancel returns after the grace period.
  const cancelC = tasks.cancel('t3', 'cancelled by cancel-task');
  t.is(tasks.currentTask(), null);
  t.is(arbiter.holder(), null);
  await clock.tickAsync(6000);
  t.true((await cancelC).ok);
  t.is(tasks.currentTask(), null);
  t.is(arbiter.holder(), null);
  t.is(tasks.list().history[0].status, 'cancelled');
});

test.serial('a replace:false start issued right after a replacing start is refused because that task is current', async (t) => {
  const clock = sinon.useFakeTimers({ now: 1.7e12 });
  t.teardown(() => clock.restore());
  const { tasks, arbiter, events, runs } = setupWithStubborn(1000);
  await tasks.start('stubborn', { label: 'A' });

  const startY = tasks.start('demo', { label: 'Y' });
  const startX = tasks.start('demo', { label: 'X' }, { replace: false });
  await clock.tickAsync(3000);
  const [resultY, resultX] = await Promise.all([startY, startX]);

  t.true(resultY.ok);
  if (resultY.ok) t.is(resultY.task.id, 't2');
  t.false(resultX.ok);
  if (!resultX.ok) t.regex(resultX.error, /Task t2 \(demo\) is already running/);
  t.is(tasks.currentTask()?.id, 't2');
  t.true(arbiter.holder()?.holder.startsWith('task t2 demo'));
  t.false(runs.some(run => run.label === 'X'));
  t.is(events.query({ types: ['task_started'], limit: 10 }).events.length, 2);
  t.deepEqual(tasks.list().history.map(record => record.id), ['t1']);
  await tasks.cancelAll('test finished');
});

test.serial('with no task running, a replace:false start right after another start is refused', async (t) => {
  const clock = sinon.useFakeTimers({ now: 1.7e12 });
  t.teardown(() => clock.restore());
  const { tasks, runs } = setupWithStubborn(1000);

  const startY = tasks.start('demo', { label: 'Y' });
  const startX = tasks.start('demo', { label: 'X' }, { replace: false });
  const [resultY, resultX] = await Promise.all([startY, startX]);

  t.true(resultY.ok);
  t.false(resultX.ok);
  if (!resultX.ok) t.regex(resultX.error, /Task t1 \(demo\) is already running/);
  t.is(tasks.currentTask()?.id, 't1');
  t.deepEqual(runs.map(run => run.label), ['Y']);
  await tasks.cancelAll('test finished');
});

// Final review: if the bot leaves while the old task is stopping, the replacement must not be installed half-way.
test('a replacement started while the bot leaves the game is refused and leaves no task behind', async (t) => {
  const bot = { pathfinder: { stop: sinon.stub(), setGoal: sinon.stub() }, clearControlStates: sinon.stub() };
  let inGame = true;
  const stubborn: BehaviorDefinition<Record<string, never>, null> = {
    name: 'stubborn',
    description: 'ignores cancellation for a moment',
    schema: z.object({}),
    summarize: () => 'stubborn',
    run: () => new Promise(resolve => setTimeout(() => resolve('late'), 200))
  };
  const tasks = new TaskManager({
    getBot: () => {
      if (!inGame) throw new Error('not in game');
      return bot as never;
    },
    getArbiter: () => new ActionArbiter({ stopBody: sinon.stub() }),
    events: new EventStore(),
    behaviors: [stubborn] as never
  });

  t.true((await tasks.start('stubborn', {})).ok);
  const replacement = tasks.start('stubborn', {});
  // Leave once the replacement is waiting for the old task to stop.
  await new Promise(resolve => setTimeout(resolve, 20));
  inGame = false;
  const result = await replacement;

  t.false(result.ok);
  if (!result.ok) t.regex(result.error, /left the game/);
  t.is(tasks.currentTask(), null, 'no phantom running task');
});

// ---- M8: hold() (E-011 F-003) ---------------------------------------------------------------------------------------
// Expected from the contract: hold(reason) pauses the current task as a manual command would ("waiting for resume-task
// or cancel-task"), stops the body only when the task was driving it, gives up the task's lease (so it does not come
// back by itself when whoever holds the body lets go), and resume-task brings it back.

test('hold pauses a driving task: the body is stopped, the lease released, and resume brings it back', async (t) => {
  const { tasks, arbiter, bot, events, types } = setup();
  await tasks.start('demo', {});
  t.is(arbiter.holder()?.holder, 'task t1 demo');
  bot.clearControlStates.resetHistory();
  bot.pathfinder.setGoal.resetHistory();

  const held = tasks.hold('paused by the instinct (ask_llm): on fire');

  t.true(held.ok);
  if (held.ok) t.is(held.task.status, 'paused');
  const reason = 'paused by the instinct (ask_llm): on fire (waiting for resume-task or cancel-task)';
  t.is(tasks.currentTask()?.status, 'paused');
  t.is(tasks.currentTask()?.pauseReason, reason);
  const last = events.query({ limit: 100 }).events.at(-1)!;
  t.is(last.type, 'task_paused');
  t.is(last.message, `t1 demo: ${reason}`);
  t.true(bot.clearControlStates.called, 'the body is stopped');
  t.true(bot.pathfinder.setGoal.calledWith(null), 'the pathfinder goal is cleared');
  t.is(arbiter.holder(), null, 'the task no longer holds the body');

  const resumed = tasks.resume('t1');
  t.true(resumed.ok);
  t.is(tasks.currentTask()?.status, 'running');
  t.is(arbiter.holder()?.holder, 'task t1 demo');
  t.deepEqual(types().slice(-2), ['task_paused', 'task_resumed']);
  await tasks.cancelAll('test finished');
});

test('hold on a task paused under a reflex leaves the body alone, and the task does not resume when the reflex ends', async (t) => {
  const { tasks, arbiter, bot, types } = setup();
  await tasks.start('demo', {});
  const reflex = await arbiter.acquire({ holder: 'instinct swim_up', priority: PRIORITY.ROUTINE_REFLEX });
  t.true(reflex.ok);
  t.is(tasks.currentTask()?.pauseReason, 'paused by instinct swim_up');
  const refused = tasks.resume();
  t.false(refused.ok, 'before hold, the task waits to resume on its own');
  if (!refused.ok) t.regex(refused.error, /will resume on its own/);
  bot.clearControlStates.resetHistory();
  bot.pathfinder.setGoal.resetHistory();

  const held = tasks.hold('paused by the instinct (suspend_task): under water');

  t.true(held.ok);
  t.is(tasks.currentTask()?.pauseReason, 'paused by the instinct (suspend_task): under water (waiting for resume-task or cancel-task)');
  t.true(bot.clearControlStates.notCalled, 'the task was not driving, so it does not stop the body');
  t.true(bot.pathfinder.setGoal.notCalled);
  t.is(arbiter.holder()?.holder, 'instinct swim_up', 'whoever holds the body keeps it');

  const resumedBefore = types().filter(type => type === 'task_resumed').length;
  if (reflex.ok) reflex.lease.release();
  t.is(tasks.currentTask()?.status, 'paused', 'still paused after the holder lets go');
  t.is(types().filter(type => type === 'task_resumed').length, resumedBefore, 'no task_resumed');
  t.is(arbiter.holder(), null, 'nobody holds the body');

  t.true(tasks.resume().ok, 'resume-task brings it back');
  t.is(tasks.currentTask()?.status, 'running');
  t.is(arbiter.holder()?.holder, 'task t1 demo');
  await tasks.cancelAll('test finished');
});

test('hold without a task is an error; a held task can still be cancelled', async (t) => {
  const { tasks, arbiter, types } = setup();
  const none = tasks.hold('paused by the instinct (ask_llm): on fire');
  t.false(none.ok);
  if (!none.ok) t.is(none.error, 'There is no running task');
  t.deepEqual(types(), []);

  await tasks.start('demo', {});
  t.true(tasks.hold('paused by the instinct (ask_llm): on fire').ok);
  const cancelled = await tasks.cancel(undefined, 'cancelled by cancel-task');
  t.true(cancelled.ok);
  t.is(tasks.currentTask(), null);
  t.is(arbiter.holder(), null);
  t.deepEqual(types().slice(-2), ['task_paused', 'task_cancelled']);
});
