// Contract: docs/BLUEPRINT.md F-015. The only place that talks to OpenRouter and the only reader of the API key.
// The key never appears in logs, events, errors or tool output (invariant I4).
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

export type DecisionQuestion =
  | { type: 'noul'; instructions: string; criteria: { true: string; false: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

export type DecisionAnswer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'score'; score: number; confidence: number; probabilities: Record<string, number> };

export type DecisionErrorKind = 'disabled' | 'rate_limited' | 'timeout' | 'http_error' | 'invalid_response';

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
  callsLastHour: number;
  /** The instinct's own budget (M8), counted apart from chat triage and combat judgments. */
  instinctCallsLastMinute: number;
}

/** Which per-minute limit a call counts against: decisions.maxCallsPerMinute or instinct.maxCallsPerMinute. */
export type DecisionBudget = 'decisions' | 'instinct';

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
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface OpenRouterClientOptions {
  getPolicy: () => Policy;
  /** Defaults to the OPENROUTER_API_KEY environment variable, read on every call. */
  getKey?: () => string | undefined;
  fetch?: FetchLike;
  now?: () => number;
  timeoutMs?: number;
  /** Called when the health's state or reason changes; a newer `at` alone is no change. */
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

function unreachedHealth(reply: 'timeout' | 'network'): DecisionHealth {
  return { state: 'unchecked', reason: reply === 'timeout' ? `no answer from OpenRouter within ${CHECK_TIMEOUT_MS / 1000} s` : 'could not reach OpenRouter' };
}

export class OpenRouterClient {
  private calls: number[] = [];
  private instinctCalls: number[] = [];
  private readonly fetch: FetchLike;
  private readonly now: () => number;
  private healthState: DecisionHealth = { state: 'unchecked' };
  private checking: Promise<DecisionHealth> | null = null;
  // Decisions that succeeded; a check that ends after one of them has older evidence and is not applied.
  private successes = 0;

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

  /** The current health (E-036). Without a key it is OFFLINE even before the first check, since none is needed. */
  health(): DecisionHealth {
    if (!this.isConfigured()) return { state: 'offline', reason: NO_KEY_REASON };
    return { ...this.healthState };
  }

  private setHealth(next: DecisionHealth): DecisionHealth {
    const previous = this.healthState;
    this.healthState = next;
    if (next.state !== previous.state || next.reason !== previous.reason) {
      try {
        this.options.onHealthChange?.({ ...next }, previous);
      } catch {
        // Showing the change must never break a decision or a check.
      }
    }
    return { ...next };
  }

  status(): ClientStatus {
    const now = this.now();
    this.calls = this.calls.filter(time => now - time < HOUR_MS);
    this.instinctCalls = this.instinctCalls.filter(time => now - time < MINUTE_MS);
    const decisions = this.options.getPolicy().decisions;
    return {
      configured: this.isConfigured(),
      enabled: decisions.enabled,
      model: decisions.model,
      callsLastMinute: this.calls.filter(time => now - time < MINUTE_MS).length,
      callsLastHour: this.calls.length,
      instinctCallsLastMinute: this.instinctCalls.length
    };
  }

  /**
   * One decision request. Never retries; every failure is a typed result, never a thrown error or a made-up answer.
   * The instinct has its own budget, so a chatty player cannot use up the calls the instinct needs (BLUEPRINT I4).
   */
  async decide(
    state: Record<string, unknown>,
    questions: Record<string, DecisionQuestion>,
    { model, budget = 'decisions' }: { model?: string; budget?: DecisionBudget } = {}
  ): Promise<DecisionResult> {
    const started = this.now();
    const fail = (error: DecisionErrorKind, message: string): DecisionResult => ({ ok: false, error, message: this.scrub(message), latencyMs: this.now() - started });
    const policy = this.options.getPolicy().decisions;
    const key = this.key();
    if (!key) return fail('disabled', 'no OpenRouter API key is configured (OPENROUTER_API_KEY)');
    if (!policy.enabled) return fail('disabled', 'decisions are turned off in the policy');
    const names = Object.keys(questions);
    if (names.length === 0 || names.length > MAX_QUESTIONS) return fail('invalid_response', `a request needs 1 to ${MAX_QUESTIONS} questions`);

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

    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const deadline = timeoutAfter(timeoutMs, controller);
    let reply: { status: number; ok: boolean; body: string } | 'timeout';
    try {
      const request = (async () => {
        const response = await this.fetch(DECISIONS_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: model ?? policy.model, state, questions }),
          signal: controller.signal
        });
        return { status: response.status, ok: response.ok, body: await response.text() };
      })();
      request.catch(() => {});
      reply = await Promise.race([request, deadline.promise]);
    } catch (error) {
      if (controller.signal.aborted) return fail('timeout', `no answer within ${timeoutMs} ms`);
      return fail('http_error', `request failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      deadline.cancel();
    }
    if (reply === 'timeout') return fail('timeout', `no answer within ${timeoutMs} ms`);

    if (!reply.ok) return { ok: false, error: 'http_error', message: `HTTP ${reply.status}: ${this.scrub(reply.body, ERROR_BODY_CHARS)}`, latencyMs: this.now() - started };
    let parsed: { answers?: Record<string, unknown>; model?: unknown; usage?: { cost?: unknown } };
    try {
      parsed = JSON.parse(reply.body);
    } catch {
      return fail('invalid_response', 'the response is not JSON');
    }
    if (!parsed || typeof parsed !== 'object') return fail('invalid_response', 'the response is not a JSON object');
    const answers: Record<string, DecisionAnswer> = {};
    for (const name of names) {
      const answer = parseAnswer(questions[name], parsed.answers?.[name]);
      if (!answer) return fail('invalid_response', `no valid answer for question '${name}'`);
      answers[name] = answer;
    }
    // An answer is proof that the key and the model work (E-036); failures leave the health alone until E-037.
    this.successes++;
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
   * is shared.
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
    // A decision that succeeded while the check ran is newer evidence than the check's own result.
    const apply = (health: DecisionHealth): DecisionHealth => this.successes !== successes
      ? this.health()
      : this.setHealth({ state: health.state, reason: health.reason === undefined ? undefined : this.scrub(health.reason), at: this.now() });
    try {
      const key = this.key();
      if (!key) return this.setHealth({ state: 'offline', reason: NO_KEY_REASON, at: this.now() });
      // Only the status counts. The body describes the key's account (label, limits, usage): it is never parsed or kept.
      const access = await this.checkRequest(KEY_URL, key, false);
      if (typeof access === 'string') return apply(unreachedHealth(access));
      if (!access.ok) return apply(refusedHealth(access.status, 'check the key'));
      const catalog = await this.checkRequest(MODELS_URL, key, true);
      if (typeof catalog === 'string') return apply(unreachedHealth(catalog));
      if (!catalog.ok) return apply(refusedHealth(catalog.status, 'list the decision models'));
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

  /** One GET of the check. Raced against its timer like decide(), so a request that ignores the abort still ends. */
  private async checkRequest(url: string, key: string, keepBody: boolean): Promise<CheckReply> {
    const controller = new AbortController();
    const deadline = timeoutAfter(CHECK_TIMEOUT_MS, controller);
    try {
      const request = (async () => {
        const response = await this.fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${key}` }, signal: controller.signal });
        // Read to the end either way, so the connection can be reused by the first decision.
        const body = await response.text();
        return { ok: response.ok, status: response.status, body: keepBody ? body : '' };
      })();
      request.catch(() => {});
      return await Promise.race([request, deadline.promise]);
    } catch {
      return controller.signal.aborted ? 'timeout' : 'network';
    } finally {
      deadline.cancel();
    }
  }

  /** The live catalog of decision models. Without a key it is not queried (F-018: say that no key is configured). */
  async listModels(): Promise<CatalogResult> {
    const key = this.key();
    if (!key) return { ok: false, error: 'disabled', message: 'no OpenRouter API key is configured (OPENROUTER_API_KEY)' };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
    try {
      const response = await this.fetch(MODELS_URL, { method: 'GET', headers: { Authorization: `Bearer ${key}` }, signal: controller.signal });
      const body = await response.text();
      if (!response.ok) return { ok: false, error: 'http_error', message: `HTTP ${response.status}: ${this.scrub(body, ERROR_BODY_CHARS)}` };
      const models = parseCatalog(body);
      if (!models) return { ok: false, error: 'invalid_response', message: 'the catalog has no data list' };
      return { ok: true, models };
    } catch (error) {
      if (controller.signal.aborted) return { ok: false, error: 'timeout', message: `no catalog within ${CATALOG_TIMEOUT_MS / 1000} s` };
      return { ok: false, error: 'invalid_response', message: this.scrub(`could not read the catalog: ${error instanceof Error ? error.message : String(error)}`) };
    } finally {
      clearTimeout(timer);
    }
  }
}
