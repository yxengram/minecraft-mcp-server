// Contract: docs/BLUEPRINT.md F-012. Runs on every game tick without the LLM: picks at most one triggered reflex,
// takes the body at its priority, and reports what happened as `reflex` events.
import type mineflayer from 'mineflayer';
import { performance } from 'node:perf_hooks';
import { ActionArbiter, Lease, Preemptor, PRIORITY } from './action-arbiter.js';
import type { Policy } from './policy.js';
import { assessThreats, DEFAULT_THREAT_RADIUS, ThreatSummary } from './threats.js';
import type { EventStore } from '../event-store.js';
import type { CombatJudgment, CombatSituation } from '../decisions/decision-hooks.js';
import { stopPathfinder } from '../tools/movement-utils.js';

export type ReflexName = 'creeper-evade' | 'hazard-escape' | 'low-health-retreat' | 'self-defense' | 'auto-eat';

/** The most recent hit the bot took (E-005 onDamage). */
export interface DamageInfo {
  attackerId?: number;
  type: string;
  time: number;
}

export interface TriggerContext {
  bot: mineflayer.Bot;
  policy: Policy;
  threats: ThreatSummary;
  /** The last hit, while it is fresh enough to react to. */
  damage: DamageInfo | null;
  now: number;
}

export interface ReflexRunContext extends TriggerContext {
  signal: AbortSignal;
  /** Asks the decision model whether to fight, flee or hold (M5); absent in tests that do not need it. */
  judgeCombat?: (attackerId: number, situation: CombatSituation) => Promise<CombatJudgment>;
}

/** A trigger returns why it fires, a note to report without acting (e.g. hit by a player), or null. */
export type TriggerResult = { fire: string } | { note: string } | null;

export interface ReflexDefinition {
  name: ReflexName;
  /** PRIORITY.CRITICAL_REFLEX (manual commands wait) or PRIORITY.ROUTINE_REFLEX (manual commands interrupt it). */
  priority: typeof PRIORITY.CRITICAL_REFLEX | typeof PRIORITY.ROUTINE_REFLEX;
  cooldownMs: number;
  maxDurationMs: number;
  enabled(policy: Policy): boolean;
  /** Memory-only check run every tick: no waiting, no network (invariant I6). */
  trigger(context: TriggerContext): TriggerResult;
  /** Drives the body until done; must stop issuing actions once `signal` aborts. Returns the result text. */
  run(context: ReflexRunContext): Promise<string>;
}

export interface ReflexEngineOptions {
  bot: mineflayer.Bot;
  arbiter: ActionArbiter;
  getPolicy: () => Policy;
  events: EventStore;
  /** In priority order, highest first. */
  reflexes: ReflexDefinition[];
  judgeCombat?: ReflexRunContext['judgeCombat'];
  /** Called first when the bot dies, before the running reflex lets go of the body (so nothing resumes). */
  onDeath?: () => void;
  log?: (level: string, message: string) => void;
}

export interface EngineStats {
  ticks: number;
  averageMs: number;
  maxMs: number;
}

// A hit is worth reacting to only right after it lands.
const DAMAGE_FRESH_MS = 1000;
// A routine reflex that cannot get the body (a command or critical reflex has it) waits this long before retrying.
const BLOCKED_BACKOFF_MS = 1000;
// Triggering this often within the window is reported once, so the LLM can step in (e.g. move the bot elsewhere).
const REPEAT_WINDOW_MS = 30000;
const REPEAT_LIMIT = 4;
const FULL_AIR_TICKS = 300;

class ReflexAbort extends Error {}

interface Running {
  reflex: ReflexDefinition;
  rank: number;
  reason: string;
  started: number;
  controller: AbortController;
  lease: Lease;
  timer: ReturnType<typeof setTimeout>;
  finished: boolean;
}

