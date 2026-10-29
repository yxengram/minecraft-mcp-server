// Contract: docs/BLUEPRINT.md E-014 (M12), the five tool problems from the 5-day survival test on Hard: the air
// reading, waking up under a low ceiling, "inventory gained" as a net change, lost drops and broken tools in gather,
// and leftover fuel of another kind in smelt-item. Expected values come from the contract.
import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import type mineflayer from 'mineflayer';
import type { Item } from 'prismarine-item';
import { airLevel, registerGameStateTools } from '../src/tools/gamestate-tools.js';
import { bedWakeWarning, headInsideBlock } from '../src/tools/terrain-utils.js';
import { registerInteractionTools } from '../src/tools/interaction-tools.js';
import { registerFurnaceTools } from '../src/tools/furnace-tools.js';
import { BotConnection } from '../src/bot-connection.js';
import { describeLoot, watchLoot } from '../src/autopilot/behaviors/actions.js';
import { gatherBehavior } from '../src/autopilot/behaviors/gather.js';
import { returnHomeBehavior } from '../src/autopilot/behaviors/return-home.js';
import { ActionArbiter } from '../src/autopilot/action-arbiter.js';
import { TaskManager } from '../src/autopilot/task-manager.js';
import { EventStore } from '../src/event-store.js';
import { WaypointStore } from '../src/waypoint-store.js';
import { asBot, createFactory, createFakeWorld } from './_helpers.js';

// A realistic clock: the task manager throttles progress events relative to its last one, starting from 0.
const NOW = 1_700_000_000_000;

// ---------------------------------------------------------------- 1. air reading

/** A bot at (0.5, 64, 0.5) whose own metadata holds `airTicks` (undefined: never sent) and whose head block is `head`. */
function airBot({ airTicks, head = 'air', oxygenLevel }: { airTicks?: number; head?: string; oxygenLevel?: number }) {
  const metadata: unknown[] = [0];
  if (airTicks !== undefined) metadata[1] = airTicks;
  return {
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5), metadata },
    oxygenLevel,
    blockAt: (pos: Vec3) => ({ name: pos.floored().y === 65 ? head : 'air', position: pos.floored() })
  } as unknown as mineflayer.Bot;
}

test('air: with no air value of its own (never under water since joining), the bot has full air whatever bot.oxygenLevel says', (t) => {
  // mineflayer writes any entity's air supply into bot.oxygenLevel, e.g. a fish drowning on land.
  t.is(airLevel(airBot({ oxygenLevel: 0 })), 20);
  t.is(airLevel(airBot({ oxygenLevel: 7, head: 'water' })), 20, 'even with the head in water: no value means the default, full air');
});

test('air: a low reading with the head out of water is reported as full; under water the reading counts', (t) => {
  t.is(airLevel(airBot({ airTicks: 0 })), 20, 'out of the water air only refills');
  t.is(airLevel(airBot({ airTicks: 0, head: 'water' })), 0);
  t.is(airLevel(airBot({ airTicks: 150, head: 'water' })), 10);
  t.is(airLevel(airBot({ airTicks: 150, head: 'seagrass' })), 10, 'seagrass and kelp count as water');
  t.is(airLevel({} as mineflayer.Bot), undefined, 'no entity, no reading');
});

test('air: get-observation shows 20/20 in open air while another entity drains bot.oxygenLevel', async (t) => {
  const { factory, getTool } = createFactory();
  const bot = Object.assign(airBot({ oxygenLevel: 3 }), {
    health: 20, food: 20, foodSaturation: 5, game: { dimension: 'overworld', gameMode: 'survival' },
    time: { timeOfDay: 1000, isDay: true }, thunderState: 0, isRaining: false, heldItem: null, version: '1.21.8',
    experience: { level: 0, points: 0 }, entities: {},
    inventory: { items: () => [], slots: [] }, getEquipmentDestSlot: () => 0
  });
  registerGameStateTools(factory, asBot(bot));
  const text = (await getTool('get-observation')!.execute({})).content[0].text;
  t.regex(text, /air: 20\/20/);
});

// ---------------------------------------------------------------- 2. bed headroom and waking up

/**
 * A pit dug into dirt along +z from (0, 77, 0): `length` cells long, `height` cells high, with a bed whose head is at
 * (0, 77, 0) and foot at (0, 77, 1). Everything else is dirt.
 */
