// M19 connection changes (BLUEPRINT F-047). Each case names the clause of its E row; the expected values come from
// the contract, not from what the code happens to print.
import test, { ExecutionContext } from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import type mineflayer from 'mineflayer';
import { BotConnection, CONNECT_TIMEOUT_MS } from '../src/bot-connection.js';

// ---------------------------------------------------------------------------------------------------------------
// E-021: an attempt that fails before spawning ends in disconnected, so the next tool call connects again.
// ---------------------------------------------------------------------------------------------------------------

const CONFIG = { host: 'localhost', port: 25565, username: 'Bot' };
const RECONNECT_DELAY_MS = 10;
// checkConnectionAndReconnect polls every 100 ms for the reconnect delay plus 5 s before it gives up (unchanged
// until E-028), so it replies at the first poll after that.
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

function setup(createBot?: sinon.SinonStub) {
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
  const connection = new BotConnection(CONFIG, callbacks, RECONNECT_DELAY_MS, { createBot: create as unknown as (options: mineflayer.BotOptions) => mineflayer.Bot });
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
