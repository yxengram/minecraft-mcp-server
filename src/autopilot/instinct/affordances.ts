// Contract: docs/BLUEPRINT.md F-038 (M9 changes in F1-h). Works out what the bot CAN do about the cues right now
// (facts and feasibility) and offers it as a menu; the decision model picks. Only options that are possible are
// listed, and anything unsafe is filtered out here: fight and hold only against targets checkTarget allows, with
// attackPlayers always false, so the instinct never attacks a player whatever the policy says (invariant I1).
import type mineflayer from 'mineflayer';
import type { Vec3 } from 'vec3';
import type { Cue } from './attention.js';
import type { MacroName } from './macros.js';
import type { Policy } from '../policy.js';
import { columnAbove, describeSpot, DIG_IN_DEPTH, digInPlan, enclosedNow, inLavaNow, nearestAirPocket, nearestSafeSpot, nearestWater, safeToDigOut, touchingFire } from '../hazards.js';
import { assessThreats, checkTarget, isPlayer } from '../threats.js';
import { bestWeaponName, weaponStats } from '../combat.js';
import { bestFood, label } from './motor.js';
import { metadataValue, type BotEntity } from '../../tools/entity-utils.js';

export type FixedOptionId = 'continue' | 'suspend_task' | 'ask_llm' | 'none';
export type OptionId = MacroName | FixedOptionId;

export interface MenuOption {
  id: OptionId;
  /** What the option does, for the decision model (relative directions, no coordinates). */
  text: string;
  macro?: MacroName;
  target?: Vec3 | null;
  /** The entity the action is about: the creeper to run from, the mob to fight or hold against. */
  entityId?: number;
}

export interface MenuContext {
  hasTask: boolean;
  policy: Policy;
}

// The instinct runs from mobs until none is within this distance (as low-health-retreat and self-defense did).
export const FLEE_DISTANCE = 16;

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

function entity(bot: mineflayer.Bot, id: number | undefined): BotEntity | null {
  const found = id === undefined ? undefined : bot.entities?.[id];
  return found && found !== bot.entity && found.isValid !== false && found.position ? found : null;
}

function creeperOptions(bot: mineflayer.Bot, cues: Cue[]): MenuOption[] {
  const cue = cues.find(entry => entry.kind === 'creeper_swelling') ?? cues.find(entry => entry.kind === 'creeper_near');
  const creeper = entity(bot, cue?.entityId);
  if (!creeper) return [];
  return [{ id: 'run_from_creeper', macro: 'run_from_creeper', entityId: creeper.id, text: `sprint away from ${label(creeper)} until it is 16 blocks away (out of its blast range and too far for it to follow)` }];
}

/** "1 damage per hit, so about 20 hits to kill it; the zombie has 20 health" (mineflayer keeps mob health only as metadata). */
function hitsText(bot: mineflayer.Bot, target: BotEntity, damage: number): string {
  const raw = typeof target.health === 'number' ? target.health : metadataValue(bot, target, 'health');
  if (typeof raw !== 'number' || raw <= 0) return `${damage} damage per hit`;
  const health = Math.ceil(raw);
  return `${damage} damage per hit, so about ${Math.ceil(health / damage)} hits to kill it; the ${target.name ?? 'mob'} has ${health} health`;
}

/** Fight and hold against the attacker, or the nearest hostile, when that is allowed; always the option to run. */
function combatOptions(bot: mineflayer.Bot, cues: Cue[], policy: Policy): MenuOption[] {
  const options: MenuOption[] = [];
  const threats = assessThreats(bot, { radius: FLEE_DISTANCE });
  const attacker = entity(bot, (cues.find(cue => cue.kind === 'attacked') ?? cues.find(cue => cue.kind === 'chased'))?.entityId);
  const others = threats.hostiles.filter(threat => threat.entity.id !== attacker?.id).length;
  if (attacker || threats.hostiles.length > 0) {
    const from = attacker ? `${label(attacker)}${others ? ` and ${others} other hostile(s)` : ''}` : `${threats.hostiles.length} hostile(s)`;
    options.push({ id: 'flee', macro: 'flee', entityId: attacker?.id, text: `run away from ${from} until none is within ${FLEE_DISTANCE} blocks` });
  }
  // Never against players (even with attackPlayers on), tamed animals, or neutral mobs while avoidNeutral is on (I1).
  const rules = { attackPlayers: false, avoidNeutral: policy.combat.avoidNeutral };
  const target = attacker && !isPlayer(attacker) && checkTarget(bot, attacker, rules).legal
    ? attacker
    : !attacker ? threats.hostiles.map(threat => threat.entity).find(mob => checkTarget(bot, mob, rules).legal) ?? null : null;
  // At or below retreatHealth a fight ends at once (combat disengages there), so it is not something the bot can do.
  const canFight = typeof bot.health !== 'number' || bot.health > policy.combat.retreatHealth;
  if (target && canFight) {
    const distance = bot.entity.position.distanceTo(target.position).toFixed(1);
    // How long the fight would take, as facts: with bare hands against two zombies the model chose fight nearly as
    // often as flee (0.40 against 0.43); 0.17-0.20 against 0.55-0.62 once the hits needed were stated (M14 probe).
    const weapon = bestWeaponName(bot);
    const { damage } = weaponStats(weapon === 'bare hand' ? undefined : weapon);
    options.push({ id: 'fight', macro: 'fight', entityId: target.id, text: `fight ${label(target)} (${distance} blocks away) with ${weapon} (${hitsText(bot, target, damage)}); it stops at health ${policy.combat.retreatHealth} or below` });
    options.push({ id: 'hold', macro: 'hold', entityId: target.id, text: `stand still and hit ${label(target)} only when it comes within reach; no chasing, no running` });
  }
  return options;
}

