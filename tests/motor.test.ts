// Contract: docs/BLUEPRINT.md F-042 (src/autopilot/instinct/motor.ts) and the M9 parts of F-037 to F-039 (F1-h): the
// motor code moved from the reflexes, the macros built on it (run_from_creeper, flee, fight, hold, eat), the cues
// that replaced the reflex triggers, and the menu's safety filter (invariant I1). Most tests here were moved from
// tests/reflexes.test.ts (F-025, deleted in M9) with their assertions; what belonged to the deleted reflex engine
// (leases, reflex events, cooldowns) is gone. Expected values come from the contracts, not from what the code prints.
import test, { ExecutionContext } from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import pathfinderPkg from 'mineflayer-pathfinder';
import { bestFood, eat, holdGround, runAway } from '../src/autopilot/instinct/motor.js';
import { MACROS, MacroName } from '../src/autopilot/instinct/macros.js';
import { readCues } from '../src/autopilot/instinct/attention.js';
import { buildMenu } from '../src/autopilot/instinct/affordances.js';
import { engage } from '../src/autopilot/combat.js';
import { Policy, PolicyStore, PolicyUpdate } from '../src/autopilot/policy.js';

const { goals } = pathfinderPkg;
const VERSION = '1.21.8';
const registry = minecraftData(VERSION);
const TICK = 50;
// Vanilla sprinting covers about 5.6 blocks a second; walking about 4.3.
const SPRINT_PER_TICK = 0.28;
const WALK_PER_TICK = 0.215;
// An ignited creeper explodes 1.5 s (30 ticks) after it starts to swell.
const CREEPER_FUSE_MS = 1500;
const EMPTY_BLOCKS = new Set(['air', 'cave_air', 'fire', 'soul_fire']);
const HOSTILE_NAMES = new Set(['zombie', 'skeleton', 'creeper', 'spider']);
// F-042: food the bot never eats by itself.
const AVOID_FOODS = [
  'rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken', 'chorus_fruit',
  'golden_apple', 'enchanted_golden_apple', 'golden_carrot', 'suspicious_stew'
];

// ---- fake world ------------------------------------------------------------------------------------------------

type FakeEntity = {
  id: number;
  name: string;
  type: string;
  username?: string;
  position: Vec3;
  isValid: boolean;
  height: number;
  width: number;
  metadata: unknown[];
};

type FakeItem = { name: string; count: number; type: number; slot: number };

let nextId = 100;

/** Builds an entity metadata array with each value at the index of its key for that entity type. */
function meta(name: string, values: Record<string, unknown>): unknown[] {
  const keys = registry.entitiesByName[name]?.metadataKeys as string[] | undefined;
  if (!keys) throw new Error(`no metadata keys for ${name}`);
  const result: unknown[] = [];
  for (const [key, value] of Object.entries(values)) {
    const index = keys.indexOf(key);
    if (index < 0) throw new Error(`${name} has no metadata key ${key}`);
    result[index] = value;
  }
  return result;
}

/** The bot stands at (0.5, 64, 0.5); dx and dz are offsets from there, so dx is also the distance on the x axis. */
function mob(name: string, dx: number, dz = 0, metadata: unknown[] = []): FakeEntity {
  return {
    id: nextId++,
    name,
    type: HOSTILE_NAMES.has(name) ? 'hostile' : 'animal',
    position: new Vec3(0.5 + dx, 64, 0.5 + dz),
    isValid: true,
    height: 1.95,
    width: 0.6,
    metadata
  };
}

function player(username: string, dx: number): FakeEntity {
  return { ...mob('player', dx), type: 'player', username, height: 1.8 };
}

function ignitedCreeper(dx: number, dz = 0): FakeEntity {
  return mob('creeper', dx, dz, meta('creeper', { swell_dir: -1, is_ignited: true }));
}

function tamedWolf(dx: number): FakeEntity {
  return mob('wolf', dx, 0, meta('wolf', { owneruuid: '0b1c2d3e-0000-4000-8000-000000000001' }));
}

function neutral(name: string, dx: number, dz = 0): FakeEntity {
  return { ...mob(name, dx, dz), type: registry.entitiesByName[name]?.type ?? 'mob' };
}

function item(name: string, slot = 36): FakeItem {
  return { name, count: 1, type: registry.itemsByName[name].id, slot };
}

interface WorldOptions {
  /** Block names by "x,y,z". */
  blocks?: Record<string, string>;
  /** Computed terrain, e.g. a lava channel or a cliff; `undefined` falls back to stone below y 64 and air above. */
  terrain?: (x: number, y: number, z: number) => string | undefined;
  entities?: FakeEntity[];
  inventory?: FakeItem[];
  health?: number;
  food?: number;
}

function createWorld(options: WorldOptions = {}) {
  // Its own sandbox: the default one keeps every fake of the file and warns about a leak past its threshold.
  const fakes = sinon.createSandbox();
  const blocks = new Map(Object.entries(options.blocks ?? {}));
  const blockName = (x: number, y: number, z: number): string =>
    blocks.get(`${x},${y},${z}`) ?? options.terrain?.(x, y, z) ?? (y < 64 ? 'stone' : 'air');
  const blockAt = (pos: Vec3) => {
    const p = pos.floored();
    const name = blockName(p.x, p.y, p.z);
    return { name, position: p, boundingBox: EMPTY_BLOCKS.has(name) ? 'empty' : 'block' };
  };

  const self = {
    id: 1, name: 'player', type: 'player', username: 'Bot', position: new Vec3(0.5, 64, 0.5),
    isValid: true, height: 1.8, width: 0.6, yaw: 0, pitch: 0, metadata: [] as unknown[]
  };
  const entities: Record<number, unknown> = { 1: self };
  for (const entity of options.entities ?? []) entities[entity.id] = entity;

  const controls: Record<string, boolean> = {};
  const inventory = options.inventory ?? [];
  const pathfinder = {
    goal: null as unknown,
    setGoal: fakes.spy((goal: unknown) => { pathfinder.goal = goal; }),
    stop: fakes.stub()
  };
  // Positions the bot walked through, for the "never into lava or off a cliff" checks.
  const visited: Vec3[] = [];

  const bot = Object.assign(new EventEmitter(), {
    registry,
    version: VERSION,
    entity: self,
    entities,
    players: {},
    health: options.health ?? 20,
    food: options.food ?? 20,
    foodSaturation: 5,
    oxygenLevel: 20,
    heldItem: null as FakeItem | null,
    inventory: { items: () => inventory, slots: [] as unknown[] },
    getEquipmentDestSlot: (destination: string) => ({ head: 5, torso: 6, legs: 7, feet: 8 } as Record<string, number>)[destination],
    pathfinder,
    setControlState: fakes.spy((control: string, state: boolean) => { controls[control] = state; }),
    clearControlStates: fakes.spy(() => {
      for (const key of Object.keys(controls)) controls[key] = false;
    }),
    look: fakes.spy(async (yaw: number, pitch: number) => {
      self.yaw = yaw;
      self.pitch = pitch;
    }),
    lookAt: fakes.stub().resolves(),
    equip: fakes.stub(),
    unequip: fakes.stub().resolves(),
    // Eating takes a moment in the game; here it finishes at once unless a test makes it wait.
    consume: fakes.stub(),
    deactivateItem: fakes.stub(),
    attack: fakes.spy(),
    blockAt
  });
  bot.equip.callsFake(async (stack: FakeItem) => { bot.heldItem = stack; });
  bot.consume.callsFake(async () => { bot.food = Math.min(20, bot.food + 5); });

  /** Makes consume() wait, like eating in the game, until deactivateItem() stops it. */
  const eatSlowly = () => {
    let stop: ((error: Error) => void) | null = null;
    bot.consume.callsFake(() => new Promise<void>((_resolve, reject) => { stop = reject; }));
    bot.deactivateItem.callsFake(() => stop?.(new Error('stopped eating')));
  };

  /** One physics step: walk or sprint along the current yaw while `forward` is held (mineflayer: yaw 0 faces -z). */
  const step = () => {
    if (!controls.forward) return;
    const speed = controls.sprint ? SPRINT_PER_TICK : WALK_PER_TICK;
    self.position = self.position.offset(-Math.sin(self.yaw) * speed, 0, -Math.cos(self.yaw) * speed);
    visited.push(self.position.clone());
  };

  return { bot, self, entities, controls, pathfinder, visited, blockName, step, eatSlowly };
}