export class ReflexEngine {
  private running: Running | null = null;
  private readonly cooldownUntil = new Map<ReflexName, number>();
  private readonly recentTriggers = new Map<ReflexName, number[]>();
  private readonly repeatReportedAt = new Map<ReflexName, number>();
  private readonly failedTriggers = new Set<ReflexName>();
  private damage: DamageInfo | null = null;
  private started = false;
  private stats = { ticks: 0, totalMs: 0, maxMs: 0 };
  private diedSinceSpawn = false;
  private readonly onTick = () => this.tick();
  private readonly onDeath = () => {
    this.diedSinceSpawn = true;
    this.notify(() => this.options.onDeath?.());
    this.abortRunning('the bot died');
  };
  // mineflayer keeps the bot's own entity data across a respawn, and the server only sends values that change, so a
  // burning flag or low air from the moment of death would stay set and keep triggering hazard-escape.
  private readonly onSpawn = () => {
    if (!this.diedSinceSpawn) return;
    this.diedSinceSpawn = false;
    const metadata = this.options.bot.entity?.metadata as unknown[] | undefined;
    if (!metadata) return;
    if (typeof metadata[0] === 'number') metadata[0] = metadata[0] & ~0x01;
    metadata[1] = FULL_AIR_TICKS;
  };

  constructor(private readonly options: ReflexEngineOptions) {}

  start(): void {
    // Simple test doubles without events never tick; a real bot always has them.
    if (this.started || typeof this.options.bot.on !== 'function') return;
    this.started = true;
    this.options.bot.on('physicsTick', this.onTick);
    this.options.bot.on('death', this.onDeath);
    this.options.bot.on('spawn', this.onSpawn);
  }

  stop(reason = 'stopped'): void {
    this.abortRunning(reason);
    if (!this.started) return;
    this.started = false;
    this.options.bot.removeListener('physicsTick', this.onTick);
    this.options.bot.removeListener('death', this.onDeath);
    this.options.bot.removeListener('spawn', this.onSpawn);
  }

  noteDamage(info: DamageInfo): void {
    this.damage = info;
  }

  current(): { name: ReflexName; reason: string; ms: number } | null {
    return this.running ? { name: this.running.reflex.name, reason: this.running.reason, ms: Date.now() - this.running.started } : null;
  }

  timing(): EngineStats {
    const { ticks, totalMs, maxMs } = this.stats;
    return { ticks, averageMs: ticks ? totalMs / ticks : 0, maxMs };
  }

  /** One evaluation; public so tests can drive it without a game loop. */
  tick(now = Date.now()): void {
    const { bot } = this.options;
    if (!bot.entity || (typeof bot.health === 'number' && bot.health <= 0)) return;

    const startedAt = performance.now();
    try {
      const policy = this.options.getPolicy();
      const damage = this.damage && now - this.damage.time <= DAMAGE_FRESH_MS ? this.damage : null;
      const threats = assessThreats(bot, {
        radius: Math.max(DEFAULT_THREAT_RADIUS, policy.reflexes.lowHealthRetreat.radius),
        lowHealth: policy.reflexes.lowHealthRetreat.health,
        lowAir: policy.reflexes.hazardEscape.lowAir
      });
      const context: TriggerContext = { bot, policy, threats, damage, now };
      const reflexes = this.options.reflexes;
      // While a reflex runs, only reflexes ranked above it are considered (they may interrupt it).
      const limit = this.running ? this.running.rank : reflexes.length;

      for (let rank = 0; rank < limit; rank++) {
        const reflex = reflexes[rank];
        if (!reflex.enabled(policy) || (this.cooldownUntil.get(reflex.name) ?? 0) > now) continue;
        let result: TriggerResult;
        try {
          result = reflex.trigger(context);
        } catch (error) {
          if (!this.failedTriggers.has(reflex.name)) {
            this.failedTriggers.add(reflex.name);
            this.options.log?.('warn', `Reflex ${reflex.name} trigger failed: ${error}`);
          }
          continue;
        }
        if (!result) continue;
        if ('note' in result) {
          this.options.events.addEvent('reflex', `${reflex.name}: ${result.note}`);
          this.cooldownUntil.set(reflex.name, now + reflex.cooldownMs);
          if (reflex.name === 'self-defense') this.damage = null;
          continue;
        }
        if (this.launch(reflex, rank, result.fire, context)) break;
      }
    } finally {
      const elapsed = performance.now() - startedAt;
      this.stats.ticks++;
      this.stats.totalMs += elapsed;
      this.stats.maxMs = Math.max(this.stats.maxMs, elapsed);
    }
  }

