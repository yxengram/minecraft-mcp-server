// M19 connection changes (BLUEPRINT F-047). Each case names the clause of its E row; the expected values come from
// the contract, not from what the code happens to print.
import test, { ExecutionContext } from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import type mineflayer from 'mineflayer';
import { BotConnection, CONNECT_TIMEOUT_MS } from '../src/bot-connection.js';
import { explainFailure, kickInfo } from '../src/connection-errors.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createFactory } from './_helpers.js';

// ---------------------------------------------------------------------------------------------------------------
// E-021: an attempt that fails before spawning ends in disconnected, so the next tool call connects again.
// ---------------------------------------------------------------------------------------------------------------

const CONFIG = { host: 'localhost', port: 25565, username: 'Bot' };
const RECONNECT_DELAY_MS = 10;
// checkConnectionAndReconnect polls every 100 ms for the reconnect delay plus 5 s before it gives up. Since E-028 it
// replies at the first poll after a failure, so waiting this long covers both kinds of reply.
const CALL_WAIT_MS = RECONNECT_DELAY_MS + 5000 + 100;
const CANNOT_CONNECT = 'Cannot connect to Minecraft server at localhost:25565';
// The spawn handler builds pathfinder settings from a real registry.
const VERSION = '1.21.8';
const registry = minecraftData(VERSION);

type FakeBot = EventEmitter & { _client: EventEmitter; end: sinon.SinonStub; quit?: sinon.SinonStub };

/** What mineflayer hands out before spawning: an EventEmitter with _client and end(), and no quit yet. */
function fakeBot(): FakeBot {
  const bot = new EventEmitter() as FakeBot;
  Object.assign(bot, {
    _client: new EventEmitter(),
    end: sinon.stub(),
    registry,
    version: VERSION,
    username: 'Bot',
    health: 20,
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5) },
    entities: {},
    pathfinder: { setMovements: sinon.stub() },
    chat: sinon.stub()
  });
  return bot;
}

function setup(createBot?: sinon.SinonStub, config: typeof CONFIG = CONFIG) {
  const clock = sinon.useFakeTimers();
  const bots: FakeBot[] = [];
  const create = createBot ?? sinon.stub();
  if (!createBot) create.callsFake(() => newBot(bots));
  const callbacks = {
    onLog: sinon.stub(),
    onChatMessage: sinon.stub(),
    onEvent: sinon.stub(),
    onBotReady: sinon.stub(),
    onBotEnd: sinon.stub()
  };
  const connection = new BotConnection(config, callbacks, RECONNECT_DELAY_MS, { createBot: create as unknown as (options: mineflayer.BotOptions) => mineflayer.Bot });
  return { clock, bots, createBot: create, callbacks, connection };
}

function newBot(bots: FakeBot[]): FakeBot {
  const bot = fakeBot();
  bots.push(bot);
  return bot;
}

type Setup = ReturnType<typeof setup>;

