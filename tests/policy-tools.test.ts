// Verifies docs/BLUEPRINT.md F-031 against the F-018 contract (src/tools/policy-tools.ts), together with the policy
// parts of F-001 (reset to defaults with a policy event whenever the bot (re)joins; idempotent bind/unbind without
// leftover listeners), F-014 (partial updates, all-or-nothing validation, attackPlayers warning) and invariant I4 (G6).
// The policy text format is tentative (F-018), so the tests only check the facts each line must show.
import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { Autopilot } from '../src/autopilot/autopilot.js';
import { DEFAULT_POLICY } from '../src/autopilot/policy.js';
import { EventStore } from '../src/event-store.js';
import { registerPolicyTools } from '../src/tools/policy-tools.js';
import { createFactory } from './_helpers.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { BotConnection } from '../src/bot-connection.js';

const VERSION = '1.21.8';
const registry = minecraftData(VERSION);
const REFLEX_KEYS = ['creeperEvade', 'hazardEscape', 'lowHealthRetreat', 'selfDefense', 'autoEat'] as const;

/** A bot with real events (so the reflex engine subscribes), standing safely in the open with bread in its inventory. */
function fakeBot({ food = 20 } = {}) {
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
    blockAt: (position: Vec3) => ({ name: 'air', position }),
    pathfinder: { goal: null as unknown, stop: sinon.stub(), setGoal: sinon.stub(), goto: sinon.stub().resolves() },
    clearControlStates: sinon.stub(),
    setControlState: sinon.stub(),
    lookAt: sinon.stub().resolves(),
    equip: sinon.stub().resolves(),
    // Eating lasts until it is cut short, so a started auto-eat stays visible as the running reflex.
    consume: sinon.stub().callsFake(() => new Promise<void>(resolve => { finishEating = resolve; })),
    deactivateItem: sinon.stub().callsFake(() => finishEating?.())
  });
}

type FakeBot = ReturnType<typeof fakeBot>;

function setup({ bind = true }: { bind?: boolean } = {}) {
  const events = new EventStore();
  const autopilot = new Autopilot({ events });
  const bot = fakeBot();
  if (bind) autopilot.bind(bot as never);
  const { factory, getTool } = createFactory();
  registerPolicyTools(factory, () => autopilot, events);

  const call = async (name: 'get-policy' | 'set-policy', args: Record<string, unknown> = {}) => {
    const tool = getTool(name);
    if (!tool) throw new Error(`${name} is not registered`);
    const result = await tool.execute(args);
    return { text: result.content.map(part => part.text).join('\n'), isError: result.isError === true };
  };
  const policyEvents = () => events.query({ types: ['policy'], limit: 200 }).events.map(event => event.message);
  return { events, autopilot, bot, call, policyEvents };
}

/** The lines of a tool reply that name `key` (e.g. "autoEat"). */
function linesOf(text: string, key: string): string[] {
  return text.split('\n').filter(line => new RegExp(`\\b${key}\\b`).test(line));
}

/** The first line of the policy text that names `key`. */
function lineOf(text: string, key: string): string {
  return linesOf(text, key)[0] ?? `<no line for ${key}>`;
}

/** The self-defense stance as shown by the policy text (the line also explains the reflex, which mentions fleeing). */
const STANCE = (stance: string) => new RegExp(`stance\\W+${stance}\\b`);

const ON = /\b(on|enabled|true)\b/;
const OFF = /\b(off|disabled|false)\b/;

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

test('get-policy shows the default policy: every reflex on, stance auto, players never attacked, neutral mobs avoided', async (t) => {
  const { call, autopilot } = setup();

  const { text, isError } = await call('get-policy');

  t.false(isError);
  t.deepEqual(autopilot.policy.get(), DEFAULT_POLICY);
  for (const key of REFLEX_KEYS) {
    t.regex(lineOf(text, key), ON, `${key} should be on by default`);
    t.notRegex(lineOf(text, key), OFF, `${key} should not be shown as off`);
  }
  const d = DEFAULT_POLICY.reflexes;
  t.true(numbersIn(lineOf(text, 'hazardEscape')).includes(d.hazardEscape.lowAir));
  t.true(numbersIn(lineOf(text, 'lowHealthRetreat')).includes(d.lowHealthRetreat.health));
  t.true(numbersIn(lineOf(text, 'lowHealthRetreat')).includes(d.lowHealthRetreat.radius));
  t.true(numbersIn(lineOf(text, 'autoEat')).includes(d.autoEat.food));
  t.regex(lineOf(text, 'selfDefense'), STANCE('auto'));
  t.regex(lineOf(text, 'attackPlayers'), /\bfalse\b|\boff\b/);
  t.regex(lineOf(text, 'avoidNeutral'), /\btrue\b|\bon\b/);
  t.true(numbersIn(lineOf(text, 'retreatHealth')).includes(DEFAULT_POLICY.combat.retreatHealth));
});

