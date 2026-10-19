// Contract: docs/BLUEPRINT.md F-039. The "cerebellum": motor programs that carry out what the instinct chose, until
// they finish, fail or are cancelled. A macro never switches to a different behavior on its own: when it cannot do
// its job it throws, and the instinct decides again.
import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { delay } from '../task-manager.js';
import {
  burningNow, columnAbove, describeSpot, DIG_IN_DEPTH, digInPlan, headInWater, inLavaNow, isSolidWall, isWater,
  markWaterUnreachable, nearestSafeSpot, safeToDigOut, touchingFire, yawToward
} from '../hazards.js';
import { equipBestTool } from '../../tools/block-utils.js';
import { BotEntity, refreshEntity } from '../../tools/entity-utils.js';
import { bestWeaponName, engage } from '../combat.js';
import { assessThreats } from '../threats.js';
import type { Policy } from '../policy.js';
import { eat, holdGround, label, runAway } from './motor.js';

export type MacroName =
  | 'swim_up' | 'swim_to_air' | 'dig_up' | 'leave_lava' | 'go_to_water' | 'step_off_fire'
  | 'run_from_creeper' | 'flee' | 'fight' | 'hold' | 'eat' | 'dig_in';

export interface MacroContext {
  bot: mineflayer.Bot;
  signal: AbortSignal;
  /** The spot the menu worked out: the air pocket, the ceiling block, the safe spot or the water. */
  target: Vec3 | null;
  /** The entity the menu worked out: the creeper to run from, the mob to fight or hold against. */
  entityId?: number;
  policy: Policy;
}

export interface MacroDefinition {
  name: MacroName;
  maxDurationMs: number;
  /** Drives the body until done and returns the result text; throws when it cannot do its job. */
  run(context: MacroContext): Promise<string>;
}

const TICK_MS = 50;
// Not getting closer for this long means the way is blocked.
const SWIM_STALL_MS = 4000;
const WALK_STALL_MS = 2000;
// Ceiling blocks are dug from the floor: digging while floating is five times slower.
const DIG_REACH = 4;
const EYE_HEIGHT = 1.6;

/** Tracks whether the bot keeps getting closer to a target; `stalled()` once it has not for `ms`. */
function progress(ms: number) {
  let closest = Infinity;
  let at = Date.now();
  return {
    stalled(distance: number): boolean {
      if (distance < closest - 0.3) {
        closest = distance;
        at = Date.now();
        return false;
      }
      return Date.now() - at > ms;
    }
  };
}

function clearGoal(bot: mineflayer.Bot): void {
  if (bot.pathfinder.goal) bot.pathfinder.setGoal(null);
}

const swimUp: MacroDefinition = {
  name: 'swim_up',
  maxDurationMs: 15000,
  async run({ bot, signal }) {
    for (;;) {
      signal.throwIfAborted();
      if (!headInWater(bot)) return 'head out of the water';
      if (!columnAbove(bot).open) throw new Error('a ceiling is above; swimming up cannot reach air');
      clearGoal(bot);
      bot.setControlState('forward', false);
      bot.setControlState('jump', true);
      await delay(TICK_MS, signal);
    }
  }
};

// The pathfinder cannot plan upward moves out of water, so the bot steers by itself: face the pocket, swim forward
// and keep rising.
const swimToAir: MacroDefinition = {
  name: 'swim_to_air',
  maxDurationMs: 15000,
  async run({ bot, signal, target }) {
    if (!target) throw new Error('no air pocket given');
    const where = describeSpot(bot, target);
    const watch = progress(SWIM_STALL_MS);
    for (;;) {
      signal.throwIfAborted();
      if (!headInWater(bot)) return `swam to the air pocket (${where})`;
      clearGoal(bot);
      const toward = target.offset(0.5, 0, 0.5).minus(bot.entity.position);
      const horizontal = Math.hypot(toward.x, toward.z);
      if (horizontal > 0.4) void bot.look(yawToward(toward), 0, true).catch(() => {});
      bot.setControlState('forward', horizontal > 0.4);
      bot.setControlState('jump', true);
      if (watch.stalled(bot.entity.position.distanceTo(target))) throw new Error(`could not get closer to the air pocket (${where})`);
      await delay(TICK_MS, signal);
    }
  }
};

