import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { registerGameStateTools } from '../src/tools/gamestate-tools.js';
import { registerPolicyTools } from '../src/tools/policy-tools.js';
import { Autopilot, AutopilotOptions } from '../src/autopilot/autopilot.js';
import { DEFAULT_DECISION_MODEL } from '../src/autopilot/policy.js';
import { EventStore } from '../src/event-store.js';
import { asBot, createFactory } from './_helpers.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import type mineflayer from 'mineflayer';

test('registerGameStateTools registers detect-gamemode tool', (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockBot = {} as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerGameStateTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const detectGamemodeCall = toolCalls.find(call => call.args[0] === 'detect-gamemode');

  t.truthy(detectGamemodeCall);
  t.is(detectGamemodeCall!.args[1], 'Detect the gamemode on game');
});

test('detect-gamemode returns creative mode', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const mockBot = {
    game: {
      gameMode: 'creative'
    }
  } as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerGameStateTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const detectGamemodeCall = toolCalls.find(call => call.args[0] === 'detect-gamemode');
  const executor = detectGamemodeCall!.args[3];

  const result = await executor({});

  t.true(result.content[0].text.includes('creative'));
});

test('detect-gamemode returns survival mode', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const mockBot = {
    game: {
      gameMode: 'survival'
    }
  } as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerGameStateTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const detectGamemodeCall = toolCalls.find(call => call.args[0] === 'detect-gamemode');
  const executor = detectGamemodeCall!.args[3];

  const result = await executor({});

  t.true(result.content[0].text.includes('survival'));
});

test('detect-gamemode returns adventure mode', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const mockBot = {
    game: {
      gameMode: 'adventure'
    }
  } as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerGameStateTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const detectGamemodeCall = toolCalls.find(call => call.args[0] === 'detect-gamemode');
  const executor = detectGamemodeCall!.args[3];

  const result = await executor({});

  t.true(result.content[0].text.includes('adventure'));
});

// ---- E-036: get-observation shows the instinct's state when it is given the Autopilot ------------------------------
// Expected from the E-036 row: registerGameStateTools takes an optional getAutopilot (src/main.ts passes it); with it
// get-observation always has one "Instinct: <state>" line, the same state as the Instinct line of get-policy (both
// from instinctState); without it there is no such line, so the existing callers (m12, m15 and others) are unchanged.

const KEY_CHECK_URL = 'https://openrouter.ai/api/v1/key';
const FAKE_KEY = 'sk-or-v1-FAKE-gamestate-tools-0000';

/** Enough of a bot for get-observation, with real events so the Autopilot can bind to it. */
function observationBot() {
  return Object.assign(new EventEmitter(), {
    version: '1.21.8',
    username: 'ClaudeBot',
    entity: { id: 1, position: new Vec3(0, 64, 0), effects: {}, metadata: [] },
    entities: {},
    players: {},
    game: { dimension: 'overworld', gameMode: 'survival' },
    health: 20, food: 20, foodSaturation: 5,
    experience: { level: 0, points: 0 },
    time: { timeOfDay: 1000, isDay: true },
    isRaining: false, thunderState: 0, heldItem: null,
    getEquipmentDestSlot: (destination: string) => ({ head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 }[destination] ?? 36),
    inventory: { slots: {}, items: () => [] },
    blockAt: (position: Vec3) => ({ name: 'air', position }),
    pathfinder: { goal: null, stop: sinon.stub(), setGoal: sinon.stub() },
    clearControlStates: sinon.stub()
  });
}

/** The key check answered by URL: `keyStatus` for GET /api/v1/key, the default model in the catalog. */
function keyCheck(keyStatus: number) {
  return sinon.stub().callsFake(async (url: string) => {
    if (url === KEY_CHECK_URL) return { ok: keyStatus < 300, status: keyStatus, text: async () => (keyStatus < 300 ? '{"data":{}}' : `denied ${FAKE_KEY}`) };
    if (url.startsWith('https://openrouter.ai/api/v1/models?')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: DEFAULT_DECISION_MODEL }] }) };
    }
    throw new Error('no network in tests');
  });
}

async function observe(decisions: AutopilotOptions['decisions'], { bind = true, withAutopilot = true } = {}) {
  const autopilot = new Autopilot({ events: new EventStore(), decisions });
  const bot = observationBot();
  if (bind) autopilot.bind(bot as never);
  await autopilot.checkDecisionModel();
  const { factory, getTool } = createFactory();
  registerGameStateTools(factory, asBot(bot), withAutopilot ? () => autopilot : undefined);
  registerPolicyTools(factory, () => autopilot, new EventStore());
  const observation = (await getTool('get-observation')!.execute({})).content[0].text;
  const policy = (await getTool('get-policy')!.execute({})).content[0].text;
  autopilot.unbind('test finished');
  const instinctLines = observation.split('\n').filter(line => line.startsWith('Instinct'));
  // get-policy goes on with "; <n> call(s) in the last minute".
  const policyState = policy.split('\n').find(line => line.startsWith('Instinct: '))?.replace(/; \d+ call\(s\) in the last minute$/, '');
  return { observation, instinctLines, policyState };
}