type World = ReturnType<typeof createWorld>;

/** Cosine between where the bot looks and the direction to `target`: 1 is straight at it, -1 straight away. */
function facing(world: World, target: Vec3): number {
  const dx = target.x - world.self.position.x;
  const dz = target.z - world.self.position.z;
  const length = Math.hypot(dx, dz);
  return (-Math.sin(world.self.yaw) * dx - Math.cos(world.self.yaw) * dz) / length;
}

function distanceTo(world: World, entity: FakeEntity): number {
  return world.self.position.distanceTo(entity.position);
}

function kill(world: World, entity: FakeEntity): void {
  entity.isValid = false;
  delete world.entities[entity.id];
}

// ---- harness ---------------------------------------------------------------------------------------------------

function useClock(t: ExecutionContext) {
  const clock = sinon.useFakeTimers({ now: 1.7e12 });
  t.teardown(() => clock.restore());
  return clock;
}

function policyWith(t: ExecutionContext, update?: PolicyUpdate): Policy {
  const store = new PolicyStore();
  if (update) t.true(store.update(update, 'llm').ok, `policy update ${JSON.stringify(update)}`);
  return store.get();
}

/** Runs the game's physics like a real bot: one step every 50 ms while the test runs. */
function startPhysics(t: ExecutionContext, world: World): void {
  const loop = setInterval(() => world.step(), TICK);
  t.teardown(() => clearInterval(loop));
}

type Settled = { value?: string; error?: Error; done: boolean };

/**
 * Starts a macro the way the instinct engine does, with its own abort signal; the result is recorded instead of
 * thrown. The macro is cancelled when the test ends.
 */
function startMacro(
  t: ExecutionContext,
  world: World,
  name: MacroName,
  { entityId, policy, target = null }: { entityId?: number; policy?: Policy; target?: Vec3 | null } = {}
) {
  const controller = new AbortController();
  const settled: Settled = { done: false };
  const promise = MACROS[name].run({ bot: world.bot as never, signal: controller.signal, target, entityId, policy: policy ?? new PolicyStore().get() })
    .then(value => { settled.value = value; }, (error: Error) => { settled.error = error; })
    .finally(() => { settled.done = true; });
  t.teardown(() => controller.abort());
  return { controller, settled, promise };
}

const WEST = new Vec3(-1, 0, 0);
const NORTHWEST = new Vec3(-1, 0, -1);

/** The horizontal direction of the bot's first look() (mineflayer: yaw 0 faces -z). */
function firstLook(world: World): Vec3 | null {
  const call = world.bot.look.firstCall;
  if (!call) return null;
  const yaw = call.args[0];
  return new Vec3(-Math.sin(yaw), 0, -Math.cos(yaw));
}

function cosine(a: Vec3 | null, b: Vec3): number {
  if (!a) return NaN;
  return (a.x * b.x + a.z * b.z) / (Math.hypot(a.x, a.z) * Math.hypot(b.x, b.z));
}

/** The collision boxes of a block's default state, as prismarine-block reports them in `Block.shapes`. */
function defaultShapes(name: string): number[][] {
  const block = registry.blocksByName[name];
  if (!block) return [];
  const entry = registry.blockCollisionShapes.blocks[name];
  const id = Array.isArray(entry) ? entry[block.defaultState - block.minStateId] : entry;
  return (registry.blockCollisionShapes.shapes[id] ?? []) as number[][];
}

/**
 * Gives the fake world's blocks the bounding box and collision shapes they have in the game (a fence is 1.5 tall, a
 * cobweb has no collision box).
 */
function useRealBlocks(world: World): void {
  (world.bot as { blockAt: unknown }).blockAt = (pos: Vec3) => {
    const p = pos.floored();
    const name = world.blockName(p.x, p.y, p.z);
    const known = registry.blocksByName[name];
    return {
      name,
      position: p,
      boundingBox: known?.boundingBox ?? (EMPTY_BLOCKS.has(name) ? 'empty' : 'block'),
      shapes: defaultShapes(name),
      isWaterlogged: false
    };
  };
}

/** Two-high stone walls on every side of the bot's block: no direction to run in. */
const walledIn: WorldOptions['terrain'] = (x, y, z) => ((y === 64 || y === 65) && (x !== 0 || z !== 0) ? 'stone' : undefined);

// ---- F-042 runAway, through run_from_creeper -------------------------------------------------------------------

