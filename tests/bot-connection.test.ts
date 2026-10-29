import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import type mineflayer from 'mineflayer';
import { BotConnection } from '../src/bot-connection.js';

test('constructor initializes with correct state', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  t.is(connection.getState(), 'disconnected');
  t.deepEqual(connection.getConfig(), config);
  t.is(connection.getBot(), null);
  t.false(connection.isConnected());
});

test('constructor accepts custom reconnect delay', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const customDelay = 5000;
  const connection = new BotConnection(config, callbacks, customDelay);

  t.is(connection.getState(), 'disconnected');
});

test('getState returns current state', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  t.is(connection.getState(), 'disconnected');
});

test('getConfig returns configuration', (t) => {
  const config = { host: 'example.com', port: 30000, username: 'MyBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  const returnedConfig = connection.getConfig();
  t.is(returnedConfig.host, 'example.com');
  t.is(returnedConfig.port, 30000);
  t.is(returnedConfig.username, 'MyBot');
});

test('getBot returns null initially', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  t.is(connection.getBot(), null);
});

test('isConnected returns false when state is disconnected', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  t.false(connection.isConnected());
});

test('formatError handles Error objects', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  const error = new Error('Test error');
  const formatted = (connection as unknown as { formatError: (error: unknown) => string }).formatError(error);

  t.is(formatted, 'Test error');
});

test('formatError handles plain objects', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  const errorObj = { code: 'ECONNREFUSED', message: 'Connection refused' };
  const formatted = (connection as unknown as { formatError: (error: unknown) => string }).formatError(errorObj);

  t.true(formatted.includes('ECONNREFUSED'));
  t.true(formatted.includes('Connection refused'));
});

test('formatError handles strings', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  const formatted = (connection as unknown as { formatError: (error: unknown) => string }).formatError('Simple error');

  t.is(formatted, '"Simple error"');
});

test('formatError handles non-serializable objects', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const formatted = (connection as unknown as { formatError: (error: unknown) => string }).formatError(circular);

  t.is(typeof formatted, 'string');
});

test('checkConnectionAndReconnect returns connected when already connected', async (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);
  
  (connection as unknown as { state: string }).state = 'connected';

  const result = await connection.checkConnectionAndReconnect();

  t.true(result.connected);
  t.is(result.message, undefined);
});

test('checkConnectionAndReconnect returns message when connecting', async (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  (connection as unknown as { state: string }).state = 'connecting';

  const result = await connection.checkConnectionAndReconnect();

  t.false(result.connected);
  t.true(result.message!.includes('connecting'));
});

test('checkConnectionAndReconnect includes setup instructions on failure', async (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks, 100);

  (connection as unknown as { state: string }).state = 'disconnected';

  // Stub attemptReconnect to prevent actual connection attempt
  const attemptReconnectStub = sinon.stub(connection as unknown as { attemptReconnect: () => void }, 'attemptReconnect').callsFake(() => {
    (connection as unknown as { state: string }).state = 'connecting';
  });

  const result = await connection.checkConnectionAndReconnect();

  t.true(attemptReconnectStub.calledOnce);
  t.false(result.connected);
  t.true(result.message!.includes('Cannot connect'));
  t.true(result.message!.includes('localhost:25565'));
  t.true(result.message!.includes('github.com'));
  // E-024: the first line stays as it was (E-028 and the smoke test rely on it); the link points to this repository.
  t.true(result.message!.startsWith('Cannot connect to Minecraft server at localhost:25565'));
  t.true(result.message!.includes('yxengram/minecraft-mcp-server'));
  t.is(result.message!.split('\n').at(-1), 'For setup instructions, visit: https://github.com/yxengram/minecraft-mcp-server#getting-started');

  attemptReconnectStub.restore();
});

test('cleanup clears reconnect timer', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  (connection as unknown as { reconnectTimer: ReturnType<typeof setTimeout> }).reconnectTimer = setTimeout(() => {}, 10000);

  t.notThrows(() => {
    connection.cleanup();
  });
});

