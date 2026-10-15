import { z } from "zod";
import mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import { entityLabel, resolveTargetEntity } from './entity-utils.js';
import type { Autopilot } from '../autopilot/autopilot.js';

const DEFAULT_SEARCH_DISTANCE = 32;

// follow-entity and flee-from start background tasks (BLUEPRINT E-002); their arguments and replies stay the same.
export function registerFollowTools(factory: ToolFactory, getBot: () => mineflayer.Bot, getAutopilot: () => Autopilot): void {
  const target = {
    entityId: z.coerce.number().int().optional().describe("Entity id from list-entities"),
    type: z.string().optional().describe("If no entityId is given, use the nearest entity matching this type/name or player username"),
    maxDistance: z.coerce.number().finite().positive().optional().describe(`Search distance when using type (default: ${DEFAULT_SEARCH_DISTANCE})`)
  };

  factory.registerTool(
    "follow-entity",
    "Keep following an entity (player or mob). Returns immediately and keeps following in the background as a task until stop-pathfinding or cancel-task is called",
    {
      ...target,
      range: z.coerce.number().finite().positive().optional().describe("How close to stay to the target (default: 3)")
    },
    async ({ entityId, type, maxDistance = DEFAULT_SEARCH_DISTANCE, range = 3 }) => {
      const resolved = resolveTargetEntity(getBot(), { entityId, type, maxDistance });
      if ('error' in resolved) {
        return factory.createErrorResponse(resolved.error);
      }

      const started = await getAutopilot().tasks.start('follow', { entityId: resolved.entity.id, range }, { source: 'tool' });
      if (!started.ok) return factory.createErrorResponse(started.error);
      return factory.createResponse(`Following ${entityLabel(resolved.entity)} (id ${resolved.entity.id}) at range ${range}. Use stop-pathfinding to stop (task ${started.task.id})`);
    }
  );

  factory.registerTool(
    "flee-from",
    "Run away from an entity until at least the given distance away. Returns immediately and keeps moving in the background as a task; use stop-pathfinding or cancel-task to stop",
    {
      ...target,
      distance: z.coerce.number().finite().positive().optional().describe("Distance to get away to (default: 16)")
    },
    async ({ entityId, type, maxDistance = DEFAULT_SEARCH_DISTANCE, distance = 16 }) => {
      const resolved = resolveTargetEntity(getBot(), { entityId, type, maxDistance });
      if ('error' in resolved) {
        return factory.createErrorResponse(resolved.error);
      }

      const started = await getAutopilot().tasks.start('flee', { entityId: resolved.entity.id, distance: Math.min(Math.max(distance, 2), 64) }, { source: 'tool' });
      if (!started.ok) return factory.createErrorResponse(started.error);
      return factory.createResponse(`Fleeing from ${entityLabel(resolved.entity)} (id ${resolved.entity.id}) until ${distance} blocks away (task ${started.task.id})`);
    }
  );
}
