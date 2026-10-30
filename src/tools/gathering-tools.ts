import { z } from "zod";
import { REPLY_MARGIN_MS, ToolFactory, defaultLimitMs, type ToolContext } from '../tool-factory.js';
import type { Autopilot } from '../autopilot/autopilot.js';
import type { TaskRecord } from '../autopilot/task-manager.js';
import { DEFAULT_GATHER_TIMEOUT_MS, MAX_GATHER_COUNT } from '../autopilot/behaviors/gather.js';
import { DEFAULT_LEAD_TIMEOUT_MS, MAX_LEAD_TIMEOUT_MS } from '../autopilot/behaviors/lead.js';
import { watchPathEdits } from './movement-utils.js';

// Extra time on top of timeoutMs before collect-block gives up waiting, e.g. when its task never got to run.
const WAIT_GRACE_MS = 5000;

/**
 * Waits for the task the tool started, at most waitMs, and cancels it when the call is aborted (E-027): these two
 * tools have no watchdog, but a call the MCP client cancelled must not leave its task running. The reason is the
 * abort's ('cancelled by the MCP client'). Null when the wait ran out first.
 */
async function waitForTask(tasks: Autopilot['tasks'], id: string, waitMs: number, signal: AbortSignal): Promise<TaskRecord | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const gaveUp = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), waitMs); });
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

/**
 * Waits for the task as long as the reply allows (E-038): until timeoutMs + WAIT_GRACE_MS or the call's default limit,
 * whichever comes first. timeoutMs only limits the task. When it comes first and the task has not ended (it never got
 * to run, E-004), the task is cancelled with 'time limit reached' as before. When the default limit comes first the
 * task is left running, and `running` is its record for the "Still …" reply.
 */
async function awaitTask(tasks: Autopilot['tasks'], id: string, timeoutMs: number, ctx: ToolContext): Promise<{ final: TaskRecord } | { running: TaskRecord }> {
  const ownLimit = timeoutMs + WAIT_GRACE_MS;
  const replyLimit = defaultLimitMs(ctx);
  const final = await waitForTask(tasks, id, Math.min(ownLimit, replyLimit), ctx.signal);
  if (final) return { final };
  const current = tasks.currentTask();
  // A task that ended just as the wait ran out replies with its result.
  if (ownLimit > replyLimit && current?.id === id) return { running: current };
  // The time limit counts inside the task, which only starts counting once it runs; don't wait forever.
  if (ownLimit <= replyLimit) await tasks.cancel(id, 'time limit reached');
  return { final: await tasks.waitForEnd(id) };
}

/** The reply for a task still going when the call has to answer (E-038); a success, the task is not stopped. */
function stillReply(verb: 'collecting' | 'leading', task: TaskRecord, startedAt: number): string {
  const progress = task.progress ?? task.step;
  const state = task.status === 'paused'
    ? `is paused${task.pauseReason ? ` (${task.pauseReason})` : ''}`
    : `keeps running in the background${progress ? ` (${progress})` : ''}`;
  return `Still ${verb} after ${Math.round((Date.now() - startedAt) / 1000)} s: task ${task.id} ${task.behavior} ${state}. ` +
    "Wait for it with wait-for-event types ['task_done', 'task_failed', 'task_cancelled'] (list-tasks shows whether it has already ended); " +
    `stop it with cancel-task ${task.id}`;
}

// collect-block runs a gather task and waits for it (BLUEPRINT E-004); its arguments and replies stay the same. It does
// not report the pathfinder's edits as lead-animal does (E-049): the blocks a gather digs are the task itself. Both
// tools reply within the call's budget (E-038): a task that is still going then keeps running in the background.
export function registerGatheringTools(factory: ToolFactory, getAutopilot: () => Autopilot): void {
  const replyS = Math.round((factory.callLimitMs - REPLY_MARGIN_MS) / 1000);
  const inBackground = `waits for it to finish, at most about ${replyS} s: a task still going then keeps running in the background, and the reply says how to wait for it`;
  const replyWithin = `the reply comes within about ${replyS} s either way`;

  factory.registerTool(
    "collect-block",
    `Find, mine and pick up a number of blocks of one type, e.g. 'oak_log' or 'iron_ore'. Walks to each block, uses the best tool and collects the drops. Skips blocks next to lava. Runs as a gather task (replacing the current task) and ${inBackground}`,
    {
      blockType: z.string().trim().min(1).describe("Block name to collect, e.g. 'oak_log'"),
      count: z.coerce.number().int().min(1).max(MAX_GATHER_COUNT).optional().describe(`How many blocks to mine (default: 1, max: ${MAX_GATHER_COUNT})`),
      maxDistance: z.coerce.number().finite().positive().optional().describe("Maximum search distance (default: 32)"),
      timeoutMs: z.number().int().min(1000).optional().describe(`Stop the task after this many milliseconds and report progress (default: ${DEFAULT_GATHER_TIMEOUT_MS}); ${replyWithin}`)
    },
    async ({ blockType, count = 1, maxDistance = 32, timeoutMs = DEFAULT_GATHER_TIMEOUT_MS }, ctx: ToolContext) => {
      const startedAt = Date.now();
      const tasks = getAutopilot().tasks;
      const previous = tasks.currentTask();
      const started = await tasks.start('gather', { blockType, count, maxDistance, timeoutMs }, { source: 'tool' });
      if (!started.ok) return factory.createErrorResponse(started.error);
      // Tell the LLM what this command replaced, as an interruption report would.
      const replaced = previous ? `\nReplaced ${tasks.describe(previous)}: it was cancelled.` : '';

      const waited = await awaitTask(tasks, started.task.id, timeoutMs, ctx);
      if ('running' in waited) return factory.createResponse(`${stillReply('collecting', waited.running, startedAt)}${replaced}`);
      const { final } = waited;
      if (final.status === 'done') return factory.createResponse(`${final.result ?? ''}${replaced}`);
      if (final.status === 'failed') return factory.createErrorResponse(`${final.result ?? 'gather task failed'}${replaced}`);
      const progress = final.progress ? `; progress: ${final.progress}` : '';
      return factory.createErrorResponse(`Collecting stopped: task ${final.id} was cancelled (${final.result})${progress}${replaced}`);
    }
  );

  // lead-animal runs a lead task and waits for it, as collect-block does with gather (E-020, F-045).
  factory.registerTool(
    "lead-animal",
    `Lead one animal to a point: on a lead when the bot has one, otherwise holding a food the animal follows (wheat for cows and sheep, carrots for pigs, seeds for chickens...). Walks it there step by step, waiting when it lags behind. Runs as a lead task (replacing the current task) and ${inBackground}. Open gates first; the lead is taken off and picked up at the end`,
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
      timeoutMs: z.number().int().min(1000).max(MAX_LEAD_TIMEOUT_MS).optional().describe(`Give up after this many milliseconds (default: ${DEFAULT_LEAD_TIMEOUT_MS}); ${replyWithin}`)
    },
    async ({ entityId, type, maxDistance, x, y, z, range, method, item, timeoutMs = DEFAULT_LEAD_TIMEOUT_MS }, ctx: ToolContext) => {
      if (entityId === undefined && type === undefined) return factory.createErrorResponse('Give entityId or type');
      const startedAt = Date.now();
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

        const waited = await awaitTask(tasks, started.task.id, timeoutMs, ctx);
        // The edits so far, on the first line as in every other reply (E-049); the watch stops with the call.
        if ('running' in waited) return factory.createResponse(`${stillReply('leading', waited.running, startedAt)}${stopEdits()}${replaced}`);
        const { final } = waited;
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