test.serial('run_from_creeper: an ignited creeper 4 blocks away → sprinting away from the first tick, 8+ blocks away before the fuse ends, and on to 16', async (t) => {
  const clock = useClock(t);
  const creeper = ignitedCreeper(4);
  const world = createWorld({ entities: [creeper] });
  startPhysics(t, world);
  const { settled } = startMacro(t, world, 'run_from_creeper', { entityId: creeper.id });

  t.true(world.controls.forward, 'moving forward at once');
  t.true(world.controls.sprint, 'sprinting at once');
  t.true(facing(world, creeper.position) <= -0.7, `looking away from the creeper (cos ${facing(world, creeper.position).toFixed(2)})`);

  await clock.tickAsync(CREEPER_FUSE_MS);
  t.true(distanceTo(world, creeper) >= 8, `8+ blocks away when the creeper explodes (${distanceTo(world, creeper).toFixed(2)})`);
  t.false(settled.done, 'keeps running: a creeper that does not explode follows the bot');
  await clock.tickAsync(2500);
  t.true(distanceTo(world, creeper) >= 16, `16+ blocks away, where it loses track (${distanceTo(world, creeper).toFixed(2)})`);
  t.true(settled.done, 'done once far enough');
  t.is(settled.error, undefined);
  t.regex(settled.value ?? '', new RegExp(`^moved \\d+\\.\\d blocks away from creeper \\(id ${creeper.id}\\)$`));
});

const DANGEROUS_GROUND: { label: string; terrain: WorldOptions['terrain']; forbidden: (position: Vec3) => boolean }[] = [
  {
    label: 'a lava channel',
    terrain: (x, y, z) => ((x === -1 || x === -2) && y === 64 && Math.abs(z) <= 12 ? 'lava' : undefined),
    forbidden: position => {
      const x = Math.floor(position.x);
      return (x === -1 || x === -2) && Math.abs(Math.floor(position.z)) <= 12;
    }
  },
  {
    label: 'a 10-block drop',
    terrain: (x, y) => (x <= -1 && y >= 54 && y <= 63 ? 'air' : undefined),
    forbidden: position => Math.floor(position.x) <= -1
  }
];

for (const { label, terrain, forbidden } of DANGEROUS_GROUND) {
  test.serial(`run_from_creeper does not flee into ${label} straight behind the bot`, async (t) => {
    const clock = useClock(t);
    const creeper = ignitedCreeper(4);
    const world = createWorld({ entities: [creeper], terrain });
    startPhysics(t, world);
    startMacro(t, world, 'run_from_creeper', { entityId: creeper.id });

    await clock.tickAsync(TICK + CREEPER_FUSE_MS);

    const bad = world.visited.find(forbidden);
    t.is(bad, undefined, bad ? `walked onto ${bad.floored()}` : 'stayed on safe ground');
    t.true(
      distanceTo(world, creeper) >= 8 || world.pathfinder.setGoal.getCalls().some(call => call.args[0] !== null),
      'it still gets away (or hands the way out to the pathfinder)'
    );
  });
}

for (const name of ['oak_fence', 'cobblestone_wall', 'oak_fence_gate']) {
  test.serial(`run_from_creeper: ${name} (1.5 blocks tall) straight behind the bot is not jumped onto; it runs past it at an angle`, async (t) => {
    const clock = useClock(t);
    const creeper = ignitedCreeper(4);
    const world = createWorld({ entities: [creeper], blocks: { '-1,64,0': name } });
    useRealBlocks(world);
    startPhysics(t, world);
    startMacro(t, world, 'run_from_creeper', { entityId: creeper.id });

    t.true(world.controls.forward && world.controls.sprint, 'running on the first tick');
    const look = firstLook(world);
    t.true(cosine(look, WEST) < 0.9, `not straight at the ${name} (cos ${cosine(look, WEST).toFixed(2)})`);
    t.true(cosine(look, WEST) > 0, 'still away from the creeper');

    await clock.tickAsync(CREEPER_FUSE_MS);
    const bad = world.visited.find(position => position.floored().x === -1 && position.floored().z === 0);
    t.is(bad, undefined, bad ? `walked into the ${name} at ${bad}` : 'never in the fence column');
    t.true(distanceTo(world, creeper) >= 8, `8+ blocks away when the creeper explodes (${distanceTo(world, creeper).toFixed(2)})`);
  });
}

test.serial('run_from_creeper: a one-block step straight behind is jumped, but not with a ceiling right above the bot\'s own head', async (t) => {
  useClock(t);
  const cases: { label: string; blocks: Record<string, string>; jumpable: boolean }[] = [
    { label: 'a stone step', blocks: { '-1,64,0': 'stone' }, jumpable: true },
    { label: 'a bottom slab', blocks: { '-1,64,0': 'oak_slab' }, jumpable: true },
    { label: 'a stone step with stone above the bot\'s head', blocks: { '-1,64,0': 'stone', '0,66,0': 'stone' }, jumpable: false }
  ];
  for (const { label, blocks, jumpable } of cases) {
    const creeper = ignitedCreeper(4);
    const world = createWorld({ entities: [creeper], blocks });
    useRealBlocks(world);
    const { controller } = startMacro(t, world, 'run_from_creeper', { entityId: creeper.id });
    const look = firstLook(world);
    if (jumpable) {
      t.true(cosine(look, WEST) > 0.99, `${label}: runs straight away over it (cos ${cosine(look, WEST).toFixed(2)})`);
      t.true(world.controls.forward && world.controls.jump, `${label}: jumps onto it`);
    } else {
      t.true(cosine(look, WEST) < 0.9, `${label}: no room to jump, so not straight at it (cos ${cosine(look, WEST).toFixed(2)})`);
      t.true(cosine(look, WEST) > 0, `${label}: still away from the creeper`);
    }
    controller.abort();
  }
});

for (const { key, label } of [
  { key: '-1,64,0', label: 'right behind the bot' },
  { key: '-2,65,0', label: 'two blocks behind at head height' }
]) {
  test.serial(`run_from_creeper: a cobweb ${label} is avoided even though it has no collision box`, async (t) => {
    const clock = useClock(t);
    const creeper = ignitedCreeper(4);
    const world = createWorld({ entities: [creeper], blocks: { [key]: 'cobweb' } });
    useRealBlocks(world);
    startPhysics(t, world);
    startMacro(t, world, 'run_from_creeper', { entityId: creeper.id });

    const look = firstLook(world);
    t.true(cosine(look, WEST) < 0.9, `not straight into the cobweb (cos ${cosine(look, WEST).toFixed(2)})`);
    t.true(cosine(look, WEST) >= -1e-9, 'not towards the creeper');

    await clock.tickAsync(CREEPER_FUSE_MS);
    const [x, , z] = key.split(',').map(Number);
    const bad = world.visited.find(position => position.floored().x === x && position.floored().z === z);
    t.is(bad, undefined, bad ? `walked into the cobweb at ${bad}` : 'never in the cobweb column');
    t.true(distanceTo(world, creeper) >= 8, `8+ blocks away (${distanceTo(world, creeper).toFixed(2)})`);
  });
}

