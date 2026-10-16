// Contract: docs/BLUEPRINT.md F-003.
import type mineflayer from 'mineflayer';
import type { ZodType, ZodTypeDef } from 'zod';
import { ActionArbiter, Lease, PRIORITY, Preemptor } from './action-arbiter.js';
import type { EventStore } from '../event-store.js';
import type { WaypointStore } from '../waypoint-store.js';
import { stopPathfinder } from '../tools/movement-utils.js';

export type TaskStatus = 'running' | 'paused' | 'done' | 'failed' | 'cancelled';
export type TaskSource = 'llm' | 'chat' | 'tool';

/** Shared stores behaviors may read, e.g. saved waypoints for guard and return-home. */
export interface BehaviorServices {
  waypoints?: WaypointStore;
}

export interface BehaviorContext<P, S> {
  bot: mineflayer.Bot;
  params: P;
  services: BehaviorServices;
  /** Whatever `prepare` returned, e.g. the resolved target entity. */
  prepared: S;
  signal: AbortSignal;
  isPaused(): boolean;
  /** Resolves once the task is running again; rejects if the task is cancelled meanwhile. */
  waitUntilRunning(): Promise<void>;
  /** Short description of what the behavior is doing right now, shown in snapshots. */
  setStep(step: string): void;
  /** Milestones worth an event, throttled to one event every few seconds. */
  report(progress: string): void;
}

export interface BehaviorDefinition<P = unknown, S = unknown> {
  name: string;
  description: string;
  schema: ZodType<P, ZodTypeDef, unknown>;
  /** One-line parameter summary for task listings and events. */
  summarize(params: P): string;
  /** Synchronous checks before the task exists; return { error } to refuse the start. */
  prepare?(bot: mineflayer.Bot, params: P, services: BehaviorServices): { error: string } | { value: S };
  /** Runs in the background; returns the result text, throws to fail. */
  run(context: BehaviorContext<P, S>): Promise<string>;
}

export interface TaskRecord {
  id: string;
  behavior: string;
  summary: string;
  status: TaskStatus;
  pauseReason?: string;
  progress?: string;
  step?: string;
  startedAt: number;
  endedAt?: number;
  result?: string;
  source: TaskSource;
}

export type StartResult = { ok: true; task: TaskRecord } | { ok: false; error: string };

const PROGRESS_EVENT_INTERVAL_MS = 2000;
const HISTORY_LIMIT = 20;
const CANCEL_GRACE_MS = 2000;

interface RunningTask {
  record: TaskRecord;
  controller: AbortController;
  lease: Lease | null;
  pausedListeners: Set<() => void>;
  lastProgressEventAt: number;
  finished: Promise<TaskRecord>;
  resolveFinished: (record: TaskRecord) => void;
}

export interface TaskManagerOptions {
  getBot: () => mineflayer.Bot;
  getArbiter: () => ActionArbiter;
  events: EventStore;
  behaviors: BehaviorDefinition<never, never>[];
  services?: BehaviorServices;
  log?: (level: string, message: string) => void;
}

/** Waits `ms`, rejecting early with the signal's reason if the task is cancelled. */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m${String(seconds % 60).padStart(2, '0')}s` : `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

class TaskCancelled extends Error {}

export class TaskManager {
  private current: RunningTask | null = null;
  private history: TaskRecord[] = [];
  private nextId = 1;
  // start() awaits the old task's cancellation; queue calls so two starts can't both install a task.
  private startQueue: Promise<unknown> = Promise.resolve();
  private readonly behaviors = new Map<string, BehaviorDefinition<unknown, unknown>>();

  constructor(private readonly options: TaskManagerOptions) {
    for (const behavior of options.behaviors) {
      this.behaviors.set(behavior.name, behavior as unknown as BehaviorDefinition<unknown, unknown>);
    }
  }

  behaviorNames(): string[] {
    return [...this.behaviors.keys()];
  }

  currentTask(): TaskRecord | null {
    return this.current ? { ...this.current.record } : null;
  }

  list(): { current: TaskRecord | null; history: TaskRecord[] } {
    return { current: this.currentTask(), history: this.history.map(record => ({ ...record })) };
  }

  /** Human-readable description of the current task, used for interruption reports. */
  describe(record: TaskRecord, now = Date.now()): string {
    const parts = [record.summary, `running for ${formatDuration(now - record.startedAt)}`];
    if (record.step) parts.push(`step: ${record.step}`);
    if (record.progress) parts.push(record.progress);
    return `task ${record.id} ${record.behavior} (${parts.join('; ')})`;
  }

