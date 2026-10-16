// Contract: docs/BLUEPRINT.md F-024 (verifies F-011 src/autopilot/combat.ts) and invariant G6 I1.
// Expected values come from the contracts, not from what the implementation happens to output.
import test, { ExecutionContext } from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import pathfinderPkg from 'mineflayer-pathfinder';
import {
  engage, equipBestWeapon, weaponStats, attackCooldownMs, isSword, sweepBystanders, CombatResult, EngageOptions
} from '../src/autopilot/combat.js';

const { goals } = pathfinderPkg;
const registry = minecraftData('1.21.8');
const TICK = 50;

type FakeEntity = {
  id: number;
  name?: string;
  type: string;
  username?: string;
  position: Vec3;
  isValid: boolean;
  height: number;
  metadata: unknown[];
};

type FakeItem = { name: string; count: number; type: number };

function mob(id: number, name: string, x: number, type = 'hostile'): FakeEntity {
  return { id, name, type, position: new Vec3(x, 64, 0), isValid: true, height: 1.8, metadata: [] };
}

function player(id: number, username: string, x: number): FakeEntity {
  return { id, name: 'player', type: 'player', username, position: new Vec3(x, 64, 0), isValid: true, height: 1.8, metadata: [] };
}

function item(name: string): FakeItem {
  return { name, count: 1, type: registry.itemsByName[name].id };
}

function metadataIndex(entityName: string, key: string): number {
  const index = registry.entitiesByName[entityName].metadataKeys?.indexOf(key) ?? -1;
  if (index < 0) throw new Error(`no ${key} metadata on ${entityName}`);
  return index;
}

function fakeBot(targets: FakeEntity[], inventory: FakeItem[] = []) {
  const self = { id: 1, name: 'player', type: 'player', username: 'Bot', position: new Vec3(0, 64, 0), isValid: true, height: 1.8, metadata: [] };
  const entities: Record<number, FakeEntity> = { 1: self };
  for (const target of targets) entities[target.id] = target;

  const attackTimes: number[] = [];
  const onAttack: { hook?: (count: number, entity: FakeEntity) => void } = {};
  const pathfinder: { goal: unknown; setGoal: sinon.SinonSpy; stop: sinon.SinonStub } = {
    goal: null,
    setGoal: sinon.spy((goal: unknown) => { pathfinder.goal = goal; }),
    stop: sinon.stub()
  };

  const bot = Object.assign(new EventEmitter(), {
    registry,
    entity: self,
    entities,
    players: {},
    health: 20,
    heldItem: null as FakeItem | null,
    inventory: { items: () => inventory },
    pathfinder,
    clearControlStates: sinon.stub(),
    lookAt: sinon.stub().resolves(),
    equip: sinon.stub(),
    attack: sinon.spy((entity: FakeEntity) => {
      attackTimes.push(Date.now());
      onAttack.hook?.(attackTimes.length, entity);
    })
  });
  bot.equip.callsFake(async (stack: FakeItem) => { bot.heldItem = stack; });

  return { bot, self, entities, pathfinder, attackTimes, onAttack };
}

type Fake = ReturnType<typeof fakeBot>;

/** Starts a fight with a fake clock installed first; the teardown aborts it so no test can hang another. */
function startFight(t: ExecutionContext, fake: Fake, target: FakeEntity, options: EngageOptions = {}) {
  const clock = sinon.useFakeTimers();
  const controller = new AbortController();
  const signal = options.signal ?? controller.signal;
  t.teardown(() => {
    controller.abort();
    clock.restore();
  });
  const state: { result?: CombatResult } = {};
  const promise = engage(fake.bot as never, target as never, { ...options, signal }).then(result => {
    state.result = result;
    return result;
  });
  return { clock, controller, state, promise };
}

/** Advances the fake clock tick by tick until the fight ends; fails instead of hanging. */
async function runFight(t: ExecutionContext, fight: ReturnType<typeof startFight>, maxMs = 20000): Promise<CombatResult> {
  for (let elapsed = 0; elapsed <= maxMs && !fight.state.result; elapsed += TICK) {
    await fight.clock.tickAsync(TICK);
  }
  if (!fight.state.result) {
    t.fail(`engage did not end within ${maxMs}ms`);
    throw new Error('engage did not end');
  }
  return fight.state.result;
}

/** F-011 success meaning: no leftover pathfinding goal or control state when the fight ends. */
function assertClean(t: ExecutionContext, fake: Fake) {
  t.is(fake.pathfinder.goal, null, 'no pathfinder goal is left');
  t.true(fake.pathfinder.setGoal.calledWith(null), 'the pathfinder goal is cleared');
  t.true(fake.pathfinder.stop.called, 'the pathfinder is stopped');
  t.true(fake.bot.clearControlStates.called, 'control states are cleared');
}

/**
 * A cancelled fight (pause, abort or shouldStop) does not touch the body: after a pause it belongs to a manual
 * command or reflex already, and a cancelled task is stopped by the task manager (BLUEPRINT F-011, G1, G4).
 */
function assertBodyLeftAlone(t: ExecutionContext, fake: Fake) {
  t.false(fake.pathfinder.setGoal.calledWith(null), 'the pathfinder goal is not cleared by combat');
  t.false(fake.pathfinder.stop.called, 'the pathfinder is not stopped by combat');
  t.false(fake.bot.clearControlStates.called, 'control states are not cleared by combat');
}

function followGoalWasSet(fake: Fake): boolean {
  return fake.pathfinder.setGoal.getCalls().some(call => call.args[0] !== null);
}

function gaps(times: number[]): number[] {
  return times.slice(1).map((time, i) => time - times[i]);
}

// --- weapon table ---------------------------------------------------------------------------------------------

test('attackCooldownMs: swords about 0.625s, bare hand 0.25s, whole ticks, axes slower than swords', (t) => {
  const sword = attackCooldownMs('diamond_sword');
  t.true(sword >= 625 && sword <= 700, `sword cooldown ${sword}ms should be about 625ms`);
  for (const material of ['wooden', 'stone', 'iron', 'golden', 'netherite']) {
    t.is(attackCooldownMs(`${material}_sword`), sword, `${material}_sword shares the sword cooldown`);
  }
  t.is(attackCooldownMs(undefined), 250);
  t.is(attackCooldownMs('dirt'), 250, 'a non-weapon hits like a bare hand');
  for (const name of ['wooden_axe', 'iron_axe', 'diamond_axe', 'netherite_axe']) {
    t.true(attackCooldownMs(name) > sword, `${name} is slower than a sword`);
  }
  for (const name of [undefined, 'dirt', 'iron_sword', 'iron_axe', 'wooden_axe', 'trident']) {
    t.is(attackCooldownMs(name) % TICK, 0, `${String(name)} cooldown is a whole number of ticks`);
    t.true(attackCooldownMs(name) >= 1000 / weaponStats(name).speed, `${String(name)} cooldown is not shorter than the vanilla one`);
  }
});

