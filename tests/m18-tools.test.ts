// Contract: docs/BLUEPRINT.md F-045, F-046, E-020 (M18): ground-height (the ground at faraway points) and the lead
// behavior behind lead-animal (leading an animal on a lead or by holding its food); E-049 (M19): lead-animal reports
// the blocks the pathfinder dug and placed during the lead task. Expected values come from the contract.
import test, { ExecutionContext } from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import { groundAt, groundPoints, registerVisionTools } from '../src/tools/vision-tools.js';
import { chooseLure, leadBehavior, standableTarget, STUCK_MS, TEMPT_ITEMS } from '../src/autopilot/behaviors/lead.js';
import { Autopilot, BEHAVIORS } from '../src/autopilot/autopilot.js';
import { EventStore } from '../src/event-store.js';
import { asBot, createFactory, createFakeWorld } from './_helpers.js';
import { registerBlockTools } from '../src/tools/block-tools.js';
import { registerGatheringTools } from '../src/tools/gathering-tools.js';

// ---------------------------------------------------------------- ground-height

/** A bot at (0.5, 70, 0.5); `column(x, z, y)` gives the block name, or null for an unloaded column. */
function groundBot(column: (x: number, z: number, y: number) => string | null, position = new Vec3(0.5, 70, 0.5), dimension = 'overworld') {
  const EMPTY = new Set(['air', 'cave_air', 'short_grass', 'water', 'lava', 'torch']);
  return {
    entity: { position },
    game: { dimension, minY: -64, height: 384 },
    blockAt: (pos: Vec3) => {
      const p = pos.floored();
      const name = column(p.x, p.z, p.y);
      return name === null ? null : { name, position: p, boundingBox: EMPTY.has(name) ? 'empty' : 'block' };
    }
  };
}

const plains = (x: number, z: number, y: number) => (y < 68 ? 'dirt' : y === 68 ? 'grass_block' : y === 69 && x === 5 ? 'short_grass' : 'air');

test('groundAt surface: the ground and where to stand, through grass and tree tops, with the height against the bot', (t) => {
  const bot = groundBot((x, z, y) => {
    if (x === 3 && (y === 75 || y === 74)) return 'oak_leaves';
    if (x === 4 && y === 75) return 'oak_leaves';
    if (x === 4 && y >= 69 && y <= 74) return 'oak_log';
    return plains(x, z, y);
  });
  t.is(groundAt(bot as never, 10, 0, 'surface'), 'ground at y=68 (grass_block), stand at y=69 (1 lower than the bot)');
  t.is(groundAt(bot as never, 5, 0, 'surface'), 'ground at y=68 (grass_block), stand at y=69 (1 lower than the bot)', 'tall grass is passed through');
  t.is(groundAt(bot as never, 3, 0, 'surface'), 'ground at y=68 (grass_block), stand at y=69 (1 lower than the bot), under leaves at y=75');
  t.is(groundAt(bot as never, 4, 0, 'surface'), 'ground at y=68 (grass_block), stand at y=69 (1 lower than the bot), under leaves at y=75', 'the trunk is looked through too');
});

test('groundAt surface: water surface, depth and floor; lava; an unloaded column', (t) => {
  const bot = groundBot((x, z, y) => {
    if (x === 1) return y <= 55 ? 'sand' : y <= 62 ? 'water' : 'air';
    if (x === 2) return y <= 30 ? 'lava' : 'air';
    if (x === 3) return null;
    return plains(x, z, y);
  });
  t.is(groundAt(bot as never, 1, 0, 'surface'), 'water surface at y=62, 7 deep, floor at y=55 (sand)');
  t.is(groundAt(bot as never, 2, 0, 'surface'), 'lava at y=30');
  t.is(groundAt(bot as never, 3, 0, 'surface'), 'not loaded (beyond what the bot can see)');
});

test('groundAt current-level: under a roof the nearest standable level, the others, and none', (t) => {
  // A Nether-like column: roof at y 100, floors at y 63 and y 50, lava sea at y 31.
  const nether = (x: number, z: number, y: number) => {
    if (x === 9) return y <= 31 ? 'lava' : y >= 100 ? 'netherrack' : 'air';
    if (y >= 100 || y === 63 || y === 50 || y <= 40) return y <= 31 ? 'lava' : 'netherrack';
    return 'air';
  };
  const bot = groundBot(nether, new Vec3(0.5, 64, 0.5), 'the_nether');
  t.is(groundAt(bot as never, 4, 0, 'current-level'), 'stand at y=64 on netherrack (level with the bot) (also standable at y=51, y=41)');
  t.is(groundAt(bot as never, 9, 0, 'current-level'), 'no standable cell between y=32 and y=80', 'only the lava sea below');
  t.is(groundAt(groundBot(() => null, new Vec3(0.5, 64, 0.5)) as never, 4, 0, 'current-level'), 'not loaded (beyond what the bot can see)');
});