  start(behaviorName: string, rawParams: unknown, options: { replace?: boolean; source?: TaskSource } = {}): Promise<StartResult> {
    const run = this.startQueue.then(() => this.startNow(behaviorName, rawParams, options));
    this.startQueue = run.catch(() => {});
    return run;
  }

  private async startNow(behaviorName: string, rawParams: unknown, { replace = true, source = 'llm' as TaskSource }: { replace?: boolean; source?: TaskSource }): Promise<StartResult> {
    const behavior = this.behaviors.get(behaviorName);
    if (!behavior) {
      return { ok: false, error: `Unknown behavior '${behaviorName}'. Available: ${this.behaviorNames().join(', ')}` };
    }

    const parsed = behavior.schema.safeParse(rawParams ?? {});
    if (!parsed.success) {
      const details = parsed.error.issues.map(issue => `${issue.path.join('.') || 'params'}: ${issue.message}`).join('; ');
      return { ok: false, error: `Invalid params for ${behaviorName}: ${details}` };
    }
    const params = parsed.data;

    if (this.current && !replace) {
      return { ok: false, error: `Task ${this.current.record.id} (${this.current.record.behavior}) is already ${this.current.record.status}. Cancel it first or pass replace: true` };
    }

    // Check the new task can start before replacing the current one, so a refused start leaves it running.
    const bot = this.options.getBot();
    let prepared: unknown;
    if (behavior.prepare) {
      const outcome = behavior.prepare(bot, params, this.options.services ?? {});
      if ('error' in outcome) return { ok: false, error: outcome.error };
      prepared = outcome.value;
    }

    if (this.current) {
      await this.cancel(this.current.record.id, 'replaced');
      // The bot may have left (or rejoined) while the old task was stopping; don't start against a stale bot.
      let stillHere: mineflayer.Bot | null = null;
      try {
        stillHere = this.options.getBot();
      } catch {
        // Not in the game any more.
      }
      if (stillHere !== bot) return { ok: false, error: 'The bot left the game while the task was starting. Try again' };
    }
    const arbiter = this.options.getArbiter();

    const record: TaskRecord = {
      id: `t${this.nextId++}`,
      behavior: behavior.name,
      summary: behavior.summarize(params),
      status: 'running',
      startedAt: Date.now(),
      source
    };
    let resolveFinished!: (record: TaskRecord) => void;
    const task: RunningTask = {
      record,
      controller: new AbortController(),
      lease: null,
      pausedListeners: new Set(),
      lastProgressEventAt: 0,
      finished: new Promise(resolve => { resolveFinished = resolve; }),
      resolveFinished
    };
    this.current = task;
    this.options.events.addEvent('task_started', `${record.id} ${record.behavior}: started (${record.summary}; source ${source})`);

    task.lease = arbiter.acquireOrQueue(this.leaseRequest(task));
    if (!task.lease.isActive()) {
      this.markPaused(task, `waiting for ${arbiter.holder()?.holder ?? 'another action'}`, true);
    }

    void this.runBehavior(task, behavior, bot, params, prepared);
    return { ok: true, task: { ...record } };
  }

  /** Resume a task that a manual command suspended. Tasks paused by reflexes resume on their own. */
  resume(id?: string): StartResult {
    const task = this.current;
    if (!task || (id && task.record.id !== id)) {
      return { ok: false, error: id ? `Task ${id} is not the current task` : 'There is no current task to resume' };
    }
    if (task.record.status !== 'paused') {
      return { ok: false, error: `Task ${task.record.id} is ${task.record.status}, not paused` };
    }
    if (task.lease && task.lease.state === 'suspended') {
      return { ok: false, error: `Task ${task.record.id} is ${task.record.pauseReason ?? 'paused'} and will resume on its own` };
    }

    task.lease = this.options.getArbiter().acquireOrQueue(this.leaseRequest(task));
    if (task.lease.isActive()) {
      this.markRunning(task);
    } else {
      task.record.pauseReason = `waiting for ${this.options.getArbiter().holder()?.holder ?? 'another action'}`;
    }
    return { ok: true, task: { ...task.record } };
  }

  async cancel(id: string | undefined, reason: string): Promise<StartResult> {
    const task = this.current;
    if (!task || (id && task.record.id !== id)) {
      return { ok: false, error: id ? `Task ${id} is not the current task` : 'There is no running task' };
    }
    this.finish(task, 'cancelled', reason);
    task.controller.abort(new TaskCancelled(reason));
    // Only stop the body if this task was driving it; otherwise a manual command or reflex owns it now.
    if (task.lease?.isActive()) this.stopBody();
    task.lease?.release();
    await Promise.race([task.finished, new Promise(resolve => setTimeout(resolve, CANCEL_GRACE_MS))]);
    return { ok: true, task: { ...task.record } };
  }

