// Contract: docs/BLUEPRINT.md F-040. The instinct: when the attention gate says so, hands the situation and the menu
// of what is possible to the decision model, and runs the macro it picks. Code never maps an event to a behavior
// here: without a decision (no key, turned off, timeout, error, budget used up) the bot does not act on its own and
// the danger is left to the LLM (user decision, BLUEPRINT I1).
import type mineflayer from 'mineflayer';
import { ActionArbiter, Lease, Preemptor, PRIORITY } from '../action-arbiter.js';
import type { Policy } from '../policy.js';
import type { TaskManager } from '../task-manager.js';
import type { EventStore } from '../../event-store.js';
import type { DecisionQuestion, DecisionResult } from '../../decisions/openrouter-client.js';
import { stopPathfinder } from '../../tools/movement-utils.js';
import { airLevel } from '../../tools/gamestate-tools.js';
import { Attention, Cue, readCues } from './attention.js';
import { buildMenu, MenuOption, OptionId } from './affordances.js';
import { MACROS } from './macros.js';
import { burningNow, headInWater, inLavaNow } from '../hazards.js';

export interface InstinctEngineOptions {
  bot: mineflayer.Bot;
  arbiter: ActionArbiter;
  tasks: Pick<TaskManager, 'currentTask' | 'hold' | 'describe'>;
  getPolicy: () => Policy;
  events: EventStore;
  /** A decision request on the instinct's own budget (F-015). */
  decide: (state: Record<string, unknown>, questions: Record<string, DecisionQuestion>) => Promise<DecisionResult>;
  log?: (level: string, message: string) => void;
}

export interface InstinctStatus {
  enabled: boolean;
  /** Why the last request got no decision, while that is still the latest news. */
  offline: string | null;
  running: { action: OptionId; ms: number; reason: string } | null;
  lastDecision: string | null;
}

type Outcome = 'done' | 'failed' | 'timeout' | 'interrupted';

interface Running {
  option: MenuOption;
  reason: string;
  started: number;
  controller: AbortController;
  lease: Lease;
  timer: ReturnType<typeof setTimeout>;
  finished: boolean;
}

class InstinctAbort extends Error {}

const ACTION_INSTRUCTIONS =
  'You are the instinct of a Minecraft bot that an AI player controls. The bot senses the danger described in ' +
  '`danger`. Choose what the bot should do in the next few seconds. Prefer an option that ends the danger before it ' +
  'costs much health; an instinct action that is already running (instinct_action_running) can be kept with ' +
  '`continue`. If ai_player_intent says the bot is in this situation on purpose and it is not about to be badly hurt, ' +
  '`continue` is right.';
const URGENT_INSTRUCTIONS =
  'Is the danger in `danger` serious enough that the bot must act now, even if that interrupts a command the AI ' +
  'player is running? Low air under water, a ceiling over the water, standing in lava and burning are serious; plenty ' +
  'of air with an open way up is not.';

export function instinctQuestions(menu: MenuOption[]): Record<string, DecisionQuestion> {
  return {
    action: { type: 'choice', instructions: ACTION_INSTRUCTIONS, criteria: Object.fromEntries(menu.map(option => [option.id, option.text])) },
    urgent: {
      type: 'noul',
      instructions: URGENT_INSTRUCTIONS,
      criteria: { true: 'the bot could die or lose a lot of health within seconds unless it acts now', false: 'the bot can safely wait for the AI player' }
    }
  };
}

export class InstinctEngine {
  private readonly attention = new Attention();
  private running: Running | null = null;
  private inFlight = false;
  private stopped = true;
  private offline: string | null = null;
  // Offline reasons already reported in the current danger episode (one event per episode and reason).
  private offlineReported = { episode: -1, errors: new Set<string>() };
  private lastDecision: string | null = null;
  private lastResult: string | null = null;
  // Repeats of the same decision within one danger episode are written once.
  private lastLogged: { episode: number; key: string } | null = null;
  private readonly onTick = () => this.tick();
  private readonly onDeath = () => {
    if (this.running) this.finish(this.running, 'interrupted', 'the bot died');
    this.attention.reset();
  };

  constructor(private readonly options: InstinctEngineOptions) {}

  start(): void {
    if (!this.stopped || typeof this.options.bot.on !== 'function') return;
    this.stopped = false;
    this.options.bot.on('physicsTick', this.onTick);
    this.options.bot.on('death', this.onDeath);
  }

  stop(reason = 'stopped'): void {
    if (this.running) this.finish(this.running, 'interrupted', reason);
    if (this.stopped) return;
    this.stopped = true;
    this.options.bot.removeListener('physicsTick', this.onTick);
    this.options.bot.removeListener('death', this.onDeath);
  }

