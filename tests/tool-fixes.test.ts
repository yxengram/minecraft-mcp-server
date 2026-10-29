// Contract: docs/BLUEPRINT.md E-013 (M11). The four tool problems found in the 10-day survival test: the pathfinder
// dug through the bot's own walls, place-block walked into the cell it was filling, fill-region climbed onto the roof,
// and smelt-item took only the first output.
import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'events';
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import type mineflayer from 'mineflayer';
import type { Item } from 'prismarine-item';
import { configureMovements, installDoorHelper, isBuiltBlock } from '../src/tools/movement-utils.js';
import { PLACE_REACH, placeBlockAt } from '../src/tools/block-utils.js';
import { registerBlockTools } from '../src/tools/block-tools.js';
import { registerFurnaceTools } from '../src/tools/furnace-tools.js';
import { asBot, createFactory, createFakeWorld } from './_helpers.js';

// ---- pathfinder: doors and built blocks -----------------------------------------------------------------------------

test('configureMovements: the pathfinder may open doors, and never breaks built blocks while natural ones stay diggable', (t) => {
  const movements = { canOpenDoors: false, exclusionAreasBreak: [] as ((block: { name: string }) => number)[], getBlock: () => ({ name: 'stone' }) };
  configureMovements(movements);
  t.true(movements.canOpenDoors);
  t.is(movements.exclusionAreasBreak.length, 1);
  const cost = (name: string) => movements.exclusionAreasBreak[0]({ name });
  for (const name of ['acacia_planks', 'oak_planks', 'glass', 'glass_pane', 'white_stained_glass', 'acacia_door', 'oak_trapdoor',
    'brown_bed', 'chest', 'crafting_table', 'furnace', 'torch', 'wall_torch', 'oak_fence', 'oak_fence_gate', 'stone_stairs',
    'oak_slab', 'cobblestone_wall', 'white_wool', 'bricks', 'stone_bricks', 'ladder']) {
    t.is(cost(name), 100, `${name} is unbreakable for the pathfinder`);
  }
  for (const name of ['dirt', 'grass_block', 'stone', 'cobblestone', 'andesite', 'sand', 'gravel', 'oak_log', 'acacia_leaves', 'short_grass']) {
    t.is(cost(name), 0, `${name} may still be dug on the way`);
  }
});

test('doors for the pathfinder: wooden doors are passable, open or closed (the door helper opens them); iron doors untouched', (t) => {
  const door = (half: string, open: boolean, name = 'acacia_door') => ({ name, position: { y: 64 }, height: 65, safe: false, physical: true, openable: false, shapes: [[0, 0, 0.8125, 1, 1, 1]], getProperties: () => ({ half, open, facing: 'north' }) });
  const movements = { canOpenDoors: false, exclusionAreasBreak: [] as ((block: { name: string }) => number)[], getBlock: sinon.stub() };
  const lookup = movements.getBlock;
  configureMovements(movements);
  for (const [half, open] of [['lower', false], ['upper', false], ['lower', true]] as const) {
    lookup.returns(door(half, open));
    const seen = movements.getBlock();
    t.like(seen, { safe: true, physical: false, openable: false, height: 64 }, `${half} half, open ${open}: walked through at floor level, not jumped onto`);
    t.deepEqual(seen.shapes, [[0, 0, 0.8125, 1, 1, 1]], 'the collision shape physics uses is untouched');
  }
  lookup.returns(door('lower', false, 'iron_door'));
  t.like(movements.getBlock(), { safe: false, physical: true }, 'iron doors cannot be opened by hand');
  lookup.returns({ name: 'stone', safe: false, physical: true });
  t.like(movements.getBlock(), { safe: false, physical: true }, 'other blocks are left alone');
});

/** A bot facing south (+z) with a door at (0, 64, 1) just ahead. */
function doorWorld(name = 'acacia_door') {
  const door = { open: false };
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.2), yaw: Math.PI },
    pathfinder: { isMoving: sinon.stub().returns(true) },
    blockAt: (pos: Vec3) => {
      const p = pos.floored();
      if (p.x === 0 && p.z === 1 && (p.y === 64 || p.y === 65)) {
        return { name, position: p, getProperties: () => ({ half: p.y === 64 ? 'lower' : 'upper', open: door.open }) };
      }
      return { name: 'air', position: p, getProperties: () => ({}) };
    },
    activateBlock: sinon.stub().callsFake(async () => { door.open = !door.open; })
  });
  return { bot, door };
}

