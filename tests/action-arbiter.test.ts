import test from 'ava';
import sinon from 'sinon';
import { ActionArbiter, PRIORITY } from '../src/autopilot/action-arbiter.js';

function arbiter() {
  const stopBody = sinon.stub();
  return { arbiter: new ActionArbiter({ stopBody }), stopBody };
}

function holder(name: string, priority: (typeof PRIORITY)[keyof typeof PRIORITY]) {
  return { holder: name, priority, onSuspend: sinon.stub(), onResume: sinon.stub() };
}

test('a reflex preempts a task, which resumes when the reflex releases', async (t) => {
  const { arbiter: a, stopBody } = arbiter();
  const task = holder('task t1 follow', PRIORITY.TASK);
  const taskLease = a.acquireOrQueue(task);
  t.true(taskLease.isActive());

  const reflex = await a.acquire(holder('reflex creeper-evade', PRIORITY.CRITICAL_REFLEX));
  t.true(reflex.ok);
  t.false(taskLease.isActive());
  t.is(taskLease.state, 'suspended');
  t.true(task.onSuspend.calledOnceWith(sinon.match({ holder: 'reflex creeper-evade', kind: 'reflex' }), false));
  t.true(stopBody.calledOnce);
  t.deepEqual(a.holder(), { holder: 'reflex creeper-evade', priority: PRIORITY.CRITICAL_REFLEX });

  if (reflex.ok) reflex.lease.release();
  t.true(task.onResume.calledOnce);
  t.true(taskLease.isActive());
  t.deepEqual(a.holder(), { holder: 'task t1 follow', priority: PRIORITY.TASK });
});

test('a manual command takes over immediately, reports what it preempted and does not resume it', async (t) => {
  const { arbiter: a } = arbiter();
  const task = holder('task t1 follow', PRIORITY.TASK);
  const taskLease = a.acquireOrQueue(task);

  const manual = await a.acquire(holder('manual move-to-position', PRIORITY.MANUAL));

  t.true(manual.ok);
  if (!manual.ok) return;
  t.deepEqual(manual.preempted, [{ holder: 'task t1 follow', priority: PRIORITY.TASK }]);
  t.is(taskLease.state, 'revoked');
  t.true(task.onSuspend.calledOnceWith(sinon.match({ kind: 'manual' }), true));

  manual.lease.release();
  t.false(task.onResume.called);
  t.is(a.holder(), null);
});

test('a manual command preempts a routine reflex and everything the reflex had paused', async (t) => {
  const { arbiter: a } = arbiter();
  const task = holder('task t1 follow', PRIORITY.TASK);
  const taskLease = a.acquireOrQueue(task);
  const eat = await a.acquire(holder('reflex auto-eat', PRIORITY.ROUTINE_REFLEX));
  t.true(eat.ok);

  const manual = await a.acquire(holder('manual look-at', PRIORITY.MANUAL));

  t.true(manual.ok);
  if (!manual.ok || !eat.ok) return;
  t.deepEqual(manual.preempted.map(info => info.holder), ['reflex auto-eat', 'task t1 follow']);
  t.is(eat.lease.state, 'revoked');
  t.is(taskLease.state, 'revoked');
});

test.serial('a manual command waits for a critical reflex and says who it waited for', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());
  const { arbiter: a } = arbiter();
  const reflex = await a.acquire(holder('reflex creeper-evade', PRIORITY.CRITICAL_REFLEX));

  const pending = a.acquire(holder('manual move-to-position', PRIORITY.MANUAL));
  await clock.tickAsync(1500);
  if (reflex.ok) reflex.lease.release();
  const manual = await pending;

  t.true(manual.ok);
  if (!manual.ok) return;
  t.is(manual.waitedMs, 1500);
  t.deepEqual(manual.waitedFor, { holder: 'reflex creeper-evade', priority: PRIORITY.CRITICAL_REFLEX });
});

test.serial('a manual command gives up after 10 seconds behind a critical reflex', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());
  const { arbiter: a } = arbiter();
  await a.acquire(holder('reflex hazard-escape', PRIORITY.CRITICAL_REFLEX));

  const pending = a.acquire(holder('manual jump', PRIORITY.MANUAL));
  await clock.tickAsync(10000);
  const result = await pending;

  t.false(result.ok);
  if (result.ok) return;
  t.is(result.busy.holder, 'reflex hazard-escape');
  t.is(result.waitedMs, 10000);
});

test('equal and lower priorities never preempt', async (t) => {
  const { arbiter: a } = arbiter();
  await a.acquire(holder('reflex creeper-evade', PRIORITY.CRITICAL_REFLEX));

  const routine = await a.acquire(holder('reflex auto-eat', PRIORITY.ROUTINE_REFLEX));
  const otherCritical = await a.acquire(holder('reflex hazard-escape', PRIORITY.CRITICAL_REFLEX));

  t.false(routine.ok);
  t.false(otherCritical.ok);
  t.is(a.holder()?.holder, 'reflex creeper-evade');
});

test('a task queued behind a holder starts when the holder releases', async (t) => {
  const { arbiter: a } = arbiter();
  const manual = await a.acquire(holder('manual dig-block', PRIORITY.MANUAL));
  const task = holder('task t2 flee', PRIORITY.TASK);

  const lease = a.acquireOrQueue(task);
  t.is(lease.state, 'suspended');

  if (manual.ok) manual.lease.release();
  t.true(lease.isActive());
  t.true(task.onResume.calledOnce);
});

test('releasing is idempotent and releasing a suspended lease removes it from the queue', async (t) => {
  const { arbiter: a } = arbiter();
  const task = holder('task t1 follow', PRIORITY.TASK);
  const taskLease = a.acquireOrQueue(task);
  const reflex = await a.acquire(holder('reflex creeper-evade', PRIORITY.CRITICAL_REFLEX));

  taskLease.release();
  taskLease.release();
  if (reflex.ok) {
    reflex.lease.release();
    reflex.lease.release();
  }

  t.false(task.onResume.called);
  t.is(a.holder(), null);
});

test('a throwing suspend callback does not stop the preemption', async (t) => {
  const log = sinon.stub();
  const a = new ActionArbiter({ stopBody: sinon.stub(), log });
  a.acquireOrQueue({ holder: 'task t1 follow', priority: PRIORITY.TASK, onSuspend: () => { throw new Error('boom'); } });

  const manual = await a.acquire({ holder: 'manual jump', priority: PRIORITY.MANUAL });

  t.true(manual.ok);
  t.is(a.holder()?.holder, 'manual jump');
  t.true(log.calledWithMatch('warn', /boom/));
});
