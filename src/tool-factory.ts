import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, ZodError, ZodRawShape, ZodType } from "zod";
import { BotConnection } from './bot-connection.js';
import type { Autopilot } from './autopilot/autopilot.js';
import { PRIORITY, type HolderInfo, type Lease } from './autopilot/action-arbiter.js';
import type { EventStore } from './event-store.js';
import { AbortError, stopPathfinder, throwIfAborted } from './tools/movement-utils.js';
import { log } from './logger.js';
import type mineflayer from 'mineflayer';

// After a death or another abort, how long a stopped command may take to give up before its reply is replaced and
// its lease released (E-018, E-027).
export const DEATH_SETTLE_MS = 2000;
// How long stop-all waits for the body to be free (E-040): longer than DEATH_SETTLE_MS, or a stopped command that
// takes all of it to let go would be reported as still holding the body.
export const STOP_SETTLE_MS = 2500;
// How long to wait for the respawn, to say where the bot is now.
export const RESPAWN_WAIT_MS = 5000;
// Damage this recent is named as the likely cause of a death.
const DEATH_CAUSE_WINDOW_MS = 10000;
// A body command's time budget from the moment its call arrives, the connection check and the wait for the lease
// included (E-027): common MCP clients give up on a request after 60 s and cancel it, so the command stops first and
// its reply still arrives. The default; --call-limit-seconds sets another through the factory's options (E-038).
export const CALL_LIMIT_MS = 50000;
// What a long tool leaves of the budget for its reply (E-038): it stops waiting this long before the deadline.
export const REPLY_MARGIN_MS = 5000;
// The longest delay setTimeout takes; a longer one fires after 1 ms.
const MAX_TIMER_MS = 2 ** 31 - 1;
// How often a call whose request carries a progressToken sends notifications/progress (E-039). The default; the
// factory's options set another (the tests make it shorter).
export const PROGRESS_INTERVAL_MS = 5000;

type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

type McpResponse = {
  content: McpContent[];
  isError?: boolean;
  [key: string]: unknown;
};

// Tools that move, look, attack or use items; they hold the action lease while running (BLUEPRINT E-001).
// collect-block is not listed: it runs a gather task, which takes the body at task priority itself (E-004).
export const BODY_TOOLS = new Set([
  'move-to-position', 'move-in-direction', 'look-at', 'jump', 'fly-to', 'goto-waypoint',
  'dig-block', 'place-block', 'activate-block', 'use-item', 'activate-entity', 'attack-entity',
  'mount-entity', 'dismount', 'sleep', 'consume', 'equip-item', 'craft-item', 'smelt-item',
  'read-container', 'container-deposit', 'container-withdraw',
  'clear-region', 'fill-region', 'dig-tunnel'
]);

// Tools that are not body tools but run a task and wait for it; stop-all stops them too, and their task (E-040).
const TASK_WAIT_TOOLS = new Set(['collect-block', 'lead-animal']);

/** Why a tool call was stopped (E-027; ended, the bot left the game, since E-029). */
export type AbortReason = 'death' | 'cancelled' | 'budget' | 'stop-all' | 'ended';

const ABORT_TEXT: Record<AbortReason, string> = {
  death: 'the bot died',
  cancelled: 'cancelled by the MCP client',
  budget: 'the call ran out of time',
  'stop-all': 'stopped by stop-all',
  ended: 'the bot left the game'
};

/**
 * The reason a call's signal is aborted with. An AbortError, so the walking helpers and ctx.throwIfAborted throw it;
 * its message is what a task the call started is cancelled with (collect-block, lead-animal).
 */
export class CallAborted extends AbortError {
  constructor(readonly kind: AbortReason) {
    super(ABORT_TEXT[kind]);
  }
}

/** What an executor gets besides its arguments (E-027). */
export interface ToolContext {
  /** Aborted when the call is stopped: cancelled by the MCP client, out of time, the bot died or left, or stop-all. */
  readonly signal: AbortSignal;
  /** When the call's time budget ends (Date.now() milliseconds). */
  readonly deadline: number;
  remainingMs(): number;
  /** Moves the deadline, and with it a body tool's watchdog, `ms` later. */
  extendDeadline(ms: number): void;
  /** Throws the abort reason (an AbortError) once the signal is aborted. */
  throwIfAborted(): void;
  /**
   * The message of the call's progress notifications (E-039), sent only when the request asked for them: the text, or
   * a function called before each one. A function that throws, or text that is empty, gives the default
   * "<name>: running for N s".
   */
  setProgress(text: string | (() => string)): void;
}

