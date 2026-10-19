import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { coerceCoordinates } from './coordinate-utils.js';
import { approachEntity, entityLabel, resolveTargetEntity } from './entity-utils.js';
import { sleep } from './block-utils.js';
import { bedWakeWarning, wokeUpInsideBlock } from './terrain-utils.js';

const BLOCK_REACH = 4;
const ENTITY_REACH = 3;
const DEFAULT_ENTITY_SEARCH = 16;
const DISMOUNT_WAIT_MS = 600;
const SNEAK_HOLD_MS = 300;
// The server moves the player off the bed right after waking; check where the head ended up after that (E-014).
export const WAKE_SETTLE_MS = 1000;

export function registerInteractionTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  const entityTarget = {
    entityId: z.coerce.number().int().optional().describe("Entity id from list-entities"),
    type: z.string().optional().describe("If no entityId is given, use the nearest entity matching this type/name or player username"),
    maxDistance: z.coerce.number().finite().positive().optional().describe(`Search distance when using type (default: ${DEFAULT_ENTITY_SEARCH})`)
  };

  factory.registerTool(
    "activate-block",
    "Right-click a block: open doors and trapdoors, press buttons, flip levers, use note blocks, etc. Use read-container for chests",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate")
    },
    async ({ x, y, z }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));
      const bot = getBot();
      const pos = new Vec3(x, y, z).floored();
      const block = bot.blockAt(pos);

      if (!block || block.name === 'air') {
        return factory.createErrorResponse(`No block at (${pos.x}, ${pos.y}, ${pos.z})`);
      }

      const center = pos.offset(0.5, 0.5, 0.5);
      if (bot.entity.position.distanceTo(center) > BLOCK_REACH) {
        await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2));
      }

      await bot.lookAt(center, true);
      await bot.activateBlock(block);
      return factory.createResponse(`Activated ${block.name} at (${pos.x}, ${pos.y}, ${pos.z})`);
    }
  );

  factory.registerTool(
    "activate-entity",
    "Right-click an entity: interact with a villager, feed or shear an animal, etc. Walks closer if needed",
    entityTarget,
    async ({ entityId, type, maxDistance = DEFAULT_ENTITY_SEARCH }) => {
      const bot = getBot();
      const resolved = resolveTargetEntity(bot, { entityId, type, maxDistance });
      if ('error' in resolved) {
        return factory.createErrorResponse(resolved.error);
      }

      await approachEntity(bot, resolved.entity, ENTITY_REACH);
      await bot.activateEntity(resolved.entity);
      return factory.createResponse(`Interacted with ${entityLabel(resolved.entity)} (id ${resolved.entity.id})`);
    }
  );

  factory.registerTool(
    "sleep",
    "Sleep in a bed. Uses the given bed position, or the nearest bed. Only works at night or during thunderstorms",
    {
      x: z.coerce.number().optional().describe("X coordinate of a bed (omit to find the nearest bed)"),
      y: z.coerce.number().optional().describe("Y coordinate of a bed"),
      z: z.coerce.number().optional().describe("Z coordinate of a bed"),
      maxDistance: z.coerce.number().finite().positive().optional().describe("Search distance when no position is given (default: 32)")
    },
    async ({ x, y, z, maxDistance = 32 }) => {
      const bot = getBot();

      if (bot.isSleeping) {
        return factory.createResponse("Already sleeping");
      }

      let bed;
      if (x !== undefined && y !== undefined && z !== undefined) {
        ({ x, y, z } = coerceCoordinates(x, y, z));
        bed = bot.blockAt(new Vec3(x, y, z).floored());
        if (!bed || !bot.isABed(bed)) {
          return factory.createErrorResponse(`No bed at (${Math.floor(x)}, ${Math.floor(y)}, ${Math.floor(z)})`);
        }
      } else {
        bed = bot.findBlock({ matching: (block) => bot.isABed(block), maxDistance });
        if (!bed) {
          return factory.createErrorResponse(`No bed found within ${maxDistance} blocks`);
        }
      }

      if (bot.entity.position.distanceTo(bed.position) > 3) {
        await bot.pathfinder.goto(new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2));
      }

      await bot.sleep(bed);
      const warning = bedWakeWarning(bot, bed);
      return factory.createResponse(`Sleeping in ${bed.name} at (${bed.position.x}, ${bed.position.y}, ${bed.position.z})${warning ? `; ${warning}` : ''}`);
    }
  );

  factory.registerTool(
    "wake",
    "Get out of bed",
    {},
    async () => {
      const bot = getBot();
      if (!bot.isSleeping) {
        return factory.createResponse("Not sleeping");
      }
      await bot.wake();
      await sleep(WAKE_SETTLE_MS);
      return factory.createResponse(wokeUpInsideBlock(bot) ?? "Woke up");
    }
  );

  factory.registerTool(
    "mount-entity",
    "Ride an entity such as a horse, boat or minecart. Walks closer if needed",
    entityTarget,
    async ({ entityId, type, maxDistance = DEFAULT_ENTITY_SEARCH }) => {
      const bot = getBot();
      const resolved = resolveTargetEntity(bot, { entityId, type, maxDistance });
      if ('error' in resolved) {
        return factory.createErrorResponse(resolved.error);
      }

      await approachEntity(bot, resolved.entity, ENTITY_REACH);
      bot.mount(resolved.entity);
      return factory.createResponse(`Mounting ${entityLabel(resolved.entity)} (id ${resolved.entity.id})`);
    }
  );

  factory.registerTool(
    "dismount",
    "Get off the entity the bot is currently riding",
    {},
    async () => {
      const bot = getBot();
      const riding = () => Boolean((bot as unknown as { vehicle?: unknown }).vehicle);
      if (!riding()) {
        return factory.createResponse("Not riding anything");
      }

      bot.dismount();
      await sleep(DISMOUNT_WAIT_MS);

      // Newer servers only let the player off with the sneak key, which bot.dismount() does not press.
      if (riding()) {
        bot.setControlState('sneak', true);
        await sleep(SNEAK_HOLD_MS);
        bot.setControlState('sneak', false);
        await sleep(DISMOUNT_WAIT_MS);
      }

      if (riding()) {
        return factory.createErrorResponse("Still riding after trying to dismount");
      }
      return factory.createResponse("Dismounted");
    }
  );
}
