import { z } from "zod";
import { ToolFactory, type ToolContext } from '../tool-factory.js';
import type { Autopilot } from '../autopilot/autopilot.js';
import type { TaskRecord } from '../autopilot/task-manager.js';
import { DEFAULT_GATHER_TIMEOUT_MS, MAX_GATHER_COUNT } from '../autopilot/behaviors/gather.js';
import { DEFAULT_LEAD_TIMEOUT_MS, MAX_LEAD_TIMEOUT_MS } from '../autopilot/behaviors/lead.js';
import { watchPathEdits } from './movement-utils.js';

// Extra time on top of timeoutMs before collect-block gives up waiting, e.g. when its task never got to run.
const WAIT_GRACE_MS = 5000;

/**
 * Waits for the task the tool started, at most timeoutMs + WAIT_GRACE_MS, and cancels it when the call is aborted
 * (E-027): these two tools have no watchdog, but a call the MCP client cancelled must not leave its task running. The
 * reason is the abort's ('cancelled by the MCP client'). Null when the wait ran out first.
 */
async function waitForTask(tasks: Autopilot['tasks'], id: string, timeoutMs: number, signal: AbortSignal): Promise<TaskRecord | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const gaveUp = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs + WAIT_GRACE_MS); });
  const aborted = new Promise<TaskRecord>(resolve => {
    onAbort = () => {
      const reason: unknown = signal.reason;
      void tasks.cancel(id, reason instanceof Error ? reason.message : 'cancelled by the MCP client')
        .then(() => tasks.waitForEnd(id))
        .then(resolve, () => {});
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([tasks.waitForEnd(id), gaveUp, aborted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort!);
  }
}

// collect-block runs a gather task and waits for it (BLUEPRINT E-004); its arguments and replies stay the same. It does
// not report the pathfinder's edits as lead-animal does (E-049): the blocks a gather digs are the task itself.
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
    async ({ blockType, count = 1, maxDistance = 32, timeoutMs = DEFAULT_GATHER_TIMEOUT_MS }, ctx: ToolContext) => {
      const tasks = getAutopilot().tasks;
      const previous = tasks.currentTask();
      const started = await tasks.start('gather', { blockType, count, maxDistance, timeoutMs }, { source: 'tool' });
      if (!started.ok) return factory.createErrorResponse(started.error);
      // Tell the LLM what this command replaced, as an interruption report would.
      const replaced = previous ? `\nReplaced ${tasks.describe(previous)}: it was cancelled.` : '';

      const id = started.task.id;
      let final = await waitForTask(tasks, id, timeoutMs, ctx.signal);
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

  // lead-animal runs a lead task and waits for it, as collect-block does with gather (E-020, F-045).
  factory.registerTool(
    "lead-animal",
    "Lead one animal to a point: on a lead when the bot has one, otherwise holding a food the animal follows (wheat for cows and sheep, carrots for pigs, seeds for chickens...). Walks it there step by step, waiting when it lags behind. Runs as a lead task (replacing the current task) and waits for it to finish. Open gates first; the lead is taken off and picked up at the end",
    {
      entityId: z.coerce.number().int().optional().describe("Entity id from list-entities"),
      type: z.string().trim().min(1).optional().describe("If no entityId is given, the nearest animal of this type, e.g. 'cow'"),
      maxDistance: z.coerce.number().finite().positive().optional().describe("Search distance when using type (default: 32)"),
      x: z.coerce.number().describe("Target X"),
      y: z.coerce.number().describe("Target Y"),
      z: z.coerce.number().describe("Target Z"),
      range: z.coerce.number().finite().min(1).max(8).optional().describe("How close to the target the animal must get (default: 2)"),
      method: z.enum(['auto', 'leash', 'lure']).optional().describe("'leash' uses a lead, 'lure' holds the animal's food, 'auto' a lead when the bot has one (default: auto)"),
      item: z.string().trim().min(1).optional().describe("Food to lure with (default: one the animal follows)"),
      timeoutMs: z.number().int().min(1000).max(MAX_LEAD_TIMEOUT_MS).optional().describe(`Give up after this many milliseconds (default: ${DEFAULT_LEAD_TIMEOUT_MS})`)
    },
    async ({ entityId, type, maxDistance, x, y, z, range, method, item, timeoutMs = DEFAULT_LEAD_TIMEOUT_MS }, ctx: ToolContext) => {
      if (entityId === undefined && type === undefined) return factory.createErrorResponse('Give entityId or type');
      const autopilot = getAutopilot();
      const tasks = autopilot.tasks;
      const previous = tasks.currentTask();
      const params = { entityId, target: type, maxDistance, x, y, z, range, method, item, timeoutMs };
      // The lead task walks with the pathfinder, which digs and places blocks on the way: in the M18 field test it left
      // a cobblestone inside the pen, seen only on the map (E-049). Without a bot (test fakes) nothing is recorded.
      const bot = autopilot.boundBot();
      const stopEdits = bot ? watchPathEdits(bot) : () => '';
      try {
        const started = await tasks.start('lead', params, { source: 'tool' });
        if (!started.ok) return factory.createErrorResponse(started.error);
        const replaced = previous ? `\nReplaced ${tasks.describe(previous)}: it was cancelled.` : '';

        const id = started.task.id;
        let final = await waitForTask(tasks, id, timeoutMs, ctx.signal);
        if (!final) {
          await tasks.cancel(id, 'time limit reached');
          final = await tasks.waitForEnd(id);
        }
        // On the reply's first line, before the line about the replaced task, as the move tools do (M17).
        const edits = stopEdits();
        if (final.status === 'done') return factory.createResponse(`${final.result ?? ''}${edits}${replaced}`);
        if (final.status === 'failed') return factory.createErrorResponse(`${final.result ?? 'lead task failed'}${edits}${replaced}`);
        const progress = final.progress ? `; progress: ${final.progress}` : '';
        return factory.createErrorResponse(`Leading stopped: task ${final.id} was cancelled (${final.result})${progress}${edits}${replaced}`);
      } finally {
        // Also when the start was refused or threw: bot.dig gets its own function back.
        stopEdits();
      }
    }
  );
}
