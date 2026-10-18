import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { ActionArbiter, PRIORITY } from '../src/autopilot/action-arbiter.js';
import { TaskManager, BehaviorServices } from '../src/autopilot/task-manager.js';
import { guardBehavior } from '../src/autopilot/behaviors/guard.js';
import { gatherBehavior } from '../src/autopilot/behaviors/gather.js';
import { huntBehavior } from '../src/autopilot/behaviors/hunt.js';
import { EventStore } from '../src/event-store.js';
import { PolicyStore } from '../src/autopilot/policy.js';
import { createFakeWorld } from './_helpers.js';

// Contract: docs/BLUEPRINT.md F-027 (verifies F-006 guard, F-007 gather, F-008 hunt) and invariant I1 (G6).
// Expected values come from the contracts; the implementation is only read for message details the contracts leave open.

const VERSION = '1.21.8';
const registry = minecraftData(VERSION);
// A realistic clock: the task manager throttles progress events relative to its last one, starting from 0.
const NOW = 1_700_000_000_000;

type FakeEntity = {
  id: number;
  name: string;
  type: string;
  username?: string;
  position: Vec3;
  isValid: boolean;
  height?: number;
  metadata?: unknown[];
  hitsToKill?: number;
};

type Goal = { entity?: FakeEntity; x?: number; y?: number; z?: number; rangeSq?: number } | null;

function fakeTimers() {
  return sinon.useFakeTimers({ now: NOW });
}

/** A bot whose pathfinder "arrives" as soon as a goal is set, and whose hits kill after `hitsToKill` attacks. */
function combatWorld(entities: FakeEntity[], services: BehaviorServices = {}) {
  const self = { id: 1, position: new Vec3(0, 64, 0) } as { id: number; position: Vec3; metadata?: unknown[] };
  const emitter = new EventEmitter();
  const inventory: { name: string; count: number; type: number }[] = [];
  const drops: FakeEntity[] = [];
  let nextDropId = 1000;

  const pathfinder = {
    goal: null as Goal,
    setGoal: sinon.spy((goal: Goal, _dynamic?: boolean) => {
      pathfinder.goal = goal;
      moveTo(goal);
    }),
    stop: sinon.stub(),
    goto: sinon.spy(async (goal: Goal) => {
      moveTo(goal);
      // Walking onto a drop picks it up.
      for (const [id, entity] of Object.entries(bot.entities)) {
        if (entity.name === 'item' && entity.position.distanceTo(self.position) < 1) {
          delete bot.entities[Number(id)];
          inventory.push({ name: 'beef', count: 1, type: 1 });
        }
      }
    }),
    bestHarvestTool: sinon.stub().returns(null)
  };

  function moveTo(goal: Goal) {
    if (!goal) return;
    if (goal.entity) {
      self.position = goal.entity.position.offset(1, 0, 0);
    } else if (goal.x !== undefined) {
      self.position = new Vec3(goal.x, goal.y!, goal.z!);
    }
  }

  const bot = {
    version: VERSION,
    registry,
    entity: self,
    entities: { 1: self } as Record<number, Partial<FakeEntity> & { id: number; position: Vec3 }>,
    players: {},
    health: 20,
    heldItem: null,
    game: { dimension: 'overworld' },
    inventory: { items: () => inventory },
    pathfinder,
    clearControlStates: sinon.stub(),
    equip: sinon.stub().resolves(),
    lookAt: sinon.stub().resolves(),
    on: (event: string, listener: (...args: unknown[]) => void) => emitter.on(event, listener),
    removeListener: (event: string, listener: (...args: unknown[]) => void) => emitter.removeListener(event, listener),
    attack: sinon.spy((target: FakeEntity) => {
      const hitsSoFar = bot.attack.getCalls().filter(call => call.args[0].id === target.id).length;
      if (hitsSoFar < (target.hitsToKill ?? Infinity)) return;
      target.isValid = false;
      delete (bot.entities as Record<number, unknown>)[target.id];
      emitter.emit('entityDead', target);
      const drop: FakeEntity = { id: nextDropId++, name: 'item', type: 'object', position: target.position.floored(), isValid: true };
      drops.push(drop);
      (bot.entities as Record<number, FakeEntity>)[drop.id] = drop;
    })
  };
  for (const entity of entities) (bot.entities as Record<number, FakeEntity>)[entity.id] = entity;

  const arbiter = new ActionArbiter({ stopBody: () => { pathfinder.goal = null; } });
  const events = new EventStore();
  const tasks = new TaskManager({
    getBot: () => bot as never,
    getArbiter: () => arbiter,
    events,
    services,
    behaviors: [guardBehavior, gatherBehavior, huntBehavior] as never
  });
  return { bot, self, pathfinder, arbiter, events, tasks, inventory, drops };
}

function player(id: number, username: string, x: number, z = 0): FakeEntity {
  return { id, name: 'player', type: 'player', username, position: new Vec3(x, 64, z), isValid: true, height: 1.8 };
}

function mob(id: number, name: string, x: number, z = 0, hitsToKill = 2): FakeEntity {
  return { id, name, type: registry.entitiesByName[name].type, position: new Vec3(x, 64, z), isValid: true, height: 1.5, hitsToKill };
}

function progressMessages(events: EventStore): string[] {
  return events.query({ types: ['task_progress'], limit: 50 }).events.map(event => event.message);
}

async function cancelTask(tasks: TaskManager, clock: sinon.SinonFakeTimers) {
  const cancelled = tasks.cancel(undefined, 'test over');
  await clock.tickAsync(2100);
  await cancelled;
}

// ---------------------------------------------------------------- guard (F-006)

test.serial('guard kills a zombie that comes near the guarded player, reports the kill and returns to the player', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const steve = player(5, 'Steve', 2);
  const { tasks, bot, pathfinder, events, self } = combatWorld([steve]);

  const started = await tasks.start('guard', { target: 'Steve' });
  t.true(started.ok, started.ok ? undefined : started.error);
  await clock.tickAsync(500);
  t.true(bot.attack.notCalled, 'nothing to fight yet');

  // A zombie walks to 6 blocks from Steve (inside the default radius 8).
  const zombie = mob(20, 'zombie', 8);
  (bot.entities as Record<number, FakeEntity>)[20] = zombie;
  await clock.tickAsync(3000);

  t.true(bot.attack.called, 'the zombie is attacked');
  t.true(bot.attack.getCalls().every(call => call.args[0].id === 20));
  t.false(20 in bot.entities, 'the zombie died');
  t.true(progressMessages(events).some(message => /^t1 guard: .*killed zombie.*\b1 kill\b/.test(message)),
    `progress events: ${JSON.stringify(progressMessages(events))}`);

  // After the fight the bot goes back to Steve (within 3 blocks).
  const lastGoal = pathfinder.setGoal.lastCall.args[0] as Goal;
  t.is(lastGoal?.entity?.username, 'Steve');
  t.true(pathfinder.setGoal.lastCall.args[1], 'following the player is a dynamic goal');
  t.true(self.position.distanceTo(steve.position) <= 3);
  t.regex(tasks.currentTask()?.step ?? '', /guarding Steve/);
  t.is(tasks.currentTask()?.status, 'running');

  await cancelTask(tasks, clock);
});

