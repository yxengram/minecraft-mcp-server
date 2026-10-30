import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import { REPLY_MARGIN_MS, STOP_SETTLE_MS, ToolFactory, allowFor, defaultLimitMs, stopBody, type ToolContext } from '../tool-factory.js';
import { formatStat } from '../format.js';
import { coerceCoordinates } from './coordinate-utils.js';
import {
  AbortError, MoveTimeout, PORTAL_WAIT_MS, abortError, gotoWithTimeout, stopPathfinder, arrivalProblem, portalReport, throwIfAborted,
  watchPathEdits
} from './movement-utils.js';
import type { Autopilot } from '../autopilot/autopilot.js';
import { enclosedNow } from '../autopilot/hazards.js';
import { assessThreats } from '../autopilot/threats.js';
import { MAX_PAUSE_MS } from '../autopilot/instinct/instinct-engine.js';

type Direction = 'forward' | 'back' | 'left' | 'right';

/** "zombie 4.2 blocks, spider 9.0 blocks", "none" or "unknown": hostile mobs within 16 blocks, nearest first. */
export function hostilesNear(bot: mineflayer.Bot): string {
  try {
    const hostiles = assessThreats(bot, { radius: 16 }).hostiles.slice(0, 5)
      .map(threat => `${threat.entity.name ?? 'unknown'} ${threat.distance.toFixed(1)} blocks`);
    return hostiles.length > 0 ? hostiles.join(', ') : 'none';
  } catch {
    return 'unknown';
  }
}

/**
 * Whether a move to `target` would take the bot out of a cell that is walled in on every side, as after the
 * instinct's dig_in (E-019): the pathfinder digs its way out, and in the task test that let a spider back in. A target
 * the bot is already at does not count.
 */
export function leavingShelter(bot: mineflayer.Bot, target: { x: number; y: number; z: number }, range: number): boolean {
  return walledIn(bot) && arrivalProblem(bot, target, range) !== null;
}

/** enclosedNow, false when the world cannot be read: a warning must never stop a move. */
export function walledIn(bot: mineflayer.Bot): boolean {
  try {
    return enclosedNow(bot);
  } catch {
    return false;
  }
}

/** The refusal while walled in, unless the caller passed leaveShelter (E-019, PLAN Q15). */
export function shelterRefusal(bot: mineflayer.Bot): string {
  return "The bot is walled in on every side (for example by the instinct's dig_in); moving would make the pathfinder dig out. " +
    `Hostile mobs within 16 blocks: ${hostilesNear(bot)}. Pass leaveShelter: true to move anyway`;
}

export const LEAVE_SHELTER_DESCRIPTION = "Move even though the bot is walled in on every side (e.g. in the instinct's dig_in hole), which digs it open (default: false, the move is refused)";

/** The reply suffix once a move took the bot out of its shelter. */
export function leftShelterNote(bot: mineflayer.Bot): string {
  return `; left the shelter (the bot was walled in on every side); hostile mobs within 16 blocks: ${hostilesNear(bot)}`;
}

/**
 * A move's time limit (E-038): without timeoutMs, what is left for the walk once the reply and a wait in a Nether
 * portal are allowed for (usually about 35 s). A timeoutMs the caller gave is kept, and the call's deadline moves to
 * make room for it and the portal wait.
 */
export function moveLimitMs(ctx: ToolContext, timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return Math.max(0, defaultLimitMs(ctx) - PORTAL_WAIT_MS);
  allowFor(ctx, timeoutMs + PORTAL_WAIT_MS);
  return timeoutMs;
}

/** The default in a move tool's timeoutMs description (E-038), from the call's time budget. */
export function moveTimeoutDefault(callLimitMs: number): string {
  return `default: about ${callLimitMs - REPLY_MARGIN_MS - PORTAL_WAIT_MS}, so that the reply arrives within ${Math.round(callLimitMs / 1000)} s; ` +
    'a longer timeout needs an MCP client that waits that long';
}

