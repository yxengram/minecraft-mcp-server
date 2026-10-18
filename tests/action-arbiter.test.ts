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

  const reflex = await a.acquire(holder('reflex creeper-evade', PRIORITY.URGENT_INSTINCT));
  t.true(reflex.ok);
  t.false(taskLease.isActive());
  t.is(taskLease.state, 'suspended');
  t.true(task.onSuspend.calledOnceWith(sinon.match({ holder: 'reflex creeper-evade', kind: 'instinct' }), false));
  t.true(stopBody.calledOnce);
  t.deepEqual(a.holder(), { holder: 'reflex creeper-evade', priority: PRIORITY.URGENT_INSTINCT });

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
  const eat = await a.acquire(holder('reflex auto-eat', PRIORITY.INSTINCT));
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
  const reflex = await a.acquire(holder('reflex creeper-evade', PRIORITY.URGENT_INSTINCT));

  const pending = a.acquire(holder('manual move-to-position', PRIORITY.MANUAL));
  await clock.tickAsync(1500);
  if (reflex.ok) reflex.lease.release();
  const manual = await pending;

  t.true(manual.ok);
  if (!manual.ok) return;
  t.is(manual.waitedMs, 1500);
  t.deepEqual(manual.waitedFor, { holder: 'reflex creeper-evade', priority: PRIORITY.URGENT_INSTINCT });
});

test.serial('a manual command gives up after 10 seconds behind a critical reflex', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());
  const { arbiter: a } = arbiter();
  await a.acquire(holder('reflex low-health-retreat', PRIORITY.URGENT_INSTINCT));

  const pending = a.acquire(holder('manual jump', PRIORITY.MANUAL));
  await clock.tickAsync(10000);
  const result = await pending;

  t.false(result.ok);
  if (result.ok) return;
  t.is(result.busy.holder, 'reflex low-health-retreat');
  t.is(result.waitedMs, 10000);
});