test('groundPoints: one point, several, relative offsets, a sampled line, and exactly one mode', (t) => {
  const bot = groundBot(plains, new Vec3(10.5, 70, 20.5));
  t.deepEqual(groundPoints(bot as never, { x: 3.7, z: -2.2 }), { points: [{ x: 3, z: -3 }] });
  t.deepEqual(groundPoints(bot as never, { points: [{ x: 1, z: 1 }, { x: -1, z: 2 }], relative: true }), { points: [{ x: 11, z: 21 }, { x: 9, z: 22 }] });
  t.deepEqual(groundPoints(bot as never, { direction: 'north', distance: 24, step: 8 }), { points: [{ x: 10, z: 12 }, { x: 10, z: 4 }, { x: 10, z: -4 }] });
  const diagonal = groundPoints(bot as never, { direction: 'southeast', distance: 10, step: 10 }) as { points: { x: number; z: number }[] };
  t.deepEqual(diagonal.points, [{ x: 17, z: 27 }], 'along the diagonal, 10 blocks walked');
  t.regex((groundPoints(bot as never, { x: 1, z: 1, direction: 'east' }) as { error: string }).error, /exactly one/);
  t.regex((groundPoints(bot as never, {}) as { error: string }).error, /exactly one/);
  t.regex((groundPoints(bot as never, { x: 1 }) as { error: string }).error, /both x and z/);
});

test('ground-height: one line per point, with distance and direction; the Nether uses the level view', async (t) => {
  const { factory, getTool } = createFactory();
  registerVisionTools(factory, asBot(groundBot(plains, new Vec3(0.5, 70, 0.5))));
  const text = (await getTool('ground-height')!.execute({ points: [{ x: 0, z: -20 }, { x: 15, z: 15 }] })).content[0].text;
  t.is(text, [
    'Ground from above, from the bot at (0, 70, 0) in overworld:',
    '- (0, -20), 20 blocks north: ground at y=68 (grass_block), stand at y=69 (1 lower than the bot)',
    '- (15, 15), 21 blocks southeast: ground at y=68 (grass_block), stand at y=69 (1 lower than the bot)'
  ].join('\n'));

  const nether = createFactory();
  const roofed = groundBot((x, z, y) => (y >= 100 || y === 63 ? 'netherrack' : 'air'), new Vec3(0.5, 64, 0.5), 'the_nether');
  registerVisionTools(nether.factory, asBot(roofed));
  t.regex((await nether.getTool('ground-height')!.execute({ x: 5, z: 0 })).content[0].text, /near the bot's level \(under a roof\)[\s\S]*stand at y=64 on netherrack/);
  t.true((await nether.getTool('ground-height')!.execute({})).isError);
});

// ---------------------------------------------------------------- lead: choosing how

function leadBot(inventory: { name: string; count: number }[], animalName = 'cow', type = 'animal') {
  const animal = { id: 2, name: animalName, type, position: new Vec3(2.5, 64, 0.5), isValid: true, height: 1.4 };
  const items = inventory.map((item, i) => ({ ...item, type: 900 + i, slot: 36 + i }));
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5) },
    entities: { 2: animal } as Record<number, unknown>,
    players: {},
    heldItem: null as { name: string } | null,
    inventory: { items: () => items.filter(item => item.count > 0) },
    equip: sinon.stub().callsFake(async (item: { name: string }) => { bot.heldItem = item; }),
    lookAt: sinon.stub().resolves(),
    activateEntity: sinon.stub().resolves(),
    pathfinder: { goto: sinon.stub().resolves(), stop: sinon.stub(), setGoal: sinon.stub() }
  };
  return { bot, animal, items };
}