test.serial('guard never attacks a pig or a player inside the radius', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, bot } = combatWorld([player(5, 'Steve', 2), mob(30, 'pig', 3, 1), player(31, 'Alex', 1, 1)]);

  await tasks.start('guard', { target: 'Steve' });
  await clock.tickAsync(5000);

  t.true(bot.attack.notCalled);
  t.regex(tasks.currentTask()?.step ?? '', /guarding Steve/, 'the guard loop is alive');

  // Sanity: the same loop does fight a hostile mob, and still leaves the pig and Alex alone.
  (bot.entities as Record<number, FakeEntity>)[20] = mob(20, 'zombie', 4);
  await clock.tickAsync(3000);
  t.true(bot.attack.called);
  t.true(bot.attack.getCalls().every(call => call.args[0].name === 'zombie'));

  await cancelTask(tasks, clock);
});

test.serial('guard stops chasing a zombie that runs beyond maxChase and returns to the player', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const steve = player(5, 'Steve', 2);
  const zombie = mob(20, 'zombie', 6, 0, Infinity);
  const { tasks, bot, pathfinder, self } = combatWorld([steve, zombie]);

  await tasks.start('guard', { target: 'Steve' });
  await clock.tickAsync(400);
  t.true(bot.attack.called, 'the fight began');

  // The zombie flees to 28 blocks from Steve, beyond the default maxChase of 16.
  zombie.position = new Vec3(30, 64, 0);
  await clock.tickAsync(300);
  const attacksAfterEscape = bot.attack.callCount;
  // Keep this window under engage's 5 s no-progress limit: past it the fight would end as 'lost' anyway,
  // and the test would no longer show that maxChase ended the chase.
  await clock.tickAsync(4000);

  t.is(bot.attack.callCount, attacksAfterEscape, 'no more attacks');
  const lastGoal = pathfinder.setGoal.lastCall.args[0] as Goal;
  t.is(lastGoal?.entity?.username, 'Steve', 'the bot is back to following Steve, not the zombie');
  t.not((pathfinder.goal as Goal)?.entity?.id, 20);
  t.true(self.position.distanceTo(steve.position) <= 3);
  t.is(tasks.currentTask()?.status, 'running', 'giving up a chase does not end the task');

  await cancelTask(tasks, clock);
});

test.serial('guard fails with target lost once the guarded player is missing for more than 15 seconds', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, bot } = combatWorld([player(5, 'Steve', 2)]);
  await tasks.start('guard', { target: 'Steve' });
  await clock.tickAsync(500);

  delete (bot.entities as Record<number, unknown>)[5];
  const end = tasks.waitForEnd('t1');
  await clock.tickAsync(14000);
  t.is(tasks.currentTask()?.status, 'running', 'still waiting for Steve to come back');

  await clock.tickAsync(2500);
  const final = await end;
  t.is(final.status, 'failed');
  t.regex(final.result ?? '', /^target lost/);
});

test.serial('guard keeps waiting when the player comes back within 15 seconds', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const steve = player(5, 'Steve', 2);
  const { tasks, bot } = combatWorld([steve]);
  await tasks.start('guard', { target: 'Steve' });

  delete (bot.entities as Record<number, unknown>)[5];
  await clock.tickAsync(10000);
  (bot.entities as Record<number, FakeEntity>)[5] = steve;
  await clock.tickAsync(1000);
  delete (bot.entities as Record<number, unknown>)[5];
  await clock.tickAsync(10000);

  t.is(tasks.currentTask()?.status, 'running', 'the 15 seconds start over after Steve was seen again');
  await cancelTask(tasks, clock);
});

test.serial('guard can watch a saved waypoint read from services.waypoints', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const store = {
    normalizeName: (name: string) => name.trim().toLowerCase(),
    get: (name: string) => (name.trim().toLowerCase() === 'base' ? { x: 20, y: 64, z: 0, dimension: 'overworld', createdAt: 0 } : undefined)
  };
  const { tasks, pathfinder, self } = combatWorld([], { waypoints: store as never });

  const started = await tasks.start('guard', { waypoint: 'Base' });
  t.true(started.ok, started.ok ? undefined : started.error);
  await clock.tickAsync(500);

  const goal = pathfinder.setGoal.getCalls().map(call => call.args[0] as Goal).find(g => g && g.x !== undefined);
  t.truthy(goal, 'the bot walks to the post');
  t.is(goal?.x, 20);
  t.is(goal?.y, 64);
  t.is(goal?.z, 0);
  t.true(self.position.distanceTo(new Vec3(20, 64, 0)) <= 3);
  t.is(tasks.currentTask()?.status, 'running');

  await cancelTask(tasks, clock);
});

test.serial('guard refuses an unknown waypoint or one in another dimension', async (t) => {
  const store = {
    normalizeName: (name: string) => name.trim().toLowerCase(),
    get: (name: string) => (name.trim().toLowerCase() === 'fortress' ? { x: 0, y: 70, z: 0, dimension: 'the_nether', createdAt: 0 } : undefined)
  };
  const { tasks } = combatWorld([], { waypoints: store as never });

  const unknown = await tasks.start('guard', { waypoint: 'nowhere' });
  t.false(unknown.ok);
  if (!unknown.ok) t.regex(unknown.error, /nowhere/);

  const elsewhere = await tasks.start('guard', { waypoint: 'fortress' });
  t.false(elsewhere.ok);
  if (!elsewhere.ok) t.regex(elsewhere.error, /the_nether|dimension/);
  t.is(tasks.currentTask(), null);
});

test.serial('guard rejects partial coordinates and more than one thing to guard', async (t) => {
  const { tasks } = combatWorld([player(5, 'Steve', 2)]);

  const partial = await tasks.start('guard', { x: 10, y: 64 });
  const two = await tasks.start('guard', { target: 'Steve', x: 10, y: 64, z: 0 });
  const twoOther = await tasks.start('guard', { waypoint: 'base', x: 10, y: 64, z: 0 });
  const radiusTooBig = await tasks.start('guard', { target: 'Steve', radius: 50 });

  t.false(partial.ok);
  if (!partial.ok) t.regex(partial.error, /Invalid params for guard/);
  t.false(two.ok);
  t.false(twoOther.ok);
  t.false(radiusTooBig.ok, 'radius is limited to 2-24');
  t.is(tasks.currentTask(), null);
});

test.serial('guard refuses to start when the player to guard is not visible', async (t) => {
  const { tasks } = combatWorld([]);
  const result = await tasks.start('guard', { target: 'Steve' });
  t.false(result.ok);
});

test.serial('guard does not attack while a manual command holds the body, and fights again after resume-task', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const zombie = mob(20, 'zombie', 4, 0, Infinity);
  const { tasks, bot, arbiter } = combatWorld([player(5, 'Steve', 2), zombie]);

  await tasks.start('guard', { target: 'Steve' });
  await clock.tickAsync(300);
  t.true(bot.attack.called, 'the fight began');

  const manual = await arbiter.acquire({ holder: 'manual look-at', priority: PRIORITY.MANUAL });
  t.true(manual.ok);
  await clock.tickAsync(60);
  const attacksWhenPaused = bot.attack.callCount;
  await clock.tickAsync(3000);

  t.is(tasks.currentTask()?.status, 'paused');
  t.is(bot.attack.callCount, attacksWhenPaused, 'no attacks while paused');

  if (manual.ok) manual.lease.release();
  t.true(tasks.resume().ok);
  await clock.tickAsync(1500);
  t.true(bot.attack.callCount > attacksWhenPaused, 'the fight resumes');

  await cancelTask(tasks, clock);
});

