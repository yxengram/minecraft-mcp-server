// Contract: docs/BLUEPRINT.md E-016 (M14). Digging in, being walled in, the recent instinct actions with mobs that came
// back, and eating that really happened (the eat tests are in tests/motor.test.ts). Expected values come from E-016.
import test, { ExecutionContext } from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { ActionArbiter } from '../src/autopilot/action-arbiter.js';
import { PolicyStore } from '../src/autopilot/policy.js';
import { TaskManager } from '../src/autopilot/task-manager.js';
import { EventStore } from '../src/event-store.js';
import { DIG_IN_MAX_MS, digInPlan, enclosedNow } from '../src/autopilot/hazards.js';
import { readCues } from '../src/autopilot/instinct/attention.js';
import { buildMenu } from '../src/autopilot/instinct/affordances.js';
import { MACROS } from '../src/autopilot/instinct/macros.js';
import { InstinctEngine } from '../src/autopilot/instinct/instinct-engine.js';
import type { DecisionResult } from '../src/decisions/openrouter-client.js';

const EMPTY = new Set(['air', 'cave_air', 'water', 'lava', 'short_grass', 'torch']);
const UNDIGGABLE = new Set(['bedrock', 'air', 'water', 'lava']);
// Dig times by hand, roughly as in the game.
const DIG_MS: Record<string, number> = { dirt: 750, grass_block: 900, stone: 7500, oak_planks: 3000, gravel: 900 };

interface WorldOptions {
  /** Block at x, y, z when not set: grass on top (y 63), dirt below down to y 58, stone further down, air above. */
  terrain?: (x: number, y: number, z: number) => string | undefined;
  inventory?: string[];
  health?: number;
  onGround?: boolean;
}

function ground(x: number, y: number): string {
  if (y >= 64) return 'air';
  if (y === 63) return 'grass_block';
  return y >= 58 ? 'dirt' : 'stone';
}

function createWorld(options: WorldOptions = {}) {
  const blocks = new Map<string, string>();
  const name = (x: number, y: number, z: number) => blocks.get(`${x},${y},${z}`) ?? options.terrain?.(x, y, z) ?? ground(x, y);
  const blockAt = (pos: Vec3) => {
    const p = pos.floored();
    const block = name(p.x, p.y, p.z);
    return { name: block, position: p, boundingBox: EMPTY.has(block) ? 'empty' : 'block', diggable: !UNDIGGABLE.has(block), digTime: (tool: number | null) => (tool !== null && block === 'stone' ? 400 : DIG_MS[block] ?? 1000) };
  };
  const self = { id: 1, position: new Vec3(0.5, 64, 0.5), yaw: 0, pitch: 0, onGround: options.onGround ?? true, metadata: [0, 300] as unknown[] };
  const inventory = (options.inventory ?? []).map((item, i) => ({ name: item, count: 8, type: 900 + i, slot: 36 + i }));
  const bot = Object.assign(new EventEmitter(), {
    entity: self,
    entities: { 1: self } as Record<number, unknown>,
    version: '1.21.8',
    registry: minecraftData('1.21.8'),
    health: options.health ?? 20,
    food: 20,
    heldItem: null as { name: string } | null,
    inventory: { items: () => inventory.filter(item => item.count > 0) },
    pathfinder: { goal: null as unknown, setGoal: sinon.stub(), stop: sinon.stub(), bestHarvestTool: sinon.stub().returns(null) },
    blockAt,
    setControlState: sinon.stub(),
    clearControlStates: sinon.stub(),
    look: sinon.stub().resolves(),
    equip: sinon.stub().callsFake(async (item: { name: string }) => { bot.heldItem = item; }),
    // Digging the block under the feet drops the bot into the hole.
    dig: sinon.stub().callsFake(async (block: { position: Vec3 }) => {
      blocks.set(`${block.position.x},${block.position.y},${block.position.z}`, 'air');
      if (block.position.y === Math.floor(self.position.y) - 1) self.position = self.position.offset(0, -1, 0);
    }),
    stopDigging: sinon.stub(),
    placeBlock: sinon.stub().callsFake(async (reference: { position: Vec3 }, face: Vec3) => {
      const at = reference.position.plus(face);
      blocks.set(`${at.x},${at.y},${at.z}`, bot.heldItem?.name ?? 'stone');
      const held = inventory.find(item => item.name === bot.heldItem?.name);
      if (held) held.count--;
    })
  });
  const set = (x: number, y: number, z: number, block: string) => blocks.set(`${x},${y},${z}`, block);
  const addMob = (mobName: string, x: number, z: number) => {
    const id = 100 + Object.keys(bot.entities).length;
    const mob = { id, name: mobName, type: 'hostile', position: new Vec3(x + 0.5, 64, z + 0.5), isValid: true, height: 1.8, metadata: [] };
    bot.entities[id] = mob;
    return mob;
  };
  return { bot, self, set, addMob, blocks, inventory };
}

