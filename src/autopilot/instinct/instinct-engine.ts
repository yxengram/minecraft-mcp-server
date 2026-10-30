// Contract: docs/BLUEPRINT.md F-040 (M9 changes in F1-h). The instinct: when the attention gate says so, hands the situation and the menu
// of what is possible to the decision model, and runs the macro it picks. Code never maps an event to a behavior
// here: without a decision (no key, turned off, timeout, error, budget used up) the bot does not act on its own and
// the danger is left to the LLM (user decision, BLUEPRINT I1).
import type mineflayer from 'mineflayer';
import { performance } from 'node:perf_hooks';
import { ActionArbiter, Lease, Preemptor, PRIORITY } from '../action-arbiter.js';
import type { Policy } from '../policy.js';
import type { TaskManager } from '../task-manager.js';
import type { EventStore } from '../../event-store.js';
import type { DecisionQuestion, DecisionResult } from '../../decisions/openrouter-client.js';
import { stopPathfinder } from '../../tools/movement-utils.js';
import { airLevel, armorPoints } from '../../tools/gamestate-tools.js';
import { Attention, burnedByLava, Chaser, Cue, CueKind, CUE_URGENCY, DamageInfo, outranks, readCues } from './attention.js';
import { assessThreats } from '../threats.js';
import { bestWeaponName } from '../combat.js';
import { buildMenu, MenuOption, OptionId } from './affordances.js';
import { MACROS } from './macros.js';
import { burningNow, enclosedNow, headInWater, inLavaNow } from '../hazards.js';
import { label } from './motor.js';
import { FLEE_DISTANCE } from './affordances.js';

export interface InstinctEngineOptions {
  bot: mineflayer.Bot;
  arbiter: ActionArbiter;
  tasks: Pick<TaskManager, 'currentTask' | 'hold' | 'describe' | 'resumesOnRelease'>;
  getPolicy: () => Policy;
  events: EventStore;
  /** A decision request on the instinct's own budget (F-015); `second` marks the hedged second request (E-037). */
  decide: (state: Record<string, unknown>, questions: Record<string, DecisionQuestion>, options?: { second?: boolean }) => Promise<DecisionResult>;
  /** Called first when the bot dies, before a running action lets go of the body (autopilot.ts cancels the task). */
  onDeath?: () => void;
  log?: (level: string, message: string) => void;
}

export interface InstinctStatus {
  enabled: boolean;
  /** Why the last request got no decision, while that is still the latest news. */
  offline: string | null;
  running: { action: OptionId; ms: number; reason: string } | null;
  lastDecision: string | null;
  /** Per-tick evaluation cost (invariant I6). */
  timing: { ticks: number; averageMs: number; maxMs: number };
}

const FULL_AIR_TICKS = 300;

type Outcome = 'done' | 'failed' | 'timeout' | 'interrupted';

interface Running {
  option: MenuOption;
  reason: string;
  /** The latest answer said the task should not carry on afterwards: hold it for the LLM when the action ends. */
  holdTaskAfter: boolean;
  /**
   * The bot was walled in already when the action started (eating in a dig_in hole, say): getting out is then not this
   * action's doing, and a task the AI player resumed or started in there must not be held again (E-048).
   */
  walledInAtStart: boolean;
  started: number;
  controller: AbortController;
  lease: Lease;
  timer: ReturnType<typeof setTimeout>;
  finished: boolean;
  /** The mobs a flee or run_from_creeper ran from, to tell the model whether they came back (E-016). */
  watch: { id: number; label: string }[];
  /** Health when it started and hits taken since: whether the running action is working (E-016). */
  startHealth: number | null;
  hits: number;
}