const digUp: MacroDefinition = {
  name: 'dig_up',
  maxDurationMs: 15000,
  async run({ bot, signal }) {
    let dug = 0;
    for (;;) {
      signal.throwIfAborted();
      if (!headInWater(bot)) return dug > 0 ? `dug up through ${dug} block(s) and got to air` : 'got to air';
      clearGoal(bot);
      const column = columnAbove(bot);
      if (column.open) {
        bot.setControlState('forward', false);
        bot.setControlState('jump', true);
      } else if (!column.ceiling || !safeToDigOut(bot, column.ceiling)) {
        throw new Error(`the ceiling${column.ceiling ? ` (${bot.blockAt(column.ceiling)?.name ?? 'unknown'})` : ''} cannot be dug out safely`);
      } else {
        // Sink to the floor and dig from there when the ceiling is within reach of it; too high: swim up toward it.
        const eyes = bot.entity.position.offset(0, EYE_HEIGHT, 0);
        const reach = eyes.distanceTo(column.ceiling.offset(0.5, 0.5, 0.5));
        bot.setControlState('forward', false);
        if (!bot.entity.onGround) {
          bot.setControlState('jump', reach > DIG_REACH + 1.5);
        } else if (reach > DIG_REACH) {
          bot.setControlState('jump', true);
        } else {
          bot.clearControlStates();
          const block = bot.blockAt(column.ceiling)!;
          await equipBestTool(bot, block).catch(() => {});
          signal.throwIfAborted();
          const stop = () => bot.stopDigging();
          signal.addEventListener('abort', stop, { once: true });
          try {
            await bot.dig(block, true);
            dug++;
          } catch {
            // Try again on the next tick (the block may have changed).
          } finally {
            signal.removeEventListener('abort', stop);
          }
          signal.throwIfAborted();
          bot.setControlState('jump', true);
        }
      }
      await delay(TICK_MS, signal);
    }
  }
};

// The pathfinder cannot plan a way out of a lava pool either: steer to the safe spot directly and keep jumping;
// leaving the liquid lifts the bot over the edge.
const leaveLava: MacroDefinition = {
  name: 'leave_lava',
  maxDurationMs: 8000,
  async run({ bot, signal, target }) {
    let spot = target;
    let from = bot.entity.position.floored().toString();
    for (;;) {
      signal.throwIfAborted();
      if (!inLavaNow(bot)) return 'out of the lava';
      clearGoal(bot);
      const feet = bot.entity.position.floored().toString();
      if (!spot || feet !== from) {
        spot = nearestSafeSpot(bot) ?? spot;
        from = feet;
      }
      if (spot) {
        const toward = spot.offset(0.5, 0, 0.5).minus(bot.entity.position);
        void bot.look(yawToward(toward), 0, true).catch(() => {});
        bot.setControlState('forward', true);
        bot.setControlState('sprint', true);
      }
      bot.setControlState('jump', true);
      await delay(TICK_MS, signal);
    }
  }
};

const goToWater: MacroDefinition = {
  name: 'go_to_water',
  maxDurationMs: 10000,
  async run({ bot, signal, target }) {
    if (!target) throw new Error('no water given');
    const goal = new goals.GoalBlock(target.x, target.y, target.z);
    const watch = progress(WALK_STALL_MS);
    for (;;) {
      signal.throwIfAborted();
      if (!burningNow(bot)) return 'the fire is out';
      if (isWater(bot.blockAt(bot.entity.position.floored()))) {
        // In water: the fire goes out on the next update.
        clearGoal(bot);
        bot.clearControlStates();
      } else {
        if (bot.pathfinder.goal !== goal) bot.pathfinder.setGoal(goal);
        if (watch.stalled(bot.entity.position.distanceTo(target))) {
          markWaterUnreachable(bot, target);
          throw new Error(`could not reach the water (${describeSpot(bot, target)})`);
        }
      }
      await delay(TICK_MS, signal);
    }
  }
};

