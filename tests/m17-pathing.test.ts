// Contract: docs/BLUEPRINT.md E-019 (M17), the problems from the task-based survival test: scaffolding and digging
// around built blocks, the report of blocks the pathfinder placed and dug on a move, moving while walled in, and the
// hedged second decision request for urgent cues. Expected values come from the contract. The pathfinder cases run
// mineflayer-pathfinder's own Movements and A* over a small block world.
import test, { ExecutionContext } from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Vec3 } from 'vec3';
import { z } from 'zod';
import minecraftData from 'minecraft-data';
import prismarineBlock from 'prismarine-block';
import pathfinderPkg from 'mineflayer-pathfinder';
import type mineflayer from 'mineflayer';
import { configureMovements, EDIT_LIST_LIMIT, isPlayerBuilt, nearBuilt, ROOF_CHECK, watchPathEdits } from '../src/tools/movement-utils.js';
import { registerPositionTools } from '../src/tools/position-tools.js';
import { registerWaypointTools } from '../src/tools/waypoint-tools.js';
import { WaypointStore } from '../src/waypoint-store.js';
import { ActionArbiter } from '../src/autopilot/action-arbiter.js';
import { PolicyStore } from '../src/autopilot/policy.js';
import { BehaviorDefinition, TaskManager, delay } from '../src/autopilot/task-manager.js';
import { EventStore } from '../src/event-store.js';
import { HEDGE_CUES, HEDGE_MS, InstinctEngine } from '../src/autopilot/instinct/instinct-engine.js';
import { CUE_URGENCY } from '../src/autopilot/instinct/attention.js';
import type { DecisionResult } from '../src/decisions/openrouter-client.js';
import { createFactory } from './_helpers.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const AStar = require('mineflayer-pathfinder/lib/astar');
const Move = require('mineflayer-pathfinder/lib/move');
const { Movements, goals } = pathfinderPkg;

const VERSION = '1.21.8';
const registry = minecraftData(VERSION);
const Block = prismarineBlock(registry as never);

// ---------------------------------------------------------------- 1. scaffolding and digging around built blocks

type Cell = { x: number; y: number; z: number };
type Planned = { x: number; y: number; z: number; dx: number; dy: number; dz: number; useOne?: boolean };

/**
 * A real Movements over a world of `ground` up to y 63 and air above, plus `blocks` ("x,y,z" → name). The bot has a
 * world with block-state ids, as mineflayer's does, so the built-block checks take their fast path.
 */
function pathWorld(blocks: Record<string, string>, { configure = true, ground = 'dirt', parkour = true } = {}) {
  const name = (x: number, y: number, z: number) => blocks[`${x},${y},${z}`] ?? (y <= 63 ? ground : 'air');
  const bot = {
    registry, version: VERSION, game: { minY: -64 },
    world: { getBlockStateId: (pos: Vec3) => registry.blocksByName[name(pos.x, pos.y, pos.z)].defaultState },
    entity: { position: new Vec3(0.5, 64, 0.5), effects: {} }, entities: {},
    inventory: { items: () => [{ type: registry.itemsByName.dirt.id, count: 64, name: 'dirt' }] },
    pathfinder: { bestHarvestTool: () => null },
    blockAt: (pos: Vec3) => {
      const p = pos.floored();
      const block = Block.fromStateId(registry.blocksByName[name(p.x, p.y, p.z)].defaultState, 0) as unknown as { position: Vec3 };
      block.position = p;
      return block;
    }
  };
  const movements = new Movements(bot as never, registry as never) as unknown as { countScaffoldingItems: () => number };
  if (configure) configureMovements(movements as never);
  (movements as unknown as { allowParkour: boolean }).allowParkour = parkour;
  const plan = (start: Cell, goal: unknown) => {
    const result = new AStar(new Move(start.x, start.y, start.z, movements.countScaffoldingItems(), 0), movements, goal, 10000, 10000, 30).compute();
    const path = result.path as { toPlace: Planned[]; toBreak: Cell[] }[];
    return {
      status: result.status as string,
      placed: path.flatMap(node => node.toPlace.filter(p => !p.useOne).map(p => ({ x: p.x + p.dx, y: p.y + p.dy, z: p.z + p.dz }))),
      broken: path.flatMap(node => node.toBreak.map(b => ({ x: b.x, y: b.y, z: b.z })))
    };
  };
  const builtAt = (x: number, y: number, z: number) => isPlayerBuilt(name(x, y, z));
  return { movements, plan, builtAt };
}

const key = (c: Cell) => `${c.x},${c.y},${c.z}`;

function row(name: string, xs: number[], y: number, z: number): Record<string, string> {
  return Object.fromEntries(xs.map(x => [`${x},${y},${z}`, name]));
}

