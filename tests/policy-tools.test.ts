// Verifies docs/BLUEPRINT.md F-031 against the F-018 contract (src/tools/policy-tools.ts), together with the policy
// parts of F-001 (reset to defaults with a policy event whenever the bot (re)joins; idempotent bind/unbind without
// leftover listeners), F-014 (partial updates, all-or-nothing validation, attackPlayers warning) and invariant I4 (G6).
// The policy text format is tentative (F-018), so the tests only check the facts each line must show. Since M9 (E-012)
// there is no reflexes group and no reflex engine: get-policy reports the instinct's per-tick checks instead.
import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { Autopilot, AutopilotOptions } from '../src/autopilot/autopilot.js';
import { DEFAULT_POLICY } from '../src/autopilot/policy.js';
import { EventStore } from '../src/event-store.js';
import { registerPolicyTools } from '../src/tools/policy-tools.js';
import { DECISIONS_URL } from '../src/decisions/openrouter-client.js';
import { createFactory } from './_helpers.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { BotConnection } from '../src/bot-connection.js';

const VERSION = '1.21.8';
const registry = minecraftData(VERSION);
/** A bot with real events (so the instinct subscribes), standing safely in the open with bread in its inventory. */
function fakeBot({ food = 20, lavaAtFeet = false } = {}) {
  let finishEating: (() => void) | null = null;
  const self = { id: 1, type: 'player', username: 'ClaudeBot', position: new Vec3(0, 64, 0), metadata: [] as unknown[] };
  return Object.assign(new EventEmitter(), {
    version: VERSION,
    registry,
    username: 'ClaudeBot',
    entity: self,
    entities: { 1: self } as Record<number, unknown>,
    players: {},
    health: 20,
    food,
    oxygenLevel: 20,
    heldItem: null as unknown,
    inventory: { items: () => [{ name: 'bread', type: registry.itemsByName.bread.id, count: 3, slot: 36 }] },
    // Air everywhere, or (M8 instinct tests) lava at the bot's feet.
    blockAt: (position: Vec3) => {
      const p = position.floored();
      return { name: lavaAtFeet && p.x === 0 && p.y === 64 && p.z === 0 ? 'lava' : 'air', position };
    },
    look: sinon.stub().resolves(),
    pathfinder: { goal: null as unknown, stop: sinon.stub(), setGoal: sinon.stub(), goto: sinon.stub().resolves() },
    clearControlStates: sinon.stub(),
    setControlState: sinon.stub(),
    lookAt: sinon.stub().resolves(),
    equip: sinon.stub().resolves(),
    // Eating lasts until it is cut short, so a started meal stays visible while it runs.
    consume: sinon.stub().callsFake(() => new Promise<void>(resolve => { finishEating = resolve; })),
    deactivateItem: sinon.stub().callsFake(() => finishEating?.())
  });
}

type FakeBot = ReturnType<typeof fakeBot>;

function setup({ bind = true, decisions, lavaAtFeet = false }: { bind?: boolean; decisions?: AutopilotOptions['decisions']; lavaAtFeet?: boolean } = {}) {
  const events = new EventStore();
  const autopilot = new Autopilot({ events, decisions });
  const bot = fakeBot({ lavaAtFeet });
  if (bind) autopilot.bind(bot as never);
  const { factory, getTool } = createFactory();
  registerPolicyTools(factory, () => autopilot, events);

  const call = async (name: 'get-policy' | 'set-policy' | 'list-decision-models', args: Record<string, unknown> = {}) => {
    const tool = getTool(name);
    if (!tool) throw new Error(`${name} is not registered`);
    const result = await tool.execute(args);
    return { text: result.content.map(part => part.text).join('\n'), isError: result.isError === true };
  };
  const policyEvents = () => events.query({ types: ['policy'], limit: 200 }).events.map(event => event.message);
  return { events, autopilot, bot, call, policyEvents };
}

/** The lines of a tool reply that name `key` (e.g. "retreatHealth"). */
function linesOf(text: string, key: string): string[] {
  return text.split('\n').filter(line => new RegExp(`\\b${key}\\b`).test(line));
}

/** The first line of the policy text that names `key`. */
function lineOf(text: string, key: string): string {
  return linesOf(text, key)[0] ?? `<no line for ${key}>`;
}

/** The instinct part of the policy text: from its "Instinct (" header up to the "Combat:" header. */
function instinctSection(text: string): string {
  const start = text.indexOf('Instinct (');
  if (start < 0) return '';
  const end = text.indexOf('\nCombat:', start);
  return text.slice(start, end < 0 ? undefined : end);
}

const ON = /\b(on|enabled|true)\b/;
const OFF = /\b(off|disabled|false)\b/;

/** How many decision requests a fake fetch got (other requests, such as the model catalog, do not count). */
function decisionRequests(fetch: sinon.SinonStub): number {
  return fetch.getCalls().filter(call => call.args[0] === DECISIONS_URL).length;
}

/** The numbers a line shows, so thresholds can be checked without fixing the wording around them. */
function numbersIn(line: string): number[] {
  return (line.match(/\d+(\.\d+)?/g) ?? []).map(Number);
}

test('both policy tools are registered', (t) => {
  const { factory, getTool } = createFactory();
  const autopilot = new Autopilot({ events: new EventStore() });
  registerPolicyTools(factory, () => autopilot, new EventStore());

  t.truthy(getTool('get-policy'));
  t.truthy(getTool('set-policy'));
});

test('get-policy shows the default policy: the instinct on with its cue thresholds, players never attacked, neutral mobs avoided, no reflexes', async (t) => {
  const { call, autopilot } = setup();

  const { text, isError } = await call('get-policy');

  t.false(isError);
  t.deepEqual(autopilot.policy.get(), DEFAULT_POLICY);
  const instinct = instinctSection(text);
  t.regex(instinct, ON, `the instinct is on by default: ${instinct}`);
  t.notRegex(instinct, OFF);
  const i = DEFAULT_POLICY.instinct;
  for (const value of [i.lowAir, i.lowHealth, i.hostileRadius, i.food]) {
    t.true(numbersIn(instinct).includes(value), `the instinct section shows ${value}: ${instinct}`);
  }
  t.regex(lineOf(text, 'attackPlayers'), /\bfalse\b|\boff\b/);
  t.regex(lineOf(text, 'avoidNeutral'), /\btrue\b|\bon\b/);
  t.true(numbersIn(lineOf(text, 'retreatHealth')).includes(DEFAULT_POLICY.combat.retreatHealth));
  t.notRegex(text, /reflex|selfDefense|autoEat|stance|combatThreshold/i, 'nothing about the removed reflexes or combat judgment');
});