const stepOffFire: MacroDefinition = {
  name: 'step_off_fire',
  maxDurationMs: 10000,
  async run({ bot, signal, target }) {
    if (!target) throw new Error('no safe spot given');
    const goal = new goals.GoalBlock(target.x, target.y, target.z);
    const watch = progress(WALK_STALL_MS);
    for (;;) {
      signal.throwIfAborted();
      if (!touchingFire(bot)) return burningNow(bot) ? 'off the fire (still burning; only water puts it out sooner)' : 'off the fire';
      if (bot.pathfinder.goal !== goal) bot.pathfinder.setGoal(goal);
      if (watch.stalled(bot.entity.position.distanceTo(target))) throw new Error(`could not reach the safe spot (${describeSpot(bot, target)})`);
      await delay(TICK_MS, signal);
    }
  }
};

// Out of blast range at 8 blocks; but a creeper keeps walking after the bot, so the run goes on until it is 16 blocks
// away, where it loses track of the bot. Stopping at 8 put the bot on a leash: the creeper was back at 6 blocks before
// the next decision came (M9, live).
export const CREEPER_SAFE_DISTANCE = 8;
export const CREEPER_LOSE_DISTANCE = 16;
const FLEE_DISTANCE = 16;

function target(bot: mineflayer.Bot, id: number | undefined): BotEntity {
  const found = id === undefined ? undefined : bot.entities?.[id];
  if (!found || found.isValid === false || !found.position) throw new Error('the target is gone');
  return found;
}

const runFromCreeper: MacroDefinition = {
  name: 'run_from_creeper',
  maxDurationMs: 8000,
  async run({ bot, signal, entityId }) {
    const creeper = target(bot, entityId);
    let live: BotEntity | null = creeper;
    const distance = () => (live ? bot.entity.position.distanceTo(live.position) : Infinity);
    await runAway(bot, signal, () => {
      live = refreshEntity(bot, creeper);
      return live ? [live.position] : [];
    }, () => distance() >= CREEPER_LOSE_DISTANCE);
    return live ? `moved ${distance().toFixed(1)} blocks away from ${label(creeper)}` : 'the creeper is gone';
  }
};

// Runs from every hostile within 16 blocks, plus the attacker even when it is not one (a player, a neutral mob).
const flee: MacroDefinition = {
  name: 'flee',
  maxDurationMs: 10000,
  async run({ bot, signal, entityId }) {
    const attacker = entityId === undefined ? null : bot.entities?.[entityId] ?? null;
    const near = () => {
      const mobs = assessThreats(bot, { radius: FLEE_DISTANCE }).hostiles.map(threat => threat.entity);
      const live = attacker ? refreshEntity(bot, attacker) : null;
      if (live && !mobs.some(mob => mob.id === live.id) && live.position.distanceTo(bot.entity.position) <= FLEE_DISTANCE) mobs.push(live);
      return mobs;
    };
    const from = near().length;
    await runAway(bot, signal, () => near().map(mob => mob.position), () => near().length === 0);
    return `got more than ${FLEE_DISTANCE} blocks away from ${from} mob(s)`;
  }
};

// Never against a player, whatever the policy says: the menu only offers legal targets, and the rules here say so too.
const fight: MacroDefinition = {
  name: 'fight',
  maxDurationMs: 20000,
  async run({ bot, signal, entityId, policy }) {
    const mob = target(bot, entityId);
    // The weapon goes into the result: a later decision must not take a fight won with a sword as a reason to fight
    // with bare hands (M14, live).
    const weapon = bestWeaponName(bot);
    const result = await engage(bot, mob, {
      signal,
      maxChase: FLEE_DISTANCE,
      retreatHealth: policy.combat.retreatHealth,
      rules: { attackPlayers: false, avoidNeutral: policy.combat.avoidNeutral }
    });
    if (result.outcome === 'illegal_target') throw new Error(result.detail);
    return `fought ${label(mob)} with ${weapon}: ${result.detail}`;
  }
};

const hold: MacroDefinition = {
  name: 'hold',
  maxDurationMs: 20000,
  async run({ bot, signal, entityId, policy }) {
    return holdGround(bot, target(bot, entityId), signal, policy);
  }
};

const eatNow: MacroDefinition = {
  name: 'eat',
  maxDurationMs: 5000,
  async run({ bot, signal }) {
    clearGoal(bot);
    bot.clearControlStates();
    const ate = await eat(bot, signal);
    if (!ate) throw new Error('nothing safe to eat, or not hungry');
    return ate;
  }
};

