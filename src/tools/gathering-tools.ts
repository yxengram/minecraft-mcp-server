import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { ToolFactory } from '../tool-factory.js';
import { countItems } from './item-utils.js';
import { digBlockAt, sleep } from './block-utils.js';

const MAX_COLLECT_COUNT = 64;
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_CONSECUTIVE_FAILURES = 5;
const DROP_SETTLE_MS = 300;
const PICKUP_SETTLE_MS = 150;
const DROP_PICKUP_RADIUS = 5;

async function collectNearbyDrops(bot: mineflayer.Bot, around: Vec3): Promise<void> {
  await sleep(DROP_SETTLE_MS);
  const drops = Object.values(bot.entities ?? {})
    .filter(entity => entity.name === 'item' && entity.position.distanceTo(around) <= DROP_PICKUP_RADIUS)
    .sort((a, b) => a.position.distanceTo(around) - b.position.distanceTo(around))
    .slice(0, 4);

  for (const drop of drops) {
    try {
      await bot.pathfinder.goto(new goals.GoalNear(drop.position.x, drop.position.y, drop.position.z, 0));
      await sleep(PICKUP_SETTLE_MS);
    } catch {
      // The drop may have despawned or been picked up already.
    }
  }
}

export function registerGatheringTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "collect-block",
    "Find, mine and pick up a number of blocks of one type, e.g. 'oak_log' or 'iron_ore'. Walks to each block, uses the best tool and collects the drops. Skips blocks next to lava",
    {
      blockType: z.string().trim().min(1).describe("Block name to collect, e.g. 'oak_log'"),
      count: z.coerce.number().int().min(1).max(MAX_COLLECT_COUNT).optional().describe(`How many blocks to mine (default: 1, max: ${MAX_COLLECT_COUNT})`),
      maxDistance: z.coerce.number().finite().positive().optional().describe("Maximum search distance (default: 32)"),
      timeoutMs: z.number().int().min(1000).optional().describe(`Stop after this many milliseconds and report progress (default: ${DEFAULT_TIMEOUT_MS})`)
    },
    async ({ blockType, count = 1, maxDistance = 32, timeoutMs = DEFAULT_TIMEOUT_MS }) => {
      const bot = getBot();
      const blockInfo = minecraftData(bot.version).blocksByName[blockType.toLowerCase()];
      if (!blockInfo) {
        return factory.createErrorResponse(`Unknown block type: ${blockType}`);
      }

      const itemsBefore = countItems(bot.inventory.items());
      const skipped = new Set<string>();
      const seen = new Map<string, Vec3>();
      const dugKeys = new Set<string>();
      const deadline = Date.now() + timeoutMs;
      let mined = 0;
      // Walking to a target or to its drops can make the pathfinder break other target blocks on the way.
      const clearedOnTheWay = () => [...seen.entries()].filter(([key, pos]) =>
        !dugKeys.has(key) && !skipped.has(key) && bot.blockAt(pos)?.name !== blockInfo.name).length;
      let consecutiveFailures = 0;
      let lastError = '';
      let stopReason = '';

      while (mined + clearedOnTheWay() < count) {
        if (Date.now() > deadline) {
          stopReason = 'time limit reached';
          break;
        }
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          stopReason = `too many failures (last error: ${lastError})`;
          break;
        }

        const candidates = bot.findBlocks({
          point: bot.entity.position,
          matching: blockInfo.id,
          maxDistance,
          count: skipped.size + count
        }).filter(pos => !skipped.has(pos.toString()));
        candidates.forEach(pos => seen.set(pos.toString(), pos));

        const target = candidates[0];
        if (!target) {
          stopReason = `no more ${blockInfo.name} found within ${maxDistance} blocks`;
          break;
        }

        try {
          const result = await digBlockAt(bot, target);
          consecutiveFailures = 0;
          if (result === 'dug') {
            mined++;
            dugKeys.add(target.toString());
            await collectNearbyDrops(bot, target);
          } else {
            skipped.add(target.toString());
          }
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          consecutiveFailures++;
          skipped.add(target.toString());
        }
      }

      mined += clearedOnTheWay();
      const gained = countItems(bot.inventory.items()) - itemsBefore;
      let text = `Mined ${mined} of ${count} ${blockInfo.name}; inventory gained ${gained} item(s)`;
      if (skipped.size > 0) text += `; skipped ${skipped.size} unreachable or unsafe block(s)`;
      if (stopReason) text += `. Stopped: ${stopReason}`;
      return mined === 0 && stopReason ? factory.createErrorResponse(text) : factory.createResponse(text);
    }
  );
}