function pitWorld({ length, height }: { length: number; height: number }) {
  const cells = new Map<string, string>();
  const key = (pos: Vec3) => `${pos.x},${pos.y},${pos.z}`;
  for (let z = 0; z < length; z++) {
    for (let y = 77; y < 77 + height; y++) cells.set(key(new Vec3(0, y, z)), 'air');
  }
  cells.set(key(new Vec3(0, 77, 0)), 'white_bed');
  cells.set(key(new Vec3(0, 77, 1)), 'white_bed');
  const blockAt = (pos: Vec3) => {
    const floored = pos.floored();
    const name = cells.get(key(floored)) ?? 'dirt';
    // As in minecraft-data: air, torches and liquids have no collision box.
    return { name, position: floored, boundingBox: ['air', 'torch', 'water', 'lava'].includes(name) ? 'empty' : 'block' };
  };
  const head = blockAt(new Vec3(0, 77, 0));
  const foot = blockAt(new Vec3(0, 77, 1));
  const bot = {
    blockAt,
    // mineflayer: part true is the head half; headOffset points from the foot to the head.
    parseBedMetadata: (block: { position: Vec3 }) => ({ part: block.position.z === 0, headOffset: new Vec3(0, 0, -1) }),
    entity: { id: 1, position: new Vec3(0.5, 77, 2.5) }
  };
  return { bot, blockAt, head, foot, cells, key };
}

test('bed: a bed in a 2-high pit with no free spot beside it gets a warning naming the block above it', (t) => {
  const { bot, foot, head } = pitWorld({ length: 2, height: 2 });
  const expected = 'warning: no free 2-block-high spot next to the bed and dirt at (0, 79, 0) above it: when the bot wakes up, ' +
    'the server stands it on the bed with its head in that block (suffocation damage); clear it or make room next to the bed';
  t.is(bedWakeWarning(bot as never, foot as never), expected, 'from the foot half the head half is found');
  t.is(bedWakeWarning(bot as never, head as never), expected);
});

test('bed: no warning with 2 free blocks above the bed, or with a free 2-high spot next to it', (t) => {
  t.is(bedWakeWarning(pitWorld({ length: 2, height: 3 }).bot as never, pitWorld({ length: 2, height: 3 }).foot as never), null, '3-high pit');
  const withSpot = pitWorld({ length: 3, height: 2 });
  t.is(bedWakeWarning(withSpot.bot as never, withSpot.foot as never), null, 'the free cell at the end of the pit is where the server puts the bot');

  const torchSpot = pitWorld({ length: 3, height: 2 });
  torchSpot.cells.set(torchSpot.key(new Vec3(0, 77, 2)), 'torch');
  t.is(bedWakeWarning(torchSpot.bot as never, torchSpot.foot as never), null, 'a torch has no collision box: still a free spot');

  const blockedSpot = pitWorld({ length: 3, height: 2 });
  blockedSpot.cells.set(blockedSpot.key(new Vec3(0, 77, 2)), 'crafting_table');
  t.regex(bedWakeWarning(blockedSpot.bot as never, blockedSpot.foot as never) ?? '', /^warning: no free 2-block-high spot/);

  const waterSpot = pitWorld({ length: 3, height: 2 });
  waterSpot.cells.set(waterSpot.key(new Vec3(0, 77, 2)), 'water');
  t.regex(bedWakeWarning(waterSpot.bot as never, waterSpot.foot as never) ?? '', /^warning/, 'water is not a spot to stand on');
});

test('bed: an unreadable world gives no warning instead of an error', (t) => {
  t.is(bedWakeWarning({} as never, { name: 'red_bed', position: new Vec3(0, 64, 0) } as never), null);
  t.is(bedWakeWarning({ blockAt: () => { throw new Error('unloaded'); } } as never, { name: 'red_bed', position: new Vec3(0, 64, 0) } as never), null);
});

test('sleep: the warning follows the usual reply; a roomy bed gets the usual reply alone', async (t) => {
  const low = pitWorld({ length: 2, height: 2 });
  const { factory, getTool } = createFactory();
  const bot = Object.assign(low.bot, { isSleeping: false, isABed: () => true, findBlock: () => low.foot, sleep: sinon.stub().resolves(), pathfinder: { goto: sinon.stub().resolves() } });
  bot.entity.position = new Vec3(0.5, 77, 1.5);
  registerInteractionTools(factory, asBot(bot));
  const text = (await getTool('sleep')!.execute({})).content[0].text;
  t.true(text.startsWith('Sleeping in white_bed at (0, 77, 1); warning: no free 2-block-high spot next to the bed and dirt at (0, 79, 0)'));
  t.true(bot.sleep.calledOnce, 'the warning does not stop the bot from sleeping');

  const roomy = pitWorld({ length: 2, height: 3 });
  const other = createFactory();
  registerInteractionTools(other.factory, asBot(Object.assign(roomy.bot, { isSleeping: false, isABed: () => true, findBlock: () => roomy.foot, sleep: sinon.stub().resolves(), pathfinder: { goto: sinon.stub().resolves() } })));
  t.is((await other.getTool('sleep')!.execute({})).content[0].text, 'Sleeping in white_bed at (0, 77, 1)');
});