/**
 * How long a long tool waits when the caller gives no time limit (E-038): what is left of the call's budget, less
 * REPLY_MARGIN_MS for the reply. Taken when the wait starts, so a wait for the lease counts; usually about 45 s.
 */
export function defaultLimitMs(ctx: ToolContext): number {
  return Math.max(0, ctx.remainingMs() - REPLY_MARGIN_MS);
}

/**
 * For a time limit the caller gave (E-038): moves the deadline, and with it a body tool's watchdog, so that `ms` from
 * now still leaves REPLY_MARGIN_MS for the reply. Only ever later; the caller answers for the MCP client's timeout.
 */
export function allowFor(ctx: ToolContext, ms: number): void {
  const short = ms + REPLY_MARGIN_MS - ctx.remainingMs();
  if (short > 0) ctx.extendDeadline(short);
}

/** A tool call that has not replied yet (E-027); E-040's stop-all stops these. */
export interface InFlightCall {
  readonly name: string;
  readonly started: number;
  readonly controller: AbortController;
  /** A body tool: it holds, or waits for, the action lease. */
  readonly body: boolean;
  /** Waiting for the action lease. */
  readonly queued: boolean;
  /** Stops the call: the body first when this call drives it, then the signal. Only the first reason counts. */
  abort(reason: AbortReason): void;
}

/** A call stopAll stopped (E-040): its name, how long it had run, and whether it was waiting for the lease. */
export interface StoppedCall {
  readonly call: InFlightCall;
  readonly name: string;
  readonly ms: number;
  readonly queued: boolean;
}

/** A notifications/progress for the request that carried `progressToken` (E-039); no total is given. */
interface ProgressNotification {
  method: 'notifications/progress';
  params: { progressToken: string | number; progress: number; message: string };
}

/** The part of the SDK's RequestHandlerExtra the factory reads. Direct calls (unit tests) pass none. */
interface CallExtra {
  signal?: AbortSignal;
  /** The request's _meta; a client that wants progress puts a progressToken there (the SDK's onprogress does). */
  _meta?: { progressToken?: string | number };
  /** Sends a notification about this request; the SDK drops it once the request was cancelled. */
  sendNotification?: (notification: ProgressNotification) => Promise<void>;
}

class ToolCall implements InFlightCall {
  readonly started = Date.now();
  readonly controller = new AbortController();
  queued = false;
  deadline: number;
  abortedAt: number | null = null;
  /** Why the bot this body command drove left the game, once it has (E-029). */
  endedBecause: string | null = null;
  /** Stops the body when this call drives it; set while a body command runs. */
  stopBody: () => void = () => {};
  readonly ctx: ToolContext;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private progressTimer: ReturnType<typeof setInterval> | undefined;
  private progressSent = 0;
  private progressText: string | (() => string) | null = null;
  private readonly onCancel = () => this.abort('cancelled');

