import { z } from "zod";
import mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { coerceCoordinates } from './coordinate-utils.js';
import { digBlockAt, isAir, isLiquid, overlapsBot, placeBlockAt } from './block-utils.js';

const MAX_REGION_VOLUME = 512;
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_CONSECUTIVE_FAILURES = 5;

const DIRECTIONS = {
  north: new Vec3(0, 0, -1),
  south: new Vec3(0, 0, 1),
  east: new Vec3(1, 0, 0),
  west: new Vec3(-1, 0, 0)
} as const;

const regionShape = {
  x1: z.coerce.number().describe("X of the first corner"),
  y1: z.coerce.number().describe("Y of the first corner"),
  z1: z.coerce.number().describe("Z of the first corner"),
  x2: z.coerce.number().describe("X of the opposite corner"),
  y2: z.coerce.number().describe("Y of the opposite corner"),
  z2: z.coerce.number().describe("Z of the opposite corner"),
  timeoutMs: z.number().int().min(1000).optional().describe(`Stop after this many milliseconds and report progress (default: ${DEFAULT_TIMEOUT_MS})`)
};

interface Corners { x1: number; y1: number; z1: number; x2: number; y2: number; z2: number }

function regionPositions({ x1, y1, z1, x2, y2, z2 }: Corners): Vec3[] {
  const a = coerceCoordinates(x1, y1, z1);
  const b = coerceCoordinates(x2, y2, z2);
  const min = new Vec3(Math.floor(Math.min(a.x, b.x)), Math.floor(Math.min(a.y, b.y)), Math.floor(Math.min(a.z, b.z)));
  const max = new Vec3(Math.floor(Math.max(a.x, b.x)), Math.floor(Math.max(a.y, b.y)), Math.floor(Math.max(a.z, b.z)));
  const volume = (max.x - min.x + 1) * (max.y - min.y + 1) * (max.z - min.z + 1);

  if (volume > MAX_REGION_VOLUME) {
    throw new Error(`Region has ${volume} blocks, the maximum is ${MAX_REGION_VOLUME}. Split it into smaller regions`);
  }

  const positions: Vec3[] = [];
  for (let x = min.x; x <= max.x; x++) {
    for (let y = min.y; y <= max.y; y++) {
      for (let z = min.z; z <= max.z; z++) {
        positions.push(new Vec3(x, y, z));
      }
    }
  }
  return positions;
}

function sortByDistance(bot: mineflayer.Bot, positions: Vec3[], verticalOrder: 'top-down' | 'bottom-up' | 'none'): Vec3[] {
  const origin = bot.entity.position;
  return [...positions].sort((p, q) => {
    if (verticalOrder !== 'none' && p.y !== q.y) {
      return verticalOrder === 'top-down' ? q.y - p.y : p.y - q.y;
    }
    return p.distanceTo(origin) - q.distanceTo(origin);
  });
}