test('set-policy turning the instinct off is shown by get-policy at once and writes a policy event', async (t) => {
  const { call, autopilot, policyEvents } = setup();
  const before = policyEvents().length;

  const set = await call('set-policy', { instinct: { enabled: false } });
  const { text } = await call('get-policy');

  t.false(set.isError);
  t.regex(set.text, /instinct\.enabled/, 'the reply says what changed');
  t.regex(instinctSection(set.text), OFF, `the reply carries the updated summary: ${set.text}`);
  t.regex(instinctSection(text), OFF);
  t.true(numbersIn(instinctSection(text)).includes(DEFAULT_POLICY.instinct.food), 'the food threshold keeps its value');
  t.deepEqual(autopilot.policy.get(), { ...DEFAULT_POLICY, instinct: { ...DEFAULT_POLICY.instinct, enabled: false } });
  const added = policyEvents().slice(before);
  t.true(added.length >= 1, 'a policy event is written');
  t.true(added.some(message => message.includes('instinct.enabled')), `policy events: ${JSON.stringify(added)}`);
});

test('set-policy changes several fields in one call and leaves every other field alone', async (t) => {
  const { call, autopilot } = setup();

  const set = await call('set-policy', {
    instinct: { lowHealth: 8, hostileRadius: 12 },
    combat: { retreatHealth: 9 }
  });

  t.false(set.isError);
  for (const path of ['instinct.lowHealth', 'instinct.hostileRadius', 'combat.retreatHealth']) t.true(set.text.includes(path), `reply names ${path}`);
  t.deepEqual(autopilot.policy.get(), {
    instinct: { ...DEFAULT_POLICY.instinct, lowHealth: 8, hostileRadius: 12 },
    combat: { ...DEFAULT_POLICY.combat, retreatHealth: 9 },
    chat: DEFAULT_POLICY.chat,
    decisions: DEFAULT_POLICY.decisions
  });
  const { text } = await call('get-policy');
  t.true(numbersIn(instinctSection(text)).includes(8), text);
  t.true(numbersIn(instinctSection(text)).includes(12), text);
  t.true(numbersIn(lineOf(text, 'retreatHealth')).includes(9));
});

const rejected: [string, Record<string, unknown>, string][] = [
  ['an unknown field next to a valid change', { instinct: { enabled: false, speed: 2 } }, 'speed'],
  ['the removed reflexes group (M9)', { reflexes: { autoEat: { enabled: false } } }, 'reflexes'],
  ['the removed reflexes group next to a valid instinct change (M9)', { instinct: { food: 10 }, reflexes: { selfDefense: { stance: 'flee' } } }, 'reflexes'],
  ['the removed decisions.combatThreshold (M9)', { decisions: { combatThreshold: 0.5 } }, 'combatThreshold'],
  ['an unknown combat rule next to attackPlayers', { combat: { attackPlayers: true, friendlyFire: true } }, 'friendlyFire'],
  ['an unknown top-level group', { chaos: { level: 3 } }, 'chaos'],
  ['a food threshold above 20', { instinct: { food: 25 } }, 'food'],
  ['a lowHealth above 20', { instinct: { lowHealth: 21 } }, 'lowHealth'],
  ['a hostileRadius below 1', { instinct: { hostileRadius: 0 } }, 'hostileRadius']
];

for (const [title, args, field] of rejected) {
  test(`set-policy with ${title} is an error and changes nothing`, async (t) => {
    const { call, autopilot, policyEvents } = setup();
    const before = autopilot.policy.get();
    const eventsBefore = policyEvents();
    const shownBefore = (await call('get-policy')).text;

    const result = await call('set-policy', args);

    t.true(result.isError);
    t.true(result.text.includes(field), `the error names ${field}: ${result.text}`);
    t.is(autopilot.policy.get(), before);
    t.deepEqual(autopilot.policy.get(), DEFAULT_POLICY);
    t.deepEqual(policyEvents(), eventsBefore, 'no policy event, and in particular no attackPlayers warning');
    t.is((await call('get-policy')).text, shownBefore);
  });
}

test('set-policy with no fields at all is an error', async (t) => {
  const { call, autopilot, policyEvents } = setup();
  const eventsBefore = policyEvents();

  const result = await call('set-policy', {});

  t.true(result.isError);
  t.deepEqual(autopilot.policy.get(), DEFAULT_POLICY);
  t.deepEqual(policyEvents(), eventsBefore);
});

test('turning attackPlayers on writes a warning policy event and the reply carries the warning, each time it is turned on', async (t) => {
  const { call, autopilot, policyEvents } = setup();
  const warnings = () => policyEvents().filter(message => /warning/i.test(message) && message.includes('attackPlayers'));

  const on = await call('set-policy', { combat: { attackPlayers: true } });

  t.false(on.isError);
  t.true(autopilot.policy.get().combat.attackPlayers);
  t.regex(on.text, /warning[^\n]*attackPlayers|attackPlayers[^\n]*warning/i);
  t.is(warnings().length, 1);
  t.regex(lineOf((await call('get-policy')).text, 'attackPlayers'), /\btrue\b|\bon\b/);

  const off = await call('set-policy', { combat: { attackPlayers: false } });
  t.false(off.isError);
  t.notRegex(off.text, /warning/i, 'turning it off is not a warning');
  t.is(warnings().length, 1);

  const again = await call('set-policy', { combat: { attackPlayers: true } });
  t.regex(again.text, /warning[^\n]*attackPlayers|attackPlayers[^\n]*warning/i);
  t.is(warnings().length, 2);
});

test('set-policy with values that are already set reports that nothing changed and writes no event', async (t) => {
  const { call, autopilot, policyEvents } = setup();
  await call('set-policy', { instinct: { food: 10 } });
  const eventsBefore = policyEvents();

  const defaults = await call('set-policy', { instinct: { enabled: true, lowHealth: 6 }, combat: { avoidNeutral: true } });
  const same = await call('set-policy', { instinct: { food: 10 } });

  for (const result of [defaults, same]) {
    t.false(result.isError, result.text);
    t.regex(result.text, /nothing (was )?changed|no change|unchanged/i);
  }
  t.deepEqual(policyEvents(), eventsBefore);
  t.is(autopilot.policy.get().instinct.food, 10);
});

