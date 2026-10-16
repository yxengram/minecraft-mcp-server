// Contract: docs/BLUEPRINT.md F-017.
import { z } from "zod";
import { ToolFactory } from '../tool-factory.js';
import { Autopilot, BEHAVIORS } from '../autopilot/autopilot.js';
import { formatDuration, TaskRecord } from '../autopilot/task-manager.js';

const behaviorNames = BEHAVIORS.map(behavior => behavior.name) as [string, ...string[]];

function line(record: TaskRecord, now = Date.now()): string {
  const parts = [`${record.id} ${record.behavior} [${record.status}]`, record.summary];
  if (record.status === 'running' || record.status === 'paused') {
    parts.push(`running for ${formatDuration(now - record.startedAt)}`);
    if (record.pauseReason) parts.push(record.pauseReason);
    if (record.step) parts.push(`step: ${record.step}`);
  } else if (record.result) {
    parts.push(record.result);
  }
  if (record.progress) parts.push(record.progress);
  return parts.join('; ');
}

export function registerTaskTools(factory: ToolFactory, getAutopilot: () => Autopilot): void {
  const behaviorHelp = BEHAVIORS.map(behavior => `${behavior.name}: ${behavior.description}`).join('; ');

  factory.registerTool(
    "start-task",
    `Start a background task and return immediately. The task keeps running while you do other things; progress, pauses and the result appear in get-events (use wait-for-event to be woken up). Starting a task replaces the current one unless replace is false. Behaviors: ${behaviorHelp}. Params: follow {entityId | target, range?, maxDistance?}; flee {entityId | target, distance?, maxDistance?}; guard {entityId | target | waypoint | x,y,z (default: current position), radius?, maxChase?}; gather {blockType, count?, maxDistance?, timeoutMs?}; hunt {animal, count?, maxDistance?, timeoutMs?}; return-home {waypoint? (default 'home'), sleep?, timeoutMs?}, where target is a player name or entity type`,
    {
      behavior: z.enum(behaviorNames).describe("Behavior to run"),
      params: z.record(z.unknown()).optional().describe("Behavior parameters, e.g. { \"target\": \"Steve\", \"range\": 3 }"),
      replace: z.boolean().optional().describe("Replace the current task (default: true)")
    },
    async ({ behavior, params = {}, replace = true }: { behavior: string; params?: Record<string, unknown>; replace?: boolean }) => {
      const result = await getAutopilot().tasks.start(behavior, params, { replace, source: 'llm' });
      if (!result.ok) return factory.createErrorResponse(result.error);
      const status = result.task.status === 'paused' ? ` (${result.task.pauseReason})` : '';
      return factory.createResponse(`Started task ${result.task.id}: ${result.task.behavior} (${result.task.summary})${status}`);
    }
  );

  factory.registerTool(
    "list-tasks",
    "List the current background task (status, why it is paused, what it is doing) and recently finished tasks",
    {},
    async () => {
      const { current, history } = getAutopilot().tasks.list();
      const lines = [current ? `Current: ${line(current)}` : 'Current: none'];
      if (history.length > 0) {
        lines.push('', 'Recent:', ...history.slice(0, 10).map(record => `- ${line(record)}`));
      }
      return factory.createResponse(lines.join('\n'));
    }
  );

  factory.registerTool(
    "resume-task",
    "Resume a task that one of your own commands paused. Tasks paused by reflexes resume on their own",
    {
      id: z.string().optional().describe("Task id such as t3 (default: the current task)")
    },
    async ({ id }: { id?: string }) => {
      const result = getAutopilot().tasks.resume(id);
      if (!result.ok) return factory.createErrorResponse(result.error);
      const status = result.task.status === 'paused' ? `, ${result.task.pauseReason}` : '';
      return factory.createResponse(`Resumed task ${result.task.id}: ${result.task.behavior} (${result.task.summary}${status})`);
    }
  );

  factory.registerTool(
    "cancel-task",
    "Cancel the current background task",
    {
      id: z.string().optional().describe("Task id such as t3 (default: the current task)")
    },
    async ({ id }: { id?: string }) => {
      const result = await getAutopilot().tasks.cancel(id, 'cancelled by cancel-task');
      if (!result.ok) return factory.createErrorResponse(result.error);
      return factory.createResponse(`Cancelled task ${result.task.id}: ${result.task.behavior} (${result.task.summary})`);
    }
  );
}