test('chooseLure: the food the animal follows from the inventory, or why not', (t) => {
  t.deepEqual(chooseLure(leadBot([{ name: 'wheat', count: 3 }]).bot as never, 'cow'), { item: 'wheat' });
  t.deepEqual(chooseLure(leadBot([{ name: 'potato', count: 3 }]).bot as never, 'pig'), { item: 'potato' });
  t.regex((chooseLure(leadBot([]).bot as never, 'cow') as { error: string }).error, /No food a cow follows in the inventory \(it follows wheat\)/);
  t.regex((chooseLure(leadBot([{ name: 'carrot', count: 1 }]).bot as never, 'cow', 'carrot') as { error: string }).error, /does not follow carrot; it follows wheat/);
  t.regex((chooseLure(leadBot([]).bot as never, 'cow', 'wheat') as { error: string }).error, /No wheat in the inventory/);
  t.regex((chooseLure(leadBot([{ name: 'wheat', count: 1 }]).bot as never, 'horse') as { error: string }).error, /follows no food; lead it on a lead/);
  t.true(TEMPT_ITEMS.chicken.includes('wheat_seeds'));
});

test('lead prepare: not an animal, a lead asked for but none, auto with a lead picks the lead', (t) => {
  const params = (extra: Record<string, unknown> = {}) => leadBehavior.schema.parse({ entityId: 2, x: 20, y: 64, z: 0, ...extra });
  const zombie = leadBot([{ name: 'wheat', count: 1 }], 'zombie', 'hostile');
  t.regex((leadBehavior.prepare!(zombie.bot as never, params(), {} as never) as { error: string }).error, /is not an animal/);
  const noLead = leadBot([{ name: 'wheat', count: 1 }]);
  t.regex((leadBehavior.prepare!(noLead.bot as never, params({ method: 'leash' }), {} as never) as { error: string }).error, /No lead in the inventory/);
  const both = leadBot([{ name: 'wheat', count: 1 }, { name: 'lead', count: 1 }]);
  t.like((leadBehavior.prepare!(both.bot as never, params(), {} as never) as { value: unknown }).value, { method: 'leash', lure: 'wheat' });
  t.like((leadBehavior.prepare!(both.bot as never, params({ method: 'lure' }), {} as never) as { value: unknown }).value, { method: 'lure', lure: 'wheat' });
  t.true(BEHAVIORS.some(behavior => behavior.name === 'lead'), 'start-task offers it');
});

test('standableTarget: a target inside the ground or in the air moves to the cell to stand in, within 3', (t) => {
  // Ground: solid up to y 77 at x 0, up to y 63 elsewhere.
  const bot = { blockAt: (pos: Vec3) => ({ boundingBox: pos.y <= (pos.x === 0 ? 77 : 63) ? 'block' : 'empty' }) };
  t.deepEqual(standableTarget(bot as never, new Vec3(0, 77, 0)).toArray(), [0, 78, 0], 'the grass block inside the pen: one up');
  t.deepEqual(standableTarget(bot as never, new Vec3(5, 66, 0)).toArray(), [5, 64, 0], 'in the air: down to the floor');
  t.deepEqual(standableTarget(bot as never, new Vec3(5, 64, 0)).toArray(), [5, 64, 0], 'already standable');
  t.deepEqual(standableTarget(bot as never, new Vec3(5, 50, 0)).toArray(), [5, 50, 0], 'too deep: left as given');
  t.deepEqual(standableTarget({ blockAt: () => null } as never, new Vec3(5, 50.7, 0)).toArray(), [5, 50, 0], 'unloaded: left as given');
});

// ---------------------------------------------------------------- lead: running

function useClock(t: ExecutionContext) {
  const clock = sinon.useFakeTimers({ now: 1.7e12 });
  t.teardown(() => clock.restore());
  return clock;
}

/** The pathfinder moves the bot to the edge of the goal's range, along the straight line. */
function walking(bot: ReturnType<typeof leadBot>['bot'], afterMove: () => void) {
  bot.pathfinder.goto.callsFake(async (goal: { x: number; y: number; z: number; rangeSq: number }) => {
    const target = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5);
    const range = Math.sqrt(goal.rangeSq);
    const here = bot.entity.position;
    const distance = here.distanceTo(target);
    if (distance > range) bot.entity.position = target.plus(here.minus(target).scaled(range / distance));
    afterMove();
  });
}