test('nearBuilt: the 8 cells around at the same height, the cell below and a roof up to 4 blocks above count', (t) => {
  const at = (blocks: Record<string, string>) => nearBuilt(pathWorld(blocks).builtAt, { x: 0, y: 64, z: 0 });
  t.false(at({}), 'open ground');
  t.true(at({ '1,64,0': 'oak_fence' }), 'a fence beside it');
  t.true(at({ '1,64,1': 'oak_fence' }), 'a fence diagonally beside it (a corner of the ring)');
  t.true(at({ '0,64,-1': 'oak_planks' }), 'a wall');
  t.true(at({ '0,63,0': 'oak_planks' }), 'a plank floor below');
  t.true(at({ [`0,${64 + ROOF_CHECK},0`]: 'cobblestone_slab' }), 'a roof 4 blocks above: inside a house');
  t.false(at({ [`0,${65 + ROOF_CHECK},0`]: 'oak_planks' }), 'higher than that does not count');
  t.false(at({ '2,64,0': 'oak_fence', '1,63,0': 'oak_planks' }), 'two cells away, or diagonally below, does not count');
  t.false(at({ '1,64,0': 'cobblestone', '0,63,0': 'stone', '0,65,0': 'oak_leaves' }), 'natural blocks and cobblestone are not built');
});

test('the pathfinder never places scaffolding in the gap of a fence ring or in a wall, as it is handed the cell', (t) => {
  const fence = { ...row('oak_fence', [-3, -2, -1, 1, 2, 3], 64, 1) };
  const { movements } = pathWorld(fence);
  const cost = (cell: Cell) => (movements as unknown as { exclusionPlace: (b: unknown) => number }).exclusionPlace({ name: 'air', position: cell });
  t.is(cost({ x: 0, y: 64, z: 1 }), 100, 'the gap in the ring');
  t.is(cost({ x: 0, y: 65, z: 1 }), 100, 'the cell above it: a bridging step names the cell above the one it fills');
  t.is(cost({ x: 0, y: 64, z: 4 }), 0, 'three blocks out from the fence');
  const wall = pathWorld({ ...row('oak_planks', [-1, 1], 65, 0), ...row('oak_planks', [-1, 0, 1], 64, 0) }).movements;
  t.is((wall as unknown as { exclusionPlace: (b: unknown) => number }).exclusionPlace({ name: 'air', position: { x: 0, y: 65, z: 0 } }), 100, 'a hole in a wall');
});

test('without a world of block-state ids the rules fall back to Movements.getBlock', (t) => {
  type Hook = (block: { name: string; position?: Cell }) => number;
  const fenceAt = (pos: Cell, dx: number, dy: number, dz: number) => ({ name: pos.x + dx === 1 && pos.y + dy === 64 && pos.z + dz === 0 ? 'oak_fence' : 'air' });
  const movements = { canOpenDoors: false, exclusionAreasBreak: [] as Hook[], exclusionAreasPlace: [] as Hook[], getBlock: sinon.stub().callsFake(fenceAt) };
  configureMovements(movements as never);
  t.is(movements.exclusionAreasPlace[0]({ name: 'air', position: { x: 0, y: 64, z: 0 } }), 100);
  t.is(movements.exclusionAreasPlace[0]({ name: 'air', position: { x: 5, y: 64, z: 5 } }), 0);
  t.is(movements.exclusionAreasBreak[0]({ name: 'dirt', position: { x: 1, y: 63, z: 0 } }), 100, 'under the fence');
  t.is(movements.exclusionAreasBreak[0]({ name: 'dirt', position: { x: 2, y: 63, z: 0 } }), 0);
});

test('a climb next to a plank wall is not built from scaffolding any more; far from buildings it still is', (t) => {
  // A 2-high plank wall along z 1; the goal is on top of it.
  const wall = { ...row('oak_planks', [-3, -2, -1, 0, 1, 2, 3], 64, 1), ...row('oak_planks', [-3, -2, -1, 0, 1, 2, 3], 65, 1) };
  const goal = new goals.GoalBlock(0, 66, 1);
  const before = pathWorld(wall, { configure: false }).plan({ x: 0, y: 64, z: 0 }, goal);
  t.is(before.status, 'success', 'control: without the rule the pathfinder towers up beside the wall');
  t.true(before.placed.some(cell => cell.z === 0), 'control: with a block right against the wall');

  const after = pathWorld(wall).plan({ x: 0, y: 64, z: 0 }, goal);
  const { builtAt } = pathWorld(wall);
  t.deepEqual(after.placed.filter(cell => nearBuilt(builtAt, cell)).map(key), [], 'no scaffolding next to the wall');
  t.is(after.status, 'success', 'it still gets up: from a pillar one block away from the wall, with a jump across');
  t.true(after.placed.every(cell => cell.z <= -1), 'nothing placed against the wall');

  // The same climb against a stone cliff: scaffolding is fine there.
  const cliff = { ...row('stone', [-3, -2, -1, 0, 1, 2, 3], 64, 1), ...row('stone', [-3, -2, -1, 0, 1, 2, 3], 65, 1) };
  const natural = pathWorld(cliff).plan({ x: 0, y: 64, z: 0 }, goal);
  t.is(natural.status, 'success');
  t.true(natural.placed.length > 0, 'it still towers up where nothing is built');
});