test('cleanup does not throw when no bot exists', (t) => {
  const config = { host: 'localhost', port: 25565, username: 'TestBot' };
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub() };
  const connection = new BotConnection(config, callbacks);

  t.notThrows(() => {
    connection.cleanup();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// E-034: no public greeting when the bot joins; --greeting <text> is said once per instance (again after a reconnect,
// not on a respawn), after the door helper and before onBotReady. The bots come from E-021's injectable createBot.
// ---------------------------------------------------------------------------------------------------------------

// minecraft-data's name for the 26.1.x data; the spawn handler builds pathfinder settings from this registry.
const DATA_VERSION = '26.1';
const registry = minecraftData(DATA_VERSION);
const GREETING_RECONNECT_DELAY_MS = 10;

type FakeBot = EventEmitter & { _client: EventEmitter; end: sinon.SinonStub; chat: sinon.SinonStub; pathfinder: { setMovements: sinon.SinonStub } };

function fakeBot(): FakeBot {
  const bot = new EventEmitter() as FakeBot;
  Object.assign(bot, {
    _client: new EventEmitter(),
    end: sinon.stub(),
    registry,
    version: DATA_VERSION,
    username: 'TestBot',
    health: 20,
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5) },
    entities: {},
    pathfinder: { setMovements: sinon.stub() },
    chat: sinon.stub()
  });
  return bot;
}

function greetingSetup(greeting?: string) {
  const clock = sinon.useFakeTimers();
  const bots: FakeBot[] = [];
  const createBot = sinon.stub().callsFake(() => {
    const bot = fakeBot();
    bots.push(bot);
    return bot;
  });
  const callbacks = { onLog: sinon.stub(), onChatMessage: sinon.stub(), onEvent: sinon.stub(), onBotReady: sinon.stub(), onBotEnd: sinon.stub() };
  const config = { host: 'localhost', port: 25565, username: 'TestBot', ...(greeting === undefined ? {} : { greeting }) };
  const connection = new BotConnection(config, callbacks, GREETING_RECONNECT_DELAY_MS, {
    createBot: createBot as unknown as (options: mineflayer.BotOptions) => mineflayer.Bot
  });
  const done = () => {
    connection.cleanup();
    clock.restore();
  };
  return { clock, bots, callbacks, connection, done };
}

test.serial('E-034 without a greeting: a spawn sends no chat, and onBotReady is still called once', (t) => {
  const s = greetingSetup();
  try {
    s.connection.connect();
    const bot = s.bots[0];
    bot.emit('spawn');
    t.is(s.connection.getState(), 'connected');
    // The spawn handler is async: a throw in the setup would be swallowed, so "no chat" alone would prove nothing.
    t.true(s.callbacks.onBotReady.calledOnceWithExactly(bot), 'the setup after spawn ran to the end');
    t.true(bot.pathfinder.setMovements.calledOnce);
    t.true(bot.chat.notCalled, 'no public greeting by default');
    bot.emit('spawn');
    t.true(bot.chat.notCalled, 'nor on a respawn');
  } finally {
    s.done();
  }
});

test.serial('E-034 --greeting "hello all": said once at the first spawn, not on a respawn, and again by a new instance after a reconnect', async (t) => {
  const s = greetingSetup('hello all');
  try {
    s.connection.connect();
    const first = s.bots[0];
    // Where the old greeting was: after the pathfinder settings and the door helper, before onBotReady.
    const order: string[] = [];
    first.chat.callsFake(() => {
      order.push(`movements ${first.pathfinder.setMovements.called}`);
      order.push(`door helper ${first.listenerCount('physicsTick') > 0}`);
      order.push(`ready ${s.callbacks.onBotReady.called}`);
    });
    first.emit('spawn');
    t.true(first.chat.calledOnceWithExactly('hello all'));
    t.deepEqual(order, ['movements true', 'door helper true', 'ready false']);
    t.true(s.callbacks.onBotReady.calledOnceWithExactly(first));

    // A respawn after a death is the same instance.
    first.emit('spawn');
    t.true(first.chat.calledOnce, 'no greeting on a respawn');
    t.true(s.callbacks.onBotReady.calledOnce);

    // The connection is lost; the reconnect creates a new instance, which greets again when it spawns.
    first.emit('end', 'socketClosed');
    t.is(s.connection.getState(), 'disconnected');
    s.connection.attemptReconnect();
    await s.clock.tickAsync(GREETING_RECONNECT_DELAY_MS);
    t.is(s.bots.length, 2, 'the reconnect created a new instance');
    const second = s.bots[1];
    t.true(second.chat.notCalled, 'nothing is said before the new instance spawns');
    second.emit('spawn');
    t.true(second.chat.calledOnceWithExactly('hello all'));
    t.true(first.chat.calledOnce, 'the old instance said nothing more');
    t.is(s.callbacks.onBotReady.callCount, 2);
    t.is(s.callbacks.onBotReady.secondCall.args[0], second);
  } finally {
    s.done();
  }
});