test('set-policy turning autoEat off is shown by get-policy at once and writes a policy event', async (t) => {
  const { call, autopilot, policyEvents } = setup();
  const before = policyEvents().length;

  const set = await call('set-policy', { reflexes: { autoEat: { enabled: false } } });
  const { text } = await call('get-policy');

  t.false(set.isError);
  t.regex(set.text, /autoEat/, 'the reply says what changed');
  t.true(linesOf(set.text, 'autoEat').some(line => OFF.test(line)), `the reply carries the updated summary: ${set.text}`);
  t.regex(lineOf(text, 'autoEat'), OFF);
  t.true(numbersIn(lineOf(text, 'autoEat')).includes(DEFAULT_POLICY.reflexes.autoEat.food), 'the food threshold keeps its value');
  for (const key of REFLEX_KEYS.filter(k => k !== 'autoEat')) {
    t.regex(lineOf(text, key), ON, `${key} is untouched`);
  }
  t.deepEqual(autopilot.policy.get(), {
    ...DEFAULT_POLICY,
    reflexes: { ...DEFAULT_POLICY.reflexes, autoEat: { ...DEFAULT_POLICY.reflexes.autoEat, enabled: false } }
  });
  const added = policyEvents().slice(before);
  t.true(added.length >= 1, 'a policy event is written');
  t.true(added.some(message => message.includes('autoEat')), `policy events: ${JSON.stringify(added)}`);
});

test('set-policy changes several fields in one call and leaves every other field alone', async (t) => {
  const { call, autopilot } = setup();

  const set = await call('set-policy', {
    reflexes: { selfDefense: { stance: 'flee' }, lowHealthRetreat: { health: 8 } },
    combat: { retreatHealth: 9 }
  });

  t.false(set.isError);
  for (const path of ['selfDefense', 'lowHealthRetreat', 'retreatHealth']) t.true(set.text.includes(path), `reply names ${path}`);
  t.deepEqual(autopilot.policy.get(), {
    reflexes: {
      ...DEFAULT_POLICY.reflexes,
      selfDefense: { enabled: true, stance: 'flee' },
      lowHealthRetreat: { ...DEFAULT_POLICY.reflexes.lowHealthRetreat, health: 8 }
    },
    combat: { ...DEFAULT_POLICY.combat, retreatHealth: 9 },
    chat: DEFAULT_POLICY.chat,
    decisions: DEFAULT_POLICY.decisions
  });
  const { text } = await call('get-policy');
  t.regex(lineOf(text, 'selfDefense'), STANCE('flee'));
  t.true(numbersIn(lineOf(text, 'lowHealthRetreat')).includes(8));
  t.true(numbersIn(lineOf(text, 'retreatHealth')).includes(9));
});

const rejected: [string, Record<string, unknown>, string][] = [
  ['an unknown field next to a valid change', { reflexes: { autoEat: { enabled: false, speed: 2 } } }, 'speed'],
  ['an unknown reflex', { reflexes: { danceParty: { enabled: true } } }, 'danceParty'],
  ['an unknown combat rule next to attackPlayers', { combat: { attackPlayers: true, friendlyFire: true } }, 'friendlyFire'],
  ['an unknown top-level group', { chaos: { level: 3 } }, 'chaos'],
  ['a food threshold above 20', { reflexes: { autoEat: { food: 25 } } }, 'food'],
  ['a radius below 1', { reflexes: { lowHealthRetreat: { radius: 0 } } }, 'radius'],
  ['an unknown stance', { reflexes: { selfDefense: { stance: 'berserk' } } }, 'stance']
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
  await call('set-policy', { reflexes: { autoEat: { food: 10 } } });
  const eventsBefore = policyEvents();

  const defaults = await call('set-policy', { reflexes: { creeperEvade: { enabled: true }, selfDefense: { stance: 'auto' } }, combat: { avoidNeutral: true } });
  const same = await call('set-policy', { reflexes: { autoEat: { food: 10 } } });

  for (const result of [defaults, same]) {
    t.false(result.isError, result.text);
    t.regex(result.text, /nothing (was )?changed|no change|unchanged/i);
  }
  t.deepEqual(policyEvents(), eventsBefore);
  t.is(autopilot.policy.get().reflexes.autoEat.food, 10);
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
      reflexes: { autoEat: { enabled: false }, selfDefense: { stance: 'flee' } },
      combat: { attackPlayers: true, retreatHealth: 3 }
    });
    t.notDeepEqual(autopilot.policy.get(), DEFAULT_POLICY);

    if (via === 'a disconnect and reconnect') autopilot.unbind('disconnected');
    autopilot.bind(fakeBot() as never);
    t.teardown(() => autopilot.unbind('test finished'));

    t.deepEqual(autopilot.policy.get(), DEFAULT_POLICY);
    const { text } = await call('get-policy');
    t.regex(lineOf(text, 'autoEat'), ON);
    t.regex(lineOf(text, 'attackPlayers'), /\bfalse\b|\boff\b/);
    t.regex(lineOf(text, 'selfDefense'), STANCE('auto'));
    const messages = policyEvents();
    t.true(messages.at(-1)!.startsWith('policy reset to defaults'), `last policy event: ${messages.at(-1)}`);
    t.is(messages.filter(message => message.startsWith('policy reset to defaults')).length, 2, 'one per bind');
  });
}