test.serial('run_from_creeper: lava next to a diagonal escape route, or on its second block, rules that diagonal out', async (t) => {
  useClock(t);
  // The creeper is to the south-east, so straight away is the north-west diagonal.
  const cases: { label: string; lava?: string }[] = [
    { label: 'no lava (control)' },
    { label: 'lava beside the first diagonal step (west)', lava: '-1,64,0' },
    { label: 'lava beside the first diagonal step (north)', lava: '0,64,-1' },
    { label: 'lava on the second block of the diagonal', lava: '-2,64,-2' },
    { label: 'lava beside the second diagonal step', lava: '-2,64,-1' },
    { label: 'lava beside the second diagonal step (other side)', lava: '-1,64,-2' }
  ];
  for (const { label, lava } of cases) {
    const creeper = ignitedCreeper(3, 3);
    const world = createWorld({ entities: [creeper], blocks: lava ? { [lava]: 'lava' } : {} });
    useRealBlocks(world);
    const { controller } = startMacro(t, world, 'run_from_creeper', { entityId: creeper.id });
    const look = firstLook(world);
    t.truthy(look, `${label}: runs by itself (a safe direction exists)`);
    if (!lava) {
      t.true(cosine(look, NORTHWEST) > 0.99, `${label}: straight away along the diagonal (cos ${cosine(look, NORTHWEST).toFixed(2)})`);
    } else {
      t.true(cosine(look, NORTHWEST) < 0.9, `${label}: not along that diagonal (cos ${cosine(look, NORTHWEST).toFixed(2)})`);
      t.true(cosine(look, NORTHWEST) >= -1e-9, `${label}: still away from the creeper`);
    }
    controller.abort();
  }
});

const NO_WAY_OUT: { label: string; terrain: WorldOptions['terrain'] }[] = [
  { label: 'walled in', terrain: walledIn },
  // Standing on a one-block pillar: a 10-block drop on every side.
  { label: 'on a pillar', terrain: (x, y, z) => ((x !== 0 || z !== 0) && y >= 54 && y <= 63 ? 'air' : undefined) }
];

for (const { label, terrain } of NO_WAY_OUT) {
  test.serial(`run_from_creeper with no safe direction (${label}) hands over to the pathfinder once: one GoalXZ, no clearing of controls every tick`, async (t) => {
    const clock = useClock(t);
    const creeper = ignitedCreeper(4);
    const world = createWorld({ entities: [creeper], terrain });
    useRealBlocks(world);
    startPhysics(t, world);
    const { settled } = startMacro(t, world, 'run_from_creeper', { entityId: creeper.id });

    t.true(world.bot.look.notCalled, 'no direction of its own');
    const goal = world.pathfinder.goal;
    t.true(goal instanceof goals.GoalXZ, 'the pathfinder gets a GoalXZ');
    if (goal instanceof goals.GoalXZ) t.true(goal.x < 0, `the goal is away from the creeper (x ${goal.x})`);
    const goalsSet = world.pathfinder.setGoal.callCount;
    const clears = world.bot.clearControlStates.callCount;
    t.is(goalsSet, 1, 'one goal');

    // One second of ticks, and past the 1 s stuck check.
    for (const ms of [1000, 1000]) {
      await clock.tickAsync(ms);
      t.false(settled.done, 'still running away');
      t.is(world.pathfinder.setGoal.callCount, goalsSet, 'the goal is not set again');
      t.is(world.bot.clearControlStates.callCount, clears, 'the pathfinder\'s controls are not cleared every tick');
      t.is(world.pathfinder.goal, goal, 'the same goal stays in place');
    }
  });
}

test.serial('runAway replaces a leftover pathfinder goal with its flee goal, and sets it again only when the goal changed', async (t) => {
  const clock = useClock(t);
  const zombie = mob('zombie', 4);
  const world = createWorld({ entities: [zombie], terrain: walledIn });
  useRealBlocks(world);
  // A GoalFollow left behind by an interrupted fight.
  const leftover = new goals.GoalFollow(zombie as never, 1);
  world.pathfinder.goal = leftover;
  const controller = new AbortController();
  t.teardown(() => controller.abort());
  const running = runAway(world.bot as never, controller.signal, () => [zombie.position], () => false).catch((error: unknown) => error);

  t.true(world.pathfinder.goal instanceof goals.GoalXZ, 'the leftover GoalFollow is replaced right away');
  t.not(world.pathfinder.goal, leftover);
  const flee = world.pathfinder.goal;
  await clock.tickAsync(500);
  t.is(world.pathfinder.setGoal.callCount, 1, 'set once');
  t.is(world.pathfinder.goal, flee);

  // The pathfinder dropped the goal: the next tick sets a flee goal again, once.
  world.pathfinder.goal = null;
  await clock.tickAsync(TICK);
  t.true(world.pathfinder.goal instanceof goals.GoalXZ, 'a flee goal again');
  t.is(world.pathfinder.setGoal.callCount, 2);
  await clock.tickAsync(500);
  t.is(world.pathfinder.setGoal.callCount, 2, 'and not again while it stays in place');
  t.true(world.bot.clearControlStates.notCalled, 'runAway never clears the controls in pathfinder mode');

  controller.abort();
  await running;
});

test.serial('runAway on open ground clears a leftover pathfinder goal and sprints away itself', async (t) => {
  const clock = useClock(t);
  const zombie = mob('zombie', 4);
  const world = createWorld({ entities: [zombie] });
  useRealBlocks(world);
  world.pathfinder.goal = new goals.GoalFollow(zombie as never, 1);
  const controller = new AbortController();
  t.teardown(() => controller.abort());
  const running = runAway(world.bot as never, controller.signal, () => [zombie.position], () => false).catch((error: unknown) => error);

  t.is(world.pathfinder.goal, null, 'the leftover goal is cleared');
  t.true(world.controls.forward && world.controls.sprint, 'sprinting with its own controls');
  t.true(cosine(firstLook(world), WEST) > 0.99, 'straight away from the zombie');
  await clock.tickAsync(200);
  t.true(world.pathfinder.setGoal.getCalls().every(call => call.args[0] === null), 'no pathfinder goal of its own');

  controller.abort();
  await running;
});