test('weaponStats: vanilla sword damage and bare hand fallback', (t) => {
  t.deepEqual(weaponStats(undefined), { damage: 1, speed: 4 });
  t.deepEqual(weaponStats('stick'), weaponStats(undefined));
  t.is(weaponStats('wooden_sword').damage, 4);
  t.is(weaponStats('stone_sword').damage, 5);
  t.is(weaponStats('iron_sword').damage, 6);
  t.is(weaponStats('diamond_sword').damage, 7);
  t.is(weaponStats('netherite_sword').damage, 8);
  t.is(weaponStats('diamond_sword').speed, 1.6);
  t.true(weaponStats('iron_axe').damage > weaponStats('iron_sword').damage, 'axes hit harder');
  t.true(weaponStats('iron_axe').speed < weaponStats('iron_sword').speed, 'axes swing slower');
});

// --- equipBestWeapon -------------------------------------------------------------------------------------------

test('equipBestWeapon prefers a diamond sword over an iron axe', async (t) => {
  const fake = fakeBot([], [item('dirt'), item('iron_axe'), item('diamond_sword')]);
  await equipBestWeapon(fake.bot as never);
  t.true(fake.bot.equip.calledOnce);
  t.is(fake.bot.equip.firstCall.args[0].name, 'diamond_sword');
  t.is(fake.bot.equip.firstCall.args[1], 'hand');
});

test('equipBestWeapon takes an iron axe over an empty hand', async (t) => {
  const fake = fakeBot([], [item('dirt'), item('iron_axe')]);
  await equipBestWeapon(fake.bot as never);
  t.true(fake.bot.equip.calledOnce);
  t.is(fake.bot.equip.firstCall.args[0].name, 'iron_axe');
});

test('equipBestWeapon leaves the hand alone without a weapon', async (t) => {
  const fake = fakeBot([], [item('dirt'), item('bread')]);
  await equipBestWeapon(fake.bot as never);
  t.false(fake.bot.equip.called);
});

test('equipBestWeapon does not throw when equipping fails', async (t) => {
  const fake = fakeBot([], [item('diamond_sword')]);
  fake.bot.equip.rejects(new Error('inventory busy'));
  await t.notThrowsAsync(() => equipBestWeapon(fake.bot as never));
});

// --- killed ----------------------------------------------------------------------------------------------------

test.serial('a target in reach that becomes invalid after a few hits is killed; sword hits are a cooldown apart', async (t) => {
  const zombie = mob(2, 'zombie', 2);
  const fake = fakeBot([zombie], [item('diamond_sword')]);
  fake.onAttack.hook = (count) => { if (count === 4) zombie.isValid = false; };

  const fight = startFight(t, fake, zombie);
  const result = await runFight(t, fight);

  t.is(result.outcome, 'killed');
  t.is(result.attacks, 4);
  t.is(fake.bot.attack.callCount, 4);
  t.is(fake.bot.heldItem?.name, 'diamond_sword', 'the best weapon was equipped');
  t.true(fake.bot.attack.alwaysCalledWith(zombie));
  const cooldown = attackCooldownMs('diamond_sword');
  for (const gap of gaps(fake.attackTimes)) {
    t.true(gap >= 625, `gap ${gap}ms is shorter than the sword cooldown of about 625ms`);
    t.true(gap >= cooldown, `gap ${gap}ms is shorter than attackCooldownMs ${cooldown}`);
    t.true(gap <= cooldown + 100, `gap ${gap}ms: the bot should hit again as soon as the cooldown allows`);
  }
  const elapsed = Date.now();
  t.true(Math.abs(result.durationMs - elapsed) <= TICK, `durationMs ${result.durationMs} vs elapsed ${elapsed}`);
  t.true(result.lastPosition.equals(new Vec3(2, 64, 0)));
  assertClean(t, fake);
});

test.serial('bare-handed hits are at least 250ms apart', async (t) => {
  const zombie = mob(2, 'zombie', 2);
  const fake = fakeBot([zombie]);
  fake.onAttack.hook = (count) => { if (count === 5) delete fake.entities[2]; };

  const result = await runFight(t, startFight(t, fake, zombie));

  t.is(result.outcome, 'killed');
  t.is(result.attacks, 5);
  t.false(fake.bot.equip.called);
  for (const gap of gaps(fake.attackTimes)) {
    t.true(gap >= 250, `gap ${gap}ms is shorter than the bare-hand cooldown`);
    t.true(gap <= 350, `gap ${gap}ms: the bot should hit again as soon as the cooldown allows`);
  }
  assertClean(t, fake);
});

test.serial('a failed equip still fights bare-handed', async (t) => {
  const zombie = mob(2, 'zombie', 2);
  const fake = fakeBot([zombie], [item('diamond_sword')]);
  fake.bot.equip.rejects(new Error('inventory busy'));
  fake.onAttack.hook = (count) => { if (count === 3) zombie.isValid = false; };

  const result = await runFight(t, startFight(t, fake, zombie));

  t.true(fake.bot.equip.called, 'it tried to equip the sword');
  t.is(result.outcome, 'killed');
  t.is(result.attacks, 3);
  for (const gap of gaps(fake.attackTimes)) t.true(gap >= 250, `gap ${gap}ms`);
  assertClean(t, fake);
});

test.serial('an entityDead event for the target counts as a kill even when it vanished far away', async (t) => {
  const zombie = mob(2, 'zombie', 10);
  const fake = fakeBot([zombie]);
  const fight = startFight(t, fake, zombie);

  await fight.clock.tickAsync(500);
  t.true(followGoalWasSet(fake), 'it chases the target first');
  fake.bot.emit('entityDead', zombie);
  delete fake.entities[2];
  const result = await runFight(t, fight);

  t.is(result.outcome, 'killed');
  t.is(result.attacks, 0);
  assertClean(t, fake);
});

// --- lost ------------------------------------------------------------------------------------------------------