test('bridging a ditch: plain where nothing is built; across the gap of a fence ring it bridges away from the fence', (t) => {
  // A ditch along x 1, too deep to climb out of; parkour off so the bot cannot jump it.
  const ditch: Record<string, string> = {};
  for (let z = -20; z <= 20; z++) for (let y = 55; y <= 63; y++) ditch[`1,${y},${z}`] = 'air';
  const plain = pathWorld(ditch, { parkour: false }).plan({ x: 0, y: 64, z: 0 }, new goals.GoalBlock(2, 64, 0));
  t.is(plain.status, 'success');
  t.deepEqual(plain.placed.map(key), ['1,63,0'], 'one block bridges the ditch');

  // Fence posts on both sides of the crossing: the straight bridge would sit in the gap of the ring.
  const ring = { ...ditch, '0,64,1': 'oak_fence', '0,64,-1': 'oak_fence', '2,64,1': 'oak_fence', '2,64,-1': 'oak_fence' };
  const control = pathWorld(ring, { configure: false, parkour: false }).plan({ x: -3, y: 64, z: 0 }, new goals.GoalBlock(4, 64, 0));
  t.true(control.placed.some(cell => key(cell) === '1,63,0'), 'control: without the rule it bridges in the gap');
  const world = pathWorld(ring, { parkour: false });
  const after = world.plan({ x: -3, y: 64, z: 0 }, new goals.GoalBlock(4, 64, 0));
  t.is(after.status, 'success');
  t.deepEqual(after.placed.filter(cell => nearBuilt(world.builtAt, cell) || nearBuilt(world.builtAt, { ...cell, y: cell.y + 1 })).map(key), [],
    'no bridge block where it or the cell above it touches a fence');
});

test('inside a house (a plank roof above) the pathfinder does not tower up', (t) => {
  const roof: Record<string, string> = {};
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) roof[`${x},68,${z}`] = 'oak_planks';
  const goal = new goals.GoalBlock(0, 66, 0);
  const control = pathWorld(roof, { configure: false }).plan({ x: 0, y: 64, z: 0 }, goal);
  t.deepEqual(control.placed.map(key).sort(), ['0,64,0', '0,65,0'], 'control: without the rule it towers up in the room');
  const after = pathWorld(roof).plan({ x: 0, y: 64, z: 0 }, goal);
  t.deepEqual(after.placed, []);
  t.not(after.status, 'success');
});

test('generated lookalikes (fortress bricks, moss carpets) do not stop bridging or digging; built blocks still do', (t) => {
  // A fortress deck of nether bricks with a 5-wide gap across it.
  const gap: Record<string, string> = {};
  for (let x = 3; x <= 7; x++) for (let y = 55; y <= 63; y++) for (let z = -30; z <= 30; z++) gap[`${x},${y},${z}`] = 'air';
  const deck = pathWorld(gap, { ground: 'nether_bricks', parkour: false }).plan({ x: 0, y: 64, z: 0 }, new goals.GoalBlock(10, 64, 0));
  t.is(deck.status, 'success', 'it bridges across the fortress');
  t.true(deck.placed.length > 0);

  // Digging down through a moss floor (moss carpet on moss blocks), as in a lush cave.
  const moss: Record<string, string> = { '0,64,0': 'moss_carpet', '1,64,0': 'moss_carpet', '0,60,0': 'air', '0,59,0': 'stone' };
  const down = pathWorld(moss, { ground: 'moss_block' }).plan({ x: 0, y: 64, z: 0 }, new goals.GoalBlock(0, 60, 0));
  t.is(down.status, 'success', 'the moss block under a moss carpet may be dug');

  t.false(isPlayerBuilt('nether_bricks'));
  t.false(isPlayerBuilt('nether_brick_fence'));
  t.false(isPlayerBuilt('polished_blackstone_bricks'));
  t.false(isPlayerBuilt('end_stone_brick_wall'));
  t.false(isPlayerBuilt('pale_moss_carpet'));
  t.true(isPlayerBuilt('white_carpet'));
  t.true(isPlayerBuilt('stone_bricks'));
  t.true(isPlayerBuilt('oak_fence'));
  const { movements } = pathWorld({});
  t.is((movements as unknown as { exclusionBreak: (b: unknown) => number }).exclusionBreak({ name: 'nether_bricks', position: { x: 0, y: 63, z: 0 } }), 100,
    'the lookalikes themselves stay unbreakable (M11)');
});

test('the pathfinder never digs the block under a door or a fence; other dirt is still dug', (t) => {
  const door = { '0,64,0': 'oak_door', '0,65,0': 'oak_door' };
  const { movements } = pathWorld({ ...door, '3,64,0': 'oak_fence', '6,64,0': 'torch' });
  const breakCost = (cell: Cell) => (movements as unknown as { exclusionBreak: (b: unknown) => number }).exclusionBreak({ name: 'dirt', position: cell });
  t.is(breakCost({ x: 0, y: 63, z: 0 }), 100, 'under the door');
  t.is(breakCost({ x: 3, y: 63, z: 0 }), 100, 'under a fence');
  t.is(breakCost({ x: 6, y: 63, z: 0 }), 100, 'under a torch');
  t.is(breakCost({ x: 1, y: 63, z: 0 }), 0, 'beside them');
  t.is((movements as unknown as { exclusionBreak: (b: unknown) => number }).exclusionBreak({ name: 'oak_planks', position: { x: 9, y: 63, z: 9 } }), 100, 'built blocks themselves (M11)');

  // The goal is a pocket under the doorway; the shortest way digs straight down through the door's block.
  const pocket = { ...door, '0,62,0': 'air', '0,61,0': 'air', '0,60,0': 'stone' };
  const goal = new goals.GoalBlock(0, 61, 0);
  const before = pathWorld(pocket, { configure: false }).plan({ x: 0, y: 64, z: -1 }, goal);
  t.true(before.broken.some(cell => key(cell) === '0,63,0'), 'control: without the rule it digs under the door');
  const after = pathWorld(pocket).plan({ x: 0, y: 64, z: -1 }, goal);
  t.is(after.status, 'success', 'it digs down beside the door instead');
  t.false(after.broken.some(cell => key(cell) === '0,63,0'));
});