test.serial('door helper: opens the closed door right ahead while walking, once; closes it after the bot has gone through', async (t) => {
  const clock = sinon.useFakeTimers({ now: 1e6 });
  t.teardown(() => clock.restore());
  const { bot, door } = doorWorld();
  const remove = installDoorHelper(bot as never);
  t.teardown(remove);

  bot.emit('physicsTick');
  await clock.tickAsync(0);
  t.true(bot.activateBlock.calledOnce, 'opened');
  t.deepEqual(bot.activateBlock.firstCall.args[0].position.toArray(), [0, 64, 1], 'the lower half');
  t.true(door.open);
  bot.emit('physicsTick');
  t.true(bot.activateBlock.calledOnce, 'not toggled shut again while walking through');

  // Through the doorway and on.
  bot.entity.position = new Vec3(0.5, 64, 4.2);
  await clock.tickAsync(1100);
  bot.emit('physicsTick');
  await clock.tickAsync(0);
  t.true(bot.activateBlock.calledTwice, 'closed behind the bot');
  t.false(door.open);
});

test.serial('door helper: does nothing when the bot is not walking, for iron doors, and never closes a door it did not open', async (t) => {
  const clock = sinon.useFakeTimers({ now: 1e6 });
  t.teardown(() => clock.restore());
  const idle = doorWorld();
  idle.bot.pathfinder.isMoving.returns(false);
  t.teardown(installDoorHelper(idle.bot as never));
  idle.bot.emit('physicsTick');
  t.true(idle.bot.activateBlock.notCalled, 'standing still next to a door');

  const iron = doorWorld('iron_door');
  t.teardown(installDoorHelper(iron.bot as never));
  iron.bot.emit('physicsTick');
  t.true(iron.bot.activateBlock.notCalled);

  const open = doorWorld();
  open.door.open = true;
  open.bot.pathfinder.isMoving.returns(false);
  t.teardown(installDoorHelper(open.bot as never));
  open.bot.entity.position = new Vec3(0.5, 64, 5);
  await clock.tickAsync(2000);
  open.bot.emit('physicsTick');
  t.true(open.bot.activateBlock.notCalled, 'a door someone else left open stays open');
});

test('door helper: path planning sees wooden doors without a collision shape; physics (blockAt(pos, false)) sees the real door', (t) => {
  const real = { name: 'acacia_door', position: new Vec3(0, 64, 1), shapes: [[0, 0, 0.8125, 1, 1, 1]], getProperties: () => ({ half: 'lower', open: false }) };
  const stone = { name: 'stone', position: new Vec3(0, 63, 1), shapes: [[0, 0, 0, 1, 1, 1]] };
  const bot = Object.assign(new EventEmitter(), {
    entity: { position: new Vec3(0.5, 64, 0.5), yaw: 0 },
    pathfinder: { isMoving: () => false },
    blockAt: (pos: Vec3) => (pos.y === 64 ? real : stone),
    activateBlock: sinon.stub().resolves()
  });
  const remove = installDoorHelper(bot as never);
  const seen = (bot.blockAt as (pos: Vec3, extra?: boolean) => typeof real)(new Vec3(0, 64, 1));
  t.deepEqual(seen.shapes, [], 'the pathfinder does not put a path point on top of the door');
  t.is(seen.name, 'acacia_door');
  t.deepEqual(real.shapes, [[0, 0, 0.8125, 1, 1, 1]], 'the real block is not changed');
  t.deepEqual((bot.blockAt as (pos: Vec3, extra?: boolean) => typeof real)(new Vec3(0, 64, 1), false).shapes, [[0, 0, 0.8125, 1, 1, 1]], 'physics collides with the door');
  t.deepEqual((bot.blockAt as (pos: Vec3) => typeof stone)(new Vec3(0, 63, 1)).shapes, [[0, 0, 0, 1, 1, 1]], 'other blocks unchanged');
  remove();
  t.deepEqual((bot.blockAt as (pos: Vec3) => typeof real)(new Vec3(0, 64, 1)).shapes, [[0, 0, 0.8125, 1, 1, 1]], 'removed again');
});