test.serial('return-home: the sleep result carries the same warning', async (t) => {
  const clock = sinon.useFakeTimers({ now: NOW });
  t.teardown(() => clock.restore());
  const low = pitWorld({ length: 2, height: 2 });
  const bot = Object.assign(low.bot, {
    version: '1.21.8', game: { dimension: 'overworld' }, time: { timeOfDay: 18000 }, isSleeping: false, thunderState: 0,
    isABed: (block: { name: string }) => block.name === 'white_bed', findBlock: () => low.foot, sleep: sinon.stub().resolves(), wake: sinon.stub().resolves(),
    pathfinder: { goto: sinon.stub().resolves(), stop: sinon.stub(), setGoal: sinon.stub() }, clearControlStates: sinon.stub()
  });
  bot.entity.position = new Vec3(0.5, 77, 1.5);
  const waypoints = { normalizeName: (name: string) => name, get: () => ({ x: 0, y: 77, z: 1, dimension: 'overworld' }) } as unknown as WaypointStore;
  const tasks = new TaskManager({ getBot: () => bot as never, getArbiter: () => new ActionArbiter({ stopBody: () => {} }), events: new EventStore(), services: { waypoints }, behaviors: [returnHomeBehavior] as never });
  const started = await tasks.start('return-home', {});
  t.true(started.ok, started.ok ? undefined : started.error);
  const end = tasks.waitForEnd('t1');
  await clock.tickAsync(2000);
  const final = await end;
  t.is(final.status, 'done');
  t.regex(final.result ?? '', /^Arrived at waypoint 'home' and sleeping in the white_bed at \(0, 77, 1\); warning: no free 2-block-high spot next to the bed/);
});

test('headInsideBlock: the block at eye height (feet + 1.62), only if it has a collision box', (t) => {
  const { bot } = pitWorld({ length: 2, height: 2 });
  bot.entity.position = new Vec3(0.5, 77.5625, 0.5);
  t.is(headInsideBlock(bot as never)?.position.toString(), new Vec3(0, 79, 0).toString(), 'standing on the bed, the eyes are in the ceiling');
  bot.entity.position = new Vec3(0.5, 77, 0.5);
  t.is(headInsideBlock(bot as never), null, 'on the floor the eyes are at y 78.62, in air');
});

function connectionWithBot(position: Vec3, world = pitWorld({ length: 2, height: 2 })) {
  const onEvent = sinon.stub();
  const connection = new BotConnection({ host: 'localhost', port: 25565, username: 'Bot' }, { onLog: sinon.stub(), onChatMessage: sinon.stub(), onEvent });
  const bot = new EventEmitter() as EventEmitter & Record<string, unknown>;
  Object.assign(bot, { _client: new EventEmitter(), entity: { id: 1, position }, entities: {}, health: 20, username: 'Bot', quit: sinon.stub(), blockAt: world.blockAt });
  (connection as unknown as { bot: unknown }).bot = bot;
  (connection as unknown as { registerEventHandlers: (b: unknown) => void }).registerEventHandlers(bot);
  return { bot, onEvent };
}

test.serial('woke_up: a second after waking (also the morning wake by the server), a head inside a block is reported', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());
  const { bot, onEvent } = connectionWithBot(new Vec3(0.5, 77.5625, 0.5));
  bot.emit('wake');
  await clock.tickAsync(900);
  t.false(onEvent.calledWith('woke_up'), 'not before the server has moved the bot');
  await clock.tickAsync(200);
  t.true(onEvent.calledWith('woke_up', 'Woke up with the head inside dirt at (0, 79, 0): the bot takes suffocation damage until it moves out'));
});

test.serial('woke_up: nothing is reported when the bot stands up beside the bed', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());
  const { bot, onEvent } = connectionWithBot(new Vec3(0.5, 77, 2.5), pitWorld({ length: 3, height: 2 }));
  bot.emit('wake');
  await clock.tickAsync(2000);
  t.false(onEvent.getCalls().some(call => call.args[0] === 'woke_up'));
});

test.serial('wake: the result says so when the head ends up inside a block', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());
  const { bot } = pitWorld({ length: 2, height: 2 });
  bot.entity.position = new Vec3(0.5, 77.5625, 0.5);
  const { factory, getTool } = createFactory();
  registerInteractionTools(factory, asBot(Object.assign(bot, { isSleeping: true, wake: sinon.stub().resolves() })));
  const run = getTool('wake')!.execute({});
  await clock.tickAsync(1000);
  t.is((await run).content[0].text, 'Woke up with the head inside dirt at (0, 79, 0): the bot takes suffocation damage until it moves out');

  // Standing on the floor of the pit: the eyes are at y 78.62, in air.
  bot.entity.position = new Vec3(0.5, 77, 0.5);
  const again = getTool('wake')!.execute({});
  await clock.tickAsync(1000);
  t.is((await again).content[0].text, 'Woke up');
});

// ---------------------------------------------------------------- 3, 4. pickups, drops left behind, broken tools

