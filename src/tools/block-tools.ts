import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { ToolFactory, type ToolContext } from '../tool-factory.js';
import { log } from '../logger.js';
import { coerceCoordinates } from './coordinate-utils.js';
import { blockDetails, faceName } from './block-details.js';
import { describeEntity, entityDetails, entityKind } from './entity-utils.js';
import { compassDirection } from './terrain-utils.js';
import { approachToPlace, digSeconds, equipBestTool, isAir, missingHarvestTools, overlapsBot } from './block-utils.js';
import { gotoWithTimeout } from './movement-utils.js';

type FaceDirection = 'up' | 'down' | 'north' | 'south' | 'east' | 'west';
const MAX_FIND_BLOCKS_COUNT = 256;
const SELF_CELL = 'Cannot place a block where the bot is standing or one block above';

interface FaceOption {
  direction: string;
  vector: Vec3;
}

export function registerBlockTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "place-block",
    "Place a block at the specified position",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
      faceDirection: z.enum(['up', 'down', 'north', 'south', 'east', 'west']).optional().describe("Direction to place against (default: 'down')")
    },
    async ({ x, y, z, faceDirection = 'down' }: { x: number, y: number, z: number, faceDirection?: FaceDirection }, ctx: ToolContext) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();
      const placePos = new Vec3(x, y, z).floored();
      ({ x, y, z } = placePos);

      // A block that was not placed is an error (E-031).
      const botPos = bot.entity.position.floored();
      if (placePos.equals(botPos) || placePos.equals(botPos.offset(0, 1, 0))) {
        return factory.createErrorResponse(SELF_CELL);
      }

      const blockAtPos = bot.blockAt(placePos);

      // Cave air and void air are air: a cell in a cave can be filled.
      if (blockAtPos && !isAir(blockAtPos)) {
        return factory.createErrorResponse(`There's already a block (${blockAtPos.name}) at (${x}, ${y}, ${z})`);
      }

      const possibleFaces: FaceOption[] = [
        { direction: 'down', vector: new Vec3(0, -1, 0) },
        { direction: 'north', vector: new Vec3(0, 0, -1) },
        { direction: 'south', vector: new Vec3(0, 0, 1) },
        { direction: 'east', vector: new Vec3(1, 0, 0) },
        { direction: 'west', vector: new Vec3(-1, 0, 0) },
        { direction: 'up', vector: new Vec3(0, 1, 0) }
      ];

      if (faceDirection !== 'down') {
        const specificFace = possibleFaces.find(face => face.direction === faceDirection);
        if (specificFace) {
          possibleFaces.unshift(possibleFaces.splice(possibleFaces.indexOf(specificFace), 1)[0]);
        }
      }

      // The block to place is whatever the LLM put in the hand; the walk there can change that (the pathfinder equips
      // its scaffolding blocks), and once a fence came out as "egg" (M18 field test).
      const intended = bot.heldItem?.name ?? null;
      let lastError = '';
      for (const face of possibleFaces) {
        // After an abort the next face is not tried: the tool factory stopped the walk to this one (E-027).
        ctx.throwIfAborted();
        const referencePos = placePos.plus(face.vector);
        const referenceBlock = bot.blockAt(referencePos);

        if (referenceBlock && referenceBlock.name !== 'air') {
          try {
            // A spot within reach that can see a face to click, never inside the target (E-013).
            await approachToPlace(bot, placePos, referenceBlock, ctx.signal);
          } catch (moveError) {
            ctx.throwIfAborted();
            lastError = `could not get to a spot to place from: ${moveError instanceof Error ? moveError.message : moveError}`;
            continue;
          }
          if (overlapsBot(bot, placePos)) {
            return factory.createErrorResponse(SELF_CELL);
          }

          await bot.lookAt(placePos, true);

          if (intended && bot.heldItem?.name !== intended) {
            const again = bot.inventory.items().find(item => item.name === intended);
            if (!again) return factory.createErrorResponse(`No ${intended} left to place (the walk there used it up)`);
            await bot.equip(again, 'hand');
          }

          try {
            ctx.throwIfAborted();
            await bot.placeBlock(referenceBlock, face.vector.scaled(-1));
            return factory.createResponse(`Placed block at (${x}, ${y}, ${z}) using ${face.direction} face`);
          } catch (placeError) {
            ctx.throwIfAborted();
            log('warn', `Failed to place using ${face.direction} face: ${placeError}`);
            lastError = placeError instanceof Error ? placeError.message : String(placeError);
            continue;
          }
        }
      }

      // Not "Failed to …": the error reply already starts with "Failed: ".
      return factory.createErrorResponse(`Could not place a block at (${x}, ${y}, ${z}): no suitable reference block found${lastError ? ` (last error: ${lastError})` : ''}`);
    }
  );

  factory.registerTool(
    "dig-block",
    "Dig a block at the specified position with the best tool in the inventory. Refuses when no tool the bot has makes the block drop anything",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
    },
    async ({ x, y, z }, ctx: ToolContext) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();
      const blockPos = new Vec3(x, y, z);
      const block = bot.blockAt(blockPos);

      // An unloaded block cannot be dug (an error, E-031); air is already what digging would leave (a success).
      if (!block) {
        return factory.createErrorResponse(`The block at (${x}, ${y}, ${z}) is not loaded (beyond what the bot can see)`);
      }
      if (isAir(block)) {
        return factory.createResponse(`No block found at position (${x}, ${y}, ${z})`);
      }

      // Digging obsidian with the sword the instinct last fought with took 4 minutes and dropped nothing (E-017).
      const missing = missingHarvestTools(bot, block);
      if (missing) {
        const seconds = digSeconds(bot, block, null);
        const time = seconds === null ? '' : `: digging would take about ${Math.ceil(seconds)} s and drop nothing`;
        // clear-region still digs it, e.g. to get out of a hole without a pickaxe.
        return factory.createErrorResponse(`Cannot harvest ${block.name} with what the bot has (needs ${missing.join(' or ')})${time}; to dig it out of the way anyway, use clear-region`);
      }

      if (!bot.canDigBlock(block) || !bot.canSeeBlock(block)) {
        const goal = new goals.GoalNear(x, y, z, 2);
        await gotoWithTimeout(bot, goal, undefined, ctx.signal);
      }

      ctx.throwIfAborted();
      await equipBestTool(bot, block);
      const tool = bot.heldItem?.name ?? 'bare hand';
      const started = Date.now();
      // A dig that has started is ended by the tool factory's bot.stopDigging() (E-027).
      ctx.throwIfAborted();
      await bot.dig(block);
      return factory.createResponse(`Dug ${block.name} at (${x}, ${y}, ${z}) with ${tool} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    }
  );

  factory.registerTool(
    "get-block-info",
    "Get information about a block at the specified position",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
    },
    async ({ x, y, z }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();
      const blockPos = new Vec3(x, y, z);
      const block = bot.blockAt(blockPos);

      if (!block) {
        return factory.createResponse(`No block information found at position (${x}, ${y}, ${z})`);
      }

      const lines = [`Found ${block.name} (type: ${block.type}) at position (${block.position.x}, ${block.position.y}, ${block.position.z})`, ...blockDetails(bot, block)];
      return factory.createResponse(lines.join('\n'));
    }
  );

  factory.registerTool(
    "find-blocks",
    "Find one or more nearby blocks of a specific type",
    {
      blockType: z.string().describe("Type of block to find"),
      maxDistance: z.coerce.number().finite().optional().describe("Maximum search distance (default: 16)"),
      count: z.coerce.number().int().positive().optional().describe("Maximum number of blocks to return (default: 1; values above 256 are clamped)")
    },
    async ({ blockType, maxDistance = 16, count = 1 }) => {
      const bot = getBot();
      const mcData = minecraftData(bot.version);
      const blocksByName = mcData.blocksByName;
      const normalizedCount = Math.min(count, MAX_FIND_BLOCKS_COUNT);

      if (!blocksByName[blockType]) {
        return factory.createResponse(`Unknown block type: ${blockType}`);
      }

      const blockId = blocksByName[blockType].id;

      if (normalizedCount === 1) {
        const block = bot.findBlock({
          matching: blockId,
          maxDistance: maxDistance
        });

        if (!block) {
          return factory.createResponse(`No ${blockType} found within ${maxDistance} blocks`);
        }

        return factory.createResponse(`Found ${blockType} at position (${block.position.x}, ${block.position.y}, ${block.position.z})`);
      }

      const blocks = bot.findBlocks({
        point: bot.entity.position,
        matching: blockId,
        maxDistance: maxDistance,
        count: normalizedCount
      });

      if (blocks.length === 0) {
        return factory.createResponse(`No ${blockType} found within ${maxDistance} blocks`);
      }

      const blocksList = blocks
        .map((block, i) => `${i + 1}. (${block.x}, ${block.y}, ${block.z})`)
        .join('\n');

      return factory.createResponse(`Found ${blocks.length} ${blockType} block(s) within ${maxDistance} blocks:\n${blocksList}`);
    }
  );

  factory.registerTool(
    "get-cursor-target",
    "Get what the bot is looking at: its facing direction and the block (with the face being looked at) or entity under its crosshair",
    {
      maxDistance: z.coerce.number().finite().positive().max(64).optional().describe("How far to look (default: 5, roughly reach distance)")
    },
    async ({ maxDistance = 5 }) => {
      const bot = getBot();
      const yaw = bot.entity.yaw ?? 0;
      const pitchDegrees = Math.round(((bot.entity.pitch ?? 0) * 180) / Math.PI);
      const facing = compassDirection(Math.round(-Math.sin(yaw) * 100), Math.round(-Math.cos(yaw) * 100));
      const lines = [`Facing ${facing}, looking ${pitchDegrees > 5 ? 'up' : pitchDegrees < -5 ? 'down' : 'straight ahead'} (pitch ${pitchDegrees}°)`];

      const eye = bot.entity.position.offset(0, (bot.entity as { eyeHeight?: number }).eyeHeight ?? 1.62, 0);
      const block = bot.blockAtCursor(maxDistance);
      const entity = typeof bot.entityAtCursor === 'function' ? bot.entityAtCursor(maxDistance) : null;
      const blockDistance = block ? eye.distanceTo(block.position.offset(0.5, 0.5, 0.5)) : Infinity;
      const entityDistance = entity ? eye.distanceTo(entity.position) : Infinity;

      if (entity && entityDistance <= blockDistance) {
        lines.push(`Looking at entity: ${describeEntity({ entity, distance: bot.entity.position.distanceTo(entity.position), details: entityDetails(bot, entity), kind: entityKind(bot, entity) })}`);
      } else if (block) {
        const face = faceName((block as { face?: number }).face);
        lines.push(`Looking at ${block.name} at (${block.position.x}, ${block.position.y}, ${block.position.z}), ${blockDistance.toFixed(1)} blocks away${face ? `, ${face}` : ''}`);
        lines.push(...blockDetails(bot, block));
      } else {
        lines.push(`Nothing within ${maxDistance} blocks`);
      }

      return factory.createResponse(lines.join('\n'));
    }
  );
}