async function runLead(t: ExecutionContext, clock: sinon.SinonFakeTimers, world: ReturnType<typeof leadBot>, extra: Record<string, unknown> = {}) {
  const params = leadBehavior.schema.parse({ entityId: 2, x: 20, y: 64, z: 0, ...extra });
  const prepared = leadBehavior.prepare!(world.bot as never, params, {} as never) as { value: never };
  const steps: string[] = [];
  const reports: string[] = [];
  const abort = new AbortController();
  t.teardown(() => abort.abort());
  let settled: { ok: true; value: string } | { ok: false; error: Error } | null = null;
  leadBehavior.run({
    bot: world.bot as never, params, services: {} as never, prepared: prepared.value, signal: abort.signal,
    isPaused: () => false, waitUntilRunning: async () => {}, setStep: text => steps.push(text), report: text => reports.push(text)
  }).then(value => { settled = { ok: true, value }; }, error => { settled = { ok: false, error }; });
  for (let i = 0; i < 4000 && !settled; i++) await clock.tickAsync(100);
  return { settled: settled as unknown as { ok: true; value: string } | { ok: false; error: Error }, steps, reports };
}

test.serial('lure: holds the wheat, walks the cow to the target in strides, and draws it onto the target', async (t) => {
  const clock = useClock(t);
  const world = leadBot([{ name: 'wheat', count: 5 }]);
  // A cow that follows the wheat: it stops 2.5 blocks behind the bot.
  walking(world.bot, () => {
    const away = world.animal.position.minus(world.bot.entity.position);
    world.animal.position = world.bot.entity.position.plus(away.scaled(2.5 / (away.norm() || 1)));
  });

  const { settled, steps } = await runLead(t, clock, world);

  t.true(settled.ok, settled.ok ? '' : settled.error.message);
  t.regex((settled as { value: string }).value, /^Led cow \(id 2\) to \(20, 64, 0\) by lure \(wheat\) in \d+s; it is \d\.\d blocks from the target$/);
  t.true(world.bot.equip.calledWithMatch({ name: 'wheat' }, 'hand'));
  t.is(world.bot.heldItem?.name, 'wheat', 'still holding the lure at the end');
  t.true(steps.some(text => text.startsWith('walking cow (id 2) toward the target')));
  t.true(steps.some(text => text.startsWith('drawing cow (id 2) onto the target')), 'from the target the bot walks on past it');
  t.false(world.bot.activateEntity.called, 'no lead');
});

test.serial('lure: the food goes back in the hand when walking changed what the bot holds', async (t) => {
  const clock = useClock(t);
  const world = leadBot([{ name: 'wheat', count: 5 }, { name: 'dirt', count: 5 }]);
  let strides = 0;
  walking(world.bot, () => {
    // The pathfinder placed a block on the first stride, so dirt is in the hand.
    if (strides++ === 0) world.bot.heldItem = { name: 'dirt' };
    const away = world.animal.position.minus(world.bot.entity.position);
    world.animal.position = world.bot.entity.position.plus(away.scaled(2.5 / (away.norm() || 1)));
  });
  const { settled } = await runLead(t, clock, world);
  t.true(settled.ok);
  t.true(world.bot.equip.callCount >= 2, 'equipped again after the stride');
  t.is(world.bot.heldItem?.name, 'wheat');
});

test.serial('lure: walks back to a cow left behind, and gives up when it stops following', async (t) => {
  const clock = useClock(t);
  const world = leadBot([{ name: 'wheat', count: 5 }]);
  world.animal.position = new Vec3(-9.5, 64, 0.5);
  // A cow that never moves.
  walking(world.bot, () => {});

  const { settled, steps } = await runLead(t, clock, world, { timeoutMs: 120000 });

  t.false(settled.ok);
  t.regex((settled as { error: Error }).error.message, new RegExp(`cow \\(id 2\\) stopped following: no closer to the target for ${STUCK_MS / 1000}s`));
  t.true(steps.some(text => text.startsWith('walking back to cow (id 2)')));
});

test.serial('leash: puts the lead on, walks there, takes it off at the end', async (t) => {
  const clock = useClock(t);
  const world = leadBot([{ name: 'lead', count: 1 }]);
  let onLead = false;
  world.bot.activateEntity.callsFake(async () => {
    const lead = world.items.find(item => item.name === 'lead')!;
    if (!onLead && world.bot.heldItem?.name === 'lead') {
      onLead = true;
      lead.count--;
    } else if (onLead) {
      onLead = false;
    }
  });
  // On the lead the cow is pulled along 2 blocks behind.
  walking(world.bot, () => {
    if (!onLead) return;
    const away = world.animal.position.minus(world.bot.entity.position);
    world.animal.position = world.bot.entity.position.plus(away.scaled(2 / (away.norm() || 1)));
  });

  const { settled, reports } = await runLead(t, clock, world);

  t.true(settled.ok, settled.ok ? '' : settled.error.message);
  t.regex((settled as { value: string }).value, /^Led cow \(id 2\) to \(20, 64, 0\) on a lead in \d+s/);
  t.is(world.bot.activateEntity.callCount, 2, 'on, then off');
  t.false(onLead);
  t.true(reports.includes('cow (id 2) is on the lead'));
});