test('isBuiltBlock does not mistake natural blocks for built ones', (t) => {
  t.false(isBuiltBlock('stone'));
  t.false(isBuiltBlock('deepslate'));
  t.false(isBuiltBlock('red_terracotta'));
  t.true(isBuiltBlock('acacia_planks'));
});

// ---- approaching a placement: GoalPlaceBlock, never inside the target ----------------------------------------------

test('fill-region (placeBlockAt) far from the target walks with GoalPlaceBlock: within reach, line of sight, not standing in it', async (t) => {
  const world = createFakeWorld({ '5,68,5': 'acacia_planks' }, new Vec3(0, 64, 0));
  world.bot.heldItem = { name: 'acacia_planks' };
  const placed = await placeBlockAt(world.bot as never, new Vec3(5, 69, 5));
  t.true(placed);
  t.true(world.bot.pathfinder.goto.calledOnce);
  const goal = world.bot.pathfinder.goto.firstCall.args[0];
  t.true(goal instanceof goals.GoalPlaceBlock, 'not GoalNear: for a roof edge no floor spot is within 3 blocks');
  t.is(goal.options.range, PLACE_REACH);
  t.true(goal.options.LOS);
  t.false(goal.isEnd(new Vec3(5, 69, 5)), 'standing in the target never counts as arrived');
  t.false(goal.isEnd(new Vec3(5, 68, 5)), 'nor with the head in it');
});

test('placeBlockAt close by with the reference in sight does not move the bot', async (t) => {
  const world = createFakeWorld({ '1,63,0': 'stone' }, new Vec3(0, 64, 0));
  world.bot.heldItem = { name: 'stone' };
  t.true(await placeBlockAt(world.bot as never, new Vec3(1, 64, 0)));
  t.true(world.bot.pathfinder.goto.notCalled);
});

test('placeBlockAt that ends up standing in the target does not try to place there', async (t) => {
  const world = createFakeWorld({ '5,63,5': 'stone' }, new Vec3(0, 64, 0));
  world.bot.pathfinder.goto.callsFake(async () => { world.bot.entity.position = new Vec3(5.5, 64, 5.5); });
  t.false(await placeBlockAt(world.bot as never, new Vec3(5, 64, 5)));
  t.true(world.bot.placeBlock.notCalled);
});

function placeTool(world: ReturnType<typeof createFakeWorld>) {
  const { factory, getTool } = createFactory();
  registerBlockTools(factory, asBot(world.bot));
  return getTool('place-block')!;
}

test('place-block with the reference out of sight approaches with GoalPlaceBlock, not "2 blocks from the reference"', async (t) => {
  // A one-block-deep hole: the grass at its bottom is the reference.
  const world = createFakeWorld({ '3,63,0': 'grass_block', '2,64,0': 'dirt', '4,64,0': 'dirt', '3,64,1': 'dirt', '3,64,-1': 'dirt' }, new Vec3(0, 65, 0));
  world.bot.canSeeBlock = () => false;
  world.bot.heldItem = { name: 'dirt' };
  const result = await placeTool(world).execute({ x: 3, y: 64, z: 0 });
  t.regex(result.content[0].text, /^Placed block at \(3, 64, 0\)/);
  const goal = world.bot.pathfinder.goto.firstCall.args[0];
  t.true(goal instanceof goals.GoalPlaceBlock);
  t.false(goal.isEnd(new Vec3(3, 64, 0)), 'the goal never ends in the hole being filled');
});

test('place-block that ends up standing in the target refuses instead of failing every face', async (t) => {
  const world = createFakeWorld({ '3,63,0': 'grass_block' }, new Vec3(0, 65, 0));
  world.bot.canSeeBlock = () => false;
  world.bot.pathfinder.goto.callsFake(async () => { world.bot.entity.position = new Vec3(3.5, 64, 0.5); });
  const result = await placeTool(world).execute({ x: 3, y: 64, z: 0 });
  t.true(result.isError);
  t.is(result.content[0].text, 'Failed: Cannot place a block where the bot is standing or one block above');
  t.true(world.bot.placeBlock.notCalled);
});

