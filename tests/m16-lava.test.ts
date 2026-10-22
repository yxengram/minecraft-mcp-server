// Contract: docs/BLUEPRINT.md E-018 (M16): the pathfinder keeps away from lava, the instinct knows the bot is in lava
// when its collision box touches lava or the server burns it with lava, and body commands stop when the bot dies.
// Expected values come from E-018.
import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { configureMovements, LAVA_EDGE_COST } from '../src/tools/movement-utils.js';
import { inLavaNow } from '../src/autopilot/hazards.js';
import { LAVA_DAMAGE_CUE_MS, readCues } from '../src/autopilot/instinct/attention.js';
import { buildMenu } from '../src/autopilot/instinct/affordances.js';
import { assessThreats } from '../src/autopilot/threats.js';
import { PolicyStore } from '../src/autopilot/policy.js';
import minecraftData from 'minecraft-data';
import { ActionArbiter } from '../src/autopilot/action-arbiter.js';
import { TaskManager } from '../src/autopilot/task-manager.js';
import { EventStore } from '../src/event-store.js';
import { InstinctEngine } from '../src/autopilot/instinct/instinct-engine.js';
import type { DecisionResult } from '../src/decisions/openrouter-client.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';

const LAVA_ID = 37;
const policy = () => new PolicyStore().get();

/** A bot standing at `position` on stone (y 63), with lava in the given cells and air elsewhere. */
function lavaWorld(position: Vec3, lava: string[] = []) {
  const cells = new Set(lava);
  const name = (p: Vec3) => (cells.has(`${p.x},${p.y},${p.z}`) ? 'lava' : p.y <= 63 ? 'stone' : 'air');
  const self = { id: 1, position, onGround: true, metadata: [0, 300] as unknown[] };
  return {
    entity: self, entities: { 1: self }, health: 18, food: 20, players: {},
    inventory: { items: () => [] },
    blockAt: (pos: Vec3) => { const p = pos.floored(); return { name: name(p), position: p, boundingBox: name(p) === 'stone' ? 'block' : 'empty' }; }
  };
}

// ---------------------------------------------------------------- 1. the pathfinder and lava

function movementsWith(lava: string[]) {
  const cells = new Set(lava);
  return {
    canOpenDoors: false,
    exclusionAreasBreak: [],
    exclusionAreasStep: [] as ((block: { name: string; position?: unknown }) => number)[],
    exclusionAreasPlace: [] as ((block: { name: string; position?: { x: number; y: number; z: number } }) => number)[],
    replaceables: new Set([0, LAVA_ID, 35]),
    getBlock: (pos: { x: number; y: number; z: number }, dx: number, dy: number, dz: number) =>
      ({ name: cells.has(`${pos.x + dx},${pos.y + dy},${pos.z + dz}`) ? 'lava' : 'air' }),
    bot: { registry: { blocksByName: { lava: { id: LAVA_ID } } } }
  };
}

const stepCost = (movements: ReturnType<typeof movementsWith>, x: number, y: number, z: number) =>
  movements.exclusionAreasStep.reduce((sum, exclusion) => sum + exclusion({ name: 'air', position: { x, y, z } }), 0);

test('configureMovements: a cell with lava beside it, below it or below a neighbour costs extra; lava two away does not', (t) => {
  const movements = movementsWith(['1,64,0', '5,63,5', '10,63,1']);
  configureMovements(movements as never);
  t.is(stepCost(movements, 0, 64, 0), LAVA_EDGE_COST, 'lava to the east');
  t.is(stepCost(movements, 5, 64, 5), LAVA_EDGE_COST, 'lava below');
  t.is(stepCost(movements, 10, 64, 0), LAVA_EDGE_COST, 'a lava lake level with the shore floor, as in the live death');
  t.is(stepCost(movements, -1, 64, 0), 0, 'lava two blocks away');
  t.is(stepCost(movements, 2, 66, 0), 0, 'lava two below a neighbour');
  t.true(LAVA_EDGE_COST < 100, 'a target on the shore stays reachable');
});

test('configureMovements: the pathfinder no longer places scaffolding into lava; water and air stay replaceable', (t) => {
  const movements = movementsWith([]);
  configureMovements(movements as never);
  t.false(movements.replaceables.has(LAVA_ID));
  t.true(movements.replaceables.has(0));
  t.true(movements.replaceables.has(35));
  t.notThrows(() => configureMovements({ ...movementsWith([]), bot: undefined, replaceables: undefined } as never), 'fakes without a registry');
});