// New in M9, from the F-042 text: "卡住 1 秒时，改由寻路器接手 2 秒".
test.serial('runAway: stuck for 1 s on a way that looks safe → the pathfinder takes over for 2 s, then the bot steers itself again', async (t) => {
  const clock = useClock(t);
  const zombie = mob('zombie', 4);
  const world = createWorld({ entities: [zombie] });
  // No physics loop: the controls are held but the bot does not move (e.g. pushed against something unseen).
  const controller = new AbortController();
  t.teardown(() => controller.abort());
  const running = runAway(world.bot as never, controller.signal, () => [zombie.position], () => false).catch((error: unknown) => error);

  await clock.tickAsync(900);
  t.false(world.pathfinder.goal instanceof goals.GoalXZ, 'not before a second has passed');
  t.true(world.controls.forward && world.controls.sprint);

  await clock.tickAsync(200);
  const goal = world.pathfinder.goal;
  t.true(goal instanceof goals.GoalXZ, 'stuck for a second: the pathfinder gets a flee goal');
  if (goal instanceof goals.GoalXZ) t.true(goal.x < 0, `away from the zombie (x ${goal.x})`);

  // The pathfinder makes progress (it moves the bot about a block a second); the 2 s hand-over then runs out.
  world.self.position = world.self.position.offset(-1, 0, 0);
  await clock.tickAsync(1000);
  world.self.position = world.self.position.offset(-1, 0, 0);
  await clock.tickAsync(700);
  t.is(world.pathfinder.goal, goal, 'still the pathfinder\'s turn before 2 s are over');
  const looks = world.bot.look.callCount;
  await clock.tickAsync(300);
  t.is(world.pathfinder.goal, null, 'after 2 s the flee goal is cleared');
  t.true(world.bot.look.callCount > looks, 'and the bot steers by itself again');
  t.true(world.controls.forward && world.controls.sprint);

  controller.abort();
  await running;
});

// From the runAway contract: controls are set again every tick, because a preempted manual command may still clear
// them when its own timer fires.
test.serial('runAway sets its controls again on every tick, so a stray clearControlStates does not stop the run', async (t) => {
  const clock = useClock(t);
  const zombie = mob('zombie', 4);
  const world = createWorld({ entities: [zombie] });
  startPhysics(t, world);
  const controller = new AbortController();
  t.teardown(() => controller.abort());
  const running = runAway(world.bot as never, controller.signal, () => [zombie.position], () => false).catch((error: unknown) => error);

  await clock.tickAsync(200);
  world.bot.clearControlStates();
  t.false(world.controls.forward);
  await clock.tickAsync(TICK);
  t.true(world.controls.forward && world.controls.sprint, 'forward and sprint are held again on the next tick');

  controller.abort();
  await running;
});

// ---- F-042 eating --------------------------------------------------------------------------------------------------

test('bestFood: the best safe food; none of the ten harmful or valuable foods, even when they are better', (t) => {
  const all = createWorld({ inventory: [...AVOID_FOODS.map((name, i) => item(name, 9 + i)), item('bread', 30)] });
  t.is(bestFood(all.bot as never)?.name, 'bread', 'golden_carrot and the golden apples are worth more, but are never eaten');

  for (const name of AVOID_FOODS) {
    t.is(bestFood(createWorld({ inventory: [item(name)] }).bot as never), null, `${name} alone is not food for the bot`);
  }
  t.is(bestFood(createWorld({ inventory: [item('bread', 9), item('cooked_beef', 10), item('apple', 11)] }).bot as never)?.name, 'cooked_beef', 'the most filling first');
  t.is(bestFood(createWorld({ inventory: [item('stone')] }).bot as never), null, 'nothing edible');
});

test.serial('eat: food 10 with bread → equips the bread, eats it, and puts the previously held sword back in hand', async (t) => {
  const clock = useClock(t);
  const bread = item('bread', 36);
  const sword = item('iron_sword', 37);
  const world = createWorld({ food: 10, inventory: [bread, sword] });
  world.bot.heldItem = sword;

  const eating = eat(world.bot as never, new AbortController().signal);
  await clock.tickAsync(1000);
  const result = await eating;

  t.is(world.bot.equip.firstCall?.args[0], bread, 'the bread goes in hand');
  t.true(world.bot.consume.calledOnce, 'eats it');
  t.true(world.bot.food > 10);
  t.is(world.bot.equip.lastCall?.args[0], sword, 'the sword goes back in hand');
  t.is(world.bot.heldItem, sword);
  t.is(result, 'ate bread (food 10 → 15)');
});

test.serial('eat (E-016): waits until the food is really in hand before eating', async (t) => {
  const clock = useClock(t);
  const bread = item('bread', 36);
  const world = createWorld({ food: 10, inventory: [bread] });
  // The slot update that confirms the equip arrives 3 ticks later.
  world.bot.equip.callsFake(async (stack: FakeItem) => { setTimeout(() => { world.bot.heldItem = stack; }, TICK * 3); });
  world.bot.consume.callsFake(async () => { if (world.bot.heldItem?.name === 'bread') world.bot.food = 15; });
  const eating = eat(world.bot as never, new AbortController().signal);
  await clock.tickAsync(TICK * 2);
  t.true(world.bot.consume.notCalled, 'not before the bread is in hand');
  await clock.tickAsync(1000);
  t.is(await eating, 'ate bread (food 10 → 15)');
  t.true(world.bot.consume.calledOnce);
});

test.serial('eat (E-016): a consume that ends without eating is tried once more, then reported as not eaten', async (t) => {
  const clock = useClock(t);
  const world = createWorld({ food: 17, inventory: [item('cooked_beef')] });
  world.bot.consume.callsFake(async () => {});
  const eating = eat(world.bot as never, new AbortController().signal);
  const failed = t.throwsAsync(eating, { message: 'did not eat cooked_beef: eating was interrupted' });
  await clock.tickAsync(2000);
  await failed;
  t.is(world.bot.consume.callCount, 2, 'one more try');

  const second = createWorld({ food: 17, inventory: [item('cooked_beef')] });
  let calls = 0;
  second.bot.consume.callsFake(async () => { if (++calls === 2) second.bot.food = 20; });
  const again = eat(second.bot as never, new AbortController().signal);
  await clock.tickAsync(2000);
  t.is(await again, 'ate cooked_beef (food 17 → 20)', 'the second try counts');
});

test.serial('eat: nothing to do with a full food bar or only harmful food', async (t) => {
  useClock(t);
  t.is(await eat(createWorld({ food: 20, inventory: [item('bread')] }).bot as never, new AbortController().signal), null);
  const flesh = createWorld({ food: 10, inventory: [item('rotten_flesh')] });
  t.is(await eat(flesh.bot as never, new AbortController().signal), null);
  t.true(flesh.bot.consume.notCalled);
});

test.serial('eat: cancelled while eating → stops eating at once (deactivateItem)', async (t) => {
  const clock = useClock(t);
  const world = createWorld({ food: 10, inventory: [item('bread')] });
  world.eatSlowly();
  const controller = new AbortController();
  const eating = eat(world.bot as never, controller.signal);
  const failed = t.throwsAsync(eating);
  await clock.tickAsync(200);
  t.true(world.bot.consume.calledOnce, 'eating');

  controller.abort(new Error('interrupted by manual command move-to-position'));

  t.true(world.bot.deactivateItem.called, 'eating is stopped');
  await failed;
});