test.serial('guard does not start a fight with a zombie that arrives while paused', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, bot, arbiter } = combatWorld([player(5, 'Steve', 2)]);
  await tasks.start('guard', { target: 'Steve' });
  await clock.tickAsync(300);

  const manual = await arbiter.acquire({ holder: 'manual move-to-position', priority: PRIORITY.MANUAL });
  (bot.entities as Record<number, FakeEntity>)[20] = mob(20, 'zombie', 3);
  await clock.tickAsync(3000);

  t.true(bot.attack.notCalled);
  if (manual.ok) manual.lease.release();
  await cancelTask(tasks, clock);
});

// ---------------------------------------------------------------- gather (F-007)

function gatherWorld(initial: Record<string, string>) {
  const world = createFakeWorld(initial);
  const { bot, blocks, key, keyToVec } = world;
  const data = minecraftData(bot.version);
  const inventory: { name: string; count: number; type: number }[] = [];
  bot.inventory.items = () => inventory;
  bot.findBlocks.callsFake(({ point, matching, maxDistance, count }: { point: Vec3; matching: number; maxDistance: number; count: number }) =>
    [...blocks.entries()]
      .filter(([, name]) => name === data.blocks[matching]?.name)
      .map(([k]) => keyToVec(k))
      .filter(pos => pos.distanceTo(point) <= maxDistance)
      .sort((a, b) => a.distanceTo(point) - b.distanceTo(point))
      .slice(0, count));
  const mine = async (block: { name: string; position: Vec3 }) => {
    blocks.delete(key(block.position));
    inventory.push({ name: block.name, count: 1, type: data.itemsByName[block.name]?.id ?? 0 });
  };
  bot.dig.callsFake(mine);

  const arbiter = new ActionArbiter({ stopBody: () => { bot.pathfinder.goal = null; } });
  const events = new EventStore();
  const tasks = new TaskManager({ getBot: () => bot as never, getArbiter: () => arbiter, events, behaviors: [gatherBehavior] as never });
  return { ...world, inventory, arbiter, events, tasks, mine };
}

test.serial('gather mines the requested count and reports the collect-block result', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, bot, blocks } = gatherWorld({ '2,64,0': 'oak_log', '3,64,0': 'oak_log', '0,64,4': 'oak_log', '9,64,0': 'oak_log' });

  const started = await tasks.start('gather', { blockType: 'oak_log', count: 3 });
  t.true(started.ok);
  const end = tasks.waitForEnd('t1');
  await clock.tickAsync(5000);
  const final = await end;

  t.is(final.status, 'done');
  t.is(final.result, 'Mined 3 of 3 oak_log; inventory gained 3 item(s)');
  t.is(bot.dig.callCount, 3);
  t.deepEqual(bot.dig.getCalls().map(call => call.args[0].position.toString()).sort(),
    [new Vec3(0, 64, 4), new Vec3(2, 64, 0), new Vec3(3, 64, 0)].map(String).sort(), 'the three nearest logs');
  t.true(blocks.has('9,64,0'), 'nothing beyond the requested count is mined');
});

test.serial('gather skips a block next to lava and counts it as skipped', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, bot, blocks } = gatherWorld({ '1,64,0': 'oak_log', '2,64,0': 'lava', '0,64,4': 'oak_log' });

  await tasks.start('gather', { blockType: 'oak_log', count: 1 });
  const end = tasks.waitForEnd('t1');
  await clock.tickAsync(3000);
  const final = await end;

  t.is(final.status, 'done');
  t.regex(final.result ?? '', /^Mined 1 of 1 oak_log; inventory gained 1 item\(s\)/);
  t.regex(final.result ?? '', /skipped 1\b/);
  t.true(bot.dig.getCalls().every(call => !call.args[0].position.equals(new Vec3(1, 64, 0))), 'the log next to lava is never dug');
  t.is(blocks.get('1,64,0'), 'oak_log');
  t.false(blocks.has('0,64,4'));
});

test.serial('M7: gather skips a block touching water (submerged or an aquifer wall) and mines a dry one', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, bot, blocks } = gatherWorld({ '1,64,0': 'oak_log', '1,65,0': 'water', '0,64,4': 'oak_log' });

  await tasks.start('gather', { blockType: 'oak_log', count: 1 });
  const end = tasks.waitForEnd('t1');
  await clock.tickAsync(3000);
  const final = await end;

  t.is(final.status, 'done');
  t.regex(final.result ?? '', /^Mined 1 of 1 oak_log; inventory gained 1 item\(s\); skipped 1 unreachable or unsafe block/);
  t.true(bot.dig.getCalls().every(call => !call.args[0].position.equals(new Vec3(1, 64, 0))), 'the wet log is never dug');
  t.is(blocks.get('1,64,0'), 'oak_log');
  t.false(blocks.has('0,64,4'));
});

test.serial('gather fails when nothing could be mined', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const { tasks } = gatherWorld({ '1,64,0': 'oak_log', '2,64,0': 'lava' });

  await tasks.start('gather', { blockType: 'oak_log', count: 2 });
  const end = tasks.waitForEnd('t1');
  await clock.tickAsync(3000);
  const final = await end;

  t.is(final.status, 'failed');
  t.regex(final.result ?? '', /^Mined 0 of 2 oak_log/);
});

test.serial('gather finishes with a partial result when it runs out of blocks', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const { tasks } = gatherWorld({ '2,64,0': 'oak_log' });

  await tasks.start('gather', { blockType: 'oak_log', count: 3 });
  const end = tasks.waitForEnd('t1');
  await clock.tickAsync(3000);
  const final = await end;

  t.is(final.status, 'done');
  t.regex(final.result ?? '', /^Mined 1 of 3 oak_log; inventory gained 1 item\(s\)/);
});

test.serial('gather refuses an unknown block type', async (t) => {
  const { tasks } = gatherWorld({});
  const result = await tasks.start('gather', { blockType: 'unobtainium_log' });
  t.false(result.ok);
  const tooMany = await tasks.start('gather', { blockType: 'oak_log', count: 65 });
  t.false(tooMany.ok, 'count is limited to 1-64');
});

test.serial('a pause while digging is not a failure: the same block is mined after resume-task', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, bot, arbiter, mine } = gatherWorld({ '2,64,0': 'oak_log' });
  let abortDig: ((error: Error) => void) | undefined;
  bot.dig.onFirstCall().callsFake(() => new Promise((_, reject) => { abortDig = reject; }));
  bot.dig.callsFake(mine);
  bot.stopDigging.callsFake(() => abortDig?.(new Error('Digging aborted')));

  await tasks.start('gather', { blockType: 'oak_log', count: 1 });
  await clock.tickAsync(100);
  t.true(bot.dig.calledOnce, 'digging has begun');

  const manual = await arbiter.acquire({ holder: 'manual look-at', priority: PRIORITY.MANUAL });
  t.true(manual.ok);
  await clock.tickAsync(200);
  t.true(bot.stopDigging.called, 'digging stops when the task is paused');
  t.is(tasks.currentTask()?.status, 'paused');
  await clock.tickAsync(3000);
  t.true(bot.dig.calledOnce, 'no digging while paused');

  if (manual.ok) manual.lease.release();
  t.true(tasks.resume().ok);
  const end = tasks.waitForEnd('t1');
  await clock.tickAsync(2000);
  const final = await end;

  t.is(final.status, 'done');
  t.is(final.result, 'Mined 1 of 1 oak_log; inventory gained 1 item(s)');
  t.is(bot.dig.callCount, 2);
  t.true(bot.dig.secondCall.args[0].position.equals(new Vec3(2, 64, 0)), 'the interrupted block is mined');
});

