// Contract: docs/BLUEPRINT.md F-001 (M1–M3 scope: arbiter, tasks, behaviors, policy, reflexes, bind/unbind; decisions come in M4).
import type mineflayer from 'mineflayer';
import { ActionArbiter, HolderInfo, PRIORITY } from './action-arbiter.js';
import { TaskManager, TaskRecord, BehaviorDefinition } from './task-manager.js';
import { followBehavior } from './behaviors/follow.js';
import { fleeBehavior } from './behaviors/flee.js';
import { guardBehavior } from './behaviors/guard.js';
import { gatherBehavior } from './behaviors/gather.js';
import { huntBehavior } from './behaviors/hunt.js';
import { returnHomeBehavior } from './behaviors/return-home.js';
import { PolicyStore } from './policy.js';
import { DamageInfo, ReflexEngine } from './reflex-engine.js';
import { REFLEXES } from './reflexes.js';
import type { EventStore } from '../event-store.js';
import type { WaypointStore } from '../waypoint-store.js';
import { stopPathfinder } from '../tools/movement-utils.js';

export const BEHAVIORS = [
  followBehavior, fleeBehavior, guardBehavior, gatherBehavior, huntBehavior, returnHomeBehavior
] as unknown as BehaviorDefinition<never, never>[];

export interface AutopilotOptions {
  events: EventStore;
  /** Saved waypoints, read by guard and return-home. */
  waypoints?: WaypointStore;
  log?: (level: string, message: string) => void;
}

export class AutopilotNotReady extends Error {
  constructor() {
    super('The bot is not in the game yet. Try again in a moment.');
  }
}

export class Autopilot {
  private bot: mineflayer.Bot | null = null;
  private arbiterInstance: ActionArbiter | null = null;
  private reflexEngine: ReflexEngine | null = null;
  readonly tasks: TaskManager;
  readonly policy = new PolicyStore();

  constructor(private readonly options: AutopilotOptions) {
    this.tasks = new TaskManager({
      getBot: () => this.requireBot(),
      getArbiter: () => this.arbiter,
      events: options.events,
      behaviors: BEHAVIORS,
      services: { waypoints: options.waypoints, policy: () => this.policy.get() },
      log: options.log
    });
  }

  isReady(): boolean {
    return this.bot !== null;
  }

  get arbiter(): ActionArbiter {
    if (!this.arbiterInstance) throw new AutopilotNotReady();
    return this.arbiterInstance;
  }

  get reflexes(): ReflexEngine {
    if (!this.reflexEngine) throw new AutopilotNotReady();
    return this.reflexEngine;
  }

  bind(bot: mineflayer.Bot): void {
    if (this.bot === bot) return;
    if (this.bot) this.unbind('rebound to a new bot');
    this.bot = bot;
    const arbiter = new ActionArbiter({
      stopBody: () => {
        stopPathfinder(bot);
        bot.clearControlStates();
      },
      log: this.options.log
    });
    this.arbiterInstance = arbiter;
    // Every (re)join starts from the default policy (user decision, PLAN Q2).
    this.policy.reset();
    this.options.events.addEvent('policy', 'policy reset to defaults (bot joined the game)');
    this.reflexEngine = new ReflexEngine({
      bot,
      arbiter,
      getPolicy: () => this.policy.get(),
      events: this.options.events,
      reflexes: REFLEXES,
      log: this.options.log
    });
    this.reflexEngine.start();
  }

  unbind(reason = 'disconnected'): void {
    if (!this.bot) return;
    // Cancel tasks first: stopping a running reflex releases its lease, which would otherwise resume the paused task
    // just before it is cancelled.
    void this.tasks.cancelAll(reason);
    this.reflexEngine?.stop(reason);
    this.reflexEngine = null;
    this.bot = null;
    this.arbiterInstance = null;
  }

  noteDamage(info: DamageInfo): void {
    this.reflexEngine?.noteDamage(info);
  }

  /**
   * Text appended to a manual command's result when it interrupted something, so the LLM knows what the bot
   * was doing a moment before and can decide whether to resume it.
   */
  describeInterruption(preempted: HolderInfo[], waited?: { holder: string; ms: number }): string | null {
    const lines: string[] = [];
    if (waited && waited.ms >= 250) {
      lines.push(`Waited ${(waited.ms / 1000).toFixed(1)}s for ${waited.holder} to finish before running this command.`);
    }

    for (const info of preempted) {
      if (info.priority === PRIORITY.TASK) {
        const task = this.tasks.currentTask();
        if (task) {
          lines.push(`Interrupted before this command: ${this.tasks.describe(task)}. It is paused: call resume-task ${task.id} to continue or cancel-task ${task.id} to drop it.`);
          continue;
        }
      }
      lines.push(`Interrupted before this command: ${info.holder}.`);
    }

    return lines.length > 0 ? lines.join('\n') : null;
  }

  currentTask(): TaskRecord | null {
    return this.tasks.currentTask();
  }

  private requireBot(): mineflayer.Bot {
    if (!this.bot) throw new AutopilotNotReady();
    return this.bot;
  }
}
