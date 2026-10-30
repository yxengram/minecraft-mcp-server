import test, { ExecutionContext } from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { Autopilot, AutopilotNotReady } from '../src/autopilot/autopilot.js';
import { PRIORITY } from '../src/autopilot/action-arbiter.js';
import { EventStore } from '../src/event-store.js';
import { DECISIONS_URL } from '../src/decisions/openrouter-client.js';
import { DEFAULT_DECISION_MODEL } from '../src/autopilot/policy.js';

// F-001: the M1 scope (arbiter, tasks, bind / unbind), plus the instinct wiring (M8, E-011) and, since M9 (E-012),
// what the deleted reflex engine used to do here: the death and respawn handling now lives in the instinct engine.

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
    [{ holder: 'task t1 follow', priority: PRIORITY.TASK }, { holder: 'instinct eat', priority: PRIORITY.INSTINCT }],
    { holder: 'instinct run_from_creeper', ms: 2400 }
  );

  t.truthy(report);
  const lines = report!.split('\n');
  t.is(lines[0], 'Waited 2.4s for instinct run_from_creeper to finish before running this command.');
  t.regex(lines[1], /^Interrupted before this command: task t1 follow \(target Steve, range 3; running for 0s; step: following Steve \(id 5\) \(distance 4\.0\)\)\. It is paused: call resume-task t1 to continue or cancel-task t1 to drop it\.$/);
  t.is(lines[2], 'Interrupted before this command: instinct eat.');
  t.is(autopilot.describeInterruption([]), null);
});

// ---- the instinct engine on the bot (F-001, F-040; G2, G4) ----------------------------------------------------------

/** mockBot() as an EventEmitter, with the blocks, controls and looking the instinct and its macros read. */
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

// Listeners per event once bound: since M9 only the instinct engine follows the bot (physicsTick, death, spawn).
const ENGINE_EVENTS: Record<string, number> = { physicsTick: 1, death: 1, spawn: 1 };

test('the instinct follows physicsTick only while bound; rebinding and unbinding leave no listeners behind', (t) => {
  const autopilot = new Autopilot({ events: new EventStore() });
  const first = eventBot();
  autopilot.bind(first.bot as never);

  for (const [name, count] of Object.entries(ENGINE_EVENTS)) t.is(first.bot.listenerCount(name), count, `${count} ${name} listener(s) after bind`);
  autopilot.bind(first.bot as never);
  for (const [name, count] of Object.entries(ENGINE_EVENTS)) t.is(first.bot.listenerCount(name), count, `a repeated bind adds no further ${name} listener`);

  const firstEngine = autopilot.instinct;
  first.bot.emit('physicsTick');
  t.is(firstEngine.status().timing.ticks, 1, 'each physicsTick reaches the instinct');

  const second = eventBot();
  autopilot.bind(second.bot as never);
  t.deepEqual(first.bot.eventNames(), [], 'rebinding leaves no listener on the old bot');
  for (const [name, count] of Object.entries(ENGINE_EVENTS)) t.is(second.bot.listenerCount(name), count);
  const secondEngine = autopilot.instinct;
  t.not(secondEngine, firstEngine);
  second.bot.emit('physicsTick');
  t.is(secondEngine.status().timing.ticks, 1);

  autopilot.unbind('disconnected');
  for (const name of Object.keys(ENGINE_EVENTS)) t.is(second.bot.listenerCount(name), 0, `unbind removes the ${name} listeners`);
  t.deepEqual(second.bot.eventNames(), []);
  first.bot.emit('physicsTick');
  second.bot.emit('physicsTick');
  t.is(firstEngine.status().timing.ticks, 1, 'an unbound engine no longer evaluates anything');
  t.is(secondEngine.status().timing.ticks, 1);
  t.throws(() => autopilot.instinct, { instanceOf: AutopilotNotReady });
});

/**
 * A fetch that answers the decisions API the way the model would: `choice` for the action when the menu offers it
 * (otherwise none), and 0.9 for every yes/no question (urgent, resume_task). Nothing reaches the network.
 */