test('the first bind writes a policy event that the policy starts from its defaults', (t) => {
  const { policyEvents, autopilot } = setup();

  t.deepEqual(autopilot.policy.get(), DEFAULT_POLICY);
  t.is(policyEvents().filter(message => message.startsWith('policy reset to defaults')).length, 1);
});

for (const via of ['a disconnect and reconnect', 'a direct rebind'] as const) {
  test(`binding a new bot after ${via} resets a changed policy to its defaults and writes "policy reset to defaults"`, async (t) => {
    const { call, autopilot, policyEvents } = setup();
    await call('set-policy', {
      instinct: { enabled: false, food: 3 },
      combat: { attackPlayers: true, retreatHealth: 3 }
    });
    t.notDeepEqual(autopilot.policy.get(), DEFAULT_POLICY);

    if (via === 'a disconnect and reconnect') autopilot.unbind('disconnected');
    autopilot.bind(fakeBot() as never);
    t.teardown(() => autopilot.unbind('test finished'));

    t.deepEqual(autopilot.policy.get(), DEFAULT_POLICY);
    const { text } = await call('get-policy');
    t.regex(instinctSection(text), ON);
    t.true(numbersIn(instinctSection(text)).includes(DEFAULT_POLICY.instinct.food));
    t.regex(lineOf(text, 'attackPlayers'), /\bfalse\b|\boff\b/);
    const messages = policyEvents();
    t.true(messages.at(-1)!.startsWith('policy reset to defaults'), `last policy event: ${messages.at(-1)}`);
    t.is(messages.filter(message => message.startsWith('policy reset to defaults')).length, 2, 'one per bind');
  });
}

test('binding the same bot again keeps the policy and a single set of tick listeners', async (t) => {
  const { call, autopilot, bot, policyEvents } = setup();
  t.teardown(() => autopilot.unbind('test finished'));
  await call('set-policy', { instinct: { food: 3 } });
  const engine = autopilot.instinct;

  autopilot.bind(bot as never);

  t.is(autopilot.policy.get().instinct.food, 3, 'a repeated ready callback is not a rejoin');
  t.is(policyEvents().filter(message => message.startsWith('policy reset to defaults')).length, 1);
  t.is(autopilot.instinct, engine);
  // Only the instinct follows the bot since M9.
  t.is(bot.listenerCount('physicsTick'), 1);
  t.is(bot.listenerCount('death'), 1);
  t.is(bot.listenerCount('spawn'), 1);
  bot.emit('physicsTick');
  t.is(autopilot.instinct.status().timing.ticks, 1, 'one evaluation per game tick');
});

test('after bind every game tick reaches the instinct, and get-policy reports its checks', async (t) => {
  const { autopilot, bot, call } = setup();
  t.teardown(() => autopilot.unbind('test finished'));

  bot.emit('physicsTick');
  bot.emit('physicsTick');
  bot.emit('physicsTick');

  t.is(autopilot.instinct.status().timing.ticks, 3);
  t.is(autopilot.instinct.status().running, null);
  const { text } = await call('get-policy');
  t.regex(text, /^Instinct checks: 3 ticks, \d+(\.\d+)? ms on average, \d+(\.\d+)? ms at most$/m, `get-policy: ${text}`);
  t.notRegex(text, /Reflex/, 'no reflex lines any more');
});

function listenerTotal(bot: FakeBot): number {
  return bot.eventNames().reduce((sum, name) => sum + bot.listenerCount(name), 0);
}

test('unbind removes every listener the autopilot added to the bot, and later ticks do nothing', (t) => {
  const { autopilot, bot } = setup({ bind: false });
  autopilot.bind(bot as never);
  t.is(bot.listenerCount('physicsTick'), 1, 'the instinct');

  autopilot.unbind('disconnected');

  t.is(bot.listenerCount('physicsTick'), 0);
  t.is(bot.listenerCount('death'), 0);
  t.is(bot.listenerCount('spawn'), 0);
  t.is(listenerTotal(bot), 0);
  t.notThrows(() => bot.emit('physicsTick'));
  t.false(autopilot.isReady());
});

test('binding a new bot leaves no listeners on the old one', (t) => {
  const { autopilot, bot: first } = setup();
  const second = fakeBot();

  autopilot.bind(second as never);
  t.teardown(() => autopilot.unbind('test finished'));

  t.is(listenerTotal(first), 0);
  t.is(second.listenerCount('physicsTick'), 1);
});

test('noteDamage before any bot is bound, or after unbind, does not throw', (t) => {
  const autopilot = new Autopilot({ events: new EventStore() });

  t.notThrows(() => autopilot.noteDamage({ attackerId: 5, type: 'mob_attack', time: Date.now() }));
  t.notThrows(() => autopilot.noteDamage({ type: 'fall', time: Date.now() }));

  autopilot.bind(fakeBot() as never);
  autopilot.unbind('disconnected');
  t.notThrows(() => autopilot.noteDamage({ attackerId: 5, type: 'mob_attack', time: Date.now() }));
});

test('the instinct follows a set-policy change on its next tick', async (t) => {
  const fetch = sinon.stub().rejects(new Error('no network in tests'));
  const { autopilot, bot, call } = setup({ decisions: { getKey: () => 'sk-or-v1-FAKE-policy-tools-next-tick', fetch } });
  t.teardown(() => autopilot.unbind('test finished'));

  await call('set-policy', { instinct: { enabled: false } });
  // Hungry (food 5 below 14) with bread in the bag: a cue the instinct would ask about.
  bot.food = 5;
  bot.emit('physicsTick');

  t.is(decisionRequests(fetch), 0, 'the instinct is off: nobody is asked');
  t.is(autopilot.arbiter.holder(), null);
  t.false(bot.equip.called);

  await call('set-policy', { instinct: { enabled: true } });
  bot.emit('physicsTick');

  t.is(decisionRequests(fetch), 1, 'turned back on, the hungry bot asks the decision model on the next tick');
  t.is(autopilot.arbiter.holder(), null, 'nothing acts without an answer');
});

test.serial('policy tool output and policy events never contain the OpenRouter API key (I4)', async (t) => {
  const key = 'sk-or-v1-policy-tools-test-sentinel-0123456789';
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = key;
  t.teardown(() => {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  });
  // The key still comes from the environment; since E-036 bind checks it, so the check gets a fake 401 that echoes
  // the key instead of reaching the network.
  const fetch = sinon.stub().resolves({ ok: false, status: 401, text: async () => `{"error":{"message":"User not found: ${key}"}}` });
  const { call, events, autopilot } = setup({ decisions: { fetch } });
  await autopilot.checkDecisionModel();

  const outputs = [
    await call('get-policy'),
    await call('set-policy', { combat: { attackPlayers: true } }),
    await call('set-policy', { instinct: { food: 99 } }),
    await call('set-policy', {}),
    await call('get-policy')
  ];

  for (const { text } of outputs) t.false(text.includes(key));
  for (const event of events.query({ limit: 200 }).events) t.false(event.message.includes(key));
});