  /** Waits for the given task (or the current one) to reach a final state. */
  waitForEnd(id: string): Promise<TaskRecord> {
    if (this.current?.record.id === id) return this.current.finished;
    const done = this.history.find(record => record.id === id);
    return done ? Promise.resolve({ ...done }) : Promise.reject(new Error(`Unknown task ${id}`));
  }

  async cancelAll(reason: string): Promise<void> {
    if (this.current) await this.cancel(this.current.record.id, reason);
  }

  private leaseRequest(task: RunningTask) {
    return {
      holder: `task ${task.record.id} ${task.record.behavior}`,
      priority: PRIORITY.TASK,
      onSuspend: (by: Preemptor, revoked: boolean) => {
        if (revoked) task.lease = null;
        const reason = by.kind === 'manual'
          ? `paused by manual command ${by.holder.replace(/^manual /, '')} (waiting for resume-task or cancel-task)`
          : `paused by ${by.holder}`;
        this.markPaused(task, reason, true);
      },
      onResume: () => this.markRunning(task)
    };
  }

  private markPaused(task: RunningTask, reason: string, emit: boolean): void {
    if (this.isFinal(task)) return;
    task.record.status = 'paused';
    task.record.pauseReason = reason;
    if (emit) this.options.events.addEvent('task_paused', `${task.record.id} ${task.record.behavior}: ${reason}`);
  }

  private markRunning(task: RunningTask): void {
    if (this.isFinal(task)) return;
    const wasPaused = task.record.status === 'paused';
    task.record.status = 'running';
    task.record.pauseReason = undefined;
    if (wasPaused) this.options.events.addEvent('task_resumed', `${task.record.id} ${task.record.behavior}: resumed`);
    for (const listener of task.pausedListeners) listener();
    task.pausedListeners.clear();
  }

  private async runBehavior(task: RunningTask, behavior: BehaviorDefinition<unknown, unknown>, bot: mineflayer.Bot, params: unknown, prepared: unknown): Promise<void> {
    const context: BehaviorContext<unknown, unknown> = {
      bot,
      params,
      services: this.options.services ?? {},
      prepared,
      signal: task.controller.signal,
      isPaused: () => task.record.status === 'paused',
      waitUntilRunning: () => new Promise<void>((resolve, reject) => {
        if (task.controller.signal.aborted) return reject(task.controller.signal.reason);
        if (task.record.status !== 'paused') return resolve();
        const onAbort = () => reject(task.controller.signal.reason);
        task.controller.signal.addEventListener('abort', onAbort, { once: true });
        task.pausedListeners.add(() => {
          task.controller.signal.removeEventListener('abort', onAbort);
          resolve();
        });
      }),
      setStep: step => {
        if (!this.isFinal(task)) task.record.step = step;
      },
      report: progress => {
        if (this.isFinal(task)) return;
        task.record.progress = progress;
        const now = Date.now();
        if (now - task.lastProgressEventAt >= PROGRESS_EVENT_INTERVAL_MS) {
          task.lastProgressEventAt = now;
          this.options.events.addEvent('task_progress', `${task.record.id} ${task.record.behavior}: ${progress}`);
        }
      }
    };

    try {
      if (context.isPaused()) await context.waitUntilRunning();
      // The task may have been cancelled between being resumed and getting here.
      task.controller.signal.throwIfAborted();
      const result = await behavior.run(context);
      this.finish(task, 'done', result);
    } catch (error) {
      if (!task.controller.signal.aborted) {
        this.finish(task, 'failed', error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (task.lease?.isActive()) this.stopBody();
      task.lease?.release();
      task.resolveFinished({ ...task.record });
    }
  }

  private finish(task: RunningTask, status: 'done' | 'failed' | 'cancelled', result: string): void {
    if (this.isFinal(task)) return;
    task.record.status = status;
    task.record.result = result;
    task.record.endedAt = Date.now();
    task.record.pauseReason = undefined;
    const text = status === 'done' ? result : `${status} (${result})`;
    this.options.events.addEvent(`task_${status}`, `${task.record.id} ${task.record.behavior}: ${text}`);
    if (this.current === task) this.current = null;
    this.history.unshift({ ...task.record });
    this.history.length = Math.min(this.history.length, HISTORY_LIMIT);
  }

  private isFinal(task: RunningTask): boolean {
    return task.record.status === 'done' || task.record.status === 'failed' || task.record.status === 'cancelled';
  }

  private stopBody(): void {
    try {
      const bot = this.options.getBot();
      stopPathfinder(bot);
      bot.clearControlStates();
    } catch (error) {
      this.options.log?.('warn', `Could not stop the bot: ${error}`);
    }
  }
}