// Digging in (E-016): three blocks straight down, then the hole above the head is closed. The bot stands in the middle
// of its cell first, or it stays on the edge of the next block instead of dropping in.
const CENTER_MS = 1000;
const LAND_MS = 1000;
const DROP_MS = 1000;
const PICKUP_MS = 1000;
const SIDES: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function count(bot: mineflayer.Bot, name: string): number {
  return bot.inventory.items().filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
}

const digIn: MacroDefinition = {
  name: 'dig_in',
  maxDurationMs: 10000,
  async run({ bot, signal }) {
    // A hit knocks the bot into the air for a moment: wait for it to land before judging the ground.
    let plan = digInPlan(bot);
    for (let waited = 0; !plan && !bot.entity.onGround && waited < LAND_MS; waited += TICK_MS) {
      await delay(TICK_MS, signal);
      plan = digInPlan(bot);
    }
    if (!plan) throw new Error('the ground here is no longer safe or quick to dig into');
    const started = Date.now();
    clearGoal(bot);
    bot.clearControlStates();
    const center = plan.cap.offset(0.5, 1, 0.5);
    for (let waited = 0; Math.hypot(center.x - bot.entity.position.x, center.z - bot.entity.position.z) > 0.2 && waited < CENTER_MS; waited += TICK_MS) {
      signal.throwIfAborted();
      void bot.look(yawToward(center.minus(bot.entity.position)), 0, true).catch(() => {});
      bot.setControlState('forward', true);
      await delay(TICK_MS, signal);
    }
    bot.clearControlStates();
    for (const [index, cell] of plan.cells.entries()) {
      signal.throwIfAborted();
      const block = bot.blockAt(cell);
      if (!block || !isSolidWall(block)) throw new Error(`block ${index + 1} below the feet changed before it was dug`);
      await equipBestTool(bot, block).catch(() => {});
      signal.throwIfAborted();
      const stop = () => bot.stopDigging();
      signal.addEventListener('abort', stop, { once: true });
      try {
        await bot.dig(block, true);
      } finally {
        signal.removeEventListener('abort', stop);
      }
      signal.throwIfAborted();
      for (let waited = 0; bot.entity.position.y > cell.y + 0.1 && waited < DROP_MS; waited += TICK_MS) await delay(TICK_MS, signal);
      if (bot.entity.position.y > cell.y + 0.1) throw new Error(`dug ${index + 1} block(s) but the bot did not drop into the hole`);
    }
    // The cover may be the first block's drop, which falls into the hole after the bot.
    for (let waited = 0; count(bot, plan.capItem) === 0 && waited < PICKUP_MS; waited += TICK_MS) await delay(TICK_MS, signal);
    const cover = bot.inventory.items().find(item => item.name === plan.capItem);
    if (!cover) throw new Error(`dug ${DIG_IN_DEPTH} blocks down but has no ${plan.capItem} to close the hole`);
    await bot.equip(cover, 'hand');
    signal.throwIfAborted();
    const references = [plan.reference, ...SIDES.map(([dx, dz]) => plan.cap.offset(dx, 0, dz)).filter(spot => !spot.equals(plan.reference))];
    for (const spot of references) {
      if (isSolidWall(bot.blockAt(plan.cap))) break;
      const reference = bot.blockAt(spot);
      if (!isSolidWall(reference)) continue;
      // Straight against the side of the neighbouring block: no walking, no pathfinding.
      await bot.placeBlock(reference!, plan.cap.minus(spot)).catch(() => {});
      signal.throwIfAborted();
    }
    if (!isSolidWall(bot.blockAt(plan.cap))) throw new Error(`dug ${DIG_IN_DEPTH} blocks down but could not close the hole above the head`);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const { x, y, z } = plan.cap;
    return `dug in ${DIG_IN_DEPTH} blocks down and closed the hole above the head with ${plan.capItem} (${seconds}s): no mob can reach the bot; dig the block above the head at (${x}, ${y}, ${z}) to get out`;
  }
};

export const MACROS: Record<MacroName, MacroDefinition> = {
  swim_up: swimUp,
  swim_to_air: swimToAir,
  dig_up: digUp,
  leave_lava: leaveLava,
  go_to_water: goToWater,
  step_off_fire: stepOffFire,
  run_from_creeper: runFromCreeper,
  flee,
  fight,
  hold,
  eat: eatNow,
  dig_in: digIn
};