  private launch(reflex: ReflexDefinition, rank: number, reason: string, context: TriggerContext): boolean {
    const { arbiter, bot } = this.options;
    const previous = this.running;
    const controller = new AbortController();
    let lease: Lease | null = null;
    const onSuspend = (by: Preemptor) => {
      // Give the lease back at once: a suspended reflex lease would otherwise be resumed later and hold the body
      // with nobody driving it, keeping the paused task waiting forever.
      const run = this.running;
      if (run && run.lease === lease) {
        this.finish(run, 'interrupted', `interrupted by ${by.kind === 'manual' ? 'manual command ' + by.holder.replace(/^manual /, '') : by.holder}`, { keepBody: true });
      } else {
        lease?.release();
      }
    };

    // A running reflex hands its lease straight to the one interrupting it (same-priority reflexes cannot preempt
    // each other through the arbiter, and nothing paused should resume in between).
    const acquired = arbiter.acquireNow({ holder: `reflex ${reflex.name}`, priority: reflex.priority, onSuspend }, previous?.lease);
    if (!acquired) {
      // Busy with a manual command or a critical reflex: try again a little later, without an event.
      this.cooldownUntil.set(reflex.name, context.now + BLOCKED_BACKOFF_MS);
      return false;
    }
    lease = acquired;
    if (previous) this.finish(previous, 'interrupted', `interrupted by ${reflex.name}`, { keepBody: true });

    if (reflex.name === 'self-defense') this.damage = null;
    const running: Running = {
      reflex,
      rank,
      reason,
      started: Date.now(),
      controller,
      lease,
      timer: setTimeout(() => this.finish(running, 'timeout', `timed out after ${reflex.maxDurationMs / 1000}s`), reflex.maxDurationMs),
      finished: false
    };
    this.running = running;
    this.noteTrigger(reflex.name, context.now);

    reflex.run({ ...context, bot, signal: controller.signal, judgeCombat: this.options.judgeCombat })
      .then(result => this.finish(running, 'done', result))
      .catch(error => {
        if (controller.signal.aborted) return;
        this.finish(running, 'failed', `failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    return true;
  }

  private abortRunning(reason: string): void {
    if (this.running) this.finish(this.running, 'interrupted', `interrupted: ${reason}`);
  }

  /**
   * Ends a reflex once. Stops the body only while this reflex still owns it, and before releasing: releasing hands
   * the body back to the paused task, which re-applies its own goal (BLUEPRINT G4).
   */
  private finish(run: Running, outcome: 'done' | 'failed' | 'timeout' | 'interrupted', text: string, { keepBody = false } = {}): void {
    if (run.finished) return;
    run.finished = true;
    clearTimeout(run.timer);
    run.controller.abort(new ReflexAbort(text));
    if (run.lease.isActive() && !keepBody) {
      try {
        stopPathfinder(this.options.bot);
        this.options.bot.clearControlStates();
      } catch (error) {
        this.options.log?.('warn', `Could not stop the bot after reflex ${run.reflex.name}: ${error}`);
      }
    }
    run.lease.release();
    if (this.running === run) this.running = null;

    const seconds = ((Date.now() - run.started) / 1000).toFixed(1);
    this.options.events.addEvent('reflex', `${run.reflex.name}: ${run.reason} → ${text} (${seconds}s)`);
    this.cooldownUntil.set(run.reflex.name, Date.now() + run.reflex.cooldownMs);
    if (outcome === 'failed') this.options.log?.('warn', `Reflex ${run.reflex.name} ${text}`);
  }

  private notify(hook: () => void): void {
    try {
      hook();
    } catch (error) {
      this.options.log?.('warn', `Reflex engine callback failed: ${error}`);
    }
  }

  private noteTrigger(name: ReflexName, now: number): void {
    const recent = (this.recentTriggers.get(name) ?? []).filter(time => now - time < REPEAT_WINDOW_MS);
    recent.push(now);
    this.recentTriggers.set(name, recent);
    const reportedAt = this.repeatReportedAt.get(name) ?? -Infinity;
    if (recent.length >= REPEAT_LIMIT && now - reportedAt >= REPEAT_WINDOW_MS) {
      this.repeatReportedAt.set(name, now);
      this.options.events.addEvent('reflex', `${name}: triggered ${recent.length} times in ${REPEAT_WINDOW_MS / 1000}s; the bot may be stuck in a dangerous spot (move it, or turn the reflex off with set-policy)`);
    }
  }
}