function errno(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** A tool call while disconnected: the reconnect creates the next bot, `fail` ends that attempt, and the call replies. */
async function callWhile(t: ExecutionContext, s: Setup, fail: (bot: FakeBot) => void) {
  const before = s.bots.length;
  const reply = s.connection.checkConnectionAndReconnect();
  await s.clock.tickAsync(RECONNECT_DELAY_MS);
  t.is(s.bots.length, before + 1, 'the call starts a new attempt');
  fail(s.bots[s.bots.length - 1]);
  await s.clock.tickAsync(CALL_WAIT_MS);
  return reply;
}

const preSpawnFailures: { name: string; fail: (bot: FakeBot) => void }[] = [
  {
    name: 'ENOTFOUND (error, then end)',
    fail: bot => {
      bot.emit('error', errno('ENOTFOUND', 'getaddrinfo ENOTFOUND nonexistent.invalid'));
      bot.emit('end', 'socketClosed');
    }
  },
  {
    name: 'ECONNRESET (end, then error)',
    fail: bot => {
      bot.emit('end', 'socketClosed');
      bot.emit('error', errno('ECONNRESET', 'read ECONNRESET'));
    }
  },
  { name: "an end('socketClosed') during login", fail: bot => bot.emit('end', 'socketClosed') },
  {
    name: 'a version error without a code or an end (Unsupported protocol version)',
    fail: bot => bot.emit('error', new Error("Unsupported protocol version '776'; try updating your packages with 'npm update'"))
  },
  {
    name: 'a version error without a code or an end (No data available for version)',
    fail: bot => bot.emit('error', new Error('No data available for version 26.2'))
  },
  {
    name: "a version error without a code or an end (Server version '…' is not supported)",
    fail: bot => bot.emit('error', new Error("Server version '26.2' is not supported. Latest supported version is '26.1.2'."))
  },
  {
    name: 'a version error without a code or an end (This server is version)',
    fail: bot => bot.emit('error', new Error('This server is version 1.21.8, you are using version 26.1.2, please specify the correct version in the options.'))
  }
];

for (const { name, fail } of preSpawnFailures) {
  test.serial(`E-021 before spawn, ${name}: disconnected, bot.end called, and the next calls reconnect instead of "please wait"`, async (t) => {
    const s = setup();
    t.teardown(() => s.clock.restore());
    s.connection.connect();
    t.is(s.connection.getState(), 'connecting');

    fail(s.bots[0]);
    t.is(s.connection.getState(), 'disconnected');
    t.is(s.connection.getBot(), null);
    t.true(s.bots[0].end.calledOnce, 'the instance is let go with bot.end (bot.quit does not exist yet)');
    t.true(s.callbacks.onEvent.calledWith('disconnected'), 'a disconnected event is written');
    t.true(s.callbacks.onBotEnd.notCalled, 'the Autopilot binds only at spawn, so it is not unbound');

    // As in the live check: three calls in a row, each a new attempt, none of them "please wait".
    for (let call = 1; call <= 3; call++) {
      const result = await callWhile(t, s, fail);
      t.false(result.connected);
      t.true(result.message!.startsWith(CANNOT_CONNECT), `call ${call}: ${result.message}`);
      t.false(result.message!.includes('Please wait'));
      t.is(s.connection.getState(), 'disconnected');
    }
    t.is(s.createBot.callCount, 4);
  });
}

test.serial('E-021 watchdog: no spawn within CONNECT_TIMEOUT_MS (30 s) ends the attempt as SPAWN_TIMEOUT', async (t) => {
  t.is(CONNECT_TIMEOUT_MS, 30_000);
  const s = setup();
  t.teardown(() => s.clock.restore());
  s.connection.connect();

  await s.clock.tickAsync(CONNECT_TIMEOUT_MS - 1);
  t.is(s.connection.getState(), 'connecting', 'a server that accepts and never answers sends no event');
  await s.clock.tickAsync(1);
  t.is(s.connection.getState(), 'disconnected');
  t.is(s.connection.getBot(), null);
  t.true(s.bots[0].end.calledOnce);
  t.like(s.connection.lastFailure(), { code: 'SPAWN_TIMEOUT', message: 'no spawn within 30 s', time: CONNECT_TIMEOUT_MS });
  t.true(s.callbacks.onBotEnd.notCalled);

  const result = await callWhile(t, s, () => {});
  t.true(result.message!.startsWith(CANNOT_CONNECT));
  t.is(s.createBot.callCount, 2);
});

test.serial('E-021 watchdog: a spawn clears it', async (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  s.connection.connect();
  await s.clock.tickAsync(1000);
  s.bots[0].emit('spawn');
  t.is(s.connection.getState(), 'connected');
  await s.clock.tickAsync(CONNECT_TIMEOUT_MS * 2);
  t.is(s.connection.getState(), 'connected');
  t.true(s.bots[0].end.notCalled);
  t.is(s.connection.lastFailure(), null);
});

test.serial('E-021 lastFailure: the code, message and time of the error that ended the attempt', (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  s.connection.connect();
  s.clock.tick(250);
  s.bots[0].emit('error', errno('ENOTFOUND', 'getaddrinfo ENOTFOUND nonexistent.invalid'));
  s.bots[0].emit('end', 'socketClosed');
  t.like(s.connection.lastFailure(), { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND nonexistent.invalid', time: 250 });
});

test.serial('E-021 lastFailure: a version error is recorded with its message', (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  s.connection.connect();
  s.bots[0].emit('error', new Error('No data available for version 26.2'));
  t.is(s.connection.lastFailure()?.code, undefined);
  t.is(s.connection.lastFailure()?.message, 'No data available for version 26.2');
});

test.serial('E-021 lastFailure: with the end first, "socketClosed" is used because nothing came earlier', (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  s.connection.connect();
  s.bots[0].emit('end', 'socketClosed');
  s.bots[0].emit('error', errno('ECONNRESET', 'read ECONNRESET'));
  t.is(s.connection.lastFailure()?.message, 'socketClosed');
});

test.serial('E-021 lastFailure: an unlisted error waits for the end, and its code wins over "socketClosed"', (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  s.connection.connect();
  s.clock.tick(100);
  s.bots[0].emit('error', errno('EPROTO', 'unexpected packet'));
  t.is(s.connection.getState(), 'connecting', 'an error outside the list does not end the attempt by itself');
  t.true(s.bots[0].end.notCalled);
  s.clock.tick(100);
  s.bots[0].emit('end', 'socketClosed');
  t.is(s.connection.getState(), 'disconnected');
  t.like(s.connection.lastFailure(), { code: 'EPROTO', message: 'unexpected packet', time: 100 });
});

test.serial('E-021 lastFailure: an unlisted error that is followed by nothing is ended by the watchdog, and keeps its code', async (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  s.connection.connect();
  s.bots[0].emit('error', errno('EPROTO', 'unexpected packet'));
  await s.clock.tickAsync(CONNECT_TIMEOUT_MS);
  t.is(s.connection.getState(), 'disconnected');
  t.is(s.connection.lastFailure()?.code, 'EPROTO');
});

test.serial('E-021 lastFailure: a kick during login keeps the raw reason, and wins over the end after it', (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  s.connection.connect();
  const bot = s.bots[0];
  // kicked comes from the kick plugin, which brings quit with it.
  bot.quit = sinon.stub();
  const reason = { translate: 'multiplayer.disconnect.not_whitelisted' };
  bot.emit('kicked', reason, false);
  t.true(s.callbacks.onEvent.calledWith('kicked'), 'kicked keeps its event');
  t.is(s.connection.getState(), 'disconnected');
  bot.emit('end', 'socketClosed');
  t.deepEqual(s.connection.lastFailure()?.kickReason, reason);
  t.is(s.connection.lastFailure()?.code, undefined);
  t.is(s.connection.getBot(), null);
});

test.serial('E-021 lastFailure: each attempt keeps its own first record', async (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  s.connection.connect();
  s.bots[0].emit('error', errno('ENOTFOUND', 'getaddrinfo ENOTFOUND nonexistent.invalid'));
  await callWhile(t, s, bot => bot.emit('error', errno('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:25565')));
  t.is(s.connection.lastFailure()?.code, 'ECONNREFUSED', 'the earlier attempt does not hold on to its record');
});

test.serial('E-021 lastFailure: cleared when the bot spawns', (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  s.connection.connect();
  s.bots[0].emit('error', errno('EPROTO', 'unexpected packet'));
  t.is(s.connection.lastFailure()?.code, 'EPROTO');
  s.bots[0].emit('spawn');
  t.is(s.connection.getState(), 'connected');
  t.is(s.connection.lastFailure(), null);
  t.true(s.callbacks.onBotReady.calledOnce);
});

test.serial('E-021 a late error after the instance is let go is not thrown and causes no unhandled rejection', async (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  s.connection.connect();
  const bot = s.bots[0];
  bot.emit('error', errno('ENOTFOUND', 'getaddrinfo ENOTFOUND nonexistent.invalid'));
  t.is(s.connection.getState(), 'disconnected');

  t.notThrows(() => bot.emit('error', new Error('ping: second error')));
  // ping reports it from inside a promise's then, where a throw would become an unhandled rejection.
  await t.notThrowsAsync(Promise.resolve().then(() => bot.emit('error', errno('ECONNRESET', 'read ECONNRESET'))));
  t.is(s.connection.getState(), 'disconnected');
});

test.serial('E-021 late end and error from an older instance do not change the newer one', async (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  s.connection.connect();
  const old = s.bots[0];
  old.emit('error', errno('ENOTFOUND', 'getaddrinfo ENOTFOUND nonexistent.invalid'));
  void s.connection.checkConnectionAndReconnect();
  await s.clock.tickAsync(RECONNECT_DELAY_MS);
  const current = s.bots[1];
  t.is(s.connection.getState(), 'connecting');

  old.emit('end', 'socketClosed');
  old.emit('error', errno('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:25565'));
  t.is(s.connection.getState(), 'connecting');
  t.is(s.connection.getBot(), current as unknown as mineflayer.Bot);

  current.emit('spawn');
  old.emit('end', 'socketClosed');
  t.is(s.connection.getState(), 'connected');
  t.is(s.connection.getBot(), current as unknown as mineflayer.Bot);
  t.true(s.callbacks.onBotEnd.notCalled);
  await s.clock.tickAsync(CALL_WAIT_MS);
});

test.serial('E-021 an instance replaced by a reconnect is let go with bot.end("Reconnecting..."), and its late end is ignored', async (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  s.connection.connect();
  const old = s.bots[0];
  old.emit('spawn');
  old.quit = sinon.stub();
  old.emit('kicked', '{"text":"Kicked by an operator"}', true);
  t.is(s.connection.getState(), 'disconnected');

  void s.connection.checkConnectionAndReconnect();
  await s.clock.tickAsync(RECONNECT_DELAY_MS);
  t.true(old.end.calledOnceWith('Reconnecting...'));
  old.emit('end', 'socketClosed');
  t.is(s.connection.getState(), 'connecting');
  t.is(s.connection.getBot(), s.bots[1] as unknown as mineflayer.Bot);
  t.true(s.callbacks.onBotEnd.notCalled);
  await s.clock.tickAsync(CALL_WAIT_MS);
});

test.serial('E-021 after spawn, an ECONNRESET is still handled by the end: disconnected event, onBotEnd, clean-up', async (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  s.connection.connect();
  const bot = s.bots[0];
  bot.emit('spawn');
  t.is(s.connection.getState(), 'connected');

  bot.emit('error', errno('ECONNRESET', 'read ECONNRESET'));
  t.is(s.connection.getState(), 'connected', 'after spawn the error alone changes nothing, as before');
  t.true(bot.end.notCalled);
  bot.emit('end', 'socketClosed');
  t.is(s.connection.getState(), 'disconnected');
  t.is(s.connection.getBot(), null);
  t.true(s.callbacks.onBotEnd.calledOnce);
  t.true(s.callbacks.onEvent.calledWith('disconnected'));
  t.notThrows(() => bot.emit('error', errno('ECONNRESET', 'read ECONNRESET')), 'the released instance keeps a no-op error listener');

  const result = await callWhile(t, s, () => {});
  t.true(result.message!.startsWith(CANNOT_CONNECT));
});

test.serial('E-021 createBot throws synchronously: disconnected, recorded, and the next call tries again', async (t) => {
  const bots: FakeBot[] = [];
  const createBot = sinon.stub();
  createBot.onCall(0).throws(new Error('Invalid username'));
  createBot.onCall(1).throws(new Error('Invalid username'));
  createBot.callsFake(() => newBot(bots));
  const s = setup(createBot);
  t.teardown(() => s.clock.restore());

  t.notThrows(() => s.connection.connect());
  t.is(s.connection.getState(), 'disconnected');
  t.is(s.connection.getBot(), null);
  t.like(s.connection.lastFailure(), { message: 'Invalid username', time: 0 });

  // A throw inside the reconnect must not leave isReconnecting set either.
  const first = s.connection.checkConnectionAndReconnect();
  await s.clock.tickAsync(CALL_WAIT_MS + RECONNECT_DELAY_MS);
  t.true((await first).message!.startsWith(CANNOT_CONNECT));
  t.is(createBot.callCount, 2);
  t.is(s.connection.getState(), 'disconnected');

  void s.connection.checkConnectionAndReconnect();
  await s.clock.tickAsync(RECONNECT_DELAY_MS);
  t.is(createBot.callCount, 3);
  t.is(bots.length, 1);
  t.is(s.connection.getState(), 'connecting');
  await s.clock.tickAsync(CALL_WAIT_MS);
});

test.serial('E-021 cleanup lets go of a connecting bot with bot.end("Server shutting down") and stops the watchdog', async (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  s.connection.connect();
  s.connection.cleanup();
  t.true(s.bots[0].end.calledOnceWith('Server shutting down'));
  await s.clock.tickAsync(CONNECT_TIMEOUT_MS);
  t.true(s.callbacks.onEvent.neverCalledWith('disconnected'), 'the watchdog does not fire after shutdown');
});

// ---------------------------------------------------------------------------------------------------------------
// E-028 (F-053): what went wrong, in words the user can act on, and kick reasons as plain text.
// ---------------------------------------------------------------------------------------------------------------

// Different from CONFIG, so that each of H, P and U is seen to be filled in.
const TARGET = { host: 'mc.example.test', port: 41234, username: 'Helper' };
const KEY = 'multiplayer.disconnect.';

// The texts of the F-053 table, with H, P and U filled in.
const NOTHING_LISTENING = 'Nothing is listening on mc.example.test:41234. Open the world to LAN (Esc → Open to LAN) and use the port it prints in chat as --port';
const HOST_NOT_FOUND = "The host name 'mc.example.test' was not found. Check --host (localhost for a world on this computer)";
const NO_ANSWER = 'No answer from mc.example.test:41234. Check the address, the network and the firewall';
const CLOSED_DURING_LOGIN = 'mc.example.test:41234 closed the connection during login. Check that it is a Minecraft Java server and that the port is right';
const ONLINE_MODE = 'The server checks Microsoft accounts (online mode); this bot joins with an offline account. See Accounts in the README';
const SAME_NAME = 'Another player or bot named Helper joined (maybe you, if the bot has your name). Give the bot its own --username';
const serverVersion = (version: string) => `The server runs Minecraft ${version}; this bot is verified with 26.1.2`;
// F-053: "another version" when the version cannot be read.
const ANOTHER_VERSION = 'The server runs another version of Minecraft; this bot is verified with 26.1.2';
const NOT_WHITELISTED = 'Helper is not on the whitelist: run /whitelist add Helper on the server';

const errorRows: { code: string; message: string; explanation: string; shown: string }[] = [
  { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:41234', explanation: NOTHING_LISTENING, shown: 'ECONNREFUSED' },
  { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND mc.example.test', explanation: HOST_NOT_FOUND, shown: 'ENOTFOUND' },
  { code: 'EAI_AGAIN', message: 'getaddrinfo EAI_AGAIN mc.example.test', explanation: HOST_NOT_FOUND, shown: 'EAI_AGAIN' },
  { code: 'ETIMEDOUT', message: 'connect ETIMEDOUT 10.0.0.9:41234', explanation: NO_ANSWER, shown: 'ETIMEDOUT' },
  { code: 'EHOSTUNREACH', message: 'connect EHOSTUNREACH 10.0.0.9:41234', explanation: NO_ANSWER, shown: 'EHOSTUNREACH' },
  { code: 'ENETUNREACH', message: 'connect ENETUNREACH 10.0.0.9:41234', explanation: NO_ANSWER, shown: 'ENETUNREACH' },
  // The E-021 watchdog: the parentheses show its message rather than its code.
  { code: 'SPAWN_TIMEOUT', message: 'no spawn within 30 s', explanation: NO_ANSWER, shown: 'no spawn within 30 s' },
  { code: 'ECONNRESET', message: 'read ECONNRESET', explanation: CLOSED_DURING_LOGIN, shown: 'ECONNRESET' },
  { code: 'EPIPE', message: 'write EPIPE', explanation: CLOSED_DURING_LOGIN, shown: 'EPIPE' }
];

for (const { code, message, explanation, shown } of errorRows) {
  test(`E-028 explainFailure: ${code}`, (t) => {
    t.like(explainFailure({ code, message }, TARGET), { explanation, code: shown });
  });
}

// Errors without a code: the end of a login, and the four version errors E-021 ends an attempt on.
const messageRows: { name: string; message: string; explanation: string }[] = [
  { name: "an end('socketClosed') during login", message: 'socketClosed', explanation: CLOSED_DURING_LOGIN },
  {
    name: 'Unsupported protocol version (a protocol number, not a Minecraft version)',
    message: "Unsupported protocol version '776'; try updating your packages with 'npm update'",
    explanation: ANOTHER_VERSION
  },
  { name: 'No data available for version', message: 'No data available for version 26.2', explanation: serverVersion('26.2') },
  {
    name: "Server version '…' is not supported",
    message: "Server version '26.2' is not supported. Latest supported version is '26.1.2'.",
    explanation: serverVersion('26.2')
  },
  {
    name: 'This server is version',
    message: 'This server is version 1.21.8, you are using version 26.1.2, please specify the correct version in the options.',
    explanation: serverVersion('1.21.8')
  }
];

for (const { name, message, explanation } of messageRows) {
  test(`E-028 explainFailure: ${name}`, (t) => {
    t.like(explainFailure({ message }, TARGET), { explanation, code: message });
  });
}

// Kicks as the server sends them at login: a JSON string. The parentheses show the whole translation key.
const kickRows: { key: string; args?: string[]; explanation: string }[] = [
  { key: 'unverified_username', explanation: ONLINE_MODE },
  { key: 'duplicate_login', explanation: SAME_NAME },
  { key: 'name_taken', explanation: SAME_NAME },
  { key: 'outdated_client', args: ['26.2'], explanation: serverVersion('26.2') },
  { key: 'outdated_server', args: ['1.21.8'], explanation: serverVersion('1.21.8') },
  { key: 'incompatible', args: ['26.2'], explanation: serverVersion('26.2') },
  { key: 'incompatible', explanation: ANOTHER_VERSION },
  { key: 'banned', explanation: 'Helper is banned from this server: run /pardon Helper on the server' },
  { key: 'banned.reason', args: ['Griefing'], explanation: 'Helper is banned from this server (reason: Griefing): run /pardon Helper on the server' },
  { key: 'ip_banned', explanation: 'The IP address of this computer is banned from this server: run /pardon-ip <address> on the server' },
  { key: 'not_whitelisted', explanation: NOT_WHITELISTED },
  { key: 'server_full', explanation: 'The server is full: wait for a player to leave. A world opened to LAN takes at most 8 players, the host included; on a dedicated server, raise max-players in server.properties and restart the server' },
  { key: 'kicked', explanation: 'An operator kicked the bot' }
];

for (const { key, args, explanation } of kickRows) {
  test(`E-028 explainFailure: kick ${key}${args ? ` (${args.join(', ')})` : ''}`, (t) => {
    const kickReason = JSON.stringify(args ? { translate: KEY + key, with: args } : { translate: KEY + key });
    t.like(explainFailure({ message: kickReason, kickReason }, TARGET), { explanation, code: KEY + key });
    // F-053 uses only keys checked to exist in the 26.1.2 language.json; a missing one would come back as itself.
    t.not(kickInfo(kickReason).text, KEY + key);
  });
}

const nbtString = (value: string) => ({ type: 'string', value });

/** A translatable component as network NBT, the way kick_disconnect carries it since 1.20.3. */
function nbtTranslate(key: string, args: string[] = []) {
  const value: Record<string, unknown> = { translate: nbtString(key) };
  if (args.length > 0) value.with = { type: 'list', value: { type: 'string', value: args } };
  return { type: 'compound', value };
}

test('E-028 kickInfo: a JSON string and network NBT give the same key and plain text', (t) => {
  const expected = { key: `${KEY}kicked`, text: 'Kicked by an operator' };
  t.deepEqual(kickInfo('{"translate":"multiplayer.disconnect.kicked"}'), expected);
  t.deepEqual(kickInfo(nbtTranslate(`${KEY}kicked`)), expected);
  t.deepEqual(kickInfo({ translate: `${KEY}kicked` }), expected, 'an object works too');
});

test('E-028 kickInfo: %s takes the with arguments, from JSON and from NBT', (t) => {
  const expected = { key: `${KEY}incompatible`, text: 'Incompatible client! Please use 26.2' };
  t.deepEqual(kickInfo('{"translate":"multiplayer.disconnect.incompatible","with":["26.2"]}'), expected);
  t.deepEqual(kickInfo(nbtTranslate(`${KEY}incompatible`, ['26.2'])), expected);
  // Mixed argument lists are compounds with an empty key; positional %1$s and %2$s are filled in order too.
  const mixed = {
    type: 'compound',
    value: {
      translate: nbtString('death.attack.arrow'),
      with: { type: 'list', value: { type: 'compound', value: [{ '': nbtString('Helper') }, { text: nbtString('Skeleton') }] } }
    }
  };
  t.deepEqual(kickInfo(mixed), { key: 'death.attack.arrow', text: 'Helper was shot by Skeleton' });
});

test('E-028 kickInfo: translated arguments and extra parts, on one line', (t) => {
  const reason = {
    translate: `${KEY}banned.reason`,
    with: [{ translate: `${KEY}banned.reason.default` }],
    extra: [{ translate: `${KEY}banned.expiration`, with: ['2026-11-01'] }]
  };
  t.deepEqual(kickInfo(reason), {
    key: `${KEY}banned.reason`,
    text: 'You are banned from this server. Reason: Banned by an operator. Your ban will be removed on 2026-11-01'
  });
});

test('E-028 kickInfo: without a key the text is the component\'s own text', (t) => {
  t.deepEqual(kickInfo('{"text":"Go and build ","extra":[{"text":"your own house"}]}'), { text: 'Go and build your own house' });
  t.deepEqual(kickInfo(nbtString('Server restarting')), { text: 'Server restarting' });
});

test('E-028 kickInfo: a reason that is neither JSON nor a component is String(reason) without a key', (t) => {
  t.deepEqual(kickInfo('Server restarting'), { text: 'Server restarting' });
  t.deepEqual(kickInfo('{not json'), { text: '{not json' });
  t.deepEqual(kickInfo(42), { text: '42' });
});

test('E-028 kickInfo: a key missing from language.json is its own text', (t) => {
  t.deepEqual(kickInfo({ translate: `${KEY}no_such_reason` }), { key: `${KEY}no_such_reason`, text: `${KEY}no_such_reason` });
});

test('E-028 explainFailure: an unrecognised kick keeps its key and text', (t) => {
  const result = explainFailure({ message: 'x', kickReason: nbtTranslate(`${KEY}idling`) }, TARGET);
  t.deepEqual(result, { explanation: 'You have been idle for too long!', code: `${KEY}idling` });
});

test('E-028 explainFailure: a /kick with a reason sends only that text, which stays as it is', (t) => {
  const result = explainFailure({ message: 'x', kickReason: '{"text":"Go and build your own house"}' }, TARGET);
  t.deepEqual(result, { explanation: 'Go and build your own house' });
});

test('E-028 explainFailure: an unrecognised error keeps its code and message', (t) => {
  t.deepEqual(explainFailure({ code: 'EPROTO', message: 'unexpected packet' }, TARGET), { explanation: 'unexpected packet', code: 'EPROTO' });
  t.deepEqual(explainFailure({ message: 'Invalid username' }, TARGET), { explanation: 'Invalid username' });
});

test('E-028 explainFailure: without a key, a reason that is word for word the English text of a table key is matched', (t) => {
  t.like(explainFailure({ message: 'x', kickReason: '{"text":"You are not white-listed on this server!"}' }, TARGET), { explanation: NOT_WHITELISTED });
  t.like(explainFailure({ message: 'x', kickReason: 'Incompatible client! Please use 26.2' }, TARGET), { explanation: serverVersion('26.2') });
});

// --- In BotConnection: the reply of checkConnectionAndReconnect, and the kicked event ---------------------------

const CANNOT_CONNECT_BECAUSE = `${CANNOT_CONNECT}: `;
const SETUP_LINE_START = 'For setup instructions, visit: ';

/** Starts a tool call while disconnected and says whether it has replied yet. */
async function startCall(s: Setup) {
  const call = { settled: false, reply: undefined as unknown as Promise<{ connected: boolean; message?: string }> };
  call.reply = s.connection.checkConnectionAndReconnect().then((result) => {
    call.settled = true;
    return result;
  });
  await s.clock.tickAsync(RECONNECT_DELAY_MS);
  return call;
}

test.serial('E-028 a failed attempt replies at the next poll, with the explanation, then the setup line', async (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  const call = await startCall(s);
  s.bots[0].emit('error', errno('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:25565'));
  await s.clock.tickAsync(100);
  t.true(call.settled, 'no waiting out the reconnect delay plus 5 s');

  const result = await call.reply;
  t.false(result.connected);
  const [first, ...rest] = result.message!.split('\n');
  t.is(first, `${CANNOT_CONNECT_BECAUSE}Nothing is listening on localhost:25565. Open the world to LAN (Esc → Open to LAN) and use the port it prints in chat as --port (ECONNREFUSED)`);
  t.true(rest.some(line => line.startsWith(SETUP_LINE_START)), 'the setup line follows');
  t.false(result.message!.includes('Please ensure'));
});

const replyCases: { name: string; fail: (bot: FakeBot) => void; first: string }[] = [
  {
    name: 'ENOTFOUND',
    fail: bot => {
      bot.emit('error', errno('ENOTFOUND', 'getaddrinfo ENOTFOUND localhost'));
      bot.emit('end', 'socketClosed');
    },
    first: "The host name 'localhost' was not found. Check --host (localhost for a world on this computer) (ENOTFOUND)"
  },
  {
    name: "an end('socketClosed') during login",
    fail: bot => bot.emit('end', 'socketClosed'),
    first: 'localhost:25565 closed the connection during login. Check that it is a Minecraft Java server and that the port is right (socketClosed)'
  },
  {
    name: 'a version error',
    fail: bot => bot.emit('error', new Error('No data available for version 26.2')),
    first: 'The server runs Minecraft 26.2; this bot is verified with 26.1.2 (No data available for version 26.2)'
  },
  {
    name: 'createBot throwing',
    fail: () => {},
    first: 'Invalid username'
  }
];

for (const { name, fail, first } of replyCases) {
  test.serial(`E-028 the reply after ${name} starts with "${CANNOT_CONNECT_BECAUSE}"`, async (t) => {
    const createBot = name === 'createBot throwing' ? sinon.stub().throws(new Error('Invalid username')) : undefined;
    const s = setup(createBot);
    t.teardown(() => s.clock.restore());
    const call = await startCall(s);
    if (s.bots.length > 0) fail(s.bots[0]);
    await s.clock.tickAsync(100);
    t.true(call.settled);
    t.is((await call.reply).message!.split('\n')[0], CANNOT_CONNECT_BECAUSE + first);
  });
}

test.serial('E-028 an attempt that neither joins nor fails in time still gets the checklist after the full wait', async (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  const call = await startCall(s);
  await s.clock.tickAsync(4000);
  t.false(call.settled, 'still waiting while the attempt is in progress');
  await s.clock.tickAsync(CALL_WAIT_MS);
  t.true(call.settled);
  const message = (await call.reply).message!;
  t.true(message.startsWith(`${CANNOT_CONNECT}\n`));
  t.true(message.includes('Please ensure'));
  t.is(s.connection.getState(), 'connecting', 'the attempt goes on after the reply');
});

test.serial('E-028 an error outside the E-021 list does not end the call early; the end after it does', async (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  const call = await startCall(s);
  s.bots[0].emit('error', errno('EPROTO', 'unexpected packet'));
  await s.clock.tickAsync(500);
  t.false(call.settled, 'recorded while the attempt is still connecting');
  s.bots[0].emit('end', 'socketClosed');
  await s.clock.tickAsync(100);
  t.true(call.settled);
  t.is((await call.reply).message!.split('\n')[0], `${CANNOT_CONNECT_BECAUSE}unexpected packet (EPROTO)`);
});

test.serial('E-028 a failure recorded before the call does not end the call early', async (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  s.connection.connect();
  s.bots[0].emit('error', errno('ENOTFOUND', 'getaddrinfo ENOTFOUND localhost'));
  t.is(s.connection.lastFailure()?.code, 'ENOTFOUND');

  const call = await startCall(s);
  t.is(s.bots.length, 2, 'the call starts a new attempt');
  await s.clock.tickAsync(1000);
  t.false(call.settled, 'the earlier attempt\'s failure is not this attempt\'s');
  await s.clock.tickAsync(CALL_WAIT_MS);
  t.true((await call.reply).message!.includes('Please ensure'));
});

function kickedEvents(s: Setup): string[] {
  return s.callbacks.onEvent.getCalls().filter(call => call.args[0] === 'kicked').map(call => call.args[1] as string);
}

test.serial('E-028 a kick during login: the reply explains it, and the kicked event is plain text with the explanation', async (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  const call = await startCall(s);
  const bot = s.bots[0];
  bot.quit = sinon.stub();
  // At login the reason is a JSON string.
  bot.emit('kicked', '{"translate":"multiplayer.disconnect.not_whitelisted"}', false);
  bot.emit('end', 'socketClosed');
  await s.clock.tickAsync(100);
  t.true(call.settled);
  t.is((await call.reply).message!.split('\n')[0],
    `${CANNOT_CONNECT_BECAUSE}Bot is not on the whitelist: run /whitelist add Bot on the server (multiplayer.disconnect.not_whitelisted)`);
  t.deepEqual(kickedEvents(s), ['You are not white-listed on this server!: Bot is not on the whitelist: run /whitelist add Bot on the server']);
});

test.serial('E-028 kicked by an operator after spawn: the event and log are just "Kicked by an operator", and the next call reconnects', async (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  s.connection.connect();
  const bot = s.bots[0];
  bot.emit('spawn');
  bot.quit = sinon.stub();
  // In play the reason is network NBT.
  bot.emit('kicked', nbtTranslate(`${KEY}kicked`), true);
  t.deepEqual(kickedEvents(s), ['Kicked by an operator']);
  t.true(s.callbacks.onLog.calledWith('error', 'Bot was kicked from server: Kicked by an operator'));
  bot.emit('end', 'socketClosed');

  await startCall(s);
  t.is(s.bots.length, 2, 'being kicked does not stop the next call from reconnecting');
  await s.clock.tickAsync(CALL_WAIT_MS);
});

const kickedEventCases: { name: string; reason: unknown; event: string }[] = [
  {
    name: 'another login with the same name',
    reason: nbtTranslate(`${KEY}duplicate_login`),
    event: 'You logged in from another location: Another player or bot named Bot joined (maybe you, if the bot has your name). Give the bot its own --username'
  },
  {
    name: 'a version mismatch',
    reason: nbtTranslate(`${KEY}incompatible`, ['26.2']),
    event: 'Incompatible client! Please use 26.2: The server runs Minecraft 26.2; this bot is verified with 26.1.2'
  },
  {
    name: 'online mode',
    reason: nbtTranslate(`${KEY}unverified_username`),
    event: 'Failed to verify username!: The server checks Microsoft accounts (online mode); this bot joins with an offline account. See Accounts in the README'
  },
  { name: 'a ban', reason: nbtTranslate(`${KEY}banned`), event: 'You are banned from this server: Bot is banned from this server: run /pardon Bot on the server' },
  {
    name: 'an IP ban',
    reason: nbtTranslate(`${KEY}ip_banned`),
    event: 'You have been IP banned from this server: The IP address of this computer is banned from this server: run /pardon-ip <address> on the server'
  },
  // Not among the reasons E-028 explains in the event: the text says enough, or nothing is known beyond it.
  { name: 'a full server', reason: nbtTranslate(`${KEY}server_full`), event: 'The server is full!' },
  { name: 'a /kick with a reason', reason: { type: 'compound', value: { text: nbtString('Go and build your own house') } }, event: 'Go and build your own house' },
  { name: 'an unrecognised key', reason: nbtTranslate(`${KEY}idling`), event: 'You have been idle for too long!' }
];

for (const { name, reason, event } of kickedEventCases) {
  test.serial(`E-028 kicked event after spawn, ${name}`, (t) => {
    const s = setup();
    t.teardown(() => s.clock.restore());
    s.connection.connect();
    const bot = s.bots[0];
    bot.emit('spawn');
    bot.quit = sinon.stub();
    bot.emit('kicked', reason, true);
    t.deepEqual(kickedEvents(s), [event]);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// E-029: each instance has an end signal, whenEnded(bot), so a body command whose goto or dig lost its listeners
// returns when the bot leaves. It resolves in the end handler after onBotEnd, in failAttempt, when a reconnect
// replaces the instance and at cleanup; a kick gives kickInfo's plain text, anything else the end's reason.
// ---------------------------------------------------------------------------------------------------------------

/** Whether a promise has settled yet, and with what. */
function watch<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T } = { settled: false };
  void promise.then(value => {
    state.settled = true;
    state.value = value;
  });
  return state;
}

const asBot = (bot: FakeBot) => bot as unknown as mineflayer.Bot;

test.serial('E-029 whenEnded: an end after spawn resolves it with the end\'s reason as plain text, after onBotEnd', async (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  s.connection.connect();
  const bot = s.bots[0];
  bot.emit('spawn');
  const ended = watch(s.connection.whenEnded(asBot(bot)));
  const seenThen: { unbound?: boolean; state?: string; bot?: unknown } = {};
  void s.connection.whenEnded(asBot(bot)).then(() => {
    seenThen.unbound = s.callbacks.onBotEnd.calledOnce;
    seenThen.state = s.connection.getState();
    seenThen.bot = s.connection.getBot();
  });
  await s.clock.tickAsync(CONNECT_TIMEOUT_MS * 2);
  t.false(ended.settled, 'not while the bot is in the game');

  // The release calls bot.end and then resolves the signal, so bot.end not yet called at the unbind means the order.
  let releasedAtUnbind: boolean | undefined;
  s.callbacks.onBotEnd.callsFake(() => { releasedAtUnbind = bot.end.called; });
  bot.emit('end', 'socketClosed');
  await s.clock.tickAsync(0);
  t.true(ended.settled);
  t.is(ended.value, 'socketClosed', 'the reason itself, not JSON text');
  t.false(releasedAtUnbind, 'the instance is let go, and its end signal resolved, only after onBotEnd');
  t.deepEqual(seenThen, { unbound: true, state: 'disconnected', bot: null }, 'a caller that resumes finds the Autopilot unbound and no bot');
});

const kickEnds: { name: string; reason: unknown; text: string }[] = [
  { name: 'by an operator (network NBT)', reason: nbtTranslate(`${KEY}kicked`), text: 'Kicked by an operator' },
  // The plain text only: the event adds E-028's explanation, the end signal does not.
  { name: 'by another login with the same name', reason: nbtTranslate(`${KEY}duplicate_login`), text: 'You logged in from another location' },
  { name: 'with a reason of its own (JSON text)', reason: '{"text":"Go and build your own house"}', text: 'Go and build your own house' }
];

for (const { name, reason, text } of kickEnds) {
  test.serial(`E-029 whenEnded: kicked ${name}, the end after the kick resolves it with the kick's plain text`, async (t) => {
    const s = setup();
    t.teardown(() => s.clock.restore());
    s.connection.connect();
    const bot = s.bots[0];
    bot.emit('spawn');
    bot.quit = sinon.stub();
    const ended = watch(s.connection.whenEnded(asBot(bot)));
    bot.emit('kicked', reason, true);
    await s.clock.tickAsync(0);
    t.false(ended.settled, 'it resolves when the instance is let go, at the end');

    bot.emit('end', 'socketClosed');
    await s.clock.tickAsync(0);
    t.is(ended.value, text);
  });
}

// The contract gives the value only when there is an end or a kick; an attempt that fails without either (ENOTFOUND,
// the watchdog) only has to resolve with some reason.
const failedAttemptEnds: { name: string; fail: (bot: FakeBot) => void; reason?: string; waitMs?: number }[] = [
  { name: "an end('socketClosed') during login", fail: bot => bot.emit('end', 'socketClosed'), reason: 'socketClosed' },
  {
    name: 'an ENOTFOUND error',
    fail: bot => bot.emit('error', errno('ENOTFOUND', 'getaddrinfo ENOTFOUND nonexistent.invalid'))
  },
  {
    name: 'a kick during login',
    fail: bot => {
      bot.quit = sinon.stub();
      bot.emit('kicked', '{"translate":"multiplayer.disconnect.not_whitelisted"}', false);
      bot.emit('end', 'socketClosed');
    },
    reason: 'You are not white-listed on this server!'
  },
  { name: 'the watchdog', fail: () => {}, waitMs: CONNECT_TIMEOUT_MS }
];

for (const { name, fail, reason, waitMs = 0 } of failedAttemptEnds) {
  test.serial(`E-029 whenEnded: an attempt that fails before spawn (${name}) resolves it`, async (t) => {
    const s = setup();
    t.teardown(() => s.clock.restore());
    s.connection.connect();
    const bot = s.bots[0];
    const ended = watch(s.connection.whenEnded(asBot(bot)));
    fail(bot);
    await s.clock.tickAsync(waitMs);
    t.is(s.connection.getState(), 'disconnected');
    t.true(ended.settled);
    if (reason === undefined) t.true(typeof ended.value === 'string' && ended.value.length > 0, 'some reason');
    else t.is(ended.value, reason);
  });
}

test.serial('E-029 whenEnded: a reconnect that replaces the instance resolves it with "replaced by a new connection"; the new one stays pending', async (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  s.connection.connect();
  const old = s.bots[0];
  old.emit('spawn');
  // After spawn ECONNREFUSED sets disconnected without an end, so the instance is still held when a call reconnects.
  old.emit('error', errno('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:25565'));
  t.is(s.connection.getState(), 'disconnected');
  const ended = watch(s.connection.whenEnded(asBot(old)));

  void s.connection.checkConnectionAndReconnect();
  await s.clock.tickAsync(RECONNECT_DELAY_MS);
  t.true(old.end.calledOnceWith('Reconnecting...'), 'bot.end gets the same reason as before');
  t.is(ended.value, 'replaced by a new connection');
  const newer = watch(s.connection.whenEnded(asBot(s.bots[1])));

  // The old instance's late end changes neither signal.
  old.emit('end', 'socketClosed');
  await s.clock.tickAsync(0);
  t.is(ended.value, 'replaced by a new connection');
  t.false(newer.settled);
  await s.clock.tickAsync(CALL_WAIT_MS);
});

test.serial('E-029 whenEnded: a kicked instance that a reconnect replaces before its end still gives the kick text', async (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  s.connection.connect();
  const old = s.bots[0];
  old.emit('spawn');
  old.quit = sinon.stub();
  old.emit('kicked', nbtTranslate(`${KEY}kicked`), true);
  const ended = watch(s.connection.whenEnded(asBot(old)));

  void s.connection.checkConnectionAndReconnect();
  await s.clock.tickAsync(RECONNECT_DELAY_MS);
  t.is(ended.value, 'Kicked by an operator');
  await s.clock.tickAsync(CALL_WAIT_MS);
});

test.serial('E-029 whenEnded: cleanup resolves it with "the MCP server is shutting down"', async (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  s.connection.connect();
  const bot = s.bots[0];
  bot.emit('spawn');
  const ended = watch(s.connection.whenEnded(asBot(bot)));
  s.connection.cleanup();
  await s.clock.tickAsync(0);
  t.true(bot.end.calledOnceWith('Server shutting down'), 'bot.end gets the same reason as before');
  t.is(ended.value, 'the MCP server is shutting down');
});

test.serial('E-029 a body command returns as soon as the kicked bot leaves, with the kick text; also without the Autopilot', async (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  s.connection.connect();
  const bot = s.bots[0];
  bot.emit('spawn');
  bot.quit = sinon.stub();
  const server = { tool: sinon.stub() };
  // No setAutopilot: the command runs without an arbiter, as when the Autopilot is not bound.
  const factory = new ToolFactory(server as unknown as McpServer, s.connection);
  // Like a goto or a dig whose listeners went with the bot, it never settles; body: true, as the trade tools register.
  factory.registerTool('stuck-command', 'Never ends', {}, () => new Promise(() => {}), { body: true });
  const handler = server.tool.firstCall.args[3] as (args: unknown) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;

  const reply = watch(handler({}));
  await s.clock.tickAsync(1000);
  t.false(reply.settled);

  bot.emit('kicked', nbtTranslate(`${KEY}kicked`), true);
  bot.emit('end', 'socketClosed');
  await s.clock.tickAsync(100);
  t.true(reply.settled, 'within 100 ms of the end');
  t.deepEqual(reply.value, {
    content: [{ type: 'text', text: 'Failed: The bot left the game during stuck-command (Kicked by an operator); the command was stopped. The next tool call reconnects' }],
    isError: true
  });
  t.is(factory.inFlight().length, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// E-030: after joining, the server's version from its ping response. Not 26.1.2: a warning on stderr, a connection
// event and the same sentence at the end of the first tool reply after the join. 26.1.2: only the connection event.
// The bot stays in the game either way.
// ---------------------------------------------------------------------------------------------------------------

type AutoVersionHook = (response: unknown, client: unknown, options: unknown) => void;
type PingVersion = { name?: string; protocol?: number };
type Reply = { content: { type: string; text: string }[]; isError?: boolean };
type Handler = (args: unknown, extra?: { signal?: AbortSignal }) => Promise<Reply>;

// G3's first example, so the matching case can be checked word for word.
const G3_CONFIG = { host: '127.0.0.1', port: 25565, username: 'LLMBot' };
const MATCH = 'Joined localhost:25565 as Bot (Minecraft 26.1.2)';
const WARN_26_1 = 'Joined localhost:25565 as Bot; the server runs Minecraft 26.1 (protocol 775); this bot is verified only with 26.1.2, so some tools may misbehave';
const WARN_1_21_11 = 'Joined localhost:25565 as Bot; the server runs Minecraft 1.21.11 (protocol 774); this bot is verified only with 26.1.2, so some tools may misbehave';

function versionHooks(bot: FakeBot): AutoVersionHook[] {
  return (bot._client as unknown as { autoVersionHooks?: AutoVersionHook[] }).autoVersionHooks ?? [];
}

/** What minecraft-protocol's autoVersion does with the ping response: it calls every hook, then lets the login go on. */
function answerPing(bot: FakeBot, version: PingVersion | undefined) {
  const response = { version, players: { max: 8, online: 1 }, description: { text: 'A Minecraft Server' } };
  for (const hook of versionHooks(bot)) hook(response, bot._client, { host: 'localhost', port: 25565 });
}

/** The first connect: the ping is answered, then the bot spawns. */
function join(s: Setup, version: PingVersion | undefined): FakeBot {
  s.connection.connect();
  const bot = s.bots[s.bots.length - 1];
  answerPing(bot, version);
  bot.emit('spawn');
  return bot;
}

function connectionEvents(s: Setup): string[] {
  return s.callbacks.onEvent.getCalls().filter(call => call.args[0] === 'connection').map(call => call.args[1] as string);
}

function warnings(s: Setup): string[] {
  return s.callbacks.onLog.getCalls().filter(call => call.args[0] === 'warn').map(call => call.args[1] as string);
}

/** A factory on the real connection with one tool that succeeds and one that fails. */
function tools(s: Setup) {
  const server = { tool: sinon.stub() };
  const factory = new ToolFactory(server as unknown as McpServer, s.connection);
  factory.registerTool('get-thing', 'Succeeds', {}, async () => factory.createResponse('thing'));
  factory.registerTool('break-thing', 'Fails', {}, async () => { throw new Error('boom'); });
  const handler = (name: string) => server.tool.getCalls().find(call => call.args[0] === name)!.args[3] as Handler;
  return { ok: handler('get-thing'), fail: handler('break-thing') };
}

const text = (value: string) => ({ type: 'text', text: value });

test.serial('E-030 the hook: connect() adds it to a _client that has no autoVersionHooks array, and it records the name and protocol', (t) => {
  const bots: FakeBot[] = [];
  const createBot = sinon.stub().callsFake(() => {
    const bot = newBot(bots);
    // minecraft-protocol does not create the array; a plain push would throw.
    t.false('autoVersionHooks' in bot._client);
    return bot;
  });
  const s = setup(createBot);
  t.teardown(() => s.clock.restore());
  t.notThrows(() => s.connection.connect());
  // With its own createBot, setup does not collect the bots.
  const bot = bots[0];
  t.true(Array.isArray(versionHooks(bot)));
  t.is(versionHooks(bot).length, 1);
  t.is(s.connection.getServerVersion(), null, 'nothing before the ping is answered');

  answerPing(bot, { name: 'Paper 26.1.2', protocol: 775 });
  t.deepEqual(s.connection.getServerVersion(), { name: 'Paper 26.1.2', protocol: 775, version: '26.1.2' });
  t.is(s.connection.getState(), 'connecting', 'recording the version does not change the attempt');
});

test.serial('E-030 the hook: an autoVersionHooks array that is already there keeps its hooks', (t) => {
  const bots: FakeBot[] = [];
  const forgeHook = sinon.stub();
  const createBot = sinon.stub().callsFake(() => {
    const bot = newBot(bots);
    (bot._client as unknown as { autoVersionHooks: AutoVersionHook[] }).autoVersionHooks = [forgeHook];
    return bot;
  });
  const s = setup(createBot);
  t.teardown(() => s.clock.restore());
  s.connection.connect();
  const hooks = versionHooks(bots[0]);
  t.is(hooks.length, 2);
  t.is(hooks[0], forgeHook);
  answerPing(bots[0], { name: '26.1.2', protocol: 775 });
  t.true(forgeHook.calledOnce);
  t.is(s.connection.getServerVersion()?.name, '26.1.2');
});

test.serial('E-030 the hook: a ping response without a version neither throws nor records anything', (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  s.connection.connect();
  const [hook] = versionHooks(s.bots[0]);
  t.notThrows(() => hook({ players: { max: 8, online: 0 } }, s.bots[0]._client, {}));
  t.notThrows(() => hook(undefined, s.bots[0]._client, {}));
  t.is(s.connection.getServerVersion(), null);
});

test.serial('E-030 the hook: each attempt starts without a version, and a late ping of an instance let go is ignored', async (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  s.connection.connect();
  const old = s.bots[0];
  answerPing(old, { name: '26.1', protocol: 775 });
  old.emit('error', errno('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:25565'));

  void s.connection.checkConnectionAndReconnect();
  await s.clock.tickAsync(RECONNECT_DELAY_MS);
  t.is(s.connection.getServerVersion(), null, 'the earlier attempt\'s server says nothing about this one');
  answerPing(old, { name: '1.21.11', protocol: 774 });
  t.is(s.connection.getServerVersion(), null);
  answerPing(s.bots[1], { name: '26.1.2', protocol: 775 });
  t.deepEqual(s.connection.getServerVersion(), { name: '26.1.2', protocol: 775, version: '26.1.2' });
  await s.clock.tickAsync(CALL_WAIT_MS);
});

test.serial('E-030 "26.1.2" (protocol 775): no warning, only the connection event of G3', (t) => {
  const s = setup(undefined, G3_CONFIG);
  t.teardown(() => s.clock.restore());
  const bot = join(s, { name: '26.1.2', protocol: 775 });
  t.deepEqual(connectionEvents(s), ['Joined 127.0.0.1:25565 as LLMBot (Minecraft 26.1.2)']);
  t.deepEqual(warnings(s), []);
  t.is(s.connection.takeJoinNote(), null);
  t.is(s.connection.getState(), 'connected');
  t.true(s.callbacks.onBotReady.calledOnceWith(asBot(bot)), 'the setup after spawn still runs');
});

test.serial('E-030 "Paper 26.1.2" (protocol 775): the version number is found in the name, and there is no warning', (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  join(s, { name: 'Paper 26.1.2', protocol: 775 });
  t.is(s.connection.getServerVersion()?.version, '26.1.2');
  t.deepEqual(connectionEvents(s), [MATCH]);
  t.deepEqual(warnings(s), []);
  t.is(s.connection.takeJoinNote(), null);
});

const otherVersions: { name: string; ping: PingVersion; warning: string }[] = [
  // Same protocol, so bot.version is "26.1" for 26.1.2 too: only the name tells them apart.
  { name: '"26.1" (protocol 775)', ping: { name: '26.1', protocol: 775 }, warning: WARN_26_1 },
  { name: '"1.21.11" (protocol 774)', ping: { name: '1.21.11', protocol: 774 }, warning: WARN_1_21_11 }
];

for (const { name, ping, warning } of otherVersions) {
  test.serial(`E-030 ${name}: the same warning on stderr, in the connection event and for the first reply; the bot stays in`, (t) => {
    const s = setup();
    t.teardown(() => s.clock.restore());
    const bot = join(s, ping);
    t.deepEqual(warnings(s), [warning]);
    t.deepEqual(connectionEvents(s), [warning]);
    t.is(s.connection.getState(), 'connected', 'the connection is not refused');
    t.is(s.connection.getBot(), asBot(bot));
    t.true(bot.end.notCalled);
    t.true(s.callbacks.onBotReady.calledOnceWith(asBot(bot)), 'the setup after spawn still runs');
    t.is(s.connection.takeJoinNote(), warning);
    t.is(s.connection.takeJoinNote(), null, 'once per join');
  });
}

test.serial('E-030 H, P and U are the configured host, port and username', (t) => {
  const s = setup(undefined, TARGET);
  t.teardown(() => s.clock.restore());
  join(s, { name: '26.1', protocol: 775 });
  t.deepEqual(connectionEvents(s), [
    'Joined mc.example.test:41234 as Helper; the server runs Minecraft 26.1 (protocol 775); this bot is verified only with 26.1.2, so some tools may misbehave'
  ]);
});

test.serial('E-030 without a name only the protocol counts: 775 does not warn', (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  join(s, { protocol: 775 });
  t.deepEqual(s.connection.getServerVersion(), { name: null, protocol: 775, version: null });
  t.deepEqual(connectionEvents(s), [MATCH]);
  t.deepEqual(warnings(s), []);
  t.is(s.connection.takeJoinNote(), null);
});

test.serial('E-030 without a name only the protocol counts: 774 warns', (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  join(s, { protocol: 774 });
  const [warning] = warnings(s);
  // The contract does not say which version V is without a name, only that it is one.
  t.regex(warning, /^Joined localhost:25565 as Bot; the server runs Minecraft \d+\.\d+(\.\d+)? \(protocol 774\); this bot is verified only with 26\.1\.2, so some tools may misbehave$/);
  t.deepEqual(connectionEvents(s), [warning]);
  t.is(s.connection.takeJoinNote(), warning);
  t.is(s.connection.getState(), 'connected');
});

test.serial('E-030 a name without a version number counts as no name: only the protocol is judged', (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  join(s, { name: 'Velocity', protocol: 775 });
  t.deepEqual(s.connection.getServerVersion(), { name: 'Velocity', protocol: 775, version: null });
  t.deepEqual(connectionEvents(s), [MATCH]);
  t.deepEqual(warnings(s), []);
});

test.serial('E-030 a bot that spawns without a ping answer (a stand-in) gets no judgment: no event, no warning, no note', (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  join(s, undefined);
  t.deepEqual(connectionEvents(s), []);
  t.deepEqual(warnings(s), []);
  t.is(s.connection.takeJoinNote(), null);
});

test.serial('E-030 a respawn after a death is not a join: no second connection event', (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  const bot = join(s, { name: '26.1', protocol: 775 });
  bot.emit('death');
  bot.emit('spawn');
  t.deepEqual(connectionEvents(s), [WARN_26_1]);
  t.deepEqual(warnings(s), [WARN_26_1]);
});

test.serial('E-030 the warning ends only the first reply after the join, then again the first after joining again; errors too', async (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  const { ok, fail } = tools(s);
  const bot = join(s, { name: '26.1', protocol: 775 });

  t.deepEqual(await ok({}), { content: [text('thing'), text(WARN_26_1)] }, 'the reply itself first, the warning after it');
  t.deepEqual(await ok({}), { content: [text('thing')] });
  t.deepEqual(await fail({}), { content: [text('Failed: boom')], isError: true });

  // The bot leaves; the next call joins again, and its reply is the first after that join.
  bot.emit('end', 'socketClosed');
  t.is(s.connection.getState(), 'disconnected');
  const reply = watch(fail({}));
  await s.clock.tickAsync(RECONNECT_DELAY_MS);
  t.is(s.bots.length, 2);
  answerPing(s.bots[1], { name: '26.1', protocol: 775 });
  s.bots[1].emit('spawn');
  await s.clock.tickAsync(100);
  t.true(reply.settled);
  t.deepEqual(reply.value, { content: [text('Failed: boom'), text(WARN_26_1)], isError: true }, 'an error reply gets it too');
  t.deepEqual(await ok({}), { content: [text('thing')] });
  t.deepEqual(connectionEvents(s), [WARN_26_1, WARN_26_1], 'one connection event per join');
});

test.serial('E-030 with 26.1.2 no reply changes', async (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  const { ok, fail } = tools(s);
  join(s, { name: '26.1.2', protocol: 775 });
  t.deepEqual(await ok({}), { content: [text('thing')] });
  t.deepEqual(await fail({}), { content: [text('Failed: boom')], isError: true });
});

test.serial('E-030 the note of a join that is over does not end a later "Cannot connect" reply', async (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  const { ok } = tools(s);
  const bot = join(s, { name: '26.1', protocol: 775 });
  // No reply took the note before the bot left; the next call's attempt fails.
  bot.emit('end', 'socketClosed');
  const reply = watch(ok({}));
  await s.clock.tickAsync(RECONNECT_DELAY_MS);
  s.bots[1].emit('error', errno('ECONNREFUSED', 'connect ECONNREFUSED 127.0.0.1:25565'));
  await s.clock.tickAsync(100);
  t.true(reply.settled);
  t.is(reply.value!.content.length, 1);
  t.true(reply.value!.content[0].text.startsWith(CANNOT_CONNECT));
  t.false(reply.value!.content[0].text.includes('verified only with'));
});

test.serial('E-030 a reply the MCP client cancelled, which the SDK drops, leaves the warning for the next reply', async (t) => {
  const s = setup();
  t.teardown(() => s.clock.restore());
  const { ok } = tools(s);
  join(s, { name: '26.1', protocol: 775 });
  const cancelled = new AbortController();
  cancelled.abort();
  t.deepEqual(await ok({}, { signal: cancelled.signal }), { content: [text('thing')] });
  t.deepEqual(await ok({}), { content: [text('thing'), text(WARN_26_1)] });
});

test('E-030 a connection stand-in without takeJoinNote leaves the results as they were', async (t) => {
  const { factory, getTool } = createFactory();
  factory.registerTool('get-thing', 'Succeeds', {}, async () => factory.createResponse('thing'));
  factory.registerTool('break-thing', 'Fails', {}, async () => { throw new Error('boom'); });
  t.deepEqual(await getTool('get-thing')!.execute({}), { content: [text('thing')] });
  t.deepEqual(await getTool('break-thing')!.execute({}), { content: [text('Failed: boom')], isError: true });
});