function instinctFetch(choice: string) {
  return sinon.spy(async (url: string, init: { body?: string }) => {
    // Anything but a decision request (e.g. the catalog) gets an empty catalog.
    if (url !== DECISIONS_URL) return { ok: true, status: 200, text: async () => JSON.stringify({ data: [] }) };
    const body = JSON.parse(init.body ?? '{}') as { questions: Record<string, { type: string; criteria: Record<string, string> }> };
    const answers: Record<string, unknown> = {};
    for (const [name, question] of Object.entries(body.questions)) {
      if (question.type === 'choice') {
        const pick = Object.hasOwn(question.criteria, choice) ? choice : 'none';
        answers[name] = { type: 'choice', choice: pick, confidence: 0.9, probabilities: pick === 'none' ? { none: 0.9 } : { [pick]: 0.9, none: 0.1 } };
      } else {
        answers[name] = { type: 'noul', noul: 0.9 };
      }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ model: 'test/decider-1', answers }) };
  });
}

/** The decision requests among a fake fetch's calls (other requests, such as the model catalog, do not count). */
function decisionCalls(fetch: sinon.SinonSpy) {
  return fetch.getCalls().filter(call => call.args[0] === DECISIONS_URL);
}

/**
 * A bound Autopilot whose decision model says "flee", with a follow task running, under fake timers. `endanger()` puts
 * the bot at health 4 with a zombie 6 blocks away (low_health); the fake bot never gets farther from it, so the flee
 * keeps running (and holding the body) until something stops it.
 */
async function fleeingAutopilot(t: ExecutionContext) {
  const clock = sinon.useFakeTimers({ now: 1.7e12 });
  t.teardown(() => clock.restore());
  const events = new EventStore();
  const fetch = instinctFetch('flee');
  const autopilot = new Autopilot({ events, decisions: { getKey: () => 'test-key', fetch } });
  const world = eventBot();
  autopilot.bind(world.bot as never);
  t.teardown(() => autopilot.unbind('test finished'));
  const tick = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 50) {
      world.bot.emit('physicsTick');
      await clock.tickAsync(50);
    }
  };
  const started = await autopilot.tasks.start('follow', { target: 'Steve' });
  t.true(started.ok);
  await clock.tickAsync(300);
  t.is(autopilot.currentTask()?.status, 'running');
  const endanger = () => {
    const zombie = { id: 9, name: 'zombie', type: 'hostile', position: new Vec3(6, 64, 0), isValid: true, height: 1.95, width: 0.6 };
    (world.bot.entities as Record<number, unknown>)[zombie.id] = zombie;
    world.bot.health = 4;
  };
  const log = () => events.query({ limit: 500 }).events;
  const taskEvents = () => log().filter(event => event.type.startsWith('task_')).map(event => `${event.type} ${event.message}`);
  const instinctEvents = () => log().filter(event => event.type === 'instinct').map(event => event.message);
  return { clock, events, fetch, autopilot, world, tick, endanger, log, taskEvents, instinctEvents };
}

test.serial('unbinding while an instinct action has the task paused cancels the task without resuming it first', async (t) => {
  const { clock, autopilot, world, tick, endanger, log, instinctEvents, fetch } = await fleeingAutopilot(t);
  endanger();
  await tick(300);

  // Preconditions: the instinct's flee holds the body and the task is paused under it.
  t.true(decisionCalls(fetch).length > 0, 'the decision model was asked');
  t.is(autopilot.instinct.status().running?.action, 'flee');
  t.regex(autopilot.arbiter.holder()?.holder ?? '', /^instinct flee$/);
  t.is(autopilot.currentTask()?.status, 'paused');

  autopilot.unbind('disconnected');
  await clock.tickAsync(100);

  const events = log();
  const paused = events.findIndex(event => event.type === 'task_paused');
  const cancelled = events.findIndex(event => event.type === 'task_cancelled');
  t.true(paused >= 0, 'the task was paused by the instinct');
  t.true(cancelled > paused, 'the task was cancelled after the pause');
  t.is(events[cancelled]?.message, 't1 follow: cancelled (disconnected)');
  t.deepEqual(
    events.slice(paused + 1).filter(event => event.type === 'task_resumed').map(event => event.message),
    [],
    'stopping the instinct action must not hand the body back to the task before it is cancelled'
  );
  t.deepEqual(events.filter(event => event.type.startsWith('task_')).map(event => event.type), ['task_started', 'task_paused', 'task_cancelled']);
  t.regex(instinctEvents().at(-1) ?? '', /^flee → interrupted: disconnected \(\d+\.\ds\)$/);
  t.false(autopilot.isReady());
  t.is(autopilot.currentTask(), null);
  t.deepEqual(world.bot.eventNames(), []);
});