// The instinct's recent actions and how they turned out, as facts for the model (E-016): whether a mob the bot ran
// from came back is what tells it that running again will not end the danger.
const RECENT_ACTION_MS = 120_000;
const RECENT_ACTION_LIMIT = 5;
const RUNS = new Set(['flee', 'run_from_creeper']);
// A mob that came back counts as chasing the bot for this long (the 'chased' cue).
const CHASE_MS = 30_000;
// Cues that can kill within seconds (the first five of CUE_URGENCY). A slow answer about them gets a second, identical
// request, and the first valid answer is used (E-019): in the task test one 1.5 s timeout at 5.3 health was fatal.
export const HEDGE_CUES: CueKind[] = CUE_URGENCY.slice(0, 5);
// The M5 probe: median 0.64 s, slowest 1.07 s over 198 calls.
export const HEDGE_MS = 800;
// Failures another request may not have (E-037). A refused key or credit (auth, no_credit), a 429 (throttled), a
// pause (backoff), rate_limited and disabled would fail the same way again.
const HEDGE_AFTER: Set<string> = new Set(['timeout', 'server_error', 'network', 'invalid_response']);

type HedgedResult = DecisionResult & { second?: boolean };

interface RecentAction {
  endedAt: number;
  text: string;
  watch: { id: number; label: string }[];
  cameBack: string | null;
  /** The mob that came back, and when. */
  chaser: { id: number; label: string; at: number } | null;
}

class InstinctAbort extends Error {}

// Earlier dangers the model is told about, so it can see that a task keeps leading the bot back into the same one
// (the day-2 loop: escape, the task resumes, back into the water) and choose suspend_task. A fact, not a rule.
const HISTORY_MS = 120_000;
const HISTORY_LIMIT = 5;

interface PastDanger {
  endedAt: number;
  kinds: string;
  result: string;
  task: string | null;
}

const ACTION_INSTRUCTIONS =
  'You are the instinct of a Minecraft bot that an AI player controls. The bot senses the danger described in ' +
  '`danger`. Choose what the bot should do in the next few seconds. Prefer an option that ends the danger before it ' +
  'costs much health; an instinct action that is already running (instinct_action_running) can be kept with ' +
  '`continue`. ai_player_intent is what the AI player wants right now and outweighs earlier_dangers: if it says the ' +
  'bot is in this situation on purpose, `continue` is right until the bot is about to be badly hurt (for example ' +
  'very little air left). recent_instinct_actions tells how the instinct\'s last actions turned out, for example a mob ' +
  'that came back after the bot ran away from it.';
const URGENT_INSTRUCTIONS =
  'Is the danger in `danger` serious enough that the bot must act now, even if that interrupts a command the AI ' +
  'player is running? Low air under water, a ceiling over the water, standing in lava, burning, a creeper about to ' +
  'explode and low health with hostiles near are serious; plenty of air with an open way up, mild hunger, or one ' +
  'hit at high health is not.';

const RESUME_INSTRUCTIONS =
  'Once the bot is out of this danger, should the task in doing_now carry on by itself? Answer false when ' +
  'earlier_dangers shows that this task keeps leading the bot back into the same kind of danger, so the AI player ' +
  'should decide first.';
// Below this, the task is held for the LLM once the action ends. The M8 probe: 0.20-0.26 when the task had led the bot
// back into the same danger before, 0.88-0.95 the first time.
export const RESUME_THRESHOLD = 0.5;

export function instinctQuestions(menu: MenuOption[], { hasTask = false } = {}): Record<string, DecisionQuestion> {
  const questions: Record<string, DecisionQuestion> = {
    action: { type: 'choice', instructions: ACTION_INSTRUCTIONS, criteria: Object.fromEntries(menu.map(option => [option.id, option.text])) },
    urgent: {
      type: 'noul',
      instructions: URGENT_INSTRUCTIONS,
      criteria: { true: 'the bot could die or lose a lot of health within seconds unless it acts now', false: 'the bot can safely wait for the AI player' }
    }
  };
  if (hasTask) {
    questions.resume_task = {
      type: 'noul',
      instructions: RESUME_INSTRUCTIONS,
      criteria: { true: 'the task can safely carry on afterwards', false: 'the task should stay paused for the AI player' }
    };
  }
  return questions;
}

function orUnknown<T>(read: () => T): T | 'unknown' {
  try {
    return read();
  } catch {
    return 'unknown';
  }
}

