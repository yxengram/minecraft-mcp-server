import test from 'ava';
import sinon from 'sinon';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';

test('createResponse returns proper MCP response format', (t) => {
  const mockServer = {} as McpServer;
  const mockConnection = {} as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const response = factory.createResponse('Test message');
  
  t.deepEqual(response, {
    content: [{ type: 'text', text: 'Test message' }]
  });
});

test('createResponse handles empty string', (t) => {
  const mockServer = {} as McpServer;
  const mockConnection = {} as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const response = factory.createResponse('');
  
  t.deepEqual(response, {
    content: [{ type: 'text', text: '' }]
  });
});

test('createErrorResponse with Error object', (t) => {
  const mockServer = {} as McpServer;
  const mockConnection = {} as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const error = new Error('Connection timeout');
  const response = factory.createErrorResponse(error);
  
  t.deepEqual(response, {
    content: [{ type: 'text', text: 'Failed: Connection timeout' }],
    isError: true
  });
});

test('createErrorResponse with string', (t) => {
  const mockServer = {} as McpServer;
  const mockConnection = {} as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const response = factory.createErrorResponse('Invalid argument');
  
  t.deepEqual(response, {
    content: [{ type: 'text', text: 'Failed: Invalid argument' }],
    isError: true
  });
});

test('createErrorResponse includes isError flag', (t) => {
  const mockServer = {} as McpServer;
  const mockConnection = {} as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  
  const response = factory.createErrorResponse('Error occurred');
  
  t.true(response.isError === true);
});

test('registerTool calls server.tool with correct parameters', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  
  const factory = new ToolFactory(mockServer, mockConnection);
  const schema = { type: 'object', properties: {} };
  const executor = sinon.stub().resolves({ content: [{ type: 'text', text: 'Success' }] });
  
  factory.registerTool('test_tool', 'A test tool', schema, executor);
  
  t.true((mockServer.tool as sinon.SinonStub).calledOnce);
  t.is((mockServer.tool as sinon.SinonStub).firstCall.args[0], 'test_tool');
  t.is((mockServer.tool as sinon.SinonStub).firstCall.args[1], 'A test tool');
  t.is((mockServer.tool as sinon.SinonStub).firstCall.args[2], schema);
});

test('registerTool executor checks connection before executing', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  
  const factory = new ToolFactory(mockServer, mockConnection);
  const executor = sinon.stub().resolves({ content: [{ type: 'text', text: 'Success' }] });
  
  factory.registerTool('test_tool', 'A test tool', {}, executor);
  
  const registeredExecutor = (mockServer.tool as sinon.SinonStub).firstCall.args[3];
  await registeredExecutor({ arg: 'value' });
  
  t.true((mockConnection.checkConnectionAndReconnect as sinon.SinonStub).calledOnce);
});

test('registerTool executor returns error when not connected', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ 
      connected: false, 
      message: 'Bot is not connected' 
    })
  } as unknown as BotConnection;
  
  const factory = new ToolFactory(mockServer, mockConnection);
  const executor = sinon.stub().resolves({ content: [{ type: 'text', text: 'Success' }] });
  
  factory.registerTool('test_tool', 'A test tool', {}, executor);
  
  const registeredExecutor = (mockServer.tool as sinon.SinonStub).firstCall.args[3];
  const response = await registeredExecutor({ arg: 'value' });
  
  t.deepEqual(response, {
    content: [{ type: 'text', text: 'Bot is not connected' }],
    isError: true
  });
  t.true((executor as sinon.SinonStub).notCalled);
});

test('registerTool executor calls executor when connected', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  
  const factory = new ToolFactory(mockServer, mockConnection);
  const executor = sinon.stub().resolves({ content: [{ type: 'text', text: 'Success' }] });
  
  factory.registerTool('test_tool', 'A test tool', {}, executor);
  
  const registeredExecutor = (mockServer.tool as sinon.SinonStub).firstCall.args[3];
  const args = { arg: 'value' };
  await registeredExecutor(args);
  
  t.true((executor as sinon.SinonStub).calledOnceWith(args));
});

test('registerTool executor returns executor result when successful', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  
  const factory = new ToolFactory(mockServer, mockConnection);
  const expectedResponse = { content: [{ type: 'text', text: 'Tool executed' }] };
  const executor = sinon.stub().resolves(expectedResponse);
  
  factory.registerTool('test_tool', 'A test tool', {}, executor);
  
  const registeredExecutor = (mockServer.tool as sinon.SinonStub).firstCall.args[3];
  const response = await registeredExecutor({ arg: 'value' });
  
  t.deepEqual(response, expectedResponse);
});