test('binding the same bot again keeps the policy and a single set of tick listeners', async (t) => {
  const { call, autopilot, bot, policyEvents } = setup();
  t.teardown(() => autopilot.unbind('test finished'));
  await call('set-policy', { reflexes: { autoEat: { enabled: false } } });
  const engine = autopilot.reflexes;

  autopilot.bind(bot as never);

  t.false(autopilot.policy.get().reflexes.autoEat.enabled, 'a repeated ready callback is not a rejoin');
  t.is(policyEvents().filter(message => message.startsWith('policy reset to defaults')).length, 1);
  t.is(autopilot.reflexes, engine);
  t.is(bot.listenerCount('physicsTick'), 1);
  t.is(bot.listenerCount('death'), 1);
  bot.emit('physicsTick');
  t.is(autopilot.reflexes.timing().ticks, 1, 'one evaluation per game tick');
});

test('after bind every game tick reaches the reflex engine, and get-policy reports the checks', async (t) => {
  const { autopilot, bot, call } = setup();
  t.teardown(() => autopilot.unbind('test finished'));

  bot.emit('physicsTick');
  bot.emit('physicsTick');
  bot.emit('physicsTick');

  t.is(autopilot.reflexes.timing().ticks, 3);
  t.is(autopilot.reflexes.current(), null);
  const { text } = await call('get-policy');
  t.true(numbersIn(lineOf(text, 'ticks')).includes(3), `get-policy: ${text}`);
});

function listenerTotal(bot: FakeBot): number {
  return bot.eventNames().reduce((sum, name) => sum + bot.listenerCount(name), 0);
}