type FakeItem = { name: string; count: number; type: number; maxDurability?: number; durabilityUsed?: number };

function lootBot(items: FakeItem[] = []) {
  const bot = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const client = new EventEmitter();
  const inventory = Object.assign(new EventEmitter(), { items: () => items });
  const entities: Record<number, unknown> = {};
  Object.assign(bot, { _client: client, entity: { id: 1, position: new Vec3(0, 64, 0) }, entities, inventory });
  let nextId = 100;
  /** An item entity appears at `pos` (mineflayer's itemDrop comes with its metadata). */
  const drop = (name: string, count: number, pos: Vec3) => {
    const id = nextId++;
    const entity = { id, name: 'item', position: pos, isValid: true, getDroppedItem: () => ({ name, count }) };
    entities[id] = entity;
    bot.emit('itemDrop', entity);
    return entity;
  };
  const collect = (id: number, collector = 1, pickupItemCount?: number) => {
    client.emit('collect', { collectedEntityId: id, collectorEntityId: collector, pickupItemCount });
    if (collector === 1 || pickupItemCount === undefined) delete entities[id];
  };
  return { bot: bot as unknown as mineflayer.Bot, client, inventory, entities, drop, collect, items };
}

test.serial('watchLoot counts what the bot picks up by name, from the collect packet', (t) => {
  const clock = sinon.useFakeTimers({ now: NOW });
  t.teardown(() => clock.restore());
  const world = lootBot();
  const watch = watchLoot(world.bot);
  const a = world.drop('raw_iron', 2, new Vec3(5, 64, 0));
  world.collect(a.id, 1, 2);
  const b = world.drop('cobblestone', 1, new Vec3(6, 64, 0));
  world.collect(b.id);
  const c = world.drop('raw_iron', 1, new Vec3(7, 64, 0));
  world.collect(c.id, 1, 1);
  const theirs = world.drop('raw_iron', 5, new Vec3(8, 64, 0));
  world.collect(theirs.id, 2, 5);
  world.entities[300] = { id: 300, name: 'experience_orb', position: new Vec3(0, 64, 0) };
  world.collect(300, 1, 1);
  watch.stop();
  t.deepEqual([...watch.pickedUp()], [['raw_iron', 3], ['cobblestone', 1]], 'another player\'s pickup and an orb are not counted');
  t.is(describeLoot(watch), 'picked up 4 item(s) (3 raw_iron, 1 cobblestone)');
  t.is(world.client.listenerCount('collect'), 0, 'stop removes the listeners');
});

test.serial('watchLoot: drops near a noted source that are still on the ground at the end are listed; others are not', (t) => {
  const clock = sinon.useFakeTimers({ now: NOW });
  t.teardown(() => clock.restore());
  const world = lootBot();
  const watch = watchLoot(world.bot);
  const stray = world.drop('rotten_flesh', 1, new Vec3(10.5, 64, 0.5));
  clock.tick(5000);

  // A mob's drops appear at its death, before the hunt notes where it died.
  const beforeNote = world.drop('beef', 2, new Vec3(3.5, 64, 0.5));
  watch.noteSource(new Vec3(3.2, 64, 0.4));
  // A block's drop can also come just after the dig is noted.
  watch.noteSource(new Vec3(0.5, 64.5, 5.5));
  clock.tick(300);
  const afterNote = world.drop('raw_iron', 1, new Vec3(0.6, 64.2, 5.4));
  const pickedUp = world.drop('raw_iron', 1, new Vec3(0.4, 64.2, 5.6));
  world.collect(pickedUp.id, 1, 1);
  // 300 ms after the note: still inside the 2 s window.
  world.drop('raw_iron', 1, new Vec3(0.5, 64.2, 5.5));
  // Partly picked up (full inventory): as on the server, the collect packet carries the count from before the pickup,
  // and the new count of what stays on the ground comes after it in the item's metadata.
  const partial = world.drop('raw_iron', 3, new Vec3(0.5, 64, 6));
  world.client.emit('collect', { collectedEntityId: partial.id, collectorEntityId: 1, pickupItemCount: 3 });
  partial.getDroppedItem = () => ({ name: 'raw_iron', count: 1 });
  (world.bot as unknown as EventEmitter).emit('itemDrop', partial);

  watch.stop();
  t.truthy(stray && beforeNote && afterNote);
  t.deepEqual(Object.fromEntries(watch.leftOnGround()), { beef: 2, raw_iron: 3 });
  t.is(describeLoot(watch), 'picked up 3 item(s) (3 raw_iron); left 5 item(s) on the ground (3 raw_iron, 2 beef)');
});