test.serial('a target that vanishes far away without a death event or recent hits is lost', async (t) => {
  const zombie = mob(2, 'zombie', 10);
  const fake = fakeBot([zombie]);
  const fight = startFight(t, fake, zombie);

  await fight.clock.tickAsync(500);
  fake.bot.emit('entityDead', mob(3, 'zombie', 12));
  delete fake.entities[2];
  const result = await runFight(t, fight);

  t.is(result.outcome, 'lost', 'another entity dying is not this target dying');
  t.is(result.attacks, 0);
  t.true(followGoalWasSet(fake));
  assertClean(t, fake);
});

test.serial('no progress towards the target for more than 5 seconds is lost', async (t) => {
  const zombie = mob(2, 'zombie', 8);
  const fake = fakeBot([zombie]);
  const fight = startFight(t, fake, zombie);

  await fight.clock.tickAsync(4500);
  t.is(fight.state.result, undefined, 'still trying after 4.5s');
  const result = await runFight(t, fight, 3000);

  t.is(result.outcome, 'lost');
  t.true(Date.now() > 5000 && Date.now() <= 6000, `gave up at ${Date.now()}ms`);
  t.true(followGoalWasSet(fake));
  assertClean(t, fake);
});

test.serial('steady approach does not count as being stuck', async (t) => {
  const zombie = mob(2, 'zombie', 15);
  const fake = fakeBot([zombie]);
  const fight = startFight(t, fake, zombie);

  for (let second = 1; second <= 8; second++) {
    await fight.clock.tickAsync(1000);
    fake.self.position = new Vec3(second, 64, 0);
  }
  await fight.clock.tickAsync(500);
  t.is(fight.state.result, undefined, 'still chasing after 8.5s of progress');
  fight.controller.abort();
  const result = await runFight(t, fight, 500);
  t.is(result.outcome, 'cancelled');
});

// --- out of range ----------------------------------------------------------------------------------------------

test.serial('a target that runs further than maxChase from the start ends as out_of_range', async (t) => {
  const zombie = mob(2, 'zombie', 8);
  const fake = fakeBot([zombie]);
  const fight = startFight(t, fake, zombie, { maxChase: 10 });

  await fight.clock.tickAsync(500);
  t.is(fight.state.result, undefined, '8 blocks is within the chase distance');
  t.true(followGoalWasSet(fake));
  zombie.position = new Vec3(12, 64, 0);
  const result = await runFight(t, fight, 1000);

  t.is(result.outcome, 'out_of_range');
  t.is(result.attacks, 0);
  assertClean(t, fake);
});

test.serial('the chase distance is measured from the anchor', async (t) => {
  const zombie = mob(2, 'zombie', 2);
  const fake = fakeBot([zombie]);
  const post = new Vec3(-20, 64, 0);

  const result = await runFight(t, startFight(t, fake, zombie, { maxChase: 16, anchor: () => post }));

  t.is(result.outcome, 'out_of_range', 'the target is 22 blocks from the post even though it is in reach');
  t.is(result.attacks, 0);
  assertClean(t, fake);
});

test.serial('a target out of reach gets a dynamic GoalFollow on it', async (t) => {
  const zombie = mob(2, 'zombie', 8);
  const fake = fakeBot([zombie]);
  const fight = startFight(t, fake, zombie);

  await fight.clock.tickAsync(300);
  const call = fake.pathfinder.setGoal.getCalls().find(c => c.args[0] !== null);
  t.truthy(call, 'a goal was set');
  const [goal, dynamic] = call!.args;
  t.true(goal instanceof goals.GoalFollow);
  t.is(goal.entity, zombie);
  t.true(dynamic, 'the goal follows the moving target');
  t.false(fake.bot.attack.called, 'nothing is hit from 8 blocks away');

  fight.controller.abort();
  const result = await runFight(t, fight, 500);
  t.is(result.outcome, 'cancelled');
  assertBodyLeftAlone(t, fake);
});

// --- retreated -------------------------------------------------------------------------------------------------

test.serial('health dropping to the retreat threshold ends the fight as retreated', async (t) => {
  const zombie = mob(2, 'zombie', 2);
  const fake = fakeBot([zombie]);
  fake.onAttack.hook = (count) => { if (count === 2) fake.bot.health = 6; };

  const result = await runFight(t, startFight(t, fake, zombie, { retreatHealth: 6 }));

  t.is(result.outcome, 'retreated');
  t.is(result.attacks, 2, 'no hit after health reached the threshold');
  t.is(fake.bot.attack.callCount, 2);
  assertClean(t, fake);
});

test.serial('health one above the retreat threshold keeps fighting', async (t) => {
  const zombie = mob(2, 'zombie', 2);
  const fake = fakeBot([zombie]);
  fake.onAttack.hook = (count) => {
    if (count === 1) fake.bot.health = 7;
    if (count === 3) zombie.isValid = false;
  };

  const result = await runFight(t, startFight(t, fake, zombie, { retreatHealth: 6 }));

  t.is(result.outcome, 'killed');
  t.is(result.attacks, 3);
  assertClean(t, fake);
});

// --- illegal targets (invariant I1) ----------------------------------------------------------------------------

test.serial('a player is an illegal target: no hit and no movement', async (t) => {
  const steve = player(5, 'Steve', 2);
  const fake = fakeBot([steve], [item('diamond_sword')]);

  const result = await runFight(t, startFight(t, fake, steve));

  t.is(result.outcome, 'illegal_target');
  t.is(result.attacks, 0);
  t.false(fake.bot.attack.called);
  t.false(followGoalWasSet(fake), 'the bot never moved towards the player');
  assertClean(t, fake);
});

test.serial('a player is still illegal when attackPlayers is explicitly false', async (t) => {
  const steve = player(5, 'Steve', 2);
  const fake = fakeBot([steve]);

  const result = await runFight(t, startFight(t, fake, steve, { rules: { attackPlayers: false, allowTypes: ['player'] } }));

  t.is(result.outcome, 'illegal_target');
  t.is(result.attacks, 0);
  t.false(fake.bot.attack.called);
});

test.serial('attackPlayers: true allows fighting a player', async (t) => {
  const steve = player(5, 'Steve', 2);
  const fake = fakeBot([steve]);
  fake.onAttack.hook = (count) => { if (count === 2) steve.isValid = false; };

  const result = await runFight(t, startFight(t, fake, steve, { rules: { attackPlayers: true } }));

  t.is(result.outcome, 'killed');
  t.is(result.attacks, 2);
  t.true(fake.bot.attack.alwaysCalledWith(steve));
  assertClean(t, fake);
});

test.serial('a passive mob that was not named explicitly is an illegal target', async (t) => {
  const cow = mob(3, 'cow', 2, 'animal');
  const fake = fakeBot([cow]);

  const result = await runFight(t, startFight(t, fake, cow));

  t.is(result.outcome, 'illegal_target');
  t.is(result.attacks, 0);
  t.false(fake.bot.attack.called);
});