// stop-all (E-040): the instinct's pause unless pauseInstinctS says otherwise, and how often it looks whether the body
// is free while it waits (at most STOP_SETTLE_MS).
export const DEFAULT_PAUSE_INSTINCT_S = 10;
const MAX_PAUSE_INSTINCT_S = MAX_PAUSE_MS / 1000;
const STOP_POLL_MS = 50;

/** From the bot's block to the target's block, in blocks. */
function cellDistance(position: Vec3, target: { x: number; y: number; z: number }): number {
  const at = position.floored();
  return Math.hypot(at.x - Math.floor(target.x), at.y - Math.floor(target.y), at.z - Math.floor(target.z));
}

/** Added to "Move timed out after Nms" (E-038): where the walk stopped, how far from the target, and what to do next. */
export function moveTimeoutNote(bot: mineflayer.Bot, target: { x: number; y: number; z: number }, tool: string): string {
  const position = bot.entity?.position;
  // Test fakes may have no entity.
  if (!position) return ` at an unknown place; call ${tool} again to continue`;
  const at = position.floored();
  return ` at (${at.x}, ${at.y}, ${at.z}), ${cellDistance(position, target).toFixed(1)} blocks from the target; call ${tool} again to continue`;
}

/**
 * A move's progress text (E-039), read at each notification: "12 blocks to go", measured as in moveTimeoutNote and
 * rounded to whole blocks. Empty (the call's default text) without a position.
 */
export function blocksToGo(bot: mineflayer.Bot, target: { x: number; y: number; z: number }): () => string {
  return () => {
    const position = bot.entity?.position;
    return position ? `${Math.round(cellDistance(position, target))} blocks to go` : '';
  };
}

