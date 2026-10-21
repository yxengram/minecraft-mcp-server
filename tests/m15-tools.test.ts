// Contract: docs/BLUEPRINT.md E-017 (M15), the tool problems from the live Nether portal test: buckets (use-item),
// activate-block reporting success when nothing happened, dig-block and its tool, dig times of pickaxe blocks,
// walking into portals, beds outside the overworld, magma on paths, piglins and the entity labels, and the time line
// in the Nether. Expected values come from the contract.
import test from 'ava';
import sinon from 'sinon';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import prismarineBlock from 'prismarine-block';
import type mineflayer from 'mineflayer';
import { digSeconds, fixToolMaterials, missingHarvestTools } from '../src/tools/block-utils.js';
import { registerBlockTools } from '../src/tools/block-tools.js';
import { registerInteractionTools } from '../src/tools/interaction-tools.js';
import { registerWaypointTools } from '../src/tools/waypoint-tools.js';
import { registerGameStateTools } from '../src/tools/gamestate-tools.js';
import { configureMovements, MAGMA_STEP_COST, portalReport } from '../src/tools/movement-utils.js';
import { assessThreats, checkTarget, mobHostility } from '../src/autopilot/threats.js';
import { describeEntity, entityKind, findNearbyEntities } from '../src/tools/entity-utils.js';
import { WaypointStore } from '../src/waypoint-store.js';
import { BODY_TOOLS } from '../src/tool-factory.js';
import { arriveAtGoal, asBot, createFactory } from './_helpers.js';

const VERSION = '26.1.2';

// ---------------------------------------------------------------- 4. dig times of pickaxe blocks

test('fixToolMaterials: the 108 "incorrect_for_" blocks become pickaxe blocks and dig as fast as in the game', (t) => {
  // Each test file runs in its own worker, so fixing the shared registry here does not leak into other files.
  const registry = minecraftData(VERSION);
  const Block = prismarineBlock(registry as never);
  const item = (name: string) => registry.itemsByName[name].id;
  const ms = (block: string, tool: string) =>
    Block.fromStateId(registry.blocksByName[block].defaultState, 0).digTime(item(tool), false, false, false, [], {} as never);

  t.is(ms('obsidian', 'diamond_pickaxe'), 75000, 'before: the pickaxe speed is ignored');
  t.is(ms('iron_ore', 'stone_pickaxe'), 4550);
  const netherrack = ms('netherrack', 'diamond_pickaxe');

  const fixed = fixToolMaterials(registry as never);

  t.is(fixed, 108);
  t.is(ms('obsidian', 'diamond_pickaxe'), 9400, 'obsidian with a diamond pickaxe, as in the game');
  t.is(ms('iron_ore', 'stone_pickaxe'), 1150);
  t.is(ms('diamond_ore', 'iron_pickaxe'), 750);
  t.is(ms('ancient_debris', 'diamond_pickaxe'), 5650);
  t.is(ms('netherrack', 'diamond_pickaxe'), netherrack, 'blocks that were right stay the same');
  t.is(registry.blocksByName.obsidian.material, 'mineable/pickaxe');
  t.truthy(registry.blocksByName.obsidian.harvestTools, 'harvest tools are unchanged');
  const pickaxes = new Set(['wooden', 'stone', 'copper', 'iron', 'golden', 'diamond', 'netherite']
    .map(tier => registry.itemsByName[`${tier}_pickaxe`]?.id));
  for (const block of registry.blocksArray.filter(b => /^incorrect_for_/.test((b as { material?: string }).material ?? ''))) {
    t.fail(`${block.name} still has an incorrect_for_ material`);
  }
  const notPickaxe = Object.values(registry.blocksByName)
    .filter(b => b.material === 'mineable/pickaxe' && b.harvestTools && Object.keys(b.harvestTools).some(id => !pickaxes.has(Number(id))));
  t.deepEqual(notPickaxe.map(b => b.name), [], 'every harvest tool of a pickaxe block is a pickaxe');
  t.is(fixToolMaterials(registry as never), 0, 'a second call changes nothing');
  t.is(fixToolMaterials(undefined), 0);
});