// ---------------------------------------------------------------- 2. the report of placed and dug blocks

function editBot() {
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0, 64, 0) },
    dig: sinon.stub().resolves()
  });
  // As the pathfinder digs: bot.dig(block, true), looked up on the bot each time.
  const dig = (name: string, x: number, y: number, z: number) => bot.dig({ name, position: new Vec3(x, y, z) } as never, true as never);
  const place = (name: string, x: number, y: number, z: number) => {
    const position = new Vec3(x, y, z);
    bot.emit('blockPlaced', { name: 'air', type: 0, position }, { name, type: 10, position });
  };
  return { bot, dig, place };
}

test('watchPathEdits: lists what was dug and placed, and puts bot.dig back when it stops', async (t) => {
  const { bot, dig, place } = editBot();
  const original = bot.dig;
  const stop = watchPathEdits(bot as unknown as mineflayer.Bot);
  t.not(bot.dig, original, 'digs are seen through bot.dig');
  await dig('dirt', 1, 63, 2);
  place('cobblestone', 0, 64, 1);
  t.is(stop(), '; on the way the pathfinder dug 1 block(s): dirt at (1, 63, 2); placed 1 block(s): cobblestone at (0, 64, 1)');
  t.is(bot.dig, original);
  t.is(bot.listenerCount('blockPlaced'), 0);
  await dig('stone', 5, 63, 5);
  t.regex(stop(), /dirt at \(1, 63, 2\); placed/, 'nothing after the move is added');

  const quiet = watchPathEdits(bot as unknown as mineflayer.Bot);
  t.is(quiet(), '', 'nothing dug or placed: no suffix');

  const many = watchPathEdits(bot as unknown as mineflayer.Bot);
  for (let i = 0; i < EDIT_LIST_LIMIT + 2; i++) place('dirt', i, 64, 0);
  t.is(many(), `; on the way the pathfinder placed 8 block(s): ${Array.from({ length: EDIT_LIST_LIMIT }, (_, i) => `dirt at (${i}, 64, 0)`).join(', ')}, and 2 more`);
});

test('watchPathEdits: every dig of a move counts, even after the pathfinder drops all diggingCompleted listeners; failed digs do not', async (t) => {
  const { bot, dig } = editBot();
  const original = bot.dig;
  const stop = watchPathEdits(bot as unknown as mineflayer.Bot);
  await dig('stone', 0, 66, 0);
  // mineflayer-pathfinder re-plans after a block update with removeAllListeners('diggingCompleted', fn).
  bot.removeAllListeners('diggingCompleted');
  await dig('stone', 1, 65, 0);
  await dig('stone', 1, 64, 0);
  original.rejects(new Error('Digging aborted'));
  await t.throwsAsync(dig('dirt', 2, 64, 0) as Promise<void>, { message: 'Digging aborted' }, 'the error reaches the pathfinder unchanged');
  t.is(stop(), '; on the way the pathfinder dug 3 block(s): stone at (0, 66, 0), stone at (1, 65, 0), stone at (1, 64, 0)');
});

function moveBot(goto: (bot: ReturnType<typeof editBot>) => Promise<void>) {
  const world = editBot();
  const bot = Object.assign(world.bot, {
    game: { dimension: 'overworld' },
    blockAt: (pos: Vec3) => ({ name: pos.y < 64 ? 'stone' : 'air', position: pos.floored(), boundingBox: pos.y < 64 ? 'block' : 'empty' }),
    entities: {},
    players: {},
    pathfinder: { goto: sinon.spy(() => goto(world)), stop: sinon.stub(), setGoal: sinon.stub() },
    clearControlStates: sinon.stub()
  });
  return { ...world, bot };
}