test('configureMovements: scaffolding over a floor above the lava is fine (the first block below is not lava)', (t) => {
  const movements = movementsWith(['3,60,0']);
  // Solid ground at y 63 between the cell and the lava.
  movements.getBlock = (pos, dx, dy, _dz) => ({ name: pos.y + dy === 60 && pos.x + dx === 3 ? 'lava' : pos.y + dy === 63 ? 'stone' : 'air' });
  configureMovements(movements as never);
  t.is(movements.exclusionAreasPlace.reduce((sum, exclusion) => sum + exclusion({ name: 'air', position: { x: 3, y: 64, z: 0 } }), 0), 0);
});

test('configureMovements: no scaffolding in the air above lava either (the bridge it built one level up once lava was not replaceable)', (t) => {
  const movements = movementsWith(['3,63,0']);
  configureMovements(movements as never);
  const placeCost = (x: number, y: number, z: number) =>
    movements.exclusionAreasPlace.reduce((sum, exclusion) => sum + exclusion({ name: 'air', position: { x, y, z } }), 0);
  t.true(placeCost(3, 64, 0) >= 100, 'a block placed right above the lava (jumping up): forbidden');
  t.true(placeCost(3, 65, 0) >= 100, 'stepping forward, the pathfinder passes the cell above the placed block: forbidden');
  t.true(placeCost(3, 67, 0) >= 100, 'a bridge built higher up is still over the lava');
  t.is(placeCost(4, 64, 0), 0, 'beside it: allowed');
});

// ---------------------------------------------------------------- 2. in lava

test('inLavaNow: the collision box reaching into the lava next to the bot counts, not only the middle column', (t) => {
  // At x 0.75 the box spans x 0.45..1.05, so it is in cell x 1 too.
  t.true(inLavaNow(lavaWorld(new Vec3(0.75, 64, 0.5), ['1,64,0']) as never), 'lava beside the feet');
  t.true(inLavaNow(lavaWorld(new Vec3(0.5, 64, 0.75), ['0,65,1']) as never), 'lava beside the head');
  t.false(inLavaNow(lavaWorld(new Vec3(0.5, 64, 0.5), ['1,64,0']) as never), 'in the middle of the cell the box does not reach it');
  t.true(inLavaNow(lavaWorld(new Vec3(0.5, 64, 0.5), ['0,64,0']) as never), 'standing in it');
  t.true(assessThreats(lavaWorld(new Vec3(0.75, 64, 0.5), ['1,64,0']) as never).inLava, 'the threat summary agrees');
});

test('readCues: lava damage in the last second is an in_lava cue even when no touched cell reads as lava', (t) => {
  const bot = lavaWorld(new Vec3(0.5, 64, 0.5));
  const now = 1_000_000;
  const cues = readCues(bot as never, policy(), { type: 'lava', time: now - 300 }, now);
  t.deepEqual(cues.filter(cue => cue.kind === 'in_lava').map(cue => cue.detail), ['taking lava damage (health 18)']);
  t.false(readCues(bot as never, policy(), { type: 'lava', time: now - LAVA_DAMAGE_CUE_MS - 1 }, now).some(cue => cue.kind === 'in_lava'), 'older damage is not');
  t.false(readCues(bot as never, policy(), { type: 'on_fire', time: now - 300 }, now).some(cue => cue.kind === 'in_lava'), 'burning is not lava');
  const inside = readCues(lavaWorld(new Vec3(0.75, 64, 0.5), ['1,64,0']) as never, policy(), null, now);
  t.deepEqual(inside.filter(cue => cue.kind === 'in_lava').map(cue => cue.detail), ['standing in lava (health 18)']);
});

test('buildMenu: an in_lava cue offers leave_lava, also when it came from lava damage alone', (t) => {
  const bot = lavaWorld(new Vec3(0.5, 64, 0.5));
  const menu = buildMenu(bot as never, [{ kind: 'in_lava', detail: 'taking lava damage (health 18)' }], { hasTask: false, policy: policy() });
  t.true(menu.some(option => option.id === 'leave_lava'));
});