async function clearPositions(bot: mineflayer.Bot, positions: Vec3[], timeoutMs: number, verticalOrder: 'top-down' | 'none') {
  const stats = { dug: 0, empty: 0, unbreakable: 0, nearLava: 0, failed: 0, remaining: 0, lastError: '' };
  const queue = sortByDistance(bot, positions, verticalOrder);
  const deadline = Date.now() + timeoutMs;
  let consecutiveFailures = 0;

  for (let i = 0; i < queue.length; i++) {
    if (Date.now() > deadline || consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      stats.remaining = queue.length - i;
      break;
    }

    try {
      const result = await digBlockAt(bot, queue[i]);
      consecutiveFailures = 0;
      if (result === 'dug') stats.dug++;
      else if (result === 'air') stats.empty++;
      else if (result === 'unbreakable') stats.unbreakable++;
      else stats.nearLava++;
    } catch (error) {
      stats.failed++;
      consecutiveFailures++;
      stats.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return stats;
}

function describeClearStats(stats: Awaited<ReturnType<typeof clearPositions>>, label: string): string {
  const parts = [`dug ${stats.dug}`, `already empty ${stats.empty}`];
  if (stats.unbreakable) parts.push(`unbreakable ${stats.unbreakable}`);
  if (stats.nearLava) parts.push(`skipped ${stats.nearLava} next to lava`);
  if (stats.failed) parts.push(`failed ${stats.failed}${stats.lastError ? ` (last error: ${stats.lastError})` : ''}`);
  let text = `${label}: ${parts.join(', ')}`;
  if (stats.remaining) text += `. Stopped early with ${stats.remaining} block(s) not processed; run again to continue`;
  return text;
}

export function registerRegionTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "clear-region",
    `Dig out every block in a box between two corners (max ${MAX_REGION_VOLUME} blocks). Digs top to bottom, picks the best tool, and skips blocks next to lava. Dropped items are not collected`,
    regionShape,
    async ({ timeoutMs = DEFAULT_TIMEOUT_MS, ...corners }) => {
      const positions = regionPositions(corners as Corners);
      const stats = await clearPositions(getBot(), positions, timeoutMs, 'top-down');
      return factory.createResponse(describeClearStats(stats, `Cleared region of ${positions.length} blocks`));
    }
  );

  factory.registerTool(
    "fill-region",
    `Fill the empty spaces in a box between two corners with a block from the inventory (max ${MAX_REGION_VOLUME} blocks). Builds bottom to top; occupied spaces and the bot's own position are skipped`,
    {
      ...regionShape,
      blockName: z.string().trim().min(1).describe("Name of the block item to place, e.g. 'cobblestone'")
    },
    async ({ blockName, timeoutMs = DEFAULT_TIMEOUT_MS, ...corners }) => {
      const bot = getBot();
      const positions = sortByDistance(bot, regionPositions(corners as Corners), 'bottom-up');
      const wanted = blockName.toLowerCase();
      const stats = { placed: 0, occupied: 0, onBot: 0, failed: 0, remaining: 0, outOfItems: false };
      const deadline = Date.now() + timeoutMs;

      for (let i = 0; i < positions.length; i++) {
        const pos = positions[i];
        if (Date.now() > deadline) {
          stats.remaining = positions.length - i;
          break;
        }

        const existing = bot.blockAt(pos);
        if (!isAir(existing) && !isLiquid(existing)) {
          stats.occupied++;
          continue;
        }
        if (overlapsBot(bot, pos)) {
          stats.onBot++;
          continue;
        }

        if (bot.heldItem?.name !== wanted) {
          const item = bot.inventory.items().find(candidate => candidate.name === wanted);
          if (!item) {
            stats.outOfItems = true;
            stats.remaining = positions.length - i;
            break;
          }
          await bot.equip(item, 'hand');
        }

        if (await placeBlockAt(bot, pos)) stats.placed++;
        else stats.failed++;
      }

      if (stats.outOfItems && stats.placed === 0 && stats.occupied + stats.onBot + stats.failed === 0) {
        return factory.createErrorResponse(`No ${wanted} in inventory`);
      }

      const parts = [`placed ${stats.placed}`, `already occupied ${stats.occupied}`];
      if (stats.onBot) parts.push(`skipped ${stats.onBot} where the bot stands (move away and run again)`);
      if (stats.failed) parts.push(`failed ${stats.failed} (no support block to place against)`);
      let text = `Filled region of ${positions.length} blocks with ${wanted}: ${parts.join(', ')}`;
      if (stats.outOfItems) text += `. Ran out of ${wanted} with ${stats.remaining} space(s) left`;
      else if (stats.remaining) text += `. Stopped early with ${stats.remaining} space(s) not processed; run again to continue`;
      return factory.createResponse(text);
    }
  );

  factory.registerTool(
    "dig-tunnel",
    `Dig a straight horizontal tunnel starting next to the bot (max ${MAX_REGION_VOLUME} blocks in total). Skips blocks next to lava`,
    {
      direction: z.enum(['north', 'south', 'east', 'west']).describe("Direction to dig (north is -Z, east is +X)"),
      length: z.coerce.number().int().min(1).max(MAX_REGION_VOLUME).describe("How many blocks long"),
      width: z.coerce.number().int().min(1).max(9).optional().describe("Tunnel width (default: 1)"),
      height: z.coerce.number().int().min(1).max(9).optional().describe("Tunnel height (default: 2)"),
      timeoutMs: z.number().int().min(1000).optional().describe(`Stop after this many milliseconds and report progress (default: ${DEFAULT_TIMEOUT_MS})`)
    },
    async ({ direction, length, width = 1, height = 2, timeoutMs = DEFAULT_TIMEOUT_MS }: {
      direction: keyof typeof DIRECTIONS; length: number; width?: number; height?: number; timeoutMs?: number;
    }) => {
      const volume = length * width * height;
      if (volume > MAX_REGION_VOLUME) {
        return factory.createErrorResponse(`Tunnel has ${volume} blocks, the maximum is ${MAX_REGION_VOLUME}. Use a shorter length`);
      }

      const bot = getBot();
      const forward = DIRECTIONS[direction];
      const side = new Vec3(-forward.z, 0, forward.x);
      const start = bot.entity.position.floored();
      const firstOffset = -Math.floor((width - 1) / 2);

      const positions: Vec3[] = [];
      for (let i = 1; i <= length; i++) {
        for (let w = 0; w < width; w++) {
          for (let h = 0; h < height; h++) {
            positions.push(start.plus(forward.scaled(i)).plus(side.scaled(firstOffset + w)).offset(0, h, 0));
          }
        }
      }

      const stats = await clearPositions(bot, positions, timeoutMs, 'none');
      return factory.createResponse(describeClearStats(stats, `Dug ${direction} tunnel ${length}x${width}x${height}`));
    }
  );
}