// ---------------------------------------------------------------------------------------------------------------
// Review fix 10: set-policy with groups but no values is an error; every request to turn attackPlayers on is
// reported (reply and policy warning event), even when it is already on (F-014, F-018, G3 policy events).

/** A bound setup whose policy is already off the defaults, so "unchanged" cannot pass by coincidence. */
async function setupOffDefaults() {
  const context = setup();
  const set = await context.call('set-policy', { instinct: { food: 10 }, combat: { retreatHealth: 8 } });
  if (set.isError) throw new Error(`setup update failed: ${set.text}`);
  return context;
}

for (const [name, args] of [
  ['{ instinct: {} }', { instinct: {} }],
  ['{ instinct: {}, chat: {} }', { instinct: {}, chat: {} }],
  ['{ combat: {} }', { combat: {} }]
] as const) {
  test(`fix 10: set-policy with ${name} is an error, changes nothing and writes no event`, async (t) => {
    const { call, autopilot, policyEvents } = await setupOffDefaults();
    t.teardown(() => autopilot.unbind('test finished'));
    const before = autopilot.policy.get();
    const snapshot = structuredClone(before);
    const eventsBefore = policyEvents();

    const result = await call('set-policy', args as Record<string, unknown>);

    t.true(result.isError, `expected an error, got: ${result.text}`);
    t.notRegex(result.text, /^Changed:/m, 'the reply must not claim a change');
    t.is(autopilot.policy.get(), before, 'the policy object is not replaced');
    t.deepEqual(autopilot.policy.get(), snapshot);
    t.deepEqual(policyEvents(), eventsBefore);
  });
}

test('fix 10: set-policy turning attackPlayers on twice in a row warns in both replies and writes two warning events', async (t) => {
  const { call, autopilot, policyEvents } = setup();
  t.teardown(() => autopilot.unbind('test finished'));
  const warnings = () => policyEvents().filter(message => /warning/i.test(message) && message.includes('attackPlayers'));
  const eventsBefore = policyEvents().length;

  const first = await call('set-policy', { combat: { attackPlayers: true } });
  const second = await call('set-policy', { combat: { attackPlayers: true } });

  for (const [label, reply] of [['first', first], ['second', second]] as const) {
    t.false(reply.isError, `${label}: ${reply.text}`);
    t.regex(reply.text, /warning[^\n]*attackPlayers|attackPlayers[^\n]*warning/i, `${label} reply carries the warning: ${reply.text}`);
  }
  t.regex(second.text, /nothing (was )?changed|no change|unchanged/i, 'the second call changes nothing');
  t.is(warnings().length, 2, `policy events: ${JSON.stringify(policyEvents())}`);
  const added = policyEvents().slice(eventsBefore);
  t.is(added.filter(message => !/warning/i.test(message)).length, 1, `only the first call writes a change event: ${JSON.stringify(added)}`);
  t.true(autopilot.policy.get().combat.attackPlayers);
});

// ---------------------------------------------------------------------------------------------------------------
// Review fix 12, part 1: set-policy refuses before the bot has joined (the policy is reset on join, so a change made
// earlier would be lost without notice; F-001: services not ready give a clear "not ready" error).

