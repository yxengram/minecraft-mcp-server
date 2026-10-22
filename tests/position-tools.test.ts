import test from 'ava';
import { arriveAtGoal } from './_helpers.js';
import sinon from 'sinon';
import { registerPositionTools } from '../src/tools/position-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import { BotConnection } from '../src/bot-connection.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';

test('registerPositionTools registers get-position tool', (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockBot = {} as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerPositionTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const getPositionCall = toolCalls.find(call => call.args[0] === 'get-position');

  t.truthy(getPositionCall);
  t.is(getPositionCall!.args[1], 'Get the current position of the bot');
});

test('registerPositionTools registers move-to-position tool', (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockBot = {} as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerPositionTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const moveToPositionCall = toolCalls.find(call => call.args[0] === 'move-to-position');

  t.truthy(moveToPositionCall);
  t.is(moveToPositionCall!.args[1], 'Move the bot to a specific position. Reports the blocks the pathfinder dug and placed on the way. Refused while the bot is walled in on every side unless leaveShelter is true. Ending in a Nether portal waits up to 10 s for the trip to the other dimension and reports it');
});

test('get-position returns current bot position', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const mockBot = {
    entity: {
      position: new Vec3(100, 64, 200)
    }
  } as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerPositionTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const getPositionCall = toolCalls.find(call => call.args[0] === 'get-position');
  const executor = getPositionCall!.args[3];

  const result = await executor({});

  t.true(result.content[0].text.includes('100'));
  t.true(result.content[0].text.includes('64'));
  t.true(result.content[0].text.includes('200'));
});

test('move-to-position returns error when pathfinding fails', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const mockBot = {
    pathfinder: {
      goto: sinon.stub().rejects(new Error('Cannot find path')),
      stop: sinon.stub()
    },
    entity: {
      position: new Vec3(10, 20, 30)
    }
  } as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerPositionTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const moveToPositionCall = toolCalls.find(call => call.args[0] === 'move-to-position');
  const executor = moveToPositionCall!.args[3];

  const result = await executor({ x: 100, y: 64, z: 200 });

  t.true(result.isError);
  t.true(result.content[0].text.includes('Cannot find path'));
});

test.serial('move-to-position returns timeout error and stops pathfinder', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());

  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const mockBot = {
    pathfinder: {
      goto: sinon.stub().returns(new Promise(() => {})),
      stop: sinon.stub(),
      setGoal: sinon.stub()
    }
  } as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerPositionTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const moveToPositionCall = toolCalls.find(call => call.args[0] === 'move-to-position');
  const executor = moveToPositionCall!.args[3];

  const resultPromise = executor({ x: 100, y: 64, z: 200, timeoutMs: 1000 });
  await clock.tickAsync(1000);
  const result = await resultPromise;

  t.true(result.isError);
  t.true(result.content[0].text.includes('Move timed out after 1000ms'));
  t.true((mockBot.pathfinder!.stop as sinon.SinonStub).calledOnce);
});

test('move-to-position succeeds without timeout and does not stop pathfinder', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  // The pathfinder really gets the bot there; move-to-position checks the arrival (M7).
  const mockBot = {
    entity: { position: new Vec3(0, 64, 0) },
    pathfinder: {
      goto: sinon.stub().resolves(),
      stop: sinon.stub()
    }
  } as Partial<mineflayer.Bot>;
  mockBot.pathfinder!.goto = arriveAtGoal(mockBot as never) as never;
  const getBot = () => mockBot as mineflayer.Bot;

  registerPositionTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const moveToPositionCall = toolCalls.find(call => call.args[0] === 'move-to-position');
  const executor = moveToPositionCall!.args[3];

  const result = await executor({ x: 100, y: 64, z: 200 });

  t.falsy(result.isError);
  t.true(result.content[0].text.includes('Successfully moved'));
  t.true((mockBot.pathfinder!.stop as sinon.SinonStub).notCalled);
});

test.serial('move-to-position succeeds before timeout and does not stop pathfinder', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());

  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  // The pathfinder really gets the bot there; move-to-position checks the arrival (M7).
  const mockBot = {
    entity: { position: new Vec3(0, 64, 0) },
    pathfinder: {
      goto: sinon.stub().resolves(),
      stop: sinon.stub()
    }
  } as Partial<mineflayer.Bot>;
  mockBot.pathfinder!.goto = arriveAtGoal(mockBot as never) as never;
  const getBot = () => mockBot as mineflayer.Bot;

  registerPositionTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const moveToPositionCall = toolCalls.find(call => call.args[0] === 'move-to-position');
  const executor = moveToPositionCall!.args[3];

  const result = await executor({ x: 100, y: 64, z: 200, timeoutMs: 1000 });
  await clock.tickAsync(1000);

  t.falsy(result.isError);
  t.true(result.content[0].text.includes('Successfully moved'));
  t.true((mockBot.pathfinder!.stop as sinon.SinonStub).notCalled);
});

test('move-to-position preserves pathfinder error when not timing out', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const mockBot = {
    pathfinder: {
      goto: sinon.stub().rejects(new Error('Path was stopped before it could be completed! Thus, the desired goal was not reached.')),
      stop: sinon.stub()
    }
  } as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerPositionTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const moveToPositionCall = toolCalls.find(call => call.args[0] === 'move-to-position');
  const executor = moveToPositionCall!.args[3];

  const result = await executor({ x: 100, y: 64, z: 200, timeoutMs: 5000 });

  t.true(result.isError);
  t.true(result.content[0].text.includes('Path was stopped before it could be completed'));
  t.true((mockBot.pathfinder!.stop as sinon.SinonStub).notCalled);
});

test('M7: move-to-position reports an error when the pathfinder finishes without getting the bot there', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  // Boxed in: goto resolves at once and the bot has not moved.
  const mockBot = {
    entity: { position: new Vec3(0, 64, 0) },
    pathfinder: { goto: sinon.stub().resolves(), stop: sinon.stub() }
  } as Partial<mineflayer.Bot>;
  registerPositionTools(factory, () => mockBot as mineflayer.Bot);
  const executor = (mockServer.tool as sinon.SinonStub).getCalls().find(call => call.args[0] === 'move-to-position')!.args[3];

  const result = await executor({ x: 10, y: 64, z: 0 });

  t.true(result.isError);
  t.is(result.content[0].text, 'Failed: Did not reach (10, 64, 0): stopped at (0, 64, 0), 10.0 blocks from the target: the pathfinder found no way closer');

  // Within the range plus one block counts as arrived.
  mockBot.entity!.position = new Vec3(8, 64, 0);
  const near = await executor({ x: 10, y: 64, z: 0, range: 1 });
  t.falsy(near.isError);
  t.true(near.content[0].text.includes('Successfully moved'));
});