const NO_KEY = { getKey: () => undefined, fetch: sinon.stub().rejects(new Error('no network in tests')) };

test('E-036: without getAutopilot get-observation has no Instinct line', async (t) => {
  const { instinctLines, observation } = await observe(NO_KEY, { withAutopilot: false });
  t.deepEqual(instinctLines, []);
  t.true(observation.includes('Health: 20/20'), 'the observation itself is unchanged');
});

test('E-036: with getAutopilot get-observation has one Instinct line, the same state as get-policy', async (t) => {
  const cases: [string, AutopilotOptions['decisions'], RegExp][] = [
    ['no key', NO_KEY, /^Instinct: OFFLINE \(no OPENROUTER_API_KEY\): the bot does not react to dangers by itself$/],
    ['a rejected key', { getKey: () => FAKE_KEY, fetch: keyCheck(401) }, /^Instinct: OFFLINE \(OpenRouter rejected the API key \(HTTP 401\)\): the bot does not react to dangers by itself$/],
    ['a key that passes', { getKey: () => FAKE_KEY, fetch: keyCheck(200) }, /^Instinct: online \(key checked at \d\d:\d\d UTC\)$/]
  ];
  for (const [label, decisions, expected] of cases) {
    const { instinctLines, policyState, observation } = await observe(decisions);
    t.is(instinctLines.length, 1, `${label}: ${observation}`);
    t.regex(instinctLines[0], expected, label);
    t.is(instinctLines[0], policyState ?? '<no Instinct line in get-policy>', `${label}: the same state as get-policy`);
    t.false(observation.includes('FAKE-gamestate-tools'), `${label}: no key in the observation (I4)`);
  }
});

test('E-036: get-observation shows the state before the Autopilot has bound the bot, without an error', async (t) => {
  const { instinctLines } = await observe(NO_KEY, { bind: false });
  t.deepEqual(instinctLines, ['Instinct: OFFLINE (no OPENROUTER_API_KEY): the bot does not react to dangers by itself']);
  // A key that passes gets past the OFFLINE line to where the instinct engine would be asked; it does not exist yet.
  const passed = await observe({ getKey: () => FAKE_KEY, fetch: keyCheck(200) }, { bind: false });
  t.is(passed.instinctLines.length, 1);
  t.regex(passed.instinctLines[0], /^Instinct: online \(key checked at \d\d:\d\d UTC\)$/);
});

// E-037: a pause after a 429 shows in get-observation the same way as in get-policy, "OFFLINE for 7 more s (paused after
// HTTP 429)", since both come from instinctState.
test.serial('E-037: during a pause get-observation has the same Instinct line as get-policy, with the seconds left', async (t) => {
  const clock = sinon.useFakeTimers({ now: 1.7e12 });
  t.teardown(() => clock.restore());
  const check = keyCheck(200);
  const fetch = sinon.stub().callsFake(async (url: string, init: unknown) => url === 'https://openrouter.ai/api/alpha/decisions'
    ? { ok: false, status: 429, text: async () => `slow down ${FAKE_KEY}`, headers: { get: (name: string) => (name.toLowerCase() === 'retry-after' ? '7' : null) } }
    : check(url, init));
  const autopilot = new Autopilot({ events: new EventStore(), decisions: { getKey: () => FAKE_KEY, fetch } });
  const bot = observationBot();
  autopilot.bind(bot as never);
  t.teardown(() => autopilot.unbind('test finished'));
  await autopilot.checkDecisionModel();
  const result = await autopilot.decisions.decide({}, { action: { type: 'choice', instructions: 'test', criteria: { none: 'nothing' } } }, { budget: 'instinct' });
  t.true(!result.ok && result.error === 'throttled');

  const { factory, getTool } = createFactory();
  registerGameStateTools(factory, asBot(bot), () => autopilot);
  registerPolicyTools(factory, () => autopilot, new EventStore());
  const observation = (await getTool('get-observation')!.execute({})).content[0].text;
  const policy = (await getTool('get-policy')!.execute({})).content[0].text;
  const instinctLines = observation.split('\n').filter(line => line.startsWith('Instinct'));
  t.deepEqual(instinctLines, ['Instinct: OFFLINE for 7 more s (paused after HTTP 429): the bot does not react to dangers by itself']);
  t.is(policy.split('\n').find(line => line.startsWith('Instinct: '))?.replace(/; \d+ call\(s\) in the last minute$/, ''), instinctLines[0]);
  t.false(observation.includes('FAKE-gamestate-tools'), 'no key in the observation (I4)');
});