test.serial('watchLoot: drops outside the 2 s window or 2 blocks of a source are not listed', (t) => {
  const clock = sinon.useFakeTimers({ now: NOW });
  t.teardown(() => clock.restore());
  const world = lootBot();
  const watch = watchLoot(world.bot);
  watch.noteSource(new Vec3(0.5, 64.5, 0.5));
  world.drop('dirt', 1, new Vec3(3.5, 64, 0.5));
  clock.tick(2100);
  world.drop('stone', 1, new Vec3(0.5, 64, 0.5));
  watch.stop();
  t.is(watch.leftOnGround().size, 0);
  t.is(describeLoot(watch), 'picked up nothing');
});

test.serial('watchLoot: a pickup counts once the item entity is gone; mineflayer emits entityGone before marking it invalid', (t) => {
  const clock = sinon.useFakeTimers({ now: NOW });
  t.teardown(() => clock.restore());
  const world = lootBot();
  const watch = watchLoot(world.bot);
  watch.noteSource(new Vec3(0.5, 64.5, 0.5));
  const drop = world.drop('raw_iron', 2, new Vec3(0.5, 64, 0.5));
  world.client.emit('collect', { collectedEntityId: drop.id, collectorEntityId: 1, pickupItemCount: 2 });
  (world.bot as unknown as EventEmitter).emit('entityGone', drop);
  t.deepEqual(Object.fromEntries(watch.pickedUp()), { raw_iron: 2 }, 'settled at entityGone, while the entity is still listed');
  t.is(watch.leftOnGround().size, 0);
  delete world.entities[drop.id];
  watch.stop();
  t.is(describeLoot(watch), 'picked up 2 item(s) (2 raw_iron)', 'not counted twice');
});

test.serial('watchLoot: a mob\'s drops are matched to the time of its death, even when the source is noted seconds later', (t) => {
  const clock = sinon.useFakeTimers({ now: NOW });
  t.teardown(() => clock.restore());
  const world = lootBot();
  const watch = watchLoot(world.bot);
  const diedAt = Date.now();
  world.drop('beef', 1, new Vec3(3.5, 64, 0.5));
  // A lagging server removes the body long after the death.
  clock.tick(3500);
  watch.noteSource(new Vec3(3.4, 64, 0.4), diedAt);
  watch.stop();
  t.deepEqual(Object.fromEntries(watch.leftOnGround()), { beef: 1 });
});

test.serial('watchLoot: tools lost because the bot died did not break', (t) => {
  const clock = sinon.useFakeTimers({ now: NOW });
  t.teardown(() => clock.restore());
  const sword: FakeItem = { name: 'stone_sword', count: 1, type: 1, maxDurability: 131, durabilityUsed: 130 };
  const world = lootBot([sword]);
  const watch = watchLoot(world.bot);
  world.items.splice(0, 1);
  world.inventory.emit('updateSlot', 36, sword, null);
  (world.bot as unknown as EventEmitter).emit('death');
  clock.tick(300);
  watch.stop();
  t.deepEqual(watch.brokenTools(), []);
});

test.serial('watchLoot: a worn-out tool that leaves the inventory broke; one moved to another slot or a healthy one did not', (t) => {
  const clock = sinon.useFakeTimers({ now: NOW });
  t.teardown(() => clock.restore());
  const pickaxe: FakeItem = { name: 'stone_pickaxe', count: 1, type: 1, maxDurability: 131, durabilityUsed: 130 };
  const axe: FakeItem = { name: 'stone_axe', count: 1, type: 2, maxDurability: 131, durabilityUsed: 129 };
  const sword: FakeItem = { name: 'iron_sword', count: 1, type: 3, maxDurability: 250, durabilityUsed: 10 };
  const world = lootBot([pickaxe, axe, sword]);
  const broken: string[] = [];
  const watch = watchLoot(world.bot, { onBroken: tool => broken.push(tool) });

  world.items.splice(world.items.indexOf(pickaxe), 1);
  world.inventory.emit('updateSlot', 36, pickaxe, null);
  // Equipping moves the axe to the hand: its old slot empties but it is still in the inventory.
  world.inventory.emit('updateSlot', 20, axe, null);
  // The sword is dropped or stored with plenty of durability left: not worn out.
  world.items.splice(world.items.indexOf(sword), 1);
  world.inventory.emit('updateSlot', 37, sword, null);
  clock.tick(300);

  t.deepEqual(watch.brokenTools(), ['stone_pickaxe']);
  t.deepEqual(broken, ['stone_pickaxe'], 'reported as it happens');

  // A tool that breaks just before the task ends is still caught.
  world.items.splice(world.items.indexOf(axe), 1);
  world.inventory.emit('updateSlot', 36, { ...axe, durabilityUsed: 130 }, null);
  watch.stop();
  t.deepEqual(watch.brokenTools(), ['stone_pickaxe', 'stone_axe']);
  t.is(describeLoot(watch), 'picked up nothing; stone_pickaxe broke; stone_axe broke');
});