// ---------------------------------------------------------------- 3. dig-block and its tool

function digWorld({ inventory, held = null as { name: string; type: number } | null }: { inventory: { name: string; type: number; count: number }[]; held?: { name: string; type: number } | null }) {
  const obsidian = {
    name: 'obsidian', position: new Vec3(1, 64, 0), diggable: true,
    harvestTools: { 900: true, 901: true },
    digTime: (tool: number | null) => (tool === 900 ? 9400 : 250000)
  };
  const bot = {
    entity: { position: new Vec3(0, 64, 0), effects: {} },
    registry: { items: { 900: { name: 'diamond_pickaxe' }, 901: { name: 'netherite_pickaxe' } } },
    heldItem: held,
    inventory: { items: () => inventory },
    blockAt: sinon.stub().returns(obsidian),
    canDigBlock: () => true,
    canSeeBlock: () => true,
    pathfinder: { goto: sinon.stub().resolves(), bestHarvestTool: sinon.stub().callsFake(() => inventory.find(i => i.type === 900) ?? null) },
    equip: sinon.stub().callsFake(async (item: { name: string; type: number }) => { bot.heldItem = item; }),
    dig: sinon.stub().resolves()
  };
  return { bot, obsidian };
}

test('dig-block equips the best tool, then digs, and says which tool it used', async (t) => {
  const pickaxe = { name: 'diamond_pickaxe', type: 900, count: 1 };
  const { bot } = digWorld({ inventory: [{ name: 'iron_sword', type: 5, count: 1 }, pickaxe], held: { name: 'iron_sword', type: 5 } });
  const { factory, getTool } = createFactory();
  registerBlockTools(factory, asBot(bot));

  const result = await getTool('dig-block')!.execute({ x: 1, y: 64, z: 0 });

  t.falsy(result.isError);
  t.true(bot.equip.calledOnceWith(pickaxe, 'hand'), 'the sword the instinct left in the hand is swapped for the pickaxe');
  t.true(bot.equip.calledBefore(bot.dig));
  t.regex(result.content[0].text, /^Dug obsidian at \(1, 64, 0\) with diamond_pickaxe \(\d+\.\d s\)$/);
});

test('dig-block refuses a block no tool in the inventory can harvest, with the tools it needs and the time it would take', async (t) => {
  const { bot } = digWorld({ inventory: [{ name: 'iron_sword', type: 5, count: 1 }], held: { name: 'iron_sword', type: 5 } });
  const { factory, getTool } = createFactory();
  registerBlockTools(factory, asBot(bot));

  const result = await getTool('dig-block')!.execute({ x: 1, y: 64, z: 0 });

  t.true(result.isError);
  t.is(result.content[0].text, 'Failed: Cannot harvest obsidian with what the bot has (needs diamond_pickaxe or netherite_pickaxe): digging would take about 250 s and drop nothing');
  t.false(bot.dig.called);
  t.false(bot.pathfinder.goto.called, 'it does not walk there either');
});

test('dig-block keeps the held item when no tool digs faster than a bare hand', async (t) => {
  const litter = { name: 'leaf_litter', type: 7, count: 3 };
  const grass = { name: 'grass_block', position: new Vec3(1, 64, 0), diggable: true, harvestTools: undefined, digTime: () => 900 };
  const bot = {
    entity: { position: new Vec3(0, 64, 0), effects: {} }, heldItem: { name: 'iron_sword', type: 5 },
    inventory: { items: () => [litter] }, blockAt: () => grass, canDigBlock: () => true, canSeeBlock: () => true,
    pathfinder: { goto: sinon.stub().resolves(), bestHarvestTool: () => litter }, equip: sinon.stub().resolves(), dig: sinon.stub().resolves()
  };
  const { factory, getTool } = createFactory();
  registerBlockTools(factory, asBot(bot));
  const text = (await getTool('dig-block')!.execute({ x: 1, y: 64, z: 0 })).content[0].text;
  t.false(bot.equip.called);
  t.regex(text, /with iron_sword/);
});