test('fix 12: set-policy before the bot joined is a clear error, the policy is unchanged and no event is written', async (t) => {
  const { call, autopilot, policyEvents } = setup({ bind: false });
  const before = autopilot.policy.get();

  const off = await call('set-policy', { instinct: { enabled: false } });
  const attack = await call('set-policy', { combat: { attackPlayers: true } });

  for (const result of [off, attack]) {
    t.true(result.isError, `expected an error, got: ${result.text}`);
    t.regex(result.text, /not (in the game|joined|ready|connected)|has(n't| not) joined|once it (has )?joined/i, result.text);
  }
  t.is(autopilot.policy.get(), before);
  t.deepEqual(autopilot.policy.get(), DEFAULT_POLICY);
  t.deepEqual(policyEvents(), [], 'no policy event, in particular no attackPlayers warning');
});

test('fix 12: set-policy after the bot left the game is refused and the last policy stays as it was', async (t) => {
  const { call, autopilot, policyEvents } = setup();
  const set = await call('set-policy', { instinct: { lowHealth: 9 } });
  t.false(set.isError, set.text);
  autopilot.unbind('disconnected');
  const held = autopilot.policy.get();
  const eventsBefore = policyEvents();

  const result = await call('set-policy', { instinct: { lowHealth: 2 }, combat: { attackPlayers: true } });

  t.true(result.isError, `expected an error, got: ${result.text}`);
  t.is(autopilot.policy.get(), held);
  t.is(autopilot.policy.get().instinct.lowHealth, 9);
  t.false(autopilot.policy.get().combat.attackPlayers);
  t.deepEqual(policyEvents(), eventsBefore);
});

// ---------------------------------------------------------------------------------------------------------------
// Review fix 12, part 2: through a REAL McpServer (SDK) and client, set-policy rejects unknown top-level groups
// instead of the SDK silently stripping them (F-014/F-018: unknown fields rejected, the policy unchanged on error).
// If the SDK stripped `party`, `{ combat: { retreatHealth: 8 }, party: ... }` would succeed and apply retreatHealth 8.
// (M3 used `chat` and `decisions` as the unknown groups; they became real groups in M4.)

type RealReply = { text: string; isError: boolean };

async function realServer(t: import('ava').ExecutionContext, { bind = true }: { bind?: boolean } = {}) {
  const events = new EventStore();
  const autopilot = new Autopilot({ events });
  if (bind) autopilot.bind(fakeBot() as never);
  const server = new McpServer({ name: 'policy-tools-test-server', version: '0.0.0' });
  const connection = { checkConnectionAndReconnect: async () => ({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(server, connection);
  factory.setAutopilot(() => autopilot);
  // Register before connecting: the server sets up its tool handlers on the first registration.
  registerPolicyTools(factory, () => autopilot, events);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'policy-tools-test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.teardown(async () => {
    await client.close();
    await server.close();
    autopilot.unbind('test finished');
  });

  const call = async (name: 'get-policy' | 'set-policy', args: Record<string, unknown> = {}): Promise<RealReply> => {
    try {
      const result = await client.callTool({ name, arguments: args });
      const content = (result.content ?? []) as { type: string; text?: string }[];
      return { text: content.map(part => part.text ?? '').join('\n'), isError: result.isError === true };
    } catch (error) {
      // A protocol-level rejection is an error too.
      return { text: error instanceof Error ? error.message : String(error), isError: true };
    }
  };
  const policyEvents = () => events.query({ types: ['policy'], limit: 200 }).events.map(event => event.message);
  return { autopilot, client, call, policyEvents };
}

test('fix 12 (real MCP): the policy tools are listed and set-policy takes the four policy groups (no reflexes since M9)', async (t) => {
  const { client } = await realServer(t);

  const { tools } = await client.listTools();

  t.truthy(tools.find(tool => tool.name === 'get-policy'));
  const setPolicy = tools.find(tool => tool.name === 'set-policy');
  t.truthy(setPolicy);
  const properties = Object.keys((setPolicy?.inputSchema.properties ?? {}) as Record<string, unknown>).sort();
  t.deepEqual(properties, ['chat', 'combat', 'decisions', 'instinct']);
});

test('fix 12 (real MCP): an unknown group (party) next to a valid combat change is an error and nothing is applied', async (t) => {
  const { autopilot, call, policyEvents } = await realServer(t);
  const before = autopilot.policy.get();
  const eventsBefore = policyEvents();

  const result = await call('set-policy', { combat: { retreatHealth: 8 }, party: { commandsFrom: ['Steve'] } });

  t.true(result.isError, `expected an error, got: ${result.text}`);
  t.true(result.text.includes('party'), `the error names the unknown group: ${result.text}`);
  t.is(autopilot.policy.get().combat.retreatHealth, DEFAULT_POLICY.combat.retreatHealth, 'the valid combat part is not applied');
  t.is(autopilot.policy.get(), before);
  t.deepEqual(autopilot.policy.get(), DEFAULT_POLICY);
  t.deepEqual(policyEvents(), eventsBefore);
});

test('fix 12 (real MCP): a misspelled group (Combat) turning attackPlayers on is an error, attackPlayers stays off and nothing warns', async (t) => {
  const { autopilot, call, policyEvents } = await realServer(t);
  const before = autopilot.policy.get();
  const eventsBefore = policyEvents();

  const result = await call('set-policy', { Combat: { attackPlayers: true } });

  t.true(result.isError, `expected an error, got: ${result.text}`);
  // Case-sensitive: only a rejection of the unknown key names 'Combat'; had the SDK stripped it, the handler would
  // have refused an empty update without naming it.
  t.true(result.text.includes('Combat'), `the error names the misspelled group: ${result.text}`);
  t.false(autopilot.policy.get().combat.attackPlayers, 'I1: attackPlayers must stay off');
  t.is(autopilot.policy.get(), before);
  t.deepEqual(autopilot.policy.get(), DEFAULT_POLICY);
  t.deepEqual(policyEvents(), eventsBefore, 'no policy event, in particular no attackPlayers warning');
  t.regex(lineOf((await call('get-policy')).text, 'attackPlayers'), /\bfalse\b|\boff\b/);
});

test('fix 12 (real MCP): the removed reflexes group or an unknown group next to a valid instinct change, the removed decisions.combatThreshold, and a misspelled combat field, are errors', async (t) => {
  const { autopilot, call, policyEvents } = await realServer(t);
  const before = autopilot.policy.get();
  const eventsBefore = policyEvents();

  // M9: had the SDK stripped `reflexes`, the instinct change would have gone through.
  const removed = await call('set-policy', { instinct: { enabled: false }, reflexes: { autoEat: { enabled: false } } });
  const group = await call('set-policy', { instinct: { enabled: false }, decision: { enabled: true } });
  const threshold = await call('set-policy', { decisions: { combatThreshold: 0.5, enabled: false } });
  const field = await call('set-policy', { combat: { retreatHealt: 8 } });

  t.true(removed.isError, `removed group: ${removed.text}`);
  t.true(removed.text.includes('reflexes'), removed.text);
  t.true(group.isError, `unknown group: ${group.text}`);
  t.true(group.text.includes('decision'), group.text);
  t.true(threshold.isError, `removed field: ${threshold.text}`);
  t.true(threshold.text.includes('combatThreshold'), threshold.text);
  t.true(field.isError, `misspelled field: ${field.text}`);
  t.true(field.text.includes('retreatHealt'), field.text);
  t.is(autopilot.policy.get(), before);
  t.true(autopilot.policy.get().instinct.enabled, 'the valid instinct part is not applied');
  t.true(autopilot.policy.get().decisions.enabled, 'the valid decisions part is not applied');
  t.deepEqual(policyEvents(), eventsBefore);
});

test('fix 12 (real MCP): a valid set-policy call succeeds, is shown by get-policy and writes a policy event', async (t) => {
  const { autopilot, call, policyEvents } = await realServer(t);
  const eventsBefore = policyEvents().length;

  const result = await call('set-policy', { combat: { retreatHealth: 8 }, instinct: { hostileRadius: 10 } });

  t.false(result.isError, result.text);
  t.is(autopilot.policy.get().combat.retreatHealth, 8);
  t.deepEqual(autopilot.policy.get().instinct, { ...DEFAULT_POLICY.instinct, hostileRadius: 10 }, 'other instinct fields untouched');
  const added = policyEvents().slice(eventsBefore);
  t.true(added.some(message => message.includes('retreatHealth')), `policy events: ${JSON.stringify(added)}`);
  t.true(added.some(message => message.includes('instinct.hostileRadius')), `policy events: ${JSON.stringify(added)}`);
  const shown = (await call('get-policy')).text;
  t.true(numbersIn(lineOf(shown, 'retreatHealth')).includes(8), shown);
  t.true(numbersIn(instinctSection(shown)).includes(10), shown);
});

test('fix 12 (real MCP): set-policy before the bot joined is an error and the policy is unchanged', async (t) => {
  const { autopilot, call, policyEvents } = await realServer(t, { bind: false });
  const before = autopilot.policy.get();

  const result = await call('set-policy', { combat: { retreatHealth: 8 } });

  t.true(result.isError, `expected an error, got: ${result.text}`);
  t.is(autopilot.policy.get(), before);
  t.deepEqual(autopilot.policy.get(), DEFAULT_POLICY);
  t.deepEqual(policyEvents(), []);
});

test('fix 10 (real MCP): set-policy with an empty group is an error; attackPlayers on twice writes two warning events', async (t) => {
  const { autopilot, call, policyEvents } = await realServer(t);
  const before = autopilot.policy.get();

  const empty = await call('set-policy', { instinct: {} });
  t.true(empty.isError, `expected an error, got: ${empty.text}`);
  t.is(autopilot.policy.get(), before);

  const first = await call('set-policy', { combat: { attackPlayers: true } });
  const second = await call('set-policy', { combat: { attackPlayers: true } });
  t.false(first.isError, first.text);
  t.false(second.isError, second.text);
  t.regex(second.text, /warning[^\n]*attackPlayers|attackPlayers[^\n]*warning/i);
  t.is(policyEvents().filter(message => /warning/i.test(message) && message.includes('attackPlayers')).length, 2);
});

// ---------------------------------------------------------------------------------------------------------------
// M8: the instinct group and its status (E-011, F-018, F-040). No test here reaches the network: every autopilot gets
// an injected key getter and fetch.

const NO_KEY = { getKey: () => undefined, fetch: sinon.stub().rejects(new Error('no network in tests')) };
const FAKE_KEY = 'sk-or-v1-FAKE-policy-tools-instinct-0000';
const KEY_CHECK_URL = 'https://openrouter.ai/api/v1/key';
const CATALOG_URL = 'https://openrouter.ai/api/v1/models?output_modalities=decisions';

/**
 * A fetch that answers by URL, never by call order (E-036): the key check with `keyStatus` (a refusal echoes the key),
 * the catalog with the default model, and decision requests with `answers` (rejected without them).
 */
function byUrl(answers?: Record<string, unknown>, { keyStatus = 200 }: { keyStatus?: number } = {}): sinon.SinonStub {
  return sinon.stub().callsFake(async (url: string) => {
    if (url === KEY_CHECK_URL) {
      const ok = keyStatus < 300;
      return { ok, status: keyStatus, text: async () => (ok ? '{"data":{"label":"x"}}' : `{"error":{"message":"User not found: ${FAKE_KEY}"}}`) };
    }
    if (url === CATALOG_URL) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: DEFAULT_POLICY.decisions.model, canonical_slug: DEFAULT_POLICY.decisions.model, context_length: 4096, pricing: { prompt: '0.00000002' } }] }) };
    }
    if (url === DECISIONS_URL && answers) return { ok: true, status: 200, text: async () => JSON.stringify({ model: 'test/decider-1', answers }) };
    throw new Error('no network in tests');
  });
}