// Moved from the reflex engine's timeout test: an instinct action has a longest duration (flee: 10 s, F-039).
test.serial('an instinct action that runs past its longest duration (flee, 10 s) ends as timed out and gives the body back to the task', async (t) => {
  const { autopilot, tick, endanger, taskEvents, instinctEvents } = await fleeingAutopilot(t);
  endanger();
  await tick(300);
  t.is(autopilot.instinct.status().running?.action, 'flee');
  const timedOut = () => instinctEvents().filter(message => message.startsWith('flee → timeout'));

  await tick(9000);
  t.is(autopilot.instinct.status().running?.action, 'flee', 'still running before 10 s (re-asks keep the same action)');
  t.deepEqual(timedOut(), []);
  t.false(taskEvents().some(event => event.startsWith('task_resumed')));

  await tick(1500);
  t.is(timedOut().length, 1, JSON.stringify(instinctEvents()));
  t.regex(timedOut()[0], /^flee → timeout: .*10.*\(10\.\ds\)$/);
  t.true(taskEvents().some(event => event.startsWith('task_resumed')), 'the lease was released and the task got the body back');
});

// ---- M7 / M9: death ends the task (F-001, F-040 onDeath) -------------------------------------------------------------
// Expected from the contract: the instinct engine calls onDeath first, while a running action may still hold the body,
// and autopilot.ts cancels the task there ("the bot died"); only then is the action interrupted. A task the action had
// paused is therefore cancelled instead of being resumed after the bot died.

test.serial('death while an instinct action has the task paused → the task is cancelled (the bot died) and never resumes, not even after the respawn', async (t) => {
  const { autopilot, world, tick, endanger, taskEvents, instinctEvents } = await fleeingAutopilot(t);
  endanger();
  await tick(300);
  t.is(autopilot.instinct.status().running?.action, 'flee');
  t.is(autopilot.currentTask()?.status, 'paused');

  world.bot.health = 0;
  world.bot.emit('death');
  await tick(100);

  t.deepEqual(taskEvents().map(event => event.split(' ')[0]), ['task_started', 'task_paused', 'task_cancelled'], 'cancelled at once, with no task_resumed in between');
  t.is(taskEvents().at(-1), 'task_cancelled t1 follow: cancelled (the bot died)');
  t.is(autopilot.arbiter.holder(), null);
  t.is(autopilot.instinct.status().running, null);
  t.true(instinctEvents().some(message => /^flee → interrupted: the bot died \(\d+\.\ds\)$/.test(message)), JSON.stringify(instinctEvents()));

  // Respawn: nothing comes back.
  await tick(1500);
  world.bot.health = 20;
  world.bot.emit('spawn');
  await tick(500);
  t.deepEqual(taskEvents().map(event => event.split(' ')[0]), ['task_started', 'task_paused', 'task_cancelled'], 'no task_resumed after the respawn');
  t.is(autopilot.currentTask(), null);
  t.is(autopilot.arbiter.holder(), null);
});

test.serial('death with no instinct action running cancels the running task (the bot died)', async (t) => {
  const { autopilot, world, taskEvents, fetch } = await fleeingAutopilot(t);

  world.bot.health = 0;
  world.bot.emit('death');

  t.deepEqual(decisionCalls(fetch), [], 'there was nothing to decide');
  t.is(autopilot.currentTask(), null);
  t.deepEqual(taskEvents().map(event => event.split(' ')[0]), ['task_started', 'task_cancelled']);
  t.is(taskEvents().at(-1), 'task_cancelled t1 follow: cancelled (the bot died)');
  t.is(autopilot.arbiter.holder(), null);
});

