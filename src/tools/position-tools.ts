import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import { REPLY_MARGIN_MS, ToolFactory, allowFor, defaultLimitMs, type ToolContext } from '../tool-factory.js';
import { coerceCoordinates } from './coordinate-utils.js';
import {
  AbortError, MoveTimeout, PORTAL_WAIT_MS, abortError, gotoWithTimeout, stopPathfinder, arrivalProblem, portalReport, throwIfAborted,
  watchPathEdits
} from './movement-utils.js';
import type { Autopilot } from '../autopilot/autopilot.js';
import { enclosedNow } from '../autopilot/hazards.js';
import { assessThreats } from '../autopilot/threats.js';

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

/** Added to "Move timed out after Nms" (E-038): where the walk stopped, how far from the target, and what to do next. */
export function moveTimeoutNote(bot: mineflayer.Bot, target: { x: number; y: number; z: number }, tool: string): string {
  const position = bot.entity?.position;
  // Test fakes may have no entity.
  if (!position) return ` at an unknown place; call ${tool} again to continue`;
  const at = position.floored();
  const distance = Math.hypot(at.x - Math.floor(target.x), at.y - Math.floor(target.y), at.z - Math.floor(target.z));
  return ` at (${at.x}, ${at.y}, ${at.z}), ${distance.toFixed(1)} blocks from the target; call ${tool} again to continue`;
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
}
