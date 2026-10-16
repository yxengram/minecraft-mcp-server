// Contract: docs/BLUEPRINT.md F-035. Pause-aware building blocks shared by the work behaviors.
//
// When a reflex or a manual command takes the body, the arbiter stops the pathfinder, which makes a running
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