test('move-to-position and goto-waypoint add the report to success, "did not reach" and thrown errors', async (t) => {
  const arrive = moveBot(async world => {
    await world.dig('dirt', 2, 63, 0);
    world.place('cobblestone', 3, 63, 0);
    world.bot.entity.position = new Vec3(5, 64, 0);
  });
  const { factory, getTool } = createFactory();
  registerPositionTools(factory, () => arrive.bot as never);
  const ok = await getTool('move-to-position')!.execute({ x: 5, y: 64, z: 0 });
  t.falsy(ok.isError);
  t.is(ok.content[0].text, 'Successfully moved to position near (5, 64, 0); on the way the pathfinder dug 1 block(s): dirt at (2, 63, 0); placed 1 block(s): cobblestone at (3, 63, 0)');

  const short = moveBot(async world => { world.place('dirt', 1, 64, 0); });
  const second = createFactory();
  registerPositionTools(second.factory, () => short.bot as never);
  const missed = await second.getTool('move-to-position')!.execute({ x: 20, y: 64, z: 0 });
  t.true(missed.isError);
  t.regex(missed.content[0].text, /^Failed: Did not reach \(20, 64, 0\): stopped at .*; on the way the pathfinder placed 1 block\(s\): dirt at \(1, 64, 0\)$/);

  const broken = moveBot(async world => {
    await world.dig('stone', 1, 64, 0);
    throw new Error('No path to the goal!');
  });
  const store = new WaypointStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'm17-')), 'waypoints.json'), 'localhost');
  store.set('home', { x: 9, y: 64, z: 0, dimension: 'overworld', createdAt: 0 });
  const third = createFactory();
  registerWaypointTools(third.factory, () => broken.bot as never, store);
  const failed = await third.getTool('goto-waypoint')!.execute({ name: 'home' });
  t.true(failed.isError);
  t.regex(failed.content[0].text, /No path to the goal!; on the way the pathfinder dug 1 block\(s\): stone at \(1, 64, 0\)/);
  t.is(broken.bot.listenerCount('blockPlaced'), 0, 'listeners are removed after a failed move');
});

// ---------------------------------------------------------------- 3. moving while walled in

/** The bot in a 1x2 hole in stone (as after dig_in), with open ground from x 5 on and a zombie at (7, 64, 0). */
function shelterBot(goto: (bot: { entity: { position: Vec3 } }) => Promise<void>) {
  const solid = (p: Vec3) => p.y < 64 || (p.x < 5 && !(p.x === 0 && p.z === 0 && (p.y === 64 || p.y === 65)) && p.y < 67);
  const holder: { bot?: { entity: { position: Vec3 } } } = {};
  const self = { id: 1, type: 'player', username: 'Bot', position: new Vec3(0.5, 64, 0.5) };
  const zombie = { id: 2, name: 'zombie', type: 'hostile', position: new Vec3(7.5, 64, 0.5), isValid: true, height: 1.95 };
  const bot = Object.assign(new EventEmitter(), {
    registry, entity: self, entities: { 1: self, 2: zombie }, players: {}, game: { dimension: 'overworld' },
    inventory: { slots: [], items: () => [] },
    blockAt: (pos: Vec3) => {
      const p = pos.floored();
      return { name: solid(p) ? 'stone' : 'air', position: p, boundingBox: solid(p) ? 'block' : 'empty' };
    },
    pathfinder: { goto: sinon.spy(() => goto(holder.bot!)), stop: sinon.stub(), setGoal: sinon.stub() },
    clearControlStates: sinon.stub()
  });
  holder.bot = bot;
  return bot;
}

test('walled in on every side, both move tools refuse and name the hostile mobs near; leaveShelter: true moves and says so', async (t) => {
  const refused = shelterBot(async bot => { bot.entity.position = new Vec3(6.5, 64, 0.5); });
  const { factory, getTool } = createFactory();
  registerPositionTools(factory, () => refused as never);
  const no = await getTool('move-to-position')!.execute({ x: 6, y: 64, z: 0 });
  t.true(no.isError);
  t.is(no.content[0].text, "Failed: The bot is walled in on every side (for example by the instinct's dig_in); moving would make the pathfinder dig out. Hostile mobs within 16 blocks: zombie 7.0 blocks. Pass leaveShelter: true to move anyway");
  t.true(refused.pathfinder.goto.notCalled, 'nothing was dug');

  const yes = await getTool('move-to-position')!.execute({ x: 6, y: 64, z: 0, leaveShelter: true });
  t.falsy(yes.isError);
  t.is(yes.content[0].text, 'Successfully moved to position near (6, 64, 0); left the shelter (the bot was walled in on every side); hostile mobs within 16 blocks: zombie 1.0 blocks');

  // Already at the target: it does not leave, so it is neither refused nor reported.
  const stay = shelterBot(async () => {});
  const second = createFactory();
  registerPositionTools(second.factory, () => stay as never);
  t.is((await second.getTool('move-to-position')!.execute({ x: 0, y: 64, z: 0 })).content[0].text, 'Successfully moved to position near (0, 64, 0)');

  // The pathfinder found no way out: still walled in, so no note.
  const stuck = shelterBot(async () => {});
  const third = createFactory();
  registerPositionTools(third.factory, () => stuck as never);
  const missed = await third.getTool('move-to-position')!.execute({ x: 6, y: 64, z: 0, leaveShelter: true });
  t.true(missed.isError);
  t.regex(missed.content[0].text, /^Failed: Did not reach/);
  t.notRegex(missed.content[0].text, /left the shelter/);

  // A bot whose world cannot be read (no blockAt, as in older test fakes) is never stopped by the check.
  const unreadable = shelterBot(async bot => { bot.entity.position = new Vec3(6.5, 64, 0.5); });
  (unreadable as { blockAt: unknown }).blockAt = undefined;
  const fourth = createFactory();
  registerPositionTools(fourth.factory, () => unreadable as never);
  t.falsy((await fourth.getTool('move-to-position')!.execute({ x: 6, y: 64, z: 0 })).isError);
});