/** The get-policy status line for the instinct (the policy text itself has an "Instinct (...)" section header). */
function instinctLine(text: string): string | undefined {
  return text.split('\n').find(line => /^Instinct: /.test(line));
}

test('M8: set-policy with instinct.intent changes it, writes a policy event and get-policy shows it', async (t) => {
  const { call, autopilot, policyEvents } = setup({ decisions: NO_KEY });
  t.teardown(() => autopilot.unbind('test finished'));
  const before = policyEvents().length;

  const set = await call('set-policy', { instinct: { intent: 'diving to the ocean monument on purpose' } });

  t.false(set.isError, set.text);
  t.regex(set.text, /instinct\.intent/);
  t.is(autopilot.policy.get().instinct.intent, 'diving to the ocean monument on purpose');
  t.deepEqual(autopilot.policy.get(), { ...DEFAULT_POLICY, instinct: { ...DEFAULT_POLICY.instinct, intent: 'diving to the ocean monument on purpose' } });
  t.deepEqual(policyEvents().slice(before), ['set-policy changed instinct.intent']);
  t.true((await call('get-policy')).text.includes('diving to the ocean monument on purpose'));
});

const instinctRejected: [string, Record<string, unknown>, string][] = [
  ['an intent of 301 characters', { instinct: { intent: 'x'.repeat(301) } }, 'intent'],
  ['a reaskMs below 500', { instinct: { reaskMs: 499 } }, 'reaskMs'],
  ['an unknown instinct field', { instinct: { panic: true } }, 'panic'],
  ['the removed reflexes.hazardEscape (the whole reflexes group since M9)', { reflexes: { hazardEscape: { enabled: false } } }, 'reflexes']
];

for (const [title, args, field] of instinctRejected) {
  test(`M8: set-policy with ${title} is an error and changes nothing`, async (t) => {
    const { call, autopilot, policyEvents } = setup({ decisions: NO_KEY });
    t.teardown(() => autopilot.unbind('test finished'));
    const eventsBefore = policyEvents();

    const result = await call('set-policy', args);

    t.true(result.isError);
    t.true(result.text.includes(field), `the error names ${field}: ${result.text}`);
    t.deepEqual(autopilot.policy.get(), DEFAULT_POLICY);
    t.deepEqual(policyEvents(), eventsBefore);
  });
}

test('M8: get-policy without a decision key shows the instinct section and says it is offline, with no action running', async (t) => {
  const { call, autopilot } = setup({ decisions: NO_KEY });
  t.teardown(() => autopilot.unbind('test finished'));

  const { text } = await call('get-policy');

  t.regex(text, /^Instinct \(/m, 'the policy text has an instinct section');
  const line = instinctLine(text) ?? '';
  // E-036: the no-key state is the health's OFFLINE, as everywhere else.
  t.regex(line, /^Instinct: OFFLINE \(no OPENROUTER_API_KEY\): the bot does not react to dangers by itself; /, `status line: ${line}`);
  t.regex(line, /\b0 call\(s\) in the last minute/);
  t.true(text.split('\n').includes('No instinct action is running'));
  t.false(text.includes('Last instinct decision'), 'no decision has been made');
});

test('M8: get-policy before the bot joined shows the instinct settings but no instinct status', async (t) => {
  const { call } = setup({ bind: false, decisions: NO_KEY });

  const { text, isError } = await call('get-policy');

  t.false(isError);
  t.regex(text, /^Instinct\b/m, 'the policy text still has its instinct section');
  t.is(instinctLine(text), undefined, 'no status line without a bot');
  t.false(text.includes('No instinct action is running'));
});

// E-036 changed this M8 case: with a key the line no longer says online before the key has been checked.
test('M8 / E-036: with a key get-policy says the instinct is not checked yet until a check passes, and turned off after set-policy instinct.enabled false', async (t) => {
  // Every request waits until fail() and is then refused as if there were no network.
  const waiting: (() => void)[] = [];
  const fail = () => waiting.splice(0).forEach(reject => reject());
  const fetch = sinon.stub().callsFake(() => new Promise((_resolve, reject) => { waiting.push(() => reject(new Error('no network in tests'))); }));
  const { call, autopilot } = setup({ decisions: { getKey: () => FAKE_KEY, fetch } });
  t.teardown(() => autopilot.unbind('test finished'));

  t.regex(instinctLine((await call('get-policy')).text) ?? '', /^Instinct: not checked yet; /, 'while the check of the join is under way');
  fail();
  await autopilot.checkDecisionModel();
  const failed = instinctLine((await call('get-policy')).text) ?? '';
  t.regex(failed, /^Instinct: not checked yet \([^)]+\); /, `a check that could not reach OpenRouter gives its reason: ${failed}`);
  t.notRegex(failed, /online/);
  const off = await call('set-policy', { instinct: { enabled: false } });
  t.false(off.isError, off.text);
  t.regex(instinctLine((await call('get-policy')).text) ?? '', /turned off/);
  t.is(decisionRequests(fetch), 0, 'nothing was asked: the bot stands safely in the open');
});