test.serial('the instinct asks about lava damage with in_lava true and leave_lava on the menu (the live death had neither)', async (t) => {
  const clock = sinon.useFakeTimers({ now: 1.7e12 });
  t.teardown(() => clock.restore());
  const bot = Object.assign(new EventEmitter(), lavaWorld(new Vec3(0.5, 64, 0.5)), {
    version: '1.21.8', registry: minecraftData('1.21.8'), heldItem: null,
    pathfinder: { goal: null, setGoal: sinon.stub(), stop: sinon.stub() }, setControlState: sinon.stub(), clearControlStates: sinon.stub()
  });
  const arbiter = new ActionArbiter({ stopBody: () => {} });
  const events = new EventStore();
  const tasks = new TaskManager({ getBot: () => bot as never, getArbiter: () => arbiter, events, behaviors: [] as never });
  const store = new PolicyStore();
  const answer: DecisionResult = { ok: true, answers: { action: { type: 'choice', choice: 'ask_llm', confidence: 0.9, probabilities: { ask_llm: 0.9 } }, urgent: { type: 'noul', noul: 0.1 } }, model: 'test/model', latencyMs: 600 };
  const decide = sinon.stub().resolves(answer);
  const engine = new InstinctEngine({ bot: bot as never, arbiter, tasks, getPolicy: () => store.get(), events, decide });
  engine.start();
  t.teardown(() => engine.stop('test finished'));

  engine.noteDamage({ type: 'lava', time: Date.now() });
  engine.tick();
  await clock.tickAsync(0);

  t.true(decide.calledOnce);
  const state = decide.firstCall.args[0] as { situation: { in_lava: boolean }; danger: string[] };
  t.true(state.situation.in_lava, 'the fact agrees with the cue');
  t.true(state.danger.some(text => text.startsWith('taking lava damage')));
  t.regex(JSON.stringify(decide.firstCall.args[1]), /leave_lava/);
});

// ---------------------------------------------------------------- 3. body commands stop on death

function deathSetup() {
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(-1286.5, 63, -411.5) },
    pathfinder: { stop: sinon.stub(), setGoal: sinon.stub() },
    clearControlStates: sinon.stub()
  });
  const server = { tool: sinon.stub(), registerTool: sinon.stub() } as unknown as McpServer;
  const connection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }),
    getBot: () => bot,
    lastDamage: () => ({ description: 'lava', time: Date.now() })
  } as unknown as BotConnection;
  const factory = new ToolFactory(server, connection);
  const tool = (name: string) => (server.tool as sinon.SinonStub).getCalls().find(call => call.args[0] === name)!.args[3] as
    (args: Record<string, unknown>) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  return { bot, factory, tool };
}

test('a body command stops when the bot dies: the pathfinder stops, and the reply says where and why it died and where it respawned', async (t) => {
  const { bot, factory, tool } = deathSetup();
  // A move that would go on forever, as the pathfinder did with the respawned body.
  factory.registerTool('move-to-position', 'Move', {}, () => new Promise(() => {}));

  const reply = tool('move-to-position')({});
  await new Promise(resolve => setTimeout(resolve, 20));
  bot.emit('death');
  bot.entity.position = new Vec3(-1314.5, 77, -448.5);
  bot.emit('spawn');
  const result = await reply;

  t.true(result.isError);
  t.is(result.content[0].text, 'Failed: The bot died during move-to-position at (-1287, 63, -412) (lava); it respawned at (-1315, 77, -449) and the command was stopped');
  t.true(bot.pathfinder.stop.calledOnce);
  t.true(bot.pathfinder.setGoal.calledWith(null));
  t.true(bot.clearControlStates.calledOnce);
  t.is(bot.listenerCount('death'), 0, 'the watch is removed');
  t.is(bot.listenerCount('spawn'), 0);
});

test('a body command that ends normally keeps its reply, and other tools are not watched', async (t) => {
  const { bot, factory, tool } = deathSetup();
  factory.registerTool('move-to-position', 'Move', {}, async () => factory.createResponse('Successfully moved to position near (1, 2, 3)'));
  factory.registerTool('get-position', 'Where', {}, async () => {
    t.is(bot.listenerCount('death'), 0, 'not a body tool');
    return factory.createResponse('Current position: (1, 2, 3)');
  });

  t.is((await tool('move-to-position')({})).content[0].text, 'Successfully moved to position near (1, 2, 3)');
  t.is((await tool('get-position')({})).content[0].text, 'Current position: (1, 2, 3)');
  t.is(bot.listenerCount('death'), 0);
  t.false(bot.pathfinder.stop.called);
});