test.serial('a tamed wolf is illegal even when wolves are named explicitly', async (t) => {
  const wolf = mob(4, 'wolf', 2, 'animal');
  wolf.metadata[metadataIndex('wolf', 'owneruuid')] = '7f1c2d3e-0000-4000-8000-000000000001';
  const fake = fakeBot([wolf]);

  const result = await runFight(t, startFight(t, fake, wolf, { rules: { allowTypes: ['wolf'] } }));

  t.is(result.outcome, 'illegal_target');
  t.is(result.attacks, 0);
  t.false(fake.bot.attack.called);
});

test.serial('a target that becomes tamed mid-fight ends the fight as illegal_target at once', async (t) => {
  const wolf = mob(4, 'wolf', 2, 'animal');
  const fake = fakeBot([wolf]);
  fake.onAttack.hook = (count, entity) => {
    if (count === 1) entity.metadata[metadataIndex('wolf', 'owneruuid')] = '7f1c2d3e-0000-4000-8000-000000000001';
  };

  const result = await runFight(t, startFight(t, fake, wolf, { rules: { allowTypes: ['wolf'] } }));

  t.is(result.outcome, 'illegal_target');
  t.is(result.attacks, 1, 'no hit after the wolf was tamed');
  t.is(fake.bot.attack.callCount, 1);
  t.true(Date.now() <= 2 * TICK, `ended at ${Date.now()}ms instead of right away`);
  assertClean(t, fake);
});

// --- cancelled -------------------------------------------------------------------------------------------------

test.serial('an abort signal stops the fight within a tick and leaves the body to its new owner', async (t) => {
  const zombie = mob(2, 'zombie', 8);
  const fake = fakeBot([zombie]);
  const fight = startFight(t, fake, zombie);

  await fight.clock.tickAsync(400);
  t.true(followGoalWasSet(fake));
  t.not(fake.pathfinder.goal, null);
  fight.controller.abort();
  await fight.clock.tickAsync(TICK);

  t.truthy(fight.state.result, 'ended within one tick of the abort');
  t.is(fight.state.result?.outcome, 'cancelled');
  assertBodyLeftAlone(t, fake);
});

test.serial('no hit lands after an abort between hits', async (t) => {
  const zombie = mob(2, 'zombie', 2);
  const fake = fakeBot([zombie], [item('diamond_sword')]);
  const fight = startFight(t, fake, zombie);

  await fight.clock.tickAsync(700);
  const hits = fake.bot.attack.callCount;
  t.true(hits >= 1);
  fight.controller.abort();
  await fight.clock.tickAsync(TICK);
  t.is(fight.state.result?.outcome, 'cancelled');
  await fight.clock.tickAsync(2000);
  t.is(fake.bot.attack.callCount, hits, 'no hit after the abort');
  t.is(fight.state.result?.attacks, hits);
  assertBodyLeftAlone(t, fake);
});

test.serial('an already aborted signal ends as cancelled without a hit', async (t) => {
  const zombie = mob(2, 'zombie', 2);
  const fake = fakeBot([zombie]);
  const controller = new AbortController();
  controller.abort();

  const result = await runFight(t, startFight(t, fake, zombie, { signal: controller.signal }), 200);

  t.is(result.outcome, 'cancelled');
  t.is(result.attacks, 0);
  t.false(fake.bot.attack.called);
  assertBodyLeftAlone(t, fake);
});

test.serial('shouldStop returning true ends the fight as cancelled', async (t) => {
  const zombie = mob(2, 'zombie', 8);
  const fake = fakeBot([zombie]);
  let paused = false;
  const fight = startFight(t, fake, zombie, { shouldStop: () => paused });

  await fight.clock.tickAsync(400);
  t.is(fight.state.result, undefined);
  t.true(followGoalWasSet(fake));
  paused = true;
  await fight.clock.tickAsync(TICK);

  t.is(fight.state.result?.outcome, 'cancelled');
  assertBodyLeftAlone(t, fake);
});

// --- sword sweep safety (F-011: no sword next to a player, a pet or a neutral mob) -------------------------------

// One block beside the zombie at (2, 64, 0) and about 2.24 blocks from the bot: a sword sweep would hit it.
const BESIDE = new Vec3(2, 64, 1);
// Far from both the target and the bot.
const AWAY = new Vec3(-6, 64, 6);

type HandSwitch = { at: number; to: string | undefined };
type HitRecord = { at: number; held: string | undefined; beside: boolean };

/**
 * Logs every real change of the held item (equip or unequip) and every hit with the item held at that moment and
 * whether a bystander stood next to the target. Each hit is answered with an entityHurt event, like a real server.
 */
function trackHands(fake: Fake, besideNow: () => boolean) {
  const switches: HandSwitch[] = [];
  const hits: HitRecord[] = [];
  const unequip = sinon.stub().callsFake(async (_slot: string) => {
    if (fake.bot.heldItem) switches.push({ at: Date.now(), to: undefined });
    fake.bot.heldItem = null;
  });
  Object.assign(fake.bot, { unequip });
  fake.bot.equip.callsFake(async (stack: FakeItem) => {
    if (fake.bot.heldItem?.name !== stack.name) switches.push({ at: Date.now(), to: stack.name });
    fake.bot.heldItem = stack;
  });
  const extra: { hook?: (count: number, entity: FakeEntity) => void } = {};
  fake.onAttack.hook = (count, entity) => {
    hits.push({ at: Date.now(), held: fake.bot.heldItem?.name, beside: besideNow() });
    fake.bot.emit('entityHurt', entity);
    extra.hook?.(count, entity);
  };
  return { switches, hits, unequip, extra };
}

function assertNoSwordNextToBystander(t: ExecutionContext, hits: HitRecord[]) {
  for (const hit of hits) {
    t.false(isSword(hit.held) && hit.beside, `hit at ${hit.at}ms with ${String(hit.held)} while a bystander stood beside the target`);
  }
}

/** After each item switch, the next hit waits at least the full cooldown of the new item. */
function assertFullCooldownAfterSwitches(t: ExecutionContext, switches: HandSwitch[], hits: HitRecord[]) {
  for (const change of switches) {
    const next = hits.find(hit => hit.at >= change.at);
    if (!next) continue;
    const needed = attackCooldownMs(change.to);
    t.true(next.at - change.at >= needed,
      `switched to ${String(change.to)} at ${change.at}ms but hit at ${next.at}ms (cooldown ${needed}ms)`);
  }
}

