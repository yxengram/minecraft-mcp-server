// Contract: docs/BLUEPRINT.md F-014 (reflexes and combat since M3; chat and decisions since M4).
// The policy lives in memory only and goes back to its defaults whenever the bot (re)joins the game.
import { z } from 'zod';

export type PolicySource = 'llm' | 'startup';
const SOURCES: readonly string[] = ['llm', 'startup'];

const vital = () => z.number().min(0).max(20);
const distance = () => z.number().min(1).max(32);
const probability = () => z.number().min(0).max(1);
// Minecraft usernames: 3-16 letters, digits or underscores. Compared case-sensitively.
const username = z.string().regex(/^[A-Za-z0-9_]{3,16}$/, 'not a valid Minecraft username');

/**
 * The decision model used when nothing else is configured: a dated id from the live catalog, never an alias, chosen
 * by probing real chat samples (PLAN M4, 2026-10-17). --decision-model overrides it at startup.
 */
export const DEFAULT_DECISION_MODEL = 'perplexity/pplx-decider-v1.2-20261016';

const reflexesSchema = z.object({
  creeperEvade: z.object({ enabled: z.boolean() }).strict(),
  hazardEscape: z.object({ enabled: z.boolean(), lowAir: vital() }).strict(),
  lowHealthRetreat: z.object({ enabled: z.boolean(), health: vital(), radius: distance() }).strict(),
  selfDefense: z.object({ enabled: z.boolean(), stance: z.enum(['fight', 'flee', 'auto']) }).strict(),
  autoEat: z.object({ enabled: z.boolean(), food: vital() }).strict()
}).strict();

const combatSchema = z.object({
  attackPlayers: z.boolean(),
  avoidNeutral: z.boolean(),
  retreatHealth: vital()
}).strict();

const chatSchema = z.object({
  /** Ask the decision model whether a message is meant for the bot, and report only those (chat_request). */
  triage: z.boolean(),
  /** Players whose clear commands run without the LLM. Empty by default; only the LLM can change it (I2). */
  commandsFrom: z.array(username).max(32),
  /** Confirm executed chat commands in chat. */
  replyInChat: z.boolean()
}).strict();

const decisionsSchema = z.object({
  enabled: z.boolean(),
  model: z.string().trim().min(1).max(200),
  /** A chat command runs only at or above this probability (and only when it is addressed to the bot). */
  actThreshold: probability(),
  /** Messages at or above this probability of being meant for the bot are reported. */
  cautiousThreshold: probability(),
  maxCallsPerMinute: z.number().int().min(1).max(600)
}).strict();

export const policySchema = z.object({ reflexes: reflexesSchema, combat: combatSchema, chat: chatSchema, decisions: decisionsSchema }).strict();
export type Policy = z.infer<typeof policySchema>;
export type Stance = Policy['reflexes']['selfDefense']['stance'];

// Every field optional at every level, but unknown fields are still rejected.
export const reflexesUpdateSchema = z.object({
  creeperEvade: reflexesSchema.shape.creeperEvade.partial().strict().optional(),
  hazardEscape: reflexesSchema.shape.hazardEscape.partial().strict().optional(),
  lowHealthRetreat: reflexesSchema.shape.lowHealthRetreat.partial().strict().optional(),
  selfDefense: reflexesSchema.shape.selfDefense.partial().strict().optional(),
  autoEat: reflexesSchema.shape.autoEat.partial().strict().optional()
}).strict();
export const combatUpdateSchema = combatSchema.partial().strict();
export const chatUpdateSchema = chatSchema.partial().strict();
export const decisionsUpdateSchema = decisionsSchema.partial().strict();
export const policyUpdateSchema = z.object({
  reflexes: reflexesUpdateSchema.optional(),
  combat: combatUpdateSchema.optional(),
  chat: chatUpdateSchema.optional(),
  decisions: decisionsUpdateSchema.optional()
}).strict();
export type PolicyUpdate = z.infer<typeof policyUpdateSchema>;