  constructor(
    readonly name: string, readonly body: boolean, private readonly extra: CallExtra | undefined, limitMs: number,
    progressIntervalMs: number
  ) {
    this.deadline = this.started + limitMs;
    const call = this;
    this.ctx = {
      signal: this.controller.signal,
      get deadline() { return call.deadline; },
      remainingMs: () => Math.max(0, call.deadline - Date.now()),
      extendDeadline: ms => {
        call.deadline += ms;
        call.arm();
      },
      throwIfAborted: () => throwIfAborted(call.controller.signal),
      setProgress: text => { call.progressText = text; }
    };
    // A direct call without extra has no client to cancel it and no watchdog, as before (E-027). It still has a
    // deadline, so the long tools' default limits (E-038) apply to it as well.
    const cancel = extra?.signal;
    if (cancel?.aborted) this.abort('cancelled');
    else cancel?.addEventListener('abort', this.onCancel, { once: true });
    this.arm();
    // Progress only for a request that asked for it (E-039); without a progressToken there is no timer at all.
    const token = extra?._meta?.progressToken;
    const send = extra?.sendNotification;
    if ((typeof token === 'string' || typeof token === 'number') && typeof send === 'function' && !this.signal.aborted) {
      this.progressTimer = setInterval(() => this.sendProgress(token, send), progressIntervalMs);
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Why the call was stopped, or null while it runs. */
  get reason(): AbortReason | null {
    const reason: unknown = this.controller.signal.reason;
    return this.controller.signal.aborted && reason instanceof CallAborted ? reason.kind : null;
  }

  abort(reason: AbortReason): void {
    if (this.controller.signal.aborted) return;
    this.abortedAt = Date.now();
    clearTimeout(this.watchdog);
    // A stopped call is ending: what is left is its reply.
    clearInterval(this.progressTimer);
    // The body first, so a loop that wakes up on the abort finds the pathfinder already stopped.
    this.stopBody();
    this.controller.abort(new CallAborted(reason));
  }

  dispose(): void {
    clearTimeout(this.watchdog);
    clearInterval(this.progressTimer);
    this.extra?.signal?.removeEventListener('abort', this.onCancel);
  }

  /**
   * One progress notification (E-039): progress counts up from 1, and the message is the executor's setProgress text,
   * or the default. A failed send is only logged; the call and its result go on as if nothing was sent.
   */
  private sendProgress(progressToken: string | number, send: NonNullable<CallExtra['sendNotification']>): void {
    this.progressSent++;
    const notification: ProgressNotification = {
      method: 'notifications/progress',
      params: { progressToken, progress: this.progressSent, message: this.progressMessage() }
    };
    const failed = (error: unknown) =>
      log('warn', `Could not send a progress notification for ${this.name}: ${error instanceof Error ? error.message : String(error)}`);
    try {
      void Promise.resolve(send(notification)).catch(failed);
    } catch (error) {
      // A send that throws instead of rejecting.
      failed(error);
    }
  }

  private progressMessage(): string {
    const fallback = `${this.name}: running for ${Math.round((Date.now() - this.started) / 1000)} s`;
    const text = this.progressText;
    if (text === null) return fallback;
    try {
      const value = typeof text === 'function' ? text() : text;
      return typeof value === 'string' && value !== '' ? value : fallback;
    } catch {
      return fallback;
    }
  }

  // The watchdog is only on body tools; the others keep their own limits (wait-for-event at most 55 s). A deadline an
  // explicit timeoutMs moved (E-038) can be further away than setTimeout can wait, which would fire it at once: the
  // timer waits at most MAX_TIMER_MS and is set again until the deadline has come.
  private arm(): void {
    clearTimeout(this.watchdog);
    if (!this.body || !this.extra || this.controller.signal.aborted) return;
    this.watchdog = setTimeout(
      () => (Date.now() < this.deadline ? this.arm() : this.abort('budget')),
      Math.min(MAX_TIMER_MS, Math.max(0, this.deadline - Date.now()))
    );
  }
}

type Outcome = { ok: true; value: McpResponse } | { ok: false; error: unknown };

interface DeathWatch {
  died(): { at: string; cause: string } | null;
  respawned: Promise<void>;
  dispose(): void;
}

export interface ToolOptions {
  /** The tool drives the bot's body (moving, looking, attacking, using items) and must hold the action lease. */
  body?: boolean;
  /** Reject unknown top-level arguments instead of silently dropping them (the SDK strips them otherwise). */
  strict?: boolean;
}

export interface ToolFactoryOptions {
  /** Each call's time budget (E-038's --call-limit-seconds); CALL_LIMIT_MS when not given. */
  callLimitMs?: number;
  /** How often progress notifications go out (E-039); PROGRESS_INTERVAL_MS when not given. */
  progressIntervalMs?: number;
}

export class ToolFactory {
  private autopilotProvider: (() => Autopilot | null) | null = null;
  private events: EventStore | null = null;
  private readonly calls = new Set<ToolCall>();
  // The body commands waiting on each bot's end signal (E-029): one subscription per bot, not one per call.
  private readonly endWatchers = new WeakMap<mineflayer.Bot, Set<ToolCall>>();
  /** Each call's time budget, for the tools' descriptions and replies (E-038). */
  readonly callLimitMs: number;
  private readonly progressIntervalMs: number;

  constructor(
    private server: McpServer,
    private connection: BotConnection,
    options: ToolFactoryOptions = {}
  ) {
    this.callLimitMs = options.callLimitMs ?? CALL_LIMIT_MS;
    this.progressIntervalMs = options.progressIntervalMs ?? PROGRESS_INTERVAL_MS;
  }

  setAutopilot(provider: () => Autopilot | null): void {
    this.autopilotProvider = provider;
  }

  /** Where `command` events go (E-027): a cancelled call's reply is dropped by the SDK, so it is written there too. */
  setEvents(events: EventStore): void {
    this.events = events;
  }

  /** The calls that have not replied yet, queued ones included (for E-040's stop-all). */
  inFlight(): InFlightCall[] {
    return [...this.calls];
  }

  /** The calls stop-all stops (E-040): body calls, queued ones included, and collect-block and lead-animal. */
  static stoppable(call: InFlightCall): boolean {
    return call.body || TASK_WAIT_TOOLS.has(call.name);
  }

  /**
   * Stops every body call in flight, the ones waiting for the lease included, and collect-block and lead-animal, which
   * cancel the task they started (E-040). Queries, wait-for-event and stop-all itself go on. A call that was already
   * stopped for another reason is left to that. Each reply then reads "<name> was stopped by stop-all after N s at
   * (x, y, z)". Returns what was stopped, with the times and queue state from just before.
   */
  stopAll(reason: AbortReason): StoppedCall[] {
    const now = Date.now();
    const stopped: StoppedCall[] = [];
    for (const call of [...this.calls]) {
      if (!ToolFactory.stoppable(call) || call.signal.aborted) continue;
      stopped.push({ call, name: call.name, ms: now - call.started, queued: call.queued });
    }
    // All are aborted before any lets go of the lease, so a command waiting in the queue cannot take it in between.
    for (const { call } of stopped) call.abort(reason);
    return stopped;
  }

  registerTool(
    name: string,
    description: string,
    schema: Record<string, unknown>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor: (args: any, ctx: ToolContext) => Promise<McpResponse>,
    options: ToolOptions = {}
  ): void {
    const body = options.body ?? BODY_TOOLS.has(name);
    const respond = async (call: ToolCall, args: unknown): Promise<McpResponse> => {
      const connectionCheck = await this.connection.checkConnectionAndReconnect();

      if (!connectionCheck.connected) {
        return {
          content: [{ type: "text", text: connectionCheck.message! }],
          isError: true
        };
      }

      try {
        const parsedArgs = this.shouldValidateSchema(schema)
          ? this.parseArgs(schema as ZodRawShape, args)
          : args;
        if (body) {
          return await this.runWithBody(call, () => executor(parsedArgs, call.ctx));
        }
        const response = await executor(parsedArgs, call.ctx);
        // collect-block and lead-animal stopped by stop-all have cancelled their task by now; the reply is stop-all's
        // as for a body command (E-040).
        if (call.reason === 'stop-all') return this.stopAllReply(call, this.currentBot());
        return response;
      } catch (error) {
        if (!body && call.reason === 'stop-all') return this.stopAllReply(call, this.currentBot());
        return this.createErrorResponse(error as Error);
      }
    };
    const handler = async (args: unknown, extra?: CallExtra): Promise<McpResponse> => {
      // The budget starts now: the connection check and the wait for the lease count too (E-027). So does the
      // progress a client asked for (E-039): a call stuck in a reconnect is still running.
      const call = new ToolCall(name, body, extra, this.callLimitMs, this.progressIntervalMs);
      this.calls.add(call);
      try {
        return this.withJoinNote(call, await respond(call, args));
      } finally {
        this.calls.delete(call);
        call.dispose();
      }
    };

    if (options.strict) {
      // server.tool() only takes a raw shape, which the SDK turns into a stripping object schema.
      this.server.registerTool(name, { description, inputSchema: z.object(schema as ZodRawShape).strict() }, handler);
    } else {
      this.server.tool(name, description, schema, handler);
    }
  }

  // LLM commands run right away: they pause the current task and non-urgent instinct actions, and only wait (up to
  // 10 seconds) for urgent ones. The result tells the LLM what was interrupted. See BLUEPRINT G1.
  //
  // One way to stop them (E-027, with E-018's death handling folded in): a death, a cancel from the MCP client, the end
  // of the time budget or stop-all stop the body, abort ctx.signal, give the command DEATH_SETTLE_MS to give up, and
  // then release the lease and discard the command's result. When the bot leaves the game (E-029) there is no body to
  // stop and nothing to wait for: the lease goes and the reply comes at once.
  private async runWithBody(call: ToolCall, run: () => Promise<McpResponse>): Promise<McpResponse> {
    const name = call.name;
    const bot = this.currentBot();
    const autopilot = this.autopilotProvider?.();
    const arbiter = autopilot?.isReady() ? autopilot.arbiter : null;
    let lease: Lease | null = null;
    // Only the holder stops the body (G4): a command an urgent instinct action suspended, or one still waiting in the
    // queue, leaves it alone. Without the Autopilot there is no arbiter and the command is what drives the body. A
    // bot that left the game has no body to stop.
    call.stopBody = () => {
      if (bot && call.endedBecause === null && (!arbiter || lease?.isActive())) stopBody(bot);
    };
    const death = this.watchDeath(bot, call);
    const end = this.watchEnd(bot, call);
    try {
      let report: string | null = null;
      let interruptedBy: string | null = null;
      // A call stopped before it asks for the lease (e.g. during a reconnect) never waited for anyone: it skips the
      // queue, and runUntilAborted replies as for a command stopped before it started.
      if (arbiter && !call.signal.aborted) {
        call.queued = true;
        const acquired = await arbiter.acquire({
          holder: `manual ${name}`,
          priority: PRIORITY.MANUAL,
          onSuspend: by => { interruptedBy = by.holder; }
        }, undefined, call.signal);
        call.queued = false;
        if (!acquired.ok && acquired.aborted) return await this.abortedReply(call, bot, death, null, acquired);
        if (!acquired.ok) {
          return this.createErrorResponse(`Busy: ${acquired.busy.holder} is controlling the bot (waited ${(acquired.waitedMs / 1000).toFixed(1)}s). Try again shortly`);
        }
        lease = acquired.lease;
        report = autopilot!.describeInterruption(
          acquired.preempted,
          acquired.waitedFor ? { holder: acquired.waitedFor.holder, ms: acquired.waitedMs } : undefined
        );
      }

      const response = await this.runUntilAborted(call, run, () => lease?.release(), bot, death);
      const notes = [report, interruptedBy ? `This command was interrupted by ${interruptedBy}.` : null].filter(Boolean);
      if (notes.length === 0) return response;
      return { ...response, content: [...response.content, { type: "text", text: notes.join('\n') }] };
    } finally {
      lease?.release();
      death.dispose();
      end.dispose();
      call.stopBody = () => {};
    }
  }

  /** The command's own result, or once the call is aborted, the reply that says why it stopped. */
  private async runUntilAborted(
    call: ToolCall, run: () => Promise<McpResponse>, release: () => void, bot: mineflayer.Bot | null, death: DeathWatch
  ): Promise<McpResponse> {
    const state: { outcome: Outcome | null; beforeAbort: boolean } = { outcome: null, beforeAbort: false };
    if (call.signal.aborted) {
      // Stopped before the command started (before the lease was asked for, or since it was granted): the command never
      // starts, and a body it holds stops.
      call.stopBody();
    } else {
      const running = run();
      // Also takes a rejection that comes after the reply, so a command that fails late is not an unhandled rejection.
      const settled = running.then(
        value => { state.outcome = { ok: true, value }; state.beforeAbort = !call.signal.aborted; },
        error => { state.outcome = { ok: false, error }; state.beforeAbort = !call.signal.aborted; }
      );
      await Promise.race([settled, untilAborted(call.signal)]);
      if (state.outcome && state.beforeAbort) {
        if (state.outcome.ok) return state.outcome.value;
        throw state.outcome.error;
      }
      // A command of a bot that left the game may never settle, since the bot's listeners are gone. That body is gone
      // too, so releasing the lease now cannot let two holders drive it (E-029).
      if (!state.outcome && call.reason !== 'ended') await settleWithin(settled, DEATH_SETTLE_MS);
    }
    // Nothing of this call moves the body any more: its loops stopped on the signal, or its result is discarded.
    release();
    return this.abortedReply(call, bot, death, state.outcome, null);
  }

  /** `queued`: the call was stopped while it waited for the lease, which `busy` held. */
  private async abortedReply(
    call: ToolCall, bot: mineflayer.Bot | null, death: DeathWatch, outcome: Outcome | null,
    queued: { busy: HolderInfo; waitedMs: number } | null
  ): Promise<McpResponse> {
    const name = call.name;
    const seconds = (((call.abortedAt ?? Date.now()) - call.started) / 1000).toFixed(1);
    const at = cellText(bot?.entity?.position);
    switch (call.reason) {
      case 'death': {
        await Promise.race([death.respawned, delay(RESPAWN_WAIT_MS)]);
        const { at: diedAt, cause } = death.died() ?? { at: 'an unknown place', cause: '' };
        return this.createErrorResponse(
          `The bot died during ${name} at ${diedAt}${cause}; it respawned at ${cellText(bot?.entity?.position)} and the command was stopped`);
      }
      case 'budget': {
        if (queued) {
          return this.createErrorResponse(`Busy: ${queued.busy.holder} is controlling the bot (waited ${(queued.waitedMs / 1000).toFixed(1)}s). Try again shortly`);
        }
        // A command that gave up within DEATH_SETTLE_MS says how far it got, e.g. a region tool's counts.
        const own = outcome?.ok ? responseText(outcome.value).replace(/^Failed: /, '') : '';
        const budget = Math.round((call.deadline - call.started) / 1000);
        return this.createErrorResponse(
          `${name} did not finish within ${budget} s, so it was stopped at ${at}; call it again to continue, or use start-task for long jobs${own ? `\n${own}` : ''}`);
      }
      case 'ended':
        // Also for a call that waited for the lease: the body it waited for is gone. No command event: this reply
        // reaches the client.
        return this.createErrorResponse(
          `The bot left the game during ${name} (${call.endedBecause}); the command was stopped. The next tool call reconnects`);
      case 'stop-all':
        return this.stopAllReply(call, bot);
      case 'cancelled':
      default: {
        // The SDK drops the reply to a cancelled request, so the event is what the LLM can read later.
        const text = queued
          ? `${name} was cancelled by the MCP client while waiting for ${queued.busy.holder}`
          : `${name} was cancelled by the MCP client after ${seconds} s; the bot stopped at ${at}`;
        this.events?.addEvent('command', text);
        return this.createErrorResponse(text);
      }
    }
  }

  /** The reply of a call stop-all stopped (E-040), also written as a `command` event. */
  private stopAllReply(call: ToolCall, bot: mineflayer.Bot | null): McpResponse {
    const seconds = (((call.abortedAt ?? Date.now()) - call.started) / 1000).toFixed(1);
    const text = `${call.name} was stopped by stop-all after ${seconds} s at ${cellText(bot?.entity?.position)}`;
    this.events?.addEvent('command', text);
    return this.createErrorResponse(text);
  }

  /**
   * Stops a body command when the bot dies (E-018): in the live test a move-to-position walked the respawned bot back
   * to where it had just burned to death and then reported success. The reply says what happened instead.
   */
  private watchDeath(bot: mineflayer.Bot | null, call: ToolCall): DeathWatch {
    let died: { at: string; cause: string } | null = null;
    let signalSpawn: () => void = () => {};
    const respawned = new Promise<void>(resolve => { signalSpawn = resolve; });
    if (!bot || typeof bot.once !== 'function') return { died: () => null, respawned, dispose: () => {} };
    const onDeath = () => {
      // Listened for from the death on, so a respawn that comes quickly is not missed.
      bot.once('spawn', signalSpawn);
      const damage = (this.connection as { lastDamage?: () => { description: string; time: number } | null }).lastDamage?.();
      died = {
        at: cellText(bot.entity?.position),
        cause: damage && Date.now() - damage.time <= DEATH_CAUSE_WINDOW_MS ? ` (${damage.description})` : ''
      };
      call.abort('death');
    };
    bot.once('death', onDeath);
    return {
      died: () => died,
      respawned,
      dispose: () => {
        bot.removeListener?.('death', onDeath);
        bot.removeListener?.('spawn', signalSpawn);
      }
    };
  }

  /**
   * Stops a body command when its bot leaves the game (E-029). Letting go of the bot removes all of its listeners, the
   * pathfinder's and the death watch's included, so a pending goto, dig or window never settled and the call did not
   * return until the budget ran out. The connection's end signal is a promise, which survives that. A connection
   * without one (a stand-in) leaves the command as before.
   */
  private watchEnd(bot: mineflayer.Bot | null, call: ToolCall): { dispose(): void } {
    const connection = this.connection as { whenEnded?: (bot: mineflayer.Bot) => Promise<string> };
    if (!bot || typeof connection.whenEnded !== 'function') return { dispose: () => {} };
    // One subscription per bot: the promise keeps its callbacks until the bot leaves, which may be hours and many
    // calls later, so a callback per call would pile up. Once it has fired the entry goes, and a call that starts
    // after that subscribes again and is stopped at once.
    let calls = this.endWatchers.get(bot);
    if (!calls) {
      const watching = new Set<ToolCall>();
      calls = watching;
      this.endWatchers.set(bot, watching);
      void connection.whenEnded(bot).then(reason => {
        this.endWatchers.delete(bot);
        for (const waiting of [...watching]) {
          waiting.endedBecause = reason;
          waiting.abort('ended');
        }
      });
    }
    calls.add(call);
    const watched = calls;
    return { dispose: () => { watched.delete(call); } };
  }

  /**
   * Ends the first reply after a join with the connection's version warning, when the server is not 26.1.2 (E-030),
   * whether the reply is a success or an error. A connection without takeJoinNote (a stand-in) leaves the reply as it
   * is. The SDK drops the reply to a request the client cancelled, so that reply leaves the note for the next one.
   */
  private withJoinNote(call: ToolCall, response: McpResponse): McpResponse {
    if (call.reason === 'cancelled') return response;
    const note = (this.connection as { takeJoinNote?: () => string | null }).takeJoinNote?.();
    if (!note) return response;
    return { ...response, content: [...response.content, { type: "text", text: note }] };
  }

  private currentBot(): mineflayer.Bot | null {
    return (this.connection as { getBot?: () => mineflayer.Bot | null }).getBot?.() ?? null;
  }

  createResponse(text: string): McpResponse {
    return {
      content: [{ type: "text", text }]
    };
  }

  createImageResponse(text: string, image: Buffer, mimeType = "image/png"): McpResponse {
    return {
      content: [
        { type: "image", data: image.toString('base64'), mimeType },
        { type: "text", text }
      ]
    };
  }

  createErrorResponse(error: Error | string): McpResponse {
    const errorMessage = error instanceof Error ? error.message : error;
    return {
      content: [{ type: "text", text: `Failed: ${errorMessage}` }],
      isError: true
    };
  }

  private shouldValidateSchema(schema: Record<string, unknown>): boolean {
    const values = Object.values(schema);
    if (values.length === 0) {
      return true;
    }

    return values.every((value) => value instanceof ZodType);
  }

  private parseArgs(schema: ZodRawShape, args: unknown): unknown {
    try {
      return z.object(schema).passthrough().parse(args ?? {});
    } catch (error) {
      if (error instanceof ZodError) {
        throw new Error(this.formatZodError(error));
      }
      throw error;
    }
  }

  private formatZodError(error: ZodError): string {
    const details = error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
        return `${path}${issue.message}`;
      })
      .join('; ');

    return `Invalid tool arguments: ${details}`;
  }
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Waits for `promise`, but at most `ms`; the timer does not outlive the wait. */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms); })]);
  clearTimeout(timer);
}

function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * Stops the pathfinder, the controls and digging; each part on its own, so one failing does not skip the rest. Only for
 * a body nobody else holds (G4); stop-all uses it once the lease is free (E-040).
 */
export function stopBody(bot: mineflayer.Bot): void {
  const parts = [() => stopPathfinder(bot), () => bot.clearControlStates?.(), () => bot.stopDigging?.()];
  for (const stop of parts) {
    try {
      stop();
    } catch {
      // Stopping is best effort; the reply still says the command was stopped.
    }
  }
}

function responseText(response: McpResponse): string {
  return response.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n');
}

function cellText(position: { x: number; y: number; z: number } | undefined): string {
  return position ? `(${Math.floor(position.x)}, ${Math.floor(position.y)}, ${Math.floor(position.z)})` : 'an unknown place';
}
