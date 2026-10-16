import { z } from "zod";
import { ToolFactory } from '../tool-factory.js';
import type { Autopilot } from '../autopilot/autopilot.js';
import { DEFAULT_GATHER_TIMEOUT_MS, MAX_GATHER_COUNT } from '../autopilot/behaviors/gather.js';

// Extra time on top of timeoutMs before collect-block gives up waiting, e.g. when its task never got to run.
const WAIT_GRACE_MS = 5000;

// collect-block runs a gather task and waits for it (BLUEPRINT E-004); its arguments and replies stay the same.
export function registerGatheringTools(factory: ToolFactory, getAutopilot: () => Autopilot): void {
  factory.registerTool(
    "collect-block",
    "Find, mine and pick up a number of blocks of one type, e.g. 'oak_log' or 'iron_ore'. Walks to each block, uses the best tool and collects the drops. Skips blocks next to lava. Runs as a gather task (replacing the current task) and waits for it to finish",
    {
      blockType: z.string().trim().min(1).describe("Block name to collect, e.g. 'oak_log'"),
      count: z.coerce.number().int().min(1).max(MAX_GATHER_COUNT).optional().describe(`How many blocks to mine (default: 1, max: ${MAX_GATHER_COUNT})`),
      maxDistance: z.coerce.number().finite().positive().optional().describe("Maximum search distance (default: 32)"),
      timeoutMs: z.number().int().min(1000).optional().describe(`Stop after this many milliseconds and report progress (default: ${DEFAULT_GATHER_TIMEOUT_MS})`)
    },
    async ({ blockType, count = 1, maxDistance = 32, timeoutMs = DEFAULT_GATHER_TIMEOUT_MS }) => {
      const tasks = getAutopilot().tasks;
      const previous = tasks.currentTask();
      const started = await tasks.start('gather', { blockType, count, maxDistance, timeoutMs }, { source: 'tool' });
      if (!started.ok) return factory.createErrorResponse(started.error);
      // Tell the LLM what this command replaced, as an interruption report would.
      const replaced = previous ? `\nReplaced ${tasks.describe(previous)}: it was cancelled.` : '';

      const id = started.task.id;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const gaveUp = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs + WAIT_GRACE_MS); });
      let final = await Promise.race([tasks.waitForEnd(id), gaveUp]).finally(() => clearTimeout(timer));
      if (!final) {
        // The time limit counts inside the task, which only starts counting once it runs; don't wait forever.
        await tasks.cancel(id, 'time limit reached');
        final = await tasks.waitForEnd(id);
      }
      if (final.status === 'done') return factory.createResponse(`${final.result ?? ''}${replaced}`);
      if (final.status === 'failed') return factory.createErrorResponse(`${final.result ?? 'gather task failed'}${replaced}`);
      const progress = final.progress ? `; progress: ${final.progress}` : '';
      return factory.createErrorResponse(`Collecting stopped: task ${final.id} was cancelled (${final.result})${progress}${replaced}`);
    }
  );
}