/** gather on createFakeWorld: each dig drops the block's usual item, which the bot picks up unless `drops` says otherwise. */
function gatherWorld(blocks: Record<string, string>, items: FakeItem[]) {
  const world = createFakeWorld(blocks);
  const data = minecraftData(world.bot.version);
  const client = new EventEmitter();
  const emitter = new EventEmitter();
  const inventory = Object.assign(new EventEmitter(), { items: () => items });
  Object.assign(world.bot, {
    _client: client,
    inventory,
    on: (event: string, listener: (...args: unknown[]) => void) => emitter.on(event, listener),
    removeListener: (event: string, listener: (...args: unknown[]) => void) => emitter.removeListener(event, listener)
  });
  Object.assign(world.bot.entity, { id: 1 });
  world.bot.findBlocks.callsFake(({ point, matching, count }: { point: Vec3; matching: number; count: number }) =>
    [...world.blocks.entries()]
      .filter(([, name]) => name === data.blocks[matching]?.name)
      .map(([k]) => world.keyToVec(k))
      .sort((a, b) => a.distanceTo(point) - b.distanceTo(point))
      .slice(0, count));
  let nextId = 700;
  const spawnDrop = (name: string, pos: Vec3) => {
    const id = nextId++;
    const entity = { id, name: 'item', position: pos.offset(0.5, 0.25, 0.5), isValid: true, getDroppedItem: () => ({ name, count: 1 }) };
    (world.bot.entities as Record<number, unknown>)[id] = entity;
    emitter.emit('itemDrop', entity);
    return entity;
  };
  const pickUp = (entity: { id: number; getDroppedItem: () => { name: string; count: number } }) => {
    client.emit('collect', { collectedEntityId: entity.id, collectorEntityId: 1, pickupItemCount: 1 });
    delete (world.bot.entities as Record<number, unknown>)[entity.id];
    const { name } = entity.getDroppedItem();
    items.push({ name, count: 1, type: data.itemsByName[name]?.id ?? 0 });
  };
  const events = new EventStore();
  const tasks = new TaskManager({
    getBot: () => world.bot as never,
    getArbiter: () => new ActionArbiter({ stopBody: () => {} }),
    events,
    behaviors: [gatherBehavior] as never
  });
  return { ...world, data, inventory, items, tasks, events, spawnDrop, pickUp };
}

async function runGather(world: ReturnType<typeof gatherWorld>, clock: sinon.SinonFakeTimers, params: Record<string, unknown>) {
  const started = await world.tasks.start('gather', params);
  if (!started.ok) throw new Error(started.error);
  const end = world.tasks.waitForEnd('t1');
  await clock.tickAsync(10000);
  return end;
}

test.serial('gather reports what it picked up, not the net change: scaffolding placed on the way does not count against it', async (t) => {
  const clock = sinon.useFakeTimers({ now: NOW });
  t.teardown(() => clock.restore());
  const items: FakeItem[] = [{ name: 'dirt', count: 3, type: 9 }];
  const world = gatherWorld({ '2,64,0': 'oak_log', '3,64,0': 'oak_log' }, items);
  world.bot.dig.callsFake(async (block: { name: string; position: Vec3 }) => {
    world.blocks.delete(world.key(block.position));
    // The pathfinder used a dirt block as a step on the way (the old "inventory gained -1").
    items[0].count--;
    items[0].count--;
    world.pickUp(world.spawnDrop(block.name, block.position));
  });
  const final = await runGather(world, clock, { blockType: 'oak_log', count: 2 });
  t.is(final.status, 'done');
  t.is(final.result, 'Mined 2 of 2 oak_log; picked up 2 item(s) (2 oak_log)');
});

test.serial('gather lists drops it left on the ground', async (t) => {
  const clock = sinon.useFakeTimers({ now: NOW });
  t.teardown(() => clock.restore());
  const items: FakeItem[] = [{ name: 'stone_pickaxe', count: 1, type: 0, maxDurability: 131, durabilityUsed: 0 }];
  const world = gatherWorld({ '2,64,0': 'iron_ore', '3,64,0': 'iron_ore' }, items);
  items[0].type = world.data.itemsByName.stone_pickaxe.id;
  let digs = 0;
  world.bot.dig.callsFake(async (block: { position: Vec3 }) => {
    world.blocks.delete(world.key(block.position));
    const drop = world.spawnDrop('raw_iron', block.position);
    // The second drop falls where the bot does not get it.
    if (++digs === 1) world.pickUp(drop);
  });
  const final = await runGather(world, clock, { blockType: 'iron_ore', count: 2 });
  t.is(final.status, 'done');
  t.is(final.result, 'Mined 2 of 2 iron_ore; picked up 1 item(s) (1 raw_iron); left 1 item(s) on the ground (1 raw_iron)');
});