export function registerPositionTools(factory: ToolFactory, getBot: () => mineflayer.Bot, getAutopilot?: () => Autopilot | null): void {
  const limitS = Math.round(factory.callLimitMs / 1000);
  factory.registerTool(
    "get-position",
    "Get the current position of the bot",
    {},
    async () => {
      const bot = getBot();
      const position = bot.entity.position;
      const pos = {
        x: Math.floor(position.x),
        y: Math.floor(position.y),
        z: Math.floor(position.z)
      };
      return factory.createResponse(`Current position: (${pos.x}, ${pos.y}, ${pos.z})`);
    }
  );

  factory.registerTool(
    "move-to-position",
    "Move the bot to a specific position. Reports the blocks the pathfinder dug and placed on the way. Refused while the bot is walled in on every side unless leaveShelter is true. Ending in a Nether portal waits up to 10 s for the trip to the other dimension and reports it",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
      range: z.coerce.number().finite().optional().describe("How close to get to the target (default: 1)"),
      timeoutMs: z.number().int().min(50).optional().describe(`Timeout in milliseconds before cancelling (min: 50, ${moveTimeoutDefault(factory.callLimitMs)})`),
      leaveShelter: z.boolean().optional().describe(LEAVE_SHELTER_DESCRIPTION)
    },
    async ({ x, y, z, range = 1, timeoutMs, leaveShelter = false }: { x: number; y: number; z: number; range?: number; timeoutMs?: number; leaveShelter?: boolean }, ctx: ToolContext) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();
      const goal = new goals.GoalNear(x, y, z, range);
      const sheltered = leavingShelter(bot, { x, y, z }, range);
      if (sheltered && !leaveShelter) return factory.createErrorResponse(shelterRefusal(bot));
      const left = () => (sheltered && !walledIn(bot) ? leftShelterNote(bot) : '');
      const edits = watchPathEdits(bot);
      ctx.setProgress(blocksToGo(bot, { x, y, z }));

      try {
        // Stops the pathfinder itself when its time limit runs out; on an abort the tool factory has stopped it (E-027).
        await gotoWithTimeout(bot, goal, moveLimitMs(ctx, timeoutMs), ctx.signal);
        const problem = arrivalProblem(bot, { x, y, z }, range);
        if (problem) return factory.createErrorResponse(`Did not reach (${x}, ${y}, ${z}): ${problem}${edits()}${left()}`);
        // The notes describe the walk, so they are made before the wait in a portal (and a change of dimension).
        const changed = edits() + left();
        return factory.createResponse(`Successfully moved to position near (${x}, ${y}, ${z})${changed}${await portalReport(bot)}`);
      } catch (error) {
        if (error instanceof MoveTimeout) error.message += moveTimeoutNote(bot, { x, y, z }, 'move-to-position');
        const changed = edits() + left();
        // An abort's reason is shared by the whole call; its reply is written by the tool factory.
        if (changed && error instanceof Error && !(error instanceof AbortError)) error.message += changed;
        throw error;
      } finally {
        edits();
      }
    }
  );

  factory.registerTool(
    "look-at",
    "Make the bot look at a specific position",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
    },
    async ({ x, y, z }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();
      await bot.lookAt(new Vec3(x, y, z), true);
      return factory.createResponse(`Looking at position (${x}, ${y}, ${z})`);
    }
  );

  factory.registerTool(
    "jump",
    "Make the bot jump",
    {},
    async () => {
      const bot = getBot();
      bot.setControlState('jump', true);
      setTimeout(() => bot.setControlState('jump', false), 250);
      return factory.createResponse("Successfully jumped");
    }
  );

  factory.registerTool(
    "move-in-direction",
    "Move the bot in a specific direction for a duration",
    {
      direction: z.enum(['forward', 'back', 'left', 'right']).describe("Direction to move"),
      duration: z.number().optional().describe(
        `Duration in milliseconds (default: 1000; at most about ${factory.callLimitMs - REPLY_MARGIN_MS}, so that the reply arrives within ${limitS} s)`
      )
    },
    async ({ direction, duration = 1000 }: { direction: Direction, duration?: number }, ctx: ToolContext) => {
      const bot = getBot();
      throwIfAborted(ctx.signal);
      // The reply must arrive within the call's budget (E-038): a longer walk is cut short, and the reply says so.
      const walkMs = Math.min(duration, defaultLimitMs(ctx));
      const capped = walkMs < duration ? ` (capped from ${duration} ms: a reply must arrive within ${limitS} s)` : '';
      return new Promise((resolve, reject) => {
        // On an abort the timer goes and the call ends at once; the tool factory has cleared the controls (E-027).
        const onAbort = () => {
          clearTimeout(timer);
          reject(abortError(ctx.signal));
        };
        bot.setControlState(direction, true);
        const timer = setTimeout(() => {
          ctx.signal.removeEventListener('abort', onAbort);
          bot.setControlState(direction, false);
          resolve(factory.createResponse(`Moved ${direction} for ${walkMs}ms${capped}`));
        }, walkMs);
        ctx.signal.addEventListener('abort', onAbort, { once: true });
      });
    }
  );

  factory.registerTool(
    "stop-pathfinding",
    "Stop the bot's current movement (pathfinding and manual movement) and cancel the current background task",
    {},
    async () => {
      const bot = getBot();
      const autopilot = getAutopilot?.();
      const task = autopilot?.isReady() ? autopilot.currentTask() : null;
      if (task) await autopilot!.tasks.cancel(task.id, 'stopped by stop-pathfinding');
      stopPathfinder(bot);
      bot.clearControlStates();
      return factory.createResponse(task ? `Stopped all movement and cancelled task ${task.id} (${task.behavior})` : "Stopped all movement");
    }
  );

  // The emergency stop (E-040, invariant I8). Not a body tool: it takes no lease, so it never queues behind what it is
  // to stop. The instinct is paused first and the task cancelled before the instinct's action ends, so that when a
  // stopped command lets go of the body nobody is left to take it over (as in Autopilot.unbind).
  factory.registerTool(
    "stop-all",
    "Emergency stop: stops every command that moves or uses the bot's body (also those waiting for their turn), collect-block and lead-animal, cancels the current task, interrupts the instinct's action and stops the pathfinder. " +
      "The instinct then pauses for pauseInstinctS seconds, handling only lava, drowning, low air and swelling creepers. Queries and wait-for-event go on. The reply lists what was stopped and the bot's state",
    {
      pauseInstinctS: z.number().int().min(0).max(MAX_PAUSE_INSTINCT_S).optional().describe(
        `How long the instinct pauses, in seconds (0-${MAX_PAUSE_INSTINCT_S}, default: ${DEFAULT_PAUSE_INSTINCT_S}); 0 does not pause it and ends an earlier pause`
      )
    },
    async ({ pauseInstinctS = DEFAULT_PAUSE_INSTINCT_S }: { pauseInstinctS?: number }) => {
      const bot = getBot();
      const autopilot = getAutopilot?.();
      // Without the Autopilot there is no task, instinct or lease: only the commands and the body are stopped.
      const ready = autopilot?.isReady() ? autopilot : null;
      const arbiter = ready?.arbiter ?? null;
      // Read first: a stopped collect-block cancels its own task.
      const task = ready?.tasks.currentTask() ?? null;

      // (1) The pause, (2) the commands, (3) the task, (4) the instinct's action; all before anything lets go of the body.
      ready?.instinct.pauseFor(pauseInstinctS * 1000, 'stop-all');
      const stopped = factory.stopAll('stop-all');
      const cancelling = task && ready!.tasks.currentTask()?.id === task.id ? ready!.tasks.cancel(task.id, 'stopped by stop-all') : Promise.resolve();
      const interrupted = ready?.instinct.interrupt('stopped by stop-all') ?? null;

      // (5) At most STOP_SETTLE_MS for the body to be free and for every body call, collect-block and lead-animal to
      // have replied (I8): also one stopped earlier for another reason (a death, the client) and one that came in
      // meanwhile. The one holder left alone is an instinct action started during the pause, so for an urgent danger.
      let cancelled = false;
      void cancelling.then(() => { cancelled = true; }, () => { cancelled = true; });
      const lingering = () => factory.inFlight().filter(call => ToolFactory.stoppable(call));
      const urgentHolder = () => {
        const holder = arbiter?.holder();
        const run = ready?.instinct.status().running ?? null;
        return holder && run?.duringPause && holder.holder === `instinct ${run.action}` ? run : null;
      };
      const settled = () => cancelled && lingering().length === 0 && (!arbiter?.holder() || urgentHolder() !== null);
      const deadline = Date.now() + STOP_SETTLE_MS;
      while (!settled() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, STOP_POLL_MS));

      const holder = arbiter?.holder() ?? null;
      const urgent = urgentHolder();
      // (6) Only a body nobody holds is stopped (G4).
      if (!holder) stopBody(bot);

      const items: string[] = [];
      if (task) {
        const final = ready!.tasks.list().history.find(record => record.id === task.id);
        items.push(`task ${task.id} ${task.behavior} (${final?.status ?? task.status})`);
      }
      for (const entry of stopped) items.push(`${entry.name} (stopped after ${(entry.ms / 1000).toFixed(1)}s)`);
      if (interrupted) items.push(`instinct action ${interrupted} (interrupted)`);
      const problems = [
        ...(holder && !urgent ? [`still held by ${holder.holder}`] : []),
        // A call that is stopped but has not replied yet, or one that came in after the others were stopped.
        ...lingering().map(call => (call.controller.signal.aborted ? `${call.name} is still stopping` : `${call.name} was called during stop-all`))
      ];
      const sentences = [`${items.length > 0 ? `Stopped: ${items.join(', ')}` : 'Nothing was running'}${problems.map(problem => `; ${problem}`).join('')}.`];
      if (ready && pauseInstinctS > 0) {
        const during = urgent ? `; instinct action ${urgent.action} started for ${urgent.reason} during the pause` : '';
        sentences.push(`The instinct is paused for ${pauseInstinctS} s (lava, drowning, low air and swelling creepers are still handled)${during}.`);
      }
      const position = bot.entity?.position;
      const at = position ? `(${Math.floor(position.x)}, ${Math.floor(position.y)}, ${Math.floor(position.z)})` : 'an unknown place';
      sentences.push(`The bot is at ${at}, health ${formatStat(bot.health)}, food ${formatStat(bot.food)}; hostile mobs within 16 blocks: ${hostilesNear(bot)}`);
      const text = sentences.join(' ');
      return problems.length > 0 ? factory.createErrorResponse(text) : factory.createResponse(text);
    }
  );
}