test.serial('gather stops at its time limit even while paused', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, bot, arbiter, mine } = gatherWorld({ '2,64,0': 'oak_log', '3,64,0': 'oak_log' });
  let abortDig: ((error: Error) => void) | undefined;
  bot.dig.callsFake(mine);
  bot.dig.onSecondCall().callsFake(() => new Promise((_, reject) => { abortDig = reject; }));
  bot.stopDigging.callsFake(() => abortDig?.(new Error('Digging aborted')));

  await tasks.start('gather', { blockType: 'oak_log', count: 2, timeoutMs: 5000 });
  const end = tasks.waitForEnd('t1');
  await clock.tickAsync(1000);
  t.is(bot.dig.callCount, 2, 'the first log is mined and the second is being dug');

  await arbiter.acquire({ holder: 'manual look-at', priority: PRIORITY.MANUAL });
  await clock.tickAsync(200);
  t.is(tasks.currentTask()?.status, 'paused');
  await clock.tickAsync(5000);
  const final = await end;

  t.is(final.status, 'done', 'one log was mined, so the result is partial rather than a failure');
  t.regex(final.result ?? '', /^Mined 1 of 2 oak_log; inventory gained 1 item\(s\)/);
  t.regex(final.result ?? '', /time limit reached/);
  t.is(bot.dig.callCount, 2);
});

test.serial('gather fails at its time limit when nothing was mined while paused', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, bot, arbiter } = gatherWorld({ '2,64,0': 'oak_log' });
  let abortDig: ((error: Error) => void) | undefined;
  bot.dig.callsFake(() => new Promise((_, reject) => { abortDig = reject; }));
  bot.stopDigging.callsFake(() => abortDig?.(new Error('Digging aborted')));

  await tasks.start('gather', { blockType: 'oak_log', count: 1, timeoutMs: 2000 });
  const end = tasks.waitForEnd('t1');
  await clock.tickAsync(100);
  await arbiter.acquire({ holder: 'manual look-at', priority: PRIORITY.MANUAL });
  await clock.tickAsync(3000);
  const final = await end;

  t.is(final.status, 'failed');
  t.regex(final.result ?? '', /^Mined 0 of 1 oak_log/);
  t.regex(final.result ?? '', /time limit reached/);
});

// ---------------------------------------------------------------- hunt (F-008)

test.serial('hunt kills the requested number of cows and walks to their drops', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, bot, pathfinder, inventory, drops, events } = combatWorld([mob(40, 'cow', 2), mob(41, 'cow', 0, 2), mob(42, 'cow', 0, -9)]);

  const started = await tasks.start('hunt', { animal: 'cow', count: 2 });
  t.true(started.ok, started.ok ? undefined : started.error);
  const end = tasks.waitForEnd('t1');
  await clock.tickAsync(10000);
  const final = await end;

  t.is(final.status, 'done');
  t.regex(final.result ?? '', /^Killed 2 of 2 cow/);
  t.true(40 in bot.entities === false && 41 in bot.entities === false, 'the two nearest cows are dead');
  t.true(42 in bot.entities, 'no more cows than requested');
  t.is(drops.length, 2);
  for (const drop of drops) {
    t.true(pathfinder.goto.getCalls().some(call => {
      const goal = call.args[0] as Goal;
      return goal?.x === drop.position.x && goal?.y === drop.position.y && goal?.z === drop.position.z;
    }), `walked to the drop at ${drop.position}`);
  }
  const firstDropWalk = pathfinder.goto.getCalls().find(call => (call.args[0] as Goal)?.x === drops[0].position.x
    && (call.args[0] as Goal)?.z === drops[0].position.z);
  const firstCowId = bot.attack.firstCall.args[0].id;
  const firstHitOnSecondCow = bot.attack.getCalls().find(call => call.args[0].id !== firstCowId);
  t.truthy(firstDropWalk && firstHitOnSecondCow);
  if (firstDropWalk && firstHitOnSecondCow) t.true(firstDropWalk.calledBefore(firstHitOnSecondCow), 'drops are picked up before the next cow is chased');
  t.true(inventory.some(item => item.name === 'beef'), 'beef was picked up');
  t.regex(final.result ?? '', /inventory gained 2 item\(s\)/);
  t.true(progressMessages(events).some(message => /^t1 hunt: .*killed cow/.test(message)));
});

test.serial('hunt never attacks a pig while hunting cows', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, bot } = combatWorld([mob(50, 'pig', 1, 1), mob(40, 'cow', 2, -1)]);

  await tasks.start('hunt', { animal: 'cow', count: 1 });
  const end = tasks.waitForEnd('t1');
  await clock.tickAsync(5000);
  const final = await end;

  t.is(final.status, 'done');
  t.true(bot.attack.called);
  t.true(bot.attack.getCalls().every(call => call.args[0].name === 'cow'));
  t.true(50 in bot.entities, 'the pig is alive');
});

test.serial('hunt never attacks a player, even next to the animals', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, bot } = combatWorld([player(5, 'Steve', 1), mob(40, 'cow', 2, 1)]);

  await tasks.start('hunt', { animal: 'cow', count: 1 });
  const end = tasks.waitForEnd('t1');
  await clock.tickAsync(5000);
  const final = await end;

  t.is(final.status, 'done');
  t.true(bot.attack.called, 'the cow was fought');
  t.true(bot.attack.getCalls().every(call => call.args[0].type !== 'player'));
});

test.serial('hunt rejects player as the animal to hunt', async (t) => {
  const { tasks } = combatWorld([player(5, 'Steve', 1)]);

  const lower = await tasks.start('hunt', { animal: 'player' });
  const upper = await tasks.start('hunt', { animal: 'Player' });

  t.false(lower.ok);
  if (!lower.ok) t.regex(lower.error, /Invalid params for hunt/);
  t.false(upper.ok);
  t.is(tasks.currentTask(), null);
});

test.serial('hunt fails with no huntable wolf when only tamed wolves are nearby', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const ownerIndex = registry.entitiesByName.wolf.metadataKeys!.indexOf('owneruuid');
  t.true(ownerIndex >= 0);
  const tamed = (id: number, x: number) => {
    const wolf = mob(id, 'wolf', x);
    wolf.metadata = [];
    wolf.metadata[ownerIndex] = '6f0e1a2b-0000-4000-8000-000000000001';
    return wolf;
  };
  const { tasks, bot } = combatWorld([tamed(60, 2), tamed(61, 3)]);

  const started = await tasks.start('hunt', { animal: 'wolf', count: 1 });
  t.true(started.ok, started.ok ? undefined : started.error);
  const end = tasks.waitForEnd('t1');
  await clock.tickAsync(3000);
  const final = await end;

  t.is(final.status, 'failed');
  t.regex(final.result ?? '', /no huntable wolf/);
  t.true(bot.attack.notCalled, 'tamed animals are never attacked');
});

test.serial('hunt refuses an unknown entity type', async (t) => {
  const { tasks } = combatWorld([]);
  const result = await tasks.start('hunt', { animal: 'unicorn' });
  t.false(result.ok);
  if (!result.ok) t.regex(result.error, /unicorn/);
  const tooMany = await tasks.start('hunt', { animal: 'cow', count: 17 });
  t.false(tooMany.ok, 'count is limited to 1-16');
});

// ---------------------------------------------------------------- review fixes (F-006 chase limit, return stall; F-008 living targets; F-007 pause while equipping)

