// Contract: docs/BLUEPRINT.md F-007. The collect-block loop, moved here from src/tools/gathering-tools.ts.
import { z } from 'zod';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { BehaviorDefinition } from '../task-manager.js';
import { countItems } from '../../tools/item-utils.js';
import { digBlockAt, DigResult, digPrecheck, isAir } from '../../tools/block-utils.js';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { collectNearbyDrops, DeadlineReached, interruptible, waitWhilePaused, walkTo } from './actions.js';

export const MAX_GATHER_COUNT = 64;
export const DEFAULT_GATHER_TIMEOUT_MS = 120000;
const MAX_CONSECUTIVE_FAILURES = 5;

const schema = z.object({
  blockType: z.string().trim().min(1).describe("Block name to collect, e.g. 'oak_log'"),
  count: z.coerce.number().int().min(1).max(MAX_GATHER_COUNT).default(1).describe(`How many blocks to mine (default: 1, max: ${MAX_GATHER_COUNT})`),
  maxDistance: z.coerce.number().finite().positive().default(32).describe('Maximum search distance (default: 32)'),
  timeoutMs: z.coerce.number().int().min(1000).default(DEFAULT_GATHER_TIMEOUT_MS).describe(`Stop after this many milliseconds and report progress (default: ${DEFAULT_GATHER_TIMEOUT_MS})`)
});

type GatherParams = z.infer<typeof schema>;
type BlockInfo = { id: number; name: string };

export const gatherBehavior: BehaviorDefinition<GatherParams, BlockInfo> = {
  name: 'gather',
  description: 'Find, mine and pick up a number of blocks of one type; skips blocks next to lava',
  schema,
  summarize: params => `${params.count} ${params.blockType.toLowerCase()} within ${params.maxDistance} blocks`,
  prepare: (bot, params) => {
    const info = minecraftData(bot.version).blocksByName[params.blockType.toLowerCase()];
    return info ? { value: { id: info.id, name: info.name } } : { error: `Unknown block type: ${params.blockType}` };
  },
  async run(ctx) {
    const { bot, params, prepared: blockInfo, setStep, report } = ctx;
    const { count, maxDistance } = params;
    const itemsBefore = countItems(bot.inventory.items());
    const skipped = new Set<string>();
    const seen = new Map<string, Vec3>();
    const dugKeys = new Set<string>();
    const deadline = Date.now() + params.timeoutMs;
    let mined = 0;
    // Walking to a target or to its drops can make the pathfinder break other target blocks on the way.
    const clearedOnTheWay = () => [...seen.entries()].filter(([key, pos]) =>
      !dugKeys.has(key) && !skipped.has(key) && bot.blockAt(pos)?.name !== blockInfo.name).length;
    let consecutiveFailures = 0;
    let lastError = '';
    let stopReason = '';

    while (mined + clearedOnTheWay() < count) {
      if (!(await waitWhilePaused(ctx, deadline)) || Date.now() > deadline) {
        stopReason = 'time limit reached';
        break;
      }
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        stopReason = `too many failures (last error: ${lastError})`;
        break;
      }

      setStep(`looking for ${blockInfo.name}`);
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

      setStep(`digging ${blockInfo.name} at (${target.x}, ${target.y}, ${target.z})`);
      try {
        // Blocks touching water are left alone: digging them floods the hole or leads the bot under water (M7).
        let result: DigResult | null = digPrecheck(bot, target, { avoidWater: true });
        if (!result) {
          // Walk first under the time limit, so a long walk cannot run past it (collect-block waits on this task).
          const block = bot.blockAt(target)!;
          if (!bot.canDigBlock(block) || !bot.canSeeBlock(block)) {
            setStep(`walking to ${blockInfo.name} at (${target.x}, ${target.y}, ${target.z})`);
            await walkTo(ctx, new goals.GoalNear(target.x, target.y, target.z, 2), deadline);
            setStep(`digging ${blockInfo.name} at (${target.x}, ${target.y}, ${target.z})`);
          }
          // The pathfinder may break blocks that are in its way, including the target itself.
          if (isAir(bot.blockAt(target))) {
            result = 'dug';
          } else {
            const attempt = await interruptible(
              ctx,
              () => digBlockAt(bot, target, () => ctx.isPaused() || ctx.signal.aborted),
              // Only stop this task's own dig, never one a manual command has started on another block since.
              () => {
                const digging = bot.targetDigBlock?.position;
                if (!digging || digging.equals(target)) bot.stopDigging?.();
              }
            );
            // Interrupted by a reflex or a command: look for a target again once the task runs again.
            if (!attempt.done) continue;
            result = attempt.value;
          }
        }
        consecutiveFailures = 0;
        if (result === 'dug') {
          mined++;
          dugKeys.add(target.toString());
          report(`mined ${mined + clearedOnTheWay()} of ${count} ${blockInfo.name}`);
          setStep('collecting drops');
          await collectNearbyDrops(ctx, target, deadline);
        } else {
          skipped.add(target.toString());
        }
      } catch (error) {
        ctx.signal.throwIfAborted();
        if (error instanceof DeadlineReached) continue;
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
    if (mined === 0 && stopReason) throw new Error(text);
    return text;
  }
};