test.serial('E-036: after a key check that passes, get-policy says online (key checked at HH:MM UTC)', async (t) => {
  // 1.7e12 ms is 2023-11-14 22:13:20 UTC.
  const clock = sinon.useFakeTimers({ now: 1.7e12 });
  t.teardown(() => clock.restore());
  const fetch = byUrl();
  const { call, autopilot } = setup({ decisions: { getKey: () => FAKE_KEY, fetch } });
  t.teardown(() => autopilot.unbind('test finished'));

  await autopilot.checkDecisionModel();

  t.regex(instinctLine((await call('get-policy')).text) ?? '', /^Instinct: online \(key checked at 22:13 UTC\); 0 call\(s\) in the last minute$/);
  t.is(decisionRequests(fetch), 0, 'the check is not a decision request');
});

test.serial('M8: after an instinct decision, get-policy counts the call and shows the last decision', async (t) => {
  const clock = sinon.useFakeTimers({ now: 1.7e12 });
  t.teardown(() => clock.restore());
  // The decision model leaves it to the AI player.
  const answers = {
    action: { type: 'choice', choice: 'ask_llm', confidence: 0.9, probabilities: { continue: 0.05, ask_llm: 0.9, none: 0.05 } },
    urgent: { type: 'noul', noul: 0.2 }
  };
  // By URL (E-036): the key check of bind gets its own replies instead of the decision's.
  const fetch = byUrl(answers);
  const { call, autopilot, bot, events } = setup({ decisions: { getKey: () => FAKE_KEY, fetch } });
  t.teardown(() => autopilot.unbind('test finished'));

  // On fire in the open: a cue for the instinct.
  bot.entity.metadata[0] = 0x01;
  bot.emit('physicsTick');
  await clock.tickAsync(10);

  t.is(decisionRequests(fetch), 1, 'one instinct request');
  const { text } = await call('get-policy');
  // E-036: online carries the time of the check or of the last decision that succeeded (1.7e12 ms is 22:13 UTC).
  t.regex(instinctLine(text) ?? '', /^Instinct: online \(key checked at 22:13 UTC\); 1 call\(s\) in the last minute/);
  t.true(text.split('\n').includes('No instinct action is running'), 'ask_llm runs no action');
  const last = text.split('\n').find(line => line.startsWith('Last instinct decision: ')) ?? '';
  t.regex(last, /on fire/, last);
  t.regex(last, /ask_llm/, last);
  t.is(autopilot.arbiter.holder(), null, 'the body was not taken');
  t.true(events.query({ types: ['instinct'], limit: 20 }).events.some(event => event.message.includes('ask_llm')));
});

for (const [label, decisions] of [
  ['the request fails', {}],
  ['decisions are turned off in the policy', { decisions: { enabled: false } }]
] as const) {
  test.serial(`M8: with a key but ${label}, get-policy says the instinct is offline and why; the body is not taken`, async (t) => {
    const clock = sinon.useFakeTimers({ now: 1.7e12 });
    t.teardown(() => clock.restore());
    const fetch = sinon.stub().rejects(new Error('connection refused'));
    const { call, autopilot, bot, events } = setup({ decisions: { getKey: () => FAKE_KEY, fetch } });
    t.teardown(() => autopilot.unbind('test finished'));
    if ('decisions' in decisions) t.false((await call('set-policy', decisions)).isError);

    bot.entity.metadata[0] = 0x01;
    bot.emit('physicsTick');
    await clock.tickAsync(10);

    const line = instinctLine((await call('get-policy')).text) ?? '';
    t.regex(line, /offline/, line);
    if ('decisions' in decisions) {
      t.is(decisionRequests(fetch), 0, 'decisions off: no request');
    } else {
      t.is(decisionRequests(fetch), 1);
      t.regex(line, /http_error/, `the reason is named: ${line}`);
    }
    const offline = events.query({ types: ['instinct'], limit: 20 }).events.filter(event => event.message.includes('instinct offline'));
    t.is(offline.length, 1);
    t.is(autopilot.arbiter.holder(), null, 'the body is not taken');
  });
}

test.serial('M8: get-policy shows the instinct action that is running', async (t) => {
  const clock = sinon.useFakeTimers({ now: 1.7e12 });
  t.teardown(() => clock.restore());
  const answers = {
    action: { type: 'choice', choice: 'leave_lava', confidence: 0.9, probabilities: { leave_lava: 0.9, continue: 0.05, ask_llm: 0.05, none: 0 } },
    urgent: { type: 'noul', noul: 0.9 }
  };
  const fetch = sinon.stub().resolves({ ok: true, status: 200, text: async () => JSON.stringify({ model: 'test/decider-1', answers }) });
  const { call, autopilot, bot } = setup({ decisions: { getKey: () => FAKE_KEY, fetch }, lavaAtFeet: true });
  t.teardown(() => autopilot.unbind('test finished'));

  bot.emit('physicsTick');
  await clock.tickAsync(500);

  t.is(decisionRequests(fetch), 1);
  t.is(autopilot.arbiter.holder()?.holder, 'instinct leave_lava');
  const { text } = await call('get-policy');
  const running = text.split('\n').find(line => line.startsWith('Instinct action running now: ')) ?? '';
  t.regex(running, /leave_lava/, text);
  t.regex(running, /lava/);
  t.false(text.split('\n').includes('No instinct action is running'));
  t.regex(text.split('\n').find(line => line.startsWith('Last instinct decision: ')) ?? '', /leave_lava/);
});