test.serial('guard with radius 24 and the default maxChase fights a zombie 20 blocks from the post; the summary shows max chase 24', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  // F-006: the effective chase limit is never below the radius, else a mob inside the radius could never be reached.
  const zombie = mob(20, 'zombie', 20);
  const { tasks, bot, events } = combatWorld([zombie]);

  const started = await tasks.start('guard', { x: 0, y: 64, z: 0, radius: 24 });
  t.true(started.ok, started.ok ? undefined : started.error);
  if (started.ok) t.regex(started.task.summary, /max chase 24\b/);
  t.regex(tasks.currentTask()?.summary ?? '', /max chase 24\b/);

  await clock.tickAsync(3000);

  t.true(bot.attack.called, 'the zombie 20 blocks away is attacked');
  t.true(bot.attack.getCalls().every(call => call.args[0].id === 20));
  t.false(20 in bot.entities, 'the zombie died');
  const messages = progressMessages(events);
  t.false(messages.some(message => /stopped chasing|more than 16 blocks/.test(message)),
    `not given up as out of range: ${JSON.stringify(messages)}`);
  t.true(messages.some(message => /^t1 guard: .*killed zombie/.test(message)), JSON.stringify(messages));
  t.is(tasks.currentTask()?.status, 'running');

  await cancelTask(tasks, clock);
});

test.serial('guard of a point it cannot get back to reports it once after about 5 seconds and keeps guarding', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, pathfinder, events, self } = combatWorld([]);
  // A pathfinder that accepts goals but never moves the bot (no path).
  pathfinder.setGoal = sinon.spy((goal: Goal, _dynamic?: boolean) => { pathfinder.goal = goal; });
  const stallMessages = () => progressMessages(events).filter(message => /cannot get back to/.test(message));
  const postGoals = () => pathfinder.setGoal.getCalls().filter(call => (call.args[0] as Goal)?.x === 30).length;

  const started = await tasks.start('guard', { x: 30, y: 64, z: 0 });
  t.true(started.ok, started.ok ? undefined : started.error);

  await clock.tickAsync(4500);
  t.is(stallMessages().length, 0, 'not reported before 5 s without progress');
  t.is(postGoals(), 1, 'one goal to the post so far');

  await clock.tickAsync(2000);
  t.is(stallMessages().length, 1, `reported once: ${JSON.stringify(progressMessages(events))}`);
  t.regex(stallMessages()[0], /^t1 guard: /);
  t.true(postGoals() >= 2, 'the goal to the post is issued again after the report');

  await clock.tickAsync(20000);
  t.is(stallMessages().length, 1, 'reported only once');
  t.is(tasks.currentTask()?.status, 'running', 'guarding continues');
  t.true(self.position.equals(new Vec3(0, 64, 0)), 'the fake pathfinder never moved the bot');

  await cancelTask(tasks, clock);
});

test.serial('hunt refuses item and arrow (not living mobs) without cancelling the running task', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, events } = combatWorld([]);
  const running = await tasks.start('guard', { x: 0, y: 64, z: 0 });
  t.true(running.ok);
  await clock.tickAsync(500);

  for (const animal of ['item', 'arrow']) {
    const result = await tasks.start('hunt', { animal });
    t.false(result.ok, `${animal} cannot be hunted`);
    if (!result.ok) t.regex(result.error, new RegExp(animal));
    t.is(tasks.currentTask()?.id, 't1', 'the guard task is still the current task');
    t.is(tasks.currentTask()?.status, 'running');
  }
  await clock.tickAsync(500);
  t.is(tasks.currentTask()?.status, 'running');
  t.is(events.query({ types: ['task_cancelled'], limit: 10 }).events.length, 0, 'nothing was cancelled');
  t.is(events.query({ types: ['task_started'], limit: 10 }).events.length, 1, 'no hunt task was started');

  await cancelTask(tasks, clock);
});

test.serial('gather paused while equipping the tool does not dig until resume-task, then digs the same block with a forced look', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, bot, arbiter } = gatherWorld({ '2,64,0': 'oak_log' });
  bot.pathfinder.bestHarvestTool.returns({ name: 'iron_axe' });
  let finishEquip: (() => void) | undefined;
  bot.equip.onFirstCall().callsFake(() => new Promise<void>(resolve => { finishEquip = resolve; }));

  const started = await tasks.start('gather', { blockType: 'oak_log', count: 1 });
  t.true(started.ok);
  const end = tasks.waitForEnd('t1');
  await clock.tickAsync(10);
  t.true(bot.equip.calledOnce, 'equipping the best tool');
  t.true(bot.dig.notCalled);

  const manual = await arbiter.acquire({ holder: 'manual look-at', priority: PRIORITY.MANUAL });
  t.true(manual.ok);
  await clock.tickAsync(100);
  t.is(tasks.currentTask()?.status, 'paused');

  // The equip finishes while the task is paused: digging must not start now.
  finishEquip?.();
  await clock.tickAsync(3000);
  t.true(bot.dig.notCalled, 'no digging while paused');
  t.is(tasks.currentTask()?.status, 'paused');

  if (manual.ok) manual.lease.release();
  t.true(tasks.resume().ok);
  await clock.tickAsync(2000);
  const final = await end;

  t.is(final.status, 'done');
  t.is(final.result, 'Mined 1 of 1 oak_log; inventory gained 1 item(s)', 'the block was not skipped');
  t.true(bot.dig.calledOnce);
  t.true(bot.dig.firstCall.args[0].position.equals(new Vec3(2, 64, 0)));
  t.is((bot.dig.firstCall.args as unknown[])[1], true, 'dug with a forced look');
});

// ---------------------------------------------------------------- second-round fixes (F-006 follow slack, F-007 walk under the time limit)

test.serial('guard of a player resting 5.5 blocks away (inside the follow slack) never reports that it cannot get back', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  // GoalFollow re-anchors only after the player moves a few blocks, so a follower may rest past POST_RANGE (3).
  const steve = player(5, 'Steve', 5.5);
  const { tasks, pathfinder, events, self } = combatWorld([steve]);
  // A pathfinder that accepts goals but never moves the bot.
  pathfinder.setGoal = sinon.spy((goal: Goal, _dynamic?: boolean) => { pathfinder.goal = goal; });
  const stallMessages = () => progressMessages(events).filter(message => /cannot get back to/.test(message));

  const started = await tasks.start('guard', { target: 'Steve' });
  t.true(started.ok, started.ok ? undefined : started.error);
  await clock.tickAsync(10000);

  t.is(stallMessages().length, 0, `no stall report at 5.5 blocks: ${JSON.stringify(progressMessages(events))}`);
  t.is(tasks.currentTask()?.status, 'running');
  t.true(self.position.equals(new Vec3(0, 64, 0)), 'the bot stayed 5.5 blocks from Steve the whole time');
  t.is(self.position.distanceTo(steve.position), 5.5);

  await cancelTask(tasks, clock);
});