/** Consecutive hits are at least the cooldown of the item used for the later hit apart. */
function assertHitGaps(t: ExecutionContext, hits: HitRecord[]) {
  for (let i = 1; i < hits.length; i++) {
    const gap = hits[i].at - hits[i - 1].at;
    const needed = attackCooldownMs(hits[i].held);
    t.true(gap >= needed, `gap ${gap}ms before a ${String(hits[i].held)} hit is shorter than ${needed}ms`);
  }
}

test('sweepBystanders: a player or a tamed wolf beside the target counts, a hostile zombie or a far player does not', (t) => {
  const zombie = mob(2, 'zombie', 2);
  const alex = player(6, 'Alex', 0);
  alex.position = BESIDE.clone();
  const wolf = mob(7, 'wolf', 0, 'animal');
  wolf.position = new Vec3(2, 64, -1);
  wolf.metadata[metadataIndex('wolf', 'owneruuid')] = '7f1c2d3e-0000-4000-8000-000000000001';
  const other = mob(8, 'zombie', 0);
  other.position = new Vec3(2.8, 64, 0.8);
  const far = player(9, 'Sam', 0);
  far.position = AWAY.clone();
  const fake = fakeBot([zombie, alex, wolf, other, far]);

  const ids = sweepBystanders(fake.bot as never, zombie as never).map(entity => entity.id).sort();
  t.deepEqual(ids, [6, 7]);
});

test.serial('a player beside the target: the bot swaps the sword for the axe, and uses the sword again once the player leaves', async (t) => {
  const zombie = mob(2, 'zombie', 2);
  const alex = player(6, 'Alex', 0);
  alex.position = BESIDE.clone();
  const sword = item('diamond_sword');
  const fake = fakeBot([zombie, alex], [sword, item('iron_axe')]);
  fake.bot.heldItem = sword;
  let beside = true;
  const log = trackHands(fake, () => beside);

  const fight = startFight(t, fake, zombie);
  await fight.clock.tickAsync(3000);

  const axeEquip = fake.bot.equip.getCalls().find(call => call.args[0].name === 'iron_axe');
  t.truthy(axeEquip, 'the axe was equipped');
  t.true(fake.bot.attack.called, 'the bot still fights');
  t.true(axeEquip!.calledBefore(fake.bot.attack.firstCall), 'the axe is in hand before the first hit');
  const phaseOne = log.hits.length;
  t.true(phaseOne >= 2, `${phaseOne} hits in 3s with the axe`);
  t.true(log.hits.every(hit => hit.held === 'iron_axe'), 'every hit next to the player uses the axe');

  alex.position = AWAY.clone();
  beside = false;
  await fight.clock.tickAsync(3000);
  const phaseTwo = log.hits.slice(phaseOne);
  t.true(phaseTwo.some(hit => hit.held === 'diamond_sword'), 'the sword is used again once the player left');

  const beforeReturn = log.hits.length;
  alex.position = BESIDE.clone();
  beside = true;
  await fight.clock.tickAsync(3000);
  const phaseThree = log.hits.slice(beforeReturn);
  t.true(phaseThree.length >= 1, 'the bot keeps fighting after the player came back');
  t.true(phaseThree.every(hit => !isSword(hit.held)), 'no sword hit after the player came back');

  zombie.isValid = false;
  const result = await runFight(t, fight, 2000);
  t.is(result.outcome, 'killed');
  t.is(result.attacks, log.hits.length);
  assertNoSwordNextToBystander(t, log.hits);
  t.deepEqual(log.switches.map(change => change.to), ['iron_axe', 'diamond_sword', 'iron_axe']);
  // The swap made before the first hit is checked by its own test below.
  assertFullCooldownAfterSwitches(t, log.switches.slice(1), log.hits);
  assertHitGaps(t, log.hits.slice(1));
  assertClean(t, fake);
});

// F-011: "换手中物品后等待一个完整冷却" also applies to the swap made before the first hit.
test.serial('the first hit after the swap made before the fight waits a full axe cooldown', async (t) => {
  const zombie = mob(2, 'zombie', 2);
  const alex = player(6, 'Alex', 0);
  alex.position = BESIDE.clone();
  const sword = item('diamond_sword');
  const fake = fakeBot([zombie, alex], [sword, item('iron_axe')]);
  fake.bot.heldItem = sword;
  const log = trackHands(fake, () => true);

  const fight = startFight(t, fake, zombie);
  await fight.clock.tickAsync(3000);

  t.is(log.switches[0]?.to, 'iron_axe');
  t.true(log.hits.length >= 1);
  assertFullCooldownAfterSwitches(t, log.switches, log.hits);
});

// Drawing the sword from an empty hand at the start of a fight is an item switch too.
test.serial('the first hit after drawing the sword at the start waits a full sword cooldown', async (t) => {
  const zombie = mob(2, 'zombie', 2);
  const fake = fakeBot([zombie], [item('diamond_sword')]);
  const log = trackHands(fake, () => false);

  const fight = startFight(t, fake, zombie);
  await fight.clock.tickAsync(2000);

  t.is(log.switches[0]?.to, 'diamond_sword');
  t.true(log.hits.length >= 1);
  assertFullCooldownAfterSwitches(t, log.switches, log.hits);
});

test.serial('a tamed wolf beside the target: the bot fights with the axe, never the sword', async (t) => {
  const zombie = mob(2, 'zombie', 2);
  const wolf = mob(7, 'wolf', 0, 'animal');
  wolf.position = BESIDE.clone();
  wolf.metadata[metadataIndex('wolf', 'owneruuid')] = '7f1c2d3e-0000-4000-8000-000000000001';
  const fake = fakeBot([zombie, wolf], [item('diamond_sword'), item('iron_axe')]);
  const log = trackHands(fake, () => true);
  log.extra.hook = (count) => { if (count === 3) zombie.isValid = false; };

  const result = await runFight(t, startFight(t, fake, zombie));

  t.is(result.outcome, 'killed');
  t.is(result.attacks, 3);
  t.true(log.hits.every(hit => hit.held === 'iron_axe'), `hits with ${log.hits.map(hit => hit.held).join(', ')}`);
  t.false(fake.bot.equip.getCalls().some(call => isSword(call.args[0].name)), 'the sword is never drawn');
  assertHitGaps(t, log.hits);
  assertClean(t, fake);
});

