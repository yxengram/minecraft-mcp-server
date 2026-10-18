// Contract: docs/BLUEPRINT.md F-015. The only place that talks to OpenRouter and the only reader of the API key.
// The key never appears in logs, events, errors or tool output (invariant I4).
import type { Policy } from '../autopilot/policy.js';

export const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
export const MODELS_URL = 'https://openrouter.ai/api/v1/models?output_modalities=decisions';
export const DEFAULT_TIMEOUT_MS = 1500;
const CATALOG_TIMEOUT_MS = 10000;
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

export class OpenRouterClient {
  private calls: number[] = [];
  private instinctCalls: number[] = [];
  private readonly fetch: FetchLike;
  private readonly now: () => number;

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
    return {
      ok: true,
      answers,
      model: typeof parsed.model === 'string' ? parsed.model : model ?? policy.model,
      latencyMs: this.now() - started,
      cost: typeof parsed.usage?.cost === 'number' ? parsed.usage.cost : undefined
    };
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
      const data = (JSON.parse(body) as { data?: unknown } | null)?.data;
      if (!Array.isArray(data)) return { ok: false, error: 'invalid_response', message: 'the catalog has no data list' };
      const models = data
        .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string')
        .map(entry => ({
          id: entry.id as string,
          canonicalSlug: typeof entry.canonical_slug === 'string' ? entry.canonical_slug : undefined,
          name: typeof entry.name === 'string' ? entry.name : undefined,
          contextLength: typeof entry.context_length === 'number' ? entry.context_length : undefined,
          promptPrice: typeof (entry.pricing as { prompt?: unknown } | undefined)?.prompt === 'string' ? (entry.pricing as { prompt: string }).prompt : undefined
        }));
      return { ok: true, models };
    } catch (error) {
      if (controller.signal.aborted) return { ok: false, error: 'timeout', message: `no catalog within ${CATALOG_TIMEOUT_MS / 1000} s` };
      return { ok: false, error: 'invalid_response', message: this.scrub(`could not read the catalog: ${error instanceof Error ? error.message : String(error)}`) };
    } finally {
      clearTimeout(timer);
    }
  }
}