test.serial('guard of a player 9 blocks away that it cannot reach reports it exactly once after about 5 seconds and keeps guarding', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const steve = player(5, 'Steve', 5.5);
  const { tasks, pathfinder, events, self } = combatWorld([steve]);
  pathfinder.setGoal = sinon.spy((goal: Goal, _dynamic?: boolean) => { pathfinder.goal = goal; });
  const stallMessages = () => progressMessages(events).filter(message => /cannot get back to/.test(message));

  await tasks.start('guard', { target: 'Steve' });
  await clock.tickAsync(2000);
  t.is(stallMessages().length, 0);

  // Steve walks on to 9 blocks from the bot (beyond POST_RANGE + 4), and the pathfinder still cannot move the bot.
  steve.position = new Vec3(9, 64, 0);
  await clock.tickAsync(4500);
  t.is(stallMessages().length, 0, 'not reported before 5 s without progress');

  await clock.tickAsync(2000);
  t.is(stallMessages().length, 1, `reported once: ${JSON.stringify(progressMessages(events))}`);
  t.regex(stallMessages()[0], /^t1 guard: cannot get back to Steve/);

  await clock.tickAsync(20000);
  t.is(stallMessages().length, 1, 'reported only once');
  t.is(tasks.currentTask()?.status, 'running', 'guarding continues');
  t.true(self.position.equals(new Vec3(0, 64, 0)), 'the fake pathfinder never moved the bot');

  await cancelTask(tasks, clock);
});

test.serial('guard of a fixed point 5.5 blocks away still reports the stall (the follow slack is only for a guarded entity)', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, pathfinder, events } = combatWorld([]);
  pathfinder.setGoal = sinon.spy((goal: Goal, _dynamic?: boolean) => { pathfinder.goal = goal; });
  const stallMessages = () => progressMessages(events).filter(message => /cannot get back to/.test(message));

  await tasks.start('guard', { x: 5.5, y: 64, z: 0 });
  await clock.tickAsync(7000);

  t.is(stallMessages().length, 1, `a fixed post keeps POST_RANGE 3: ${JSON.stringify(progressMessages(events))}`);
  t.is(tasks.currentTask()?.status, 'running');

  await cancelTask(tasks, clock);
});

test.serial('gather whose walk to a block it cannot see never arrives fails at its time limit instead of hanging, and stops the pathfinder', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, bot } = gatherWorld({ '5,64,0': 'oak_log' });
  bot.canSeeBlock = () => false;
  // A walk that never settles (no path, no error).
  bot.pathfinder.goto.callsFake(() => new Promise<void>(() => {}));
  const stopsWhileRunning: (string | undefined)[] = [];
  bot.pathfinder.stop.callsFake(() => { stopsWhileRunning.push(tasks.currentTask()?.status); });

  // collect-block (E-004) starts the same task and waits for it.
  const started = await tasks.start('gather', { blockType: 'oak_log', count: 1, timeoutMs: 2000 }, { source: 'tool' });
  t.true(started.ok, started.ok ? undefined : started.error);
  const end = tasks.waitForEnd('t1');
  let ended = false;
  void end.then(() => { ended = true; });

  await clock.tickAsync(1900);
  t.false(ended, 'still walking before the time limit');
  t.true(bot.pathfinder.goto.called, 'the walk began');
  t.regex(tasks.currentTask()?.step ?? '', /^walking to oak_log/);

  await clock.tickAsync(600);
  t.true(ended, 'the task ended within about 0.5 s of the time limit');
  const final = await end;
  t.is(final.status, 'failed', 'nothing was mined');
  t.regex(final.result ?? '', /^Mined 0 of 1 oak_log/);
  t.regex(final.result ?? '', /time limit reached/);
  t.true((final.endedAt ?? Infinity) - final.startedAt <= 2500, `ended after ${(final.endedAt ?? NaN) - final.startedAt} ms`);
  t.true(bot.dig.notCalled);
  t.true(bot.pathfinder.goto.callCount <= 3, `no busy loop of walks: ${bot.pathfinder.goto.callCount}`);
  t.true(stopsWhileRunning.includes('running'), `the time limit stopped the pathfinder while the task was running: ${JSON.stringify(stopsWhileRunning)}`);
});

test.serial('gather that mined one block and then cannot reach the next ends done with a partial result at its time limit', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, bot } = gatherWorld({ '2,64,0': 'oak_log', '6,64,0': 'oak_log' });
  const hidden = new Vec3(6, 64, 0);
  (bot as unknown as { canSeeBlock: (block: { position: Vec3 }) => boolean }).canSeeBlock = block => !block.position.equals(hidden);
  bot.pathfinder.goto.callsFake(() => new Promise<void>(() => {}));

  await tasks.start('gather', { blockType: 'oak_log', count: 2, timeoutMs: 2000 }, { source: 'tool' });
  const end = tasks.waitForEnd('t1');
  let ended = false;
  void end.then(() => { ended = true; });

  await clock.tickAsync(1900);
  t.false(ended);
  t.is(bot.dig.callCount, 1, 'the visible log was mined');

  await clock.tickAsync(600);
  t.true(ended, 'the task ended within about 0.5 s of the time limit');
  const final = await end;
  t.is(final.status, 'done', 'one log was mined, so the result is partial rather than a failure');
  t.regex(final.result ?? '', /^Mined 1 of 2 oak_log; inventory gained 1 item\(s\)/);
  t.regex(final.result ?? '', /time limit reached/);
  t.true(bot.dig.getCalls().every(call => !call.args[0].position.equals(hidden)), 'the unreachable log was never dug');
});

// Final review: unsafe blocks are skipped before any walk, as the old collect-block did inside digBlockAt.
test.serial('gather skips a lava-adjacent block it cannot see without walking to it, and mines a safe one', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, bot } = gatherWorld({ '3,64,0': 'oak_log', '3,65,0': 'lava', '0,64,6': 'oak_log' });
  (bot as { canSeeBlock: (block: { position: Vec3 }) => boolean }).canSeeBlock = block => block.position.x !== 3;

  await tasks.start('gather', { blockType: 'oak_log', count: 1 });
  const end = tasks.waitForEnd('t1');
  await clock.tickAsync(5000);
  const final = await end;

  t.is(final.status, 'done');
  t.is(final.result, 'Mined 1 of 1 oak_log; inventory gained 1 item(s); skipped 1 unreachable or unsafe block(s)');
  const walkedToLava = bot.pathfinder.goto.getCalls().some(call => call.args[0].x === 3 && call.args[0].z === 0);
  t.false(walkedToLava, 'no walk toward the lava-adjacent log');
  t.deepEqual(bot.dig.getCalls().map(call => call.args[0].position.toString()), [new Vec3(0, 64, 6).toString()]);
});

// Final review: a target the pathfinder breaks on the way counts as mined (F-007), not as skipped.
test.serial('gather counts a target the pathfinder broke while walking to it as mined', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, bot, blocks, key } = gatherWorld({ '5,64,0': 'oak_log', '0,64,10': 'oak_log' });
  (bot as { canSeeBlock: () => boolean }).canSeeBlock = () => false;
  bot.pathfinder.goto.callsFake(async (goal: { x: number }) => {
    if (goal.x === 5) blocks.delete(key(new Vec3(5, 64, 0)));
  });

  await tasks.start('gather', { blockType: 'oak_log', count: 1 });
  const end = tasks.waitForEnd('t1');
  await clock.tickAsync(5000);
  const final = await end;

  t.is(final.status, 'done');
  t.is(final.result, 'Mined 1 of 1 oak_log; inventory gained 0 item(s)');
  t.is(bot.dig.callCount, 0, 'nothing else is dug');
  t.is(blocks.get('0,64,10'), 'oak_log', 'the second log is left alone');
});