// ---- F-042 holdGround, through the hold macro ------------------------------------------------------------------

test.serial('hold: does not chase a zombie 6 blocks away, does not run, and hits it once within reach', async (t) => {
  const clock = useClock(t);
  const zombie = mob('zombie', 6);
  const world = createWorld({ entities: [zombie] });
  startPhysics(t, world);
  const { settled } = startMacro(t, world, 'hold', { entityId: zombie.id });
  const position = world.self.position.clone();

  await clock.tickAsync(1000);
  t.false(world.pathfinder.setGoal.getCalls().some(call => call.args[0] !== null), 'no chase goal');
  t.is(world.pathfinder.goal, null);
  t.false(world.bot.setControlState.getCalls().some(call => call.args[1] === true), 'no running or walking');
  t.true(world.self.position.equals(position), 'stands still');
  t.true(world.bot.attack.notCalled, 'out of reach: no attack');
  t.false(settled.done, 'still holding its ground');

  zombie.position = new Vec3(2.5, 64, 0.5);
  await clock.tickAsync(500);
  t.true(world.bot.attack.calledWith(sinon.match({ id: zombie.id })), 'hits it within reach');
  t.false(world.pathfinder.setGoal.getCalls().some(call => call.args[0] !== null), 'still no chase goal');
  t.true(world.self.position.equals(position), 'still in place');

  kill(world, zombie);
  await clock.tickAsync(200);
  t.true(settled.done);
  t.regex(settled.value ?? '', /^held ground/);
});

test.serial('holdGround ends when the target is gone or more than 16 blocks away', async (t) => {
  const clock = useClock(t);
  const far = mob('zombie', 10);
  const world = createWorld({ entities: [far] });
  const policy = policyWith(t);
  const leaving = holdGround(world.bot as never, far as never, new AbortController().signal, policy);
  await clock.tickAsync(200);
  far.position = new Vec3(17.5, 64, 0.5);
  await clock.tickAsync(TICK * 2);
  t.is(await leaving, `held ground; zombie (id ${far.id}) left`);

  const gone = mob('zombie', 10);
  world.entities[gone.id] = gone;
  const vanishing = holdGround(world.bot as never, gone as never, new AbortController().signal, policy);
  await clock.tickAsync(200);
  kill(world, gone);
  await clock.tickAsync(TICK * 2);
  t.is(await vanishing, `held ground; zombie (id ${gone.id}) is gone`);
  t.true(world.bot.attack.notCalled, 'neither came within reach');
});

// ---- F-039 macros (M9) ---------------------------------------------------------------------------------------------

test.serial('run_from_creeper: a creeper that disappears during the run ends it with "the creeper is gone"; one gone from the start fails', async (t) => {
  const clock = useClock(t);
  const creeper = ignitedCreeper(4);
  const world = createWorld({ entities: [creeper] });
  startPhysics(t, world);
  const { settled } = startMacro(t, world, 'run_from_creeper', { entityId: creeper.id });
  await clock.tickAsync(200);
  kill(world, creeper);
  await clock.tickAsync(TICK * 2);
  t.true(settled.done);
  t.is(settled.value, 'the creeper is gone');

  const missing = startMacro(t, createWorld(), 'run_from_creeper', { entityId: 999 });
  await clock.tickAsync(0);
  t.is(missing.settled.error?.message, 'the target is gone');
});

test.serial('flee: hit by a zombie → runs away without attacking until no hostile is within 16 blocks', async (t) => {
  const clock = useClock(t);
  const zombie = mob('zombie', 2);
  const world = createWorld({ entities: [zombie] });
  startPhysics(t, world);
  const { settled } = startMacro(t, world, 'flee', { entityId: zombie.id });

  await clock.tickAsync(500);
  t.true(world.bot.attack.notCalled, 'never attacks');
  t.true(world.controls.forward, 'moving');
  t.true(facing(world, zombie.position) <= -0.7, 'away from the zombie');
  t.true(distanceTo(world, zombie) > 3, `got further away (${distanceTo(world, zombie).toFixed(1)})`);
  t.false(settled.done, 'still within 16 blocks');

  await clock.tickAsync(3000);
  t.true(settled.done, 'ends by itself');
  t.true(distanceTo(world, zombie) > 16, `more than 16 blocks away (${distanceTo(world, zombie).toFixed(1)})`);
  t.is(settled.value, 'got more than 16 blocks away from 1 mob(s)');
  t.true(world.bot.attack.notCalled);
});

for (const { label, attacker } of [
  { label: 'a player', attacker: () => player('Steve', 2) },
  { label: 'an iron golem (neutral)', attacker: () => neutral('iron_golem', 2) }
]) {
  test.serial(`flee: hit by ${label}, which is not a hostile → still runs from the attacker until it is beyond 16 blocks, never attacking`, async (t) => {
    const clock = useClock(t);
    const entity = attacker();
    const world = createWorld({ entities: [entity] });
    startPhysics(t, world);
    const { settled } = startMacro(t, world, 'flee', { entityId: entity.id });

    await clock.tickAsync(500);
    t.true(world.controls.forward, 'moving');
    t.true(facing(world, entity.position) <= -0.7, 'away from the attacker');
    t.true(distanceTo(world, entity) > 3, `got further away (${distanceTo(world, entity).toFixed(1)})`);

    await clock.tickAsync(3500);
    t.true(settled.done);
    t.true(distanceTo(world, entity) > 16, `more than 16 blocks away (${distanceTo(world, entity).toFixed(1)})`);
    t.true(world.bot.attack.notCalled, 'never attacked (I1)');
  });
}

// G1, G4: once the body is taken away (the macro's signal is aborted), it must not touch it any more.
test.serial('flee cancelled midway (a manual command took the body): it stops driving the body and leaves the new goal alone', async (t) => {
  const clock = useClock(t);
  const zombie = mob('zombie', 2);
  const world = createWorld({ entities: [zombie] });
  startPhysics(t, world);
  const { controller, settled } = startMacro(t, world, 'flee', { entityId: zombie.id });
  await clock.tickAsync(TICK + 200);
  t.true(world.controls.forward);

  controller.abort(new Error('interrupted by manual command move-to-position'));
  const manualGoal = { manual: true };
  world.pathfinder.goal = manualGoal;
  const counts = {
    controls: world.bot.setControlState.callCount,
    clears: world.bot.clearControlStates.callCount,
    looks: world.bot.look.callCount,
    goals: world.pathfinder.setGoal.callCount
  };

  await clock.tickAsync(500);

  t.true(settled.done);
  t.truthy(settled.error, 'the macro ends as cancelled, not as done');
  t.is(world.bot.setControlState.callCount, counts.controls, 'no control changes after losing the body');
  t.is(world.bot.clearControlStates.callCount, counts.clears, 'the manual command\'s controls are not cleared');
  t.is(world.bot.look.callCount, counts.looks, 'no more looking around');
  t.is(world.pathfinder.setGoal.callCount, counts.goals, 'the pathfinder is left alone');
  t.is(world.pathfinder.goal, manualGoal);
});