// Tentative defaults (BLUEPRINT F-013, F-014); the scenario tests tune them. 'auto' uses rules until M5 adds the
// decision model.
export const DEFAULT_POLICY: Policy = {
  reflexes: {
    creeperEvade: { enabled: true },
    hazardEscape: { enabled: true, lowAir: 6 },
    lowHealthRetreat: { enabled: true, health: 6, radius: 16 },
    selfDefense: { enabled: true, stance: 'auto' },
    autoEat: { enabled: true, food: 14 }
  },
  combat: { attackPlayers: false, avoidNeutral: true, retreatHealth: 6 },
  chat: { triage: true, commandsFrom: [], replyInChat: true },
  // Thresholds are tentative until M5 probes them with real messages.
  decisions: { enabled: true, model: DEFAULT_DECISION_MODEL, actThreshold: 0.85, cautiousThreshold: 0.5, maxCallsPerMinute: 30 }
};

/** Settings given at startup (command line); they survive every reset. */
export interface StartupPolicy {
  decisionModel?: string;
}

export type UpdateResult =
  | { ok: true; policy: Policy; changed: string[]; warnings: string[] }
  | { ok: false; errors: string[] };

function clone(policy: Policy): Policy {
  return JSON.parse(JSON.stringify(policy)) as Policy;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** Paths of the leaf values that differ, e.g. "reflexes.autoEat.enabled". */
function changedPaths(before: unknown, after: unknown, prefix = ''): string[] {
  if (Array.isArray(before) || Array.isArray(after)) {
    return JSON.stringify(before) === JSON.stringify(after) ? [] : [prefix];
  }
  if (before && after && typeof before === 'object' && typeof after === 'object') {
    return Object.keys(after).flatMap(key =>
      changedPaths((before as Record<string, unknown>)[key], (after as Record<string, unknown>)[key], prefix ? `${prefix}.${key}` : key));
  }
  return before === after ? [] : [prefix];
}

/** Drops fields given as undefined, so `{ attackPlayers: undefined }` cannot write an invalid value. */
function withoutUndefined(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined).map(([key, child]) => [key, withoutUndefined(child)]));
}

/** How many leaf values an update sets; `{ reflexes: {} }` sets none. */
function leafCount(value: unknown): number {
  if (Array.isArray(value)) return 1;
  if (value && typeof value === 'object') return Object.values(value).reduce((sum: number, child) => sum + leafCount(child), 0);
  return value === undefined ? 0 : 1;
}

export class PolicyStore {
  private readonly baseline: Policy;
  private current: Policy;

  constructor(startup: StartupPolicy = {}) {
    const baseline = clone(DEFAULT_POLICY);
    if (startup.decisionModel) baseline.decisions.model = startup.decisionModel;
    this.baseline = deepFreeze(baseline);
    this.current = this.baseline;
  }

  /** The current policy. It is frozen: every update replaces it, so readers always see one consistent version. */
  get(): Policy {
    return this.current;
  }