// Final review: a paused gather task must not abort a dig that a manual command started on another block (G1).
test.serial('a paused gather does not stop a manual dig on another block', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const { tasks, bot, arbiter } = gatherWorld({ '2,64,0': 'oak_log' });
  let releaseEquip!: () => void;
  bot.pathfinder.bestHarvestTool.returns({ name: 'iron_axe' });
  bot.equip.callsFake(() => new Promise<void>(resolve => { releaseEquip = resolve; }));

  await tasks.start('gather', { blockType: 'oak_log', count: 1 });
  await clock.tickAsync(10);
  const manual = await arbiter.acquire({ holder: 'manual dig-block', priority: PRIORITY.MANUAL });
  t.true(manual.ok);
  (bot as { targetDigBlock?: unknown }).targetDigBlock = { position: new Vec3(9, 64, 9) };
  await clock.tickAsync(200);

  t.false(bot.stopDigging.called, 'the manual dig keeps going');
  t.false(bot.dig.called, 'the paused task does not dig');
  releaseEquip();
  await clock.tickAsync(200);
  t.false(bot.dig.called);
  if (manual.ok) manual.lease.release();
  await tasks.cancel(undefined, 'done');
});

// ---------------------------------------------------------------- M3: guard and hunt read the policy at each fight (F-014 combat group, F-006, F-008, I1)

/** A combat world whose behaviors read the live policy, as the autopilot wires it (services.policy). */
function policyWorld(entities: FakeEntity[], store: PolicyStore) {
  // Keep the lambda: every update replaces the frozen policy object, so a captured store.get() would go stale.
  return combatWorld(entities, { policy: () => store.get() });
}

function updatePolicy(t: { true: (value: boolean, message?: string) => void }, store: PolicyStore, update: unknown) {
  const result = store.update(update, 'llm');
  t.true(result.ok, result.ok ? undefined : result.errors.join('; '));
  return result;
}

function goalTargets(pathfinder: { setGoal: sinon.SinonSpy }, id: number): boolean {
  return pathfinder.setGoal.getCalls().some(call => (call.args[0] as Goal)?.entity?.id === id);
}

function swordEquips(bot: { equip: sinon.SinonStub }): string[] {
  return bot.equip.getCalls()
    .map(call => (call.args[0] as { name?: string } | undefined)?.name ?? '')
    .filter(name => name.endsWith('_sword'));
}

test.serial('guard reads combat.retreatHealth at each check: too hurt at 12 of 15 it leaves a zombie alone, and fights it once set-policy lowers the threshold, without restarting the task', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const store = new PolicyStore();
  updatePolicy(t, store, { combat: { retreatHealth: 15 } });
  const zombie = mob(20, 'zombie', 5);
  const { tasks, bot, pathfinder, events } = policyWorld([player(5, 'Steve', 2), zombie], store);
  bot.health = 12;

  const started = await tasks.start('guard', { target: 'Steve' });
  t.true(started.ok, started.ok ? undefined : started.error);
  await clock.tickAsync(3000);

  t.true(bot.attack.notCalled, 'health 12 is not above retreatHealth 15: no fight');
  t.false(goalTargets(pathfinder, 20), 'the zombie is not even chased');
  t.true(20 in bot.entities);
  t.is(tasks.currentTask()?.status, 'running');
  t.regex(tasks.currentTask()?.step ?? '', /guarding Steve/);

  // The LLM lowers the threshold; the running task sees it at its next check.
  updatePolicy(t, store, { combat: { retreatHealth: 6 } });
  await clock.tickAsync(3000);

  t.true(bot.attack.called, 'the zombie is attacked once health 12 is above retreatHealth 6');
  t.true(bot.attack.getCalls().every(call => call.args[0].id === 20));
  t.false(20 in bot.entities, 'the zombie died');
  t.true(progressMessages(events).some(message => /^t1 guard: .*killed zombie/.test(message)), JSON.stringify(progressMessages(events)));
  t.is(tasks.currentTask()?.id, 't1', 'the same task, not a restarted one');
  t.is(tasks.currentTask()?.status, 'running');
  t.is(events.query({ types: ['task_started'], limit: 10 }).events.length, 1, 'only one task was ever started');

  await cancelTask(tasks, clock);
});

test.serial('guard with the default policy (avoidNeutral true) never attacks an enderman in its radius, and attacks it once set-policy turns avoidNeutral off', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const store = new PolicyStore();
  t.true(store.get().combat.avoidNeutral, 'the default leaves neutral mobs alone');
  const enderman = mob(70, 'enderman', 4, 1);
  const { tasks, bot, pathfinder, events } = policyWorld([player(5, 'Steve', 2), enderman], store);

  const started = await tasks.start('guard', { target: 'Steve' });
  t.true(started.ok, started.ok ? undefined : started.error);
  await clock.tickAsync(5000);

  t.true(bot.attack.notCalled, 'the enderman is never attacked with the default policy');
  t.false(goalTargets(pathfinder, 70), 'nor chased');
  t.true(70 in bot.entities);
  t.regex(tasks.currentTask()?.step ?? '', /guarding Steve/, 'the guard loop is alive');

  updatePolicy(t, store, { combat: { avoidNeutral: false } });
  await clock.tickAsync(3000);

  t.true(bot.attack.called, 'with avoidNeutral off the enderman inside the radius is fought');
  t.true(bot.attack.getCalls().every(call => call.args[0].id === 70));
  t.false(70 in bot.entities, 'the enderman died');
  t.is(tasks.currentTask()?.id, 't1');
  t.is(tasks.currentTask()?.status, 'running');
  t.is(events.query({ types: ['task_started'], limit: 10 }).events.length, 1);

  await cancelTask(tasks, clock);
});

test.serial('guard with avoidNeutral false attacks an enderman in its radius but still never a tamed wolf or a player', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const store = new PolicyStore();
  updatePolicy(t, store, { combat: { avoidNeutral: false } });
  const ownerIndex = registry.entitiesByName.wolf.metadataKeys!.indexOf('owneruuid');
  t.true(ownerIndex >= 0);
  const tamedWolf = mob(71, 'wolf', 3, -2);
  tamedWolf.metadata = [];
  tamedWolf.metadata[ownerIndex] = '6f0e1a2b-0000-4000-8000-000000000001';
  const enderman = mob(70, 'enderman', 5, 1);
  const { tasks, bot, events } = policyWorld([player(5, 'Steve', 2), enderman, tamedWolf, player(31, 'Alex', 1, 2)], store);

  const started = await tasks.start('guard', { target: 'Steve' });
  t.true(started.ok, started.ok ? undefined : started.error);
  await clock.tickAsync(5000);

  t.true(bot.attack.called, 'the enderman is attacked');
  t.true(bot.attack.getCalls().every(call => call.args[0].id === 70), `targets: ${JSON.stringify(bot.attack.getCalls().map(call => call.args[0].name))}`);
  t.false(70 in bot.entities, 'the enderman died');
  t.true(71 in bot.entities, 'the tamed wolf is never attacked (I1: tamed animals are never legal)');
  t.true(31 in bot.entities && 5 in bot.entities, 'no player is attacked');
  t.true(progressMessages(events).some(message => /^t1 guard: .*killed enderman/.test(message)), JSON.stringify(progressMessages(events)));
  t.is(tasks.currentTask()?.status, 'running');

  await cancelTask(tasks, clock);
});