test('place-block that cannot place says why in the failure', async (t) => {
  const world = createFakeWorld({ '3,63,0': 'grass_block' }, new Vec3(0, 64, 0));
  world.bot.placeBlock.rejects(new Error('No block has been placed : the block is still air'));
  const result = await placeTool(world).execute({ x: 3, y: 64, z: 0 });
  t.true(result.isError);
  t.is(result.content[0].text, 'Failed: Could not place a block at (3, 64, 0): no suitable reference block found (last error: No block has been placed : the block is still air)');
});

// ---- smelt-item takes the whole batch ---------------------------------------------------------------------------------

const item = (name: string, count: number, type: number) => ({ name, count, type, metadata: 0 }) as unknown as Item;

/** A furnace that turns one input into one output every `ms`, like the game's 10 s, and announces it with 'update'. */
function fakeFurnace(inputName: string, outputName: string, ms: number) {
  const furnace = new EventEmitter() as mineflayer.Furnace & EventEmitter;
  let input = 0;
  let output = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  furnace.putFuel = sinon.stub().resolves();
  furnace.putInput = sinon.stub().callsFake(async (_type: number, _metadata: unknown, count: number) => {
    input += count;
    timer = setInterval(() => {
      if (input === 0) return;
      input--;
      output++;
      furnace.emit('update');
    }, ms);
  });
  furnace.inputItem = sinon.stub().callsFake(() => (input ? item(inputName, input, 1) : null));
  furnace.fuelItem = sinon.stub().returns(null);
  furnace.outputItem = sinon.stub().callsFake(() => (output ? item(outputName, output, 2) : null));
  furnace.takeOutput = sinon.stub().callsFake(async () => {
    const taken = item(outputName, output, 2);
    output = 0;
    return taken;
  });
  furnace.close = sinon.stub().callsFake(() => { if (timer) clearInterval(timer); });
  return furnace;
}

function smeltTool(inventory: Item[], furnace: mineflayer.Furnace) {
  const { factory, getTool } = createFactory();
  const bot = { blockAt: sinon.stub().returns({ name: 'furnace' }), openFurnace: sinon.stub().resolves(furnace), inventory: { items: () => inventory } };
  registerFurnaceTools(factory, asBot(bot));
  return getTool('smelt-item')!;
}

test.serial('smelt-item takes every output of the batch: 4 sand → "Smelted 4 glass", nothing left in the furnace', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());
  const furnace = fakeFurnace('sand', 'glass', 10000);
  const run = smeltTool([item('sand', 4, 1), item('acacia_planks', 10, 3)], furnace).execute({ x: 0, y: 64, z: 0, inputItem: 'sand', inputCount: 4, fuelItem: 'acacia_planks', fuelCount: 3 });
  await clock.tickAsync(45000);
  const result = await run;
  t.is(result.content[0].text, 'Smelted 4 glass');
  t.true((furnace.takeOutput as sinon.SinonStub).callCount >= 1);
  t.falsy(furnace.outputItem(), "nothing left to take");
  t.falsy(furnace.inputItem(), "nothing left to smelt");
});

test.serial('smelt-item that runs out of time reports what it took and what is still in the furnace', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());
  const furnace = fakeFurnace('sand', 'glass', 10000);
  const run = smeltTool([item('sand', 4, 1), item('acacia_planks', 10, 3)], furnace).execute({ x: 0, y: 64, z: 0, inputItem: 'sand', inputCount: 4, fuelItem: 'acacia_planks', fuelCount: 3, timeoutMs: 25000 });
  await clock.tickAsync(30000);
  const result = await run;
  t.is(result.content[0].text, 'Smelted 2 glass; 2 sand still in the furnace (stopped after 25000ms)');
});

test.serial('smelt-item picks the exact item name first: "sand" is sand, not red_sand', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());
  const furnace = fakeFurnace('sand', 'glass', 10000);
  const run = smeltTool([item('red_sand', 3, 7), item('sand', 2, 1), item('acacia_planks', 10, 3)], furnace).execute({ x: 0, y: 64, z: 0, inputItem: 'sand', inputCount: 1, fuelItem: 'acacia_planks' });
  await clock.tickAsync(15000);
  await run;
  t.is((furnace.putInput as sinon.SinonStub).firstCall.args[0], 1, 'the sand stack (type 1), not red_sand (type 7)');
});