  status(): InstinctStatus {
    const run = this.running;
    return {
      enabled: this.options.getPolicy().instinct.enabled,
      offline: this.offline,
      running: run ? { action: run.option.id, ms: Date.now() - run.started, reason: run.reason } : null,
      lastDecision: this.lastDecision
    };
  }

  /** One evaluation; public so tests can drive it without a game loop. */
  tick(now = Date.now()): void {
    const { bot } = this.options;
    if (this.stopped || !bot.entity || (typeof bot.health === 'number' && bot.health <= 0)) return;
    const policy = this.options.getPolicy();
    if (!policy.instinct.enabled) {
      if (this.running) this.finish(this.running, 'interrupted', 'the instinct was turned off');
      this.attention.reset();
      return;
    }
    let cues: Cue[];
    try {
      cues = readCues(bot, policy);
    } catch (error) {
      this.options.log?.('warn', `Instinct could not read the situation: ${error}`);
      return;
    }
    if (!this.attention.shouldAsk(cues, now, policy.instinct.reaskMs) || this.inFlight) return;
    this.ask(cues, policy, now);
  }

  private ask(cues: Cue[], policy: Policy, now: number): void {
    const { bot } = this.options;
    let menu: MenuOption[];
    let state: Record<string, unknown>;
    try {
      menu = buildMenu(bot, cues, { hasTask: this.options.tasks.currentTask() !== null });
      state = this.state(cues, policy);
    } catch (error) {
      this.options.log?.('warn', `Instinct could not build its menu: ${error}`);
      return;
    }
    this.attention.noteAsked(cues, now);
    this.inFlight = true;
    const episode = this.attention.episode;
    this.options.decide(state, instinctQuestions(menu))
      .then(result => this.handle(result, menu, cues, episode))
      .catch(error => this.options.log?.('warn', `Instinct decision failed: ${error}`))
      .finally(() => {
        this.inFlight = false;
      });
  }

  private state(cues: Cue[], policy: Policy): Record<string, unknown> {
    const { bot, arbiter, tasks } = this.options;
    const holder = arbiter.holder();
    const task = tasks.currentTask();
    const doing: string[] = [];
    if (holder && holder.priority === PRIORITY.MANUAL) doing.push(`running a command from the AI player (${holder.holder.replace(/^manual /, '')})`);
    else if (holder && !holder.holder.startsWith('task ') && !holder.holder.startsWith('instinct ')) doing.push(holder.holder);
    if (task) doing.push(`task ${tasks.describe(task)}`);
    const run = this.running;
    return {
      situation: {
        health: bot.health,
        food: bot.food,
        air: airLevel(bot) ?? 'unknown',
        head_under_water: headInWater(bot),
        in_lava: inLavaNow(bot),
        on_fire: burningNow(bot),
        held_item: bot.heldItem?.name ?? 'nothing'
      },
      danger: cues.map(cue => cue.detail),
      doing_now: doing.length > 0 ? doing.join('; ') : 'nothing',
      instinct_action_running: run ? `${run.option.id} for ${((Date.now() - run.started) / 1000).toFixed(1)}s` : 'none',
      last_instinct_result: this.lastResult ?? 'none',
      ai_player_intent: policy.instinct.intent || 'none given'
    };
  }

  private handle(result: DecisionResult, menu: MenuOption[], cues: Cue[], episode: number): void {
    if (this.stopped) return;
    const dangers = cues.map(cue => cue.detail).join('; ');
    if (!result.ok) {
      this.offline = `${result.error}: ${result.message}`;
      if (this.offlineReported.episode !== episode) this.offlineReported = { episode, errors: new Set() };
      if (!this.offlineReported.errors.has(result.error)) {
        this.offlineReported.errors.add(result.error);
        this.options.events.addEvent('instinct', `instinct offline (${this.offline}): ${dangers}; the bot does not act on its own, decide what to do`);
      }
      return;
    }
    this.offline = null;
    const policy = this.options.getPolicy().instinct;
    const action = result.answers.action;
    const urgentAnswer = result.answers.urgent;
    if (action?.type !== 'choice') return;
    const choice = action.choice as OptionId;
    const p = action.probabilities[choice] ?? action.confidence;
    const urgentP = urgentAnswer?.type === 'noul' ? urgentAnswer.noul : 0;
    const urgent = urgentP >= policy.urgentThreshold;
    const summary = `${choice} p=${p.toFixed(2)}, urgent p=${urgentP.toFixed(2)} (${result.model}; ${result.latencyMs}ms)`;

    let taken: string;
    // The danger may be over by the time the answer arrives (e.g. the bot surfaced): record it, do nothing.
    if (!this.attention.inEpisode() || episode !== this.attention.episode) {
      taken = 'arrived after the danger ended; not acted on';
    } else if (p < policy.actThreshold) {
      taken = `not confident enough (below ${policy.actThreshold}); no change`;
    } else {
      const option = menu.find(entry => entry.id === choice);
      taken = this.act(option, choice, urgent, dangers);
    }
    this.lastDecision = `${dangers} → ${summary} → ${taken}`;
    const key = `${choice}|${taken}`;
    if (!this.lastLogged || this.lastLogged.episode !== episode || this.lastLogged.key !== key) {
      this.lastLogged = { episode, key };
      this.options.events.addEvent('instinct', this.lastDecision);
    }
  }