test('unbind removes every listener the autopilot added to the bot, and later ticks do nothing', (t) => {
  const { autopilot, bot } = setup({ bind: false });
  autopilot.bind(bot as never);
  t.is(bot.listenerCount('physicsTick'), 1);

  autopilot.unbind('disconnected');

  t.is(bot.listenerCount('physicsTick'), 0);
  t.is(bot.listenerCount('death'), 0);
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

test('the reflex engine follows a set-policy change on its next tick', async (t) => {
  const { autopilot, bot, call } = setup();
  t.teardown(() => autopilot.unbind('test finished'));

  await call('set-policy', { reflexes: { autoEat: { enabled: false } } });
  bot.food = 5;
  bot.emit('physicsTick');

  t.is(autopilot.reflexes.current(), null, 'auto-eat is off');
  t.is(autopilot.arbiter.holder(), null);
  t.false(bot.equip.called);

  await call('set-policy', { reflexes: { autoEat: { enabled: true } } });
  bot.emit('physicsTick');

  t.is(autopilot.reflexes.current()?.name, 'auto-eat', 'turned back on, the hungry bot starts eating');
  t.is(autopilot.arbiter.holder()?.holder, 'reflex auto-eat');
  t.regex((await call('get-policy')).text, /auto-eat/, 'get-policy names the running reflex');
});

test.serial('policy tool output and policy events never contain the OpenRouter API key (I4)', async (t) => {
  const key = 'sk-or-v1-policy-tools-test-sentinel-0123456789';
  const previous = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = key;
  t.teardown(() => {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  });
  const { call, events } = setup();

  const outputs = [
    await call('get-policy'),
    await call('set-policy', { combat: { attackPlayers: true } }),
    await call('set-policy', { reflexes: { autoEat: { food: 99 } } }),
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
  const set = await context.call('set-policy', { reflexes: { autoEat: { food: 10 } }, combat: { retreatHealth: 8 } });
  if (set.isError) throw new Error(`setup update failed: ${set.text}`);
  return context;
}

for (const [name, args] of [
  ['{ reflexes: {} }', { reflexes: {} }],
  ['{ reflexes: { autoEat: {} } }', { reflexes: { autoEat: {} } }],
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

  const off = await call('set-policy', { reflexes: { autoEat: { enabled: false } } });
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
  const set = await call('set-policy', { reflexes: { selfDefense: { stance: 'flee' } } });
  t.false(set.isError, set.text);
  autopilot.unbind('disconnected');
  const held = autopilot.policy.get();
  const eventsBefore = policyEvents();

  const result = await call('set-policy', { reflexes: { selfDefense: { stance: 'fight' } }, combat: { attackPlayers: true } });

  t.true(result.isError, `expected an error, got: ${result.text}`);
  t.is(autopilot.policy.get(), held);
  t.is(autopilot.policy.get().reflexes.selfDefense.stance, 'flee');
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

test('fix 12 (real MCP): the policy tools are listed and set-policy takes the four policy groups', async (t) => {
  const { client } = await realServer(t);

  const { tools } = await client.listTools();

  t.truthy(tools.find(tool => tool.name === 'get-policy'));
  const setPolicy = tools.find(tool => tool.name === 'set-policy');
  t.truthy(setPolicy);
  const properties = Object.keys((setPolicy?.inputSchema.properties ?? {}) as Record<string, unknown>).sort();
  t.deepEqual(properties, ['chat', 'combat', 'decisions', 'reflexes']);
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

test('fix 12 (real MCP): an unknown group next to a valid reflex change, and a misspelled combat field, are errors', async (t) => {
  const { autopilot, call, policyEvents } = await realServer(t);
  const before = autopilot.policy.get();
  const eventsBefore = policyEvents();

  const group = await call('set-policy', { reflexes: { autoEat: { enabled: false } }, decision: { enabled: true } });
  const field = await call('set-policy', { combat: { retreatHealt: 8 } });

  t.true(group.isError, `unknown group: ${group.text}`);
  t.true(group.text.includes('decision'), group.text);
  t.true(field.isError, `misspelled field: ${field.text}`);
  t.true(field.text.includes('retreatHealt'), field.text);
  t.is(autopilot.policy.get(), before);
  t.true(autopilot.policy.get().reflexes.autoEat.enabled, 'the valid autoEat part is not applied');
  t.deepEqual(policyEvents(), eventsBefore);
});

test('fix 12 (real MCP): a valid set-policy call succeeds, is shown by get-policy and writes a policy event', async (t) => {
  const { autopilot, call, policyEvents } = await realServer(t);
  const eventsBefore = policyEvents().length;

  const result = await call('set-policy', { combat: { retreatHealth: 8 }, reflexes: { selfDefense: { stance: 'flee' } } });

  t.false(result.isError, result.text);
  t.is(autopilot.policy.get().combat.retreatHealth, 8);
  t.is(autopilot.policy.get().reflexes.selfDefense.stance, 'flee');
  t.deepEqual(autopilot.policy.get().reflexes.autoEat, DEFAULT_POLICY.reflexes.autoEat, 'other fields untouched');
  const added = policyEvents().slice(eventsBefore);
  t.true(added.some(message => message.includes('retreatHealth')), `policy events: ${JSON.stringify(added)}`);
  const shown = (await call('get-policy')).text;
  t.true(numbersIn(lineOf(shown, 'retreatHealth')).includes(8), shown);
  t.regex(lineOf(shown, 'selfDefense'), STANCE('flee'));
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

  const empty = await call('set-policy', { reflexes: {} });
  t.true(empty.isError, `expected an error, got: ${empty.text}`);
  t.is(autopilot.policy.get(), before);

  const first = await call('set-policy', { combat: { attackPlayers: true } });
  const second = await call('set-policy', { combat: { attackPlayers: true } });
  t.false(first.isError, first.text);
  t.false(second.isError, second.text);
  t.regex(second.text, /warning[^\n]*attackPlayers|attackPlayers[^\n]*warning/i);
  t.is(policyEvents().filter(message => /warning/i.test(message) && message.includes('attackPlayers')).length, 2);
});
