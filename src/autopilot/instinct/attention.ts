// Contract: docs/BLUEPRINT.md F-037 (M9 changes in F1-h). Decides WHEN the instinct should be asked, never WHAT to do:
// lists the cues the bot can sense right now and says whether this tick needs a decision. Memory-only, run on every
// tick (invariant I6).
import type mineflayer from 'mineflayer';
import type { Policy } from '../policy.js';
import { burningNow, columnAbove, enclosedNow, headInWater, inLavaNow, touchingFire } from '../hazards.js';
import { assessThreats, isSwellingCreeper } from '../threats.js';
import { currentCombatTarget } from '../combat.js';
import { bestFood, label } from './motor.js';
import { airLevel } from '../../tools/gamestate-tools.js';
import { describeOffset } from '../../tools/terrain-utils.js';

export type CueKind =
  | 'in_lava' | 'trapped_underwater' | 'low_air' | 'on_fire'
  | 'creeper_swelling' | 'creeper_near' | 'attacked' | 'low_health' | 'hungry' | 'chased';

export interface Cue {
  kind: CueKind;
  /** One line for the decision model and the events, e.g. "under water, stone ceiling 2 blocks up, 14 air left". */
  detail: string;
  /** The entity the cue is about (the creeper, the attacker), for the menu. */
  entityId?: number;
}

/** A mob the instinct ran from that came back within the flee distance (E-016), as the engine saw it. */
export interface Chaser {
  id: number;
  label: string;
  /** "came within 16 blocks again 6s later". */
  detail: string;
}

/** The most recent hit the bot took (E-005 onDamage). */
export interface DamageInfo {
  attackerId?: number;
  type: string;
  time: number;
}

export const CREEPER_SWELL_RADIUS = 7;
export const CREEPER_NEAR_RADIUS = 10;
// A hit is a cue for this long, so one fight is one danger and not a new one with every blow.
export const ATTACK_CUE_MS = 3000;
// Lava damage this recent means the bot is in lava even when no cell it touches reads as lava (E-018).
export const LAVA_DAMAGE_CUE_MS = 1000;

/** The server burned the bot with lava within LAVA_DAMAGE_CUE_MS: it is in lava, whatever the cells around it read. */
export function burnedByLava(damage: DamageInfo | null, now = Date.now()): boolean {
  return damage?.type === 'lava' && now - damage.time <= LAVA_DAMAGE_CUE_MS;
}
// Hunger changes slowly: asking about it every 1.5 s would only spend calls.
const REASK_MS: Partial<Record<CueKind, number>> = { hungry: 20000 };

function where(bot: mineflayer.Bot, position: { x: number; z: number }): string {
  const self = bot.entity.position;
  return describeOffset(Math.round(position.x - self.x), Math.round(position.z - self.z));
}

/** What the bot senses right now that may need a decision. */
export function readCues(bot: mineflayer.Bot, policy: Policy, damage: DamageInfo | null = null, now = Date.now(), chasers: Chaser[] = []): Cue[] {
  const cues: Cue[] = [];
  const air = airLevel(bot);
  const airText = air === undefined ? 'air unknown' : `${air} air left`;
  const health = typeof bot.health === 'number' ? bot.health : undefined;
  if (inLavaNow(bot)) {
    cues.push({ kind: 'in_lava', detail: `standing in lava (health ${health ?? '?'})` });
  } else if (burnedByLava(damage, now)) {
    cues.push({ kind: 'in_lava', detail: `taking lava damage (health ${health ?? '?'})` });
  }
  if (headInWater(bot)) {
    const column = columnAbove(bot);
    if (!column.open && column.ceiling) {
      const above = column.ceiling.y - bot.entity.position.floored().y - 1;
      const name = bot.blockAt(column.ceiling)?.name ?? 'solid';
      cues.push({ kind: 'trapped_underwater', detail: `under water with a ${name} ceiling ${above} block(s) above the head, ${airText}` });
    } else if (air !== undefined && air <= policy.instinct.lowAir) {
      cues.push({ kind: 'low_air', detail: `under water, ${airText}` });
    }
  }
  if (burningNow(bot)) cues.push({ kind: 'on_fire', detail: touchingFire(bot) ? 'on fire and standing in or next to fire' : 'on fire' });

  const { hostileRadius, lowHealth, food } = policy.instinct;
  // Walled in on every side, no mob can reach the bot: hostiles near and a creeper walking about are no danger (E-016).
  const enclosed = enclosedNow(bot);
  const threats = assessThreats(bot, { radius: Math.max(hostileRadius, CREEPER_NEAR_RADIUS) });
  const creepers = threats.hostiles.filter(threat => threat.entity.name === 'creeper' && threat.distance <= CREEPER_NEAR_RADIUS);
  const swelling = creepers.find(threat => threat.distance <= CREEPER_SWELL_RADIUS && isSwellingCreeper(bot, threat.entity));
  if (swelling) {
    cues.push({ kind: 'creeper_swelling', entityId: swelling.entity.id, detail: `${label(swelling.entity)} ${swelling.distance.toFixed(1)} blocks ${where(bot, swelling.entity.position)} is about to explode (about 1.5 s fuse)` });
  } else if (creepers.length > 0 && !enclosed) {
    const nearest = creepers[0];
    const state = isSwellingCreeper(bot, nearest.entity) ? 'swelling, but beyond its blast range for now' : 'not swelling yet';
    cues.push({ kind: 'creeper_near', entityId: nearest.entity.id, detail: `${label(nearest.entity)} ${nearest.distance.toFixed(1)} blocks ${where(bot, nearest.entity.position)}, ${state}` });
  }

  if (damage?.attackerId !== undefined && now - damage.time <= ATTACK_CUE_MS) {
    const attacker = bot.entities?.[damage.attackerId];
    // Already fighting it (a guard or hunt task, or the instinct's own fight): its blows are part of that fight.
    if (attacker && attacker !== bot.entity && attacker.position && currentCombatTarget(bot) !== attacker.id) {
      const distance = bot.entity.position.distanceTo(attacker.position);
      cues.push({ kind: 'attacked', entityId: attacker.id, detail: `hit by ${label(attacker)} ${distance.toFixed(1)} blocks ${where(bot, attacker.position)} (${damage.type}); health ${health ?? '?'}` });
    }
  }

  const near = threats.hostiles.filter(threat => threat.distance <= hostileRadius);
  if (health !== undefined && !enclosed && (health < lowHealth || health <= policy.combat.retreatHealth) && near.length > 0) {
    cues.push({ kind: 'low_health', detail: `health ${health} with ${near.length} hostile(s) within ${hostileRadius} blocks (nearest ${label(near[0].entity)} ${near[0].distance.toFixed(1)} blocks away)` });
  }

  // Back after the bot ran from it: ask again now, while it is still some way off, not only once it hits (E-016).
  if (!enclosed && !cues.some(cue => cue.kind === 'attacked')) {
    for (const chaser of chasers) {
      const mob = bot.entities?.[chaser.id];
      if (!mob || mob.isValid === false || !mob.position) continue;
      const distance = bot.entity.position.distanceTo(mob.position);
      if (distance > hostileRadius) continue;
      cues.push({ kind: 'chased', entityId: chaser.id, detail: `${chaser.label} ${distance.toFixed(1)} blocks ${where(bot, mob.position)} is back: the bot ran from it and it ${chaser.detail}` });
      break;
    }
  }

  if (typeof bot.food === 'number' && bot.food < food) {
    const meal = bestFood(bot);
    if (meal) cues.push({ kind: 'hungry', detail: `food ${bot.food} (below ${food}); has ${meal.name}` });
  }
  return cues;
}

