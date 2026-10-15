import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { ToolFactory } from '../tool-factory.js';
import { entityLabel, resolveTargetEntity } from './entity-utils.js';

const DEFAULT_SEARCH_DISTANCE = 32;

export function registerFollowTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  const target = {
    entityId: z.coerce.number().int().optional().describe("Entity id from list-entities"),
    type: z.string().optional().describe("If no entityId is given, use the nearest entity matching this type/name or player username"),
    maxDistance: z.coerce.number().finite().positive().optional().describe(`Search distance when using type (default: ${DEFAULT_SEARCH_DISTANCE})`)
  };

  factory.registerTool(
    "follow-entity",
    "Keep following an entity (player or mob). Returns immediately and keeps following in the background until stop-pathfinding is called",
    {
      ...target,
      range: z.coerce.number().finite().positive().optional().describe("How close to stay to the target (default: 3)")
    },
    async ({ entityId, type, maxDistance = DEFAULT_SEARCH_DISTANCE, range = 3 }) => {
      const bot = getBot();
      const resolved = resolveTargetEntity(bot, { entityId, type, maxDistance });
      if ('error' in resolved) {
        return factory.createErrorResponse(resolved.error);
      }

      bot.pathfinder.setGoal(new goals.GoalFollow(resolved.entity, range), true);
      return factory.createResponse(`Following ${entityLabel(resolved.entity)} (id ${resolved.entity.id}) at range ${range}. Use stop-pathfinding to stop`);
    }
  );

  factory.registerTool(
    "flee-from",
    "Run away from an entity until at least the given distance away. Returns immediately and keeps moving in the background; use stop-pathfinding to stop",
    {
      ...target,
      distance: z.coerce.number().finite().positive().optional().describe("Distance to get away to (default: 16)")
    },
    async ({ entityId, type, maxDistance = DEFAULT_SEARCH_DISTANCE, distance = 16 }) => {
      const bot = getBot();
      const resolved = resolveTargetEntity(bot, { entityId, type, maxDistance });
      if ('error' in resolved) {
        return factory.createErrorResponse(resolved.error);
      }

      bot.pathfinder.setGoal(new goals.GoalInvert(new goals.GoalFollow(resolved.entity, distance)), true);
      return factory.createResponse(`Fleeing from ${entityLabel(resolved.entity)} (id ${resolved.entity.id}) until ${distance} blocks away`);
    }
  );
}
