// Contract: docs/BLUEPRINT.md F-039. The "cerebellum": motor programs that carry out what the instinct chose, until
// they finish, fail or are cancelled. A macro never switches to a different behavior on its own: when it cannot do
// its job it throws, and the instinct decides again.
import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { delay } from '../task-manager.js';
import {
  burningNow, columnAbove, describeSpot, headInWater, inLavaNow, isWater, markWaterUnreachable, nearestSafeSpot,
  safeToDigOut, touchingFire, yawToward
} from '../hazards.js';
import { equipBestTool } from '../../tools/block-utils.js';

export type MacroName = 'swim_up' | 'swim_to_air' | 'dig_up' | 'leave_lava' | 'go_to_water' | 'step_off_fire';

export interface MacroContext {
  bot: mineflayer.Bot;
  signal: AbortSignal;
  /** The spot the menu worked out: the air pocket, the ceiling block, the safe spot or the water. */
  target: Vec3 | null;
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

export const MACROS: Record<MacroName, MacroDefinition> = {
  swim_up: swimUp,
  swim_to_air: swimToAir,
  dig_up: digUp,
  leave_lava: leaveLava,
  go_to_water: goToWater,
  step_off_fire: stepOffFire
};