const policy = () => new PolicyStore().get();
const asBot = (world: ReturnType<typeof createWorld>) => world.bot as never;

// ---- digInPlan ----------------------------------------------------------------------------------------------------

test('digInPlan: on grass over dirt the bot can dig 3 down and close the hole with the dirt it digs up', (t) => {
  const plan = digInPlan(asBot(createWorld()));
  t.truthy(plan);
  t.deepEqual(plan!.cells.map(cell => cell.y), [63, 62, 61]);
  t.deepEqual(plan!.cap.toArray(), [0, 63, 0]);
  t.is(plan!.capItem, 'dirt', 'grass dug by hand drops dirt');
  t.is(plan!.ms, 900 + 750 + 750);
  t.true(plan!.ms <= DIG_IN_MAX_MS);
});

test('digInPlan: a cheap block in the inventory closes the hole, never a crafting table or a chest', (t) => {
  t.is(digInPlan(asBot(createWorld({ inventory: ['crafting_table', 'chest', 'cobblestone'] })))!.capItem, 'cobblestone');
  t.is(digInPlan(asBot(createWorld({ inventory: ['oak_planks', 'dirt'] })))!.capItem, 'dirt', 'cheapest first');
  t.is(digInPlan(asBot(createWorld({ inventory: ['crafting_table', 'sand'] })))!.capItem, 'dirt', 'no table, no falling sand: the dug dirt instead');
});

test('digInPlan: not where it would open a cave, let liquid in, dig built or falling blocks, or take too long', (t) => {
  const cases: [string, WorldOptions][] = [
    ['a cave under the hole', { terrain: (x, y, z) => (x === 0 && z === 0 && y === 60 ? 'air' : undefined) }],
    ['air beside the bottom cell', { terrain: (x, y, z) => (x === 1 && z === 0 && y === 61 ? 'cave_air' : undefined) }],
    ['water beside the head cell', { terrain: (x, y, z) => (x === 0 && z === -1 && y === 62 ? 'water' : undefined) }],
    ['lava under the floor', { terrain: (x, y, z) => (x === 0 && z === 0 && y === 60 ? 'lava' : undefined) }],
    ['a plank floor (built)', { terrain: (x, y, z) => (x === 0 && z === 0 && y === 63 ? 'oak_planks' : undefined) }],
    ['gravel (falls)', { terrain: (x, y, z) => (x === 0 && z === 0 && y === 62 ? 'gravel' : undefined) }],
    ['stone by hand (too slow)', { terrain: (x, y) => (y < 64 ? 'stone' : undefined) }],
    ['in the air (jumping)', { onGround: false }]
  ];
  for (const [what, options] of cases) t.is(digInPlan(asBot(createWorld(options))), null, what);
});

test('digInPlan: stone with nothing to close the hole is refused; with a pickaxe its cobblestone will do', (t) => {
  const stone = (x: number, y: number) => (y < 64 ? 'stone' : undefined);
  const withPickaxe = createWorld({ terrain: stone, inventory: ['stone_pickaxe'] });
  withPickaxe.bot.pathfinder.bestHarvestTool.returns({ type: 1, name: 'stone_pickaxe' });
  const plan = digInPlan(asBot(withPickaxe));
  t.is(plan?.capItem, 'cobblestone');
  t.is(plan?.ms, 1200, 'quick with the pickaxe');

  // A tool that digs it quickly but is not a pickaxe (the fake's digTime only looks at whether there is a tool).
  const noPickaxe = createWorld({ terrain: stone, inventory: [] });
  noPickaxe.bot.pathfinder.bestHarvestTool.returns({ type: 2, name: 'iron_shovel' });
  t.is(digInPlan(asBot(noPickaxe)), null, 'stone mined without a pickaxe drops nothing to close the hole with');
});

// ---- enclosedNow, cues and menu -----------------------------------------------------------------------------------

function inHole() {
  const world = createWorld({ health: 4 });
  // The bot stands at the bottom of a closed hole: feet at y 61, head at y 62, cover at y 63 (still grass here).
  world.self.position = new Vec3(0.5, 61, 0.5);
  world.set(0, 61, 0, 'air');
  world.set(0, 62, 0, 'air');
  return world;
}