// Mobs that shoot from a distance and do not follow the bot into a hole; any other hostile walks up and drops in after
// it before the hole is closed (M14, live: two zombies next to the bot followed it down the shaft).
const RANGED = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'witch', 'blaze', 'ghast', 'breeze', 'shulker']);
// Blocks per second on foot, roughly; a mob counts as arriving once it is within 1.5 blocks.
const FAST = new Set(['spider', 'cave_spider', 'silverfish', 'endermite']);
export const DIG_IN_MARGIN_S = 1;

function walkSpeed(bot: mineflayer.Bot, mob: BotEntity): number {
  if (FAST.has(mob.name ?? '')) return 3.5;
  const keys = (bot.registry as { entitiesByName?: Record<string, { metadataKeys?: string[] }> } | undefined)?.entitiesByName?.[mob.name ?? '']?.metadataKeys;
  const baby = keys ? (mob.metadata as unknown[] | undefined)?.[keys.indexOf('baby')] === true : false;
  return baby ? 4 : 2.5;
}

/** Seconds until the nearest hostile that walks (not one that shoots) is next to the bot; Infinity when none is near. */
export function meleeArrivalSeconds(bot: mineflayer.Bot): number {
  const walkers = assessThreats(bot, { radius: FLEE_DISTANCE }).hostiles.filter(threat => !RANGED.has(threat.entity.name ?? ''));
  return Math.min(Infinity, ...walkers.map(threat => Math.max(0, threat.distance - 1.5) / walkSpeed(bot, threat.entity)));
}

/**
 * Digging in (E-016): only where the ground is safe for it and it is quick enough (digInPlan), and only while no mob
 * that walks can reach the bot before the hole is closed.
 */
function digInOptions(bot: mineflayer.Bot): MenuOption[] {
  const plan = digInPlan(bot);
  if (!plan || meleeArrivalSeconds(bot) < plan.ms / 1000 + DIG_IN_MARGIN_S) return [];
  const seconds = Math.max(0.5, Math.round(plan.ms / 100) / 10);
  return [{
    id: 'dig_in',
    macro: 'dig_in',
    target: plan.cap,
    text: `dig straight down ${DIG_IN_DEPTH} blocks (about ${seconds} s) and close the hole above the head with ${plan.capItem}: inside, no mob can reach or shoot the bot, so this ends the danger even when mobs keep coming back; the AI player digs out later`
  }];
}

function eatOptions(bot: mineflayer.Bot): MenuOption[] {
  const meal = bestFood(bot);
  if (!meal || typeof bot.food !== 'number' || bot.food >= 20) return [];
  return [{ id: 'eat', macro: 'eat', text: `eat ${meal.name} now (food ${bot.food}; takes about 1.6 s standing still)` }];
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
  // Walled in on every side (after dig_in, say): running, fighting and digging in again all mean breaking out first.
  const enclosed = enclosedNow(bot);
  if (!enclosed && (kinds.has('creeper_swelling') || kinds.has('creeper_near'))) add(creeperOptions(bot, cues));
  if (!enclosed && (kinds.has('attacked') || kinds.has('low_health') || kinds.has('chased'))) {
    add(combatOptions(bot, cues, context.policy));
    add(digInOptions(bot));
  }
  if (kinds.has('hungry') || kinds.has('low_health')) add(eatOptions(bot));

  options.push({ id: 'continue', text: 'keep doing what the bot is doing now (see doing_now), including an instinct action that is already running' });
  if (context.hasTask) {
    options.push({ id: 'suspend_task', text: 'stop and pause the current task, and leave the decision to the AI player (the task does not resume by itself)' });
  }
  options.push({ id: 'ask_llm', text: 'do nothing now and leave it to the AI player (a running task stays paused until it decides)' });
  options.push({ id: 'none', text: 'none of these fit' });
  return options;
}