export class InstinctEngine {
  private readonly attention = new Attention();
  private running: Running | null = null;
  // Requests are numbered; only the newest one's answer may act (a new cue supersedes one in flight).
  private requestSeq = 0;
  private inFlight = false;
  // The cues of the request in flight, to judge whether a new cue is more urgent than all of them.
  private inFlightCues: Cue[] = [];
  private damage: DamageInfo | null = null;
  private diedSinceSpawn = false;
  private stats = { ticks: 0, totalMs: 0, maxMs: 0 };
  private stopped = true;
  private offline: string | null = null;
  // Offline reasons already reported in the current danger episode (one event per episode and reason).
  private offlineReported = { episode: -1, errors: new Set<string>() };
  private lastDecision: string | null = null;
  private lastResult: string | null = null;
  // Repeats of the same decision within one danger episode are written once.
  private lastLogged: { episode: number; key: string } | null = null;
  private history: PastDanger[] = [];
  private recentActions: RecentAction[] = [];
  // The current danger episode: what it is about, how many times the model was asked, and the last action's result.
  private episodeInfo = { kinds: '', rounds: 0, result: null as string | null };
  private readonly onTick = () => this.tick();
  private readonly onDeath = () => {
    this.diedSinceSpawn = true;
    // First, while an action may still hold the body: the task is cancelled before anything could resume it (M7).
    try {
      this.options.onDeath?.();
    } catch (error) {
      this.options.log?.('warn', `Instinct death callback failed: ${error}`);
    }
    this.damage = null;
    if (this.running) this.finish(this.running, 'interrupted', 'the bot died');
    // A new life starts somewhere else: mobs the bot ran from before it died are not chasing it now.
    this.recentActions = [];
    if (this.attention.inEpisode()) this.endEpisode(Date.now(), 'the bot died');
    this.attention.reset();
  };

  // mineflayer keeps the bot's own entity data across a respawn, and the server only sends values that change, so a
  // burning flag or low air from the moment of death would stay set and keep the instinct asking about them.
  private readonly onSpawn = () => {
    if (!this.diedSinceSpawn) return;
    this.diedSinceSpawn = false;
    const metadata = this.options.bot.entity?.metadata as unknown[] | undefined;
    if (!metadata) return;
    if (typeof metadata[0] === 'number') metadata[0] = metadata[0] & ~0x01;
    metadata[1] = FULL_AIR_TICKS;
  };

  constructor(private readonly options: InstinctEngineOptions) {}

  /** The latest hit (E-005 onDamage), for the 'attacked' cue. */
  noteDamage(info: DamageInfo): void {
    this.damage = info;
    if (this.running && info.attackerId !== undefined) this.running.hits++;
  }

  start(): void {
    if (!this.stopped || typeof this.options.bot.on !== 'function') return;
    this.stopped = false;
    this.options.bot.on('physicsTick', this.onTick);
    this.options.bot.on('death', this.onDeath);
    this.options.bot.on('spawn', this.onSpawn);
  }

  stop(reason = 'stopped'): void {
    if (this.running) this.finish(this.running, 'interrupted', reason);
    if (this.stopped) return;
    this.stopped = true;
    this.options.bot.removeListener('physicsTick', this.onTick);
    this.options.bot.removeListener('death', this.onDeath);
    this.options.bot.removeListener('spawn', this.onSpawn);
  }

  status(): InstinctStatus {
    const run = this.running;
    return {
      enabled: this.options.getPolicy().instinct.enabled,
      offline: this.offline,
      running: run ? { action: run.option.id, ms: Date.now() - run.started, reason: run.reason } : null,
      lastDecision: this.lastDecision,
      timing: { ticks: this.stats.ticks, averageMs: this.stats.ticks ? this.stats.totalMs / this.stats.ticks : 0, maxMs: this.stats.maxMs }
    };
  }

  /** One evaluation; public so tests can drive it without a game loop. */
  tick(now = Date.now()): void {
    const { bot } = this.options;
    if (this.stopped || !bot.entity || (typeof bot.health === 'number' && bot.health <= 0)) return;
    const startedAt = performance.now();
    try {
      this.noteReturns(now);
      this.evaluate(now);
    } finally {
      const elapsed = performance.now() - startedAt;
      this.stats.ticks++;
      this.stats.totalMs += elapsed;
      this.stats.maxMs = Math.max(this.stats.maxMs, elapsed);
    }
  }