test('enclosedNow: true at the bottom of a closed hole, false in the open or with one side missing', (t) => {
  t.true(enclosedNow(asBot(inHole())));
  t.false(enclosedNow(asBot(createWorld())));
  const open = inHole();
  open.set(0, 63, 0, 'air');
  t.false(enclosedNow(asBot(open)), 'the hole is not closed');
  const side = inHole();
  side.set(1, 62, 0, 'air');
  t.false(enclosedNow(asBot(side)));
});

test('cues: walled in, hostiles near are not a danger (no low_health), but they are in the open', (t) => {
  const hole = inHole();
  hole.addMob('zombie', 3, 0);
  t.false(readCues(asBot(hole), policy()).some(cue => cue.kind === 'low_health'));

  const open = createWorld({ health: 4 });
  open.addMob('zombie', 3, 0);
  t.true(readCues(asBot(open), policy()).some(cue => cue.kind === 'low_health'));
});

test('menu: dig_in only while no walking mob can reach the bot before the hole is closed; skeletons do not count', (t) => {
  const menuFor = (mobName: string, x: number, kind: 'attacked' | 'chased' = 'attacked') => {
    const world = createWorld({ health: 12 });
    const mob = world.addMob(mobName, x, 0);
    return buildMenu(asBot(world), [{ kind, entityId: mob.id, detail: `${kind} by ${mobName}` }], { hasTask: false, policy: policy() });
  };
  const has = (menu: { id: string }[], id: string) => menu.some(option => option.id === id);
  // 2.4 s of digging plus a second: a zombie 1 or 6 blocks away arrives first, one 12 blocks away does not.
  t.false(has(menuFor('zombie', 1), 'dig_in'), 'next to the bot it would follow it down the shaft');
  t.false(has(menuFor('zombie', 6), 'dig_in'));
  const far = menuFor('zombie', 12, 'chased');
  t.true(has(far, 'dig_in'));
  t.true(has(far, 'flee'), 'the chased cue offers running too');
  t.is(far.find(option => option.id === 'dig_in')!.text,
    'dig straight down 3 blocks (about 2.4 s) and close the hole above the head with dirt: inside, no mob can reach or shoot the bot, so this ends the danger even when mobs keep coming back; the AI player digs out later');
  t.true(has(menuFor('skeleton', 3), 'dig_in'), 'a skeleton shoots but does not follow the bot into the hole');
  t.false(has(menuFor('spider', 9), 'dig_in'), 'a spider is quicker than a zombie');
});

test('menu: walled in there is no running, fighting or digging in', (t) => {
  const hole = inHole();
  const inside = hole.addMob('zombie', 1, 0);
  const walled = buildMenu(asBot(hole), [{ kind: 'attacked', entityId: inside.id, detail: 'hit by zombie' }], { hasTask: false, policy: policy() });
  t.deepEqual(walled.map(option => option.id).filter(id => ['flee', 'fight', 'hold', 'dig_in', 'run_from_creeper'].includes(id)), []);
  t.true(walled.some(option => option.id === 'continue'));
});

test('cues: a mob the bot ran from that is back within 16 blocks is the chased cue, unless it is hitting or the bot is walled in', (t) => {
  const world = createWorld();
  const zombie = world.addMob('zombie', 10, 0);
  const chasers = [{ id: zombie.id, label: `zombie (id ${zombie.id})`, detail: 'came within 16 blocks again 6s later' }];
  const cues = readCues(asBot(world), policy(), null, Date.now(), chasers);
  t.deepEqual(cues.map(cue => cue.kind), ['chased']);
  t.is(cues[0].detail, `zombie (id ${zombie.id}) 10.0 blocks 10 blocks east is back: the bot ran from it and it came within 16 blocks again 6s later`);
  t.is(cues[0].entityId, zombie.id);

  zombie.position = new Vec3(20.5, 64, 0.5);
  t.deepEqual(readCues(asBot(world), policy(), null, Date.now(), chasers), [], 'farther than 16 blocks');

  const hole = inHole();
  const below = hole.addMob('zombie', 5, 0);
  t.deepEqual(readCues(asBot(hole), policy(), null, Date.now(), [{ id: below.id, label: 'zombie', detail: 'came back' }]), []);
});

// ---- the dig_in macro ---------------------------------------------------------------------------------------------

function useClock(t: ExecutionContext) {
  const clock = sinon.useFakeTimers({ now: 1.7e12 });
  t.teardown(() => clock.restore());
  return clock;
}

