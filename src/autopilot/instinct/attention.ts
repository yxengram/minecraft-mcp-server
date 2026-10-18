// Contract: docs/BLUEPRINT.md F-037. Decides WHEN the instinct should be asked, never WHAT to do: lists the cues the
// bot can sense right now and says whether this tick needs a decision. Memory-only, run on every tick (invariant I6).
import type mineflayer from 'mineflayer';
import type { Policy } from '../policy.js';
import { burningNow, columnAbove, headInWater, inLavaNow, touchingFire } from '../hazards.js';
import { airLevel } from '../../tools/gamestate-tools.js';

export type CueKind = 'in_lava' | 'trapped_underwater' | 'low_air' | 'on_fire';

export interface Cue {
  kind: CueKind;
  /** One line for the decision model and the events, e.g. "under water, stone ceiling 2 blocks up, 14 air left". */
  detail: string;
}

/** What the bot senses right now that may need a decision. */
export function readCues(bot: mineflayer.Bot, policy: Policy): Cue[] {
  const cues: Cue[] = [];
  const air = airLevel(bot);
  const airText = air === undefined ? 'air unknown' : `${air} air left`;
  if (inLavaNow(bot)) cues.push({ kind: 'in_lava', detail: `standing in lava (health ${bot.health ?? '?'})` });
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
  return cues;
}

/**
 * Tracks one "danger episode" (from the first cue until all cues are gone) and says when to ask: a cue that was not
 * there at the last request, the re-ask interval passing while cues last, or the instinct's last action ending.
 */
export class Attention {
  private askedKinds = new Set<CueKind>();
  private lastAskAt = -Infinity;
  private reask = false;
  private active = false;
  /** Increments whenever a new episode starts. */
  episode = 0;

  /** Whether this tick should ask, given the cues now. Clears the episode when there are none. */
  shouldAsk(cues: Cue[], now: number, reaskMs: number): boolean {
    if (cues.length === 0) {
      if (this.active) this.reset();
      return false;
    }
    if (!this.active) {
      this.active = true;
      this.episode++;
    }
    if (this.reask) return true;
    if (cues.some(cue => !this.askedKinds.has(cue.kind))) return true;
    return now - this.lastAskAt >= reaskMs;
  }

  noteAsked(cues: Cue[], now: number): void {
    this.lastAskAt = now;
    this.reask = false;
    this.askedKinds = new Set(cues.map(cue => cue.kind));
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
    this.askedKinds.clear();
    this.lastAskAt = -Infinity;
  }
}
