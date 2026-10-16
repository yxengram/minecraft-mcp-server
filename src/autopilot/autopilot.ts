// Contract: docs/BLUEPRINT.md F-001 (M1–M2 scope: arbiter, tasks, behaviors, bind/unbind; reflexes, policy and decisions come later).
import type mineflayer from 'mineflayer';
import { ActionArbiter, HolderInfo, PRIORITY } from './action-arbiter.js';
import { TaskManager, TaskRecord, BehaviorDefinition } from './task-manager.js';
import { followBehavior } from './behaviors/follow.js';
import { fleeBehavior } from './behaviors/flee.js';
import { guardBehavior } from './behaviors/guard.js';
import { gatherBehavior } from './behaviors/gather.js';
import { huntBehavior } from './behaviors/hunt.js';
import { returnHomeBehavior } from './behaviors/return-home.js';
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
  readonly tasks: TaskManager;

  constructor(private readonly options: AutopilotOptions) {
    this.tasks = new TaskManager({
      getBot: () => this.requireBot(),
      getArbiter: () => this.arbiter,
      events: options.events,
      behaviors: BEHAVIORS,
      services: { waypoints: options.waypoints },
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

  bind(bot: mineflayer.Bot): void {
    if (this.bot === bot) return;
    if (this.bot) this.unbind('rebound to a new bot');
    this.bot = bot;
    this.arbiterInstance = new ActionArbiter({
      stopBody: () => {
        stopPathfinder(bot);
        bot.clearControlStates();
      },
      log: this.options.log
    });
  }

  unbind(reason = 'disconnected'): void {
    if (!this.bot) return;
    void this.tasks.cancelAll(reason);
    this.bot = null;
    this.arbiterInstance = null;
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