test.serial('fight: hit by a zombie → attacks it even at health 8, and ends when it dies', async (t) => {
  const clock = useClock(t);
  const zombie = mob('zombie', 2);
  const world = createWorld({ health: 8, entities: [zombie] });
  const { settled } = startMacro(t, world, 'fight', { entityId: zombie.id });

  await clock.tickAsync(300);
  t.true(world.bot.attack.calledWith(sinon.match({ id: zombie.id })), 'fights back');

  kill(world, zombie);
  await clock.tickAsync(200);
  t.true(settled.done);
  t.regex(settled.value ?? '', new RegExp(`^fought zombie \\(id ${zombie.id}\\) with bare hand: `));
});

// I1: the macro's own rules say attackPlayers false, whatever the policy says; avoidNeutral follows the policy.
const NEVER_FOUGHT: { label: string; target: () => FakeEntity; update: PolicyUpdate }[] = [
  { label: 'a player, even with combat.attackPlayers on', target: () => player('Steve', 2), update: { combat: { attackPlayers: true } } },
  { label: 'a tamed wolf, even with avoidNeutral off', target: () => tamedWolf(2), update: { combat: { avoidNeutral: false } } },
  { label: 'an iron golem with avoidNeutral on (the default)', target: () => neutral('iron_golem', 2), update: { combat: { retreatHealth: 6 } } }
];

for (const { label, target, update } of NEVER_FOUGHT) {
  test.serial(`fight against ${label} fails without a single attack (I1)`, async (t) => {
    const clock = useClock(t);
    const entity = target();
    const world = createWorld({ entities: [entity] });
    const { settled } = startMacro(t, world, 'fight', { entityId: entity.id, policy: policyWith(t, update) });
    await clock.tickAsync(1000);

    t.true(settled.done);
    t.truthy(settled.error, 'the macro reports that it cannot do its job');
    t.true(world.bot.attack.notCalled, 'never attacked');
  });
}

for (const { label, target, update } of NEVER_FOUGHT) {
  test.serial(`hold against ${label} never attacks it, even within reach (I1)`, async (t) => {
    const clock = useClock(t);
    const entity = target();
    const world = createWorld({ entities: [entity] });
    startMacro(t, world, 'hold', { entityId: entity.id, policy: policyWith(t, update) });
    await clock.tickAsync(1000);
    t.true(world.bot.attack.notCalled, 'never attacked');
  });
}

test.serial('fight against an iron golem with avoidNeutral off → attacks it', async (t) => {
  const clock = useClock(t);
  const golem = neutral('iron_golem', 2);
  const world = createWorld({ entities: [golem] });
  startMacro(t, world, 'fight', { entityId: golem.id, policy: policyWith(t, { combat: { avoidNeutral: false } }) });
  await clock.tickAsync(300);
  t.true(world.bot.attack.calledWith(sinon.match({ id: golem.id })), 'fights back');
});

test.serial('fight or hold with a target that is gone fails with "the target is gone"', async (t) => {
  const clock = useClock(t);
  for (const name of ['fight', 'hold'] as const) {
    const zombie = mob('zombie', 2);
    const world = createWorld({ entities: [zombie] });
    kill(world, zombie);
    const { settled } = startMacro(t, world, name, { entityId: zombie.id });
    await clock.tickAsync(0);
    t.is(settled.error?.message, 'the target is gone', name);
    t.true(world.bot.attack.notCalled);
  }
});

test.serial('the eat macro stops moving and eats the best safe food; with nothing safe to eat it fails', async (t) => {
  const clock = useClock(t);
  const world = createWorld({ food: 10, inventory: [item('golden_apple', 9), item('bread', 10)] });
  world.pathfinder.goal = { leftover: true };
  world.controls.forward = true;
  const { settled } = startMacro(t, world, 'eat');
  await clock.tickAsync(0);
  t.is(world.pathfinder.goal, null, 'the pathfinder goal is cleared first');
  t.false(world.controls.forward, 'the controls are released first');
  await clock.tickAsync(1000);
  t.is(settled.value, 'ate bread (food 10 → 15)');

  const nothing = startMacro(t, createWorld({ food: 10, inventory: [item('rotten_flesh')] }), 'eat');
  await clock.tickAsync(0);
  t.regex(nothing.settled.error?.message ?? '', /nothing safe to eat/);
});

// ---- F-037 cues that replaced the reflex triggers (M9) -------------------------------------------------------------

function cueKinds(t: ExecutionContext, options: WorldOptions, update?: PolicyUpdate): string[] {
  return readCues(createWorld(options).bot as never, policyWith(t, update)).map(cue => cue.kind);
}

test('low_health: below instinct.lowHealth or at combat.retreatHealth, only with a hostile within instinct.hostileRadius', (t) => {
  const has = (kinds: string[]) => kinds.includes('low_health');
  const zombie = () => [mob('zombie', 10)];

  t.true(has(cueKinds(t, { health: 5, entities: zombie() })), 'health 5 < 6 with a zombie at 10 ≤ 16');
  t.false(has(cueKinds(t, { health: 5, entities: [mob('zombie', 20)] })), 'the zombie is beyond 16 blocks');
  t.true(has(cueKinds(t, { health: 6, entities: zombie() })), 'health 6 is the combat retreat point');
  t.false(has(cueKinds(t, { health: 7, entities: zombie() })), 'health 7 is above both thresholds');
  t.false(has(cueKinds(t, { health: 5 })), 'no hostile around');
  t.false(has(cueKinds(t, { health: 5, entities: zombie() }, { instinct: { hostileRadius: 8 } })), 'policy hostileRadius 8');
  t.true(has(cueKinds(t, { health: 7, entities: zombie() }, { instinct: { lowHealth: 8 } })), 'policy lowHealth 8');

  const apart: PolicyUpdate = { instinct: { lowHealth: 4 }, combat: { retreatHealth: 8 } };
  t.true(has(cueKinds(t, { health: 8, entities: zombie() }, apart)), 'health 8 = combat.retreatHealth 8');
  t.true(has(cueKinds(t, { health: 7, entities: zombie() }, apart)), 'health 7 < combat.retreatHealth 8');
  t.false(has(cueKinds(t, { health: 9, entities: zombie() }, apart)), 'health 9 is above both thresholds');
  t.false(has(cueKinds(t, { health: 8 }, apart)), 'still needs a hostile nearby');
  const lowOwn: PolicyUpdate = { instinct: { lowHealth: 4 } };
  t.true(has(cueKinds(t, { health: 6, entities: zombie() }, lowOwn)), 'health 6 = the default combat.retreatHealth');
  t.false(has(cueKinds(t, { health: 7, entities: zombie() }, lowOwn)), 'health 7 is above the default combat.retreatHealth 6');
});