test('registerTool executor catches and returns error response on exception', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  
  const factory = new ToolFactory(mockServer, mockConnection);
  const error = new Error('Execution failed');
  const executor = sinon.stub().rejects(error);
  
  factory.registerTool('test_tool', 'A test tool', {}, executor);
  
  const registeredExecutor = (mockServer.tool as sinon.SinonStub).firstCall.args[3];
  const response = await registeredExecutor({ arg: 'value' });
  
  t.deepEqual(response, {
    content: [{ type: 'text', text: 'Failed: Execution failed' }],
    isError: true
  });
});

// E-029: a body command returns when the connection's whenEnded(bot) resolves. A connection without whenEnded (the
// stand-ins of the tests above) and a bot that stays in the game give the command's own result, as before.
function bodyToolHandler(connection: Record<string, unknown>, executor: sinon.SinonStub) {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const factory = new ToolFactory(mockServer, connection as unknown as BotConnection);
  factory.registerTool('move-to-position', 'A body tool', {}, executor);
  return (mockServer.tool as sinon.SinonStub).firstCall.args[3] as (args: unknown) => Promise<unknown>;
}

const standInBot = () => ({ once: sinon.stub(), removeListener: sinon.stub(), entity: { position: { x: 0.5, y: 64, z: 0.5 } } });

test('E-029: a body tool on a connection stand-in without whenEnded returns its own result as before', async (t) => {
  const bot = standInBot();
  const expected = { content: [{ type: 'text', text: 'Successfully moved' }] };
  const handler = bodyToolHandler({ checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }), getBot: () => bot }, sinon.stub().resolves(expected));
  t.deepEqual(await handler({}), expected);
});

test('E-029: a body tool whose bot stays in the game returns its own result, and waits on that bot\'s end signal', async (t) => {
  const bot = standInBot();
  const whenEnded = sinon.stub().returns(new Promise(() => {}));
  const expected = { content: [{ type: 'text', text: 'Successfully moved' }] };
  const handler = bodyToolHandler({ checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }), getBot: () => bot, whenEnded }, sinon.stub().resolves(expected));
  t.deepEqual(await handler({}), expected);
  t.true(whenEnded.calledOnceWith(bot));
});

// Serial, so the fake timers (only setTimeout: setImmediate stays real) cannot reach the concurrent tests above.
test.serial('E-029: when whenEnded resolves during a body tool, the call replies within 100 ms that the bot left the game', async (t) => {
  const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  t.teardown(() => clock.restore());
  const bot = standInBot();
  let leave: (reason: string) => void = () => {};
  const whenEnded = sinon.stub().returns(new Promise<string>(resolve => { leave = resolve; }));
  const handler = bodyToolHandler({ checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }), getBot: () => bot, whenEnded }, sinon.stub().returns(new Promise(() => {})));
  let reply: unknown;
  let settled = false;
  void handler({}).then(value => {
    settled = true;
    reply = value;
  });
  await new Promise(resolve => setImmediate(resolve));
  leave('socketClosed');
  await clock.tickAsync(100);
  t.true(settled, 'within 100 ms of the end signal, not after DEATH_SETTLE_MS');
  t.deepEqual(reply, {
    content: [{ type: 'text', text: 'Failed: The bot left the game during move-to-position (socketClosed); the command was stopped. The next tool call reconnects' }],
    isError: true
  });
});

test.serial('E-029: two body calls on the same bot both reply that it left, and so does one that starts after it left', async (t) => {
  const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  t.teardown(() => clock.restore());
  const bot = standInBot();
  let leave: (reason: string) => void = () => {};
  const ended = new Promise<string>(resolve => { leave = resolve; });
  // Without the Autopilot there is no lease, so both commands run at once.
  const handler = bodyToolHandler({ checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }), getBot: () => bot, whenEnded: () => ended }, sinon.stub().returns(new Promise(() => {})));
  const replies: unknown[] = [];
  void handler({}).then(value => replies.push(value));
  void handler({}).then(value => replies.push(value));
  await new Promise(resolve => setImmediate(resolve));
  leave('socketClosed');
  await clock.tickAsync(100);
  const left = {
    content: [{ type: 'text', text: 'Failed: The bot left the game during move-to-position (socketClosed); the command was stopped. The next tool call reconnects' }],
    isError: true
  };
  t.deepEqual(replies, [left, left]);

  void handler({}).then(value => replies.push(value));
  await new Promise(resolve => setImmediate(resolve));
  await clock.tickAsync(100);
  t.deepEqual(replies, [left, left, left], 'the end signal had already resolved when this call started');
});