test.serial('only a sword: a player stepping beside the target makes the bot put the sword away and fight bare-handed', async (t) => {
  const zombie = mob(2, 'zombie', 2);
  const alex = player(6, 'Alex', 0);
  alex.position = AWAY.clone();
  const fake = fakeBot([zombie, alex], [item('diamond_sword')]);
  let beside = false;
  const log = trackHands(fake, () => beside);

  const fight = startFight(t, fake, zombie);
  await fight.clock.tickAsync(2000);
  const swordHits = log.hits.length;
  t.true(swordHits >= 2, `${swordHits} sword hits before the player came`);
  t.true(log.hits.every(hit => hit.held === 'diamond_sword'));
  t.false(log.unequip.called);

  alex.position = BESIDE.clone();
  beside = true;
  await fight.clock.tickAsync(2000);

  t.true(log.unequip.calledWith('hand'), 'the sword was put away');
  const later = log.hits.slice(swordHits);
  t.true(later.length >= 2, `${later.length} hits after the player came`);
  t.true(log.unequip.firstCall.calledBefore(fake.bot.attack.getCall(swordHits)), 'the sword is put away before the next hit');
  t.true(later.every(hit => hit.held === undefined), 'bare-handed next to the player');
  const putAway = log.switches.find(change => change.to === undefined);
  t.truthy(putAway);
  t.true(later[0].at - putAway!.at >= attackCooldownMs(undefined),
    `put away at ${putAway!.at}ms, next hit at ${later[0].at}ms`);

  zombie.isValid = false;
  const result = await runFight(t, fight, 2000);
  t.is(result.outcome, 'killed');
  assertNoSwordNextToBystander(t, log.hits);
  assertHitGaps(t, log.hits);
  assertClean(t, fake);
});

test.serial('only a sword held and a player already beside the target: unequip comes before the first hit', async (t) => {
  const zombie = mob(2, 'zombie', 2);
  const alex = player(6, 'Alex', 0);
  alex.position = BESIDE.clone();
  const sword = item('diamond_sword');
  const fake = fakeBot([zombie, alex], [sword]);
  fake.bot.heldItem = sword;
  const log = trackHands(fake, () => true);
  log.extra.hook = (count) => { if (count === 3) zombie.isValid = false; };

  const result = await runFight(t, startFight(t, fake, zombie));

  t.is(result.outcome, 'killed');
  t.true(log.unequip.calledWith('hand'));
  t.true(log.unequip.firstCall.calledBefore(fake.bot.attack.firstCall));
  t.true(log.hits.every(hit => hit.held === undefined), `hits with ${log.hits.map(hit => String(hit.held)).join(', ')}`);
  assertClean(t, fake);
});

test.serial('a sword that cannot be put away: the bot holds fire while the player stays, and hits once the player leaves', async (t) => {
  const zombie = mob(2, 'zombie', 2);
  const alex = player(6, 'Alex', 0);
  alex.position = BESIDE.clone();
  const sword = item('diamond_sword');
  const fake = fakeBot([zombie, alex], [sword]);
  fake.bot.heldItem = sword;
  let beside = true;
  const log = trackHands(fake, () => beside);
  const unequip = sinon.stub().rejects(new Error('inventory busy'));
  Object.assign(fake.bot, { unequip });

  const fight = startFight(t, fake, zombie);
  await fight.clock.tickAsync(3000);

  t.true(unequip.calledWith('hand'), 'it tried to put the sword away');
  t.is(fake.bot.heldItem?.name, 'diamond_sword');
  t.false(fake.bot.attack.called, 'no sword hit while the player stands beside the target');

  alex.position = AWAY.clone();
  beside = false;
  await fight.clock.tickAsync(1000);
  t.true(fake.bot.attack.called, 'the bot hits once the player left');
  t.true(log.hits.every(hit => hit.held === 'diamond_sword'));

  zombie.isValid = false;
  const result = await runFight(t, fight, 2000);
  t.is(result.outcome, 'killed');
  assertNoSwordNextToBystander(t, log.hits);
  assertClean(t, fake);
});

test.serial('a hostile mob beside the target does not stop the bot from using its sword', async (t) => {
  const zombie = mob(2, 'zombie', 2);
  const other = mob(3, 'zombie', 0);
  other.position = BESIDE.clone();
  const fake = fakeBot([zombie, other], [item('iron_axe'), item('diamond_sword')]);
  const log = trackHands(fake, () => false);
  log.extra.hook = (count) => { if (count === 3) zombie.isValid = false; };

  const result = await runFight(t, startFight(t, fake, zombie));

  t.is(result.outcome, 'killed');
  t.is(result.attacks, 3);
  t.true(log.hits.every(hit => hit.held === 'diamond_sword'), `hits with ${log.hits.map(hit => hit.held).join(', ')}`);
  t.false(fake.bot.equip.getCalls().some(call => call.args[0].name === 'iron_axe'), 'the axe is never drawn');
  t.false(log.unequip.called);
  t.true(fake.bot.attack.alwaysCalledWith(zombie), 'only the target is hit');
  assertClean(t, fake);
});

// --- targets that never get hurt -------------------------------------------------------------------------------

test.serial('10 seconds of hits without an entityHurt event for the target ends as lost', async (t) => {
  const zombie = mob(2, 'zombie', 2);
  const fake = fakeBot([zombie], [item('diamond_sword')]);
  const fight = startFight(t, fake, zombie);

  await fight.clock.tickAsync(9500);
  t.is(fight.state.result, undefined, 'still swinging after 9.5s');
  const result = await runFight(t, fight, 3000);

  t.is(result.outcome, 'lost');
  const swinging = Date.now() - fake.attackTimes[0];
  t.true(swinging >= 10000 && swinging <= 10000 + attackCooldownMs('diamond_sword'),
    `gave up ${swinging}ms after the first hit`);
  t.true(result.attacks >= 10, `${result.attacks} hits`);
  t.is(fake.bot.attack.callCount, result.attacks);
  assertClean(t, fake);
});

test.serial('entityHurt events for another entity do not keep the fight going', async (t) => {
  const zombie = mob(2, 'zombie', 2);
  const fake = fakeBot([zombie], [item('diamond_sword')]);
  fake.onAttack.hook = () => { fake.bot.emit('entityHurt', mob(9, 'zombie', 5)); };

  const result = await runFight(t, startFight(t, fake, zombie), 15000);

  t.is(result.outcome, 'lost');
  const swinging = Date.now() - fake.attackTimes[0];
  t.true(swinging >= 10000 && swinging <= 10000 + attackCooldownMs('diamond_sword'),
    `gave up ${swinging}ms after the first hit`);
  assertClean(t, fake);
});

