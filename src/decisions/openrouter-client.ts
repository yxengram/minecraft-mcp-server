// Contract: docs/BLUEPRINT.md F-015. The only place that talks to OpenRouter and the only reader of the API key.
// The key never appears in logs, events, errors or tool output (invariant I4). E-037: typed HTTP errors, the pauses
// that follow them and the statistics of every request sent.
import type { Policy } from '../autopilot/policy.js';

export const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
export const MODELS_URL = 'https://openrouter.ai/api/v1/models?output_modalities=decisions';
/** Answers 401 for a key OpenRouter does not know and 200 for a real one; the catalog answers 200 to any key (E-036 step 0). */
export const KEY_URL = 'https://openrouter.ai/api/v1/key';
export const DEFAULT_TIMEOUT_MS = 1500;
const CATALOG_TIMEOUT_MS = 10000;
// Per request of checkAccess (the key, then the catalog), so a whole check ends within 10 s.
const CHECK_TIMEOUT_MS = 5000;
export const NO_KEY_REASON = 'no OPENROUTER_API_KEY';
const MAX_QUESTIONS = 128;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const ERROR_BODY_CHARS = 300;
// E-037: the pauses after a failure. A refused key waits for a check, which a call starts again 10 minutes after the
// last one; an account without credit lets one request through every 5 minutes; a 429 waits for Retry-After (1 to
// 60 s), or 2 s doubling up to 30 s without it; 3 server or network errors in a row wait 2 s doubling up to 15 s.
const RECHECK_MS = 10 * MINUTE_MS;
const NO_CREDIT_PROBE_MS = 5 * MINUTE_MS;
const RETRY_AFTER_MIN_MS = 1000;
const RETRY_AFTER_MAX_MS = 60_000;
const THROTTLE_FIRST_MS = 2000;
const THROTTLE_MAX_MS = 30_000;
const FAILURES_BEFORE_PAUSE = 3;
const FAILURE_FIRST_MS = 2000;
const FAILURE_MAX_MS = 15_000;
// The cost of a call that reports none is estimated from the median of this many known costs.
const KNOWN_COSTS = 50;

export type DecisionQuestion =
  | { type: 'noul'; instructions: string; criteria: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

export type DecisionAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'score'; score: number; confidence: number; probabilities: Record<string, number> };

/**
 * Why a decision failed. E-037 split M4's http_error by status: auth (401, 403), no_credit (402), throttled (429),
 * bad_request (any other 4xx), server_error (5xx); network when fetch throws. backoff: not sent, because a pause after
 * an earlier failure is on.
 */
export type DecisionErrorKind =
  | 'disabled' | 'rate_limited' | 'timeout' | 'invalid_response'
  | 'auth' | 'no_credit' | 'throttled' | 'bad_request' | 'server_error' | 'network'
  | 'backoff';

export type DecisionResult =
  | { ok: true; answers: Record<string, DecisionAnswer>; model: string; latencyMs: number; cost?: number }
  | { ok: false; error: DecisionErrorKind; message: string; latencyMs: number };

export interface DecisionModelInfo {
  id: string;
  canonicalSlug?: string;
  name?: string;
  contextLength?: number;
  /** USD per input token, as the catalog reports it. */
  promptPrice?: string;
}

export type CatalogResult =
  | { ok: true; models: DecisionModelInfo[] }
  | { ok: false; error: DecisionErrorKind; message: string };

export interface ClientStatus {
  configured: boolean;
  enabled: boolean;
  model: string;
  callsLastMinute: number;
  /** Every request sent in the last hour: instinct, chat and key checks (E-037; before, the chat budget's only). */
  callsLastHour: number;
  /** The instinct's own budget (M8), counted apart from chat triage and combat judgments. */
  instinctCallsLastMinute: number;
}

/** Which per-minute limit a call counts against: decisions.maxCallsPerMinute or instinct.maxCallsPerMinute. */
export type DecisionBudget = 'decisions' | 'instinct';