test.serial('gather stops when its pickaxe breaks and no tool left can harvest the ore, and says the pickaxe broke', async (t) => {
  const clock = sinon.useFakeTimers({ now: NOW });
  t.teardown(() => clock.restore());
  const pickaxe: FakeItem = { name: 'stone_pickaxe', count: 1, type: 0, maxDurability: 131, durabilityUsed: 129 };
  const wooden: FakeItem = { name: 'wooden_pickaxe', count: 1, type: 0, maxDurability: 59, durabilityUsed: 0 };
  const items: FakeItem[] = [pickaxe, wooden];
  const world = gatherWorld({ '2,64,0': 'iron_ore', '3,64,0': 'iron_ore', '4,64,0': 'iron_ore', '5,64,0': 'iron_ore' }, items);
  pickaxe.type = world.data.itemsByName.stone_pickaxe.id;
  wooden.type = world.data.itemsByName.wooden_pickaxe.id;
  world.bot.dig.callsFake(async (block: { position: Vec3 }) => {
    world.blocks.delete(world.key(block.position));
    world.pickUp(world.spawnDrop('raw_iron', block.position));
    pickaxe.durabilityUsed! += 1;
    if (pickaxe.durabilityUsed! >= pickaxe.maxDurability!) {
      items.splice(items.indexOf(pickaxe), 1);
      world.inventory.emit('updateSlot', 36, { ...pickaxe, durabilityUsed: pickaxe.maxDurability! - 1 }, null);
    }
  });
  const final = await runGather(world, clock, { blockType: 'iron_ore', count: 4 });
  t.is(world.bot.dig.callCount, 2, 'no digging with the wooden pickaxe, which gets nothing from iron ore');
  t.is(final.status, 'done', 'two were mined: a partial result');
  t.regex(final.result ?? '', /^Mined 2 of 4 iron_ore; picked up 2 item\(s\) \(2 raw_iron\); stone_pickaxe broke\. Stopped: no tool that can harvest iron_ore \(needs one of: [a-z_, ]*stone_pickaxe[a-z_, ]*\)$/);
  t.notRegex(final.result ?? '', /wooden_pickaxe/);
});