test.serial('a target that is hurt by every hit keeps being fought past 10 seconds', async (t) => {
  const zombie = mob(2, 'zombie', 2);
  const fake = fakeBot([zombie], [item('diamond_sword')]);
  fake.onAttack.hook = (_count, entity) => { fake.bot.emit('entityHurt', entity); };
  const fight = startFight(t, fake, zombie);

  await fight.clock.tickAsync(15000);
  t.is(fight.state.result, undefined, 'still fighting after 15s');
  t.true(fake.bot.attack.callCount >= 20, `${fake.bot.attack.callCount} hits in 15s`);

  zombie.isValid = false;
  const result = await runFight(t, fight, 1000);
  t.is(result.outcome, 'killed');
  assertClean(t, fake);
});

test.serial('the 10 seconds without damage count from the last entityHurt event', async (t) => {
  const zombie = mob(2, 'zombie', 2);
  const fake = fakeBot([zombie], [item('diamond_sword')]);
  let lastHurt = -1;
  fake.onAttack.hook = (count, entity) => {
    if (count <= 5) {
      lastHurt = Date.now();
      fake.bot.emit('entityHurt', entity);
    }
  };

  const result = await runFight(t, startFight(t, fake, zombie), 20000);

  t.is(result.outcome, 'lost');
  t.true(lastHurt > fake.attackTimes[0]);
  const sinceHurt = Date.now() - lastHurt;
  t.true(sinceHurt >= 10000 && sinceHurt <= 10000 + attackCooldownMs('diamond_sword'),
    `gave up ${sinceHurt}ms after the last hurt event`);
  assertClean(t, fake);
});

test.serial('a bot without event support never gives up for lack of hurt events', async (t) => {
  const zombie = mob(2, 'zombie', 2);
  const fake = fakeBot([zombie], [item('diamond_sword')]);
  Object.assign(fake.bot, { on: undefined, removeListener: undefined });
  const fight = startFight(t, fake, zombie);

  await fight.clock.tickAsync(15000);
  t.is(fight.state.result, undefined, 'still fighting after 15s');
  fight.controller.abort();
  const result = await runFight(t, fight, 500);
  t.is(result.outcome, 'cancelled');
});

// --- who owns the body when the fight ends ---------------------------------------------------------------------

test.serial('a pause in the middle of hitting ends as cancelled and leaves the body alone', async (t) => {
  const zombie = mob(2, 'zombie', 2);
  const fake = fakeBot([zombie], [item('diamond_sword')]);
  fake.onAttack.hook = (_count, entity) => { fake.bot.emit('entityHurt', entity); };
  let paused = false;
  const fight = startFight(t, fake, zombie, { shouldStop: () => paused });

  await fight.clock.tickAsync(1500);
  const hits = fake.bot.attack.callCount;
  t.true(hits >= 2);
  paused = true;
  await fight.clock.tickAsync(TICK);
  t.is(fight.state.result?.outcome, 'cancelled');
  await fight.clock.tickAsync(2000);
  t.is(fake.bot.attack.callCount, hits, 'no hit after the pause');
  assertBodyLeftAlone(t, fake);
});

test.serial('a pause while looking at the target: no hit and the body is left alone', async (t) => {
  const zombie = mob(2, 'zombie', 2);
  const fake = fakeBot([zombie], [item('diamond_sword')]);
  let paused = false;
  fake.bot.lookAt.callsFake(async () => { paused = true; });

  const result = await runFight(t, startFight(t, fake, zombie, { shouldStop: () => paused }), 1000);

  t.true(fake.bot.lookAt.called);
  t.is(result.outcome, 'cancelled');
  t.is(result.attacks, 0);
  t.false(fake.bot.attack.called);
  assertBodyLeftAlone(t, fake);
});

test.serial('a pause while switching weapons: no hit with the new weapon and the body is left alone', async (t) => {
  const zombie = mob(2, 'zombie', 2);
  const alex = player(6, 'Alex', 0);
  alex.position = AWAY.clone();
  const fake = fakeBot([zombie, alex], [item('diamond_sword'), item('iron_axe')]);
  fake.onAttack.hook = (_count, entity) => { fake.bot.emit('entityHurt', entity); };
  let paused = false;
  const fight = startFight(t, fake, zombie, { shouldStop: () => paused });

  await fight.clock.tickAsync(1500);
  const hits = fake.bot.attack.callCount;
  t.true(hits >= 1);
  t.is(fake.bot.heldItem?.name, 'diamond_sword');
  fake.bot.equip.callsFake(async (stack: FakeItem) => {
    paused = true;
    fake.bot.heldItem = stack;
  });
  alex.position = BESIDE.clone();
  await fight.clock.tickAsync(1000);

  t.true(fake.bot.equip.calledWith(sinon.match({ name: 'iron_axe' })), 'it started switching to the axe');
  t.is(fight.state.result?.outcome, 'cancelled');
  t.is(fake.bot.attack.callCount, hits, 'no hit with the new weapon after the pause');
  assertBodyLeftAlone(t, fake);
});

// --- second-round fixes: slime and magma cube size (fix B) -------------------------------------------------------

/** A slime at (2, 64, 0) with the base registry box (0.52 x 0.52) and the given 'size' metadata. */
function slime(id: number, size: number): FakeEntity & { width: number } {
  const entity = { ...mob(id, 'slime', 2), width: 0.52, height: 0.52 };
  entity.metadata[metadataIndex('slime', 'size')] = size;
  return entity;
}

// 2.0 blocks from the slime's centre along z and about 2.83 blocks from the bot at the origin.
const SLIME_NEIGHBOUR = new Vec3(2, 64, 2);

test('sweepBystanders: a player 2 blocks from a size-4 slime is in the sweep, but not next to a size-1 slime', (t) => {
  const big = slime(2, 4);
  const alex = player(6, 'Alex', 0);
  alex.position = SLIME_NEIGHBOUR.clone();
  const fake = fakeBot([big, alex]);
  t.deepEqual(sweepBystanders(fake.bot as never, big as never).map(entity => entity.id), [6],
    'a size-4 slime is 2.08 blocks wide, so the sweep reaches 2.04 blocks from its centre plus the player\'s half width');

  const small = slime(2, 1);
  const alex2 = player(6, 'Alex', 0);
  alex2.position = SLIME_NEIGHBOUR.clone();
  const fakeSmall = fakeBot([small, alex2]);
  t.deepEqual(sweepBystanders(fakeSmall.bot as never, small as never), [],
    'a size-1 slime is 0.52 blocks wide; a player 2 blocks away is out of the sweep');
});

