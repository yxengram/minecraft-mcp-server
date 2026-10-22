import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { coerceCoordinates } from './coordinate-utils.js';
import { stopPathfinder, arrivalProblem, portalReport, watchPathEdits } from './movement-utils.js';
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

export function registerPositionTools(factory: ToolFactory, getBot: () => mineflayer.Bot, getAutopilot?: () => Autopilot | null): void {
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
      timeoutMs: z.number().int().min(50).optional().describe("Timeout in milliseconds before cancelling (min: 50, default: no timeout)"),
      leaveShelter: z.boolean().optional().describe(LEAVE_SHELTER_DESCRIPTION)
    },
    async ({ x, y, z, range = 1, timeoutMs, leaveShelter = false }: { x: number; y: number; z: number; range?: number; timeoutMs?: number; leaveShelter?: boolean }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();
      const goal = new goals.GoalNear(x, y, z, range);
      const sheltered = leavingShelter(bot, { x, y, z }, range);
      if (sheltered && !leaveShelter) return factory.createErrorResponse(shelterRefusal(bot));
      const left = () => (sheltered && !walledIn(bot) ? leftShelterNote(bot) : '');
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      let timeoutPromise: Promise<never> | null = null;
      let timedOut = false;

      if (timeoutMs !== undefined) {
        timeoutPromise = new Promise((_, reject) => {
          timeoutId = setTimeout(() => {
            timedOut = true;
            reject(new Error(`Move timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        });
      }

      const edits = watchPathEdits(bot);
      const gotoPromise = bot.pathfinder.goto(goal);

      try {
        if (timeoutPromise) {
          await Promise.race([gotoPromise, timeoutPromise]);
        } else {
          await gotoPromise;
        }
        const problem = arrivalProblem(bot, { x, y, z }, range);
        if (problem) return factory.createErrorResponse(`Did not reach (${x}, ${y}, ${z}): ${problem}${edits()}${left()}`);
        // The notes describe the walk, so they are made before the wait in a portal (and a change of dimension).
        const changed = edits() + left();
        return factory.createResponse(`Successfully moved to position near (${x}, ${y}, ${z})${changed}${await portalReport(bot)}`);
      } catch (error) {
        if (timedOut) {
          throw new Error(`Move timed out after ${timeoutMs}ms${edits()}${left()}`);
        }
        const changed = edits() + left();
        if (changed && error instanceof Error) error.message += changed;
        throw error;
      } finally {
        edits();
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        if (timedOut) {
          stopPathfinder(bot);
          gotoPromise.catch(() => {});
        }
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
      duration: z.number().optional().describe("Duration in milliseconds (default: 1000)")
    },
    async ({ direction, duration = 1000 }: { direction: Direction, duration?: number }) => {
      const bot = getBot();
      return new Promise((resolve) => {
        bot.setControlState(direction, true);
        setTimeout(() => {
          bot.setControlState(direction, false);
          resolve(factory.createResponse(`Moved ${direction} for ${duration}ms`));
        }, duration);
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