test.serial('leash: a lead that does not hold falls back to the lure with auto, and fails with leash', async (t) => {
  const clock = useClock(t);
  const auto = leadBot([{ name: 'lead', count: 1 }, { name: 'wheat', count: 2 }]);
  walking(auto.bot, () => {
    const away = auto.animal.position.minus(auto.bot.entity.position);
    auto.animal.position = auto.bot.entity.position.plus(away.scaled(2.5 / (away.norm() || 1)));
  });
  const first = await runLead(t, clock, auto);
  t.true(first.settled.ok);
  t.regex((first.settled as { value: string }).value, /by lure \(wheat\)/);
  t.true(first.reports.includes('the lead did not hold; luring with wheat instead'));

  const only = leadBot([{ name: 'lead', count: 1 }]);
  walking(only.bot, () => {});
  const second = await runLead(t, clock, only, { method: 'leash' });
  t.false(second.settled.ok);
  t.regex((second.settled as { error: Error }).error.message, /could not put the lead on cow \(id 2\)/);
});

// ---------------------------------------------------------------- lead-animal: the pathfinder's edits (E-049)

type ToolReply = { content: { text: string }[]; isError?: boolean };

/**
 * lead-animal on an Autopilot bound to leadBot's bot, which also gets events (blockPlaced) and a dig for the
 * pathfinder to call. No decision key, so binding reaches no network.
 */
function leadAnimal(t: ExecutionContext, inventory: { name: string; count: number }[]) {
  const world = leadBot(inventory);
  const emitter = new EventEmitter();
  const bot = Object.assign(world.bot, {
    version: '1.20.4',
    dig: sinon.stub().resolves(),
    clearControlStates: sinon.stub(),
    on: emitter.on.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
    emit: emitter.emit.bind(emitter),
    listenerCount: emitter.listenerCount.bind(emitter)
  });
  const autopilot = new Autopilot({
    events: new EventStore(),
    decisions: { getKey: () => undefined, fetch: sinon.stub().rejects(new Error('no network in tests')) }
  });
  autopilot.bind(bot as never);
  t.teardown(() => autopilot.unbind('test over'));
  const { factory, getTool } = createFactory();
  registerGatheringTools(factory, () => autopilot);
  const lead = (extra: Record<string, unknown> = {}) =>
    getTool('lead-animal')!.execute({ entityId: 2, x: 20, y: 64, z: 0, ...extra }) as Promise<ToolReply>;
  return { ...world, bot, autopilot, lead };
}

/** Advances the fake clock until the tool replies. */
async function reply(clock: sinon.SinonFakeTimers, pending: Promise<ToolReply>, onTick: (tick: number) => void = () => {}) {
  let result: ToolReply | null = null;
  void pending.then(value => { result = value; });
  for (let i = 0; i < 4000 && !result; i++) {
    onTick(i);
    await clock.tickAsync(100);
  }
  return result as unknown as ToolReply;
}

/** A cow that follows the wheat: it stops 2.5 blocks behind the bot. */
function following(world: ReturnType<typeof leadBot>) {
  const away = world.animal.position.minus(world.bot.entity.position);
  world.animal.position = world.bot.entity.position.plus(away.scaled(2.5 / (away.norm() || 1)));
}

test.serial('lead-animal: a block the pathfinder placed during the lead task is listed after the reply', async (t) => {
  const clock = useClock(t);
  const world = leadAnimal(t, [{ name: 'wheat', count: 5 }]);
  const ownDig = world.bot.dig;
  let strides = 0;
  walking(world.bot, () => {
    // Scaffolding on the first stride, as the pathfinder did inside the pen in the M18 field test.
    if (strides++ === 0) world.bot.emit('blockPlaced', null, { name: 'cobblestone', position: new Vec3(5, 64, 0) });
    following(world);
  });

  const result = await reply(clock, world.lead());

  t.falsy(result.isError);
  t.regex(result.content[0].text,
    /^Led cow \(id 2\) to \(20, 64, 0\) by lure \(wheat\) in \d+s; it is \d\.\d blocks from the target; on the way the pathfinder placed 1 block\(s\): cobblestone at \(5, 64, 0\)$/);
  // Stopped when the task ended: bot.dig is the bot's own again and nothing listens for placements.
  t.is(world.bot.dig, ownDig);
  t.is(world.bot.listenerCount('blockPlaced'), 0);
});

