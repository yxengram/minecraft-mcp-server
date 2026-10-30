// M19 tool experience changes (BLUEPRINT F-052). Each case names its E row and the item of the row's 验证 column; the
// expected values come from the contract and G6, not from what the code happens to print. A real McpServer and SDK
// Client talk over InMemoryTransport.createLinkedPair, so extra.signal and notifications/cancelled take the SDK's own
// path; the bot is a stand-in, the ActionArbiter (and for collect-block the TaskManager) are real.
import test, { type ExecutionContext } from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CALL_LIMIT_MS, DEATH_SETTLE_MS, REPLY_MARGIN_MS, RESPAWN_WAIT_MS, ToolFactory, type ToolContext, type ToolFactoryOptions
} from '../src/tool-factory.js';
import { PORTAL_WAIT_MS } from '../src/tools/movement-utils.js';
import { registerWaypointTools } from '../src/tools/waypoint-tools.js';
import type { WaypointStore } from '../src/waypoint-store.js';
import { ActionArbiter, PRIORITY } from '../src/autopilot/action-arbiter.js';
import { TaskManager } from '../src/autopilot/task-manager.js';
import { BEHAVIORS } from '../src/autopilot/autopilot.js';
import type { Autopilot } from '../src/autopilot/autopilot.js';
import type { BotConnection } from '../src/bot-connection.js';
import { EventStore } from '../src/event-store.js';
import { registerPositionTools } from '../src/tools/position-tools.js';
import { registerBlockTools } from '../src/tools/block-tools.js';
import { registerRegionTools } from '../src/tools/region-tools.js';
import { registerInteractionTools } from '../src/tools/interaction-tools.js';
import { registerEntityTools } from '../src/tools/entity-tools.js';
import { registerEventTools } from '../src/tools/event-tools.js';
import { registerGatheringTools } from '../src/tools/gathering-tools.js';
import { registerInventoryTools } from '../src/tools/inventory-tools.js';
import { registerFurnaceTools } from '../src/tools/furnace-tools.js';
import { createFakeWorld } from './_helpers.js';

const STOPPED = 'Path was stopped before it could be completed! Thus, the desired goal was not reached.';