test('missingHarvestTools and digSeconds: null when any tool will do or the bot has one; null for an unknown time', (t) => {
  const { bot, obsidian } = digWorld({ inventory: [{ name: 'diamond_pickaxe', type: 900, count: 1 }] });
  t.is(missingHarvestTools(bot as never, obsidian as never), null);
  t.is(missingHarvestTools(bot as never, { name: 'dirt', harvestTools: undefined } as never), null);
  t.is(digSeconds(bot as never, obsidian as never, 900), 9.4);
  t.is(digSeconds(bot as never, { digTime: () => { throw new Error('no data'); } } as never, null), null);
});

// ---------------------------------------------------------------- 2. activate-block reports "no visible change"

function activateBot(change: boolean) {
  let state = 1;
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    heldItem: { name: 'water_bucket', count: 1 },
    pathfinder: { goto: sinon.stub().resolves() },
    lookAt: sinon.stub().resolves(),
    blockAt: () => ({ name: change ? 'oak_door' : 'grass_block', position: new Vec3(1, 64, 0), stateId: state }),
    activateBlock: sinon.stub().callsFake(async () => { if (change) state = 2; })
  };
  return bot;
}

test('activate-block says when nothing changed and points to use-item for the held item', async (t) => {
  const { factory, getTool } = createFactory();
  registerInteractionTools(factory, asBot(activateBot(false)));
  const text = (await getTool('activate-block')!.execute({ x: 1, y: 64, z: 0 })).content[0].text;
  t.is(text, 'Activated grass_block at (1, 64, 0); no visible change; to use the held water_bucket on a liquid or into the air, use use-item');
});

test('activate-block reports plainly when the block changed state (a door opened)', async (t) => {
  const { factory, getTool } = createFactory();
  registerInteractionTools(factory, asBot(activateBot(true)));
  const result = await getTool('activate-block')!.execute({ x: 1, y: 64, z: 0 });
  t.falsy(result.isError);
  t.is(result.content[0].text, 'Activated oak_door at (1, 64, 0)');
});

test('activate-block counts a fire or portal above the clicked block as a change (flint and steel)', async (t) => {
  let lit = false;
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    heldItem: { name: 'flint_and_steel', count: 1, durabilityUsed: 0 },
    pathfinder: { goto: sinon.stub().resolves() },
    lookAt: sinon.stub().resolves(),
    blockAt: (pos: Vec3) => ({ name: pos.y === 64 ? 'obsidian' : lit ? 'nether_portal' : 'air', position: pos.floored(), stateId: 1 }),
    activateBlock: sinon.stub().callsFake(async () => { lit = true; })
  };
  const { factory, getTool } = createFactory();
  registerInteractionTools(factory, asBot(bot));
  t.is((await getTool('activate-block')!.execute({ x: 1, y: 64, z: 0 })).content[0].text, 'Activated obsidian at (1, 64, 0)');
});

// ---------------------------------------------------------------- 1. use-item

type Cell = { name: string; boundingBox?: string; stateId?: number; level?: number };