test('goto-waypoint: refused while walled in, moves with leaveShelter: true', async (t) => {
  const walk = shelterBot(async bot => { bot.entity.position = new Vec3(9.5, 64, 0.5); });
  const store = new WaypointStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'm17-')), 'waypoints.json'), 'localhost');
  store.set('field', { x: 9, y: 64, z: 0, dimension: 'overworld', createdAt: 0 });
  const { factory, getTool } = createFactory();
  registerWaypointTools(factory, () => walk as never, store);
  const no = await getTool('goto-waypoint')!.execute({ name: 'field' });
  t.true(no.isError);
  t.regex(no.content[0].text, /walled in on every side .* Hostile mobs within 16 blocks: zombie 7\.0 blocks\. Pass leaveShelter: true to move anyway$/);
  t.true(walk.pathfinder.goto.notCalled);
  t.is((await getTool('goto-waypoint')!.execute({ name: 'field', leaveShelter: true })).content[0].text,
    "Arrived near waypoint 'field' (9, 64, 0); left the shelter (the bot was walled in on every side); hostile mobs within 16 blocks: zombie 2.0 blocks");
});

// ---------------------------------------------------------------- 4. the hedged second request for urgent cues

const EMPTY = new Set(['air', 'water', 'fire']);

function engineWorld({ underwater = false, burning = false } = {}) {
  // Under water: a pool at y 64-65 under a stone ceiling, open to the east at x 3. Burning: open ground.
  const name = (x: number, y: number, zz: number) => {
    if (y < 64) return 'stone';
    if (!underwater || Math.abs(x) > 3 || Math.abs(zz) > 3) return y < 68 && underwater ? 'stone' : 'air';
    if (y <= 65) return 'water';
    if (x === 3 && y <= 67) return 'air';
    return 'stone';
  };
  const self = { id: 1, position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0, onGround: true, metadata: [burning ? 0x01 : 0, 300] as unknown[] };
  const bot = Object.assign(new EventEmitter(), {
    entity: self, entities: { 1: self }, version: VERSION, registry, health: 20, food: 20, heldItem: null,
    inventory: { items: () => [] },
    pathfinder: { goal: null, setGoal: sinon.stub(), stop: sinon.stub(), bestHarvestTool: sinon.stub().returns(null) },
    blockAt: (pos: Vec3) => {
      const p = pos.floored();
      const block = name(p.x, p.y, p.z);
      return { name: block, position: p, boundingBox: EMPTY.has(block) ? 'empty' : 'block', diggable: block !== 'air' };
    },
    setControlState: sinon.stub(), clearControlStates: sinon.stub(), look: sinon.stub().resolves(), equip: sinon.stub().resolves(),
    dig: sinon.stub().resolves(), stopDigging: sinon.stub()
  });
  return bot;
}

const idle: BehaviorDefinition<Record<string, never>, null> = {
  name: 'idle', description: 'runs until cancelled', schema: z.object({}), summarize: () => 'idle',
  async run({ signal }) { for (;;) await delay(50, signal); }
};

function startEngine(t: ExecutionContext, bot: ReturnType<typeof engineWorld>, decide: sinon.SinonStub) {
  const events = new EventStore();
  const arbiter = new ActionArbiter({ stopBody: () => {} });
  const store = new PolicyStore();
  const tasks = new TaskManager({ getBot: () => bot as never, getArbiter: () => arbiter, events, behaviors: [idle] as never });
  const engine = new InstinctEngine({ bot: bot as never, arbiter, tasks, getPolicy: () => store.get(), events, decide });
  engine.start();
  t.teardown(() => engine.stop('test finished'));
  const messages = () => events.query({ types: ['instinct'], limit: 50 }).events.map(event => event.message);
  return { engine, arbiter, store, messages };
}

function answer(choice: string, p = 0.9): DecisionResult {
  return {
    ok: true,
    answers: { action: { type: 'choice', choice, confidence: p, probabilities: { [choice]: p } }, urgent: { type: 'noul', noul: 0.9 } },
    model: 'test/model',
    latencyMs: 300
  };
}

const failure = (error: string, message = 'x'): DecisionResult => ({ ok: false, error, message, latencyMs: 0 } as DecisionResult);

/** A decide fake whose calls resolve only when the test says so. */
function controlledDecide() {
  const replies: ((result: DecisionResult) => void)[] = [];
  const calledAt: number[] = [];
  const decide = sinon.stub().callsFake(() => new Promise<DecisionResult>(resolve => { replies.push(resolve); calledAt.push(Date.now()); }));
  return { decide, replies, calledAt };
}

function useClock(t: ExecutionContext) {
  const clock = sinon.useFakeTimers({ now: 1.7e12 });
  t.teardown(() => clock.restore());
  return clock;
}

test('HEDGE_CUES are the five most urgent cue kinds; HEDGE_MS is under the 1.5 s timeout', (t) => {
  t.deepEqual(HEDGE_CUES, ['creeper_swelling', 'in_lava', 'trapped_underwater', 'low_air', 'low_health']);
  t.deepEqual(HEDGE_CUES, CUE_URGENCY.slice(0, 5));
  t.is(HEDGE_MS, 800);
});