function useClock(t: ExecutionContext) {
  // Only the timers and the date: the SDK and the transport run on promises, which stay real.
  const clock = sinon.useFakeTimers({ now: 1.7e12, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  t.teardown(() => clock.restore());
  return clock;
}

/**
 * A bot whose pathfinder.goto never arrives on its own: like mineflayer-pathfinder's, the pending goto rejects once the
 * pathfinder is stopped. With `arrive` set, goto moves the bot to the goal instead. Blocks are 'air' unless listed.
 */
function fakeBot(blocks: Record<string, string> = {}) {
  const cells = new Map(Object.entries(blocks));
  const key = (pos: Vec3) => `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
  const pending: ((error: Error) => void)[] = [];
  const bot = Object.assign(new EventEmitter(), {
    version: '1.20.4',
    registry: minecraftData('1.20.4'),
    username: 'Bot',
    arrive: false,
    entity: { position: new Vec3(0.5, 64, 0.5), height: 1.8, yaw: 0, pitch: 0 },
    entities: {} as Record<number, unknown>,
    players: {},
    health: 20,
    food: 20,
    heldItem: null as unknown,
    inventory: { items: (): { name: string; count: number; type: number }[] => [] },
    pathfinder: {
      goto: sinon.stub(),
      stop: sinon.stub().callsFake(() => { for (const reject of pending.splice(0)) reject(new Error(STOPPED)); }),
      setGoal: sinon.stub(),
      isMoving: () => false,
      goal: null
    },
    clearControlStates: sinon.stub(),
    setControlState: sinon.stub(),
    stopDigging: sinon.stub(),
    lookAt: sinon.stub().resolves(),
    attack: sinon.stub(),
    equip: sinon.stub().resolves(),
    dig: sinon.stub().callsFake(async (block: { position: Vec3 }) => { cells.delete(key(block.position)); }),
    placeBlock: sinon.stub().resolves(),
    activateBlock: sinon.stub().resolves(),
    canDigBlock: () => true,
    canSeeBlock: (_block: { position: Vec3 }): boolean => true,
    blockAt: (pos: Vec3) => {
      const name = cells.get(key(pos)) ?? 'air';
      return { name, position: pos.floored(), diggable: true, getProperties: () => ({}) };
    },
    world: {
      getBlock: (pos: Vec3) => ({ name: cells.get(key(pos)) ?? 'air', position: pos.floored(), shapes: [] }),
      raycast: () => null
    }
  });
  bot.pathfinder.goto.callsFake((goal: { x?: number; y?: number; z?: number }) => {
    if (bot.arrive && typeof goal.x === 'number') {
      bot.entity.position = new Vec3(goal.x, goal.y ?? 64, goal.z ?? 0);
      return Promise.resolve();
    }
    return new Promise<void>((_, reject) => pending.push(reject));
  });
  return bot;
}

type Reply = { text: string; isError: boolean; rejected: boolean };

/**
 * A real MCP server with the factory, the real arbiter and the tools under test, and a client connected to it. The
 * Autopilot stand-in has what the factory reads (isReady, arbiter, describeInterruption) and, when given, a task
 * manager for collect-block. The arbiter's own preemption stop is a separate stub, so the bot's stubs count only
 * what the tool factory and the tools did.
 */
async function serve(
  t: ExecutionContext, bot: unknown, extra: (factory: ToolFactory, stand: Record<string, unknown>) => void = () => {},
  factoryOptions: ToolFactoryOptions = {}
) {
  const events = new EventStore();
  const arbiter = new ActionArbiter({ stopBody: sinon.stub() });
  const stand: Record<string, unknown> = { isReady: () => true, arbiter, describeInterruption: () => null, boundBot: () => bot };
  const server = new McpServer({ name: 'm19-tool-experience-test', version: '0.0.0' });
  // The factory calls checkConnectionAndReconnect on every call, so a test can replace it with a slow one. Without
  // whenEnded the connection is like the stand-ins before E-029; leaveGame() below adds one.
  const connection: {
    checkConnectionAndReconnect: () => Promise<{ connected: boolean }>;
    getBot: () => unknown;
    whenEnded?: (bot: unknown) => Promise<string>;
  } = {
    checkConnectionAndReconnect: async () => ({ connected: true }),
    getBot: () => bot
  };
  const factory = new ToolFactory(server, connection as unknown as BotConnection, factoryOptions);
  factory.setEvents(events);
  factory.setAutopilot(() => stand as unknown as Autopilot);
  const getBot = () => bot as never;
  // Registered before connecting: the server sets up its tool handlers on the first registration.
  registerPositionTools(factory, getBot);
  registerBlockTools(factory, getBot);
  registerRegionTools(factory, getBot);
  registerInteractionTools(factory, getBot);
  registerEntityTools(factory, getBot);
  registerEventTools(factory, events, getBot);
  registerInventoryTools(factory, getBot);
  registerFurnaceTools(factory, getBot);
  extra(factory, stand);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'm19-tool-experience-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  t.teardown(async () => {
    await client.close();
    await server.close();
  });

  const call = async (name: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Reply> => {
    try {
      // A long client timeout: the tests are about the server's own limits, not the SDK client's 60 s default.
      const result = await client.callTool({ name, arguments: args }, undefined, { signal, timeout: 300000 });
      const content = (result.content ?? []) as { type: string; text?: string }[];
      return { text: content.map(part => part.text ?? '').join('\n'), isError: result.isError === true, rejected: false };
    } catch (error) {
      // A cancelled request rejects on the client; the server's reply to it is dropped by the SDK.
      return { text: error instanceof Error ? error.message : String(error), isError: true, rejected: true };
    }
  };
  const commandEvents = () => events.query({ types: ['command'], limit: 100 }).events.map(event => event.message);
  return { factory, arbiter, events, call, commandEvents, stand, connection, client };
}

/** Tracks whether a call has replied yet. */
function track(promise: Promise<Reply>) {
  const state = { settled: false, reply: null as Reply | null };
  void promise.then(reply => { state.settled = true; state.reply = reply; });
  return state;
}

// ---------------------------------------------------------------------------------------------------------------
// E-027: tool calls have a time budget, a watchdog and MCP cancellation (Q27). Body tools stop at about 50 s and
// release the lease; a call the client cancels stops at once and leaves a `command` event (G3); after the abort
// nothing moves the body any more (G6 I3).
// ---------------------------------------------------------------------------------------------------------------

test.serial('E-027 (1): a cancelled move-to-position stops the body within 2.5 s, frees the lease, writes a command event, and the next move runs', async (t) => {
  const clock = useClock(t);
  const bot = fakeBot();
  const s = await serve(t, bot);
  const controller = new AbortController();

  const first = track(s.call('move-to-position', { x: 40, y: 64, z: 0 }, controller.signal));
  await clock.tickAsync(1000);
  t.is(s.arbiter.holder()?.holder, 'manual move-to-position', 'the move holds the body');
  t.true(bot.pathfinder.goto.calledOnce);

  controller.abort();
  await clock.tickAsync(2500);

  t.true(bot.pathfinder.stop.called, 'the pathfinder is stopped');
  t.true(bot.pathfinder.setGoal.calledWith(null), 'and has no goal, so the bot does not walk on toward (40, 64, 0)');
  t.true(bot.clearControlStates.called, 'the controls are cleared');
  t.is(s.arbiter.holder(), null, 'the lease is released');
  t.deepEqual(s.commandEvents(), ['move-to-position was cancelled by the MCP client after 1.0 s; the bot stopped at (0, 64, 0)']);
  t.true(first.settled && first.reply!.rejected, 'the client gave up on the request; the SDK drops the reply');
  t.is(s.factory.inFlight().length, 0, 'the call left the in-flight table');

  bot.arrive = true;
  const second = await s.call('move-to-position', { x: 3, y: 64, z: 0 });
  t.false(second.isError, second.text);
  t.true(second.text.startsWith('Successfully moved to position near (3, 64, 0)'), second.text);
  t.false(second.text.includes('Busy'), second.text);
  t.is(bot.pathfinder.goto.callCount, 2);
});

test.serial('E-027 (1): a command cancelled while it waits for the lease leaves the queue, never runs, and does not touch the holder\'s body', async (t) => {
  const clock = useClock(t);
  const bot = fakeBot();
  const s = await serve(t, bot);
  const urgent = await s.arbiter.acquire({ holder: 'instinct leave_lava', priority: PRIORITY.URGENT_INSTINCT });
  t.true(urgent.ok);
  if (!urgent.ok) return;
  const controller = new AbortController();

  const queued = track(s.call('move-to-position', { x: 40, y: 64, z: 0 }, controller.signal));
  await clock.tickAsync(3000);
  t.deepEqual(s.factory.inFlight().map(call => ({ name: call.name, body: call.body, queued: call.queued })),
    [{ name: 'move-to-position', body: true, queued: true }], 'the in-flight table shows the queued call (for E-040)');

  controller.abort();
  await clock.tickAsync(100);

  t.deepEqual(s.commandEvents(), ['move-to-position was cancelled by the MCP client while waiting for instinct leave_lava']);
  t.true(queued.settled);
  t.false(bot.pathfinder.goto.called, 'the command never ran');
  t.false(bot.pathfinder.stop.called, 'the holder\'s body is not stopped (G4)');
  t.false(bot.clearControlStates.called);
  t.is(s.arbiter.holder()?.holder, 'instinct leave_lava');

  urgent.lease.release();
  await clock.tickAsync(10000);
  t.is(s.arbiter.holder(), null, 'the cancelled command never gets the lease');
  t.false(bot.pathfinder.goto.called);
  t.is(s.factory.inFlight().length, 0);
});

test.serial('E-027 (1): a command cancelled before it asks for the lease (during a slow reconnect) never runs, and its event does not name a holder it never waited for', async (t) => {
  const clock = useClock(t);
  const bot = fakeBot();
  const s = await serve(t, bot);
  s.connection.checkConnectionAndReconnect = () => new Promise(resolve => setTimeout(() => resolve({ connected: true }), 3000));
  const controller = new AbortController();

  const pending = track(s.call('move-to-position', { x: 40, y: 64, z: 0 }, controller.signal));
  await clock.tickAsync(1000);
  controller.abort();
  await clock.tickAsync(2100);

  t.deepEqual(s.commandEvents(), ['move-to-position was cancelled by the MCP client after 1.0 s; the bot stopped at (0, 64, 0)']);
  t.true(pending.settled);
  t.false(bot.pathfinder.goto.called, 'the command never ran');
  t.false(bot.pathfinder.stop.called, 'it never held the body, so it does not stop it (G4)');
  t.is(s.arbiter.holder(), null, 'and never gets the lease');
  t.is(s.factory.inFlight().length, 0);
});

test.serial('E-027 (1): cancelling a command that an urgent instinct action suspended leaves the instinct\'s body alone (G4)', async (t) => {
  const clock = useClock(t);
  const bot = fakeBot();
  const s = await serve(t, bot, factory => {
    factory.registerTool('stubborn-command', 'Never ends', {}, () => new Promise(() => {}), { body: true });
  });
  const controller = new AbortController();
  track(s.call('stubborn-command', {}, controller.signal));
  await clock.tickAsync(500);
  const urgent = await s.arbiter.acquire({ holder: 'instinct run_from_creeper', priority: PRIORITY.URGENT_INSTINCT });
  t.true(urgent.ok);

  controller.abort();
  await clock.tickAsync(DEATH_SETTLE_MS + 100);

  t.false(bot.pathfinder.stop.called, 'the command no longer held the body, so it does not stop it');
  t.false(bot.clearControlStates.called);
  t.false(bot.stopDigging.called);
  t.is(s.arbiter.holder()?.holder, 'instinct run_from_creeper');
  if (urgent.ok) urgent.lease.release();
  t.is(s.arbiter.holder(), null, 'the cancelled command does not resume after the instinct action');
});

test.serial('E-027 (2): a command that ignores the signal still has its lease released after 2 s', async (t) => {
  const clock = useClock(t);
  const bot = fakeBot();
  const s = await serve(t, bot, factory => {
    factory.registerTool('stubborn-command', 'Never ends and never looks at ctx.signal', {}, () => new Promise(() => {}), { body: true });
  });
  const controller = new AbortController();
  const pending = track(s.call('stubborn-command', {}, controller.signal));
  await clock.tickAsync(500);

  controller.abort();
  await clock.tickAsync(DEATH_SETTLE_MS - 10);
  t.is(s.arbiter.holder()?.holder, 'manual stubborn-command', 'it gets DEATH_SETTLE_MS to give up');
  t.true(bot.pathfinder.stop.calledOnce, 'the body was stopped right away');
  t.true(bot.clearControlStates.calledOnce);
  t.true(bot.stopDigging.calledOnce);

  await clock.tickAsync(20);
  t.is(s.arbiter.holder(), null, 'then the lease is released anyway');
  t.deepEqual(s.commandEvents(), ['stubborn-command was cancelled by the MCP client after 0.5 s; the bot stopped at (0, 64, 0)']);
  t.true(pending.settled);
  t.is(s.factory.inFlight().length, 0);
});

test.serial('E-027 (2): after the abort clear-region digs no further cell (no digBlockAt for the next one), even one it would not walk to', async (t) => {
  const clock = useClock(t);
  // The bot walks to the nearest cell (it cannot see it); the next one it could dig from where it stands.
  const bot = fakeBot({ '3,64,0': 'stone', '4,64,0': 'stone' });
  // digBlockAt first asks whether it can see its cell, so the cells looked at are the cells it was entered for.
  const looked: number[] = [];
  bot.canSeeBlock = (block: { position: Vec3 }) => {
    looked.push(block.position.x);
    return block.position.x !== 3;
  };
  const s = await serve(t, bot);
  const controller = new AbortController();

  track(s.call('clear-region', { x1: 3, y1: 64, z1: 0, x2: 4, y2: 64, z2: 0 }, controller.signal));
  await clock.tickAsync(1000);
  t.true(bot.pathfinder.goto.calledOnce, 'walking to the first cell');
  controller.abort();
  await clock.tickAsync(30000);

  t.true(bot.pathfinder.goto.calledOnce, 'no walk to another cell');
  t.false(looked.includes(4), 'digBlockAt is not entered for the next cell');
  t.false(bot.dig.called, 'nothing dug');
  t.is(s.arbiter.holder(), null);
});

test.serial('E-027 (2): after the abort place-block does not try the next face, and places nothing', async (t) => {
  const clock = useClock(t);
  // Two faces to place against: the bot cannot see the one below and walks; it could place against the west one from
  // where it stands, which is what it would do next if it tried the next face.
  const bot = fakeBot({ '10,63,0': 'stone', '9,64,0': 'stone' });
  bot.entity.position = new Vec3(7.5, 64, 0.5);
  bot.canSeeBlock = (block: { position: Vec3 }) => !(block.position.x === 10 && block.position.y === 63);
  const s = await serve(t, bot);
  const controller = new AbortController();

  track(s.call('place-block', { x: 10, y: 64, z: 0 }, controller.signal));
  await clock.tickAsync(1000);
  t.true(bot.pathfinder.goto.calledOnce, 'walking to place against the face below');
  controller.abort();
  await clock.tickAsync(30000);

  t.true(bot.pathfinder.goto.calledOnce, 'no other walk');
  t.false(bot.lookAt.called, 'the west face is not tried');
  t.false(bot.placeBlock.called);
  t.is(s.arbiter.holder(), null);
});

test.serial('E-027 (2): after the abort fill-region places nothing more, also where it would not have to walk', async (t) => {
  const clock = useClock(t);
  // Two empty cells on a floor: the bot cannot see the floor under the nearer one and walks; the other it could fill
  // from where it stands.
  const bot = fakeBot({ '3,63,0': 'stone', '5,63,0': 'stone' });
  bot.entity.position = new Vec3(2.5, 64, 0.5);
  bot.inventory.items = () => [{ name: 'dirt', count: 8, type: 1 }];
  bot.heldItem = { name: 'dirt' };
  bot.canSeeBlock = (block: { position: Vec3 }) => block.position.x !== 3;
  const s = await serve(t, bot);
  const controller = new AbortController();

  track(s.call('fill-region', { x1: 3, y1: 64, z1: 0, x2: 5, y2: 64, z2: 0, blockName: 'dirt' }, controller.signal));
  await clock.tickAsync(1000);
  t.true(bot.pathfinder.goto.calledOnce, 'walking to fill the first cell');
  controller.abort();
  await clock.tickAsync(30000);

  t.true(bot.pathfinder.goto.calledOnce, 'no other walk');
  t.false(bot.placeBlock.called, 'nothing placed');
  t.is(s.arbiter.holder(), null);
});

test.serial('E-027 (2): after the abort dig-block and activate-block neither dig nor click', async (t) => {
  const clock = useClock(t);
  const bot = fakeBot({ '10,64,0': 'stone', '-10,64,0': 'lever' });
  bot.canSeeBlock = () => false;
  // A walk that arrives on its own 2.5 s after the abort, after the lease is released, and that a stop does not end:
  // only the tools' own abort checks keep them from digging or clicking then.
  bot.pathfinder.goto = sinon.stub().callsFake(() => new Promise<void>(resolve => setTimeout(resolve, 3500)));
  const s = await serve(t, bot);

  for (const [name, args] of [['dig-block', { x: 10, y: 64, z: 0 }], ['activate-block', { x: -10, y: 64, z: 0 }]] as const) {
    const controller = new AbortController();
    track(s.call(name, args, controller.signal));
    await clock.tickAsync(1000);
    controller.abort();
    await clock.tickAsync(DEATH_SETTLE_MS + 2000);
    t.is(s.arbiter.holder(), null, name);
  }
  t.is(bot.pathfinder.goto.callCount, 2, 'each walked once');
  t.false(bot.dig.called);
  t.false(bot.activateBlock.called);
});

test.serial('E-027 (2): after the abort attack-entity hits no more', async (t) => {
  const clock = useClock(t);
  const bot = fakeBot();
  bot.entities = { 2: { id: 2, name: 'zombie', type: 'hostile', position: new Vec3(2, 64, 0), height: 1.95, isValid: true } };
  const s = await serve(t, bot);
  const controller = new AbortController();

  track(s.call('attack-entity', { entityId: 2, times: 5 }, controller.signal));
  await clock.tickAsync(300);
  t.true(bot.attack.calledOnce, 'the first hit');
  // The abort lands in the pause between hits.
  const looks = bot.lookAt.callCount;
  controller.abort();
  await clock.tickAsync(10000);

  t.true(bot.attack.calledOnce, 'no hit after the abort');
  t.is(bot.lookAt.callCount, looks, 'no look at the target after the abort');
  t.is(s.arbiter.holder(), null);
});

test.serial('E-027 (3): a body command past the 50 s budget returns an error, is stopped, and its lease is released', async (t) => {
  const clock = useClock(t);
  // E-038 gave move-to-position a default limit of its own (about 35 s), so the walk that never ends is
  // activate-block's, whose walk to the block has no limit but the budget.
  const bot = fakeBot({ '40,64,0': 'lever' });
  const s = await serve(t, bot);
  t.is(CALL_LIMIT_MS, 50000);

  const pending = track(s.call('activate-block', { x: 40, y: 64, z: 0 }));
  await clock.tickAsync(CALL_LIMIT_MS - 100);
  t.false(pending.settled, 'still walking just before the budget');
  t.false(bot.pathfinder.stop.called);

  await clock.tickAsync(200);
  t.true(pending.settled);
  const reply = pending.reply!;
  t.true(reply.isError);
  t.false(reply.rejected, 'a real reply, not a client-side timeout');
  t.is(reply.text, 'Failed: activate-block did not finish within 50 s, so it was stopped at (0, 64, 0); call it again to continue, or use start-task for long jobs');
  t.true(bot.pathfinder.stop.called);
  t.true(bot.clearControlStates.called);
  t.is(s.arbiter.holder(), null);
  t.deepEqual(s.commandEvents(), [], 'only a client cancel writes a command event');
});

test.serial('E-027 (3): a region tool stopped by the budget adds its own counts to the reply', async (t) => {
  const clock = useClock(t);
  // The first cell is dug where the bot stands; the walk to the second never ends.
  const bot = fakeBot({ '2,64,0': 'stone', '3,64,0': 'stone' });
  bot.canSeeBlock = (block: { position: Vec3 }) => block.position.x === 2;
  const s = await serve(t, bot);

  const pending = track(s.call('clear-region', { x1: 2, y1: 64, z1: 0, x2: 3, y2: 64, z2: 0 }));
  await clock.tickAsync(CALL_LIMIT_MS + 100);

  t.true(pending.settled);
  const reply = pending.reply!;
  t.true(reply.isError);
  t.true(reply.text.startsWith('Failed: clear-region did not finish within 50 s, so it was stopped at (0, 64, 0); call it again to continue, or use start-task for long jobs'), reply.text);
  t.true(reply.text.includes('Cleared region of 2 blocks: dug 1, already empty 0. Stopped early with 1 block(s) not processed; run again to continue'), reply.text);
  t.true(bot.dig.calledOnce);
  t.is(s.arbiter.holder(), null);
});

test.serial('E-027 (3): a body command that returns more than 2 s after the budget ran out has its lease released at 2 s and its text dropped', async (t) => {
  const clock = useClock(t);
  const bot = fakeBot();
  const s = await serve(t, bot, factory => {
    factory.registerTool('late-command', 'Gives up 3 s after the abort', {}, async (_args: unknown, ctx: ToolContext) => {
      await new Promise(resolve => ctx.signal.addEventListener('abort', resolve, { once: true }));
      await new Promise(resolve => setTimeout(resolve, 3000));
      return factory.createResponse('late text');
    }, { body: true });
  });

  const pending = track(s.call('late-command'));
  await clock.tickAsync(CALL_LIMIT_MS + DEATH_SETTLE_MS - 10);
  t.false(pending.settled, 'it gets DEATH_SETTLE_MS to give up');
  t.is(s.arbiter.holder()?.holder, 'manual late-command');

  await clock.tickAsync(110);
  t.true(pending.settled);
  t.is(s.arbiter.holder(), null, 'then the lease is released, before the command returns');
  t.is(pending.reply!.text, 'Failed: late-command did not finish within 50 s, so it was stopped at (0, 64, 0); call it again to continue, or use start-task for long jobs');
  await clock.tickAsync(1000);
});

test.serial('E-027 (2), E-018: a death stops the body, releases the lease after 2 s, and the reply is the death reply as before', async (t) => {
  const clock = useClock(t);
  const bot = fakeBot();
  const s = await serve(t, bot, factory => {
    factory.registerTool('stubborn-command', 'Never ends', {}, () => new Promise(() => {}), { body: true });
  });

  const pending = track(s.call('stubborn-command'));
  await clock.tickAsync(500);
  bot.emit('death');
  t.true(bot.pathfinder.stop.calledOnce, 'the body is stopped at once');
  t.true(bot.clearControlStates.calledOnce);

  await clock.tickAsync(DEATH_SETTLE_MS - 10);
  t.is(s.arbiter.holder()?.holder, 'manual stubborn-command', 'it gets DEATH_SETTLE_MS to give up');
  await clock.tickAsync(20);
  t.is(s.arbiter.holder(), null, 'then the lease is released, before the respawn');
  t.false(pending.settled, 'the reply waits for the respawn');

  bot.entity.position = new Vec3(10.5, 65, 10.5);
  bot.emit('spawn');
  await clock.tickAsync(100);
  t.true(pending.settled);
  t.is(pending.reply!.text, 'Failed: The bot died during stubborn-command at (0, 64, 0); it respawned at (10, 65, 10) and the command was stopped');
  t.true(bot.pathfinder.stop.calledOnce);
  t.deepEqual(s.commandEvents(), [], 'command events are only for client cancels and stop-all (G3)');
  t.is(s.factory.inFlight().length, 0);
});

test.serial('E-027 (3): tools that are not body tools have no watchdog: wait-for-event still waits 55 s, a 70 s tool still answers', async (t) => {
  const clock = useClock(t);
  const bot = fakeBot();
  const s = await serve(t, bot, factory => {
    factory.registerTool('slow-query', 'Answers after 70 s', {}, async () => {
      await new Promise(resolve => setTimeout(resolve, 70000));
      return factory.createResponse('answered after 70 s');
    });
  });

  const waiting = track(s.call('wait-for-event', { types: ['never'], timeoutMs: 55000 }));
  const slow = track(s.call('slow-query'));
  await clock.tickAsync(CALL_LIMIT_MS + 1000);
  t.false(waiting.settled, 'wait-for-event is not stopped at 50 s');
  t.false(slow.settled);

  await clock.tickAsync(5000);
  t.true(waiting.settled);
  t.false(waiting.reply!.isError, waiting.reply!.text);
  t.true(waiting.reply!.text.startsWith('Nothing happened within 55.0s'), waiting.reply!.text);

  await clock.tickAsync(15000);
  t.true(slow.settled);
  t.false(slow.reply!.isError);
  t.is(slow.reply!.text, 'answered after 70 s');
  t.false(bot.pathfinder.stop.called);
});

test.serial('E-027 (4): after 10 s waiting for the lease ctx.remainingMs() is about 40 s, and extendDeadline moves the watchdog', async (t) => {
  const clock = useClock(t);
  const bot = fakeBot();
  const seen: { remaining?: number; budget?: number } = {};
  let start = 0;
  const s = await serve(t, bot, factory => {
    factory.registerTool('probe-command', 'Reads its budget', {}, async (_args: unknown, ctx: ToolContext) => {
      seen.remaining = ctx.remainingMs();
      ctx.extendDeadline(30000);
      seen.budget = ctx.deadline - start;
      await new Promise(resolve => ctx.signal.addEventListener('abort', resolve, { once: true }));
      return factory.createResponse('probe stopped');
    }, { body: true });
  });
  const urgent = await s.arbiter.acquire({ holder: 'instinct swim_to_air', priority: PRIORITY.URGENT_INSTINCT });
  t.true(urgent.ok);
  if (!urgent.ok) return;

  start = Date.now();
  const pending = track(s.call('probe-command'));
  await clock.tickAsync(9900);
  urgent.lease.release();
  await clock.tickAsync(0);

  t.true(seen.remaining !== undefined && Math.abs(seen.remaining - 40100) <= 100, `remainingMs ${seen.remaining}`);
  t.is(seen.budget, 80000, 'the deadline moved 30 s later');
  await clock.tickAsync(CALL_LIMIT_MS - 9900 + 1000);
  t.false(pending.settled, 'not stopped at 50 s: the watchdog moved with the deadline');

  await clock.tickAsync(30000);
  t.true(pending.settled);
  t.true(pending.reply!.text.startsWith('Failed: probe-command did not finish within 80 s, so it was stopped at (0, 64, 0)'), pending.reply!.text);
  t.true(pending.reply!.text.includes('\nprobe stopped'), 'its own text, as it returned within 2 s');
  t.is(s.arbiter.holder(), null);
});

test.serial('E-027 (5): collect-block has no watchdog, and once cancelled its gather task ends as cancelled by the MCP client', async (t) => {
  const clock = useClock(t);
  const world = createFakeWorld({ '6,64,0': 'oak_log' });
  const logId = minecraftData('1.20.4').blocksByName.oak_log.id;
  world.bot.findBlocks.callsFake(({ matching }: { matching: number }) => (matching === logId ? [new Vec3(6, 64, 0)] : []));
  world.bot.canSeeBlock = () => false;
  // The walk to the log never ends; like the real pathfinder, a stop makes it reject.
  const pending: ((error: Error) => void)[] = [];
  world.bot.pathfinder.goto = sinon.stub().callsFake(() => new Promise((_, reject) => pending.push(reject)));
  world.bot.pathfinder.stop = sinon.stub().callsFake(() => { for (const reject of pending.splice(0)) reject(new Error(STOPPED)); });
  let tasks: TaskManager | null = null;
  const s = await serve(t, world.bot, (factory, stand) => {
    tasks = new TaskManager({ getBot: () => world.bot as never, getArbiter: () => stand.arbiter as ActionArbiter, events: new EventStore(), behaviors: BEHAVIORS });
    stand.tasks = tasks;
    registerGatheringTools(factory, () => stand as unknown as Autopilot);
  });
  const controller = new AbortController();

  const call = track(s.call('collect-block', { blockType: 'oak_log' }, controller.signal));
  await clock.tickAsync(1000);
  const task = tasks!.currentTask();
  t.is(task?.behavior, 'gather');
  t.is(task?.status, 'running');
  t.deepEqual(s.factory.inFlight().map(c => ({ name: c.name, body: c.body })), [{ name: 'collect-block', body: false }],
    'collect-block is in the in-flight table (for E-040)');

  // Since E-038 the call replies "Still collecting …" at about 45 s (see the E-038 cases below), so the cancel comes
  // before that.
  await clock.tickAsync(CALL_LIMIT_MS - 15000);
  t.false(call.settled, 'still waiting, before the default limit (about 45 s)');
  t.is(tasks!.currentTask()?.status, 'running');

  controller.abort();
  await clock.tickAsync(1000);
  const record = tasks!.list().history.find(entry => entry.id === task?.id);
  t.is(record?.status, 'cancelled');
  t.is(record?.result, 'cancelled by the MCP client');
  t.is(tasks!.currentTask(), null);
  t.true(call.settled);
  t.is(s.factory.inFlight().length, 0);
});

test.serial('E-027 (5): lead-animal is in the in-flight table, and once cancelled its lead task ends as cancelled by the MCP client', async (t) => {
  const clock = useClock(t);
  // A cow next to the bot and wheat to lure it with; the walk toward the target never ends.
  const bot = fakeBot();
  bot.entities = { 2: { id: 2, name: 'cow', type: 'animal', position: new Vec3(2.5, 64, 0.5), height: 1.4, isValid: true } };
  bot.inventory.items = () => [{ name: 'wheat', count: 5, type: 900 }];
  let tasks: TaskManager | null = null;
  const s = await serve(t, bot, (factory, stand) => {
    tasks = new TaskManager({ getBot: () => bot as never, getArbiter: () => stand.arbiter as ActionArbiter, events: new EventStore(), behaviors: BEHAVIORS });
    stand.tasks = tasks;
    registerGatheringTools(factory, () => stand as unknown as Autopilot);
  });
  const controller = new AbortController();

  const call = track(s.call('lead-animal', { entityId: 2, x: 20, y: 64, z: 0 }, controller.signal));
  await clock.tickAsync(1000);
  const task = tasks!.currentTask();
  t.is(task?.behavior, 'lead');
  t.is(task?.status, 'running');
  t.deepEqual(s.factory.inFlight().map(c => ({ name: c.name, body: c.body })), [{ name: 'lead-animal', body: false }],
    'lead-animal is in the in-flight table (for E-040)');

  controller.abort();
  await clock.tickAsync(1000);
  const record = tasks!.list().history.find(entry => entry.id === task?.id);
  t.is(record?.status, 'cancelled');
  t.is(record?.result, 'cancelled by the MCP client');
  t.is(tasks!.currentTask(), null);
  t.true(call.settled);
  t.is(s.factory.inFlight().length, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// E-029: a body command in progress returns at once when the bot leaves the game. BotConnection lets go of the bot
// with removeAllListeners, so a pending goto, dig or window never settles and the death watch is gone too; the
// connection's whenEnded(bot) promise is what tells the call. The kick text and the four places that resolve it are
// tested with the real BotConnection in tests/m19-connection.test.ts.
// ---------------------------------------------------------------------------------------------------------------

type Served = Awaited<ReturnType<typeof serve>>;

/**
 * Gives the stand-in connection a whenEnded for `bot` and returns what makes the bot leave: like BotConnection's
 * release, every listener on the bot goes (the death watch's included) before the end signal resolves.
 */
function leaveGame(s: Served, bot: EventEmitter) {
  let resolve: (reason: string) => void = () => {};
  const ended = new Promise<string>(settle => { resolve = settle; });
  s.connection.whenEnded = asked => (asked === bot ? ended : new Promise(() => {}));
  return (reason: string) => {
    bot.removeAllListeners();
    resolve(reason);
  };
}

const leftDuring = (name: string, reason: string) =>
  `Failed: The bot left the game during ${name} (${reason}); the command was stopped. The next tool call reconnects`;

test.serial('E-029: move-to-position whose goto never ends returns within 100 ms of the end signal, and the lease is released', async (t) => {
  const clock = useClock(t);
  const bot = fakeBot();
  // Once the bot is let go nothing settles the goto, not even a stop of the pathfinder.
  bot.pathfinder.goto = sinon.stub().returns(new Promise(() => {}));
  const s = await serve(t, bot);
  const leave = leaveGame(s, bot);

  const pending = track(s.call('move-to-position', { x: 40, y: 64, z: 0 }));
  await clock.tickAsync(1000);
  t.is(s.arbiter.holder()?.holder, 'manual move-to-position');
  t.false(pending.settled);

  leave('socketClosed');
  await clock.tickAsync(100);
  t.true(pending.settled, 'replied within 100 ms');
  t.false(pending.reply!.rejected, 'a real reply');
  t.true(pending.reply!.isError);
  t.is(pending.reply!.text, leftDuring('move-to-position', 'socketClosed'));
  t.is(s.arbiter.holder(), null);
  t.is(s.factory.inFlight().length, 0);
  t.deepEqual(s.commandEvents(), [], 'the reply reaches the client, so no command event (G3)');
});

test.serial('E-029: a body command that ignores the signal still replies at once (no 2 s wait); its ctx.signal is aborted, and its late rejection is not unhandled', async (t) => {
  const clock = useClock(t);
  const bot = fakeBot();
  const unhandled = sinon.spy();
  process.on('unhandledRejection', unhandled);
  t.teardown(() => { process.off('unhandledRejection', unhandled); });
  let seen: ToolContext | null = null;
  const s = await serve(t, bot, factory => {
    factory.registerTool('stuck-command', 'Fails 3 s after it starts, whatever happens', {}, async (_args: unknown, ctx: ToolContext) => {
      seen = ctx;
      await new Promise(resolve => setTimeout(resolve, 3000));
      throw new Error('the window never opened');
    }, { body: true });
  });
  const leave = leaveGame(s, bot);

  const pending = track(s.call('stuck-command'));
  await clock.tickAsync(500);
  leave('socketClosed');
  await clock.tickAsync(100);
  t.true(pending.settled, 'not after DEATH_SETTLE_MS: the command would never settle on a bot that is gone');
  t.is(pending.reply!.text, leftDuring('stuck-command', 'socketClosed'));
  t.is(s.arbiter.holder(), null, 'the lease is released at once');
  const ctx = seen as ToolContext | null;
  t.true(ctx?.signal.aborted, 'ctx.signal is aborted, so a loop that wakes up later does not drive the next bot');
  t.throws(() => ctx?.throwIfAborted());

  // The original promise rejects only now, after the reply.
  await clock.tickAsync(3000);
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  t.true(unhandled.notCalled, 'no unhandled rejection');
  t.is(s.factory.inFlight().length, 0);
});

test.serial('E-029: the reply names the reason the connection gives, e.g. the plain kick text', async (t) => {
  const clock = useClock(t);
  const bot = fakeBot();
  const s = await serve(t, bot, factory => {
    factory.registerTool('stubborn-command', 'Never ends', {}, () => new Promise(() => {}), { body: true });
  });
  const leave = leaveGame(s, bot);

  const pending = track(s.call('stubborn-command'));
  await clock.tickAsync(500);
  leave('Kicked by an operator');
  await clock.tickAsync(100);
  t.is(pending.reply?.text, leftDuring('stubborn-command', 'Kicked by an operator'));
});

test.serial('E-029: a command waiting for the lease when the bot leaves returns at once and never runs', async (t) => {
  const clock = useClock(t);
  const bot = fakeBot();
  const s = await serve(t, bot);
  const leave = leaveGame(s, bot);
  const urgent = await s.arbiter.acquire({ holder: 'instinct leave_lava', priority: PRIORITY.URGENT_INSTINCT });
  t.true(urgent.ok);
  if (!urgent.ok) return;

  const queued = track(s.call('move-to-position', { x: 40, y: 64, z: 0 }));
  await clock.tickAsync(1000);
  t.false(queued.settled, 'waiting for the instinct action');
  leave('socketClosed');
  await clock.tickAsync(100);
  t.true(queued.settled);
  t.is(queued.reply!.text, leftDuring('move-to-position', 'socketClosed'));

  urgent.lease.release();
  await clock.tickAsync(10000);
  t.false(bot.pathfinder.goto.called, 'the command never ran');
  t.is(s.arbiter.holder(), null, 'and never gets the lease');
  t.is(s.factory.inFlight().length, 0);
});

test.serial('E-029, E-018: when the death comes first the reply is still the death reply', async (t) => {
  const clock = useClock(t);
  const bot = fakeBot();
  const s = await serve(t, bot, factory => {
    factory.registerTool('stubborn-command', 'Never ends', {}, () => new Promise(() => {}), { body: true });
  });
  const leave = leaveGame(s, bot);

  const pending = track(s.call('stubborn-command'));
  await clock.tickAsync(500);
  bot.emit('death');
  await clock.tickAsync(100);
  leave('socketClosed');
  // The respawn never comes on a bot that left, so the death reply waits its usual time for it.
  await clock.tickAsync(DEATH_SETTLE_MS + RESPAWN_WAIT_MS + 100);
  t.true(pending.settled);
  t.is(pending.reply!.text, 'Failed: The bot died during stubborn-command at (0, 64, 0); it respawned at (0, 64, 0) and the command was stopped');
  t.is(s.arbiter.holder(), null);
});

test.serial('E-029: a body command that ends before the bot leaves keeps its result, and a tool that is not a body tool is not stopped', async (t) => {
  const clock = useClock(t);
  const bot = fakeBot();
  bot.arrive = true;
  const s = await serve(t, bot, factory => {
    factory.registerTool('slow-query', 'Answers after 1 s', {}, async () => {
      await new Promise(resolve => setTimeout(resolve, 1000));
      return factory.createResponse('answered after 1 s');
    });
  });
  const leave = leaveGame(s, bot);

  const moved = await s.call('move-to-position', { x: 3, y: 64, z: 0 });
  t.false(moved.isError, moved.text);
  t.true(moved.text.startsWith('Successfully moved to position near (3, 64, 0)'), moved.text);

  const query = track(s.call('slow-query'));
  await clock.tickAsync(500);
  leave('socketClosed');
  await clock.tickAsync(600);
  t.true(query.settled);
  t.false(query.reply!.isError, query.reply!.text);
  t.is(query.reply!.text, 'answered after 1 s');
});

// ---------------------------------------------------------------------------------------------------------------
// E-031: an action tool that did not do what was asked replies with createErrorResponse (isError true, the text
// after "Failed: "). Queries that find nothing and requests for a state the bot is already in stay successes with
// the same text (Q29).
// ---------------------------------------------------------------------------------------------------------------

const SELF_CELL = 'Failed: Cannot place a block where the bot is standing or one block above';

test.serial('E-031: place-block into the bot\'s own cell is an error, at the feet, at the head, and when the walk there ends in the target', async (t) => {
  useClock(t);
  const bot = fakeBot({ '10,63,0': 'stone' });
  const s = await serve(t, bot);

  for (const y of [64, 65]) {
    const reply = await s.call('place-block', { x: 0, y, z: 0 });
    t.true(reply.isError, `y ${y}`);
    t.is(reply.text, SELF_CELL, `y ${y}`);
  }

  // The bot cannot see the floor at (10, 63, 0) and walks; the walk ends standing in the target.
  bot.entity.position = new Vec3(7.5, 64, 0.5);
  bot.canSeeBlock = () => false;
  bot.pathfinder.goto = sinon.stub().callsFake(async () => { bot.entity.position = new Vec3(10.5, 64, 0.5); });
  const walkedIn = await s.call('place-block', { x: 10, y: 64, z: 0 });
  t.true(walkedIn.isError);
  t.is(walkedIn.text, SELF_CELL);
  t.false(bot.placeBlock.called, 'nothing placed');
});

test.serial('E-031: place-block on a cell that holds a block is an error; cave_air and void_air are not a block there', async (t) => {
  useClock(t);
  const bot = fakeBot({ '3,64,0': 'dirt', '3,63,0': 'stone', '2,64,0': 'cave_air', '2,63,0': 'stone', '-2,64,0': 'void_air', '-2,63,0': 'stone' });
  const s = await serve(t, bot);

  const filled = await s.call('place-block', { x: 3, y: 64, z: 0 });
  t.true(filled.isError);
  t.is(filled.text, 'Failed: There\'s already a block (dirt) at (3, 64, 0)');
  t.false(bot.placeBlock.called);
  t.false(bot.pathfinder.goto.called, 'no walk to a cell that is already filled');

  for (const x of [2, -2]) {
    const cave = await s.call('place-block', { x, y: 64, z: 0 });
    t.false(cave.isError, cave.text);
    t.true(cave.text.startsWith(`Placed block at (${x}, 64, 0)`), cave.text);
  }
  t.is(bot.placeBlock.callCount, 2, 'placed into the cave_air and into the void_air');
});

test.serial('E-031: place-block with nothing to place against is an error that does not read "Failed: Failed to"', async (t) => {
  useClock(t);
  // The floor at (2, 63, 0) is in reach and in sight, so no walk.
  const bot = fakeBot({ '2,63,0': 'stone' });
  const s = await serve(t, bot);

  // All six neighbours are air.
  const none = await s.call('place-block', { x: 3, y: 64, z: 0 });
  t.true(none.isError);
  t.is(none.text, 'Failed: Could not place a block at (3, 64, 0): no suitable reference block found');

  // The only neighbour is the floor, and placing against it fails: the reply keeps the last error.
  bot.placeBlock.rejects(new Error('No block has been placed : the block is still air'));
  const failed = await s.call('place-block', { x: 2, y: 64, z: 0 });
  t.true(failed.isError);
  t.is(failed.text, 'Failed: Could not place a block at (2, 64, 0): no suitable reference block found (last error: No block has been placed : the block is still air)');
  t.false(failed.text.includes('Failed: Failed'));
  t.true(bot.placeBlock.calledOnce, 'tried against the floor');
  t.false(bot.pathfinder.goto.called);
});

test.serial('E-031: dig-block on a block that is not loaded is an error; on air, cave_air included, it is still a success', async (t) => {
  useClock(t);
  const bot = fakeBot({ '4,64,0': 'cave_air' });
  // Past x 100 the chunk is not loaded: mineflayer's blockAt gives null.
  const loaded = bot.blockAt;
  Object.assign(bot, { blockAt: (pos: Vec3) => (pos.x >= 100 ? null : loaded(pos)) });
  const s = await serve(t, bot);

  const unloaded = await s.call('dig-block', { x: 100, y: 64, z: 0 });
  t.true(unloaded.isError);
  t.is(unloaded.text, 'Failed: The block at (100, 64, 0) is not loaded (beyond what the bot can see)');

  for (const x of [3, 4]) {
    const air = await s.call('dig-block', { x, y: 64, z: 0 });
    t.false(air.isError, air.text);
    t.is(air.text, `No block found at position (${x}, 64, 0)`);
  }
  t.false(bot.dig.called);
  t.false(bot.pathfinder.goto.called);
});

type Stack = { name: string; count: number; type: number; stackSize?: number };
const RAW_IRON: Stack = { name: 'raw_iron', count: 2, type: 1 };
const COAL: Stack = { name: 'coal', count: 3, type: 5 };

/**
 * A furnace window whose input and fuel slots hold `input` and `fuel`; nothing ever comes out of it. The bot's part
 * of the window (slots 3-38) has `emptySlots` empty slots, the rest is full of cobblestone.
 */
function fakeFurnace({ input = null, fuel = null, emptySlots = 36 }: { input?: Stack | null; fuel?: Stack | null; emptySlots?: number } = {}) {
  let fuelSlot = fuel;
  const filler = Array.from({ length: 36 - emptySlots }, () => ({ name: 'cobblestone', count: 64, type: 99, stackSize: 64 }));
  return Object.assign(new EventEmitter(), {
    inventoryStart: 3,
    inventoryEnd: 39,
    slots: [null, null, null, ...filler, ...Array(emptySlots).fill(null)],
    inputItem: () => input,
    fuelItem: () => fuelSlot,
    outputItem: () => null,
    takeFuel: sinon.stub().callsFake(async () => {
      const taken = fuelSlot;
      fuelSlot = null;
      return taken;
    }),
    putFuel: sinon.stub().resolves(),
    putInput: sinon.stub().resolves(),
    takeOutput: sinon.stub().resolves(null),
    close: sinon.stub()
  });
}

/** A bot next to a furnace at (5, 64, 0) (or none, with `furnaceBlock` 'air') that opens `furnace`. */
function smeltBot(furnace: ReturnType<typeof fakeFurnace>, items: Stack[] = [RAW_IRON, COAL], furnaceBlock = 'furnace') {
  const bot = fakeBot({ '5,64,0': furnaceBlock });
  bot.inventory.items = () => items;
  return Object.assign(bot, { openFurnace: sinon.stub().resolves(furnace) });
}

const SMELT = { x: 5, y: 64, z: 0, inputItem: 'raw_iron', fuelItem: 'coal' };

test.serial('E-031: smelt-item without a furnace, input or fuel, or with a slot in the way is an error, and the text is as before', async (t) => {
  useClock(t);
  const cases: { what: string; furnace: ReturnType<typeof fakeFurnace>; items?: Stack[]; block?: string; text: string; opened: boolean }[] = [
    { what: 'no furnace', furnace: fakeFurnace(), block: 'air', text: 'Failed: No furnace block found at (5, 64, 0)', opened: false },
    { what: 'no input', furnace: fakeFurnace(), items: [COAL], text: 'Failed: Couldn\'t find any item matching \'raw_iron\' in inventory', opened: false },
    { what: 'no fuel', furnace: fakeFurnace(), items: [RAW_IRON], text: 'Failed: Couldn\'t find any fuel item matching \'coal\' in inventory', opened: false },
    { what: 'input slot', furnace: fakeFurnace({ input: { name: 'sand', count: 4, type: 12 } }), text: 'Failed: Furnace input slot is occupied by sand', opened: true },
    {
      what: 'fuel slot',
      furnace: fakeFurnace({ fuel: { name: 'oak_planks', count: 10, type: 7, stackSize: 64 }, emptySlots: 0 }),
      text: 'Failed: Furnace fuel slot holds 10 oak_planks and it could not be taken out (the inventory is full): pass fuelItem \'oak_planks\' to smelt with it, or make room in the inventory',
      opened: true
    }
  ];
  for (const { what, furnace, items, block, text, opened } of cases) {
    const bot = smeltBot(furnace, items, block);
    const s = await serve(t, bot);
    const reply = await s.call('smelt-item', SMELT);
    t.true(reply.isError, what);
    t.is(reply.text, text, what);
    t.is(bot.openFurnace.called, opened, what);
    t.false(furnace.putInput.called, `${what}: nothing put in`);
    t.false(furnace.putFuel.called, `${what}: no fuel put in`);
    if (opened) t.true(furnace.close.calledOnce, `${what}: the furnace window is closed`);
  }
});

test.serial('E-031: smelt-item with no output in time is an error that says the input and fuel are in the furnace and where', async (t) => {
  const clock = useClock(t);
  const furnace = fakeFurnace();
  const s = await serve(t, smeltBot(furnace));

  const pending = track(s.call('smelt-item', { ...SMELT, timeoutMs: 1000 }));
  await clock.tickAsync(1500);
  t.true(pending.settled);
  t.true(pending.reply!.isError);
  t.is(pending.reply!.text, 'Failed: No output after 1000ms; the input and fuel are in the furnace at (5, 64, 0)');
  t.true(furnace.putInput.calledOnce, 'the input went in');
  t.true(furnace.putFuel.calledOnce, 'the fuel went in');

  // Leftover fuel of another kind taken out first: the reply still says where the input and fuel are, and keeps the
  // took-out note (the contract does not fix the order of the two).
  const leftover = fakeFurnace({ fuel: { name: 'oak_planks', count: 3, type: 7, stackSize: 64 } });
  const again = await serve(t, smeltBot(leftover));
  const tookOut = track(again.call('smelt-item', { ...SMELT, timeoutMs: 1000 }));
  await clock.tickAsync(1500);
  t.true(tookOut.settled);
  t.true(tookOut.reply!.isError);
  t.true(tookOut.reply!.text.startsWith('Failed: No output after 1000ms; the input and fuel are in the furnace at (5, 64, 0)'), tookOut.reply!.text);
  t.true(tookOut.reply!.text.includes('; took 3 oak_planks out of the fuel slot first'), tookOut.reply!.text);
});

test.serial('E-031: equip-item with an item that is not in the inventory is an error', async (t) => {
  useClock(t);
  const bot = fakeBot();
  const s = await serve(t, bot);

  const reply = await s.call('equip-item', { itemName: 'diamond_sword', destination: 'hand' });
  t.true(reply.isError);
  t.is(reply.text, 'Failed: Couldn\'t find any item matching \'diamond_sword\' in inventory');
  t.false(bot.equip.called);
});

test.serial('E-031: still successes, so the rule does not grow: find-item that finds nothing, unequip-item on an empty slot, wake when not sleeping, dismount when not riding', async (t) => {
  useClock(t);
  const bot = Object.assign(fakeBot(), {
    isSleeping: false,
    wake: sinon.stub().resolves(),
    vehicle: null,
    dismount: sinon.stub(),
    unequip: sinon.stub().resolves(),
    getEquipmentDestSlot: () => 5
  });
  Object.assign(bot.inventory, { slots: Array(46).fill(null) });
  const s = await serve(t, bot);

  for (const [name, args, text] of [
    ['find-item', { nameOrType: 'diamond' }, 'Couldn\'t find any item matching \'diamond\' in inventory'],
    ['unequip-item', { destination: 'head' }, 'Nothing equipped in \'head\''],
    ['wake', {}, 'Not sleeping'],
    ['dismount', {}, 'Not riding anything']
  ] as const) {
    const reply = await s.call(name, args);
    t.false(reply.isError, `${name}: ${reply.text}`);
    t.is(reply.text, text, name);
  }
  t.false(bot.unequip.called);
  t.false(bot.wake.called);
  t.false(bot.dismount.called);
});

// ---------------------------------------------------------------------------------------------------------------
// E-038: long tools get a default time limit within the call budget, the default limit being what is left of the
// budget less REPLY_MARGIN_MS (about 45 s), and hand long work to the background task (Q27). collect-block and
// lead-animal reply "Still …" and leave their task running; the moves stop after about 35 s; the region tools after
// about 45 s; smelt-item's wait and move-in-direction's duration are capped. An explicit timeoutMs is kept and moves
// the watchdog. --call-limit-seconds sets the budget through the factory's options (its parsing is in config.test.ts).
// ---------------------------------------------------------------------------------------------------------------

const STILL_WAIT = "Wait for it with wait-for-event types ['task_done', 'task_failed', 'task_cancelled'] (list-tasks shows whether it has already ended)";
const still = (verb: string, id: string, behavior: string, state: string) =>
  `Still ${verb} after 45 s: task ${id} ${behavior} ${state}. ${STILL_WAIT}; stop it with cancel-task ${id}`;

test.serial('E-038: the default limit is the 50 s budget less a 5 s reply margin, and the moves leave 10 s more for a portal', (t) => {
  t.is(CALL_LIMIT_MS, 50000);
  t.is(REPLY_MARGIN_MS, 5000);
  t.is(PORTAL_WAIT_MS, 10000);
});

/**
 * collect-block on a real TaskManager: oak logs at `logs` (x,y,z keys). The bot digs those `visible` lets it see from
 * where it stands; its walk to any other never ends (a stop makes it reject, as the real pathfinder's does).
 */
async function gatherServe(t: ExecutionContext, logs: string[], visible: (x: number) => boolean) {
  const world = createFakeWorld(Object.fromEntries(logs.map(cell => [cell, 'oak_log'])));
  const logId = minecraftData('1.20.4').blocksByName.oak_log.id;
  world.bot.findBlocks.callsFake(({ matching, count }: { matching: number; count: number }) => (matching === logId
    ? [...world.blocks.entries()].filter(([, name]) => name === 'oak_log').map(([cell]) => world.keyToVec(cell))
      .sort((a, b) => a.distanceTo(world.bot.entity.position) - b.distanceTo(world.bot.entity.position)).slice(0, count)
    : []));
  Object.assign(world.bot, { canSeeBlock: (block: { position: Vec3 }) => visible(block.position.x) });
  const pending: ((error: Error) => void)[] = [];
  world.bot.pathfinder.goto = sinon.stub().callsFake(() => new Promise((_, reject) => pending.push(reject)));
  world.bot.pathfinder.stop = sinon.stub().callsFake(() => { for (const reject of pending.splice(0)) reject(new Error(STOPPED)); });
  const taskEvents = new EventStore();
  let tasks: TaskManager | null = null;
  const s = await serve(t, world.bot, (factory, stand) => {
    tasks = new TaskManager({ getBot: () => world.bot as never, getArbiter: () => stand.arbiter as ActionArbiter, events: taskEvents, behaviors: BEHAVIORS });
    stand.tasks = tasks;
    registerGatheringTools(factory, () => stand as unknown as Autopilot);
  });
  return { ...s, world, tasks: tasks! as TaskManager, taskEvents };
}

/** Cancels a task a test left running, and lets the cancel finish on the fake clock. */
async function cancelLeftOver(clock: sinon.SinonFakeTimers, tasks: TaskManager) {
  const cancelling = tasks.cancelAll('test over');
  await clock.tickAsync(3000);
  await cancelling;
}

test.serial('E-038 (1): collect-block whose task is still going at the default limit replies "Still collecting" with its progress, and the task keeps running', async (t) => {
  const clock = useClock(t);
  // The first log is dug where the bot stands; the walk to the second never ends.
  const s = await gatherServe(t, ['1,64,0', '6,64,0'], x => x === 1);

  const pending = track(s.call('collect-block', { blockType: 'oak_log', count: 2 }));
  await clock.tickAsync(44900);
  t.false(pending.settled, 'still waiting just before the default limit');
  const task = s.tasks.currentTask()!;
  t.is(task.status, 'running');
  t.is(task.progress, 'mined 1 of 2 oak_log');

  await clock.tickAsync(200);
  t.true(pending.settled, 'replied at the default limit, not at the task\'s own 120 s');
  const reply = pending.reply!;
  t.false(reply.rejected);
  t.false(reply.isError, reply.text);
  t.is(reply.text, still('collecting', task.id, 'gather', 'keeps running in the background (mined 1 of 2 oak_log)'));
  t.true(reply.text.startsWith('Still collecting after'));
  t.false(reply.text.includes('did not finish within'), 'no watchdog: collect-block replies by itself');
  for (const part of [task.id, 'task_done', 'task_failed', 'task_cancelled', 'list-tasks', `cancel-task ${task.id}`]) {
    t.true(reply.text.includes(part), part);
  }
  t.is(s.tasks.currentTask()?.id, task.id, 'the task is still the current one');
  t.is(s.tasks.currentTask()?.status, 'running');
  t.deepEqual(s.tasks.list().history, [], 'nothing was cancelled');
  t.deepEqual(s.taskEvents.query({ types: ['task_cancelled'] }).events, []);
  t.false(s.world.bot.pathfinder.stop.called, 'the task\'s walk was not stopped');
  t.is(s.factory.inFlight().length, 0, 'the call is over');

  // The task goes on after the reply.
  await clock.tickAsync(30000);
  t.is(s.tasks.currentTask()?.status, 'running');
  await cancelLeftOver(clock, s.tasks);
});

test.serial('E-038 (1): collect-block keeps the line about the task it replaced in the "Still collecting" reply', async (t) => {
  const clock = useClock(t);
  const s = await gatherServe(t, ['1,64,0', '6,64,0'], x => x === 1);
  // A follow task that is still going when collect-block starts.
  Object.assign(s.world.bot, { entities: { 2: { id: 2, name: 'cow', type: 'animal', position: new Vec3(3.5, 64, 0.5), height: 1.4, isValid: true } } });
  t.true((await s.tasks.start('follow', { entityId: 2 })).ok);
  await clock.tickAsync(500);
  t.is(s.tasks.currentTask()?.behavior, 'follow');

  const pending = track(s.call('collect-block', { blockType: 'oak_log', count: 2 }));
  await clock.tickAsync(45100);
  t.true(pending.settled);
  const reply = pending.reply!;
  t.false(reply.isError, reply.text);
  const task = s.tasks.currentTask()!;
  t.is(task.behavior, 'gather');
  t.is(task.status, 'running');
  const [first, ...rest] = reply.text.split('\n');
  t.is(first, still('collecting', task.id, 'gather', 'keeps running in the background (mined 1 of 2 oak_log)'));
  t.regex(rest.join('\n'), /^Replaced task t\d+ follow \(.*\): it was cancelled\.$/);
  t.deepEqual(s.tasks.list().history.map(entry => `${entry.behavior} ${entry.status}`), ['follow cancelled'], 'only the replaced task ended');
  await cancelLeftOver(clock, s.tasks);
});

test.serial('E-038 (1): a task held at the default limit is reported as paused, with the reason (before, the call waited until the time limit)', async (t) => {
  const clock = useClock(t);
  const s = await gatherServe(t, ['6,64,0'], () => false);

  const pending = track(s.call('collect-block', { blockType: 'oak_log' }));
  await clock.tickAsync(1000);
  t.true(s.tasks.hold('held by the instinct after dig_in: the bot is walled in').ok);
  await clock.tickAsync(44100);

  t.true(pending.settled);
  const reply = pending.reply!;
  t.false(reply.isError, reply.text);
  const task = s.tasks.currentTask()!;
  t.is(task.status, 'paused');
  t.is(reply.text, still('collecting', task.id, 'gather',
    'is paused (held by the instinct after dig_in: the bot is walled in (waiting for resume-task or cancel-task))'));
  t.deepEqual(s.tasks.list().history, [], 'still held, not cancelled');
  await cancelLeftOver(clock, s.tasks);
});

test.serial('E-038 (1): a task queued behind the instinct at the default limit is paused with the holder named, and runs to the end afterwards', async (t) => {
  const clock = useClock(t);
  const s = await gatherServe(t, ['1,64,0'], () => true);
  const urgent = await s.arbiter.acquire({ holder: 'instinct leave_lava', priority: PRIORITY.URGENT_INSTINCT });
  t.true(urgent.ok);
  if (!urgent.ok) return;

  // The default timeoutMs (120 s) plus 5 s comes after the default limit: the task is not cancelled.
  const pending = track(s.call('collect-block', { blockType: 'oak_log' }));
  await clock.tickAsync(45100);
  t.true(pending.settled);
  const task = s.tasks.currentTask()!;
  t.false(pending.reply!.isError, pending.reply!.text);
  t.is(pending.reply!.text, still('collecting', task.id, 'gather', 'is paused (waiting for instinct leave_lava)'));
  t.true(urgent.lease.isActive(), 'the holder keeps the body');

  // Once the instinct lets go the task runs and ends, which is what wait-for-event then reports.
  urgent.lease.release();
  await clock.tickAsync(5000);
  const record = s.tasks.list().history.find(entry => entry.id === task.id);
  t.is(record?.status, 'done');
  t.true(record?.result?.startsWith('Mined 1 of 1 oak_log'), record?.result);
  t.is(s.taskEvents.query({ types: ['task_done'] }).events.length, 1);
});

test.serial('E-038 (1): with timeoutMs 1000 and the task queued the whole time, collect-block still cancels it after about 6 s (time limit reached)', async (t) => {
  const clock = useClock(t);
  const s = await gatherServe(t, ['1,64,0'], () => true);
  const urgent = await s.arbiter.acquire({ holder: 'instinct leave_lava', priority: PRIORITY.URGENT_INSTINCT });
  t.true(urgent.ok);
  if (!urgent.ok) return;

  const pending = track(s.call('collect-block', { blockType: 'oak_log', timeoutMs: 1000 }));
  await clock.tickAsync(5900);
  t.false(pending.settled, 'still waiting before timeoutMs + 5 s');
  const task = s.tasks.currentTask()!;
  t.is(task.status, 'paused');

  await clock.tickAsync(400);
  t.true(pending.settled);
  const reply = pending.reply!;
  t.true(reply.isError);
  t.true(reply.text.includes(`task ${task.id} was cancelled (time limit reached)`), reply.text);
  t.false(reply.text.includes('Still'), reply.text);
  const record = s.tasks.list().history.find(entry => entry.id === task.id);
  t.is(record?.status, 'cancelled');
  t.is(record?.result, 'time limit reached');
  t.true(urgent.lease.isActive(), 'cancelling the queued task does not touch the holder\'s body');
  t.false(s.world.bot.pathfinder.stop.called);
  urgent.lease.release();
});

/**
 * lead-animal on a real TaskManager: a cow next to the bot and wheat to lure it with, 20 blocks from the target. Each
 * stride takes 10 s and the cow follows 2.5 blocks behind, so the lead makes progress (no "stopped following") and is
 * still going at 45 s. `onStride` runs at the end of each stride, before the cow catches up.
 */
async function leadServe(t: ExecutionContext, onStride: (bot: ReturnType<typeof fakeBot>) => void = () => {}) {
  const bot = fakeBot();
  const cow = { id: 2, name: 'cow', type: 'animal', position: new Vec3(2.5, 64, 0.5), height: 1.4, isValid: true };
  bot.entities = { 2: cow };
  bot.inventory.items = () => [{ name: 'wheat', count: 5, type: 900 }];
  bot.pathfinder.goto = sinon.stub().callsFake((goal: { x: number; y: number; z: number; rangeSq: number }) =>
    new Promise<void>(resolve => setTimeout(() => {
      const target = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5);
      const range = Math.sqrt(goal.rangeSq);
      const here = bot.entity.position;
      const distance = here.distanceTo(target);
      if (distance > range) bot.entity.position = target.plus(here.minus(target).scaled(range / distance));
      onStride(bot);
      const away = cow.position.minus(bot.entity.position);
      cow.position = bot.entity.position.plus(away.scaled(2.5 / (away.norm() || 1)));
      resolve();
    }, 10000)));
  let tasks: TaskManager | null = null;
  const s = await serve(t, bot, (factory, stand) => {
    tasks = new TaskManager({ getBot: () => bot as never, getArbiter: () => stand.arbiter as ActionArbiter, events: new EventStore(), behaviors: BEHAVIORS });
    stand.tasks = tasks;
    registerGatheringTools(factory, () => stand as unknown as Autopilot);
  });
  return { ...s, bot, manager: tasks! as TaskManager };
}

test.serial('E-038 (1): lead-animal whose task is still going replies "Still leading" with its progress, keeps the line about the task it replaced, and the task keeps running', async (t) => {
  const clock = useClock(t);
  const { manager, ...s } = await leadServe(t);
  const follow = await manager.start('follow', { entityId: 2 });
  t.true(follow.ok);
  await clock.tickAsync(500);

  const pending = track(s.call('lead-animal', { entityId: 2, x: 20, y: 64, z: 0 }));
  await clock.tickAsync(44900);
  t.false(pending.settled, 'still waiting just before the default limit');
  await clock.tickAsync(200);
  t.true(pending.settled);
  const reply = pending.reply!;
  t.false(reply.isError, reply.text);
  const task = manager.currentTask()!;
  t.is(task.behavior, 'lead');
  t.is(task.status, 'running');
  const detail = task.progress ?? task.step;
  t.truthy(detail, 'the lead task reports what it is doing');
  const [first, ...rest] = reply.text.split('\n');
  t.is(first, still('leading', task.id, 'lead', `keeps running in the background (${detail})`));
  t.regex(rest.join('\n'), /^Replaced task t\d+ follow \(.*\): it was cancelled\.$/);
  t.deepEqual(manager.list().history.map(entry => `${entry.behavior} ${entry.status}`), ['follow cancelled'], 'only the replaced task ended');
  t.is(s.factory.inFlight().length, 0);

  // The lead goes on after the reply and ends by itself, which is what wait-for-event then reports.
  await clock.tickAsync(30000);
  const record = manager.list().history.find(entry => entry.id === task.id);
  t.is(record?.status, 'done', record?.result);
  t.regex(record?.result ?? '', /^Led cow \(id 2\) to \(20, 64, 0\) by lure \(wheat\)/);
  await cancelLeftOver(clock, manager);
});

test.serial('E-038 (1), E-049: the "Still leading" reply lists the blocks the pathfinder placed so far, on its first line', async (t) => {
  const clock = useClock(t);
  let strides = 0;
  // Scaffolding on the first stride, as the pathfinder did inside the pen in the M18 field test.
  const { manager, bot, ...s } = await leadServe(t, lead => {
    if (strides++ === 0) lead.emit('blockPlaced', null, { name: 'cobblestone', position: new Vec3(5, 64, 0) });
  });

  const pending = track(s.call('lead-animal', { entityId: 2, x: 20, y: 64, z: 0 }));
  await clock.tickAsync(45100);
  t.true(pending.settled);
  const reply = pending.reply!;
  t.false(reply.isError, reply.text);
  const task = manager.currentTask()!;
  t.is(task.status, 'running');
  const detail = task.progress ?? task.step;
  t.is(reply.text, `${still('leading', task.id, 'lead', `keeps running in the background (${detail})`)}; on the way the pathfinder placed 1 block(s): cobblestone at (5, 64, 0)`);
  t.is(bot.listenerCount('blockPlaced'), 0, 'the watch stopped with the call');
  await cancelLeftOver(clock, manager);
});

const farWaypoint = { x: 40, y: 64, z: 0, createdAt: 0 };
const waypointStand = { get: () => farWaypoint, normalizeName: (name: string) => name.trim().toLowerCase() } as unknown as WaypointStore;
const MOVES = [['move-to-position', { x: 40, y: 64, z: 0 }], ['goto-waypoint', { name: 'far' }]] as const;

for (const [tool, args] of MOVES) {
  test.serial(`E-038 (2): ${tool} without timeoutMs stops after about 35 s, says where and how far from the target, and stops the pathfinder`, async (t) => {
    const clock = useClock(t);
    const bot = fakeBot();
    // A stand-in store, so nothing is written to disk.
    const s = await serve(t, bot, factory => registerWaypointTools(factory, () => bot as never, waypointStand));

    const pending = track(s.call(tool, args));
    await clock.tickAsync(34900);
    t.false(pending.settled, 'still walking just before 35 s');
    t.false(bot.pathfinder.stop.called);

    await clock.tickAsync(200);
    t.true(pending.settled);
    const reply = pending.reply!;
    t.false(reply.rejected);
    t.true(reply.isError);
    t.is(reply.text, `Failed: Move timed out after 35000ms at (0, 64, 0), 40.0 blocks from the target; call ${tool} again to continue`);
    t.true(bot.pathfinder.stop.calledOnce, 'the move stopped the pathfinder');
    t.true(bot.pathfinder.setGoal.calledWith(null));
    t.is(s.arbiter.holder(), null, 'the lease is released');
    t.deepEqual(s.commandEvents(), []);
  });

  test.serial(`E-038 (2): ${tool} with timeoutMs 60000 is stopped neither at 35 s nor by the watchdog at 50 s, and times out at 60 s`, async (t) => {
    const clock = useClock(t);
    const bot = fakeBot();
    const s = await serve(t, bot, factory => registerWaypointTools(factory, () => bot as never, waypointStand));

    const pending = track(s.call(tool, { ...args, timeoutMs: 60000 }));
    await clock.tickAsync(35100);
    t.false(pending.settled, 'not at 35 s');
    await clock.tickAsync(15000);
    t.false(pending.settled, 'not at 50 s either: the watchdog was moved');
    t.false(bot.pathfinder.stop.called);
    t.is(s.arbiter.holder()?.holder, `manual ${tool}`);

    await clock.tickAsync(10000);
    t.true(pending.settled);
    t.is(pending.reply!.text, `Failed: Move timed out after 60000ms at (0, 64, 0), 40.0 blocks from the target; call ${tool} again to continue`);
    t.true(bot.pathfinder.stop.calledOnce);
    t.is(s.arbiter.holder(), null);
  });
}

test.serial('E-038 (2): a move that arrives within the default limit replies as before', async (t) => {
  const clock = useClock(t);
  const bot = fakeBot();
  bot.pathfinder.goto = sinon.stub().callsFake(() => new Promise<void>(resolve => setTimeout(() => {
    bot.entity.position = new Vec3(3, 64, 0);
    resolve();
  }, 20000)));
  const s = await serve(t, bot);

  const pending = track(s.call('move-to-position', { x: 3, y: 64, z: 0 }));
  await clock.tickAsync(20100);
  t.true(pending.settled);
  t.false(pending.reply!.isError, pending.reply!.text);
  t.is(pending.reply!.text, 'Successfully moved to position near (3, 64, 0)');
  t.false(bot.pathfinder.stop.called);
});

test.serial('E-038 (2): the default limit is taken when the wait starts, so the wait for the lease counts: after 9.9 s queued a move stops about 35 s after the call', async (t) => {
  const clock = useClock(t);
  const bot = fakeBot();
  const s = await serve(t, bot);
  const urgent = await s.arbiter.acquire({ holder: 'instinct leave_lava', priority: PRIORITY.URGENT_INSTINCT });
  t.true(urgent.ok);
  if (!urgent.ok) return;

  const pending = track(s.call('move-to-position', { x: 40, y: 64, z: 0 }));
  await clock.tickAsync(9900);
  urgent.lease.release();
  await clock.tickAsync(0);
  t.true(bot.pathfinder.goto.calledOnce, 'the move got the lease');

  await clock.tickAsync(25000);
  t.false(pending.settled, 'still walking 34.9 s after the call');
  await clock.tickAsync(200);
  t.true(pending.settled);
  // 50 s less the 9.9 s in the queue, the reply margin and the portal wait.
  t.is(pending.reply!.text, 'Failed: Move timed out after 25100ms at (0, 64, 0), 40.0 blocks from the target; call move-to-position again to continue');
  t.is(s.arbiter.holder(), null);
});

test.serial('E-038 (4): a region tool that waited 9.9 s for the lease stops early on what is left of the budget, before the watchdog', async (t) => {
  const clock = useClock(t);
  const bot = slowDigger(SLAB);
  const s = await serve(t, bot);
  const urgent = await s.arbiter.acquire({ holder: 'instinct leave_lava', priority: PRIORITY.URGENT_INSTINCT });
  t.true(urgent.ok);
  if (!urgent.ok) return;

  const pending = track(s.call('clear-region', CLEAR_SLAB));
  await clock.tickAsync(9900);
  urgent.lease.release();
  await clock.tickAsync(0);
  // The limit ends 45 s after the call; the cell started at 41.9 s ends at 45.9 s.
  await clock.tickAsync(35900);
  t.false(pending.settled);
  await clock.tickAsync(200);
  t.true(pending.settled);
  t.false(pending.reply!.isError, pending.reply!.text);
  t.is(pending.reply!.text, 'Cleared region of 24 blocks: dug 9, already empty 0. Stopped early with 15 block(s) not processed; run again to continue');
  t.is(s.arbiter.holder(), null);
});

test.serial('E-038 (2): an explicit timeoutMs moves the watchdog by the portal wait as well: a move that reaches a portal at 58 s of 60 still waits its 10 s there', async (t) => {
  const clock = useClock(t);
  const bot = fakeBot({ '3,64,0': 'nether_portal' });
  bot.pathfinder.goto = sinon.stub().callsFake(() => new Promise<void>(resolve => setTimeout(() => {
    bot.entity.position = new Vec3(3.5, 64, 0.5);
    resolve();
  }, 58000)));
  const s = await serve(t, bot);

  const pending = track(s.call('move-to-position', { x: 3, y: 64, z: 0, timeoutMs: 60000 }));
  await clock.tickAsync(66000);
  t.false(pending.settled, 'past timeoutMs plus the reply margin, and still waiting in the portal');
  t.is(s.arbiter.holder()?.holder, 'manual move-to-position');

  await clock.tickAsync(2100);
  t.true(pending.settled);
  const reply = pending.reply!;
  t.false(reply.isError, reply.text);
  t.true(reply.text.startsWith('Successfully moved to position near (3, 64, 0); stood in the portal for 10 s'), reply.text);
  t.false(reply.text.includes('did not finish within'), reply.text);
});

/** Stone at `cells` that the bot can dig from where it stands; each dig takes 4 s. */
function slowDigger(cells: string[]) {
  const bot = fakeBot(Object.fromEntries(cells.map(cell => [cell, 'stone'])));
  const dig = bot.dig;
  bot.dig = sinon.stub().callsFake(async (block: { position: Vec3 }) => {
    await new Promise(resolve => setTimeout(resolve, 4000));
    await dig(block);
  });
  return bot;
}

// 24 cells: x 2 to 7, y 64 to 67.
const SLAB = Array.from({ length: 24 }, (_, i) => `${2 + (i % 6)},${64 + Math.floor(i / 6)},0`);
const CLEAR_SLAB = { x1: 2, y1: 64, z1: 0, x2: 7, y2: 67, z2: 0 };

test.serial('E-038 (4): clear-region without timeoutMs stops early after about 45 s (was 120 s) with its usual counts, before the watchdog', async (t) => {
  const clock = useClock(t);
  const bot = slowDigger(SLAB);
  const s = await serve(t, bot);

  const pending = track(s.call('clear-region', CLEAR_SLAB));
  await clock.tickAsync(44900);
  t.false(pending.settled, 'the limit is checked before each cell, and it has not passed yet');
  // The cell started at 44 s ends at 48 s; then the limit has passed.
  await clock.tickAsync(3200);
  t.true(pending.settled);
  const reply = pending.reply!;
  t.false(reply.isError, reply.text);
  t.is(reply.text, 'Cleared region of 24 blocks: dug 12, already empty 0. Stopped early with 12 block(s) not processed; run again to continue');
  t.is(bot.dig.callCount, 12);
  t.is(s.arbiter.holder(), null);
});

test.serial('E-038 (4): dig-tunnel without timeoutMs stops early after about 45 s as well', async (t) => {
  const clock = useClock(t);
  // Next to the bot at (0, 64, 0): x 1 to 12, two high.
  const bot = slowDigger(Array.from({ length: 24 }, (_, i) => `${1 + (i >> 1)},${64 + (i % 2)},0`));
  const s = await serve(t, bot);

  const pending = track(s.call('dig-tunnel', { direction: 'east', length: 12 }));
  await clock.tickAsync(48100);
  t.true(pending.settled);
  t.false(pending.reply!.isError, pending.reply!.text);
  t.is(pending.reply!.text, 'Dug east tunnel 12x1x2: dug 12, already empty 0. Stopped early with 12 block(s) not processed; run again to continue');
});

test.serial('E-038 (4): clear-region with an explicit timeoutMs 70000 runs past 50 s, the watchdog moved, and stops on its own limit', async (t) => {
  const clock = useClock(t);
  const bot = slowDigger(SLAB);
  const s = await serve(t, bot);

  const pending = track(s.call('clear-region', { ...CLEAR_SLAB, timeoutMs: 70000 }));
  await clock.tickAsync(50100);
  t.false(pending.settled, 'not stopped at 50 s');
  t.is(s.arbiter.holder()?.holder, 'manual clear-region');

  // The cell started at 68 s ends at 72 s.
  await clock.tickAsync(22000);
  t.true(pending.settled);
  t.false(pending.reply!.isError, pending.reply!.text);
  t.is(pending.reply!.text, 'Cleared region of 24 blocks: dug 18, already empty 0. Stopped early with 6 block(s) not processed; run again to continue');
});

test.serial('E-038 (4): an explicit timeoutMs too long for a timer still moves the watchdog, instead of firing it at once', async (t) => {
  const clock = useClock(t);
  const bot = slowDigger(SLAB);
  const s = await serve(t, bot);

  // setTimeout cannot wait longer than 2^31 - 1 ms and fires such a timer after 1 ms.
  const pending = track(s.call('clear-region', { ...CLEAR_SLAB, timeoutMs: 3000000000 }));
  await clock.tickAsync(50100);
  t.false(pending.settled, 'stopped neither at once nor at 50 s');
  t.is(s.arbiter.holder()?.holder, 'manual clear-region');

  // 24 cells of 4 s each.
  await clock.tickAsync(46000);
  t.true(pending.settled);
  t.false(pending.reply!.isError, pending.reply!.text);
  t.is(pending.reply!.text, 'Cleared region of 24 blocks: dug 24, already empty 0');
  t.is(s.arbiter.holder(), null);
});

/**
 * A row of 24 empty cells, x 2 to 25 at y 64, each on stone, and dirt in the hand. Every walk arrives at once, and
 * placing a block takes 4 s.
 */
function slowPlacer() {
  const bot = fakeBot(Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`${2 + i},63,0`, 'stone'])));
  bot.inventory.items = () => [{ name: 'dirt', count: 64, type: 1 }];
  bot.heldItem = { name: 'dirt' };
  bot.pathfinder.goto = sinon.stub().resolves();
  bot.placeBlock = sinon.stub().callsFake(() => new Promise<void>(resolve => setTimeout(resolve, 4000)));
  return bot;
}

const FILL_ROW = { x1: 2, y1: 64, z1: 0, x2: 25, y2: 64, z2: 0, blockName: 'dirt' };

test.serial('E-038 (4): fill-region without timeoutMs stops early after about 45 s with its usual counts, before the watchdog', async (t) => {
  const clock = useClock(t);
  const bot = slowPlacer();
  const s = await serve(t, bot);

  const pending = track(s.call('fill-region', FILL_ROW));
  await clock.tickAsync(44900);
  t.false(pending.settled, 'the limit is checked before each space, and it has not passed yet');
  // The space started at 44 s is filled at 48 s; then the limit has passed.
  await clock.tickAsync(3200);
  t.true(pending.settled);
  const reply = pending.reply!;
  t.false(reply.isError, reply.text);
  t.is(reply.text, 'Filled region of 24 blocks with dirt: placed 12, already occupied 0. Stopped early with 12 space(s) not processed; run again to continue');
  t.is(bot.placeBlock.callCount, 12);
  t.is(s.arbiter.holder(), null);
});

test.serial('E-038 (4): fill-region with an explicit timeoutMs 70000 runs past 50 s, the watchdog moved, and stops on its own limit', async (t) => {
  const clock = useClock(t);
  const bot = slowPlacer();
  const s = await serve(t, bot);

  const pending = track(s.call('fill-region', { ...FILL_ROW, timeoutMs: 70000 }));
  await clock.tickAsync(50100);
  t.false(pending.settled, 'not stopped at 50 s');
  t.is(s.arbiter.holder()?.holder, 'manual fill-region');

  // The space started at 68 s is filled at 72 s.
  await clock.tickAsync(22000);
  t.true(pending.settled);
  t.false(pending.reply!.isError, pending.reply!.text);
  t.is(pending.reply!.text, 'Filled region of 24 blocks with dirt: placed 18, already occupied 0. Stopped early with 6 space(s) not processed; run again to continue');
  t.is(s.arbiter.holder(), null);
});

/** A furnace that turns one input into one output every 10 s, as the game does, and says so with 'update'. */
function smeltingFurnace() {
  let input = 0;
  let output = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  const updates = new EventEmitter();
  return Object.assign(updates, {
    inventoryStart: 3,
    inventoryEnd: 39,
    slots: Array(39).fill(null),
    inputItem: () => (input ? { name: 'raw_iron', count: input, type: 1 } : null),
    fuelItem: () => null,
    outputItem: () => (output ? { name: 'iron_ingot', count: output, type: 2 } : null),
    putFuel: sinon.stub().resolves(),
    putInput: sinon.stub().callsFake(async (_type: number, _metadata: unknown, count: number) => {
      input += count;
      timer = setInterval(() => {
        if (input === 0) return;
        input--;
        output++;
        updates.emit('update');
      }, 10000);
    }),
    takeOutput: sinon.stub().callsFake(async () => {
      const taken = { name: 'iron_ingot', count: output, type: 2 };
      output = 0;
      return taken;
    }),
    close: sinon.stub().callsFake(() => clearInterval(timer))
  });
}

function smeltingBot() {
  const bot = fakeBot({ '5,64,0': 'furnace' });
  bot.inventory.items = () => [{ name: 'raw_iron', count: 8, type: 1 }, COAL];
  return Object.assign(bot, { openFurnace: sinon.stub().resolves(smeltingFurnace()) });
}

const SMELT_EIGHT = { ...SMELT, inputCount: 8 };

test.serial('E-038 (5): smelt-item waits at most the default limit (not 10 s per item plus 10 s), and says the furnace keeps smelting what is left', async (t) => {
  const clock = useClock(t);
  const s = await serve(t, smeltingBot());

  // 8 items would mean 90 s.
  const pending = track(s.call('smelt-item', SMELT_EIGHT));
  await clock.tickAsync(44900);
  t.false(pending.settled);
  await clock.tickAsync(200);
  t.true(pending.settled);
  t.false(pending.reply!.isError, pending.reply!.text);
  t.is(pending.reply!.text, 'Smelted 4 iron_ingot; 4 raw_iron still in the furnace (stopped after 45000ms); it keeps smelting in the furnace');
  t.true(pending.reply!.text.includes('keeps smelting'));
});

test.serial('E-038 (5): smelt-item with an explicit timeoutMs 65000 waits that long, the watchdog moved', async (t) => {
  const clock = useClock(t);
  const s = await serve(t, smeltingBot());

  const pending = track(s.call('smelt-item', { ...SMELT_EIGHT, timeoutMs: 65000 }));
  await clock.tickAsync(50100);
  t.false(pending.settled, 'not stopped at 50 s');
  await clock.tickAsync(15000);
  t.true(pending.settled);
  t.false(pending.reply!.isError, pending.reply!.text);
  t.is(pending.reply!.text, 'Smelted 6 iron_ingot; 2 raw_iron still in the furnace (stopped after 65000ms); it keeps smelting in the furnace');
});

test.serial('E-038 (3): move-in-direction with duration 60000 is cut to the default limit and the reply says so; a short one is as before', async (t) => {
  const clock = useClock(t);
  const bot = fakeBot();
  const s = await serve(t, bot);

  const pending = track(s.call('move-in-direction', { direction: 'forward', duration: 60000 }));
  await clock.tickAsync(44900);
  t.false(pending.settled);
  t.false(bot.setControlState.calledWith('forward', false));
  await clock.tickAsync(200);
  t.true(pending.settled);
  t.false(pending.reply!.isError, pending.reply!.text);
  t.is(pending.reply!.text, 'Moved forward for 45000ms (capped from 60000 ms: a reply must arrive within 50 s)');
  t.true(bot.setControlState.calledWith('forward', false), 'the key is let go');

  const short = track(s.call('move-in-direction', { direction: 'back', duration: 400 }));
  await clock.tickAsync(500);
  t.is(short.reply?.text, 'Moved back for 400ms');
});

test.serial('E-038 (6): with a 120 s call limit (--call-limit-seconds 120) the cap, the watchdog and the replies use 120 s', async (t) => {
  const clock = useClock(t);
  const bot = fakeBot({ '40,64,0': 'lever' });
  const s = await serve(t, bot, () => {}, { callLimitMs: 120000 });
  t.is(s.factory.callLimitMs, 120000);

  const capped = track(s.call('move-in-direction', { direction: 'forward', duration: 200000 }));
  await clock.tickAsync(115100);
  t.true(capped.settled);
  t.is(capped.reply!.text, 'Moved forward for 115000ms (capped from 200000 ms: a reply must arrive within 120 s)');

  // A body command whose walk never ends runs past 50 s and is stopped at 120 s.
  const walking = track(s.call('activate-block', { x: 40, y: 64, z: 0 }));
  await clock.tickAsync(60000);
  t.false(walking.settled, 'not stopped at 50 s');
  await clock.tickAsync(60100);
  t.true(walking.settled);
  t.is(walking.reply!.text, 'Failed: activate-block did not finish within 120 s, so it was stopped at (0, 64, 0); call it again to continue, or use start-task for long jobs');

  // A move's default is the limit less the reply margin and the portal wait.
  const moving = track(s.call('move-to-position', { x: 40, y: 64, z: 0 }));
  await clock.tickAsync(105100);
  t.true(moving.settled);
  t.true(moving.reply!.text.startsWith('Failed: Move timed out after 105000ms at (0, 64, 0)'), moving.reply!.text);
});

test.serial('E-038 (7): the tool descriptions give the new defaults, from the call limit', async (t) => {
  for (const [limit, seconds, rest, move] of [[undefined, 50, 45000, 35000], [120000, 120, 115000, 105000]] as const) {
    const bot = fakeBot();
    const s = await serve(t, bot, (factory, stand) => {
      registerWaypointTools(factory, () => bot as never, waypointStand);
      registerGatheringTools(factory, () => stand as unknown as Autopilot);
    }, { callLimitMs: limit });
    const { tools } = await s.client.listTools();
    const tool = (name: string) => tools.find(entry => entry.name === name)!;
    const parameter = (name: string, key: string) =>
      ((tool(name).inputSchema.properties ?? {}) as Record<string, { description?: string }>)[key]?.description ?? '';
    const within = `so that the reply arrives within ${seconds} s`;

    for (const name of ['move-to-position', 'goto-waypoint']) {
      t.true(parameter(name, 'timeoutMs').includes(`default: about ${move}, ${within}`), `${name}: ${parameter(name, 'timeoutMs')}`);
    }
    for (const name of ['clear-region', 'fill-region', 'dig-tunnel']) {
      t.true(parameter(name, 'timeoutMs').includes(`default: about ${rest}, ${within}`), `${name}: ${parameter(name, 'timeoutMs')}`);
      t.false(parameter(name, 'timeoutMs').includes('120000'), name);
    }
    t.true(parameter('smelt-item', 'timeoutMs').includes(`at most about ${rest}, ${within}`), parameter('smelt-item', 'timeoutMs'));
    t.true(parameter('move-in-direction', 'duration').includes(`at most about ${rest}, ${within}`), parameter('move-in-direction', 'duration'));
    for (const name of ['collect-block', 'lead-animal']) {
      t.true(tool(name).description?.includes(`at most about ${rest / 1000} s`), `${name}: ${tool(name).description}`);
      t.true(parameter(name, 'timeoutMs').includes(`the reply comes within about ${rest / 1000} s`), `${name}: ${parameter(name, 'timeoutMs')}`);
    }
    // The pinned main descriptions stay as they were.
    t.is(tool('smelt-item').description, 'Smelt items using a furnace-like block');
  }
});