// ---- respawn cleanup (F-040, moved from the reflex engine in M9) ---------------------------------------------------

test.serial('after a death, the next spawn clears the stale burning flag and refills the air; other spawns, and a stopped engine, leave the metadata alone', async (t) => {
  const clock = sinon.useFakeTimers({ now: 1.7e12 });
  t.teardown(() => clock.restore());
  const ON_FIRE = 0x01;
  const INVISIBLE = 0x20;
  const autopilot = new Autopilot({ events: new EventStore(), decisions: { getKey: () => undefined, fetch: sinon.stub().rejects(new Error('no network in tests')) } });
  const world = eventBot();
  // Burning with little air: values the server would not resend after a respawn, and that the instinct reads.
  world.self.metadata.push(ON_FIRE | INVISIBLE, 30);
  autopilot.bind(world.bot as never);

  world.bot.emit('spawn');
  t.deepEqual(world.self.metadata, [ON_FIRE | INVISIBLE, 30], 'a spawn without a death changes nothing');

  world.bot.health = 0;
  world.bot.emit('death');
  t.deepEqual(world.self.metadata, [ON_FIRE | INVISIBLE, 30], 'the death itself leaves the metadata alone');
  await clock.tickAsync(1100);
  world.bot.health = 20;
  world.bot.emit('spawn');

  t.is(world.self.metadata[0], INVISIBLE, 'the burning bit is cleared; the other flags stay');
  t.is(world.self.metadata[1], 300, 'full air');

  // A later spawn (a dimension change) without a new death leaves fresh values alone.
  world.self.metadata[0] = ON_FIRE;
  world.self.metadata[1] = 45;
  world.bot.emit('spawn');
  t.deepEqual(world.self.metadata, [ON_FIRE, 45]);

  // A stopped engine no longer touches the metadata, even after another death.
  autopilot.unbind('disconnected');
  world.bot.emit('death');
  world.bot.emit('spawn');
  t.deepEqual(world.self.metadata, [ON_FIRE, 45]);
});

// ---- M8: the instinct without a decision model (F-001, F-040, E-011) ------------------------------------------------
// Expected from the contract: fire, lava and water are no longer handled by a reflex; without a key the instinct does
// not move the body and reports "instinct offline (<reason>)" once per danger episode and reason.

test.serial('M8: with no decision key, low air under water takes the body from nobody; one "instinct offline" event per danger', async (t) => {
  const clock = sinon.useFakeTimers({ now: 1.7e12 });
  t.teardown(() => clock.restore());
  const events = new EventStore();
  const fetch = sinon.stub().rejects(new Error('no network in tests'));
  const autopilot = new Autopilot({ events, decisions: { getKey: () => undefined, fetch } });
  const world = eventBot();
  autopilot.bind(world.bot as never);
  t.teardown(() => autopilot.unbind('test finished'));
  const tick = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 50) {
      world.bot.emit('physicsTick');
      await clock.tickAsync(50);
    }
  };

  const started = await autopilot.tasks.start('follow', { target: 'Steve' });
  t.true(started.ok);
  await clock.tickAsync(300);
  t.is(autopilot.currentTask()?.status, 'running');
  const offline = () => events.query({ types: ['instinct'], limit: 200 }).events.map(event => event.message)
    .filter(message => message.includes('instinct offline'));

  // Head under open water with 4 bubbles left (60 ticks, below the default lowAir of 6), for about 4 s: well past
  // several re-ask intervals (1.5 s), and the fake air supply never refills.
  world.self.metadata[1] = 60;
  world.water.add('0,65,0');
  await tick(4000);

  t.is(autopilot.arbiter.holder()?.holder, 'task t1 follow', 'the instinct did not take the body');
  t.is(autopilot.currentTask()?.status, 'running');
  t.is(autopilot.instinct.status().running, null);
  t.is(offline().length, 1, `one offline event for the whole danger: ${JSON.stringify(offline())}`);
  t.regex(offline()[0] ?? '', /disabled/, 'it names why there is no decision');
  t.regex(offline()[0] ?? '', /4 air left/, 'and what the bot senses');
  t.true(fetch.notCalled, 'no request leaves the client without a key');
  const log = events.query({ limit: 200 }).events;
  t.deepEqual(log.filter(event => event.type.startsWith('task_')).map(event => event.type), ['task_started'], 'the task was never paused');

  // The bot surfaces (the episode ends), then goes under again: a new episode is reported once more.
  world.water.delete('0,65,0');
  await tick(200);
  world.water.add('0,65,0');
  await tick(2000);
  t.is(offline().length, 2, 'a new danger episode is reported again, once');

  autopilot.unbind('disconnected');
  await clock.tickAsync(100);
  const after = events.query({ limit: 200 }).events;
  t.is(after.filter(event => event.type === 'task_cancelled').at(-1)?.message, 't1 follow: cancelled (disconnected)');
  t.deepEqual(after.filter(event => event.type === 'task_resumed'), []);
  t.deepEqual(world.bot.eventNames(), [], 'the instinct left no listener behind');
  t.throws(() => autopilot.instinct, { instanceOf: AutopilotNotReady });
});

