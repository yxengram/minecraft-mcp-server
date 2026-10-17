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
import { OpenRouterClient, OpenRouterClientOptions } from '../decisions/openrouter-client.js';
import { ChatCommand, ChatCommandOutcome, DecisionHooks, planChatCommand } from '../decisions/decision-hooks.js';
import { findNearbyEntities } from '../tools/entity-utils.js';
import minecraftData from 'minecraft-data';
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
  /** --decision-model; survives every policy reset. */
  decisionModel?: string;
  /** For tests: a fake fetch and key instead of the network and OPENROUTER_API_KEY. */
  decisions?: Pick<OpenRouterClientOptions, 'fetch' | 'getKey' | 'now' | 'timeoutMs'>;
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
  readonly policy: PolicyStore;
  readonly decisions: OpenRouterClient;
  private readonly hooks: DecisionHooks;

  constructor(private readonly options: AutopilotOptions) {
    this.policy = new PolicyStore({ decisionModel: options.decisionModel });
    this.decisions = new OpenRouterClient({ getPolicy: () => this.policy.get(), ...options.decisions });
    this.hooks = new DecisionHooks({
      decide: (state, questions) => this.decisions.decide(state, questions),
      canDecide: () => this.decisions.isConfigured() && this.policy.get().decisions.enabled,
      getPolicy: () => this.policy.get(),
      events: options.events,
      botName: () => this.bot?.username,
      currentTaskSummary: () => {
        const task = this.tasks.currentTask();
        return task ? `${task.behavior} (${task.summary}), ${task.status}` : null;
      },
      runCommand: (command, speaker, message) => this.runChatCommand(command, speaker, message),
      reply: (speaker, whisper, text) => {
        try {
          if (whisper) this.bot?.whisper(speaker, text);
          else this.bot?.chat(`${speaker}: ${text}`);
        } catch (error) {
          options.log?.('warn', `Could not reply in chat: ${error}`);
        }
      },
      log: options.log
    });
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

  /** A chat line or whisper from another player; sorted by the decision model in the background (F-016). */
  handleChat(speaker: string, message: string, whisper: boolean): void {
    if (this.bot) this.hooks.handleChat(speaker, message, whisper);
  }

  /** Runs one of the fixed chat commands for an authorized player; reports what it replaced. */
  private async runChatCommand(command: ChatCommand, speaker: string, message: string): Promise<ChatCommandOutcome> {
    const bot = this.bot;
    if (!bot) return { ok: false, detail: 'not run: the bot is not in the game', reply: 'not now' };
    const plan = planChatCommand(command, speaker, message, {
      nearbyLogs: () => {
        const data = minecraftData(bot.version);
        const logs = data.blocksArray.filter(block => block.name.endsWith('_log') && !block.name.startsWith('stripped_'));
        const found = bot.findBlock({ matching: logs.map(block => block.id), maxDistance: 32 });
        return found ? [found.name] : [];
      },
      nearbyAnimals: () => findNearbyEntities(bot, { maxDistance: 32 }).map(nearby => nearby.entity.name ?? '')
    });
    if ('error' in plan) return { ok: false, detail: `not run: ${plan.error}`, reply: plan.error };

    const previous = this.tasks.currentTask();
    if (plan.kind === 'stop') {
      if (!previous) return { ok: true, detail: 'nothing to stop', reply: 'nothing to stop' };
      await this.tasks.cancel(previous.id, `stopped by ${speaker} in chat`);
      return { ok: true, detail: `cancelled ${this.tasks.describe(previous)}`, reply: plan.reply };
    }
    const started = await this.tasks.start(plan.behavior, plan.params, { source: 'chat' });
    if (!started.ok) return { ok: false, detail: `not started: ${started.error}`, reply: `can't: ${started.error}` };
    const replaced = previous ? ` (replaced ${this.tasks.describe(previous)})` : '';
    return { ok: true, detail: `started ${started.task.id} ${started.task.behavior}${replaced}`, reply: plan.reply };
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