function runDigIn(world: ReturnType<typeof createWorld>) {
  return MACROS.dig_in.run({ bot: asBot(world), signal: new AbortController().signal, target: null, policy: policy() });
}

test.serial('dig_in: digs the three blocks under the feet, drops in, and closes the hole above the head', async (t) => {
  const clock = useClock(t);
  const world = createWorld({ inventory: ['cobblestone'] });
  const running = runDigIn(world);
  await clock.tickAsync(3000);
  const text = await running;
  t.deepEqual(world.bot.dig.getCalls().map(call => (call.args[0] as { position: Vec3 }).position.y), [63, 62, 61]);
  t.is(world.self.position.y, 61, 'at the bottom of the hole');
  t.is(world.blocks.get('0,63,0'), 'cobblestone', 'the hole is closed');
  t.true(world.bot.pathfinder.setGoal.notCalled, 'no pathfinding');
  t.regex(text, /^dug in 3 blocks down and closed the hole above the head with cobblestone \(\d+\.\ds\): no mob can reach the bot; dig the block above the head at \(0, 63, 0\) to get out$/);
  t.true(enclosedNow(asBot(world)));
});

test.serial('dig_in fails with the step that went wrong: the bot did not drop, or the hole could not be closed', async (t) => {
  const clock = useClock(t);
  const stuck = createWorld({ inventory: ['cobblestone'] });
  stuck.bot.dig.callsFake(async () => {});
  const notDropping = t.throwsAsync(runDigIn(stuck), { message: 'dug 1 block(s) but the bot did not drop into the hole' });
  await clock.tickAsync(3000);
  await notDropping;

  const noCover = createWorld({ inventory: ['cobblestone'] });
  noCover.bot.placeBlock.callsFake(async () => { throw new Error('no block has been placed'); });
  const notClosed = t.throwsAsync(runDigIn(noCover), { message: 'dug 3 blocks down but could not close the hole above the head' });
  await clock.tickAsync(5000);
  await notClosed;
});

test('dig_in refuses to start where the ground is not safe for it any more', async (t) => {
  const world = createWorld({ terrain: (x, y, z) => (x === 0 && z === 0 && y === 60 ? 'air' : undefined) });
  await t.throwsAsync(runDigIn(world), { message: 'the ground here is no longer safe or quick to dig into' });
  t.true(world.bot.dig.notCalled);
});

// ---- recent instinct actions --------------------------------------------------------------------------------------

function answer(choice: string, p: number): DecisionResult {
  return {
    ok: true,
    answers: { action: { type: 'choice', choice, confidence: p, probabilities: { [choice]: p } }, urgent: { type: 'noul', noul: 0.9 } },
    model: 'test/model',
    latencyMs: 600
  };
}

test.serial('recent_instinct_actions: a flee and the mob that came back within 16 blocks afterwards', async (t) => {
  const clock = useClock(t);
  const world = createWorld({ health: 4 });
  const zombie = world.addMob('zombie', 4, 0);
  // A flee that works: the zombie is left behind.
  sinon.replace(MACROS.flee, 'run', sinon.fake(async () => {
    zombie.position = new Vec3(30.5, 64, 0.5);
    return 'got more than 16 blocks away from 1 mob(s)';
  }));
  t.teardown(() => sinon.restore());
  const events = new EventStore();
  const arbiter = new ActionArbiter({ stopBody: () => {} });
  const store = new PolicyStore();
  const tasks = new TaskManager({ getBot: () => world.bot as never, getArbiter: () => arbiter, events, behaviors: [] as never });
  const decide = sinon.stub().resolves(answer('flee', 0.9));
  const engine = new InstinctEngine({ bot: world.bot as never, arbiter, tasks, getPolicy: () => store.get(), events, decide });
  engine.start();
  t.teardown(() => engine.stop('test finished'));

  engine.tick();
  await clock.tickAsync(0);
  t.is((decide.firstCall.args[0] as Record<string, unknown>).recent_instinct_actions, 'none');
  await clock.tickAsync(100);

  // The bot got away; 5 s later the zombie is back at 6 blocks.
  engine.tick();
  await clock.tickAsync(5000);
  zombie.position = new Vec3(6.5, 64, 0.5);
  engine.tick();
  await clock.tickAsync(2000);
  engine.tick();
  await clock.tickAsync(0);

  const state = decide.lastCall.args[0] as Record<string, unknown>;
  t.regex((state.danger as string[]).join('; '), /zombie \(id \d+\) 6\.0 blocks 6 blocks east is back: the bot ran from it and it came within 16 blocks again 5s later/,
    'the instinct is asked again when the zombie comes back, before it hits');
  const recent = state.recent_instinct_actions as string[];
  t.true(Array.isArray(recent));
  t.regex(recent[0], /^\d+s ago: flee → done: got more than 16 blocks away from 1 mob\(s\) \(\d+\.\ds\); zombie \(id \d+\) came within 16 blocks again 5s later$/);
});