  private evaluate(now: number): void {
    const { bot } = this.options;
    const policy = this.options.getPolicy();
    if (!policy.instinct.enabled) {
      if (this.running) this.finish(this.running, 'interrupted', 'the instinct was turned off');
      this.attention.reset();
      return;
    }
    let cues: Cue[];
    try {
      cues = readCues(bot, policy, this.damage, now, this.chasers(now));
    } catch (error) {
      this.options.log?.('warn', `Instinct could not read the situation: ${error}`);
      return;
    }
    const wasInEpisode = this.attention.inEpisode();
    const episode = this.attention.episode;
    // The episode lasts while an instinct action runs, even if its cue is hidden meanwhile (a fight hides 'attacked').
    const reason = this.attention.shouldAsk(cues, now, policy.instinct.reaskMs, this.running !== null);
    if (wasInEpisode && !this.attention.inEpisode()) this.endEpisode(now);
    if (this.attention.episode !== episode) this.episodeInfo = { kinds: '', rounds: 0, result: null };
    // A new, more urgent cue does not wait behind a request about something else (a hit must not hold up a lit
    // creeper); a less urgent one does not throw away the answer that is on its way.
    if (!reason || (this.inFlight && !(reason === 'new' && outranks(cues, this.inFlightCues)))) return;
    this.ask(cues, policy, now);
  }

  /** Marks a recent run whose mob is back within the flee distance (memory reads only, I6). */
  private noteReturns(now: number): void {
    const { bot } = this.options;
    for (const action of this.recentActions) {
      if (action.cameBack || action.watch.length === 0) continue;
      for (const mob of action.watch) {
        const live = bot.entities?.[mob.id];
        if (!live || live.isValid === false || !live.position) continue;
        if (live.position.distanceTo(bot.entity.position) <= FLEE_DISTANCE) {
          action.cameBack = `${mob.label} came within ${FLEE_DISTANCE} blocks again ${Math.round((now - action.endedAt) / 1000)}s later`;
          action.chaser = { id: mob.id, label: mob.label, at: now };
          break;
        }
      }
    }
  }

  /** "flee for 4.0s; hit 2 time(s) and lost 6 health since it started; zombie (id 9) is 0.8 blocks away" (E-016). */
  private describeRunning(run: Running): string {
    const { bot } = this.options;
    const parts = [`${run.option.id} for ${((Date.now() - run.started) / 1000).toFixed(1)}s`];
    const lost = run.startHealth !== null && typeof bot.health === 'number' ? Math.max(0, run.startHealth - bot.health) : null;
    parts.push(run.hits > 0
      ? `hit ${run.hits} time(s)${lost !== null ? ` and lost ${Number(lost.toFixed(1))} health` : ''} since it started`
      : 'not hit since it started');
    const about = run.watch.length > 0 ? run.watch.map(mob => mob.id) : run.option.entityId !== undefined ? [run.option.entityId] : [];
    const nearest = about
      .map(id => bot.entities?.[id])
      .filter((mob): mob is NonNullable<typeof mob> => Boolean(mob && mob.isValid !== false && mob.position))
      .map(mob => ({ mob, distance: mob.position.distanceTo(bot.entity.position) }))
      .sort((a, b) => a.distance - b.distance)[0];
    if (nearest) parts.push(`${label(nearest.mob)} is ${nearest.distance.toFixed(1)} blocks away`);
    return parts.join('; ');
  }

  /** Mobs that came back after a run in the last 30 s, newest first, for the 'chased' cue. */
  private chasers(now: number): Chaser[] {
    return this.recentActions
      .filter(action => action.chaser && now - action.chaser.at <= CHASE_MS)
      .reverse()
      .map(action => ({ id: action.chaser!.id, label: action.chaser!.label, detail: action.cameBack!.replace(`${action.chaser!.label} `, '') }));
  }

  private recentInstinctActions(): string[] | 'none' {
    const now = Date.now();
    this.recentActions = this.recentActions.filter(action => now - action.endedAt <= RECENT_ACTION_MS).slice(-RECENT_ACTION_LIMIT);
    if (this.recentActions.length === 0) return 'none';
    return this.recentActions.map(action =>
      `${Math.round((now - action.endedAt) / 1000)}s ago: ${action.text}${action.cameBack ? `; ${action.cameBack}` : ''}`);
  }