/**
 * The requests sent since the client was made, which is once per server (E-037): by purpose (the decisions budget is
 * chat triage's since M9; check is the two GETs of checkAccess), the instinct's hedged second requests among its own,
 * the failures, the costs OpenRouter reported, and the successful decisions that reported none. Backoff, rate_limited
 * and disabled results are not sent and not counted; nor is list-decision-models.
 */
export interface SpendStats {
  calls: number;
  instinct: number;
  secondRequests: number;
  chat: number;
  check: number;
  failed: number;
  /** USD, the sum of usage.cost. */
  reportedCost: number;
  withoutCost: number;
  /** USD for the calls without a cost, at the median of the last 50 known costs; null while no cost is known yet. */
  estimatedCost: number | null;
}

/**
 * Whether the decision model can be used (E-036): online after a passed check or a decision that succeeded (`at` is
 * then that time), offline when the key is missing or refused or the model is not in the catalog, unchecked before
 * the first check or when a check could not tell. `reason` is a fixed sentence with at most a status code, never a
 * response body (I4).
 */
export interface DecisionHealth {
  state: 'online' | 'offline' | 'unchecked';
  reason?: string;
  at?: number;
  /**
   * While requests are paused after a 429 or server and network errors (E-037): how much longer, when the health was
   * read. The state is then offline and the reason "paused after HTTP 429"; once the pause is over the health before
   * it shows again.
   */
  pausedMs?: number;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  /** For Retry-After (E-037); a fake fetch may leave it out. */
  headers?: { get(name: string): string | null };
}>;