test.serial('instinct_action_running: how long the action runs, the hits taken since it started and how far the mob is', async (t) => {
  const clock = useClock(t);
  const world = createWorld({ health: 12 });
  const zombie = world.addMob('zombie', 3, 0);
  // A flee that never gets away.
  sinon.replace(MACROS.flee, 'run', sinon.fake.returns(new Promise<string>(() => {})));
  t.teardown(() => sinon.restore());
  const events = new EventStore();
  const arbiter = new ActionArbiter({ stopBody: () => {} });
  const store = new PolicyStore();
  store.update({ instinct: { lowHealth: 15 } }, 'llm');
  const tasks = new TaskManager({ getBot: () => world.bot as never, getArbiter: () => arbiter, events, behaviors: [] as never });
  const decide = sinon.stub().resolves(answer('flee', 0.9));
  const engine = new InstinctEngine({ bot: world.bot as never, arbiter, tasks, getPolicy: () => store.get(), events, decide });
  engine.start();
  t.teardown(() => engine.stop('test finished'));

  engine.tick();
  await clock.tickAsync(10);
  t.is(engine.status().running?.action, 'flee');
  t.is((decide.firstCall.args[0] as Record<string, unknown>).instinct_action_running, 'none');

  // Two hits while fleeing; the zombie keeps up.
  for (const health of [9, 6]) {
    world.bot.health = health;
    engine.noteDamage({ attackerId: zombie.id, type: 'mob_attack', time: Date.now() });
    await clock.tickAsync(1000);
  }
  zombie.position = new Vec3(1.3, 64, 0.5);
  engine.tick();
  await clock.tickAsync(10);
  const running = (decide.lastCall.args[0] as Record<string, unknown>).instinct_action_running;
  t.is(running, `flee for 2.0s; hit 2 time(s) and lost 6 health since it started; zombie (id ${zombie.id}) is 0.8 blocks away`);
});

test.serial('dig_in waits for a bot knocked into the air to land before judging the ground', async (t) => {
  const clock = useClock(t);
  const world = createWorld({ inventory: ['cobblestone'], onGround: false });
  setTimeout(() => { world.self.onGround = true; }, 300);
  const running = runDigIn(world);
  await clock.tickAsync(4000);
  t.regex(await running, /^dug in 3 blocks down/);
});

test('menu: the fight option says how hard the bot hits and how much health the mob has', (t) => {
  const world = createWorld({ health: 18 });
  const zombie = Object.assign(world.addMob('zombie', 1, 0), { health: 20 });
  const cues = [{ kind: 'attacked' as const, entityId: zombie.id, detail: 'hit by zombie' }];
  const bare = buildMenu(asBot(world), cues, { hasTask: false, policy: policy() }).find(option => option.id === 'fight');
  t.is(bare?.text, `fight zombie (id ${zombie.id}) (1.0 blocks away) with bare hand (1 damage per hit, so about 20 hits to kill it; the zombie has 20 health); it stops at health 6 or below`);

  world.inventory.push({ name: 'iron_sword', count: 1, type: 999, slot: 40 });
  const armed = buildMenu(asBot(world), cues, { hasTask: false, policy: policy() }).find(option => option.id === 'fight');
  t.regex(armed?.text ?? '', /with iron_sword \(6 damage per hit, so about 4 hits to kill it; the zombie has 20 health\)/);

  // As in the game: mineflayer has no health field on mobs, only the health metadata the server sends.
  const plain = world.addMob('zombie', 2, 0);
  plain.metadata = [];
  (plain.metadata as unknown[])[(world.bot.registry.entitiesByName.zombie.metadataKeys as string[]).indexOf('health')] = 13;
  const fromMetadata = buildMenu(asBot(world), [{ kind: 'attacked', entityId: plain.id, detail: 'hit' }], { hasTask: false, policy: policy() })
    .find(option => option.id === 'fight');
  t.regex(fromMetadata?.text ?? '', /\(6 damage per hit, so about 3 hits to kill it; the zombie has 13 health\)/);
});
