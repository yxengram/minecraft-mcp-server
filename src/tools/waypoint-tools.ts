import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { ToolFactory } from '../tool-factory.js';
import { WaypointStore } from '../waypoint-store.js';
import { coerceCoordinates } from './coordinate-utils.js';
import { gotoWithTimeout, arrivalProblem } from './movement-utils.js';

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
    "Walk to a saved waypoint",
    {
      name: z.string().trim().min(1).describe("Waypoint name"),
      range: z.coerce.number().finite().min(0).optional().describe("How close to get, 0 for the exact block (default: 2)"),
      timeoutMs: z.number().int().min(50).optional().describe("Timeout in milliseconds before cancelling (default: no timeout)")
    },
    async ({ name, range = 2, timeoutMs }) => {
      const bot = getBot();
      const waypoint = store.get(name);
      if (!waypoint) {
        return factory.createErrorResponse(`No waypoint named '${store.normalizeName(name)}'`);
      }

      const currentDimension = bot.game?.dimension;
      if (waypoint.dimension && currentDimension && waypoint.dimension !== currentDimension) {
        return factory.createErrorResponse(`Waypoint '${store.normalizeName(name)}' is in ${waypoint.dimension} but the bot is in ${currentDimension}`);
      }

      await gotoWithTimeout(bot, new goals.GoalNear(waypoint.x, waypoint.y, waypoint.z, range), timeoutMs);
      const problem = arrivalProblem(bot, waypoint, range);
      if (problem) return factory.createErrorResponse(`Did not reach waypoint '${store.normalizeName(name)}': ${problem}`);
      return factory.createResponse(`Arrived near waypoint '${store.normalizeName(name)}' (${waypoint.x}, ${waypoint.y}, ${waypoint.z})`);
    }
  );
}