test('equal and lower priorities never preempt', async (t) => {
  const { arbiter: a } = arbiter();
  await a.acquire(holder('reflex creeper-evade', PRIORITY.URGENT_INSTINCT));

  const routine = await a.acquire(holder('reflex auto-eat', PRIORITY.INSTINCT));
  const otherCritical = await a.acquire(holder('reflex low-health-retreat', PRIORITY.URGENT_INSTINCT));

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
  const reflex = await a.acquire(holder('reflex creeper-evade', PRIORITY.URGENT_INSTINCT));

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

// ---- acquireNow: reflexes on the game tick (F-002 with G1, G4; M3) ---------------------------------------------

test('a reflex handing its own lease to another reflex stops the body once and resumes nothing in between', (t) => {
  const { arbiter: a, stopBody } = arbiter();
  const task = holder('task t1 follow', PRIORITY.TASK);
  const taskLease = a.acquireOrQueue(task);
  const retreat = holder('reflex low-health-retreat', PRIORITY.URGENT_INSTINCT);
  const retreatLease = a.acquireNow(retreat);
  t.truthy(retreatLease);
  t.is(taskLease.state, 'suspended');
  stopBody.resetHistory();

  const evade = holder('reflex creeper-evade', PRIORITY.URGENT_INSTINCT);
  const evadeLease = a.acquireNow(evade, retreatLease!);

  t.truthy(evadeLease, 'handing over its own lease works at equal priority');
  t.true(evadeLease!.isActive());
  t.deepEqual(a.holder(), { holder: 'reflex creeper-evade', priority: PRIORITY.URGENT_INSTINCT });
  t.false(retreatLease!.isActive());
  t.is(retreatLease!.state, 'released');
  t.is(stopBody.callCount, 1, 'a handover is a preemption: the old holder\'s goal and controls are cleared once (G4)');
  t.is(taskLease.state, 'suspended');
  t.false(task.onResume.called, 'the paused task must not get the body between the two reflexes');

  // The engine releases the old lease right after the handover; that must not disturb the new holder.
  retreatLease!.release();
  t.true(evadeLease!.isActive());
  t.is(a.holder()?.holder, 'reflex creeper-evade');
  t.false(task.onResume.called);
  t.is(stopBody.callCount, 1);

  // The task paused under the first reflex still resumes once the last reflex lets go.
  evadeLease!.release();
  t.true(task.onResume.calledOnce);
  t.true(taskLease.isActive());
  t.deepEqual(a.holder(), { holder: 'task t1 follow', priority: PRIORITY.TASK });
});

test('a critical reflex taking over from a routine one by handover keeps the task paused and stops the body once', (t) => {
  const { arbiter: a, stopBody } = arbiter();
  const task = holder('task t1 guard', PRIORITY.TASK);
  const taskLease = a.acquireOrQueue(task);
  const eat = holder('reflex auto-eat', PRIORITY.INSTINCT);
  const eatLease = a.acquireNow(eat);
  t.truthy(eatLease);
  t.true(task.onSuspend.calledOnceWith(sinon.match({ holder: 'reflex auto-eat', kind: 'instinct' }), false));
  stopBody.resetHistory();

  const evadeLease = a.acquireNow(holder('reflex creeper-evade', PRIORITY.URGENT_INSTINCT), eatLease!);

  t.true(evadeLease?.isActive());
  t.is(a.holder()?.holder, 'reflex creeper-evade');
  t.false(eatLease!.isActive());
  t.true(stopBody.calledOnce);
  t.is(taskLease.state, 'suspended');
  t.true(task.onSuspend.calledOnce, 'the task was already paused; it is not paused a second time');
  t.false(task.onResume.called);

  evadeLease!.release();
  t.true(task.onResume.calledOnce);
  t.true(taskLease.isActive());
});

test('acquireNow returns null without touching the body when an equal or higher priority holds it', async (t) => {
  const { arbiter: a, stopBody } = arbiter();
  const hazard = holder('reflex low-health-retreat', PRIORITY.URGENT_INSTINCT);
  const hazardLease = a.acquireNow(hazard);
  t.truthy(hazardLease);
  stopBody.resetHistory();

  const eat = holder('reflex auto-eat', PRIORITY.INSTINCT);
  const evade = holder('reflex creeper-evade', PRIORITY.URGENT_INSTINCT);
  t.is(a.acquireNow(eat), null, 'a routine reflex cannot take the body from a critical one');
  t.is(a.acquireNow(evade), null, 'equal priority never preempts without handing over its own lease (G1)');

  t.false(stopBody.called);
  t.true(hazardLease!.isActive());
  t.false(hazard.onSuspend.called);
  t.deepEqual(a.holder(), { holder: 'reflex low-health-retreat', priority: PRIORITY.URGENT_INSTINCT });
  hazardLease!.release();
  t.is(a.holder(), null, 'a refused acquireNow leaves nothing queued behind');

  // A manual command holds the body: a routine reflex cannot interrupt it (G1).
  const manual = await a.acquire(holder('manual move-to-position', PRIORITY.MANUAL));
  t.true(manual.ok);
  stopBody.resetHistory();
  t.is(a.acquireNow(holder('reflex self-defense', PRIORITY.INSTINCT)), null);
  t.false(stopBody.called);
  if (manual.ok) t.true(manual.lease.isActive());
  t.is(a.holder()?.holder, 'manual move-to-position');
});

test('handing over a lease that no longer holds the body does not release the current holder', (t) => {
  const { arbiter: a, stopBody } = arbiter();
  const eatLease = a.acquireNow(holder('reflex auto-eat', PRIORITY.INSTINCT));
  t.truthy(eatLease);
  const hazardLease = a.acquireNow(holder('reflex low-health-retreat', PRIORITY.URGENT_INSTINCT));
  t.truthy(hazardLease);
  t.is(eatLease!.state, 'suspended');
  stopBody.resetHistory();

  // auto-eat's lease is suspended, not current: passing it as `replacing` must not count as a handover.
  t.is(a.acquireNow(holder('reflex self-defense', PRIORITY.INSTINCT), eatLease!), null);
  t.true(hazardLease!.isActive());
  t.is(a.holder()?.holder, 'reflex low-health-retreat');
  t.false(stopBody.called);

  // Nor does a lease that was already released.
  eatLease!.release();
  t.is(a.acquireNow(holder('reflex creeper-evade', PRIORITY.URGENT_INSTINCT), eatLease!), null);
  t.true(hazardLease!.isActive());
  t.false(stopBody.called);
});

test.serial('a manual command waiting behind a critical reflex keeps waiting through a critical-to-critical handover', async (t) => {
  const clock = sinon.useFakeTimers({ now: 1.7e12 });
  t.teardown(() => clock.restore());
  const { arbiter: a } = arbiter();
  const retreatLease = a.acquireNow(holder('reflex low-health-retreat', PRIORITY.URGENT_INSTINCT));
  t.truthy(retreatLease);

  const pending = a.acquire(holder('manual move-to-position', PRIORITY.MANUAL));
  let settled = false;
  void pending.then(() => { settled = true; });
  await clock.tickAsync(500);

  const evadeLease = a.acquireNow(holder('reflex creeper-evade', PRIORITY.URGENT_INSTINCT), retreatLease!);
  retreatLease!.release();
  await clock.tickAsync(500);

  t.true(evadeLease?.isActive(), 'the manual command must not slip in between two critical reflexes (G1)');
  t.is(a.holder()?.holder, 'reflex creeper-evade');
  t.false(settled);

  evadeLease!.release();
  const manual = await pending;
  t.true(manual.ok);
  if (!manual.ok) return;
  t.true(manual.lease.isActive());
  t.is(manual.waitedMs, 1000);
  t.is(a.holder()?.holder, 'manual move-to-position');
});
