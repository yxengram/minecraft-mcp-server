import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { ToolFactory, type ToolContext } from '../tool-factory.js';
import { WaypointStore } from '../waypoint-store.js';
import { coerceCoordinates } from './coordinate-utils.js';
import { Vec3 } from 'vec3';
import { AbortError, gotoWithTimeout, arrivalProblem, portalReport, watchPathEdits } from './movement-utils.js';
import { LEAVE_SHELTER_DESCRIPTION, leavingShelter, leftShelterNote, shelterRefusal, walledIn } from './position-tools.js';

export function registerWaypointTools(factory: ToolFactory, getBot: () => mineflayer.Bot, store: WaypointStore): void {
  factory.registerTool(
    "set-waypoint",
    "Save a named location that persists across restarts. Uses the bot's current position unless coordinates are given. Overwrites an existing waypoint with the same name",
    {
      name: z.string().trim().min(1).describe("Waypoint name, e.g. 'home' or 'iron mine'"),
      x: z.coerce.number().optional().describe("X coordinate (default: current position)"),
      y: z.coerce.number().optional().describe("Y coordinate (default: current position)"),
      z: z.coerce.number().optional().describe("Z coordinate (default: current position)"),
      note: z.string().optional().describe("Optional description")
    },
    async ({ name, x, y, z, note }) => {
      const bot = getBot();
      const hasCoordinates = x !== undefined && y !== undefined && z !== undefined;
      if (!hasCoordinates && (x !== undefined || y !== undefined || z !== undefined)) {
        return factory.createErrorResponse("Provide all of x, y and z, or none to use the current position");
      }

      const position = hasCoordinates ? coerceCoordinates(x, y, z) : bot.entity.position;
      const waypoint = {
        x: Math.floor(position.x),
        y: Math.floor(position.y),
        z: Math.floor(position.z),
        dimension: bot.game?.dimension,
        note,
        createdAt: Date.now()
      };

      const existed = store.get(name) !== undefined;
      store.set(name, waypoint);
      return factory.createResponse(
        `${existed ? 'Updated' : 'Saved'} waypoint '${store.normalizeName(name)}' at (${waypoint.x}, ${waypoint.y}, ${waypoint.z})`
      );
    }
  );

  factory.registerTool(
    "list-waypoints",
    "List all saved waypoints with their distance from the bot",
    {},
    async () => {
      const bot = getBot();
      const entries = Object.entries(store.list());
      if (entries.length === 0) {
        return factory.createResponse("No waypoints saved");
      }

      const currentDimension = bot.game?.dimension;
      let output = `${entries.length} waypoint(s):\n\n`;
      entries.forEach(([name, wp]) => {
        let line = `- ${name}: (${wp.x}, ${wp.y}, ${wp.z})`;
        if (wp.dimension && currentDimension && wp.dimension !== currentDimension) {
          line += `, in ${wp.dimension} (bot is in ${currentDimension})`;
        } else {
          const distance = Math.hypot(wp.x - bot.entity.position.x, wp.y - bot.entity.position.y, wp.z - bot.entity.position.z);
          line += `, ${distance.toFixed(0)} blocks away`;
        }
        if (wp.note) line += ` - ${wp.note}`;
        output += `${line}\n`;
      });

      return factory.createResponse(output);
    }
  );

  factory.registerTool(
    "delete-waypoint",
    "Delete a saved waypoint",
    {
      name: z.string().trim().min(1).describe("Waypoint name")
    },
    async ({ name }) => {
      if (!store.delete(name)) {
        return factory.createErrorResponse(`No waypoint named '${store.normalizeName(name)}'`);
      }
      return factory.createResponse(`Deleted waypoint '${store.normalizeName(name)}'`);
    }
  );

  factory.registerTool(
    "goto-waypoint",
    "Walk to a saved waypoint. A waypoint inside a Nether portal is walked into (range 0) and the trip to the other dimension is reported. Reports the blocks the pathfinder dug and placed on the way. Refused while the bot is walled in on every side unless leaveShelter is true",
    {
      name: z.string().trim().min(1).describe("Waypoint name"),
      range: z.coerce.number().finite().min(0).optional().describe("How close to get, 0 for the exact block (default: 2, or 0 when the waypoint is in a Nether portal)"),
      timeoutMs: z.number().int().min(50).optional().describe("Timeout in milliseconds before cancelling (default: no timeout)"),
      leaveShelter: z.boolean().optional().describe(LEAVE_SHELTER_DESCRIPTION)
    },
    async ({ name, range: givenRange, timeoutMs, leaveShelter = false }, ctx: ToolContext) => {
      const bot = getBot();
      const waypoint = store.get(name);
      if (!waypoint) {
        return factory.createErrorResponse(`No waypoint named '${store.normalizeName(name)}'`);
      }

      const currentDimension = bot.game?.dimension;
      if (waypoint.dimension && currentDimension && waypoint.dimension !== currentDimension) {
        return factory.createErrorResponse(`Waypoint '${store.normalizeName(name)}' is in ${waypoint.dimension} but the bot is in ${currentDimension}`);
      }

      // Stopping 2 blocks away from a portal waypoint left the bot outside the portal (E-017).
      const inPortal = bot.blockAt?.(new Vec3(waypoint.x, waypoint.y, waypoint.z).floored())?.name === 'nether_portal';
      const range = givenRange ?? (inPortal ? 0 : 2);
      const sheltered = leavingShelter(bot, waypoint, range);
      if (sheltered && !leaveShelter) return factory.createErrorResponse(shelterRefusal(bot));
      const left = () => (sheltered && !walledIn(bot) ? leftShelterNote(bot) : '');
      const edits = watchPathEdits(bot);
      try {
        await gotoWithTimeout(bot, new goals.GoalNear(waypoint.x, waypoint.y, waypoint.z, range), timeoutMs, ctx.signal);
      } catch (error) {
        const changed = edits() + left();
        if (changed && error instanceof Error && !(error instanceof AbortError)) error.message += changed;
        throw error;
      }
      const problem = arrivalProblem(bot, waypoint, range);
      if (problem) return factory.createErrorResponse(`Did not reach waypoint '${store.normalizeName(name)}': ${problem}${edits()}${left()}`);
      const changed = edits() + left();
      return factory.createResponse(`Arrived near waypoint '${store.normalizeName(name)}' (${waypoint.x}, ${waypoint.y}, ${waypoint.z})${changed}${await portalReport(bot)}`);
    }
  );
}