/** A bot at (0.5, 64, 0.5) on a stone floor (y = 63); `cells` overrides blocks; activateItem runs `onUse`. */
function useWorld({ cells = {}, held, inventory = [], players = {}, onUse }: {
  cells?: Record<string, Cell>; held: { name: string; count: number } | null; inventory?: { name: string; count: number }[];
  players?: Record<string, unknown>; onUse?: (world: { cells: Map<string, Cell>; bot: Record<string, unknown> }) => void;
}) {
  const map = new Map(Object.entries(cells));
  const key = (pos: Vec3) => { const p = pos.floored(); return `${p.x},${p.y},${p.z}`; };
  const bot: Record<string, unknown> & { heldItem: unknown } = {
    username: 'Bot',
    entity: { position: new Vec3(0.5, 64, 0.5) },
    heldItem: held,
    players,
    inventory: { items: () => inventory },
    pathfinder: { goto: sinon.stub().resolves() },
    lookAt: sinon.stub().resolves(),
    equip: sinon.stub().callsFake(async (item: unknown) => { bot.heldItem = item; }),
    deactivateItem: sinon.stub(),
    blockAt: (pos: Vec3) => {
      const cell = map.get(key(pos)) ?? (pos.floored().y <= 63 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' });
      return { ...cell, position: pos.floored(), getProperties: () => (cell.level === undefined ? {} : { level: cell.level }) };
    }
  };
  bot.activateItem = sinon.stub().callsFake(() => onUse?.({ cells: map, bot }));
  return { bot, cells: map };
}

test('use-item pours a water bucket into a cell, aiming at the solid face below it, and reports the change', async (t) => {
  const { bot } = useWorld({
    held: { name: 'water_bucket', count: 1 },
    onUse: ({ cells, bot }) => { cells.set('3,64,0', { name: 'water', boundingBox: 'empty', level: 0 }); bot.heldItem = { name: 'bucket', count: 1 }; }
  });
  const { factory, getTool } = createFactory();
  registerInteractionTools(factory, asBot(bot));

  const result = await getTool('use-item')!.execute({ x: 3, y: 64, z: 0 });

  t.falsy(result.isError);
  t.is(result.content[0].text, 'Used water_bucket at (3, 64, 0): the cell is now water; holding bucket x1');
  const aim = (bot.lookAt as sinon.SinonStub).firstCall.args[0] as Vec3;
  t.deepEqual([aim.x, aim.y, aim.z], [3.5, 64, 0.5], 'the top face of the stone under the cell');
  t.true((bot.deactivateItem as sinon.SinonStub).calledOnce);
});

test('use-item fills an empty bucket from a liquid source, and refuses flowing liquid without using the item', async (t) => {
  const source = useWorld({
    cells: { '2,64,0': { name: 'lava', boundingBox: 'empty', level: 0 } },
    held: { name: 'bucket', count: 1 },
    onUse: ({ cells, bot }) => { cells.set('2,64,0', { name: 'air', boundingBox: 'empty' }); bot.heldItem = { name: 'lava_bucket', count: 1 }; }
  });
  const first = createFactory();
  registerInteractionTools(first.factory, asBot(source.bot));
  const filled = await first.getTool('use-item')!.execute({ x: 2, y: 64, z: 0 });
  t.is(filled.content[0].text, 'Used bucket at (2, 64, 0): the cell is now air; holding lava_bucket x1');
  const aim = (source.bot.lookAt as sinon.SinonStub).firstCall.args[0] as Vec3;
  t.deepEqual([aim.x, aim.y, aim.z], [2.5, 64.5, 0.5], 'the middle of the liquid cell');

  const flowing = useWorld({ cells: { '2,64,0': { name: 'water', boundingBox: 'empty', level: 3 } }, held: { name: 'bucket', count: 1 } });
  const second = createFactory();
  registerInteractionTools(second.factory, asBot(flowing.bot));
  const refused = await second.getTool('use-item')!.execute({ x: 2, y: 64, z: 0 });
  t.true(refused.isError);
  t.regex(refused.content[0].text, /needs a liquid source block at \(2, 64, 0\); it holds water/);
  t.false((flowing.bot.activateItem as sinon.SinonStub).called);
});

test('use-item fails when nothing changed, saying what is still there', async (t) => {
  const { bot } = useWorld({ held: { name: 'water_bucket', count: 1 } });
  const { factory, getTool } = createFactory();
  registerInteractionTools(factory, asBot(bot));

  const result = await getTool('use-item')!.execute({ x: 3, y: 64, z: 0 });

  t.true(result.isError);
  t.is(result.content[0].text, 'Failed: Used water_bucket at (3, 64, 0) but nothing changed: the cell is still air and the bot still holds water_bucket x1');
});

test('use-item fails when the held item changed but the target cell did not (the liquid went elsewhere)', async (t) => {
  const { bot } = useWorld({ held: { name: 'water_bucket', count: 1 }, onUse: ({ cells, bot }) => {
    cells.set('3,65,0', { name: 'water', boundingBox: 'empty', level: 0 }); bot.heldItem = { name: 'bucket', count: 1 };
  } });
  const { factory, getTool } = createFactory();
  registerInteractionTools(factory, asBot(bot));
  const result = await getTool('use-item')!.execute({ x: 3, y: 64, z: 0 });
  t.true(result.isError);
  t.is(result.content[0].text, 'Failed: Used water_bucket at (3, 64, 0), but the cell is still air; the bot now holds bucket x1, so it took effect somewhere else');
});

test('use-item refuses to pour lava next to the bot or within 10 blocks of another player', async (t) => {
  const near = useWorld({ held: { name: 'lava_bucket', count: 1 } });
  const first = createFactory();
  registerInteractionTools(first.factory, asBot(near.bot));
  const beside = await first.getTool('use-item')!.execute({ x: 1, y: 64, z: 0 });
  t.true(beside.isError);
  t.is(beside.content[0].text, 'Failed: Refusing to pour lava at (1, 64, 0): the cell is in or next to the bot itself');

  const player = { username: 'Thomas_Summon', entity: { position: new Vec3(9, 64, 0) } };
  const other = useWorld({ held: { name: 'lava_bucket', count: 1 }, players: { Thomas_Summon: player, Bot: { username: 'Bot', entity: near.bot.entity } } });
  const second = createFactory();
  registerInteractionTools(second.factory, asBot(other.bot));
  const nearPlayer = await second.getTool('use-item')!.execute({ x: 3, y: 64, z: 0 });
  t.is(nearPlayer.content[0].text, 'Failed: Refusing to pour lava at (3, 64, 0): Thomas_Summon is within 10 blocks of it');
  t.false((near.bot.activateItem as sinon.SinonStub).called);
  t.false((other.bot.activateItem as sinon.SinonStub).called);

  const far = useWorld({ held: { name: 'lava_bucket', count: 1 }, players: { Thomas_Summon: { ...player, entity: { position: new Vec3(30, 64, 0) } } },
    onUse: ({ cells, bot }) => { cells.set('3,64,0', { name: 'lava', boundingBox: 'empty', level: 0 }); bot.heldItem = { name: 'bucket', count: 1 }; } });
  const third = createFactory();
  registerInteractionTools(third.factory, asBot(far.bot));
  t.falsy((await third.getTool('use-item')!.execute({ x: 3, y: 64, z: 0 })).isError, 'two blocks away and no player near: allowed');
});

test('use-item equips the named item, uses it where the bot looks without a position, and checks its arguments', async (t) => {
  const pearl = { name: 'ender_pearl', count: 3 };
  const { bot } = useWorld({ held: null, inventory: [pearl], onUse: ({ bot }) => { bot.heldItem = { name: 'ender_pearl', count: 2 }; } });
  const { factory, getTool } = createFactory();
  registerInteractionTools(factory, asBot(bot));

  const thrown = await getTool('use-item')!.execute({ itemName: 'ender_pearl' });
  t.true((bot.equip as sinon.SinonStub).calledOnceWith(pearl, 'hand'));
  t.is(thrown.content[0].text, 'Used ender_pearl; holding ender_pearl x2');
  t.false((bot.lookAt as sinon.SinonStub).called);

  t.regex((await getTool('use-item')!.execute({ x: 1, y: 64 })).content[0].text, /all of x, y and z/);
  t.regex((await getTool('use-item')!.execute({ itemName: 'snowball' })).content[0].text, /No snowball in the inventory/);
  t.true(BODY_TOOLS.has('use-item'), 'it drives the body, so it holds the action lease');
});

test('use-item aims a filled bucket at a face the eyes can see, and may pour into lava (the live lava lake)', async (t) => {
  // The lava at (3, 64, 0) has stone below it and stone to the west. Here the ray toward the floor's top face is
  // blocked by the west stone, so the west stone's east face is used.
  const { bot } = useWorld({
    cells: { '3,64,0': { name: 'lava', boundingBox: 'empty', level: 0 }, '2,64,0': { name: 'stone', boundingBox: 'block' } },
    held: { name: 'water_bucket', count: 1 },
    onUse: ({ cells, bot }) => { cells.set('3,64,0', { name: 'water', boundingBox: 'empty', level: 0 }); bot.heldItem = { name: 'bucket', count: 1 }; }
  });
  const rays: Vec3[] = [];
  bot.world = { raycast: (_from: Vec3, dir: Vec3) => { rays.push(dir); return { position: new Vec3(2, 64, 0) }; } };
  const { factory, getTool } = createFactory();
  registerInteractionTools(factory, asBot(bot));

  const result = await getTool('use-item')!.execute({ x: 3, y: 64, z: 0 });

  t.is(result.content[0].text, 'Used water_bucket at (3, 64, 0): the cell is now water; holding bucket x1');
  const aim = (bot.lookAt as sinon.SinonStub).firstCall.args[0] as Vec3;
  t.deepEqual([aim.x, aim.y, aim.z], [3, 64.5, 0.5], 'the east face of the west stone, the first face the eyes can see');
  t.is(rays.length, 2, 'the floor face was tried first and skipped');
});

test('use-item will not empty a bucket into a solid block or a cell with nothing solid next to it', async (t) => {
  const solid = useWorld({ cells: { '3,64,0': { name: 'dirt', boundingBox: 'block' } }, held: { name: 'water_bucket', count: 1 } });
  const first = createFactory();
  registerInteractionTools(first.factory, asBot(solid.bot));
  t.regex((await first.getTool('use-item')!.execute({ x: 3, y: 64, z: 0 })).content[0].text, /Cannot empty water_bucket into \(3, 64, 0\): it holds dirt/);

  const floating = useWorld({ held: { name: 'water_bucket', count: 1 } });
  const second = createFactory();
  registerInteractionTools(second.factory, asBot(floating.bot));
  t.regex((await second.getTool('use-item')!.execute({ x: 3, y: 70, z: 0 })).content[0].text, /no solid block next to it that the bot can aim at/);
});

// ---------------------------------------------------------------- 6. beds outside the overworld

test('sleep refuses outside the overworld before looking for a bed', async (t) => {
  const bot = { isSleeping: false, game: { dimension: 'the_nether' }, findBlock: sinon.stub(), sleep: sinon.stub().resolves(), isABed: () => true };
  const { factory, getTool } = createFactory();
  registerInteractionTools(factory, asBot(bot));

  const result = await getTool('sleep')!.execute({});

  t.true(result.isError);
  t.is(result.content[0].text, 'Failed: Beds explode in the_nether; the bot did not use the bed');
  t.false(bot.findBlock.called);
  t.false(bot.sleep.called);
});

// ---------------------------------------------------------------- 5. walking into portals

function portalSetup(portalCells: string[]) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-m15-')), 'waypoints.json');
  const store = new WaypointStore(file, 'localhost');
  const portals = new Set(portalCells);
  const bot = {
    entity: { position: new Vec3(0.5, 68, 3.5) },
    game: { dimension: 'overworld' },
    pathfinder: { goto: sinon.stub(), stop: sinon.stub(), setGoal: sinon.stub() },
    blockAt: (pos: Vec3) => { const p = pos.floored(); return { name: portals.has(`${p.x},${p.y},${p.z}`) && bot.game.dimension === 'overworld' ? 'nether_portal' : 'air' }; }
  };
  bot.pathfinder.goto.callsFake(arriveAtGoal(bot));
  const { factory, getTool } = createFactory();
  registerWaypointTools(factory, asBot(bot), store);
  return { store, bot, getTool };
}

