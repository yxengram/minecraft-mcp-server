// Contract: docs/BLUEPRINT.md F-025, verifying F-012 (src/autopilot/reflex-engine.ts) and F-013
// (src/autopilot/reflexes.ts), with G1 (priorities and the body), G3 (reflex event format), G4 (who stops the body)
// and the G6 invariants I1 and I6. Expected values come from the contracts, not from what the implementation prints.
import test, { ExecutionContext } from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import pathfinderPkg from 'mineflayer-pathfinder';
import { z } from 'zod';
import { AcquireResult, ActionArbiter, PRIORITY } from '../src/autopilot/action-arbiter.js';
import {
  ReflexDefinition, ReflexEngine, ReflexEngineOptions, ReflexName, ReflexRunContext, TriggerContext, TriggerResult
} from '../src/autopilot/reflex-engine.js';
import type { CombatJudgment, CombatSituation } from '../src/decisions/decision-hooks.js';
import { REFLEXES, runAway } from '../src/autopilot/reflexes.js';
import { engage } from '../src/autopilot/combat.js';
import { Policy, PolicyStore, PolicyUpdate } from '../src/autopilot/policy.js';
import { BehaviorDefinition, TaskManager, delay } from '../src/autopilot/task-manager.js';
import { EventStore } from '../src/event-store.js';

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
const ON_FIRE = 0x01;

/** G3: `<reflex>: <reason> → <result> (<seconds>s)`. */
const resultFormat = (name: string) => new RegExp(`^${name}: .+ → .+ \\(\\d+\\.\\ds\\)$`);

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
  /** Raw self metadata: index 0 is the shared flags byte (bit 0 = burning), index 1 the air supply in ticks. */
  selfMetadata?: unknown[];
}