// ---- E-036: the key check at startup and on every join, and how a change is reported (F-001, F-015) ----------------
// Expected from the E-036 row: main.ts calls checkDecisionModel() once at startup and bind() calls it again, in place
// of warmUp; it asks OpenRouter only with a key and decisions.enabled, and never holds up bind or the ticks (I6). Each
// change of the health is one instinct event and one log line, OFFLINE as a warning in the row's words:
// "Decision model OFFLINE: OpenRouter rejected the API key (HTTP 401). The bot will not react to dangers by itself" and
// "decision model offline: OpenRouter rejected the API key (HTTP 401); dangers are left to you". The key is in neither (I4).

const KEY_CHECK_URL = 'https://openrouter.ai/api/v1/key';
const TEST_KEY = 'sk-or-v1-FAKE-autopilot-key-check-0000';

/** A fetch that answers by URL: the key check with `keyStatus` (a refusal echoes the key), the catalog with the default model. */
function keyCheckFetch(state: { keyStatus: number }) {
  return sinon.spy(async (url: string) => {
    if (url === KEY_CHECK_URL) {
      const ok = state.keyStatus < 300;
      return { ok, status: state.keyStatus, text: async () => (ok ? JSON.stringify({ data: { label: 'x' } }) : `{"error":{"message":"User not found: ${TEST_KEY}"}}`) };
    }
    if (url !== DECISIONS_URL) return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: DEFAULT_DECISION_MODEL }] }) };
    throw new Error('no decision requests in this test');
  });
}

function healthReports(events: EventStore, logged: sinon.SinonSpy) {
  return {
    events: () => events.query({ types: ['instinct'], limit: 100 }).events.map(event => event.message).filter(message => message.startsWith('decision model ')),
    logs: () => logged.getCalls().map(call => call.args as [string, string]).filter(([, message]) => message.startsWith('Decision model '))
  };
}

test.serial('E-036: a key check that has not answered holds up neither bind nor the ticks (I6)', async (t) => {
  const clock = sinon.useFakeTimers({ now: 1.7e12 });
  t.teardown(() => clock.restore());
  const fetch = sinon.spy(() => new Promise<never>(() => undefined));
  const autopilot = new Autopilot({ events: new EventStore(), decisions: { getKey: () => TEST_KEY, fetch } });
  const world = eventBot();

  autopilot.bind(world.bot as never);
  t.teardown(() => autopilot.unbind('test finished'));

  t.true(autopilot.isReady(), 'bound at once');
  t.deepEqual(fetch.getCalls().map(call => (call.args as unknown[])[0]), [KEY_CHECK_URL], 'the check was sent by bind');
  world.bot.emit('physicsTick');
  world.bot.emit('physicsTick');
  t.is(autopilot.instinct.status().timing.ticks, 2, 'the instinct runs while the check waits');
  t.is(autopilot.decisions.health().state, 'unchecked');

  // The check that never answers still ends, on its own timer.
  await clock.tickAsync(5000);
  t.is(autopilot.decisions.health().state, 'unchecked');
  t.regex(autopilot.decisions.health().reason ?? '', /no answer/);
});