test('goto-waypoint walks right into a portal waypoint and reports the trip to the other dimension', async (t) => {
  const { store, bot, getTool } = portalSetup(['-1340,68,-428']);
  store.set('portal', { x: -1340, y: 68, z: -428, dimension: 'overworld', createdAt: 0 });
  // The server moves the player about 4 s after it steps in; here a little sooner.
  bot.pathfinder.goto.callsFake(async (goal: { x: number; y: number; z: number }) => {
    bot.entity.position = new Vec3(goal.x, goal.y, goal.z);
    setTimeout(() => { bot.game.dimension = 'the_nether'; bot.entity.position = new Vec3(-168.5, 68, -51.5); }, 300);
  });

  const result = await getTool('goto-waypoint')!.execute({ name: 'portal' });

  t.is((bot.pathfinder.goto.firstCall.args[0] as { rangeSq: number }).rangeSq, 0, 'range 0 by default for a waypoint in a portal');
  t.is(result.content[0].text, "Arrived near waypoint 'portal' (-1340, 68, -428); went through the portal: now in the_nether at (-169, 68, -52)");
});

test('goto-waypoint keeps range 2 for other waypoints and adds nothing when the bot ends outside a portal', async (t) => {
  const { store, bot, getTool } = portalSetup([]);
  store.set('home', { x: 5, y: 68, z: 9, dimension: 'overworld', createdAt: 0 });
  const result = await getTool('goto-waypoint')!.execute({ name: 'home' });
  t.is((bot.pathfinder.goto.firstCall.args[0] as { rangeSq: number }).rangeSq, 4);
  t.is(result.content[0].text, "Arrived near waypoint 'home' (5, 68, 9)");
});