test('hungry: food below instinct.food with something safe to eat', (t) => {
  const has = (kinds: string[]) => kinds.includes('hungry');
  t.true(has(cueKinds(t, { food: 13, inventory: [item('bread')] })), 'food 13 < 14 with bread');
  t.false(has(cueKinds(t, { food: 14, inventory: [item('bread')] })), 'food 14 is not below the default 14');
  t.false(has(cueKinds(t, { food: 10, inventory: [item('rotten_flesh')] })), 'only harmful food');
  t.false(has(cueKinds(t, { food: 10 })), 'nothing to eat');
  t.true(has(cueKinds(t, { food: 15, inventory: [item('bread')] }, { instinct: { food: 16 } })), 'policy food 16');
  // F-037 names no hostile condition: whether to eat with a zombie near is the decision model's call now.
  t.true(has(cueKinds(t, { food: 10, inventory: [item('bread')], entities: [mob('zombie', 5)] })), 'a zombie nearby does not hide it');
});

test.serial('attacked: no cue for a hit from the mob the bot is already fighting; once that fight is over it is a cue again', async (t) => {
  const clock = useClock(t);
  const wolf = neutral('wolf', 2);
  const world = createWorld({ entities: [wolf] });
  const policy = policyWith(t);
  const controller = new AbortController();
  const fight = engage(world.bot as never, wolf as never, { signal: controller.signal, rules: { allowTypes: ['wolf'] } });

  await clock.tickAsync(TICK);
  const hit = { attackerId: wolf.id, type: 'mob_attack', time: Date.now() };
  t.false(readCues(world.bot as never, policy, hit).some(cue => cue.kind === 'attacked'), 'part of the fight already going on');

  controller.abort();
  await clock.tickAsync(TICK);
  await fight;
  const again = { attackerId: wolf.id, type: 'mob_attack', time: Date.now() };
  t.true(readCues(world.bot as never, policy, again).some(cue => cue.kind === 'attacked' && cue.entityId === wolf.id), 'a cue again');
});

// ---- F-038 menu safety filter (I1; these were self-defense reflex tests) -------------------------------------------

const optionIds = (t: ExecutionContext, world: World, attacker: FakeEntity, update?: PolicyUpdate, type = 'mob_attack') => {
  const policy = policyWith(t, update);
  const cues = readCues(world.bot as never, policy, { attackerId: attacker.id, type, time: Date.now() });
  return buildMenu(world.bot as never, cues, { hasTask: false, policy });
};

const NO_FIGHT: { label: string; attacker: () => FakeEntity; update?: PolicyUpdate; type?: string }[] = [
  { label: 'a player', attacker: () => player('Steve', 2), type: 'player_attack' },
  { label: 'a player, with combat.attackPlayers on', attacker: () => player('Steve', 2), update: { combat: { attackPlayers: true } }, type: 'player_attack' },
  { label: 'a tamed wolf', attacker: () => tamedWolf(2) },
  { label: 'a tamed wolf, with avoidNeutral off', attacker: () => tamedWolf(2), update: { combat: { avoidNeutral: false } } },
  { label: 'an iron golem with avoidNeutral on (the default)', attacker: () => neutral('iron_golem', 2) }
];

for (const { label, attacker, update, type } of NO_FIGHT) {
  test(`menu: attacked by ${label} → flee is offered, fight and hold are not (I1)`, (t) => {
    const entity = attacker();
    const world = createWorld({ entities: [entity] });
    const menu = optionIds(t, world, entity, update, type);
    const ids = menu.map(option => option.id);
    t.true(ids.includes('flee'), `flee is offered: ${ids.join(', ')}`);
    t.is(menu.find(option => option.id === 'flee')?.entityId, entity.id, 'flee runs from the attacker');
    t.false(ids.includes('fight'), 'no fight');
    t.false(ids.includes('hold'), 'no hold');
  });
}

for (const name of ['arrow', 'trident']) {
  test(`menu: a hit attributed to the ${name} entity offers no fight and no hold`, (t) => {
    const projectile: FakeEntity = { ...mob(name, 3), type: 'projectile', height: 0.5, width: 0.5 };
    const world = createWorld({ entities: [projectile] });
    const ids = optionIds(t, world, projectile, undefined, name).map(option => option.id);
    t.false(ids.includes('fight'));
    t.false(ids.includes('hold'));
  });
}

test('menu: an iron golem with avoidNeutral off, or a zombie, may be fought or held against', (t) => {
  const golem = neutral('iron_golem', 2);
  const golemMenu = optionIds(t, createWorld({ entities: [golem] }), golem, { combat: { avoidNeutral: false } });
  t.deepEqual(golemMenu.filter(option => option.id === 'fight' || option.id === 'hold').map(option => [option.id, option.entityId]), [['fight', golem.id], ['hold', golem.id]]);

  const zombie = mob('zombie', 2);
  const zombieMenu = optionIds(t, createWorld({ entities: [zombie] }), zombie);
  t.deepEqual(zombieMenu.slice(0, 3).map(option => [option.id, option.entityId]), [['flee', zombie.id], ['fight', zombie.id], ['hold', zombie.id]]);
});

test('menu: at or below combat.retreatHealth there is no fight or hold, only flee', (t) => {
  for (const { health, update } of [
    { health: 6, update: undefined },
    { health: 8, update: { combat: { retreatHealth: 8 } } as PolicyUpdate },
    { health: 3, update: undefined }
  ]) {
    const zombie = mob('zombie', 2);
    const world = createWorld({ health, entities: [zombie] });
    const ids = optionIds(t, world, zombie, update).map(option => option.id);
    t.true(ids.includes('flee'), `health ${health}: flee`);
    t.false(ids.includes('fight') || ids.includes('hold'), `health ${health}: no fight or hold (${ids.join(', ')})`);
  }
  const zombie = mob('zombie', 2);
  const ids = optionIds(t, createWorld({ health: 7, entities: [zombie] }), zombie).map(option => option.id);
  t.true(ids.includes('fight') && ids.includes('hold'), 'health 7 is above retreatHealth 6');
});