export type AskReason = 'new' | 'reask' | 'action_ended';

// How soon each kind of danger can hurt, most urgent first. Used only to decide whether a new cue is worth a request
// that supersedes one already in flight (BLUEPRINT F1-h): a lit creeper must not wait behind a hit, but catching fire
// must not throw away an answer about a lit creeper that is about to arrive. It never decides what to do.
export const CUE_URGENCY: CueKind[] = [
  'creeper_swelling', 'in_lava', 'trapped_underwater', 'low_air', 'low_health', 'on_fire', 'attacked', 'chased', 'creeper_near', 'hungry'
];

/** Whether `cues` holds a kind more urgent than every kind in `inFlight`. */
export function outranks(cues: Cue[], inFlight: Cue[]): boolean {
  const rank = (kind: CueKind) => CUE_URGENCY.indexOf(kind);
  const best = (list: Cue[]) => Math.min(...list.map(cue => rank(cue.kind)));
  return inFlight.length === 0 || best(cues) < best(inFlight);
}

/**
 * Tracks one "danger episode" (from the first cue until all cues are gone and no instinct action runs) and says when
 * to ask: a cue that was not there at the last request, a cue's re-ask interval passing, or the instinct's last action
 * ending.
 */
export class Attention {
  private lastAskAt = new Map<CueKind, number>();
  private reask = false;
  private active = false;
  /** Increments whenever a new episode starts. */
  episode = 0;

  /**
   * Why this tick should ask, or null. Without cues the episode ends, unless `keepEpisode` (an instinct action is still
   * running, e.g. a fight that hides the 'attacked' cue).
   */
  shouldAsk(cues: Cue[], now: number, reaskMs: number, keepEpisode = false): AskReason | null {
    if (cues.length === 0) {
      if (this.active && !keepEpisode) this.reset();
      return null;
    }
    if (!this.active) {
      this.active = true;
      this.episode++;
    }
    if (cues.some(cue => !this.lastAskAt.has(cue.kind))) return 'new';
    if (this.reask) return 'action_ended';
    const due = cues.some(cue => now - this.lastAskAt.get(cue.kind)! >= (REASK_MS[cue.kind] ?? reaskMs));
    return due ? 'reask' : null;
  }

  noteAsked(cues: Cue[], now: number): void {
    this.reask = false;
    // Kinds not present any more are forgotten, so their return counts as new.
    const present = new Set(cues.map(cue => cue.kind));
    for (const kind of this.lastAskAt.keys()) if (!present.has(kind)) this.lastAskAt.delete(kind);
    for (const kind of present) this.lastAskAt.set(kind, now);
  }

  /** The instinct's action ended (done or failed): ask again on the next tick if any cue is still there. */
  noteActionEnded(): void {
    this.reask = true;
  }

  inEpisode(): boolean {
    return this.active;
  }

  reset(): void {
    this.active = false;
    this.reask = false;
    this.lastAskAt.clear();
  }
}