test('portalReport says when the dimension did not change while the bot stood in the portal', async (t) => {
  const bot = { entity: { position: new Vec3(0.5, 68, 0.5) }, game: { dimension: 'overworld' }, blockAt: () => ({ name: 'nether_portal' }) };
  t.is(await portalReport(bot as unknown as mineflayer.Bot, 600), '; stood in the portal for 1 s; the dimension did not change (right after a trip, wait about 15 s outside the portal before walking back in)');
  t.is(await portalReport({ ...bot, blockAt: () => ({ name: 'air' }) } as unknown as mineflayer.Bot, 600), '');
});

// ---------------------------------------------------------------- 7. magma on paths

test('configureMovements: walking over a magma block costs extra, but is not forbidden', (t) => {
  const below = (name: string) => ({ canOpenDoors: false, exclusionAreasBreak: [], exclusionAreasStep: [] as ((block: { name: string; position?: unknown }) => number)[],
    getBlock: sinon.stub().callsFake((_pos: unknown, _dx: number, dy: number) => ({ name: dy === -1 ? name : 'air' })) });
  const magma = below('magma_block');
  const lookup = magma.getBlock;
  configureMovements(magma as never);
  t.is(magma.exclusionAreasStep.length, 1);
  t.is(magma.exclusionAreasStep[0]({ name: 'air', position: { x: 0, y: 64, z: 0 } }), MAGMA_STEP_COST);
  t.true(MAGMA_STEP_COST < 100, '100 would make the pathfinder refuse the way entirely');
  t.deepEqual(lookup.firstCall.args.slice(1), [0, -1, 0], 'it looks at the block under the cell');

  const netherrack = below('netherrack');
  configureMovements(netherrack as never);
  t.is(netherrack.exclusionAreasStep[0]({ name: 'air', position: { x: 0, y: 64, z: 0 } }), 0);
});