test.serial('a player 2 blocks from a size-4 slime: the bot never hits the slime with a sword', async (t) => {
  const big = slime(2, 4);
  const alex = player(6, 'Alex', 0);
  alex.position = SLIME_NEIGHBOUR.clone();
  const fake = fakeBot([big, alex], [item('diamond_sword'), item('iron_axe')]);
  const log = trackHands(fake, () => true);
  log.extra.hook = (count) => { if (count === 3) big.isValid = false; };

  const result = await runFight(t, startFight(t, fake, big));

  t.is(result.outcome, 'killed');
  t.is(result.attacks, 3);
  t.true(log.hits.every(hit => !isSword(hit.held)), `hits with ${log.hits.map(hit => String(hit.held)).join(', ')}`);
  t.true(log.hits.every(hit => hit.held === 'iron_axe'), 'the axe is the best weapon that does not sweep');
  t.false(fake.bot.equip.getCalls().some(call => isSword(call.args[0].name)), 'the sword is never drawn');
  assertNoSwordNextToBystander(t, log.hits);
  assertClean(t, fake);
});

test.serial('the same player next to a size-1 slime does not keep the bot from using its sword', async (t) => {
  const small = slime(2, 1);
  const alex = player(6, 'Alex', 0);
  alex.position = SLIME_NEIGHBOUR.clone();
  const fake = fakeBot([small, alex], [item('diamond_sword'), item('iron_axe')]);
  const log = trackHands(fake, () => false);
  log.extra.hook = (count) => { if (count === 3) small.isValid = false; };

  const result = await runFight(t, startFight(t, fake, small));

  t.is(result.outcome, 'killed');
  t.true(log.hits.every(hit => hit.held === 'diamond_sword'), `hits with ${log.hits.map(hit => String(hit.held)).join(', ')}`);
  assertClean(t, fake);
});

// --- second-round fixes: the no-damage give-up and the last-moment sweep check (fix C) ----------------------------

test.serial('a target knocked out of reach after a hurting hit: a chase of more than 10 seconds is not given up as unhurt', async (t) => {
  const zombie = mob(2, 'zombie', 2);
  const fake = fakeBot([zombie], [item('diamond_sword')]);
  let knockedAt: number | undefined;
  fake.onAttack.hook = (count, entity) => {
    // Like a real server, the hurt event arrives a tick after the hit.
    setTimeout(() => fake.bot.emit('entityHurt', entity), TICK);
    if (count === 1) {
      knockedAt = Date.now();
      entity.position = new Vec3(16, 64, 0);
    }
    if (count === 3) entity.isValid = false;
  };
  const fight = startFight(t, fake, zombie, { maxChase: 30 });

  await fight.clock.tickAsync(1000);
  t.truthy(knockedAt, 'the first hit landed and knocked the zombie away');
  // The bot closes in by one block a second; the zombie is in reach again once the bot reaches x = 13.
  for (let x = 1; x <= 13; x++) {
    fake.self.position = new Vec3(x, 64, 0);
    await fight.clock.tickAsync(1000);
    if (x < 13) {
      t.is(fight.state.result, undefined, `still chasing at ${Date.now()}ms (bot at x=${x})`);
      t.is(fake.bot.attack.callCount, 1, 'no hit while out of reach');
    }
  }
  t.true(Date.now() - knockedAt! > 10000, `chased for ${Date.now() - knockedAt!}ms`);
  t.true(followGoalWasSet(fake), 'it chased the target');

  const result = await runFight(t, fight, 3000);
  t.is(result.outcome, 'killed', `ended as ${result.outcome}: ${result.detail}`);
  t.is(result.attacks, 3);
  assertClean(t, fake);
});

test.serial('a chase resets the 10 seconds without damage: they count again from the first hit after the chase', async (t) => {
  const zombie = mob(2, 'zombie', 2);
  const fake = fakeBot([zombie], [item('diamond_sword')]);
  let knockedAt: number | undefined;
  fake.onAttack.hook = (_count, entity) => {
    // Never hurt; the first hit after 8 seconds knocks the zombie 8 blocks further away.
    if (knockedAt === undefined && Date.now() >= 8000) {
      knockedAt = Date.now();
      entity.position = new Vec3(10, 64, 0);
    }
  };
  const fight = startFight(t, fake, zombie);

  await fight.clock.tickAsync(8000);
  for (let i = 0; i < 80 && !fight.state.result; i++) {
    await fight.clock.tickAsync(250);
    if (knockedAt !== undefined && fake.self.position.x < 7) {
      fake.self.position = new Vec3(fake.self.position.x + 0.5, 64, 0);
    }
  }
  t.truthy(knockedAt, 'the zombie was knocked away');
  const result = await runFight(t, fight, 15000);

  t.is(result.outcome, 'lost');
  const firstAfterChase = fake.attackTimes.find(time => time > knockedAt!);
  t.truthy(firstAfterChase, 'the bot hit again after the chase');
  t.true(Date.now() - fake.attackTimes[0] > 10000 + attackCooldownMs('diamond_sword'),
    `gave up ${Date.now() - fake.attackTimes[0]}ms after the very first hit, counting hits from before the chase`);
  const swinging = Date.now() - firstAfterChase!;
  t.true(swinging >= 10000 && swinging <= 10000 + attackCooldownMs('diamond_sword'),
    `gave up ${swinging}ms after the first hit after the chase`);
  assertClean(t, fake);
});

test.serial('a player stepping beside the target while the bot looks at it: no sword hit, the sword is put away first', async (t) => {
  const zombie = mob(2, 'zombie', 2);
  const alex = player(6, 'Alex', 0);
  alex.position = AWAY.clone();
  const sword = item('diamond_sword');
  const fake = fakeBot([zombie, alex], [sword]);
  fake.bot.heldItem = sword;
  let beside = false;
  const log = trackHands(fake, () => beside);
  log.extra.hook = (count) => { if (count === 2) zombie.isValid = false; };
  fake.bot.lookAt.callsFake(async () => {
    alex.position = BESIDE.clone();
    beside = true;
  });

  const result = await runFight(t, startFight(t, fake, zombie));

  t.is(result.outcome, 'killed');
  t.true(log.hits.length >= 1);
  assertNoSwordNextToBystander(t, log.hits);
  t.true(log.unequip.calledWith('hand'), 'the sword was put away');
  t.true(log.unequip.firstCall.calledBefore(fake.bot.attack.firstCall), 'the sword is put away before the first hit');
  t.true(log.hits.every(hit => hit.held === undefined), `hits with ${log.hits.map(hit => String(hit.held)).join(', ')}`);
  assertFullCooldownAfterSwitches(t, log.switches, log.hits);
  assertClean(t, fake);
});