test.serial('hunt still refuses players with combat.attackPlayers true: player is rejected as the animal and a player next to the cows is never hit', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const store = new PolicyStore();
  const enabled = updatePolicy(t, store, { combat: { attackPlayers: true } });
  t.true(enabled.ok && enabled.warnings.length > 0, 'turning attackPlayers on returns a warning (F-014)');
  t.true(store.get().combat.attackPlayers);
  const { tasks, bot } = policyWorld([player(5, 'Steve', 1), mob(40, 'cow', 2, 1)], store);

  const lower = await tasks.start('hunt', { animal: 'player' });
  const upper = await tasks.start('hunt', { animal: 'Player' });
  t.false(lower.ok, 'players cannot be hunted, whatever the policy says');
  if (!lower.ok) t.regex(lower.error, /Invalid params for hunt/);
  t.false(upper.ok);
  t.is(tasks.currentTask(), null);

  const started = await tasks.start('hunt', { animal: 'cow', count: 1 });
  t.true(started.ok, started.ok ? undefined : started.error);
  const end = tasks.waitForEnd(started.ok ? started.task.id : 't1');
  await clock.tickAsync(5000);
  const final = await end;

  t.is(final.status, 'done');
  t.true(bot.attack.called, 'the cow was fought');
  t.true(bot.attack.getCalls().every(call => call.args[0].type !== 'player' && call.args[0].name === 'cow'));
  t.true(5 in bot.entities, 'Steve is untouched');
});

test.serial('hunt with combat.attackPlayers false does not swing a sword at a cow with a player right next to it (control)', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const store = new PolicyStore();
  const { tasks, bot, inventory } = policyWorld([player(5, 'Steve', 1, 1), mob(40, 'cow', 1)], store);
  inventory.push({ name: 'iron_sword', count: 1, type: registry.itemsByName.iron_sword.id });

  const started = await tasks.start('hunt', { animal: 'cow', count: 1 });
  t.true(started.ok, started.ok ? undefined : started.error);
  const end = tasks.waitForEnd('t1');
  await clock.tickAsync(5000);
  const final = await end;

  t.is(final.status, 'done');
  t.deepEqual(swordEquips(bot), [], 'the sword sweep would hit Steve, so no sword is taken out');
  t.true(bot.attack.getCalls().every(call => call.args[0].name === 'cow'));
});

// F-008: hunt never attacks players, whatever the policy says. A full-strength sword hit sweeps everything within a
// block of the cow (F-011), so with Steve next to the cow a sword hit would hurt him. With attackPlayers true, hunt
// passes the policy's rules (attackPlayers: true) to engage, sweepBystanders then counts Steve as a legal target rather
// than a bystander, and equipBestWeapon takes the sword out. Expected: hunt keeps players illegal for its fights.
test.serial('hunt with combat.attackPlayers true still does not swing a sword at a cow with a player right next to it', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const store = new PolicyStore();
  updatePolicy(t, store, { combat: { attackPlayers: true } });
  const { tasks, bot, inventory } = policyWorld([player(5, 'Steve', 1, 1), mob(40, 'cow', 1)], store);
  inventory.push({ name: 'iron_sword', count: 1, type: registry.itemsByName.iron_sword.id });

  const started = await tasks.start('hunt', { animal: 'cow', count: 1 });
  t.true(started.ok, started.ok ? undefined : started.error);
  const end = tasks.waitForEnd('t1');
  await clock.tickAsync(5000);
  const final = await end;

  t.is(final.status, 'done');
  t.deepEqual(swordEquips(bot), [], 'the sword sweep would hit Steve, so no sword is taken out');
});

test.serial('guard with combat.attackPlayers false does not swing a sword at a zombie right next to the guarded player (control)', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const store = new PolicyStore();
  const zombie = mob(20, 'zombie', 2, 1, Infinity);
  const { tasks, bot, inventory } = policyWorld([player(5, 'Steve', 2), zombie], store);
  inventory.push({ name: 'iron_sword', count: 1, type: registry.itemsByName.iron_sword.id });

  await tasks.start('guard', { target: 'Steve' });
  await clock.tickAsync(1500);

  t.true(bot.attack.called, 'the zombie is fought');
  t.true(bot.attack.getCalls().every(call => call.args[0].id === 20));
  t.deepEqual(swordEquips(bot), [], 'a sword sweep at the zombie would hit Steve');
  await cancelTask(tasks, clock);
});

// F-006 guard never attacks players, and F-011 names the guarded player as the bystander a sword sweep must spare.
// With attackPlayers true guard passes attackPlayers: true to engage, so the guarded player stops counting as a
// bystander and the sword comes out next to him.
test.serial('guard with combat.attackPlayers true still does not swing a sword at a zombie right next to the guarded player', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const store = new PolicyStore();
  updatePolicy(t, store, { combat: { attackPlayers: true } });
  const zombie = mob(20, 'zombie', 2, 1, Infinity);
  const { tasks, bot, inventory } = policyWorld([player(5, 'Steve', 2), zombie], store);
  inventory.push({ name: 'iron_sword', count: 1, type: registry.itemsByName.iron_sword.id });

  await tasks.start('guard', { target: 'Steve' });
  await clock.tickAsync(1500);

  t.true(bot.attack.called, 'the zombie is fought');
  t.deepEqual(swordEquips(bot), [], 'a sword sweep at the zombie would hit Steve');
  await cancelTask(tasks, clock);
});

test.serial('hunt reads combat.retreatHealth: at health 12 below a threshold of 15 it does not fight, and a hunt after set-policy lowers it kills the cow', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const store = new PolicyStore();
  updatePolicy(t, store, { combat: { retreatHealth: 15 } });
  const { tasks, bot } = policyWorld([mob(40, 'cow', 2, 1)], store);
  bot.health = 12;

  const first = await tasks.start('hunt', { animal: 'cow', count: 1 });
  t.true(first.ok, first.ok ? undefined : first.error);
  const firstEnd = tasks.waitForEnd('t1');
  await clock.tickAsync(3000);
  const firstFinal = await firstEnd;

  t.is(firstFinal.status, 'failed', 'nothing was killed');
  t.true(bot.attack.notCalled, 'no hit at or below retreatHealth');
  t.true(40 in bot.entities);

  updatePolicy(t, store, { combat: { retreatHealth: 6 } });
  const second = await tasks.start('hunt', { animal: 'cow', count: 1 });
  t.true(second.ok, second.ok ? undefined : second.error);
  const secondEnd = tasks.waitForEnd(second.ok ? second.task.id : 't2');
  await clock.tickAsync(5000);
  const secondFinal = await secondEnd;

  t.is(secondFinal.status, 'done');
  t.true(bot.attack.called);
  t.false(40 in bot.entities, 'the cow died');
});

test.serial('hunt reads combat.retreatHealth before each fight: raised after the first kill, the second cow is left alone and the hunt ends with a partial result', async (t) => {
  const clock = fakeTimers();
  t.teardown(() => clock.restore());
  const store = new PolicyStore();
  const { tasks, bot } = policyWorld([mob(40, 'cow', 2, 1), mob(41, 'cow', 0, -6)], store);
  bot.health = 12;
  // The LLM raises the threshold right after the first kill, while the task is still running.
  let raised = false;
  bot.on('entityDead', () => {
    if (raised) return;
    raised = true;
    updatePolicy(t, store, { combat: { retreatHealth: 15 } });
  });

  const started = await tasks.start('hunt', { animal: 'cow', count: 2 });
  t.true(started.ok, started.ok ? undefined : started.error);
  const end = tasks.waitForEnd('t1');
  await clock.tickAsync(5000);
  const final = await end;

  t.true(raised, 'the first cow died');
  t.false(40 in bot.entities);
  t.true(41 in bot.entities, 'the second cow is not fought at health 12 with retreatHealth 15');
  t.true(bot.attack.getCalls().every(call => call.args[0].id === 40));
  t.is(final.status, 'done', 'one cow was killed, so the result is partial rather than a failure');
  t.regex(final.result ?? '', /^Killed 1 of 2 cow/);
});