// ---------------------------------------------------------------- 8. piglins and the entity labels

function mobWorld(armor: string[] = []) {
  const slots: ({ name: string } | null)[] = [];
  armor.forEach((name, index) => { slots[5 + index] = { name }; });
  const self = { id: 1, type: 'player', username: 'Bot', position: new Vec3(0.5, 64, 0.5) };
  const piglin = { id: 2, name: 'piglin', type: 'hostile', position: new Vec3(3.5, 64, 0.5), isValid: true };
  const zombified = { id: 3, name: 'zombified_piglin', type: 'hostile', position: new Vec3(5.5, 64, 0.5), isValid: true };
  const newMob = { id: 4, name: 'some_new_mob', type: 'hostile', position: new Vec3(7.5, 64, 0.5), isValid: true };
  const bot = {
    registry: minecraftData(VERSION), entity: self, entities: { 1: self, 2: piglin, 3: zombified, 4: newMob }, players: {},
    inventory: { slots, items: () => [] },
    blockAt: (pos: Vec3) => ({ name: 'air', position: pos.floored() })
  };
  return { bot: bot as unknown as mineflayer.Bot, piglin, zombified, newMob };
}

test('piglins are hostile unless the bot wears a piece of gold armor; zombified piglins stay neutral', (t) => {
  const bare = mobWorld(['iron_helmet']);
  t.is(mobHostility(bare.bot, bare.piglin as never), 'hostile');
  t.true(checkTarget(bare.bot, bare.piglin as never).legal, 'guard may fight a piglin that attacks on sight');
  t.deepEqual(assessThreats(bare.bot).hostiles.map(threat => threat.entity.id), [2], 'the instinct sees it as a hostile mob');
  t.is(mobHostility(bare.bot, bare.zombified as never), 'neutral');

  for (const piece of ['golden_helmet', 'golden_chestplate', 'golden_leggings', 'golden_boots']) {
    const slots = ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'];
    slots[['golden_helmet', 'golden_chestplate', 'golden_leggings', 'golden_boots'].indexOf(piece)] = piece;
    const gold = mobWorld(slots);
    t.is(mobHostility(gold.bot, gold.piglin as never), 'neutral', `${piece} is enough`);
    t.false(checkTarget(gold.bot, gold.piglin as never).legal);
    t.deepEqual(assessThreats(gold.bot).hostiles, []);
  }
});