  private act(option: MenuOption | undefined, choice: OptionId, urgent: boolean, reason: string): string {
    if (option?.macro) {
      if (this.running?.option.id === option.id) return `kept ${option.id} running`;
      const holder = this.options.arbiter.holder();
      if (holder?.priority === PRIORITY.MANUAL && !urgent) return 'not interrupting the AI player\'s command (not urgent)';
      return this.launch(option, urgent ? PRIORITY.CRITICAL_REFLEX : PRIORITY.ROUTINE_REFLEX, reason);
    }
    if (choice === 'suspend_task' || choice === 'ask_llm') {
      // Hold the task before stopping the action: releasing the action's lease first would hand the body back to the
      // task for a moment, and it would walk straight back into the danger.
      const task = this.options.tasks.currentTask();
      if (task) this.options.tasks.hold(`paused by the instinct (${choice}): ${reason}`);
      if (this.running) this.finish(this.running, 'interrupted', `stopped: ${choice}`);
      return task ? `paused task ${task.id} and left it to the AI player` : 'left it to the AI player';
    }
    return 'no change';
  }

  private launch(option: MenuOption, priority: typeof PRIORITY.CRITICAL_REFLEX | typeof PRIORITY.ROUTINE_REFLEX, reason: string): string {
    const { arbiter, bot } = this.options;
    const macro = MACROS[option.macro!];
    const previous = this.running;
    let lease: Lease | null = null;
    const onSuspend = (by: Preemptor) => {
      // Give the lease back at once: a suspended lease would later be resumed with nobody driving it.
      const run = this.running;
      if (run && run.lease === lease) this.finish(run, 'interrupted', `interrupted by ${by.holder}`, { keepBody: true });
      else lease?.release();
    };
    const acquired = arbiter.acquireNow({ holder: `instinct ${option.id}`, priority, onSuspend }, previous?.lease);
    if (!acquired) return `could not take the body (${arbiter.holder()?.holder ?? 'busy'})`;
    lease = acquired;
    if (previous) this.finish(previous, 'interrupted', `replaced by ${option.id}`, { keepBody: true, reask: false });

    const controller = new AbortController();
    const running: Running = {
      option,
      reason,
      started: Date.now(),
      controller,
      lease,
      timer: setTimeout(() => this.finish(running, 'timeout', `timed out after ${macro.maxDurationMs / 1000}s`), macro.maxDurationMs),
      finished: false
    };
    this.running = running;
    macro.run({ bot, signal: controller.signal, target: option.target ?? null })
      .then(text => this.finish(running, 'done', text))
      .catch(error => {
        if (controller.signal.aborted) return;
        this.finish(running, 'failed', error instanceof Error ? error.message : String(error));
      });
    return `started ${option.id}${priority === PRIORITY.CRITICAL_REFLEX ? ' (urgent)' : ''}`;
  }

  /**
   * Ends an action once. Stops the body only while this action still owns it, and before releasing: releasing hands
   * the body back to a paused task, which re-applies its own goal (BLUEPRINT G4).
   */
  private finish(run: Running, outcome: Outcome, text: string, { keepBody = false, reask = true } = {}): void {
    if (run.finished) return;
    run.finished = true;
    clearTimeout(run.timer);
    run.controller.abort(new InstinctAbort(text));
    if (run.lease.isActive() && !keepBody) {
      try {
        stopPathfinder(this.options.bot);
        this.options.bot.clearControlStates();
        this.options.bot.stopDigging?.();
      } catch (error) {
        this.options.log?.('warn', `Could not stop the bot after instinct ${run.option.id}: ${error}`);
      }
    }
    run.lease.release();
    if (this.running === run) this.running = null;
    const seconds = ((Date.now() - run.started) / 1000).toFixed(1);
    this.lastResult = `${run.option.id} → ${outcome}: ${text}`;
    this.options.events.addEvent('instinct', `${run.option.id} → ${outcome === 'done' ? text : `${outcome}: ${text}`} (${seconds}s)`);
    if (reask) this.attention.noteActionEnded();
  }
}