test.serial('gather with no tool that can harvest the block fails at once without digging; logs need no tool', async (t) => {
  const clock = sinon.useFakeTimers({ now: NOW });
  t.teardown(() => clock.restore());
  const world = gatherWorld({ '2,64,0': 'iron_ore' }, []);
  const final = await runGather(world, clock, { blockType: 'iron_ore', count: 1 });
  t.is(final.status, 'failed');
  t.regex(final.result ?? '', /^Mined 0 of 1 iron_ore; picked up nothing\. Stopped: no tool that can harvest iron_ore \(needs one of: .*stone_pickaxe/);
  t.true(world.bot.dig.notCalled);

  const logs = gatherWorld({ '2,64,0': 'oak_log' }, []);
  logs.bot.dig.callsFake(async (block: { name: string; position: Vec3 }) => {
    logs.blocks.delete(logs.key(block.position));
    logs.pickUp(logs.spawnDrop(block.name, block.position));
  });
  const second = await logs.tasks.start('gather', { blockType: 'oak_log', count: 1 });
  t.true(second.ok);
  const end = logs.tasks.waitForEnd('t1');
  await clock.tickAsync(10000);
  t.is((await end).result, 'Mined 1 of 1 oak_log; picked up 1 item(s) (1 oak_log)');
});

// ---------------------------------------------------------------- 5. leftover fuel of another kind

const item = (name: string, count: number, type: number) => ({ name, count, type, metadata: 0 }) as unknown as Item;

/** A furnace whose fuel slot holds `leftover`; smelting finishes as soon as input goes in. */
/**
 * A furnace whose fuel slot holds `leftover`; smelting finishes as soon as input goes in. The bot's inventory (window
 * slots 3-38) holds `inventory`, the rest of it is empty unless `emptySlots` says how many are.
 */
function fuelFurnace(leftover: Item | null, { inventory = [] as Item[], emptySlots = 30, takesAll = true, hangs = false } = {}) {
  const furnace = new EventEmitter() as mineflayer.Furnace & EventEmitter;
  let fuel: Item | null = leftover;
  let output = 0;
  const filler = Array.from({ length: 36 - inventory.length - emptySlots }, () => item('cobblestone', 64, 99));
  const slots: (Item | null)[] = [null, null, null, ...inventory, ...filler, ...Array(emptySlots).fill(null)];
  Object.assign(furnace, { inventoryStart: 3, inventoryEnd: 39, slots });
  furnace.fuelItem = sinon.stub().callsFake(() => fuel);
  furnace.takeFuel = sinon.stub().callsFake(async () => {
    if (hangs) return new Promise(() => {});
    const taken = fuel!;
    fuel = takesAll ? null : item(taken.name, 1, taken.type);
    // Like mineflayer's click prediction, the moved item object changes too.
    taken.count = 0;
    return taken;
  });
  furnace.putFuel = sinon.stub().callsFake(async (type: number, _metadata: unknown, count: number) => {
    if (fuel) throw new Error('fuel slot occupied');
    fuel = item('coal', count, type);
  });
  furnace.putInput = sinon.stub().callsFake(async (_type: number, _metadata: unknown, count: number) => { output += count; });
  furnace.inputItem = sinon.stub().returns(null);
  furnace.outputItem = sinon.stub().callsFake(() => (output ? item('iron_ingot', output, 2) : null));
  furnace.takeOutput = sinon.stub().callsFake(async () => {
    const taken = item('iron_ingot', output, 2);
    output = 0;
    return taken;
  });
  furnace.close = sinon.stub();
  return furnace;
}

function smelt(furnace: mineflayer.Furnace) {
  const { factory, getTool } = createFactory();
  const bot = { blockAt: sinon.stub().returns({ name: 'furnace' }), openFurnace: sinon.stub().resolves(furnace), inventory: { items: () => [item('raw_iron', 2, 1), item('coal', 3, 5)] } };
  registerFurnaceTools(factory, asBot(bot));
  return getTool('smelt-item')!.execute({ x: 0, y: 64, z: 0, inputItem: 'raw_iron', inputCount: 2, fuelItem: 'coal' });
}

test('smelt-item takes leftover fuel of another kind out first, then smelts with the requested fuel', async (t) => {
  const furnace = fuelFurnace(item('oak_planks', 3, 7));
  const result = await smelt(furnace);
  t.is(result.content[0].text, 'Smelted 2 iron_ingot; took 3 oak_planks out of the fuel slot first');
  t.true((furnace.takeFuel as sinon.SinonStub).calledBefore(furnace.putFuel as sinon.SinonStub));
  t.is((furnace.putFuel as sinon.SinonStub).firstCall.args[0], 5, 'the coal goes in');
});

test('smelt-item with the same fuel already in the slot just adds to it', async (t) => {
  const furnace = fuelFurnace(item('coal', 2, 5));
  (furnace.putFuel as sinon.SinonStub).resolves();
  const result = await smelt(furnace);
  t.is(result.content[0].text, 'Smelted 2 iron_ingot');
  t.true((furnace.takeFuel as sinon.SinonStub).notCalled);
});

const stack = (name: string, count: number, type: number) => Object.assign(item(name, count, type), { stackSize: 64 });
// An error since E-031: the furnace was not used.
const holds = (reason: string) =>
  `Failed: Furnace fuel slot holds 10 oak_planks and it could not be taken out (${reason}): pass fuelItem 'oak_planks' to smelt with it, or make room in the inventory`;

test('smelt-item says what to pass when the leftover fuel cannot be taken out, without trying a move that never finishes', async (t) => {
  const full = fuelFurnace(stack('oak_planks', 10, 7), { emptySlots: 0 });
  t.is((await smelt(full)).content[0].text, holds('the inventory is full'));
  t.true((full.takeFuel as sinon.SinonStub).notCalled);
  t.true((full.putFuel as sinon.SinonStub).notCalled);
  t.true((full.close as sinon.SinonStub).calledOnce, 'the furnace window is closed');

  // 4 more fit on the stack of 60 and no slot is empty: mineflayer's shift-click would wait forever.
  const partly = fuelFurnace(stack('oak_planks', 10, 7), { inventory: [stack('oak_planks', 60, 7)], emptySlots: 0 });
  t.is((await smelt(partly)).content[0].text, holds('the inventory is full'));
  t.true((partly.takeFuel as sinon.SinonStub).notCalled);

  const lastSlot = fuelFurnace(stack('oak_planks', 10, 7), { emptySlots: 1 });
  t.is((await smelt(lastSlot)).content[0].text, holds('no free inventory slot would be left for the output'), 'the ingots would be thrown on the ground');

  const leftBehind = fuelFurnace(stack('oak_planks', 10, 7), { takesAll: false });
  t.is((await smelt(leftBehind)).content[0].text, holds('the inventory has no room for all of it'));
  t.true((leftBehind.putFuel as sinon.SinonStub).notCalled);
});

test('smelt-item: leftover fuel that merges into a stack needs no empty slot of its own; the count reported is what the slot held', async (t) => {
  const merges = fuelFurnace(stack('oak_planks', 10, 7), { inventory: [stack('oak_planks', 50, 7)], emptySlots: 1 });
  t.is((await smelt(merges)).content[0].text, 'Smelted 2 iron_ingot; took 10 oak_planks out of the fuel slot first');
});

test.serial('smelt-item gives up on a take-out that does not finish', async (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());
  const stuck = fuelFurnace(stack('oak_planks', 10, 7), { hangs: true });
  const run = smelt(stuck);
  await clock.tickAsync(5000);
  t.is((await run).content[0].text, holds('taking it out did not finish'));
  t.true((stuck.close as sinon.SinonStub).calledOnce);
});