function createWorld(options: WorldOptions = {}) {
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
    isValid: true, height: 1.8, width: 0.6, yaw: 0, pitch: 0, metadata: options.selfMetadata ?? []
  };
  const entities: Record<number, unknown> = { 1: self };
  for (const entity of options.entities ?? []) entities[entity.id] = entity;

  const controls: Record<string, boolean> = {};
  const inventory = options.inventory ?? [];
  const pathfinder = {
    goal: null as unknown,
    setGoal: sinon.spy((goal: unknown) => { pathfinder.goal = goal; }),
    stop: sinon.stub()
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
    inventory: { items: () => inventory },
    pathfinder,
    setControlState: sinon.spy((control: string, state: boolean) => { controls[control] = state; }),
    clearControlStates: sinon.spy(() => {
      for (const key of Object.keys(controls)) controls[key] = false;
    }),
    look: sinon.spy(async (yaw: number, pitch: number) => {
      self.yaw = yaw;
      self.pitch = pitch;
    }),
    lookAt: sinon.stub().resolves(),
    equip: sinon.stub(),
    unequip: sinon.stub().resolves(),
    // Eating takes a moment in the game; here it finishes at once unless a test makes it wait.
    consume: sinon.stub(),
    deactivateItem: sinon.stub(),
    attack: sinon.spy(),
    blockAt,
    findBlock: ({ matching, maxDistance = 16 }: { matching: (block: ReturnType<typeof blockAt>) => boolean; maxDistance?: number }) => {
      let best: ReturnType<typeof blockAt> | null = null;
      for (const key of blocks.keys()) {
        const [x, y, z] = key.split(',').map(Number);
        const block = blockAt(new Vec3(x, y, z));
        const distance = block.position.distanceTo(self.position);
        if (!matching(block) || distance > maxDistance) continue;
        if (!best || distance < best.position.distanceTo(self.position)) best = block;
      }
      return best;
    }
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

// ---- engine harness --------------------------------------------------------------------------------------------

function useClock(t: ExecutionContext) {
  const clock = sinon.useFakeTimers({ now: 1.7e12 });
  t.teardown(() => clock.restore());
  return clock;
}

function createEngine(
  t: ExecutionContext,
  world: World,
  reflexes: ReflexDefinition[] = REFLEXES,
  extra: Pick<ReflexEngineOptions, 'judgeCombat' | 'onDeath'> = {}
) {
  const { bot } = world;
  const events = new EventStore();
  // As in autopilot.ts: the arbiter stops the body whenever it hands it to someone else.
  const stopBody = sinon.spy(() => {
    bot.pathfinder.stop();
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
  });
  const arbiter = new ActionArbiter({ stopBody });
  const policy = new PolicyStore();
  const log = sinon.spy();
  const engine = new ReflexEngine({ bot: bot as never, arbiter, getPolicy: () => policy.get(), events, reflexes, log, ...extra });
  let loop: ReturnType<typeof setInterval> | undefined;
  t.teardown(() => {
    if (loop) clearInterval(loop);
    engine.stop('test finished');
  });

  return {
    engine,
    events,
    arbiter,
    policy,
    log,
    stopBody,
    holder: () => arbiter.holder(),
    reflexEvents: () => events.query({ types: ['reflex'], limit: 200 }).events.map(event => event.message),
    lastReflexEvent: (name: string) =>
      events.query({ types: ['reflex'], limit: 200 }).events.map(event => event.message).filter(message => message.startsWith(`${name}:`)).at(-1),
    taskEvents: () => events.query({ limit: 200 }).events.map(event => event.type).filter(type => type.startsWith('task_')),
    /** Runs the game loop like a real bot: every 50 ms one physics step, then a physicsTick for the engine. */
    startGame() {
      engine.start();
      loop = setInterval(() => {
        world.step();
        bot.emit('physicsTick');
      }, TICK);
    }
  };
}

function hitBy(engine: ReflexEngine, attacker: FakeEntity, type = 'mob_attack'): void {
  engine.noteDamage({ attackerId: attacker.id, type, time: Date.now() });
}

const POLICY_KEY: Record<ReflexName, keyof Policy['reflexes']> = {
  'creeper-evade': 'creeperEvade',
  'low-health-retreat': 'lowHealthRetreat',
  'self-defense': 'selfDefense',
  'auto-eat': 'autoEat'
};

interface Scripted {
  definition: ReflexDefinition;
  trigger: sinon.SinonSpy<[TriggerContext], TriggerResult>;
  run: sinon.SinonSpy<[ReflexRunContext], Promise<string>>;
  /** What the trigger returns on the next evaluation. */
  result: TriggerResult;
  /** When set, the trigger throws this instead. */
  throwing: Error | null;
  /** The abort signal of each run, in order. */
  signals: AbortSignal[];
  finish(text?: string): void;
  fail(error: Error): void;
}

/** A reflex whose trigger and run each test controls; it is switched on and off through the real policy. */
function scripted(
  name: ReflexName,
  priority: ReflexDefinition['priority'],
  options: { cooldownMs?: number; maxDurationMs?: number; result?: TriggerResult } = {}
): Scripted {
  let settle: { resolve: (text: string) => void; reject: (error: Error) => void } | null = null;
  const reflex: Scripted = {
    result: 'result' in options ? options.result ?? null : { fire: 'test reason' },
    throwing: null,
    signals: [],
    trigger: sinon.spy((_context: TriggerContext): TriggerResult => {
      if (reflex.throwing) throw reflex.throwing;
      return reflex.result;
    }),
    run: sinon.spy(({ signal }: ReflexRunContext) => new Promise<string>((resolve, reject) => {
      reflex.signals.push(signal);
      settle = { resolve, reject };
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })),
    definition: undefined as unknown as ReflexDefinition,
    finish: text => settle?.resolve(text ?? 'done'),
    fail: error => settle?.reject(error)
  };
  reflex.definition = {
    name,
    priority,
    cooldownMs: options.cooldownMs ?? 1000,
    maxDurationMs: options.maxDurationMs ?? 10000,
    enabled: policy => policy.reflexes[POLICY_KEY[name]].enabled,
    trigger: reflex.trigger,
    run: reflex.run
  };
  return reflex;
}

// A task that just keeps the body until it is cancelled, honouring pauses.
const idleBehavior: BehaviorDefinition<{ label: string }, undefined> = {
  name: 'idle',
  description: 'waits until cancelled',
  schema: z.object({ label: z.string().default('idle') }),
  summarize: params => params.label,
  async run({ signal, isPaused, waitUntilRunning }) {
    for (;;) {
      if (isPaused()) await waitUntilRunning();
      await delay(TICK, signal);
    }
  }
};

function createTasks(t: ExecutionContext, world: World, harness: ReturnType<typeof createEngine>) {
  const tasks = new TaskManager({
    getBot: () => world.bot as never,
    getArbiter: () => harness.arbiter,
    events: harness.events,
    behaviors: [idleBehavior] as never
  });
  t.teardown(() => { void tasks.cancelAll('test finished'); });
  return tasks;
}

const MANUAL = { holder: 'manual move-to-position', priority: PRIORITY.MANUAL };

// ---- engine: scheduling ----------------------------------------------------------------------------------------

test.serial('only the highest-priority triggered reflex runs, holding a "reflex <name>" lease at its own priority', async (t) => {
  const clock = useClock(t);
  const world = createWorld();
  const creeper = scripted('creeper-evade', PRIORITY.URGENT_INSTINCT);
  const eat = scripted('auto-eat', PRIORITY.INSTINCT);
  const { engine, holder } = createEngine(t, world, [creeper.definition, eat.definition]);

  engine.tick();

  t.true(creeper.run.calledOnce, 'the critical reflex runs');
  t.true(eat.run.notCalled, 'the lower reflex does not run in the same tick');
  t.deepEqual(holder(), { holder: 'reflex creeper-evade', priority: PRIORITY.URGENT_INSTINCT });

  // At most one reflex at a time: the lower one keeps triggering but does not start while the other runs.
  for (let i = 0; i < 5; i++) {
    await clock.tickAsync(TICK);
    engine.tick();
  }
  t.true(eat.run.notCalled, 'no second reflex while one runs');
  t.true(creeper.run.calledOnce, 'the running reflex is not started again');

  creeper.result = null;
  creeper.finish('moved away');
  await clock.tickAsync(TICK);
  engine.tick();

  t.true(eat.run.calledOnce, 'the routine reflex runs once the body is free');
  t.deepEqual(holder(), { holder: 'reflex auto-eat', priority: PRIORITY.INSTINCT });
});

test.serial('after a reflex ends it cools down and does not trigger again until the cooldown is over', async (t) => {
  const clock = useClock(t);
  const world = createWorld();
  const eat = scripted('auto-eat', PRIORITY.INSTINCT, { cooldownMs: 2000 });
  const { engine, holder, lastReflexEvent } = createEngine(t, world, [eat.definition]);

  engine.tick();
  eat.finish('ate bread');
  await clock.tickAsync(0);

  t.is(holder(), null, 'the lease is released when the reflex ends');
  t.regex(lastReflexEvent('auto-eat') ?? '', resultFormat('auto-eat'));
  t.regex(lastReflexEvent('auto-eat') ?? '', / → ate bread /);

  engine.tick();
  t.is(eat.run.callCount, 1, 'not again right away');
  await clock.tickAsync(1900);
  engine.tick();
  t.is(eat.run.callCount, 1, 'not again within the 2 s cooldown');
  await clock.tickAsync(100);
  engine.tick();
  t.is(eat.run.callCount, 2, 'again once the cooldown is over and the condition still holds');
});

test.serial('a disabled reflex is not evaluated at all, and set-policy changes take effect at the next tick', async (t) => {
  const clock = useClock(t);
  const world = createWorld();
  const creeper = scripted('creeper-evade', PRIORITY.URGENT_INSTINCT, { result: null });
  const eat = scripted('auto-eat', PRIORITY.INSTINCT, { cooldownMs: 500 });
  const { engine, policy } = createEngine(t, world, [creeper.definition, eat.definition]);

  t.true(policy.update({ reflexes: { autoEat: { enabled: false } } }, 'llm').ok);
  for (let i = 0; i < 3; i++) {
    engine.tick();
    await clock.tickAsync(TICK);
  }
  t.true(eat.trigger.notCalled, 'the disabled reflex trigger is never called');
  t.true(eat.run.notCalled);
  t.is(creeper.trigger.callCount, 3, 'enabled reflexes are still evaluated every tick');

  t.true(policy.update({ reflexes: { autoEat: { enabled: true } } }, 'llm').ok);
  engine.tick();
  t.true(eat.run.calledOnce, 'turned back on, it runs at the next tick');
  eat.finish();
  await clock.tickAsync(0);

  t.true(policy.update({ reflexes: { autoEat: { enabled: false } } }, 'llm').ok);
  await clock.tickAsync(1000);
  const evaluations = eat.trigger.callCount;
  engine.tick();
  t.is(eat.trigger.callCount, evaluations, 'turned off between ticks, it is not evaluated after its cooldown');
  t.true(eat.run.calledOnce);
});

test.serial('a reflex running longer than maxDurationMs is cancelled with a timeout event and releases the body', async (t) => {
  const clock = useClock(t);
  const world = createWorld();
  const creeper = scripted('creeper-evade', PRIORITY.URGENT_INSTINCT, { maxDurationMs: 3000 });
  const { engine, holder, lastReflexEvent } = createEngine(t, world, [creeper.definition]);

  engine.tick();
  await clock.tickAsync(2950);
  t.false(creeper.signals[0].aborted, 'still allowed to run before its limit');
  t.deepEqual(holder(), { holder: 'reflex creeper-evade', priority: PRIORITY.URGENT_INSTINCT });

  await clock.tickAsync(100);
  t.true(creeper.signals[0].aborted, 'the action is cancelled at the limit');
  t.is(holder(), null, 'the lease is released');
  const event = lastReflexEvent('creeper-evade') ?? '';
  t.regex(event, resultFormat('creeper-evade'));
  t.regex(event, / → [^→]*time(d)? ?out/i, 'the event result says it timed out');
  // G4: the reflex still owned the body, so the engine stops it.
  t.true(world.bot.clearControlStates.called, 'control states are cleared');
  t.true(world.pathfinder.setGoal.calledWith(null), 'the pathfinder goal is cleared');
});

test.serial('a reflex action that throws ends as failed, releases the body and enters its cooldown', async (t) => {
  const clock = useClock(t);
  const world = createWorld();
  const eat = scripted('auto-eat', PRIORITY.INSTINCT, { cooldownMs: 2000 });
  const { engine, holder, lastReflexEvent } = createEngine(t, world, [eat.definition]);

  engine.tick();
  eat.fail(new Error('the food vanished'));
  await clock.tickAsync(0);

  t.is(holder(), null);
  const event = lastReflexEvent('auto-eat') ?? '';
  t.regex(event, resultFormat('auto-eat'));
  t.regex(event, /fail/i);
  t.regex(event, /the food vanished/);

  engine.tick();
  t.true(eat.run.calledOnce, 'no immediate retry while cooling down');
});

test.serial('a higher reflex interrupts a lower running one, which is reported as interrupted by it', async (t) => {
  const clock = useClock(t);
  const world = createWorld();
  const creeper = scripted('creeper-evade', PRIORITY.URGENT_INSTINCT, { result: null });
  const eat = scripted('auto-eat', PRIORITY.INSTINCT);
  const { engine, holder, lastReflexEvent } = createEngine(t, world, [creeper.definition, eat.definition]);

  engine.tick();
  t.deepEqual(holder(), { holder: 'reflex auto-eat', priority: PRIORITY.INSTINCT });

  creeper.result = { fire: 'creeper about to explode' };
  await clock.tickAsync(TICK);
  engine.tick();

  t.true(eat.signals[0].aborted, 'the lower reflex is told to stop');
  t.true(creeper.run.calledOnce);
  t.deepEqual(holder(), { holder: 'reflex creeper-evade', priority: PRIORITY.URGENT_INSTINCT });
  const event = lastReflexEvent('auto-eat') ?? '';
  t.regex(event, resultFormat('auto-eat'));
  t.regex(event, / → [^→]*interrupted by creeper-evade/);
});

test.serial('a same-priority, higher-ranked critical reflex takes over without the paused task resuming in between', async (t) => {
  const clock = useClock(t);
  const world = createWorld();
  const creeper = scripted('creeper-evade', PRIORITY.URGENT_INSTINCT, { result: null });
  const retreat = scripted('low-health-retreat', PRIORITY.URGENT_INSTINCT, { result: null });
  const harness = createEngine(t, world, [creeper.definition, retreat.definition]);
  const { engine, holder, lastReflexEvent, taskEvents } = harness;
  const tasks = createTasks(t, world, harness);

  t.true((await tasks.start('idle', {})).ok);
  t.deepEqual(holder(), { holder: 'task t1 idle', priority: PRIORITY.TASK });

  retreat.result = { fire: 'health 4 with a zombie nearby' };
  engine.tick();
  t.is(tasks.currentTask()?.status, 'paused');

  creeper.result = { fire: 'creeper about to explode' };
  await clock.tickAsync(TICK);
  engine.tick();

  t.deepEqual(holder(), { holder: 'reflex creeper-evade', priority: PRIORITY.URGENT_INSTINCT });
  t.true(retreat.signals[0].aborted);
  t.regex(lastReflexEvent('low-health-retreat') ?? '', / → [^→]*interrupted by creeper-evade/);
  t.deepEqual(taskEvents(), ['task_started', 'task_paused'], 'no task_resumed / task_paused flicker during the handover');
  t.is(tasks.currentTask()?.status, 'paused');

  retreat.result = null;
  creeper.result = null;
  creeper.finish('moved away');
  await clock.tickAsync(0);

  t.deepEqual(taskEvents(), ['task_started', 'task_paused', 'task_resumed']);
  t.is(tasks.currentTask()?.status, 'running');
  t.deepEqual(holder(), { holder: 'task t1 idle', priority: PRIORITY.TASK });
});

test.serial('a task paused by a reflex resumes by itself when the reflex ends', async (t) => {
  const clock = useClock(t);
  const world = createWorld();
  const eat = scripted('auto-eat', PRIORITY.INSTINCT, { result: null });
  const harness = createEngine(t, world, [eat.definition]);
  const { engine, events, holder, taskEvents } = harness;
  const tasks = createTasks(t, world, harness);

  t.true((await tasks.start('idle', {})).ok);
  eat.result = { fire: 'food 10 below 14' };
  engine.tick();

  t.is(tasks.currentTask()?.status, 'paused');
  t.deepEqual(holder(), { holder: 'reflex auto-eat', priority: PRIORITY.INSTINCT });
  const paused = events.query({ types: ['task_paused'], limit: 10 }).events[0]?.message ?? '';
  t.regex(paused, /^t1 idle: paused by reflex auto-eat/, 'G3 task_paused format');

  eat.result = null;
  eat.finish('ate bread');
  await clock.tickAsync(0);

  t.is(tasks.currentTask()?.status, 'running');
  t.deepEqual(taskEvents(), ['task_started', 'task_paused', 'task_resumed']);
  t.deepEqual(holder(), { holder: 'task t1 idle', priority: PRIORITY.TASK });
});

// ---- engine: manual commands (G1) ------------------------------------------------------------------------------

test.serial('a manual command interrupts a routine reflex at once; the reflex lease is gone and it cools down', async (t) => {
  const clock = useClock(t);
  const world = createWorld();
  const eat = scripted('auto-eat', PRIORITY.INSTINCT, { cooldownMs: 3000 });
  const { engine, arbiter, holder, lastReflexEvent } = createEngine(t, world, [eat.definition]);

  engine.tick();
  const manual = await arbiter.acquire(MANUAL);

  t.true(manual.ok, 'the manual command does not wait for a routine reflex');
  t.true(eat.signals[0].aborted, 'the routine reflex is cancelled');
  t.deepEqual(holder(), MANUAL);
  const event = lastReflexEvent('auto-eat') ?? '';
  t.regex(event, resultFormat('auto-eat'));
  t.regex(event, / → [^→]*interrupted by manual command move-to-position/);

  if (manual.ok) manual.lease.release();
  t.is(holder(), null, 'nothing resumes the interrupted reflex lease');

  await clock.tickAsync(TICK);
  engine.tick();
  t.true(eat.run.calledOnce, 'an interrupted routine reflex enters its cooldown (G1)');
});

test.serial('a routine reflex cannot take the body from a manual command, and runs once the body is free', async (t) => {
  const clock = useClock(t);
  const world = createWorld();
  const eat = scripted('auto-eat', PRIORITY.INSTINCT);
  const { engine, arbiter, holder } = createEngine(t, world, [eat.definition]);
  const manual = await arbiter.acquire(MANUAL);

  for (let i = 0; i < 5; i++) {
    engine.tick();
    await clock.tickAsync(TICK);
  }
  t.true(eat.run.notCalled);
  t.deepEqual(holder(), MANUAL);

  if (manual.ok) manual.lease.release();
  for (let i = 0; i < 40 && eat.run.notCalled; i++) {
    await clock.tickAsync(TICK);
    engine.tick();
  }
  t.true(eat.run.calledOnce, 'the still-triggered reflex starts within 2 s of the body becoming free');
});

test.serial('a manual command waits for a critical reflex and reports the wait', async (t) => {
  const clock = useClock(t);
  const world = createWorld();
  const creeper = scripted('creeper-evade', PRIORITY.URGENT_INSTINCT);
  const { engine, arbiter, holder, lastReflexEvent } = createEngine(t, world, [creeper.definition]);

  engine.tick();
  let settled: AcquireResult | undefined;
  const pending = arbiter.acquire(MANUAL).then(result => {
    settled = result;
    return result;
  });

  await clock.tickAsync(500);
  t.is(settled, undefined, 'the manual command is still waiting');
  t.false(creeper.signals[0].aborted, 'the critical reflex keeps running');
  t.deepEqual(holder(), { holder: 'reflex creeper-evade', priority: PRIORITY.URGENT_INSTINCT });

  creeper.result = null;
  creeper.finish('moved 9 blocks away');
  await clock.tickAsync(0);
  const result = await pending;

  t.true(result.ok);
  if (result.ok) {
    t.is(result.waitedFor?.holder, 'reflex creeper-evade', 'the result names the reflex it waited for');
    t.true(result.waitedMs >= 500 && result.waitedMs < 1000, `waited ${result.waitedMs} ms`);
  }
  t.deepEqual(holder(), MANUAL);
  const event = lastReflexEvent('creeper-evade') ?? '';
  t.regex(event, resultFormat('creeper-evade'));
  t.regex(event, / → moved 9 blocks away /, 'the reflex finished normally, not interrupted');
});

// ---- engine: robustness ----------------------------------------------------------------------------------------

test.serial('a trigger that throws is skipped and logged once; other reflexes and later ticks keep working', async (t) => {
  const clock = useClock(t);
  const world = createWorld();
  const broken = scripted('creeper-evade', PRIORITY.URGENT_INSTINCT);
  broken.throwing = new Error('unreadable metadata');
  const eat = scripted('auto-eat', PRIORITY.INSTINCT, { cooldownMs: 200 });
  const { engine, log } = createEngine(t, world, [broken.definition, eat.definition]);

  t.notThrows(() => engine.tick());
  t.true(eat.run.calledOnce, 'the next reflex is still evaluated in the same tick');
  eat.result = null;
  eat.finish();
  await clock.tickAsync(0);

  for (let i = 0; i < 5; i++) {
    await clock.tickAsync(TICK);
    t.notThrows(() => engine.tick());
  }
  t.true(broken.trigger.callCount >= 5, 'the failing trigger is tried again on later ticks');
  const logged = log.getCalls().filter(call => String(call.args[1]).includes('creeper-evade'));
  t.is(logged.length, 1, 'the failure is logged once, not every tick');

  broken.throwing = null;
  await clock.tickAsync(TICK);
  engine.tick();
  t.true(broken.run.calledOnce, 'once its trigger works again the reflex runs');
});

test.serial('ticks do nothing while the bot is dead, and the engine follows physicsTick once started', async (t) => {
  useClock(t);
  const world = createWorld({ health: 0 });
  const creeper = scripted('creeper-evade', PRIORITY.URGENT_INSTINCT);
  const { engine, holder, reflexEvents } = createEngine(t, world, [creeper.definition]);
  engine.start();

  engine.tick();
  world.bot.emit('physicsTick');
  t.true(creeper.trigger.notCalled, 'nothing is evaluated at health 0');
  t.is(holder(), null);
  t.deepEqual(reflexEvents(), []);

  world.bot.health = 20;
  world.bot.emit('physicsTick');
  t.true(creeper.run.calledOnce, 'alive again, the next physicsTick runs the reflex');
});

test.serial('a death event aborts the running reflex and releases the body; stop() unsubscribes', async (t) => {
  useClock(t);
  const world = createWorld();
  const creeper = scripted('creeper-evade', PRIORITY.URGENT_INSTINCT);
  const { engine, holder, lastReflexEvent } = createEngine(t, world, [creeper.definition]);
  engine.start();
  world.bot.emit('physicsTick');
  t.true(creeper.run.calledOnce);

  world.bot.health = 0;
  world.bot.emit('death');

  t.true(creeper.signals[0].aborted);
  t.is(holder(), null);
  const event = lastReflexEvent('creeper-evade') ?? '';
  t.regex(event, resultFormat('creeper-evade'));
  t.regex(event, / → [^→]*interrupted/);

  world.bot.health = 20;
  engine.stop();
  const evaluations = creeper.trigger.callCount;
  world.bot.emit('physicsTick');
  t.is(creeper.trigger.callCount, evaluations, 'a stopped engine ignores physicsTick');
});

test.serial('a note result writes a reflex event without taking the body', async (t) => {
  useClock(t);
  const world = createWorld();
  const defense = scripted('self-defense', PRIORITY.INSTINCT, { result: { note: 'hit by player Steve; not fighting back' } });
  const { engine, holder, stopBody, reflexEvents } = createEngine(t, world, [defense.definition]);

  engine.tick();

  t.true(defense.run.notCalled);
  t.is(holder(), null);
  t.true(stopBody.notCalled, 'nothing was preempted');
  const events = reflexEvents();
  t.is(events.length, 1);
  t.regex(events[0], /^self-defense: .*hit by player Steve; not fighting back/);
});

test.serial('triggering 4 times within 30 s is reported once', async (t) => {
  const clock = useClock(t);
  const world = createWorld();
  const eat = scripted('auto-eat', PRIORITY.INSTINCT, { cooldownMs: 1000 });
  const { engine, reflexEvents } = createEngine(t, world, [eat.definition]);

  for (let i = 0; i < 6; i++) {
    engine.tick();
    eat.finish('ate');
    await clock.tickAsync(1000);
  }

  t.is(eat.run.callCount, 6);
  const messages = reflexEvents();
  const results = messages.filter(message => resultFormat('auto-eat').test(message));
  const others = messages.filter(message => !resultFormat('auto-eat').test(message));
  t.is(results.length, 6, 'one result event per run');
  t.is(others.length, 1, 'exactly one repeat warning for 6 triggers in 6 s');
  t.regex(others[0] ?? '', /^auto-eat: /);
});

test.serial('I6: every reflex trigger answers synchronously inside the tick', async (t) => {
  useClock(t);
  const zombieNear = mob('zombie', 2);
  const scenarios: { name: ReflexName; world: World; before?: (engine: ReflexEngine) => void }[] = [
    { name: 'creeper-evade', world: createWorld({ entities: [ignitedCreeper(4)] }) },
    { name: 'low-health-retreat', world: createWorld({ health: 5, entities: [mob('zombie', 10)] }) },
    { name: 'self-defense', world: createWorld({ entities: [zombieNear] }), before: engine => hitBy(engine, zombieNear) },
    { name: 'auto-eat', world: createWorld({ food: 10, inventory: [item('bread')] }) }
  ];

  for (const { name, world, before } of scenarios) {
    const original = REFLEXES.find(reflex => reflex.name === name)!;
    t.not(original.trigger.constructor.name, 'AsyncFunction', `${name} trigger is not async`);
    const trigger = sinon.spy(original.trigger);
    const { engine } = createEngine(t, world, [{ ...original, trigger }]);
    before?.(engine);

    const returned = engine.tick();

    t.is(returned, undefined);
    t.true(trigger.calledOnce, `${name} is evaluated synchronously during tick()`);
    const result = trigger.firstCall.returnValue;
    t.true(Boolean(result && 'fire' in result), `${name} fires in its scenario`);
    t.false(typeof (result as { then?: unknown } | null)?.then === 'function', `${name} returns a plain value, not a promise`);
  }
});

// ---- creeper-evade ---------------------------------------------------------------------------------------------

test.serial('creeper-evade: an ignited creeper 4 blocks away → sprinting away from the first tick, 8+ blocks away before the fuse ends', async (t) => {
  const clock = useClock(t);
  const creeper = ignitedCreeper(4);
  const world = createWorld({ entities: [creeper] });
  const { startGame, holder, lastReflexEvent } = createEngine(t, world);
  startGame();

  await clock.tickAsync(TICK);
  t.deepEqual(holder(), { holder: 'reflex creeper-evade', priority: PRIORITY.URGENT_INSTINCT });
  t.true(world.controls.forward, 'moving forward on the tick it triggered');
  t.true(world.controls.sprint, 'sprinting on the tick it triggered');
  t.true(facing(world, creeper.position) <= -0.7, `looking away from the creeper (cos ${facing(world, creeper.position).toFixed(2)})`);

  await clock.tickAsync(CREEPER_FUSE_MS);
  t.true(distanceTo(world, creeper) >= 8, `8+ blocks away when the creeper explodes (${distanceTo(world, creeper).toFixed(2)})`);
  t.is(holder(), null, 'done once far enough');
  t.false(world.controls.forward, 'the engine stops the body when the reflex ends (G4)');
  const event = lastReflexEvent('creeper-evade') ?? '';
  t.regex(event, resultFormat('creeper-evade'));
  t.notRegex(event, /interrupted|time(d)? ?out|fail/i);
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
  test.serial(`creeper-evade does not flee into ${label} straight behind the bot`, async (t) => {
    const clock = useClock(t);
    const creeper = ignitedCreeper(4);
    const world = createWorld({ entities: [creeper], terrain });
    const { startGame } = createEngine(t, world);
    startGame();

    await clock.tickAsync(TICK + CREEPER_FUSE_MS);

    const bad = world.visited.find(forbidden);
    t.is(bad, undefined, bad ? `walked onto ${bad.floored()}` : 'stayed on safe ground');
    t.true(
      distanceTo(world, creeper) >= 8 || world.pathfinder.setGoal.getCalls().some(call => call.args[0] !== null),
      'it still gets away (or hands the way out to the pathfinder)'
    );
  });
}

test.serial('creeper-evade turned off with set-policy does not trigger', async (t) => {
  useClock(t);
  const world = createWorld({ entities: [ignitedCreeper(4)] });
  const { engine, policy, holder, reflexEvents } = createEngine(t, world);
  t.true(policy.update({ reflexes: { creeperEvade: { enabled: false } } }, 'llm').ok);

  engine.tick();

  t.is(holder(), null);
  t.deepEqual(reflexEvents(), []);
  t.falsy(world.controls.forward);
});

// ---- low-health-retreat ----------------------------------------------------------------------------------------

function holderAfterOneTick(t: ExecutionContext, options: WorldOptions, update?: PolicyUpdate): string | null {
  const world = createWorld(options);
  const { engine, policy, holder } = createEngine(t, world);
  if (update) t.true(policy.update(update, 'llm').ok);
  engine.tick();
  const name = holder()?.holder ?? null;
  engine.stop();
  return name;
}

test.serial('low-health-retreat triggers below the health threshold only with a hostile within the radius', async (t) => {
  useClock(t);
  const retreat = 'reflex low-health-retreat';

  t.is(holderAfterOneTick(t, { health: 5, entities: [mob('zombie', 10)] }), retreat, 'health 5 < 6 with a zombie at 10 ≤ 16');
  t.is(holderAfterOneTick(t, { health: 5, entities: [mob('zombie', 20)] }), null, 'the zombie is beyond 16 blocks');
  // At combat.retreatHealth (6 by default) fights disengage, so the retreat starts there too (F-011 handoff).
  t.is(holderAfterOneTick(t, { health: 6, entities: [mob('zombie', 10)] }), retreat, 'health 6 is the combat retreat point');
  t.is(holderAfterOneTick(t, { health: 7, entities: [mob('zombie', 10)] }), null, 'health 7 is above both thresholds');
  t.is(holderAfterOneTick(t, { health: 5 }), null, 'no hostile around');
  t.is(holderAfterOneTick(t, { health: 5, entities: [mob('zombie', 10)] }, { reflexes: { lowHealthRetreat: { radius: 8 } } }), null, 'policy radius 8');
  t.is(holderAfterOneTick(t, { health: 7, entities: [mob('zombie', 10)] }, { reflexes: { lowHealthRetreat: { health: 8 } } }), retreat, 'policy health 8');
});

test.serial('low-health-retreat: runs away from the hostile until out of range, then eats', async (t) => {
  const clock = useClock(t);
  const zombie = mob('zombie', 10);
  const world = createWorld({ health: 5, food: 15, entities: [zombie], inventory: [item('bread')] });
  const { startGame, holder, lastReflexEvent } = createEngine(t, world);
  startGame();

  await clock.tickAsync(TICK);
  t.deepEqual(holder(), { holder: 'reflex low-health-retreat', priority: PRIORITY.URGENT_INSTINCT });
  t.true(world.controls.forward);
  t.true(facing(world, zombie.position) <= -0.7, 'running away from the zombie');

  await clock.tickAsync(3000);
  t.true(distanceTo(world, zombie) > 16, `more than 16 blocks away (${distanceTo(world, zombie).toFixed(1)})`);
  t.true(world.bot.consume.calledOnce, 'eats once away from the hostiles');
  t.is(holder(), null);
  const event = lastReflexEvent('low-health-retreat') ?? '';
  t.regex(event, resultFormat('low-health-retreat'));
  t.notRegex(event, /interrupted|time(d)? ?out|fail/i);
});

// ---- self-defense ----------------------------------------------------------------------------------------------

test.serial('self-defense, stance fight: hit by a zombie → attacks it even at health 8, and ends when it dies', async (t) => {
  const clock = useClock(t);
  const zombie = mob('zombie', 2);
  const world = createWorld({ health: 8, entities: [zombie] });
  const { engine, policy, holder, lastReflexEvent } = createEngine(t, world);
  t.true(policy.update({ reflexes: { selfDefense: { stance: 'fight' } } }, 'llm').ok);

  hitBy(engine, zombie);
  engine.tick();
  t.deepEqual(holder(), { holder: 'reflex self-defense', priority: PRIORITY.INSTINCT });

  await clock.tickAsync(300);
  t.true(world.bot.attack.calledWith(sinon.match({ id: zombie.id })), 'fights back');

  zombie.isValid = false;
  delete world.entities[zombie.id];
  await clock.tickAsync(200);
  t.is(holder(), null);
  t.regex(lastReflexEvent('self-defense') ?? '', resultFormat('self-defense'));
});

test.serial('self-defense, stance flee: hit by a zombie → runs away without attacking', async (t) => {
  const clock = useClock(t);
  const zombie = mob('zombie', 2);
  const world = createWorld({ entities: [zombie] });
  const { engine, policy, holder, startGame } = createEngine(t, world);
  t.true(policy.update({ reflexes: { selfDefense: { stance: 'flee' } } }, 'llm').ok);
  startGame();

  hitBy(engine, zombie);
  await clock.tickAsync(TICK);
  t.deepEqual(holder(), { holder: 'reflex self-defense', priority: PRIORITY.INSTINCT });

  await clock.tickAsync(500);
  t.true(world.bot.attack.notCalled, 'never attacks');
  t.true(world.controls.forward, 'moving');
  t.true(facing(world, zombie.position) <= -0.7, 'away from the zombie');
  t.true(distanceTo(world, zombie) > 3, `got further away (${distanceTo(world, zombie).toFixed(1)})`);
});

/** What the auto stance does without a decision model: 'fight' (attacked), 'flee' (moving, no attack) or 'none'. */
async function autoStanceOutcome(t: ExecutionContext, clock: sinon.SinonFakeTimers, health: number, hostiles: number) {
  const zombies = Array.from({ length: hostiles }, (_, i) => mob('zombie', 2 + i, i % 2 === 0 ? 0 : 1));
  const world = createWorld({ health, entities: zombies });
  const { engine, holder } = createEngine(t, world);
  hitBy(engine, zombies[0]);
  engine.tick();
  const started = holder()?.holder;
  await clock.tickAsync(300);
  engine.stop();
  if (started !== 'reflex self-defense') return 'none';
  if (world.bot.attack.called) return 'fight';
  return world.bot.setControlState.calledWith('forward', true) ? 'flee' : 'none';
}

test.serial('self-defense, stance auto without a decision model: fight at health ≥ 10 with ≤ 2 hostiles, otherwise flee', async (t) => {
  const clock = useClock(t);

  t.is(await autoStanceOutcome(t, clock, 20, 1), 'fight', 'health 20, one zombie');
  t.is(await autoStanceOutcome(t, clock, 10, 2), 'fight', 'health 10, two zombies');
  t.is(await autoStanceOutcome(t, clock, 8, 1), 'flee', 'health 8, one zombie');
  t.is(await autoStanceOutcome(t, clock, 20, 3), 'flee', 'health 20, three zombies');
});

test.serial('self-defense: hit by a player → only a note event; no attack and no lease (I1)', async (t) => {
  const clock = useClock(t);
  const steve = player('Steve', 2);
  const world = createWorld({ entities: [steve] });
  const { engine, policy, holder, stopBody, reflexEvents } = createEngine(t, world);

  hitBy(engine, steve, 'player_attack');
  engine.tick();
  t.is(holder(), null, 'the body is not taken');
  await clock.tickAsync(500);
  t.true(world.bot.attack.notCalled);
  t.true(stopBody.notCalled);
  const events = reflexEvents();
  t.is(events.length, 1);
  t.regex(events[0] ?? '', /^self-defense: .*Steve/, 'the event names the player');

  // Reflexes never fight players (F-013), even with attackPlayers switched on for the LLM's own commands.
  t.true(policy.update({ combat: { attackPlayers: true } }, 'llm').ok);
  await clock.tickAsync(5000);
  hitBy(engine, steve, 'player_attack');
  engine.tick();
  await clock.tickAsync(500);
  t.is(holder(), null);
  t.true(world.bot.attack.notCalled);
});

test.serial('self-defense: hit by a tamed wolf → only a note event; no attack (I1)', async (t) => {
  const clock = useClock(t);
  const wolf = tamedWolf(2);
  const world = createWorld({ entities: [wolf] });
  const { engine, holder, reflexEvents } = createEngine(t, world);

  hitBy(engine, wolf);
  engine.tick();
  await clock.tickAsync(500);

  t.is(holder(), null);
  t.true(world.bot.attack.notCalled);
  const events = reflexEvents();
  t.is(events.length, 1);
  t.regex(events[0] ?? '', /^self-defense: /);
});

test.serial('a manual command interrupting self-defense: the reflex stops driving the body and leaves the new goal alone (G1, G4)', async (t) => {
  const clock = useClock(t);
  const zombie = mob('zombie', 2);
  const world = createWorld({ entities: [zombie] });
  const { engine, arbiter, policy, holder, startGame, lastReflexEvent } = createEngine(t, world);
  t.true(policy.update({ reflexes: { selfDefense: { stance: 'flee' } } }, 'llm').ok);
  startGame();
  hitBy(engine, zombie);
  await clock.tickAsync(TICK + 200);
  t.deepEqual(holder(), { holder: 'reflex self-defense', priority: PRIORITY.INSTINCT });

  const manual = await arbiter.acquire(MANUAL);
  t.true(manual.ok);
  const manualGoal = { manual: true };
  world.pathfinder.goal = manualGoal;
  const counts = {
    controls: world.bot.setControlState.callCount,
    clears: world.bot.clearControlStates.callCount,
    looks: world.bot.look.callCount,
    goals: world.pathfinder.setGoal.callCount
  };

  await clock.tickAsync(500);

  t.deepEqual(holder(), MANUAL);
  t.regex(lastReflexEvent('self-defense') ?? '', / → [^→]*interrupted by manual command move-to-position/);
  t.is(world.bot.setControlState.callCount, counts.controls, 'no control changes after losing the body');
  t.is(world.bot.clearControlStates.callCount, counts.clears, 'the manual command\'s controls are not cleared');
  t.is(world.bot.look.callCount, counts.looks, 'no more looking around');
  t.is(world.pathfinder.setGoal.callCount, counts.goals, 'the pathfinder is left alone');
  t.is(world.pathfinder.goal, manualGoal);
});

// ---- auto-eat --------------------------------------------------------------------------------------------------

test.serial('auto-eat: food 10 with bread and no hostile within 8 → equips the bread and eats it', async (t) => {
  const clock = useClock(t);
  const bread = item('bread');
  const world = createWorld({ food: 10, inventory: [bread] });
  const { engine, holder, lastReflexEvent } = createEngine(t, world);

  engine.tick();
  t.deepEqual(holder(), { holder: 'reflex auto-eat', priority: PRIORITY.INSTINCT });
  await clock.tickAsync(0);

  t.is(world.bot.equip.firstCall?.args[0], bread, 'the bread goes in hand');
  t.true(world.bot.consume.calledOnce, 'eats it');
  t.true(world.bot.food > 10);
  t.is(holder(), null);
  const event = lastReflexEvent('auto-eat') ?? '';
  t.regex(event, resultFormat('auto-eat'));
  t.notRegex(event, /interrupted|time(d)? ?out|fail/i);
});

test.serial('auto-eat does not trigger with a hostile at 5 blocks, with only rotten flesh, or at the threshold', async (t) => {
  useClock(t);
  const eat = 'reflex auto-eat';

  t.is(holderAfterOneTick(t, { food: 13, inventory: [item('bread')] }), eat, 'food 13 < 14 with bread');
  t.is(holderAfterOneTick(t, { food: 14, inventory: [item('bread')] }), null, 'food 14 is not below the default 14');
  t.is(holderAfterOneTick(t, { food: 10, inventory: [item('bread')], entities: [mob('zombie', 5)] }), null, 'a zombie within 8 blocks');
  t.is(holderAfterOneTick(t, { food: 10, inventory: [item('rotten_flesh')] }), null, 'only harmful food');
  t.is(holderAfterOneTick(t, { food: 10 }), null, 'nothing to eat');
  t.is(holderAfterOneTick(t, { food: 15, inventory: [item('bread')] }, { reflexes: { autoEat: { food: 16 } } }), eat, 'policy threshold 16');
});

test.serial('auto-eat: a manual command while eating stops eating at once (deactivateItem)', async (t) => {
  const clock = useClock(t);
  const world = createWorld({ food: 10, inventory: [item('bread')] });
  world.eatSlowly();
  const { engine, arbiter, holder, lastReflexEvent } = createEngine(t, world);

  engine.tick();
  await clock.tickAsync(0);
  t.true(world.bot.consume.calledOnce, 'eating');

  const manual = await arbiter.acquire(MANUAL);

  t.true(manual.ok);
  t.true(world.bot.deactivateItem.called, 'eating is stopped');
  t.deepEqual(holder(), MANUAL);
  t.regex(lastReflexEvent('auto-eat') ?? '', / → [^→]*interrupted by manual command move-to-position/);
});

// ---- F-012 acceptance with the real reflexes -------------------------------------------------------------------

test.serial('auto-eat is interrupted by creeper-evade when a creeper ignites during the meal', async (t) => {
  const clock = useClock(t);
  const world = createWorld({ food: 10, inventory: [item('bread')] });
  world.eatSlowly();
  const { startGame, holder, lastReflexEvent } = createEngine(t, world);
  startGame();

  await clock.tickAsync(TICK);
  t.deepEqual(holder(), { holder: 'reflex auto-eat', priority: PRIORITY.INSTINCT });
  t.true(world.bot.consume.calledOnce);

  const creeper = ignitedCreeper(4);
  world.entities[creeper.id] = creeper;
  await clock.tickAsync(TICK);

  t.deepEqual(holder(), { holder: 'reflex creeper-evade', priority: PRIORITY.URGENT_INSTINCT });
  t.true(world.bot.deactivateItem.called, 'eating is stopped');
  t.regex(lastReflexEvent('auto-eat') ?? '', / → [^→]*interrupted by creeper-evade/);
  t.true(world.controls.forward && world.controls.sprint, 'already running from the creeper');
});

test.serial('self-defense and auto-eat both triggered → only self-defense runs', async (t) => {
  useClock(t);
  // Shot by a skeleton 10 blocks away: far enough that auto-eat alone would trigger.
  t.is(holderAfterOneTick(t, { food: 10, inventory: [item('bread')], entities: [mob('skeleton', 10)] }), 'reflex auto-eat', 'auto-eat alone would run');

  const skeleton = mob('skeleton', 10);
  const world = createWorld({ food: 10, inventory: [item('bread')], entities: [skeleton] });
  const { engine, holder } = createEngine(t, world);
  hitBy(engine, skeleton, 'arrow');
  engine.tick();

  t.deepEqual(holder(), { holder: 'reflex self-defense', priority: PRIORITY.INSTINCT });
  t.true(world.bot.consume.notCalled, 'no eating');
  t.false(world.bot.equip.getCalls().some(call => (call.args[0] as FakeItem | undefined)?.name === 'bread'), 'the bread stays in the bag');
});

// ---- review fixes: running away, retreat threshold, self-defense rules, respawn -------------------

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
 * cobweb has no collision box), and marks the blocks at the given "x,y,z" keys as waterlogged.
 */
function useRealBlocks(world: World, waterlogged: string[] = []): void {
  (world.bot as { blockAt: unknown }).blockAt = (pos: Vec3) => {
    const p = pos.floored();
    const name = world.blockName(p.x, p.y, p.z);
    const known = registry.blocksByName[name];
    return {
      name,
      position: p,
      boundingBox: known?.boundingBox ?? (EMPTY_BLOCKS.has(name) ? 'empty' : 'block'),
      shapes: defaultShapes(name),
      isWaterlogged: waterlogged.includes(`${p.x},${p.y},${p.z}`)
    };
  };
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

/** Two-high stone walls on every side of the bot's block: no direction to run in. */
const walledIn: WorldOptions['terrain'] = (x, y, z) => ((y === 64 || y === 65) && (x !== 0 || z !== 0) ? 'stone' : undefined);

function neutral(name: string, dx: number, dz = 0): FakeEntity {
  return { ...mob(name, dx, dz), type: registry.entitiesByName[name]?.type ?? 'mob' };
}

// -- fix 3: what counts as a safe direction ------------------------------------------------------------------------

for (const name of ['oak_fence', 'cobblestone_wall', 'oak_fence_gate']) {
  test.serial(`creeper-evade: ${name} (1.5 blocks tall) straight behind the bot is not jumped onto; it runs past it at an angle`, async (t) => {
    const clock = useClock(t);
    const creeper = ignitedCreeper(4);
    const world = createWorld({ entities: [creeper], blocks: { '-1,64,0': name } });
    useRealBlocks(world);
    const { startGame, holder } = createEngine(t, world);
    startGame();

    await clock.tickAsync(TICK);
    t.deepEqual(holder(), { holder: 'reflex creeper-evade', priority: PRIORITY.URGENT_INSTINCT });
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

test.serial('creeper-evade: a one-block step straight behind is jumped, but not with a ceiling right above the bot\'s own head', async (t) => {
  useClock(t);
  const cases: { label: string; blocks: Record<string, string>; jumpable: boolean }[] = [
    { label: 'a stone step', blocks: { '-1,64,0': 'stone' }, jumpable: true },
    { label: 'a bottom slab', blocks: { '-1,64,0': 'oak_slab' }, jumpable: true },
    { label: 'a stone step with stone above the bot\'s head', blocks: { '-1,64,0': 'stone', '0,66,0': 'stone' }, jumpable: false }
  ];
  for (const { label, blocks, jumpable } of cases) {
    const world = createWorld({ entities: [ignitedCreeper(4)], blocks });
    useRealBlocks(world);
    const { engine, holder } = createEngine(t, world);
    engine.tick();
    t.deepEqual(holder(), { holder: 'reflex creeper-evade', priority: PRIORITY.URGENT_INSTINCT }, label);
    const look = firstLook(world);
    if (jumpable) {
      t.true(cosine(look, WEST) > 0.99, `${label}: runs straight away over it (cos ${cosine(look, WEST).toFixed(2)})`);
      t.true(world.controls.forward && world.controls.jump, `${label}: jumps onto it`);
    } else {
      t.true(cosine(look, WEST) < 0.9, `${label}: no room to jump, so not straight at it (cos ${cosine(look, WEST).toFixed(2)})`);
      t.true(cosine(look, WEST) > 0, `${label}: still away from the creeper`);
    }
    engine.stop();
  }
});

for (const { key, label } of [
  { key: '-1,64,0', label: 'right behind the bot' },
  { key: '-2,65,0', label: 'two blocks behind at head height' }
]) {
  test.serial(`creeper-evade: a cobweb ${label} is avoided even though it has no collision box`, async (t) => {
    const clock = useClock(t);
    const creeper = ignitedCreeper(4);
    const world = createWorld({ entities: [creeper], blocks: { [key]: 'cobweb' } });
    useRealBlocks(world);
    const { startGame } = createEngine(t, world);
    startGame();

    await clock.tickAsync(TICK);
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

test.serial('creeper-evade: lava next to a diagonal escape route, or on its second block, rules that diagonal out', async (t) => {
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
    const world = createWorld({ entities: [ignitedCreeper(3, 3)], blocks: lava ? { [lava]: 'lava' } : {} });
    useRealBlocks(world);
    const { engine, holder } = createEngine(t, world);
    engine.tick();
    t.deepEqual(holder(), { holder: 'reflex creeper-evade', priority: PRIORITY.URGENT_INSTINCT }, label);
    const look = firstLook(world);
    t.truthy(look, `${label}: runs by itself (a safe direction exists)`);
    if (!lava) {
      t.true(cosine(look, NORTHWEST) > 0.99, `${label}: straight away along the diagonal (cos ${cosine(look, NORTHWEST).toFixed(2)})`);
    } else {
      t.true(cosine(look, NORTHWEST) < 0.9, `${label}: not along that diagonal (cos ${cosine(look, NORTHWEST).toFixed(2)})`);
      t.true(cosine(look, NORTHWEST) >= -1e-9, `${label}: still away from the creeper`);
    }
    engine.stop();
  }
});

// -- fix 2: the pathfinder fallback of runAway ----------------------------------------------------------------------

const NO_WAY_OUT: { label: string; terrain: WorldOptions['terrain'] }[] = [
  { label: 'walled in', terrain: walledIn },
  // Standing on a one-block pillar: a 10-block drop on every side.
  { label: 'on a pillar', terrain: (x, y, z) => ((x !== 0 || z !== 0) && y >= 54 && y <= 63 ? 'air' : undefined) }
];

for (const { label, terrain } of NO_WAY_OUT) {
  test.serial(`creeper-evade with no safe direction (${label}) hands over to the pathfinder once: one GoalXZ, no clearing of controls every tick`, async (t) => {
    const clock = useClock(t);
    const creeper = ignitedCreeper(4);
    const world = createWorld({ entities: [creeper], terrain });
    useRealBlocks(world);
    const { startGame, holder } = createEngine(t, world);
    startGame();

    await clock.tickAsync(TICK);
    t.deepEqual(holder(), { holder: 'reflex creeper-evade', priority: PRIORITY.URGENT_INSTINCT });
    t.true(world.bot.look.notCalled, 'no direction of its own');
    const goal = world.pathfinder.goal;
    t.true(goal instanceof goals.GoalXZ, 'the pathfinder gets a GoalXZ');
    if (goal instanceof goals.GoalXZ) t.true(goal.x < 0, `the goal is away from the creeper (x ${goal.x})`);
    const goalsSet = world.pathfinder.setGoal.callCount;
    const clears = world.bot.clearControlStates.callCount;
    t.is(goalsSet, 1, 'one goal');

    // One second of ticks, and past the 1 s stuck check, still before the 3 s limit.
    for (const ms of [1000, 1000]) {
      await clock.tickAsync(ms);
      t.deepEqual(holder(), { holder: 'reflex creeper-evade', priority: PRIORITY.URGENT_INSTINCT });
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
  const running = runAway(world.bot as never, controller.signal, () => [zombie.position], () => false).catch(error => error);

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
  const running = runAway(world.bot as never, controller.signal, () => [zombie.position], () => false).catch(error => error);

  t.is(world.pathfinder.goal, null, 'the leftover goal is cleared');
  t.true(world.controls.forward && world.controls.sprint, 'sprinting with its own controls');
  t.true(cosine(firstLook(world), WEST) > 0.99, 'straight away from the zombie');
  await clock.tickAsync(200);
  t.true(world.pathfinder.setGoal.getCalls().every(call => call.args[0] === null), 'no pathfinder goal of its own');

  controller.abort();
  await running;
});

// -- fix 6: low-health-retreat threshold -----------------------------------------------------------------------------

test.serial('low-health-retreat also starts at combat.retreatHealth, where fights disengage, when that is above its own threshold', async (t) => {
  useClock(t);
  const retreat = 'reflex low-health-retreat';
  const zombie = () => [mob('zombie', 10)];
  const apart: PolicyUpdate = { reflexes: { lowHealthRetreat: { health: 4 } }, combat: { retreatHealth: 8 } };

  t.is(holderAfterOneTick(t, { health: 8, entities: zombie() }, apart), retreat, 'health 8 = combat.retreatHealth 8');
  t.is(holderAfterOneTick(t, { health: 7, entities: zombie() }, apart), retreat, 'health 7 < combat.retreatHealth 8');
  t.is(holderAfterOneTick(t, { health: 9, entities: zombie() }, apart), null, 'health 9 is above both thresholds');
  t.is(holderAfterOneTick(t, { health: 8 }, apart), null, 'still needs a hostile nearby');

  const lowOwn: PolicyUpdate = { reflexes: { lowHealthRetreat: { health: 4 } } };
  t.is(holderAfterOneTick(t, { health: 6, entities: zombie() }, lowOwn), retreat, 'health 6 = the default combat.retreatHealth');
  t.is(holderAfterOneTick(t, { health: 7, entities: zombie() }, lowOwn), null, 'health 7 is above the default combat.retreatHealth 6');
});

// -- fix 7: self-defense rules ---------------------------------------------------------------------------------------

for (const stance of ['auto', 'fight'] as const) {
  test.serial(`self-defense, stance ${stance}: hit by an iron golem with the default policy (avoidNeutral) → runs away, never attacks`, async (t) => {
    const clock = useClock(t);
    const golem = neutral('iron_golem', 2);
    const world = createWorld({ entities: [golem] });
    const { engine, policy, holder, startGame } = createEngine(t, world);
    t.true(policy.update({ reflexes: { selfDefense: { stance } } }, 'llm').ok);
    startGame();

    hitBy(engine, golem);
    await clock.tickAsync(TICK);
    t.deepEqual(holder(), { holder: 'reflex self-defense', priority: PRIORITY.INSTINCT });

    await clock.tickAsync(500);
    t.true(world.bot.attack.notCalled, 'neutral mobs are not attacked by default');
    t.true(world.controls.forward, 'moving');
    t.true(facing(world, golem.position) <= -0.7, 'away from the golem');
    t.true(distanceTo(world, golem) > 3, `got further away (${distanceTo(world, golem).toFixed(1)})`);
  });
}

test.serial('self-defense: hit by an iron golem with avoidNeutral off → may fight back', async (t) => {
  const clock = useClock(t);
  const golem = neutral('iron_golem', 2);
  const world = createWorld({ entities: [golem] });
  const { engine, policy, holder } = createEngine(t, world);
  t.true(policy.update({ combat: { avoidNeutral: false } }, 'llm').ok);

  hitBy(engine, golem);
  engine.tick();
  t.deepEqual(holder(), { holder: 'reflex self-defense', priority: PRIORITY.INSTINCT });
  await clock.tickAsync(300);
  t.true(world.bot.attack.calledWith(sinon.match({ id: golem.id })), 'fights back');
});

for (const name of ['arrow', 'trident']) {
  test.serial(`self-defense: a hit attributed to the ${name} entity → only a note event; no lease, no movement, no attack`, async (t) => {
    const clock = useClock(t);
    const projectile: FakeEntity = { ...mob(name, 3), type: 'projectile', height: 0.5, width: 0.5 };
    const world = createWorld({ entities: [projectile] });
    const { engine, holder, stopBody, reflexEvents } = createEngine(t, world);

    hitBy(engine, projectile, name);
    engine.tick();
    t.is(holder(), null, 'the body is not taken');
    await clock.tickAsync(500);

    t.true(world.bot.attack.notCalled);
    t.true(world.bot.setControlState.notCalled, 'no running away either');
    t.true(stopBody.notCalled);
    const events = reflexEvents();
    t.is(events.length, 1);
    t.regex(events[0] ?? '', /^self-defense: /);
  });
}

test.serial('self-defense, stance auto: a neutral attacker that may be fought (avoidNeutral off) counts toward the hostiles', async (t) => {
  const clock = useClock(t);
  const outcome = async (zombies: number) => {
    const golem = neutral('iron_golem', 2);
    const others = Array.from({ length: zombies }, (_, i) => mob('zombie', 4 + i, 3));
    const world = createWorld({ entities: [golem, ...others] });
    const { engine, policy, holder } = createEngine(t, world);
    t.true(policy.update({ combat: { avoidNeutral: false } }, 'llm').ok);
    hitBy(engine, golem);
    engine.tick();
    const started = holder()?.holder;
    await clock.tickAsync(300);
    engine.stop();
    if (started !== 'reflex self-defense') return 'none';
    if (world.bot.attack.called) return 'fight';
    return world.bot.setControlState.calledWith('forward', true) ? 'flee' : 'none';
  };

  t.is(await outcome(1), 'fight', 'health 20, the golem and one zombie: 2 hostiles');
  t.is(await outcome(2), 'flee', 'health 20, the golem and two zombies: 3 hostiles');
});

// -- fix 8: stale metadata after a respawn ---------------------------------------------------------------------------

test.serial('after a death, the next spawn clears the stale burning flag and refills the air; other spawns leave the metadata alone', async (t) => {
  const clock = useClock(t);
  const INVISIBLE = 0x20;
  // Burning with little air: values the server would not resend after a respawn, and that the instinct reads.
  const world = createWorld({ selfMetadata: [ON_FIRE | INVISIBLE, 30] });
  const { engine } = createEngine(t, world);
  engine.start();

  world.bot.emit('spawn');
  t.deepEqual(world.self.metadata, [ON_FIRE | INVISIBLE, 30], 'a spawn without a death changes nothing');

  world.bot.health = 0;
  world.bot.emit('death');
  t.deepEqual(world.self.metadata, [ON_FIRE | INVISIBLE, 30], 'the death itself leaves the metadata alone');
  await clock.tickAsync(1100);
  world.bot.health = 20;
  world.bot.emit('spawn');

  t.is(world.self.metadata[0], INVISIBLE, 'the burning bit is cleared; the other flags stay');
  t.is(world.self.metadata[1], 300, 'full air');

  // A later spawn (a dimension change) without a new death leaves fresh values alone.
  world.self.metadata[0] = ON_FIRE;
  world.self.metadata[1] = 45;
  world.bot.emit('spawn');
  t.deepEqual(world.self.metadata, [ON_FIRE, 45]);

  // A stopped engine no longer touches the metadata, even after another death.
  engine.stop();
  world.bot.emit('death');
  world.bot.emit('spawn');
  t.deepEqual(world.self.metadata, [ON_FIRE, 45]);
});

// Final review: self-defense stays out of a fight the bot is already having with that mob (a guard or hunt task's own
// engage). Otherwise a bitten hunter would flee from the wolf it hunts, and a guard would lose its kill report.
test.serial('self-defense ignores a hit from the mob the bot is already fighting', async (t) => {
  const clock = useClock(t);
  const wolf = neutral('wolf', 2);
  const world = createWorld({ entities: [wolf] });
  const { engine, holder, reflexEvents } = createEngine(t, world);
  const controller = new AbortController();
  const fight = engage(world.bot as never, wolf as never, { signal: controller.signal, rules: { allowTypes: ['wolf'] } });

  await clock.tickAsync(TICK);
  hitBy(engine, wolf);
  engine.tick();
  t.is(holder(), null, 'self-defense does not take the body');
  t.false(reflexEvents().some(message => message.startsWith('self-defense')), 'not even a note');

  controller.abort();
  await clock.tickAsync(TICK);
  await fight;
  hitBy(engine, wolf);
  engine.tick();
  t.deepEqual(holder(), { holder: 'reflex self-defense', priority: PRIORITY.INSTINCT }, 'once that fight is over it reacts again');
});

// ---- M5: self-defense 'auto' stance with the combat judge (F-013, F-016; I1, I5, I6) ------------------------------
// The rule acts at once; the decision model, asked in the background, may switch the mode to fight, flee or hold.

type Judge = sinon.SinonSpy<[number, CombatSituation], Promise<CombatJudgment>>;

/** A judge the test answers by hand: every call returns a promise that stays pending until `answer`. */
function manualJudge() {
  const pending: { resolve: (judgment: CombatJudgment) => void; reject: (error: Error) => void }[] = [];
  const judge: Judge = sinon.spy((_attackerId: number, _situation: CombatSituation) =>
    new Promise<CombatJudgment>((resolve, reject) => { pending.push({ resolve, reject }); }));
  return {
    judge,
    answer: (judgment: CombatJudgment, call = 0) => pending[call].resolve(judgment),
    fail: (error: Error, call = 0) => pending[call].reject(error)
  };
}

const modelSays = (stance: 'fight' | 'flee' | 'hold', probability = 0.9): CombatJudgment =>
  ({ source: 'model', stance, probability, detail: 'test/decider-1; 80ms' });

/** What armorPoints() reads from a real bot: the equipment slots (all empty here). */
function withEquipment(world: World): World {
  Object.assign(world.bot.inventory, { slots: [] as unknown[] });
  const slots: Record<string, number> = { head: 5, torso: 6, legs: 7, feet: 8 };
  Object.assign(world.bot, { getEquipmentDestSlot: (destination: string) => slots[destination] });
  return world;
}

function kill(world: World, entity: FakeEntity): void {
  entity.isValid = false;
  delete world.entities[entity.id];
}

/** Calls of a spy made after the first `from` calls. */
function callsSince<A extends unknown[], R>(spy: sinon.SinonSpy<A, R>, from: number) {
  return spy.getCalls().slice(from);
}

test.serial('self-defense, stance auto: fights at once by the rule; a later "flee 0.9" stops attacking, stops the body and runs away', async (t) => {
  const clock = useClock(t);
  const zombie: FakeEntity & { displayName: string } = { ...mob('zombie', 2), displayName: 'Bob the Zombie' };
  const steve: FakeEntity = { ...player('Steve', 0), position: new Vec3(0.5, 64, 8.5) };
  const world = withEquipment(createWorld({ health: 20, entities: [zombie, steve] }));
  const { judge, answer } = manualJudge();
  const { engine, holder, lastReflexEvent, startGame } = createEngine(t, world, REFLEXES, { judgeCombat: judge });
  startGame();

  hitBy(engine, zombie);
  await clock.tickAsync(TICK);
  t.deepEqual(holder(), { holder: 'reflex self-defense', priority: PRIORITY.INSTINCT });
  t.true(judge.calledOnce, 'the judge is asked once, in the background');
  const [attackerId, situation] = judge.firstCall.args;
  t.is(attackerId, zombie.id);
  t.is(situation.attacker.type, 'zombie');
  t.is(situation.health, 20);
  t.true(situation.hostiles.every(hostile => hostile.type === 'zombie'));
  const json = JSON.stringify(situation);
  t.false(json.includes('Bob'), 'no custom names reach the model');
  t.false(json.includes('Steve'), 'no player names reach the model');

  await clock.tickAsync(300);
  t.true(world.bot.attack.calledWith(sinon.match({ id: zombie.id })), 'the rule (fight at health 20, one zombie) runs while the judge thinks');

  const attacks = world.bot.attack.callCount;
  const stops = world.pathfinder.stop.callCount;
  const goalsSet = world.pathfinder.setGoal.callCount;
  const clears = world.bot.clearControlStates.callCount;
  answer(modelSays('flee'));
  await clock.tickAsync(TICK * 2);

  t.true(world.pathfinder.stop.callCount > stops, 'the pathfinder is stopped on the switch');
  t.true(callsSince(world.pathfinder.setGoal, goalsSet).some(call => call.args[0] === null), 'its goal is cleared');
  t.true(world.bot.clearControlStates.callCount > clears, 'the control states are cleared');

  await clock.tickAsync(500);
  t.is(world.bot.attack.callCount, attacks, 'no more attacks after the switch');
  t.true(world.controls.forward, 'running');
  t.true(facing(world, zombie.position) <= -0.7, 'away from the zombie');
  t.true(distanceTo(world, zombie) > 3, `got further away (${distanceTo(world, zombie).toFixed(1)})`);

  await clock.tickAsync(4000);
  t.is(holder(), null, 'the reflex ended');
  t.is(world.bot.attack.callCount, attacks);
  t.true(distanceTo(world, zombie) >= 16, `16+ blocks away (${distanceTo(world, zombie).toFixed(1)})`);
  const event = lastReflexEvent('self-defense') ?? '';
  t.regex(event, resultFormat('self-defense'));
  t.regex(event, /\(flee by model p=0\.90\) \(\d+\.\ds\)$/);
});

const UNANSWERED: { label: string; settle: (judge: ReturnType<typeof manualJudge>) => void }[] = [
  { label: 'never answers', settle: () => {} },
  { label: 'falls back to the rule (decision timeout)', settle: judge => judge.answer({ source: 'rule', reason: 'decision timeout' }) },
  { label: 'throws', settle: judge => judge.fail(new Error('network down')) }
];

for (const { label, settle } of UNANSWERED) {
  test.serial(`self-defense, stance auto: a judge that ${label} leaves the rule action running to the end (I5)`, async (t) => {
    const clock = useClock(t);
    const zombie = mob('zombie', 2);
    const world = withEquipment(createWorld({ health: 20, entities: [zombie] }));
    const judge = manualJudge();
    const { engine, holder, lastReflexEvent } = createEngine(t, world, REFLEXES, { judgeCombat: judge.judge });

    hitBy(engine, zombie);
    engine.tick();
    t.deepEqual(holder(), { holder: 'reflex self-defense', priority: PRIORITY.INSTINCT });
    t.true(judge.judge.calledOnce);
    await clock.tickAsync(150);
    settle(judge);
    await clock.tickAsync(300);
    t.true(world.bot.attack.calledWith(sinon.match({ id: zombie.id })), 'fights back by the rule');
    t.false(world.bot.setControlState.calledWith('forward', true), 'does not run');

    kill(world, zombie);
    await clock.tickAsync(200);
    t.is(holder(), null, 'the reflex finished');
    const event = lastReflexEvent('self-defense') ?? '';
    t.regex(event, resultFormat('self-defense'));
    t.regex(event, /killed/);
    t.regex(event, /\(fight by rule\) \(\d+\.\ds\)$/);
  });
}

test.serial('self-defense, stance auto: an answer that arrives after the reflex ended changes nothing', async (t) => {
  const clock = useClock(t);
  const zombie = mob('zombie', 2);
  const world = withEquipment(createWorld({ health: 20, entities: [zombie] }));
  const { judge, answer } = manualJudge();
  const { engine, holder, reflexEvents, lastReflexEvent, startGame } = createEngine(t, world, REFLEXES, { judgeCombat: judge });
  startGame();

  hitBy(engine, zombie);
  await clock.tickAsync(TICK);
  t.deepEqual(holder(), { holder: 'reflex self-defense', priority: PRIORITY.INSTINCT });
  // The fake zombie never gets hurt, so the fight gives up after a while with the zombie still standing next to the bot.
  await clock.tickAsync(11_000);
  t.is(holder(), null, 'the reflex ended');
  t.truthy(world.entities[zombie.id], 'the zombie is still there');
  t.regex(lastReflexEvent('self-defense') ?? '', /\(fight by rule\)/);

  const controls = world.bot.setControlState.callCount;
  const goalsSet = world.pathfinder.setGoal.callCount;
  const attacks = world.bot.attack.callCount;
  const position = world.self.position.clone();
  const events = reflexEvents().length;
  answer(modelSays('flee'));
  await clock.tickAsync(1000);

  t.false(callsSince(world.bot.setControlState, controls).some(call => call.args[1] === true), 'no movement afterwards');
  t.is(world.pathfinder.setGoal.callCount, goalsSet, 'no pathfinder goal afterwards');
  t.is(world.bot.attack.callCount, attacks);
  t.true(world.self.position.equals(position), 'the bot did not move');
  t.is(holder(), null, 'the body is not taken again');
  t.is(reflexEvents().length, events, 'no new reflex event');
});

test.serial('self-defense, stance auto: an answer equal to the rule (fight) does not switch; the fight goes on', async (t) => {
  const clock = useClock(t);
  const zombie = mob('zombie', 2);
  const world = withEquipment(createWorld({ health: 20, entities: [zombie] }));
  const { judge, answer } = manualJudge();
  const { engine, holder, lastReflexEvent } = createEngine(t, world, REFLEXES, { judgeCombat: judge });

  hitBy(engine, zombie);
  engine.tick();
  await clock.tickAsync(300);
  const attacks = world.bot.attack.callCount;
  t.true(attacks > 0);
  const stops = world.pathfinder.stop.callCount;
  const clears = world.bot.clearControlStates.callCount;

  answer(modelSays('fight'));
  await clock.tickAsync(600);

  t.true(world.bot.attack.callCount > attacks, 'keeps attacking');
  t.is(world.pathfinder.stop.callCount, stops, 'the body is not stopped');
  t.is(world.bot.clearControlStates.callCount, clears, 'the controls are not cleared');
  t.false(world.bot.setControlState.calledWith('forward', true), 'does not run');
  t.deepEqual(holder(), { holder: 'reflex self-defense', priority: PRIORITY.INSTINCT });

  kill(world, zombie);
  await clock.tickAsync(200);
  t.is(holder(), null);
  t.regex(lastReflexEvent('self-defense') ?? '', /\(fight by model p=0\.90\) \(\d+\.\ds\)$/);
});

test.serial('self-defense, stance auto: "hold" → does not chase a zombie 6 blocks away, does not run, and hits it once within reach', async (t) => {
  const clock = useClock(t);
  const zombie = mob('zombie', 6);
  const world = withEquipment(createWorld({ health: 20, entities: [zombie] }));
  const { judge, answer } = manualJudge();
  const { engine, holder, lastReflexEvent, startGame } = createEngine(t, world, REFLEXES, { judgeCombat: judge });
  startGame();

  hitBy(engine, zombie);
  await clock.tickAsync(TICK);
  t.deepEqual(holder(), { holder: 'reflex self-defense', priority: PRIORITY.INSTINCT });
  t.true(world.pathfinder.goal instanceof goals.GoalFollow, 'the rule is chasing before the judge answers');
  answer(modelSays('hold'));
  await clock.tickAsync(TICK * 2);

  const goalsSet = world.pathfinder.setGoal.callCount;
  const controls = world.bot.setControlState.callCount;
  const position = world.self.position.clone();
  t.is(world.pathfinder.goal, null, 'the rule\'s chase goal is cleared on the switch');
  await clock.tickAsync(1000);

  t.false(callsSince(world.pathfinder.setGoal, goalsSet).some(call => call.args[0] !== null), 'no chase goal');
  t.is(world.pathfinder.goal, null);
  t.false(callsSince(world.bot.setControlState, controls).some(call => call.args[1] === true), 'no running or walking');
  t.true(world.self.position.equals(position), 'stands still');
  t.true(world.bot.attack.notCalled, 'out of reach: no attack');
  t.deepEqual(holder(), { holder: 'reflex self-defense', priority: PRIORITY.INSTINCT }, 'still holding its ground');

  zombie.position = new Vec3(2.5, 64, 0.5);
  await clock.tickAsync(500);
  t.true(world.bot.attack.calledWith(sinon.match({ id: zombie.id })), 'hits it within reach');
  t.false(callsSince(world.pathfinder.setGoal, goalsSet).some(call => call.args[0] !== null), 'still no chase goal');
  t.true(world.self.position.equals(position), 'still in place');

  kill(world, zombie);
  await clock.tickAsync(200);
  t.is(holder(), null);
  t.regex(lastReflexEvent('self-defense') ?? '', /\(hold by model p=0\.90\) \(\d+\.\ds\)$/);
});

for (const stance of ['fight', 'flee'] as const) {
  test.serial(`self-defense, stance ${stance} (not auto): the combat judge is never asked`, async (t) => {
    const clock = useClock(t);
    const zombie = mob('zombie', 2);
    const world = withEquipment(createWorld({ health: 20, entities: [zombie] }));
    const { judge } = manualJudge();
    const { engine, policy, holder } = createEngine(t, world, REFLEXES, { judgeCombat: judge });
    t.true(policy.update({ reflexes: { selfDefense: { stance } } }, 'llm').ok);

    hitBy(engine, zombie);
    engine.tick();
    t.deepEqual(holder(), { holder: 'reflex self-defense', priority: PRIORITY.INSTINCT });
    await clock.tickAsync(500);

    t.true(judge.notCalled);
    if (stance === 'fight') t.true(world.bot.attack.called);
    else t.true(world.bot.setControlState.calledWith('forward', true));
  });
}

const NEVER_JUDGED: { label: string; attacker: () => FakeEntity; type?: string }[] = [
  { label: 'a player', attacker: () => player('Steve', 2), type: 'player_attack' },
  { label: 'a tamed wolf', attacker: () => tamedWolf(2) },
  { label: 'an iron golem (neutral, default policy)', attacker: () => neutral('iron_golem', 2) }
];

for (const { label, attacker, type } of NEVER_JUDGED) {
  test.serial(`self-defense, stance auto: hit by ${label} → the combat judge is never asked (I1)`, async (t) => {
    const clock = useClock(t);
    const entity = attacker();
    const world = withEquipment(createWorld({ health: 20, entities: [entity] }));
    const { judge } = manualJudge();
    const { engine, policy, lastReflexEvent, startGame } = createEngine(t, world, REFLEXES, { judgeCombat: judge });
    t.is(policy.get().reflexes.selfDefense.stance, 'auto');
    startGame();

    hitBy(engine, entity, type);
    await clock.tickAsync(4000);

    t.true(judge.notCalled, 'such cases never reach the model');
    t.true(world.bot.attack.notCalled, 'never attacked');
    if (entity.name === 'iron_golem') t.regex(lastReflexEvent('self-defense') ?? '', /\(flee by policy\)/);
  });
}

test.serial('I6: no reflex trigger calls the combat judge; only self-defense\'s run gets it, and the tick does not wait for it', async (t) => {
  useClock(t);
  const zombieNear = mob('zombie', 2);
  const scenarios: { name: ReflexName; world: World; before?: (engine: ReflexEngine) => void }[] = [
    { name: 'creeper-evade', world: createWorld({ entities: [ignitedCreeper(4)] }) },
    { name: 'low-health-retreat', world: createWorld({ health: 5, entities: [mob('zombie', 10)] }) },
    { name: 'self-defense', world: createWorld({ entities: [zombieNear] }), before: engine => hitBy(engine, zombieNear) },
    { name: 'auto-eat', world: createWorld({ food: 10, inventory: [item('bread')] }) }
  ];

  for (const { name, world, before } of scenarios) {
    withEquipment(world);
    const original = REFLEXES.find(reflex => reflex.name === name)!;
    const trigger = sinon.spy(original.trigger);
    const run = sinon.spy((_context: ReflexRunContext) => new Promise<string>(() => {}));
    const { judge } = manualJudge();
    const { engine } = createEngine(t, world, [{ ...original, trigger, run }], { judgeCombat: judge });
    before?.(engine);

    engine.tick();

    t.true(trigger.calledOnce, `${name} was evaluated`);
    t.true(run.calledOnce, `${name} fired`);
    t.true(judge.notCalled, `${name}: evaluating the trigger never asks the judge`);
    t.is(run.firstCall.args[0].judgeCombat, judge, `${name}: the run context carries the judge`);
    engine.stop('scenario done');
  }

  // With the real self-defense run, the judge is asked from the run, and the tick returns without waiting for it.
  const zombie = mob('zombie', 2);
  const world = withEquipment(createWorld({ entities: [zombie] }));
  const original = REFLEXES.find(reflex => reflex.name === 'self-defense')!;
  const trigger = sinon.spy(original.trigger);
  const { judge } = manualJudge();
  const { engine, holder } = createEngine(t, world, [{ ...original, trigger }], { judgeCombat: judge });
  hitBy(engine, zombie);

  t.is(engine.tick(), undefined);
  t.true(judge.calledOnce);
  t.true(trigger.calledBefore(judge), 'the trigger ran first and did not ask');
  t.deepEqual(holder(), { holder: 'reflex self-defense', priority: PRIORITY.INSTINCT }, 'the rule action started while the judge has not answered');
});

// ---- M7: death ends the task (F-012, F-001) --------------------------------------------------------------------
// Expected from the M7 contract: the engine's onDeath runs before the running reflex lets go of the body, so a task
// the reflex paused is cancelled instead of being resumed after the bot died.

/** createEngine plus a real TaskManager, with onDeath wired the way autopilot.ts wires it. */
function createWiredEngine(t: ExecutionContext, world: World, reflexes: ReflexDefinition[]) {
  let tasks: TaskManager | null = null;
  let harness: ReturnType<typeof createEngine> | null = null;
  // What onDeath saw when it was called: who held the body, whether the reflex was already aborted, the task's status.
  const seen: { holder: string | null; task: string | null }[] = [];
  const onDeath = sinon.stub().callsFake(() => {
    seen.push({ holder: harness?.holder()?.holder ?? null, task: tasks?.currentTask()?.status ?? null });
    void tasks?.cancelAll('the bot died');
  });
  harness = createEngine(t, world, reflexes, { onDeath });
  tasks = createTasks(t, world, harness);
  const taskMessages = () => harness!.events.query({ limit: 200 }).events
    .filter(event => event.type.startsWith('task_')).map(event => `${event.type} ${event.message}`);
  return { ...harness, tasks, onDeath, seen, taskMessages };
}

test.serial('M7: death while a critical reflex has the task paused → onDeath runs before the reflex lets go; the task is cancelled and never resumes', async (t) => {
  const clock = useClock(t);
  const world = createWorld();
  const creeper = scripted('creeper-evade', PRIORITY.URGENT_INSTINCT, { result: null });
  const { engine, tasks, holder, taskEvents, taskMessages, onDeath, seen } = createWiredEngine(t, world, [creeper.definition]);
  engine.start();
  t.true((await tasks.start('idle', {})).ok);

  creeper.result = { fire: 'creeper about to explode' };
  world.bot.emit('physicsTick');
  t.is(tasks.currentTask()?.status, 'paused');
  t.deepEqual(holder(), { holder: 'reflex creeper-evade', priority: PRIORITY.URGENT_INSTINCT });

  let abortedAtDeath: boolean | undefined;
  onDeath.callsFake(() => {
    abortedAtDeath = creeper.signals[0].aborted;
    seen.push({ holder: holder()?.holder ?? null, task: tasks.currentTask()?.status ?? null });
    void tasks.cancelAll('the bot died');
  });
  world.bot.health = 0;
  world.bot.emit('death');

  t.true(onDeath.calledOnce);
  t.deepEqual(seen, [{ holder: 'reflex creeper-evade', task: 'paused' }], 'the reflex still held the body and the task was still paused');
  t.false(abortedAtDeath, 'onDeath ran before the reflex was aborted');
  t.true(creeper.signals[0].aborted, 'then the reflex is aborted');
  t.is(holder(), null);
  t.deepEqual(taskEvents(), ['task_started', 'task_paused', 'task_cancelled'], 'cancelled at once, with no task_resumed in between');
  t.is(taskMessages().at(-1), 'task_cancelled t1 idle: cancelled (the bot died)');

  // Respawn: nothing comes back.
  await clock.tickAsync(1500);
  creeper.result = null;
  world.bot.health = 20;
  world.bot.emit('spawn');
  for (let i = 0; i < 5; i++) {
    world.bot.emit('physicsTick');
    await clock.tickAsync(TICK);
  }
  t.deepEqual(taskEvents(), ['task_started', 'task_paused', 'task_cancelled'], 'no task_resumed after the respawn');
  t.is(tasks.currentTask(), null);
  t.is(holder(), null);
});

test.serial('M7: death with no reflex running cancels the running task (the bot died)', async (t) => {
  useClock(t);
  const world = createWorld();
  const creeper = scripted('creeper-evade', PRIORITY.URGENT_INSTINCT, { result: null });
  const { engine, tasks, holder, taskMessages } = createWiredEngine(t, world, [creeper.definition]);
  engine.start();
  t.true((await tasks.start('idle', {})).ok);

  world.bot.health = 0;
  world.bot.emit('death');

  t.is(tasks.currentTask(), null);
  t.deepEqual(taskMessages().map(message => message.split(' ')[0]), ['task_started', 'task_cancelled']);
  t.is(taskMessages().at(-1), 'task_cancelled t1 idle: cancelled (the bot died)');
  t.is(holder(), null);
});