test('entity labels follow the autopilot: zombified piglins are [neutral], unknown hostile mobs stay [hostile]', (t) => {
  const { bot, zombified, newMob, piglin } = mobWorld(['golden_helmet']);
  t.is(entityKind(bot, zombified as never), 'neutral');
  t.is(entityKind(bot, piglin as never), 'neutral');
  t.is(entityKind(bot, newMob as never), 'hostile', 'a mob the lists do not know keeps minecraft-data\'s type');

  const nearby = findNearbyEntities(bot, { maxDistance: 16 });
  t.regex(describeEntity(nearby.find(n => n.entity.id === 3)!), /^zombified_piglin \[neutral\], id 3/);
  t.deepEqual(findNearbyEntities(bot, { type: 'hostile', maxDistance: 16 }).map(n => n.entity.id), [4], 'the hostile filter agrees');
  t.deepEqual(findNearbyEntities(mobWorld().bot, { type: 'hostile', maxDistance: 16 }).map(n => n.entity.id), [2, 4], 'without gold the piglin is hostile');
});

// ---------------------------------------------------------------- 9. the time line in the Nether

test('get-observation has no day, night or weather outside the overworld', async (t) => {
  const bot = (dimension: string) => ({
    version: '1.21.8', entity: { id: 1, position: new Vec3(0, 64, 0), effects: {}, metadata: [] }, entities: {},
    game: { dimension, gameMode: 'survival' }, health: 20, food: 20, foodSaturation: 5, experience: { level: 0, points: 0 },
    time: { timeOfDay: 1264, isDay: true }, isRaining: true, thunderState: 0, heldItem: null,
    getEquipmentDestSlot: () => 0, inventory: { slots: [], items: () => [] }, blockAt: () => ({ name: 'air' })
  });
  const nether = createFactory();
  registerGameStateTools(nether.factory, asBot(bot('the_nether')));
  t.regex((await nether.getTool('get-observation')!.execute({})).content[0].text,
    /Time: no day or night in the_nether; weather: none here/);

  const overworld = createFactory();
  registerGameStateTools(overworld.factory, asBot(bot('overworld')));
  t.regex((await overworld.getTool('get-observation')!.execute({})).content[0].text, /Time: 1264 ticks \(day\), weather: rain/);
});