test.serial('an urgent cue with no answer after 800 ms gets one identical second request; its answer is acted on', async (t) => {
  const clock = useClock(t);
  const { decide, replies, calledAt } = controlledDecide();
  const { engine, arbiter, messages } = startEngine(t, engineWorld({ underwater: true }), decide);
  const start = Date.now();
  engine.tick();
  await clock.tickAsync(HEDGE_MS - 1);
  t.is(decide.callCount, 1, 'not before 800 ms');
  await clock.tickAsync(1);
  t.is(decide.callCount, 2);
  t.is(calledAt[1] - start, HEDGE_MS);
  t.deepEqual(decide.secondCall.args, decide.firstCall.args, 'the same state and questions');

  replies[1](answer('swim_to_air'));
  await clock.tickAsync(0);
  t.is(arbiter.holder()?.holder, 'instinct swim_to_air');
  t.regex(messages().at(-1)!, /swim_to_air p=0\.90, urgent p=0\.90 \(test\/model; 300ms, second request\) → started swim_to_air \(urgent\)$/);

  // The first answer arrives late: thrown away, nothing is written about it.
  const written = messages().length;
  replies[0](answer('dig_up'));
  await clock.tickAsync(0);
  t.is(arbiter.holder()?.holder, 'instinct swim_to_air');
  t.is(messages().length, written);
  await clock.tickAsync(1000);
  t.is(decide.callCount, 2, 'never a third request for the same question');
});

test.serial('a quick answer means no second request; a cue that is not urgent never gets one', async (t) => {
  const clock = useClock(t);
  const quick = sinon.stub().callsFake(() => new Promise<DecisionResult>(resolve => setTimeout(() => resolve(answer('swim_to_air')), 500)));
  const first = startEngine(t, engineWorld({ underwater: true }), quick);
  first.engine.tick();
  await clock.tickAsync(1000);
  t.is(quick.callCount, 1);
  t.is(first.arbiter.holder()?.holder, 'instinct swim_to_air');
  first.engine.stop('next case');

  // Burning in the open is on_fire, which is not in HEDGE_CUES: a slow answer is simply waited for.
  const { decide } = controlledDecide();
  const second = startEngine(t, engineWorld({ burning: true }), decide);
  second.engine.tick();
  await clock.tickAsync(1400);
  t.is(decide.callCount, 1);
});

test.serial('a fast failure sends the second request at once; only when both fail is the instinct offline', async (t) => {
  const clock = useClock(t);
  const { decide, replies } = controlledDecide();
  const { engine, messages } = startEngine(t, engineWorld({ underwater: true }), decide);
  engine.tick();
  await clock.tickAsync(100);
  replies[0](failure('http_error', 'HTTP 502: bad gateway'));
  await clock.tickAsync(0);
  t.is(decide.callCount, 2, 'right away, not at 800 ms');
  t.deepEqual(messages(), [], 'not offline while the second request is open');
  replies[1](failure('timeout', 'no answer within 1500 ms'));
  await clock.tickAsync(0);
  t.is(messages().length, 1);
  t.regex(messages()[0], /^instinct offline \(http_error: HTTP 502: bad gateway\): under water/, 'the first failure is the reason');
  t.is(engine.status().offline, 'http_error: HTTP 502: bad gateway');
  await clock.tickAsync(HEDGE_MS);
  t.is(decide.callCount, 2, 'the hedge timer does not fire after both failed');
});

test.serial('the hedge waits for the first request when the second is refused; disabled or rate-limited first requests get none', async (t) => {
  const clock = useClock(t);
  const { decide, replies } = controlledDecide();
  decide.onSecondCall().resolves(failure('rate_limited', 'rate limit reached (90 instinct decisions per minute)'));
  const { engine, arbiter, messages } = startEngine(t, engineWorld({ underwater: true }), decide);
  engine.tick();
  await clock.tickAsync(HEDGE_MS);
  t.is(decide.callCount, 2);
  t.deepEqual(messages(), []);
  replies[0](answer('swim_to_air'));
  await clock.tickAsync(0);
  t.is(arbiter.holder()?.holder, 'instinct swim_to_air', 'the first answer still counts');
  engine.stop('next case');

  for (const error of ['disabled', 'rate_limited']) {
    const refused = sinon.stub().resolves(failure(error));
    const next = startEngine(t, engineWorld({ underwater: true }), refused);
    next.engine.tick();
    await clock.tickAsync(HEDGE_MS + 100);
    t.is(refused.callCount, 1, `${error}: no second request`);
    next.engine.stop('next case');
  }
});

test.serial('no second request once the engine stopped', async (t) => {
  const clock = useClock(t);
  const { decide } = controlledDecide();
  const { engine } = startEngine(t, engineWorld({ underwater: true }), decide);
  engine.tick();
  await clock.tickAsync(HEDGE_MS / 2);
  engine.stop('disconnected');
  await clock.tickAsync(HEDGE_MS);
  t.is(decide.callCount, 1);
});