export interface OpenRouterClientOptions {
  getPolicy: () => Policy;
  /** Defaults to the OPENROUTER_API_KEY environment variable, read on every call. */
  getKey?: () => string | undefined;
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
  /**
   * Called when the health's state or reason changes (a newer `at` alone is no change), when a pause starts (the health
   * then has pausedMs), and on the first success after a reported outage, with that outage as `previous` (E-037).
   * Failures after an outage or a refusal are not reported again.
   */
  onHealthChange?: (health: DecisionHealth, previous: DecisionHealth) => void;
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isProbabilityMap(value: unknown): value is Record<string, number> {
  return Boolean(value) && typeof value === 'object' && Object.values(value as object).every(isProbability);
}

/** The reported confidence, or the largest probability when the server leaves it out. */
function confidenceOf(answer: Record<string, unknown>): number {
  if (isProbability(answer.confidence)) return answer.confidence;
  return Math.max(0, ...Object.values(answer.probabilities as Record<string, number>));
}

/** Resolves when the timer fires, so a request that ignores the abort still ends (F-015: give up at once). */
function timeoutAfter(ms: number, controller: AbortController): { promise: Promise<'timeout'>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => {
      controller.abort();
      resolve('timeout');
    }, ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/** The answer for one question, or null when it is missing or malformed. */
function parseAnswer(question: DecisionQuestion, raw: unknown): DecisionAnswer | null {
  if (!raw || typeof raw !== 'object') return null;
  const answer = raw as Record<string, unknown>;
  if (question.type === 'noul') {
    return isProbability(answer.noul) ? { type: 'noul', noul: answer.noul } : null;
  }
  if (question.type === 'choice') {
    // Own keys only: 'toString' is not one of the options.
    if (typeof answer.choice !== 'string' || !Object.hasOwn(question.criteria, answer.choice) || !isProbabilityMap(answer.probabilities)) return null;
    return { type: 'choice', choice: answer.choice, confidence: confidenceOf(answer), probabilities: answer.probabilities };
  }
  if (typeof answer.score !== 'number' || !Number.isFinite(answer.score) || !isProbabilityMap(answer.probabilities)) return null;
  return { type: 'score', score: answer.score, confidence: confidenceOf(answer), probabilities: answer.probabilities };
}

/** The models of a catalog body, or null when it has no data list; throws when the body is not JSON. */
function parseCatalog(body: string): DecisionModelInfo[] | null {
  const data = (JSON.parse(body) as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  return data
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string')
    .map(entry => ({
      id: entry.id as string,
      canonicalSlug: typeof entry.canonical_slug === 'string' ? entry.canonical_slug : undefined,
      name: typeof entry.name === 'string' ? entry.name : undefined,
      contextLength: typeof entry.context_length === 'number' ? entry.context_length : undefined,
      promptPrice: typeof (entry.pricing as { prompt?: unknown } | undefined)?.prompt === 'string' ? (entry.pricing as { prompt: string }).prompt : undefined
    }));
}

/** The health a refused check request means: a fixed sentence with the status code (E-036), never the body (I4). */
function refusedHealth(status: number, what: string): DecisionHealth {
  if (status === 401 || status === 403) return { state: 'offline', reason: `OpenRouter rejected the API key (HTTP ${status})` };
  if (status === 402) return { state: 'offline', reason: `the OpenRouter account has no credit (HTTP ${status})` };
  return { state: 'unchecked', reason: `OpenRouter could not ${what} (HTTP ${status})` };
}

type CheckReply = { ok: boolean; status: number; body: string } | 'timeout' | 'network';

/** The error kind of a status that is not 2xx (E-037). Anything else below 500 is a bad request. */
function httpErrorKind(status: number): DecisionErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'no_credit';
  if (status === 429) return 'throttled';
  return status >= 500 ? 'server_error' : 'bad_request';
}

/** Retry-After as milliseconds from `now`: a number of seconds or an HTTP date; null when missing or unreadable. */
function retryAfterMs(value: string | null | undefined, now: number): number | null {
  const text = value?.trim();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text) * 1000;
  const date = Date.parse(text);
  return Number.isNaN(date) ? null : date - now;
}

function headerOf(response: { headers?: { get(name: string): string | null } }, name: string): string | null {
  try {
    return response.headers?.get(name) ?? null;
  } catch {
    return null;
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const seconds = (ms: number) => Math.ceil(ms / 1000);

/**
 * Why decide() holds back (E-037). A refusal comes from a 401, 403 or 402 (from a decision or the key check) and keeps
 * the health OFFLINE: auth until a check passes, no_credit with one request every 5 minutes (nextTryAt) until one of
 * them succeeds. A pause after
 * a 429 or repeated server and network errors lasts until `until` and shows as the health meanwhile.
 */
type Refusal = { kind: 'auth'; after: string } | { kind: 'no_credit'; after: string; nextTryAt: number };
interface Pause { since: number; until: number; after: string }

function unreachedHealth(reply: 'timeout' | 'network'): DecisionHealth {
  return { state: 'unchecked', reason: reply === 'timeout' ? `no answer from OpenRouter within ${CHECK_TIMEOUT_MS / 1000} s` : 'could not reach OpenRouter' };
}

export class OpenRouterClient {
  private calls: number[] = [];
  private instinctCalls: number[] = [];
  // Every request sent, for callsLastHour (E-037); the two windows above are the per-minute limits.
  private sent: number[] = [];
  private readonly fetch: FetchLike;
  private readonly now: () => number;
  private healthState: DecisionHealth = { state: 'unchecked' };
  private checking: Promise<DecisionHealth> | null = null;
  // Decisions that succeeded; a check that ends after one of them has older evidence and is not applied.
  private successes = 0;
  private refusal: Refusal | null = null;
  private pause: Pause | null = null;
  private throttledInRow = 0;
  private failedInRow = 0;
  private lastCheckAt: number | null = null;
  // The outage last reported through onHealthChange (an OFFLINE health or the first pause), until a success ends it:
  // failures in a row are reported once, and the recovery says how long it lasted (E-037).
  private outage: DecisionHealth | null = null;
  private stats = { instinct: 0, secondRequests: 0, chat: 0, check: 0, failed: 0, reportedCost: 0, withoutCost: 0 };
  private knownCosts: number[] = [];

  constructor(private readonly options: OpenRouterClientOptions) {
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.now = options.now ?? Date.now;
  }

  private key(): string | undefined {
    const key = (this.options.getKey ?? (() => process.env.OPENROUTER_API_KEY))();
    return key && key.trim() ? key.trim() : undefined;
  }

  /** Removes the key from any text that might leave this module; cut to `limit` characters only afterwards. */
  private scrub(text: string, limit = Infinity): string {
    const key = this.key();
    const clean = key ? text.split(key).join('[redacted]') : text;
    return clean.length > limit ? clean.slice(0, limit) : clean;
  }

  isConfigured(): boolean {
    return this.key() !== undefined;
  }

  /**
   * The current health (E-036). Without a key it is OFFLINE even before the first check, since none is needed. During
   * a pause (E-037) it is OFFLINE with the time left, unless a refused key or credit already makes it OFFLINE.
   */
  health(): DecisionHealth {
    if (!this.isConfigured()) return { state: 'offline', reason: NO_KEY_REASON };
    const left = this.pauseLeft();
    if (this.pause && left > 0 && !this.refusal) return { state: 'offline', reason: `paused after ${this.pause.after}`, at: this.pause.since, pausedMs: left };
    return { ...this.healthState };
  }

  private notify(health: DecisionHealth, previous: DecisionHealth): void {
    try {
      this.options.onHealthChange?.({ ...health }, { ...previous });
    } catch {
      // Showing the change must never break a decision or a check.
    }
  }

  private setHealth(next: DecisionHealth): DecisionHealth {
    const previous = this.healthState;
    this.healthState = next;
    if (next.state === 'online' && this.outage) {
      // Back online after an outage that was reported, even when the health underneath a pause was online all along.
      const outage = this.outage;
      this.outage = null;
      this.notify(next, outage);
    } else if (next.state !== previous.state || next.reason !== previous.reason) {
      this.outage = next.state === 'offline' ? this.outage ?? { ...next, at: next.at ?? this.now() } : null;
      this.notify(next, previous);
    }
    return { ...next };
  }

  private pauseLeft(): number {
    return this.pause ? Math.max(0, this.pause.until - this.now()) : 0;
  }

  status(): ClientStatus {
    const now = this.now();
    this.calls = this.calls.filter(time => now - time < HOUR_MS);
    this.instinctCalls = this.instinctCalls.filter(time => now - time < MINUTE_MS);
    this.sent = this.sent.filter(time => now - time < HOUR_MS);
    const decisions = this.options.getPolicy().decisions;
    return {
      configured: this.isConfigured(),
      enabled: decisions.enabled,
      model: decisions.model,
      callsLastMinute: this.calls.filter(time => now - time < MINUTE_MS).length,
      callsLastHour: this.sent.length,
      instinctCallsLastMinute: this.instinctCalls.length
    };
  }

  /** The requests sent since the server started and what they cost (E-037). */
  spend(): SpendStats {
    const { instinct, secondRequests, chat, check, failed, reportedCost, withoutCost } = this.stats;
    const estimatedCost = withoutCost === 0 ? 0 : this.knownCosts.length === 0 ? null : withoutCost * median(this.knownCosts);
    return { calls: instinct + chat + check, instinct, secondRequests, chat, check, failed, reportedCost, withoutCost, estimatedCost };
  }

  private countSent(purpose: 'instinct' | 'chat' | 'check', second = false): void {
    this.stats[purpose]++;
    if (second) this.stats.secondRequests++;
    this.sent.push(this.now());
  }

  private noteCost(cost: unknown): boolean {
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return false;
    this.stats.reportedCost += cost;
    this.knownCosts = [...this.knownCosts, cost].slice(-KNOWN_COSTS);
    return true;
  }

  /**
   * Why decide() must not call OpenRouter now, or null (E-037). With a refused key, the first call 10 minutes after
   * the last check starts another one in the background, so nothing is sent while neither the instinct nor chat asks.
   */
  private holdBack(now: number): string | null {
    const refusal = this.refusal;
    if (refusal?.kind === 'auth') {
      if (this.lastCheckAt === null || now - this.lastCheckAt >= RECHECK_MS) void this.checkAccess();
      return `not calling OpenRouter until the API key passes a check (${refusal.after})`;
    }
    if (refusal?.kind === 'no_credit' && now < refusal.nextTryAt) return `not calling OpenRouter for ${seconds(refusal.nextTryAt - now)}s more (${refusal.after})`;
    const left = this.pauseLeft();
    if (this.pause && left > 0) return `not calling OpenRouter for ${seconds(left)}s more (${this.pause.after})`;
    return null;
  }

  /** A sent request failed: count it, and pause or refuse as its kind says (E-037). */
  private noteFailure(kind: DecisionErrorKind, status?: number, retryAfter: number | null = null): void {
    this.stats.failed++;
    const now = this.now();
    // Only a success clears the doubling after 429s (2(e)); the 3-in-a-row rule for server and network errors is broken
    // by any other result.
    if (kind === 'throttled') this.throttledInRow++;
    this.failedInRow = kind === 'server_error' || kind === 'network' ? this.failedInRow + 1 : 0;
    if ((kind === 'auth' || kind === 'no_credit') && status !== undefined) {
      this.refuse(status, now);
    } else if (kind === 'throttled') {
      const ms = retryAfter === null
        ? Math.min(THROTTLE_MAX_MS, THROTTLE_FIRST_MS * 2 ** (this.throttledInRow - 1))
        : Math.min(RETRY_AFTER_MAX_MS, Math.max(RETRY_AFTER_MIN_MS, retryAfter));
      this.startPause(ms, `HTTP ${status}`, now);
    } else if ((kind === 'server_error' || kind === 'network') && this.failedInRow >= FAILURES_BEFORE_PAUSE) {
      const ms = Math.min(FAILURE_MAX_MS, FAILURE_FIRST_MS * 2 ** (this.failedInRow - FAILURES_BEFORE_PAUSE));
      this.startPause(ms, kind === 'network' ? 'network errors' : `HTTP ${status}`, now);
    }
  }

  /** A 401, 403 or 402: the health goes OFFLINE with E-036's sentence, and decide() holds back (E-037). */
  private refuse(status: number, now: number): void {
    const after = `HTTP ${status}`;
    this.refusal = status === 402 ? { kind: 'no_credit', after, nextTryAt: now + NO_CREDIT_PROBE_MS } : { kind: 'auth', after };
    this.setHealth({ ...refusedHealth(status, 'check the key'), at: now });
  }

  private startPause(ms: number, after: string, now: number): void {
    this.pause = { since: this.pause && this.pauseLeft() > 0 ? this.pause.since : now, until: Math.max(now + ms, this.pause?.until ?? 0), after };
    // Only the first failure of an outage is reported; the next pauses of the same run are not.
    if (this.outage || this.refusal) return;
    const health: DecisionHealth = { state: 'offline', reason: `paused after ${after}`, at: now, pausedMs: this.pause.until - now };
    this.outage = health;
    this.notify(health, this.healthState);
  }

  /** Any success ends every pause and refusal (E-037). */
  private clearPauses(): void {
    this.refusal = null;
    this.pause = null;
    this.throttledInRow = 0;
    this.failedInRow = 0;
  }

  /**
   * One decision request. Never retries; every failure is a typed result, never a thrown error or a made-up answer.
   * The instinct has its own budget, so a chatty player cannot use up the calls the instinct needs (BLUEPRINT I4).
   * E-037: while a pause or a refusal is on it sends nothing and returns backoff at once; `second` marks the
   * instinct's hedged second request in the statistics.
   */
  async decide(
    state: Record<string, unknown>,
    questions: Record<string, DecisionQuestion>,
    { model, budget = 'decisions', second = false }: { model?: string; budget?: DecisionBudget; second?: boolean } = {}
  ): Promise<DecisionResult> {
    const started = this.now();
    const fail = (error: DecisionErrorKind, message: string): DecisionResult => ({ ok: false, error, message: this.scrub(message), latencyMs: this.now() - started });
    // A request that went out and failed: counted, and it may start a pause (E-037).
    const failSent = (error: DecisionErrorKind, message: string, status?: number, retryAfter: number | null = null): DecisionResult => {
      this.noteFailure(error, status, retryAfter);
      return fail(error, message);
    };
    const policy = this.options.getPolicy().decisions;
    const key = this.key();
    if (!key) return fail('disabled', 'no OpenRouter API key is configured (OPENROUTER_API_KEY)');
    if (!policy.enabled) return fail('disabled', 'decisions are turned off in the policy');
    const names = Object.keys(questions);
    if (names.length === 0 || names.length > MAX_QUESTIONS) return fail('invalid_response', `a request needs 1 to ${MAX_QUESTIONS} questions`);
    // Before the per-minute limits, so a call that is held back uses none of them.
    const held = this.holdBack(started);
    if (held) return fail('backoff', held);

    const status = this.status();
    if (budget === 'instinct') {
      const limit = this.options.getPolicy().instinct.maxCallsPerMinute;
      if (status.instinctCallsLastMinute >= limit) return fail('rate_limited', `rate limit reached (${limit} instinct decisions per minute)`);
      this.instinctCalls.push(started);
    } else {
      if (status.callsLastMinute >= policy.maxCallsPerMinute) {
        return fail('rate_limited', `rate limit reached (${policy.maxCallsPerMinute} decisions per minute)`);
      }
      this.calls.push(started);
    }
    // Without credit only one request goes out per 5 minutes: the next one is due from now, whatever this one gets.
    if (this.refusal?.kind === 'no_credit') this.refusal.nextTryAt = started + NO_CREDIT_PROBE_MS;
    this.countSent(budget === 'instinct' ? 'instinct' : 'chat', second);

    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const deadline = timeoutAfter(timeoutMs, controller);
    let reply: { status: number; ok: boolean; body: string; retryAfter: string | null } | 'timeout';
    try {
      const request = (async () => {
        const response = await this.fetch(DECISIONS_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: model ?? policy.model, state, questions }),
          signal: controller.signal
        });
        return { status: response.status, ok: response.ok, body: await response.text(), retryAfter: headerOf(response, 'retry-after') };
      })();
      request.catch(() => {});
      reply = await Promise.race([request, deadline.promise]);
    } catch (error) {
      if (controller.signal.aborted) return failSent('timeout', `no answer within ${timeoutMs} ms`);
      return failSent('network', `request failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      deadline.cancel();
    }
    if (reply === 'timeout') return failSent('timeout', `no answer within ${timeoutMs} ms`);

    if (!reply.ok) {
      return failSent(httpErrorKind(reply.status), `HTTP ${reply.status}: ${this.scrub(reply.body, ERROR_BODY_CHARS)}`, reply.status, retryAfterMs(reply.retryAfter, this.now()));
    }
    let parsed: { answers?: Record<string, unknown>; model?: unknown; usage?: { cost?: unknown } };
    try {
      parsed = JSON.parse(reply.body);
    } catch {
      return failSent('invalid_response', 'the response is not JSON');
    }
    if (!parsed || typeof parsed !== 'object') return failSent('invalid_response', 'the response is not a JSON object');
    // What OpenRouter says it charged counts even when the answers turn out unusable.
    const costed = this.noteCost(parsed.usage?.cost);
    const answers: Record<string, DecisionAnswer> = {};
    for (const name of names) {
      const answer = parseAnswer(questions[name], parsed.answers?.[name]);
      if (!answer) return failSent('invalid_response', `no valid answer for question '${name}'`);
      answers[name] = answer;
    }
    if (!costed) this.stats.withoutCost++;
    // An answer is proof that the key and the model work (E-036), and it ends every pause (E-037).
    this.successes++;
    this.clearPauses();
    this.setHealth({ state: 'online', at: this.now() });
    return {
      ok: true,
      answers,
      model: typeof parsed.model === 'string' ? parsed.model : model ?? policy.model,
      latencyMs: this.now() - started,
      cost: typeof parsed.usage?.cost === 'number' ? parsed.usage.cost : undefined
    };
  }

  /**
   * Checks that the decision model can be used and stores the result as the health (E-036): first the key, with
   * GET /api/v1/key, which describes the key instead of asking a model (the catalog answers 200 to any key, so it
   * cannot tell), then that decisions.model is in the catalog, by id or canonical_slug. No decision request is sent.
   * Replaces M9's warmUp and, like it, opens the connection (DNS, TLS) before the first decision: a process's first
   * request costs about 0.35 s more, which a lit creeper's 1.5 s fuse cannot spare. Without a key the health becomes
   * OFFLINE at once, with no request; with decisions turned off in the policy nothing is sent and the health stays as
   * it is. The check is not a decision, so no per-minute limit counts it. Never throws; a check that is still under way
   * is shared. E-037: it is sent while the key or the credit is refused (otherwise it could never pass), but it waits
   * for a pause after a 429 or server and network errors to end.
   */
  checkAccess(): Promise<DecisionHealth> {
    if (!this.isConfigured()) return Promise.resolve(this.setHealth({ state: 'offline', reason: NO_KEY_REASON, at: this.now() }));
    if (!this.options.getPolicy().decisions.enabled) return Promise.resolve(this.health());
    this.checking ??= this.runCheck().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private async runCheck(): Promise<DecisionHealth> {
    const successes = this.successes;
    this.lastCheckAt = this.now();
    // A decision that succeeded while the check ran is newer evidence than the check's own result. E-037: the check's
    // verdict on the key settles a refusal too. A 401 or 403 is the auth state and a 402 the no_credit state, as from
    // a decision; a check that passes ends every pause and the auth state, but not no_credit: /key accepts a key
    // whatever its credit (PLAN step 14), so only a decision that succeeds shows that there is credit again, and the
    // health stays OFFLINE until then; a model missing from the catalog is no refusal of the key; and a check that
    // could not tell leaves a refusal, and its OFFLINE health, as they are.
    const apply = (health: DecisionHealth, status?: number): DecisionHealth => {
      if (this.successes !== successes) return this.health();
      if (status === 401 || status === 403 || status === 402) {
        this.refuse(status, this.now());
        return this.health();
      }
      if (health.state === 'unchecked' && this.refusal) return this.health();
      if (health.state === 'online') {
        const credit = this.refusal?.kind === 'no_credit' ? this.refusal : null;
        this.clearPauses();
        if (credit) {
          this.refusal = credit;
          return this.health();
        }
      } else if (health.state === 'offline') this.refusal = null;
      return this.setHealth({ state: health.state, reason: health.reason === undefined ? undefined : this.scrub(health.reason), at: this.now() });
    };
    try {
      const key = this.key();
      if (!key) return this.setHealth({ state: 'offline', reason: NO_KEY_REASON, at: this.now() });
      // Only when a pause is on: otherwise the request goes out at once, before checkAccess returns.
      if (this.pauseLeft() > 0) await this.pauseOver();
      // Only the status counts. The body describes the key's account (label, limits, usage): it is never parsed or kept.
      const access = await this.checkRequest(KEY_URL, key, false);
      if (typeof access === 'string') return apply(unreachedHealth(access));
      if (!access.ok) return apply(refusedHealth(access.status, 'check the key'), access.status);
      if (this.pauseLeft() > 0) await this.pauseOver();
      const catalog = await this.checkRequest(MODELS_URL, key, true);
      if (typeof catalog === 'string') return apply(unreachedHealth(catalog));
      if (!catalog.ok) return apply(refusedHealth(catalog.status, 'list the decision models'), catalog.status);
      let models: DecisionModelInfo[] | null;
      try {
        models = parseCatalog(catalog.body);
      } catch {
        models = null;
      }
      if (!models) return apply({ state: 'unchecked', reason: 'the decision model catalog could not be read' });
      const model = this.options.getPolicy().decisions.model;
      if (!models.some(entry => entry.id === model || entry.canonicalSlug === model)) {
        return apply({ state: 'offline', reason: `model ${model} is not in the decision model catalog` });
      }
      return apply({ state: 'online' });
    } catch {
      return apply({ state: 'unchecked', reason: 'the check failed' });
    }
  }

  /** Resolves once no pause is on; a check waits for one (E-037), though not for a refusal. */
  private async pauseOver(): Promise<void> {
    for (let left = this.pauseLeft(); left > 0; left = this.pauseLeft()) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, left);
        (timer as { unref?: () => void }).unref?.();
      });
    }
  }

  /**
   * One GET of the check. Raced against its timer like decide(), so a request that ignores the abort still ends.
   * Counted as a check request, and as failed unless it gets a 2xx (E-037); it starts no pause.
   */
  private async checkRequest(url: string, key: string, keepBody: boolean): Promise<CheckReply> {
    const controller = new AbortController();
    const deadline = timeoutAfter(CHECK_TIMEOUT_MS, controller);
    this.countSent('check');
    let reply: CheckReply;
    try {
      const request = (async () => {
        const response = await this.fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${key}` }, signal: controller.signal });
        // Read to the end either way, so the connection can be reused by the first decision.
        const body = await response.text();
        return { ok: response.ok, status: response.status, body: keepBody ? body : '' };
      })();
      request.catch(() => {});
      reply = await Promise.race([request, deadline.promise]);
    } catch {
      reply = controller.signal.aborted ? 'timeout' : 'network';
    } finally {
      deadline.cancel();
    }
    if (typeof reply === 'string' || !reply.ok) this.stats.failed++;
    return reply;
  }

  /**
   * The live catalog of decision models. Without a key it is not queried (F-018: say that no key is configured). Errors
   * are classified as for decisions (E-037), but the catalog is not held back by a pause, starts none and is not
   * counted in the statistics.
   */
  async listModels(): Promise<CatalogResult> {
    const key = this.key();
    if (!key) return { ok: false, error: 'disabled', message: 'no OpenRouter API key is configured (OPENROUTER_API_KEY)' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
    let reply: { ok: boolean; status: number; body: string };
    try {
      const response = await this.fetch(MODELS_URL, { method: 'GET', headers: { Authorization: `Bearer ${key}` }, signal: controller.signal });
      reply = { ok: response.ok, status: response.status, body: await response.text() };
    } catch (error) {
      if (controller.signal.aborted) return { ok: false, error: 'timeout', message: `no catalog within ${CATALOG_TIMEOUT_MS / 1000} s` };
      return { ok: false, error: 'network', message: this.scrub(`could not read the catalog: ${error instanceof Error ? error.message : String(error)}`) };
    } finally {
      clearTimeout(timer);
    }
    if (!reply.ok) return { ok: false, error: httpErrorKind(reply.status), message: `HTTP ${reply.status}: ${this.scrub(reply.body, ERROR_BODY_CHARS)}` };
    let models: DecisionModelInfo[] | null;
    try {
      models = parseCatalog(reply.body);
    } catch (error) {
      return { ok: false, error: 'invalid_response', message: this.scrub(`could not read the catalog: ${error instanceof Error ? error.message : String(error)}`) };
    }
    if (!models) return { ok: false, error: 'invalid_response', message: 'the catalog has no data list' };
    return { ok: true, models };
  }
}