// ---------------------------------------------------------------------------------------------------------------
// E-036: the decision model's health in get-policy, and list-decision-models without a key. Expected from the E-036
// row: the Decision model line is always shown, keeps its enabled / disabled start and adds "key checked at HH:MM UTC",
// "key not checked yet" or "OFFLINE (<reason>)", so the startup check shows before the bot joins; the Instinct line
// shows OFFLINE (<reason>): the bot does not react to dangers by itself. Without a key list-decision-models still starts
// with "Not configured" and says "Without a key the instinct is offline: the bot does not react to dangers by itself;
// chat is sorted by rules"; with a key its list format is unchanged. The key appears in no output or event (I4).

function decisionLine(text: string): string {
  return text.split('\n').find(line => line.startsWith('Decision model: ')) ?? '<no Decision model line>';
}

test('E-036: without a key the Decision model line starts with disabled and says OFFLINE (no OPENROUTER_API_KEY), before and after the bot joins', async (t) => {
  const { call, autopilot, bot } = setup({ bind: false, decisions: NO_KEY });
  // As main.ts does when the server starts.
  await autopilot.checkDecisionModel();

  const before = (await call('get-policy')).text;
  t.regex(decisionLine(before), /^Decision model: disabled\b/);
  t.true(decisionLine(before).includes('OFFLINE (no OPENROUTER_API_KEY)'), decisionLine(before));
  t.is(instinctLine(before), undefined, 'no Instinct line before the bot joins');

  autopilot.bind(bot as never);
  t.teardown(() => autopilot.unbind('test finished'));
  const after = (await call('get-policy')).text;
  t.is(decisionLine(after), decisionLine(before));
  t.regex(instinctLine(after) ?? '', /^Instinct: OFFLINE \(no OPENROUTER_API_KEY\): the bot does not react to dangers by itself; /);
});

test.serial('E-036: with a key the Decision model line starts with enabled and shows key not checked yet, then key checked at HH:MM UTC', async (t) => {
  // 1.7e12 ms is 2023-11-14 22:13:20 UTC.
  const clock = sinon.useFakeTimers({ now: 1.7e12 });
  t.teardown(() => clock.restore());
  const model = DEFAULT_POLICY.decisions.model;
  const { call, autopilot } = setup({ bind: false, decisions: { getKey: () => FAKE_KEY, fetch: byUrl() } });

  t.is(decisionLine((await call('get-policy')).text), `Decision model: enabled, ${model}, key not checked yet; 0 call(s) in the last hour`);
  await autopilot.checkDecisionModel();
  t.is(decisionLine((await call('get-policy')).text), `Decision model: enabled, ${model}, key checked at 22:13 UTC; 0 call(s) in the last hour`);
});

test('E-036: with a key and decisions turned off the Decision model line keeps its start and still shows the key state', async (t) => {
  const fetch = byUrl();
  const { call, autopilot } = setup({ bind: false, decisions: { getKey: () => FAKE_KEY, fetch } });
  t.true(autopilot.policy.update({ decisions: { enabled: false } }, 'llm').ok);

  await autopilot.checkDecisionModel();

  t.is(decisionLine((await call('get-policy')).text), `Decision model: turned off in the policy, ${DEFAULT_POLICY.decisions.model}, key not checked yet; 0 call(s) in the last hour`);
  t.true(fetch.notCalled, 'decisions turned off send nothing, not even the key check');
});

test('E-036 / I4: a rejected key is OFFLINE (OpenRouter rejected the API key (HTTP 401)) on both lines, and no output or event has the key', async (t) => {
  const fetch = byUrl(undefined, { keyStatus: 401 });
  const { call, autopilot, events } = setup({ bind: false, decisions: { getKey: () => FAKE_KEY, fetch } });
  await autopilot.checkDecisionModel();
  const before = (await call('get-policy')).text;
  t.regex(decisionLine(before), /^Decision model: enabled, \S+, OFFLINE \(OpenRouter rejected the API key \(HTTP 401\)\); /);

  autopilot.bind(fakeBot() as never);
  t.teardown(() => autopilot.unbind('test finished'));
  await autopilot.checkDecisionModel();
  const after = (await call('get-policy')).text;
  t.regex(instinctLine(after) ?? '', /^Instinct: OFFLINE \(OpenRouter rejected the API key \(HTTP 401\)\): the bot does not react to dangers by itself; /);
  // The catalog does not check the key (E-036 step 0), so the models are still listed.
  const models = await call('list-decision-models');
  t.false(models.isError, models.text);
  t.regex(models.text, /^\d+ decision model\(s\); in use: /);

  const secret = FAKE_KEY.slice('sk-or-v1-'.length);
  for (const text of [before, after, models.text]) t.false(text.includes(secret), text);
  for (const event of events.query({ limit: 500 }).events) t.false(event.message.includes(secret), event.message);
  t.false(JSON.stringify(events.query({ limit: 500 }).events).includes('User not found'), 'the refusal body is not shown');
});

test('E-036: the instinct is OFFLINE first even when the policy has turned it off', async (t) => {
  const { call, autopilot } = setup({ decisions: NO_KEY });
  t.teardown(() => autopilot.unbind('test finished'));
  t.false((await call('set-policy', { instinct: { enabled: false } })).isError);
  t.regex(instinctLine((await call('get-policy')).text) ?? '', /^Instinct: OFFLINE \(no OPENROUTER_API_KEY\)/);
});

test('E-036: list-decision-models without a key starts with Not configured and says the instinct is offline', async (t) => {
  const { call, autopilot } = setup({ decisions: NO_KEY });
  t.teardown(() => autopilot.unbind('test finished'));

  const { text, isError } = await call('list-decision-models');

  t.false(isError);
  t.true(text.startsWith('Not configured: '), text);
  t.true(text.endsWith('Without a key the instinct is offline: the bot does not react to dangers by itself; chat is sorted by rules'), text);
  t.true(NO_KEY.fetch.notCalled, 'no catalog request without a key');
});

test('E-036: with a key list-decision-models keeps its list format', async (t) => {
  const model = DEFAULT_POLICY.decisions.model;
  const { call, autopilot } = setup({ decisions: { getKey: () => FAKE_KEY, fetch: byUrl() } });
  t.teardown(() => autopilot.unbind('test finished'));

  const { text, isError } = await call('list-decision-models');

  t.false(isError, text);
  t.deepEqual(text.split('\n'), [
    `1 decision model(s); in use: ${model}`,
    `- ${model}, context 4096, $0.020 per million input tokens, (in use)`
  ]);
});
