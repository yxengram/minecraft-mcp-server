// Contract: docs/BLUEPRINT.md F-035. Pause-aware building blocks shared by the work behaviors.
//
// When the instinct or a manual command takes the body, the arbiter stops the pathfinder, which makes a running
// `pathfinder.goto` reject. Without these helpers a behavior would count that as a failed step (and, for example,
// skip a perfectly good block). Here an interrupted step waits until the task runs again and is retried.
import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import type { BehaviorContext, BehaviorServices } from '../task-manager.js';
import { delay } from '../task-manager.js';
import type { Waypoint } from '../../waypoint-store.js';
import { stopPathfinder } from '../../tools/movement-utils.js';

type Goal = InstanceType<typeof goals.Goal>;
export type StepContext = Pick<BehaviorContext<unknown, unknown>, 'bot' | 'signal' | 'isPaused' | 'waitUntilRunning'>;

const WATCH_INTERVAL_MS = 50;
const DROP_SETTLE_MS = 300;
const PICKUP_SETTLE_MS = 150;
const DROP_PICKUP_RADIUS = 5;
const MAX_DROPS = 4;

/** Thrown when a behavior's own time limit runs out, so it can stop with a partial result. */
export class DeadlineReached extends Error {
  constructor() {
    super('time limit reached');
  }
}

/** Resolves once the task runs again. Returns false if `deadline` passed first; rethrows cancellation. */
export async function waitWhilePaused(ctx: StepContext, deadline = Infinity): Promise<boolean> {
  while (ctx.isPaused()) {
    ctx.signal.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    if (remaining === Infinity) {
      await ctx.waitUntilRunning();
    } else {
      // Poll so the deadline still counts while paused (collect-block waits on this task).
      await delay(Math.min(remaining, 250), ctx.signal);
    }
  }
  ctx.signal.throwIfAborted();
  return Date.now() <= deadline;
}

/**
 * Runs one body action. If the task is paused or cancelled meanwhile, `onInterrupt` stops the action
 * (e.g. bot.stopDigging) and the result is `{ done: false }` so the caller can wait and retry the same step.
 * Cancellation is rethrown; real failures are rethrown as they are.
 */
export async function interruptible<T>(ctx: StepContext, action: () => Promise<T>, onInterrupt?: () => void): Promise<{ done: true; value: T } | { done: false }> {
  let interrupted = false;
  const watcher = setInterval(() => {
    if (!interrupted && (ctx.isPaused() || ctx.signal.aborted)) {
      interrupted = true;
      try {
        onInterrupt?.();
      } catch {
        // The action is ending anyway.
      }
    }
  }, WATCH_INTERVAL_MS);

  try {
    return { done: true, value: await action() };
  } catch (error) {
    ctx.signal.throwIfAborted();
    if (ctx.isPaused()) return { done: false };
    throw error;
  } finally {
    clearInterval(watcher);
  }
}

/** Walks to `goal`, waiting out pauses and retrying. Throws DeadlineReached once `deadline` passes. */
export async function walkTo(ctx: StepContext, goal: Goal, deadline = Infinity): Promise<void> {
  for (;;) {
    if (!(await waitWhilePaused(ctx, deadline))) throw new DeadlineReached();
    const attempt = await interruptible(ctx, () => withDeadline(ctx.bot, ctx.bot.pathfinder.goto(goal), deadline));
    if (attempt.done) return;
  }
}

function withDeadline<T>(bot: mineflayer.Bot, promise: Promise<T>, deadline: number): Promise<T> {
  if (deadline === Infinity) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      stopPathfinder(bot);
      reject(new DeadlineReached());
    }, Math.max(0, deadline - Date.now()));
  });
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Walks over the item drops near `around` so they get picked up. Missing drops are not an error. */
export async function collectNearbyDrops(ctx: StepContext, around: Vec3, deadline = Infinity): Promise<void> {
  await delay(DROP_SETTLE_MS, ctx.signal);
  const drops = Object.values(ctx.bot.entities ?? {})
    .filter(entity => entity.name === 'item' && entity.position.distanceTo(around) <= DROP_PICKUP_RADIUS)
    .sort((a, b) => a.position.distanceTo(around) - b.position.distanceTo(around))
    .slice(0, MAX_DROPS);

  for (const drop of drops) {
    try {
      await walkTo(ctx, new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0), deadline);
      await delay(PICKUP_SETTLE_MS, ctx.signal);
    } catch (error) {
      ctx.signal.throwIfAborted();
      if (error instanceof DeadlineReached) return;
      // The drop may have despawned or been picked up already.
    }
  }
}

export interface ResolvedWaypoint {
  name: string;
  waypoint: Waypoint;
  position: Vec3;
}