test.serial('after a timeout the gate asks again on the next tick: the re-ask interval equals the 1.5 s timeout', async (t) => {
  // A cue that is not hedged, so only the re-ask is seen.
  const clock = useClock(t);
  const decide = sinon.stub().callsFake(() => new Promise<DecisionResult>(resolve => setTimeout(() => resolve(failure('timeout', 'no answer within 1500 ms')), 1500)));
  const { engine, store } = startEngine(t, engineWorld({ burning: true }), decide);
  t.is(store.get().instinct.reaskMs, 1500);
  engine.tick();
  await clock.tickAsync(1500);
  engine.tick();
  await clock.tickAsync(0);
  t.is(decide.callCount, 2, 'the next tick after the timeout already asks again');
});

test.serial('the first request times out after the hedge went out: no offline, and the second answer counts', async (t) => {
  const clock = useClock(t);
  const { decide, replies } = controlledDecide();
  const { engine, arbiter, messages } = startEngine(t, engineWorld({ underwater: true }), decide);
  engine.tick();
  await clock.tickAsync(HEDGE_MS);
  t.is(decide.callCount, 2);
  await clock.tickAsync(1500 - HEDGE_MS);
  replies[0](failure('timeout', 'no answer within 1500 ms'));
  await clock.tickAsync(0);
  t.deepEqual(messages(), [], 'not offline while the second request is open');
  t.is(engine.status().offline, null);
  t.is(decide.callCount, 2, 'no third request');
  replies[1](answer('swim_to_air'));
  await clock.tickAsync(0);
  t.is(arbiter.holder()?.holder, 'instinct swim_to_air');
  t.regex(messages().at(-1)!, /, second request\) → started swim_to_air \(urgent\)$/);
});

test.serial('after the hedge went out, a first answer that wins is not marked second; the late second answer is dropped', async (t) => {
  const clock = useClock(t);
  const { decide, replies } = controlledDecide();
  const { engine, arbiter, messages } = startEngine(t, engineWorld({ underwater: true }), decide);
  engine.tick();
  await clock.tickAsync(HEDGE_MS);
  t.is(decide.callCount, 2);
  replies[0](answer('swim_to_air'));
  await clock.tickAsync(0);
  t.is(arbiter.holder()?.holder, 'instinct swim_to_air');
  t.regex(messages().at(-1)!, /\(test\/model; 300ms\) → started swim_to_air \(urgent\)$/);
  const written = messages().length;
  replies[1](answer('dig_up'));
  await clock.tickAsync(0);
  t.is(arbiter.holder()?.holder, 'instinct swim_to_air');
  t.is(messages().length, written);
});

test.serial('a second request refused by the budget does not become the offline reason; the first request\'s timeout does', async (t) => {
  const clock = useClock(t);
  const { decide, replies } = controlledDecide();
  decide.onSecondCall().resolves(failure('rate_limited', 'rate limit reached (90 instinct decisions per minute)'));
  const { engine, messages } = startEngine(t, engineWorld({ underwater: true }), decide);
  engine.tick();
  await clock.tickAsync(HEDGE_MS);
  t.is(decide.callCount, 2);
  await clock.tickAsync(1500 - HEDGE_MS);
  replies[0](failure('timeout', 'no answer within 1500 ms'));
  await clock.tickAsync(0);
  t.is(engine.status().offline, 'timeout: no answer within 1500 ms');
  t.regex(messages()[0], /^instinct offline \(timeout: no answer within 1500 ms\)/);
});

test.serial('a superseded request gets no hedge, neither at 800 ms nor after a fast failure', async (t) => {
  const clock = useClock(t);
  const { decide, replies } = controlledDecide();
  const bot = engineWorld({ underwater: true });
  const { engine } = startEngine(t, bot, decide);
  engine.tick();
  await clock.tickAsync(HEDGE_MS / 2);
  // A lit creeper outranks being trapped under water, so a newer request supersedes the first.
  const keys = (registry.entitiesByName.creeper.metadataKeys ?? []) as string[];
  const metadata: unknown[] = [];
  metadata[keys.indexOf('swell_dir')] = 1;
  (bot.entities as Record<number, unknown>)[2] = { id: 2, name: 'creeper', type: 'hostile', position: new Vec3(2.5, 64, 1.5), isValid: true, height: 1.7, metadata };
  engine.tick();
  await clock.tickAsync(0);
  t.is(decide.callCount, 2, 'the newer request');
  t.notDeepEqual(decide.secondCall.args[0], decide.firstCall.args[0]);
  await clock.tickAsync(HEDGE_MS / 2 + 1);
  t.is(decide.callCount, 2, 'the first request\'s timer does not hedge it any more');
  replies[0](failure('http_error', 'HTTP 502'));
  await clock.tickAsync(0);
  t.is(decide.callCount, 2, 'nor does its fast failure');
});

test.serial('no hedge once the instinct is turned off while the request is open', async (t) => {
  const clock = useClock(t);
  const { decide } = controlledDecide();
  const { engine, store } = startEngine(t, engineWorld({ underwater: true }), decide);
  engine.tick();
  await clock.tickAsync(HEDGE_MS / 2);
  t.true(store.update({ instinct: { enabled: false } }, 'llm').ok);
  engine.tick();
  await clock.tickAsync(HEDGE_MS);
  t.is(decide.callCount, 1);
});
