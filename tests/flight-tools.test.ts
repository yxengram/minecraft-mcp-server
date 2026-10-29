import test from 'ava';
import sinon from 'sinon';
import { registerFlightTools } from '../src/tools/flight-tools.js';
import { ToolFactory, type ToolContext } from '../src/tool-factory.js';
import { BotConnection } from '../src/bot-connection.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { asBot, createFactory } from './_helpers.js';

test('registerFlightTools registers fly-to tool', (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockBot = {} as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerFlightTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const flyToCall = toolCalls.find(call => call.args[0] === 'fly-to');

  t.truthy(flyToCall);
  t.is(flyToCall!.args[1], 'Fly in a straight line to a position. Creative or spectator mode only; the line must be clear of blocks');
});

test('fly-to successfully flies to destination', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const flyToStub = sinon.stub().callsFake(async (destination: Vec3) => {
    mockBot.entity.position = destination.clone();
  });
  const stopFlyingStub = sinon.stub();
  const mockBot = {
    game: { gameMode: 'creative' },
    creative: {
      flyTo: flyToStub,
      stopFlying: stopFlyingStub
    },
    entity: {
      position: new Vec3(0, 64, 0)
    }
  } as unknown as mineflayer.Bot;
  const getBot = () => mockBot;

  registerFlightTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const flyToCall = toolCalls.find(call => call.args[0] === 'fly-to');
  const executor = flyToCall!.args[3];

  const result = await executor({ x: 100, y: 80, z: 200 });

  t.true(flyToStub.calledOnce);
  t.true(stopFlyingStub.calledOnce);
  t.true(result.content[0].text.includes('Successfully flew'));
  t.true(result.content[0].text.includes('100'));
});

test('fly-to refuses in survival mode without flying', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const flyToStub = sinon.stub().resolves();
  const stopFlyingStub = sinon.stub();
  const mockBot = {
    game: { gameMode: 'survival' },
    creative: {
      flyTo: flyToStub,
      stopFlying: stopFlyingStub
    },
    entity: {
      position: new Vec3(0, 64, 0)
    }
  } as unknown as mineflayer.Bot;
  const getBot = () => mockBot;

  registerFlightTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const flyToCall = toolCalls.find(call => call.args[0] === 'fly-to');
  const executor = flyToCall!.args[3];

  const result = await executor({ x: 100, y: 80, z: 200 });

  t.true(result.isError);
  t.is(result.content[0].text,
    'Failed: fly-to needs creative or spectator mode; the bot is in survival mode. Walk with move-to-position instead');
  t.true(flyToStub.notCalled);
  // stopFlying restores the gravity a flight saved; without a flight it has nothing to restore.
  t.true(stopFlyingStub.notCalled);
});

test('fly-to handles flight errors', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const flyToStub = sinon.stub().rejects(new Error('Cannot reach destination'));
  const stopFlyingStub = sinon.stub();
  const mockBot = {
    game: { gameMode: 'creative' },
    creative: {
      flyTo: flyToStub,
      stopFlying: stopFlyingStub
    },
    entity: {
      position: new Vec3(0, 64, 0)
    }
  } as unknown as mineflayer.Bot;
  const getBot = () => mockBot;

  registerFlightTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const flyToCall = toolCalls.find(call => call.args[0] === 'fly-to');
  const executor = flyToCall!.args[3];

  const result = await executor({ x: 100, y: 80, z: 200 });

  t.true(result.isError);
  t.true(result.content[0].text.includes('Cannot reach destination'));
  t.true(stopFlyingStub.calledOnce);
});

type FlightBot = { game: { gameMode: string }; entity: { position: Vec3 } };
type Execute = (args: Record<string, unknown>, extra?: { signal: AbortSignal }) => Promise<{ content: { text: string }[]; isError?: boolean }>;
type Executor = (args: Record<string, unknown>, ctx: ToolContext) => Promise<{ content: { text: string }[]; isError?: boolean }>;

/**
 * A bot at (0, 64, 0) in `gameMode` whose flyTo runs `fly`; by default it ends at the destination, as mineflayer's
 * flyTo does when the server accepts the move: its last step makes the given Vec3 itself the bot's position.
 * `execute` goes through the tool factory, `executor` is the tool's own function.
 */
function flight(gameMode: string, fly: (bot: FlightBot, destination: Vec3) => Promise<void> = async (bot, destination) => {
  bot.entity.position = destination;
}) {
  const { factory, getTool } = createFactory();
  const register = sinon.spy(factory, 'registerTool');
  const flyTo = sinon.stub();
  const stopFlying = sinon.stub();
  const bot = { game: { gameMode }, entity: { position: new Vec3(0, 64, 0) }, creative: { flyTo, stopFlying } };
  flyTo.callsFake((destination: Vec3) => fly(bot, destination));
  registerFlightTools(factory, asBot(bot));
  return {
    bot, flyTo, stopFlying,
    execute: getTool('fly-to')!.execute as Execute,
    executor: register.firstCall.args[3] as Executor
  };
}

test('E-032: fly-to refuses in adventure mode without flying', async (t) => {
  const { flyTo, stopFlying, execute } = flight('adventure');

  const result = await execute({ x: 100, y: 80, z: 200 });

  t.true(result.isError);
  t.is(result.content[0].text,
    'Failed: fly-to needs creative or spectator mode; the bot is in adventure mode. Walk with move-to-position instead');
  t.true(flyTo.notCalled);
  t.true(stopFlying.notCalled);
});