/** A saved waypoint in the bot's current dimension, or the reason it cannot be used. */
export function resolveWaypoint(bot: mineflayer.Bot, services: BehaviorServices, name: string): { error: string } | { value: ResolvedWaypoint } {
  const store = services.waypoints;
  if (!store) return { error: 'Waypoints are not available' };
  const key = store.normalizeName(name);
  let waypoint: Waypoint | undefined;
  try {
    waypoint = store.get(name);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (!waypoint) return { error: `No waypoint named '${key}'` };

  const dimension = bot.game?.dimension;
  if (waypoint.dimension && dimension && waypoint.dimension !== dimension) {
    return { error: `Waypoint '${key}' is in ${waypoint.dimension} but the bot is in ${dimension}` };
  }
  return { value: { name: key, waypoint, position: new Vec3(waypoint.x, waypoint.y, waypoint.z) } };
}

// ---------------------------------------------------------------- loot (E-014)

const SOURCE_RADIUS = 2;
const SOURCE_WINDOW_MS = 2000;
// Drops are kept this long for a source noted late (a mob is removed about 20 ticks after its drops appear).
const RECENT_KEEP_MS = 10000;
const WORN_OUT_DURABILITY = 2;
const BREAK_CHECK_MS = 250;

type ItemLike = { name: string; count: number; maxDurability?: number; durabilityUsed?: number | null };
type DropEntity = { id: number; name?: string; position: Vec3; isValid?: boolean; getDroppedItem?: () => ItemLike | null };

export interface LootWatch {
  /** Items appearing within 2 blocks of `pos` and 2 s of `at` (default now; before or after) are drops the task got. */
  noteSource(pos: Vec3, at?: number): void;
  /** Item name → count picked up by the bot since the watch started. */
  pickedUp(): Map<string, number>;
  /** Item name → count of noted drops still lying on the ground (not picked up by the bot). */
  leftOnGround(): Map<string, number>;
  /** Names of tools that broke, in order. */
  brokenTools(): string[];
  /** Removes the listeners; a tool that may just have broken is checked now. */
  stop(): void;
}

function droppedItem(entity: DropEntity | undefined): ItemLike | null {
  try {
    return entity?.getDroppedItem?.() ?? null;
  } catch {
    return null;
  }
}

function remainingDurability(item: ItemLike): number | null {
  if (!item.maxDurability || item.maxDurability <= 0) return null;
  return item.maxDurability - (item.durabilityUsed ?? 0);
}

type Emitter = { on?: (event: string, listener: (...args: never[]) => void) => void; removeListener?: (event: string, listener: (...args: never[]) => void) => void };

/**
 * Records what a work task picks up, which of its drops it leaves behind and which tools wear out (E-014). The
 * inventory's net change is not that: blocks the pathfinder places on the way count against it.
 */
export function watchLoot(bot: mineflayer.Bot, { onBroken }: { onBroken?: (tool: string) => void } = {}): LootWatch {
  const picked = new Map<string, number>();
  const sources: { pos: Vec3; time: number }[] = [];
  const recent: { entity: DropEntity; pos: Vec3; time: number }[] = [];
  const noted = new Map<number, DropEntity>();
  // The collect packet carries the stack's count from before the pickup, even when a full inventory took only part
  // of it; what was really taken shows once the entity is gone or its count drops.
  const pending = new Map<number, { entity: DropEntity; name: string; before: number }>();
  const broken: string[] = [];
  const pendingChecks = new Map<ReturnType<typeof setTimeout>, ItemLike>();
  let died = false;
  const add = (map: Map<string, number>, name: string, count: number) => map.set(name, (map.get(name) ?? 0) + count);
  const near = (pos: Vec3, time: number, source: { pos: Vec3; time: number }) =>
    Math.abs(source.time - time) <= SOURCE_WINDOW_MS && source.pos.distanceTo(pos) <= SOURCE_RADIUS;
  const gone = (entity: DropEntity) => bot.entities?.[entity.id] !== entity || entity.isValid === false;

  /** Settles pickups whose outcome is known; `final` counts the rest as whole pickups. */
  const settle = (final = false, goneId?: number) => {
    for (const [id, pickup] of pending) {
      // mineflayer emits entityGone before it marks the entity invalid.
      const now = id === goneId || gone(pickup.entity) ? 0 : droppedItem(pickup.entity)?.count ?? 0;
      if (now >= pickup.before && !final) continue;
      const taken = now < pickup.before ? pickup.before - now : pickup.before;
      add(picked, pickup.name, taken);
      pending.delete(id);
      if (now === 0 || now >= pickup.before) noted.delete(id);
    }
  };

  const onCollect = (packet: { collectedEntityId: number; collectorEntityId: number }) => {
    if (packet.collectorEntityId !== bot.entity?.id) return;
    const entity = bot.entities?.[packet.collectedEntityId] as DropEntity | undefined;
    if (entity?.name !== 'item' || pending.has(entity.id)) return;
    const item = droppedItem(entity);
    if (item) pending.set(entity.id, { entity, name: item.name, before: item.count });
  };

  // mineflayer emits itemDrop when an item entity's metadata arrives, again when its count changes.
  const onItemDrop = (entity: DropEntity) => {
    if (!entity?.position) return;
    if (pending.has(entity.id)) settle();
    if (noted.has(entity.id)) return;
    const now = Date.now();
    const pos = entity.position.clone();
    if (sources.some(source => near(pos, now, source))) {
      noted.set(entity.id, entity);
      return;
    }
    recent.push({ entity, pos, time: now });
    while (recent.length > 0 && now - recent[0].time > RECENT_KEEP_MS) recent.shift();
  };
  const onEntityGone = (entity: DropEntity) => {
    if (entity && pending.has(entity.id)) settle(false, entity.id);
  };

  const onUpdateSlot = (_slot: number, oldItem: ItemLike | null, newItem: ItemLike | null) => {
    if (died || !oldItem || (newItem && newItem.name === oldItem.name)) return;
    const remaining = remainingDurability(oldItem);
    if (remaining === null || remaining > WORN_OUT_DURABILITY) return;
    // Equipping or moving the tool also empties its old slot: it broke only if it is nowhere in the inventory now.
    const timer = setTimeout(() => {
      pendingChecks.delete(timer);
      checkBroken(oldItem);
    }, BREAK_CHECK_MS);
    pendingChecks.set(timer, oldItem);
  };
  const checkBroken = (oldItem: ItemLike) => {
    // Dying empties the inventory too: nothing broke.
    if (died || (typeof bot.health === 'number' && bot.health <= 0)) return;
    const used = oldItem.durabilityUsed ?? 0;
    const stillThere = (bot.inventory?.items?.() ?? []).some((item: ItemLike) => item.name === oldItem.name && (item.durabilityUsed ?? 0) >= used);
    if (stillThere) return;
    broken.push(oldItem.name);
    onBroken?.(oldItem.name);
  };
  const onDeath = () => {
    died = true;
    for (const timer of pendingChecks.keys()) clearTimeout(timer);
    pendingChecks.clear();
  };

  const client = bot._client as unknown as Emitter | undefined;
  const inventory = bot.inventory as unknown as Emitter | undefined;
  client?.on?.('collect', onCollect);
  bot.on?.('itemDrop', onItemDrop as never);
  bot.on?.('entityGone', onEntityGone as never);
  bot.on?.('death', onDeath);
  inventory?.on?.('updateSlot', onUpdateSlot);

  return {
    noteSource(pos, at = Date.now()) {
      const source = { pos: pos.clone(), time: at };
      sources.push(source);
      for (const drop of recent) {
        if (near(drop.pos, drop.time, source)) noted.set(drop.entity.id, drop.entity);
      }
    },
    pickedUp() {
      settle();
      return new Map(picked);
    },
    leftOnGround() {
      settle();
      const left = new Map<string, number>();
      for (const entity of noted.values()) {
        if (gone(entity) || pending.has(entity.id)) continue;
        const item = droppedItem(entity);
        if (item) add(left, item.name, item.count);
      }
      return left;
    },
    brokenTools: () => [...broken],
    stop() {
      client?.removeListener?.('collect', onCollect);
      bot.removeListener?.('itemDrop', onItemDrop as never);
      bot.removeListener?.('entityGone', onEntityGone as never);
      bot.removeListener?.('death', onDeath);
      inventory?.removeListener?.('updateSlot', onUpdateSlot);
      for (const [timer, oldItem] of pendingChecks) {
        clearTimeout(timer);
        checkBroken(oldItem);
      }
      pendingChecks.clear();
      settle(true);
    }
  };
}

/** "picked up 12 item(s) (10 raw_iron, 2 cobblestone)", most first; "picked up nothing". */
export function describeLoot(watch: LootWatch): string {
  const list = (map: Map<string, number>) => [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => `${count} ${name}`)
    .join(', ');
  const total = (map: Map<string, number>) => [...map.values()].reduce((sum, count) => sum + count, 0);

  const picked = watch.pickedUp();
  let text = picked.size > 0 ? `picked up ${total(picked)} item(s) (${list(picked)})` : 'picked up nothing';
  const left = watch.leftOnGround();
  if (left.size > 0) text += `; left ${total(left)} item(s) on the ground (${list(left)})`;
  for (const tool of watch.brokenTools()) text += `; ${tool} broke`;
  return text;
}