  /** Remembers how a danger episode ended, for the next ones. */
  private endEpisode(now: number, ending?: string): void {
    const task = this.options.tasks.currentTask();
    this.history.push({
      endedAt: now,
      kinds: this.episodeInfo.kinds || 'danger',
      result: ending ?? this.episodeInfo.result ?? 'no instinct action',
      task: task ? `${task.id} ${task.behavior} (${task.status})` : null
    });
    this.history = this.history.filter(past => now - past.endedAt <= HISTORY_MS).slice(-HISTORY_LIMIT);
  }

  private ask(cues: Cue[], policy: Policy, now: number): void {
    const { bot } = this.options;
    let menu: MenuOption[];
    let state: Record<string, unknown>;
    const hasTask = this.options.tasks.currentTask() !== null;
    this.episodeInfo.rounds++;
    this.episodeInfo.kinds = [...new Set(cues.map(cue => cue.kind))].join(', ');
    try {
      menu = buildMenu(bot, cues, { hasTask, policy });
      state = this.state(cues, policy);
    } catch (error) {
      this.options.log?.('warn', `Instinct could not build its menu: ${error}`);
      return;
    }
    this.attention.noteAsked(cues, now);
    this.inFlight = true;
    this.inFlightCues = cues;
    const episode = this.attention.episode;
    const seq = ++this.requestSeq;
    const hedge = cues.some(cue => HEDGE_CUES.includes(cue.kind));
    this.decide(state, instinctQuestions(menu, { hasTask }), hedge, seq, episode)
      .then(result => {
        if (seq !== this.requestSeq) {
          // A newer request about a new cue is out: this answer only goes on record.
          if (result.ok && result.answers.action?.type === 'choice') {
            this.options.events.addEvent('instinct', `${cues.map(cue => cue.detail).join('; ')} → ${result.answers.action.choice} (superseded by a newer request; not acted on)`);
          }
          return;
        }
        this.handle(result, menu, cues, episode);
      })
      .catch(error => this.options.log?.('warn', `Instinct decision failed: ${error}`))
      .finally(() => {
        if (seq === this.requestSeq) this.inFlight = false;
      });
  }