  /**
   * Merge a partial update. Only the LLM (set-policy) and startup configuration may change the policy: nothing that
   * comes from chat can (invariant I2). On any validation error nothing changes.
   */
  update(raw: unknown, source: PolicySource): UpdateResult {
    if (!SOURCES.includes(source)) {
      return { ok: false, errors: [`policy changes from '${String(source)}' are not allowed; only the LLM can change the policy`] };
    }
    const parsed = policyUpdateSchema.safeParse(withoutUndefined(raw ?? {}));
    if (!parsed.success) {
      return { ok: false, errors: parsed.error.issues.map(issue => `${issue.path.join('.') || 'policy'}: ${issue.message}`) };
    }
    // Who may command the bot through chat is the LLM's call alone, never a startup setting (F-014, I2).
    if (source !== 'llm' && parsed.data.chat?.commandsFrom !== undefined) {
      return { ok: false, errors: ['chat.commandsFrom can only be set by the LLM (set-policy)'] };
    }

    const next = clone(this.current);
    for (const [group, fields] of Object.entries(parsed.data) as [keyof Policy, Record<string, unknown> | undefined][]) {
      if (!fields) continue;
      if (group !== 'reflexes') {
        Object.assign(next[group], fields);
      } else {
        for (const [reflex, settings] of Object.entries(fields)) {
          if (settings) Object.assign(next.reflexes[reflex as keyof Policy['reflexes']], settings);
        }
      }
    }

    if (leafCount(parsed.data) === 0) {
      return { ok: false, errors: ['no policy fields given; groups are reflexes and combat (see get-policy)'] };
    }

    if (next.decisions.cautiousThreshold > next.decisions.actThreshold) {
      return { ok: false, errors: ['decisions.cautiousThreshold must not be above decisions.actThreshold'] };
    }

    const changed = changedPaths(this.current, next);
    const warnings: string[] = [];
    if (changed.includes('chat.commandsFrom')) {
      const added = next.chat.commandsFrom.filter(name => !this.current.chat.commandsFrom.includes(name));
      const removed = this.current.chat.commandsFrom.filter(name => !next.chat.commandsFrom.includes(name));
      const list = next.chat.commandsFrom.length > 0 ? next.chat.commandsFrom.join(', ') : 'nobody';
      warnings.push(`notice: chat commands are now accepted from ${list}${added.length ? ` (added ${added.join(', ')})` : ''}${removed.length ? ` (removed ${removed.join(', ')})` : ''}`);
    }
    // Every request to attack players is reported, even when it was already on (F-014, AP-6).
    if (parsed.data.combat?.attackPlayers === true) {
      warnings.push(`warning: attackPlayers enabled by ${source === 'llm' ? 'set-policy' : source}; the bot may now attack players`);
    }
    if (!next.combat.avoidNeutral && this.current.combat.avoidNeutral) {
      warnings.push('warning: avoidNeutral disabled; guard may now attack neutral mobs such as endermen and zombified piglins');
    }
    if (changed.length > 0) this.current = deepFreeze(next);
    return { ok: true, policy: this.current, changed, warnings };
  }

  /** Back to the defaults plus the startup settings; nobody may send chat commands afterwards. */
  reset(): Policy {
    this.current = this.baseline;
    return this.current;
  }
}

export function describePolicy(policy: Policy): string {
  const { reflexes: r, combat: c, chat, decisions: d } = policy;
  const onOff = (enabled: boolean) => (enabled ? 'on' : 'off');
  return [
    'Reflexes (critical ones keep running even during your commands; routine ones yield to them):',
    `- creeperEvade: ${onOff(r.creeperEvade.enabled)} (critical; run from a creeper about to explode)`,
    `- hazardEscape: ${onOff(r.hazardEscape.enabled)}, lowAir ${r.hazardEscape.lowAir} (critical; leave fire, lava or deep water)`,
    `- lowHealthRetreat: ${onOff(r.lowHealthRetreat.enabled)}, health below ${r.lowHealthRetreat.health} (or at/below combat retreatHealth ${c.retreatHealth}) with hostiles within ${r.lowHealthRetreat.radius} (critical)`,
    `- selfDefense: ${onOff(r.selfDefense.enabled)}, stance ${r.selfDefense.stance} (routine; fight back or flee when a mob hits the bot; never against players)`,
    `- autoEat: ${onOff(r.autoEat.enabled)}, food below ${r.autoEat.food} (routine; only with no hostiles within 8 blocks)`,
    'Combat:',
    `- attackPlayers: ${c.attackPlayers}`,
    `- avoidNeutral: ${c.avoidNeutral}`,
    `- retreatHealth: ${c.retreatHealth} (stop fighting at or below this health)`,
    'Chat:',
    `- triage: ${onOff(chat.triage)} (report messages meant for the bot as chat_request events)`,
    `- commandsFrom: ${chat.commandsFrom.length > 0 ? chat.commandsFrom.join(', ') : 'nobody'} (players whose clear commands run without you)`,
    `- replyInChat: ${onOff(chat.replyInChat)} (confirm those commands in chat)`,
    'Decisions:',
    `- enabled: ${onOff(d.enabled)}, model ${d.model}`,
    `- actThreshold: ${d.actThreshold}, cautiousThreshold: ${d.cautiousThreshold}, maxCallsPerMinute: ${d.maxCallsPerMinute}`
  ].join('\n');
}