test.serial('lead-animal: with nothing dug or placed the reply is the lead task\'s result, unchanged', async (t) => {
  const clock = useClock(t);
  const world = leadAnimal(t, [{ name: 'wheat', count: 5 }]);
  walking(world.bot, () => following(world));

  const result = await reply(clock, world.lead());

  t.falsy(result.isError);
  const text = result.content[0].text;
  t.regex(text, /^Led cow \(id 2\) to \(20, 64, 0\) by lure \(wheat\) in \d+s; it is \d\.\d blocks from the target$/);
  t.is(text, world.autopilot.tasks.list().history[0]?.result ?? '(no task record)');
  t.false(text.includes('on the way'));
});

test.serial('lead-animal: a failed lead task lists what the pathfinder dug too', async (t) => {
  const clock = useClock(t);
  const world = leadAnimal(t, [{ name: 'wheat', count: 5 }]);
  world.animal.position = new Vec3(-9.5, 64, 0.5);
  let strides = 0;
  // A cow that never moves; the pathfinder digs through a block on the first stride (bot.dig, as it does).
  walking(world.bot, () => {
    if (strides++ === 0) void world.bot.dig({ name: 'dirt', position: new Vec3(3, 64, 0) } as never);
  });

  const result = await reply(clock, world.lead({ timeoutMs: 120000 }));

  t.true(result.isError);
  const text = result.content[0].text;
  t.regex(text, new RegExp(`^Failed: cow \\(id 2\\) stopped following: no closer to the target for ${STUCK_MS / 1000}s`));
  t.true(text.endsWith('; on the way the pathfinder dug 1 block(s): dirt at (3, 64, 0)'), text);
  t.is(world.bot.listenerCount('blockPlaced'), 0);
});

test.serial('lead-animal: a cancelled lead task lists the blocks placed before it was cancelled', async (t) => {
  const clock = useClock(t);
  const world = leadAnimal(t, [{ name: 'wheat', count: 5 }]);
  let strides = 0;
  walking(world.bot, () => {
    if (strides++ === 0) world.bot.emit('blockPlaced', null, { name: 'cobblestone', position: new Vec3(5, 64, 0) });
    following(world);
  });

  const result = await reply(clock, world.lead(), tick => {
    const task = world.autopilot.tasks.currentTask();
    if (tick === 1 && task) void world.autopilot.tasks.cancel(task.id, 'cancelled by the test');
  });

  t.true(result.isError);
  const text = result.content[0].text;
  t.regex(text, /^Failed: Leading stopped: task t\d+ was cancelled \(cancelled by the test\)/);
  t.true(text.endsWith('; on the way the pathfinder placed 1 block(s): cobblestone at (5, 64, 0)'), text);
  t.is(world.bot.listenerCount('blockPlaced'), 0);
});

// ---------------------------------------------------------------- place-block keeps the block the LLM chose

test('place-block puts back in the hand the block chosen before the walk, when the walk changed it', async (t) => {
  const { bot, blocks } = createFakeWorld({ '5,63,0': 'stone' });
  const fence = { name: 'oak_fence', count: 1, type: 1 };
  const egg = { name: 'egg', count: 1, type: 2 };
  Object.assign(bot, { heldItem: fence, inventory: { items: () => [fence, egg] } });
  // The approach swaps the hand, as the pathfinder's scaffolding did.
  bot.pathfinder.goto.callsFake(async () => { bot.heldItem = egg; bot.entity.position = new Vec3(3, 64, 0); });
  bot.equip.callsFake(async (item: unknown) => { bot.heldItem = item; });
  bot.entity.position = new Vec3(20, 64, 0);
  const { factory, getTool } = createFactory();
  registerBlockTools(factory, asBot(bot));

  const text = (await getTool('place-block')!.execute({ x: 5, y: 64, z: 0 })).content[0].text;

  t.regex(text, /^Placed block at \(5, 64, 0\)/);
  t.true(bot.equip.calledWith(fence, 'hand'));
  t.is(blocks.get('5,64,0'), 'oak_fence', 'the fence was placed, not the egg');
});