test('E-036: with decisions turned off in the policy the check sends nothing', async (t) => {
  const fetch = keyCheckFetch({ keyStatus: 200 });
  const log = sinon.spy();
  const events = new EventStore();
  const autopilot = new Autopilot({ events, log, decisions: { getKey: () => TEST_KEY, fetch } });
  t.true(autopilot.policy.update({ decisions: { enabled: false } }, 'llm').ok);

  await autopilot.checkDecisionModel();

  t.true(fetch.notCalled);
  const reports = healthReports(events, log);
  t.deepEqual(reports.events(), []);
  t.deepEqual(reports.logs(), []);
});

test('E-036: each change of the health is one instinct event and one log line, OFFLINE as a warning; the key is in neither', async (t) => {
  const state = { keyStatus: 401 };
  const fetch = keyCheckFetch(state);
  const log = sinon.spy();
  const events = new EventStore();
  const autopilot = new Autopilot({ events, log, decisions: { getKey: () => TEST_KEY, fetch } });
  const reports = healthReports(events, log);

  // At startup (main.ts), before any bot.
  await autopilot.checkDecisionModel();
  t.deepEqual(reports.logs(), [['warn', 'Decision model OFFLINE: OpenRouter rejected the API key (HTTP 401). The bot will not react to dangers by itself']]);
  t.deepEqual(reports.events(), ['decision model offline: OpenRouter rejected the API key (HTTP 401); dangers are left to you']);

  // The join checks again; the same result is no change.
  autopilot.bind(eventBot().bot as never);
  t.teardown(() => autopilot.unbind('test finished'));
  // Called while the join's check is under way, this waits for that check instead of sending another one.
  await autopilot.checkDecisionModel();
  t.is(fetch.getCalls().filter(call => (call.args as unknown[])[0] === KEY_CHECK_URL).length, 2, 'one at startup and one for the join');
  t.is(reports.logs().length, 1);
  t.is(reports.events().length, 1);

  // A later join with a key that passes: one more line and event, not as a warning.
  state.keyStatus = 200;
  autopilot.bind(eventBot().bot as never);
  await autopilot.checkDecisionModel();
  t.is(autopilot.decisions.health().state, 'online');
  t.is(reports.logs().length, 2);
  t.is(reports.logs()[1][0], 'info');
  t.regex(reports.logs()[1][1], /^Decision model online\b/);
  t.is(reports.events().length, 2);
  t.regex(reports.events()[1], /^decision model online\b/);

  const everything = JSON.stringify([log.getCalls().map(call => call.args), events.query({ limit: 500 }).events]);
  t.false(everything.includes('FAKE-autopilot-key-check'), 'I4: no part of the key in a log line or an event');
  t.false(everything.includes('User not found'), 'nor the body of the refusal');
});

test('E-036: without a key neither the startup check nor a join sends anything; OFFLINE (no OPENROUTER_API_KEY) is reported once', async (t) => {
  const fetch = sinon.spy(async () => { throw new Error('no network in tests'); });
  const log = sinon.spy();
  const events = new EventStore();
  const autopilot = new Autopilot({ events, log, decisions: { getKey: () => undefined, fetch } });
  const reports = healthReports(events, log);

  await autopilot.checkDecisionModel();
  autopilot.bind(eventBot().bot as never);
  autopilot.bind(eventBot().bot as never);
  t.teardown(() => autopilot.unbind('test finished'));
  await autopilot.checkDecisionModel();

  t.true(fetch.notCalled);
  t.deepEqual(reports.logs(), [['warn', 'Decision model OFFLINE: no OPENROUTER_API_KEY. The bot will not react to dangers by itself']]);
  t.deepEqual(reports.events(), ['decision model offline: no OPENROUTER_API_KEY; dangers are left to you']);
});
