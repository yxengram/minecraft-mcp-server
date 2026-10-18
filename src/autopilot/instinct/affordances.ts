// Contract: docs/BLUEPRINT.md F-038. Works out what the bot CAN do about the cues right now (facts and feasibility)
// and offers it as a menu; the decision model picks. Only options that are possible are listed, and anything unsafe
// is filtered out here (M8 offers no attacks at all; from M9 attack options must pass checkTarget, invariant I1).
import type mineflayer from 'mineflayer';
import type { Vec3 } from 'vec3';
import type { Cue } from './attention.js';
import type { MacroName } from './macros.js';
import { columnAbove, describeSpot, inLavaNow, nearestAirPocket, nearestSafeSpot, nearestWater, safeToDigOut, touchingFire } from '../hazards.js';

export type FixedOptionId = 'continue' | 'suspend_task' | 'ask_llm' | 'none';
export type OptionId = MacroName | FixedOptionId;

export interface MenuOption {
  id: OptionId;
  /** What the option does, for the decision model (relative directions, no coordinates). */
  text: string;
  macro?: MacroName;
  target?: Vec3 | null;
}

export interface MenuContext {
  hasTask: boolean;
}

export const FIXED_OPTIONS: FixedOptionId[] = ['continue', 'suspend_task', 'ask_llm', 'none'];

function waterOptions(bot: mineflayer.Bot): MenuOption[] {
  const options: MenuOption[] = [];
  const column = columnAbove(bot);
  if (column.open) {
    options.push({ id: 'swim_up', macro: 'swim_up', text: 'swim straight up to the surface (the water above is open)' });
  }
  const pocket = nearestAirPocket(bot);
  if (pocket) {
    options.push({ id: 'swim_to_air', macro: 'swim_to_air', target: pocket, text: `swim to the nearest air pocket that can be reached through the water: ${describeSpot(bot, pocket)}` });
  }
  if (!column.open && column.ceiling && safeToDigOut(bot, column.ceiling)) {
    const block = bot.blockAt(column.ceiling)!;
    const above = column.ceiling.y - bot.entity.position.floored().y - 1;
    const tool = bot.pathfinder?.bestHarvestTool?.(block)?.name ?? 'bare hands';
    options.push({
      id: 'dig_up',
      macro: 'dig_up',
      target: column.ceiling,
      text: `sink to the floor and dig up through the ${block.name} ceiling ${above} block(s) above the head with ${tool}, then swim up`
    });
  }
  return options;
}

function lavaOptions(bot: mineflayer.Bot): MenuOption[] {
  const spot = nearestSafeSpot(bot);
  return [{
    id: 'leave_lava',
    macro: 'leave_lava',
    target: spot,
    text: spot
      ? `sprint and jump out of the lava toward safe ground ${describeSpot(bot, spot)}`
      : 'keep jumping and look for a way out of the lava (no safe ground found within 5 blocks)'
  }];
}

function fireOptions(bot: mineflayer.Bot): MenuOption[] {
  const options: MenuOption[] = [];
  const water = nearestWater(bot);
  if (water) {
    options.push({ id: 'go_to_water', macro: 'go_to_water', target: water, text: `walk into the water ${describeSpot(bot, water)} to put the fire out` });
  }
  if (touchingFire(bot)) {
    const spot = nearestSafeSpot(bot);
    if (spot) options.push({ id: 'step_off_fire', macro: 'step_off_fire', target: spot, text: `step off the fire onto safe ground ${describeSpot(bot, spot)} (the bot keeps burning for a few seconds)` });
  }
  return options;
}

/** The options for these cues, action options first, then the fixed ones. */
export function buildMenu(bot: mineflayer.Bot, cues: Cue[], context: MenuContext): MenuOption[] {
  const kinds = new Set(cues.map(cue => cue.kind));
  const options: MenuOption[] = [];
  const add = (more: MenuOption[]) => {
    for (const option of more) if (!options.some(existing => existing.id === option.id)) options.push(option);
  };
  if (kinds.has('in_lava') && inLavaNow(bot)) add(lavaOptions(bot));
  if (kinds.has('trapped_underwater') || kinds.has('low_air')) add(waterOptions(bot));
  if (kinds.has('on_fire')) add(fireOptions(bot));

  options.push({ id: 'continue', text: 'keep doing what the bot is doing now (see doing_now), including an instinct action that is already running' });
  if (context.hasTask) {
    options.push({ id: 'suspend_task', text: 'stop and pause the current task, and leave the decision to the AI player (the task does not resume by itself)' });
  }
  options.push({ id: 'ask_llm', text: 'do nothing now and leave it to the AI player (a running task stays paused until it decides)' });
  options.push({ id: 'none', text: 'none of these fit' });
  return options;
}