  /**
   * One decision, or for urgent cues up to two identical requests (E-019): the second goes out when the first has not
   * answered within HEDGE_MS or failed before that, unless a newer request superseded this one, the engine stopped,
   * the instinct was turned off or the danger ended. The first valid answer wins; when both fail, the result is the
   * first request's failure.
   */
  private decide(state: Record<string, unknown>, questions: Record<string, DecisionQuestion>, hedge: boolean, seq: number, episode: number): Promise<HedgedResult> {
    if (!hedge) return this.options.decide(state, questions);
    return new Promise(resolve => {
      let settled = false;
      let pending = 0;
      let second = false;
      let failure: DecisionResult | null = null;
      const settle = (result: HedgedResult) => {
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const current = () => !this.stopped && seq === this.requestSeq && this.options.getPolicy().instinct.enabled &&
        this.attention.inEpisode() && this.attention.episode === episode;
      const launch = (isSecond: boolean) => {
        pending++;
        (isSecond ? this.options.decide(state, questions, { second: true }) : this.options.decide(state, questions))
          .catch((error): DecisionResult => ({ ok: false, error: 'network', message: `request failed: ${error}`, latencyMs: 0 }))
          .then(result => {
            pending--;
            if (settled) return;
            if (result.ok) {
              settle(isSecond ? { ...result, second: true } : result);
              return;
            }
            // Only the first request's failure is kept as the reason: a second one refused by the budget says nothing
            // about the danger.
            if (!isSecond) failure = result;
            if (!second && HEDGE_AFTER.has(result.error) && current()) {
              startSecond();
              return;
            }
            if (pending === 0) settle(failure ?? result);
          });
      };
      const startSecond = () => {
        second = true;
        clearTimeout(timer);
        launch(true);
      };
      const timer = setTimeout(() => {
        if (!settled && !second && current()) startSecond();
      }, HEDGE_MS);
      launch(false);
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
        // With only the damage cue, in_lava false made the model hesitate: leave_lava 0.37, continue 0.33; 0.97 once
        // the fact agreed (M16 probe).
        in_lava: inLavaNow(bot) || burnedByLava(this.damage),
        on_fire: burningNow(bot),
        held_item: bot.heldItem?.name ?? 'nothing',
        // Optional facts: one that cannot be read must not cost the whole decision.
        armor_points: orUnknown(() => armorPoints(bot)),
        best_weapon: orUnknown(() => bestWeaponName(bot)),
        hostiles_within_16: orUnknown(() => assessThreats(bot, { radius: 16 }).hostiles.slice(0, 8)
          .map(threat => `${threat.entity.name ?? 'unknown'} ${threat.distance.toFixed(1)} blocks`))
      },
      danger: cues.map(cue => cue.detail),
      doing_now: doing.length > 0 ? doing.join('; ') : 'nothing',
      instinct_action_running: run ? this.describeRunning(run) : 'none',
      last_instinct_result: this.lastResult ?? 'none',
      times_asked_about_this_danger: this.episodeInfo.rounds,
      earlier_dangers: this.earlierDangers(),
      recent_instinct_actions: this.recentInstinctActions(),
      ai_player_intent: policy.instinct.intent || 'none given'
    };
  }

  private earlierDangers(): string[] | 'none' {
    const now = Date.now();
    const recent = this.history.filter(past => now - past.endedAt <= HISTORY_MS);
    if (recent.length === 0) return 'none';
    return recent.map(past =>
      `${Math.round((now - past.endedAt) / 1000)}s ago: ${past.kinds}, ended with ${past.result}${past.task ? `; task ${past.task} afterwards` : ''}`);
  }

  private handle(result: HedgedResult, menu: MenuOption[], cues: Cue[], episode: number): void {
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
    const resumeAnswer = result.answers.resume_task;
    const holdTaskAfter = resumeAnswer?.type === 'noul' && resumeAnswer.noul < RESUME_THRESHOLD;
    if (action?.type !== 'choice') return;
    const choice = action.choice as OptionId;
    const p = action.probabilities[choice] ?? action.confidence;
    const urgentP = urgentAnswer?.type === 'noul' ? urgentAnswer.noul : 0;
    const urgent = urgentP >= policy.urgentThreshold;
    const resumeText = resumeAnswer?.type === 'noul' ? `, resume task p=${resumeAnswer.noul.toFixed(2)}` : '';
    const summary = `${choice} p=${p.toFixed(2)}, urgent p=${urgentP.toFixed(2)}${resumeText} (${result.model}; ${result.latencyMs}ms${result.second ? ', second request' : ''})`;

    let taken: string;
    // The danger may be over by the time the answer arrives (e.g. the bot surfaced): record it, do nothing.
    if (!this.attention.inEpisode() || episode !== this.attention.episode) {
      taken = 'arrived after the danger ended; not acted on';
    } else if (p < policy.actThreshold) {
      taken = `not confident enough (below ${policy.actThreshold}); no change`;
    } else {
      const option = menu.find(entry => entry.id === choice);
      taken = this.act(option, choice, urgent, dangers, holdTaskAfter);
    }
    this.lastDecision = `${dangers} → ${summary} → ${taken}`;
    const key = `${choice}|${taken}`;
    if (!this.lastLogged || this.lastLogged.episode !== episode || this.lastLogged.key !== key) {
      this.lastLogged = { episode, key };
      this.options.events.addEvent('instinct', this.lastDecision);
    }
  }

  private act(option: MenuOption | undefined, choice: OptionId, urgent: boolean, reason: string, holdTaskAfter: boolean): string {
    const after = holdTaskAfter && this.options.tasks.currentTask() ? '; the task will wait for the AI player afterwards' : '';
    if (option?.macro) {
      if (this.running?.option.id === option.id) {
        this.running.holdTaskAfter = holdTaskAfter;
        return `kept ${option.id} running${after}`;
      }
      const holder = this.options.arbiter.holder();
      if (holder?.priority === PRIORITY.MANUAL && !urgent) return 'not interrupting the AI player\'s command (not urgent)';
      return this.launch(option, urgent ? PRIORITY.URGENT_INSTINCT : PRIORITY.INSTINCT, reason, holdTaskAfter) + after;
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

  private launch(option: MenuOption, priority: typeof PRIORITY.URGENT_INSTINCT | typeof PRIORITY.INSTINCT, reason: string, holdTaskAfter: boolean): string {
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
    const watch: { id: number; label: string }[] = [];
    if (RUNS.has(option.id)) {
      const mobs = assessThreats(bot, { radius: FLEE_DISTANCE }).hostiles.map(threat => threat.entity);
      const named = option.entityId === undefined ? undefined : bot.entities?.[option.entityId];
      if (named && !mobs.some(mob => mob.id === named.id)) mobs.push(named);
      for (const mob of mobs) watch.push({ id: mob.id, label: label(mob) });
    }
    const running: Running = {
      option,
      reason,
      holdTaskAfter,
      walledInAtStart: this.walledIn(),
      started: Date.now(),
      controller,
      lease,
      timer: setTimeout(() => this.finish(running, 'timeout', `timed out after ${macro.maxDurationMs / 1000}s`), macro.maxDurationMs),
      finished: false,
      watch,
      startHealth: typeof bot.health === 'number' ? bot.health : null,
      hits: 0
    };
    this.running = running;
    macro.run({ bot, signal: controller.signal, target: option.target ?? null, entityId: option.entityId, policy: this.options.getPolicy() })
      .then(text => this.finish(running, 'done', text))
      .catch(error => {
        if (controller.signal.aborted) return;
        this.finish(running, 'failed', error instanceof Error ? error.message : String(error));
      });
    return `started ${option.id}${priority === PRIORITY.URGENT_INSTINCT ? ' (urgent)' : ''}`;
  }

  /**
   * Ends an action once. Stops the body only while this action still owns it, and before releasing: releasing hands
   * the body back to a paused task, which re-applies its own goal (BLUEPRINT G4).
   */
  /** enclosedNow, false when the world cannot be read: a failed check must not stop the body being handed back. */
  private walledIn(): boolean {
    try {
      return enclosedNow(this.options.bot);
    } catch {
      return false;
    }
  }

  private finish(run: Running, outcome: Outcome, text: string, { keepBody = false, reask = true } = {}): void {
    if (run.finished) return;
    run.finished = true;
    clearTimeout(run.timer);
    run.controller.abort(new InstinctAbort(text));
    // Hold the task before letting go of the body, so it does not resume for a moment and walk back into the danger.
    // An action that leaves the bot walled in never hands the body back to the task, however it ended: in the M18 field
    // test the resumed lead task dug the bot out of its dig_in hole and a skeleton shot it (E-048). Leaving is the AI
    // player's call, as with leaveShelter (M17). Only a task that is waiting for the body is held, so a task already
    // held (suspend_task, a manual command) keeps its own reason.
    let held = '';
    const task = this.options.tasks.currentTask();
    const sheltered = Boolean(task) && !keepBody && !run.walledInAtStart && this.options.tasks.resumesOnRelease() && this.walledIn();
    const why = sheltered
      ? 'the bot is walled in, and resuming the task would dig it out of its shelter'
      : run.holdTaskAfter && outcome !== 'interrupted' ? 'the task kept leading the bot back into this danger' : null;
    if (why && task) {
      this.options.tasks.hold(`held by the instinct after ${run.option.id}: ${why}`);
      held = `; task ${task.id} held for the AI player`;
    }
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
    const endedAt = Date.now();
    this.recentActions.push({ endedAt, text: `${this.lastResult} (${seconds}s)`, watch: run.watch, cameBack: null, chaser: null });
    this.recentActions = this.recentActions.filter(action => endedAt - action.endedAt <= RECENT_ACTION_MS).slice(-RECENT_ACTION_LIMIT);
    this.episodeInfo.result = this.lastResult;
    this.options.events.addEvent('instinct', `${run.option.id} → ${outcome === 'done' ? text : `${outcome}: ${text}`} (${seconds}s)${held}`);
    if (reask) this.attention.noteActionEnded();
  }
}