for (const mode of ['creative', 'spectator']) {
  test(`E-032: fly-to flies in ${mode} mode`, async (t) => {
    const { bot, flyTo, stopFlying, execute } = flight(mode);

    const result = await execute({ x: 100, y: 80, z: 200 });

    t.falsy(result.isError);
    t.is(result.content[0].text, 'Successfully flew to position (100, 80, 200).');
    t.true(flyTo.calledOnce);
    t.true(flyTo.firstCall.args[0].equals(new Vec3(100, 80, 200)));
    t.true(bot.entity.position.equals(new Vec3(100, 80, 200)));
    t.true(stopFlying.calledOnce);
  });
}

test('E-032: a flight the server pulls back is an error that says where the bot ended up', async (t) => {
  let stoppedBeforePullBack = null as boolean | null;
  const { flyTo, stopFlying, execute } = flight('creative', async (bot, destination) => {
    bot.entity.position = destination;
    // The server's correction arrives after flyTo has put the bot at the target, within the 300 ms wait. mineflayer's
    // position handler changes the position object in place, here the very Vec3 flyTo was given.
    setTimeout(() => {
      stoppedBeforePullBack = stopFlying.called;
      bot.entity.position.set(0.5, 64, 0.5);
    }, 50);
  });

  const result = await execute({ x: 100, y: 80, z: 200 });

  t.true(flyTo.calledOnce);
  t.true(result.isError);
  const text = result.content[0].text;
  t.true(text.startsWith('Failed: Flight ended at (0, 64, 0), '), text);
  t.regex(text, /, \d+(\.\d+)? blocks from \(100, 80, 200\): the server did not accept the move \(blocked path\?\)$/);
  t.false(text.includes('Successfully'));
  t.is(stoppedBeforePullBack, false, 'the bot was still without gravity when the server pulled it back');
  t.true(stopFlying.calledOnce);
});

test('E-032: a flight that ends within 1.5 blocks of the target is a success, beyond that an error', async (t) => {
  const near = flight('creative', async (bot, destination) => {
    bot.entity.position = destination.offset(0, -1, 0);
  });
  const nearResult = await near.execute({ x: 10, y: 70, z: 10 });
  t.falsy(nearResult.isError);
  t.is(nearResult.content[0].text, 'Successfully flew to position (10, 70, 10).');
  t.true(near.stopFlying.calledOnce);

  // Exactly 1.5 blocks is not beyond the tolerance (70 - 1.5 is exact in floating point).
  const edge = flight('creative', async (bot, destination) => {
    bot.entity.position = destination.offset(0, -1.5, 0);
  });
  const edgeResult = await edge.execute({ x: 10, y: 70, z: 10 });
  t.falsy(edgeResult.isError);
  t.is(edgeResult.content[0].text, 'Successfully flew to position (10, 70, 10).');
  t.true(edge.stopFlying.calledOnce);

  const far = flight('creative', async (bot, destination) => {
    bot.entity.position = destination.offset(0, -2, 0);
  });
  const farResult = await far.execute({ x: 10, y: 70, z: 10 });
  t.true(farResult.isError);
  t.true(farResult.content[0].text.includes('Flight ended at (10, 68, 10), 2.0 blocks from (10, 70, 10)'), farResult.content[0].text);
  t.true(far.stopFlying.calledOnce);
});

test('E-032 (4): a cancelled call ends the flight and stops flying', async (t) => {
  const { flyTo, stopFlying, execute } = flight('creative', () => new Promise(() => {}));
  const client = new AbortController();

  const pending = execute({ x: 100, y: 80, z: 200 }, { signal: client.signal });
  while (!flyTo.called) await new Promise(resolve => setImmediate(resolve));
  t.true(stopFlying.notCalled);
  client.abort();
  const result = await pending;

  t.true(result.isError);
  t.true(result.content[0].text.includes('fly-to was cancelled by the MCP client'), result.content[0].text);
  t.true(stopFlying.called);
});

test('E-032 (4): on its call\'s abort the tool stops flying and throws the AbortError, not the timeout reply', async (t) => {
  const { flyTo, stopFlying, executor } = flight('creative', () => new Promise(() => {}));
  const call = new AbortController();
  const ctx = { signal: call.signal } as ToolContext;

  const pending = executor({ x: 100, y: 80, z: 200 }, ctx);
  while (!flyTo.called) await new Promise(resolve => setImmediate(resolve));
  t.true(stopFlying.notCalled);
  call.abort();

  await t.throwsAsync(pending, { name: 'AbortError' });
  t.true(stopFlying.called);
});

test.serial('E-032: the bot stays without gravity for 300 ms after flyTo before its position is checked', async (t) => {
  const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  t.teardown(() => clock.restore());
  const { stopFlying, execute } = flight('creative');
  let settled = false;

  const pending = execute({ x: 100, y: 80, z: 200 }).finally(() => { settled = true; });
  await clock.tickAsync(299);
  t.false(settled);
  t.true(stopFlying.notCalled);
  await clock.tickAsync(1);
  const result = await pending;

  t.is(result.content[0].text, 'Successfully flew to position (100, 80, 200).');
  t.true(stopFlying.calledOnce);
});

test.serial('fly-to still times out after 20 seconds with the same text, and stops flying', async (t) => {
  const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  t.teardown(() => clock.restore());
  const { stopFlying, execute } = flight('creative', async bot => {
    bot.entity.position = new Vec3(3.7, 66.2, -4.1);
    await new Promise(() => {});
  });

  const pending = execute({ x: 100, y: 80, z: 200 });
  await clock.tickAsync(20000);
  const result = await pending;

  t.true(result.isError);
  t.is(result.content[0].text,
    'Failed: Flight timed out after 20 seconds. The destination may be unreachable. Current position: (3, 66, -5)');
  t.true(stopFlying.called);
});
