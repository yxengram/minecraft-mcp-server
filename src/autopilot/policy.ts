// Contract: docs/BLUEPRINT.md F-014 (M3 scope: reflexes and combat; the chat and decisions groups arrive in M4).
// The policy lives in memory only and goes back to its defaults whenever the bot (re)joins the game.
import { z } from 'zod';

export type PolicySource = 'llm' | 'startup';
const SOURCES: readonly string[] = ['llm', 'startup'];

const vital = () => z.number().min(0).max(20);
const distance = () => z.number().min(1).max(32);

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

export const policySchema = z.object({ reflexes: reflexesSchema, combat: combatSchema }).strict();
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
export const policyUpdateSchema = z.object({
  reflexes: reflexesUpdateSchema.optional(),
  combat: combatUpdateSchema.optional()
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
  combat: { attackPlayers: false, avoidNeutral: true, retreatHealth: 6 }
};

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
  if (value && typeof value === 'object') return Object.values(value).reduce((sum: number, child) => sum + leafCount(child), 0);
  return value === undefined ? 0 : 1;
}

export class PolicyStore {
  private current: Policy = deepFreeze(clone(DEFAULT_POLICY));

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

    const next = clone(this.current);
    for (const [group, fields] of Object.entries(parsed.data) as [keyof Policy, Record<string, unknown> | undefined][]) {
      if (!fields) continue;
      if (group === 'combat') {
        Object.assign(next.combat, fields);
      } else {
        for (const [reflex, settings] of Object.entries(fields)) {
          if (settings) Object.assign(next.reflexes[reflex as keyof Policy['reflexes']], settings);
        }
      }
    }

    if (leafCount(parsed.data) === 0) {
      return { ok: false, errors: ['no policy fields given; groups are reflexes and combat (see get-policy)'] };
    }

    const changed = changedPaths(this.current, next);
    const warnings: string[] = [];
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

  reset(): Policy {
    this.current = deepFreeze(clone(DEFAULT_POLICY));
    return this.current;
  }
}

export function describePolicy(policy: Policy): string {
  const { reflexes: r, combat: c } = policy;
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
    `- retreatHealth: ${c.retreatHealth} (stop fighting at or below this health)`
  ].join('\n');
}
