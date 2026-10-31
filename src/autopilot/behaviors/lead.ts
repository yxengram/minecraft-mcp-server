// Contract: docs/BLUEPRINT.md F-045 (M18). Leads one animal to a target point: on a lead (leash) when the bot has
// one, otherwise by holding a food the animal follows (lure).
import { z } from 'zod';
import type mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals, Movements } = pathfinderPkg;
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { BehaviorDefinition, delay } from '../task-manager.js';
import { BotEntity, refreshEntity } from '../../tools/entity-utils.js';
import { configureMovements, stopPathfinder } from '../../tools/movement-utils.js';
import { describeTarget, needsTarget, resolveTarget, TARGET_REQUIRED, targetLabel, targetShape } from './target.js';
import { collectNearbyDrops, DeadlineReached, StepContext, waitWhilePaused, walkTo } from './actions.js';

export const DEFAULT_LEAD_TIMEOUT_MS = 300000;
export const MAX_LEAD_TIMEOUT_MS = 900000;
// A lead breaks at 10 blocks: wait for the animal from this far.
export const LEASH_WAIT_DISTANCE = 6;
const LEASH_STEP = 6;
// An animal follows a player holding its food from up to 10 blocks.
export const LURE_FOLLOW_DISTANCE = 5;
export const LURE_LOST_DISTANCE = 8;
export const LURE_STEP = 4;
const LURE_WAIT_MS = 3000;
const APPROACH_RANGE = 3;
export const STUCK_MS = 30000;
const LOST_MS = 10000;
const STEP_TIMEOUT_MS = 15000;
const TICK_MS = 250;
const LEASH_CHECK_MS = 1000;
const LEAD_ITEM = 'lead';
const LEAD_BREAK_DISTANCE = 10.5;
// A following animal stops 2-3 blocks short of the bot, so from the target the bot walks on this far past it.
const OVERSHOOT = 2.5;

/** The foods each animal follows in the game (its tempt items); animals not listed can only be led on a lead. */
export const TEMPT_ITEMS: Record<string, string[]> = {
  cow: ['wheat'], mooshroom: ['wheat'], sheep: ['wheat'], goat: ['wheat'],
  pig: ['carrot', 'potato', 'beetroot'],
  chicken: ['wheat_seeds', 'melon_seeds', 'pumpkin_seeds', 'beetroot_seeds', 'torchflower_seeds', 'pitcher_pod'],
  rabbit: ['carrot', 'golden_carrot', 'dandelion'],
  llama: ['hay_block'], trader_llama: ['hay_block'], camel: ['cactus'], turtle: ['seagrass'], frog: ['slime_ball'],
  strider: ['warped_fungus'], hoglin: ['crimson_fungus'], armadillo: ['spider_eye'], sniffer: ['torchflower_seeds'],
  cat: ['cod', 'salmon'], ocelot: ['cod', 'salmon'], panda: ['bamboo']
};

const ANIMAL_TYPES = new Set(['animal', 'passive', 'water_creature', 'ambient']);

const schema = z.object({
  ...targetShape,
  x: z.coerce.number().finite().describe('Target X'),
  y: z.coerce.number().finite().describe('Target Y'),
  z: z.coerce.number().finite().describe('Target Z'),
  range: z.coerce.number().finite().min(1).max(8).default(2).describe('How close to the target the animal must get (default: 2)'),
  method: z.enum(['auto', 'leash', 'lure']).default('auto').describe("'leash' uses a lead, 'lure' holds the animal's food, 'auto' a lead when the bot has one (default: auto)"),
  item: z.string().trim().min(1).optional().describe('Food to lure with (default: one the animal follows, from the inventory)'),
  timeoutMs: z.coerce.number().int().min(1000).max(MAX_LEAD_TIMEOUT_MS).default(DEFAULT_LEAD_TIMEOUT_MS)
    .describe(`Give up after this many milliseconds (default: ${DEFAULT_LEAD_TIMEOUT_MS})`)
}).refine(needsTarget, TARGET_REQUIRED);

type LeadParams = z.infer<typeof schema>;
type Prepared = { animal: BotEntity; method: 'leash' | 'lure'; lure: string | null };

function itemCount(bot: mineflayer.Bot, name: string): number {
  return bot.inventory.items().filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
}

// How far standableTarget moves a target up or down to find a cell to stand in.
const TARGET_ADJUST = 3;

/**
 * The cell to lead to: the given one, or the nearest standable cell within 3 above or below it. In the field test the
 * target was the grass block inside the pen (its floor one higher), the pathfinder found no way into a solid cell,
 * and the bot wandered off.
 */
export function standableTarget(bot: mineflayer.Bot, target: Vec3): Vec3 {
  const cell = target.floored();
  const solid = (pos: Vec3) => {
    const block = bot.blockAt?.(pos) as { boundingBox?: string } | null | undefined;
    return block ? block.boundingBox === 'block' : null;
  };
  const standable = (pos: Vec3) => solid(pos) === false && solid(pos.offset(0, 1, 0)) === false && solid(pos.offset(0, -1, 0)) === true;
  if (solid(cell) === null || standable(cell)) return cell;
  for (let d = 1; d <= TARGET_ADJUST; d++) {
    if (standable(cell.offset(0, d, 0))) return cell.offset(0, d, 0);
    if (standable(cell.offset(0, -d, 0))) return cell.offset(0, -d, 0);
  }
  return cell;
}

/** The lure the bot would hold for this animal: the one asked for, or the first tempt item it has. */
export function chooseLure(bot: mineflayer.Bot, animal: string, asked?: string): { item: string } | { error: string } {
  const tempts = TEMPT_ITEMS[animal] ?? [];
  if (asked) {
    if (itemCount(bot, asked) === 0) return { error: `No ${asked} in the inventory` };
    if (tempts.length > 0 && !tempts.includes(asked)) return { error: `A ${animal} does not follow ${asked}; it follows ${tempts.join(', ')}` };
    return { item: asked };
  }
  if (tempts.length === 0) return { error: `A ${animal} follows no food; lead it on a lead instead` };
  const held = tempts.find(name => itemCount(bot, name) > 0);
  return held ? { item: held } : { error: `No food a ${animal} follows in the inventory (it follows ${tempts.join(', ')})` };
}

export const leadBehavior: BehaviorDefinition<LeadParams, Prepared> = {
  name: 'lead',
  description: 'Lead one animal to a point, on a lead or by holding a food it follows',
  schema,
  summarize: params => `${describeTarget(params)} to (${Math.floor(params.x)}, ${Math.floor(params.y)}, ${Math.floor(params.z)})`,
  prepare: (bot, params) => {
    const resolved = resolveTarget(bot, params);
    if ('error' in resolved) return resolved;
    const animal = resolved.value;
    if (!ANIMAL_TYPES.has(String(animal.type)) || animal.username) return { error: `${targetLabel(animal)} is not an animal` };
    const hasLead = itemCount(bot, LEAD_ITEM) > 0;
    if (params.method === 'leash') {
      return hasLead ? { value: { animal, method: 'leash', lure: null } } : { error: 'No lead in the inventory (method leash)' };
    }
    if (params.method === 'auto' && hasLead) {
      // A lure as well, if there is one, for when the lead does not hold.
      const lure = chooseLure(bot, animal.name ?? '', params.item);
      return { value: { animal, method: 'leash', lure: 'item' in lure ? lure.item : null } };
    }
    const lure = chooseLure(bot, animal.name ?? '', params.item);
    return 'error' in lure ? lure : { value: { animal, method: 'lure', lure: lure.item } };
  },
  async run(ctx) {
    const { bot, params, prepared, setStep, report } = ctx;
    const target = standableTarget(bot, new Vec3(params.x, params.y, params.z));
    const deadline = Date.now() + params.timeoutMs;
    const started = Date.now();
    let animal = prepared.animal;
    const label = targetLabel(animal);
    let method = prepared.method;
    let leashed = false;

    const live = async (): Promise<BotEntity> => {
      const lostAt = Date.now();
      for (;;) {
        const found = refreshEntity(bot, animal);
        if (found) return (animal = found);
        if (Date.now() - lostAt > LOST_MS) throw new Error(`${label} was lost (not seen for ${LOST_MS / 1000}s)`);
        await delay(TICK_MS, ctx.signal);
      }
    };
    const toTarget = (entity: BotEntity) => entity.position.distanceTo(target);
    const toBot = (entity: BotEntity) => entity.position.distanceTo(bot.entity.position);
    // `released`: the distance when the lead came off (E-056); by lure, where the animal is now.
    const done = (entity: BotEntity, released?: number) => {
      const how = method === 'leash' ? 'on a lead' : `by lure (${prepared.lure})`;
      const where = released === undefined
        ? `it is ${toTarget(entity).toFixed(1)} blocks from the target`
        : `it was ${released.toFixed(1)} blocks from the target when the lead came off`;
      return `Led ${label} to (${Math.floor(target.x)}, ${Math.floor(target.y)}, ${Math.floor(target.z)}) ${how} in ${Math.round((Date.now() - started) / 1000)}s; ${where}`;
    };
    const timeUp = async () => `time limit reached; ${label} is ${toTarget(await live()).toFixed(1)} blocks from the target`;

    try {
      if (method === 'leash') {
        leashed = await attachLead(ctx, await live(), deadline, report);
        if (!leashed) {
          if (params.method === 'leash' || !prepared.lure) throw new Error(`could not put the lead on ${label}`);
          report(`the lead did not hold; luring with ${prepared.lure} instead`);
          method = 'lure';
        } else {
          report(`${label} is on the lead`);
        }
      }
      if (method === 'lure') {
        await bot.equip(bot.inventory.items().find(item => item.name === prepared.lure)!, 'hand');
        report(`luring ${label} with ${prepared.lure}`);
      }

      let best = toTarget(await live());
      let bestAt = Date.now();
      // Walking to the animal is progress too, while the bot gets closer to it than ever before (field test: a cow
      // 30 blocks up a hill counted as "stopped following" before the bot had set off). Walking back again to an
      // animal that does not follow is not, so that one still ends as stopped following.
      let closestGap = Infinity;
      for (;;) {
        if (!(await waitWhilePaused(ctx, deadline))) throw new Error(await timeUp());
        // The pathfinder equips tools and blocks when it digs or builds (walking back, or an instinct action between
        // strides): without the food in hand the animal stops following (field test).
        if (method === 'lure' && bot.heldItem?.name !== prepared.lure) {
          const food = bot.inventory.items().find(item => item.name === prepared.lure);
          if (!food) throw new Error(`no ${prepared.lure} left to lure ${label} with`);
          await bot.equip(food, 'hand');
        }
        const entity = await live();
        const remaining = toTarget(entity);
        if (remaining <= params.range) {
          if (leashed) {
            // A freed animal wanders off at once, so the distance is taken when the lead comes off, not after it has
            // been picked up (2.4 to 3.4 s later in the field test, by then up to 3.4 blocks): E-056.
            const released = await releaseLead(ctx, entity, deadline, () => toTarget(entity));
            leashed = false;
            return done(entity, released);
          }
          return done(entity);
        }
        if (remaining < best - 0.5) {
          best = remaining;
          bestAt = Date.now();
        } else if (Date.now() - bestAt > STUCK_MS) {
          throw new Error(`${label} stopped following: no closer to the target for ${STUCK_MS / 1000}s (${remaining.toFixed(1)} blocks away)`);
        }

        const gap = toBot(entity);
        if (method === 'leash' && leashed && gap > LEAD_BREAK_DISTANCE) {
          // A lead breaks (and drops) once the animal is 10 blocks away: carry on by lure if possible.
          leashed = false;
          if (!prepared.lure) throw new Error(`the lead broke and ${label} is ${gap.toFixed(1)} blocks away`);
          method = 'lure';
          await bot.equip(bot.inventory.items().find(item => item.name === prepared.lure)!, 'hand');
          report(`the lead broke; luring with ${prepared.lure}`);
          continue;
        }
        const waitFrom = method === 'leash' ? LEASH_WAIT_DISTANCE : LURE_FOLLOW_DISTANCE;
        if (method === 'lure' && gap > LURE_LOST_DISTANCE) {
          if (gap < closestGap - 0.5) {
            closestGap = gap;
            bestAt = Date.now();
          }
          setStep(`walking back to ${label} (${gap.toFixed(1)} blocks away)`);
          // The usual settings: nothing follows the bot on the way back.
          await step(ctx, new goals.GoalNear(entity.position.x, entity.position.y, entity.position.z, APPROACH_RANGE), deadline, { gentle: false });
          continue;
        }
        if (gap > waitFrom) {
          setStep(`waiting for ${label} to catch up (${gap.toFixed(1)} blocks away)`);
          stopPathfinder(bot);
          await bot.lookAt(entity.position.offset(0, entity.height ?? 1, 0), true).catch(() => {});
          await delay(method === 'lure' ? LURE_WAIT_MS : TICK_MS * 4, ctx.signal);
          continue;
        }
        const stride = method === 'leash' ? LEASH_STEP : LURE_STEP;
        const botLeft = bot.entity.position.distanceTo(target);
        if (botLeft <= 1.5) {
          // At the target the animal stops short of the bot: walk on past the target, away from the animal.
          const away = target.minus(entity.position);
          away.y = 0;
          const length = Math.hypot(away.x, away.z) || 1;
          const past = target.offset((away.x / length) * OVERSHOOT, 0, (away.z / length) * OVERSHOOT);
          setStep(`drawing ${label} onto the target (${remaining.toFixed(1)} blocks away)`);
          await step(ctx, new goals.GoalNear(past.x, past.y, past.z, 1), deadline);
          await delay(LURE_WAIT_MS, ctx.signal);
          continue;
        }
        // One step closer along the pathfinder's own way: within (distance - step) of the target.
        setStep(`walking ${label} toward the target (${remaining.toFixed(1)} blocks to go)`);
        await step(ctx, new goals.GoalNear(target.x, target.y, target.z, Math.max(0, Math.floor(botLeft - stride))), deadline);
        await delay(TICK_MS, ctx.signal);
      }
    } catch (error) {
      if (error instanceof DeadlineReached) throw new Error(await timeUp());
      // A lead left on a cancelled or failed task is said, not undone: the body may already belong to someone else.
      if (leashed && !ctx.signal.aborted) report(`${label} is still on the lead`);
      throw error;
    } finally {
      stopPathfinder(bot);
    }
  }
};

// How far down the bot may drop while an animal follows it.
const ANIMAL_DROP_DOWN = 3;

/**
 * The pathfinder settings for a way an animal can follow (field test, M18): no digging, no scaffolding, no parkour
 * jumps and no sprinting. With the usual settings the bot climbed a 6-block bank the chicken could not, and left it
 * behind. Null when the bot has no pathfinder movements to start from (test fakes).
 */
function animalMovements(bot: mineflayer.Bot): unknown {
  const current = (bot.pathfinder as { movements?: unknown } | undefined)?.movements;
  if (!current || !(bot as { registry?: unknown }).registry) return null;
  const movements = new Movements(bot, minecraftData(bot.version)) as unknown as {
    canDig: boolean; allowParkour: boolean; allow1by1towers: boolean; allowSprinting: boolean; maxDropDown: number; scafoldingBlocks: number[];
  };
  configureMovements(movements as never);
  movements.canDig = false;
  movements.allowParkour = false;
  movements.allow1by1towers = false;
  movements.allowSprinting = false;
  movements.maxDropDown = ANIMAL_DROP_DOWN;
  movements.scafoldingBlocks = [];
  return movements;
}

/**
 * One stride, on animal-friendly settings that are put back afterwards (so an instinct action that takes the body
 * between strides moves as usual). A stride that times out or finds no path is not the end, the loop decides.
 */
async function step(ctx: StepContext, goal: InstanceType<typeof goals.GoalNear>, deadline: number, { gentle: animalWay = true } = {}): Promise<void> {
  const pathfinder = ctx.bot.pathfinder as { movements?: unknown; setMovements?: (movements: unknown) => void };
  const usual = pathfinder.movements;
  const gentle = animalWay ? animalMovements(ctx.bot) : null;
  if (gentle) pathfinder.setMovements?.(gentle);
  try {
    await walkTo(ctx, goal, Math.min(deadline, Date.now() + STEP_TIMEOUT_MS));
  } catch (error) {
    ctx.signal.throwIfAborted();
    if (Date.now() > deadline) throw new DeadlineReached();
    if (!(error instanceof DeadlineReached)) await delay(TICK_MS, ctx.signal);
  } finally {
    if (gentle && usual) pathfinder.setMovements?.(usual);
  }
}

/** Walks up to the animal and puts the lead on; true when the lead count went down within a second. */
async function attachLead(ctx: StepContext, animal: BotEntity, deadline: number, report: (text: string) => void): Promise<boolean> {
  const { bot } = ctx;
  await step(ctx, new goals.GoalNear(animal.position.x, animal.position.y, animal.position.z, 2), deadline, { gentle: false });
  const before = itemCount(bot, LEAD_ITEM);
  await bot.equip(bot.inventory.items().find(item => item.name === LEAD_ITEM)!, 'hand');
  const entity = refreshEntity(bot, animal) ?? animal;
  if (entity.position.distanceTo(bot.entity.position) > 5) {
    report(`could not get close to ${targetLabel(entity)}`);
    return false;
  }
  await bot.activateEntity(entity);
  for (let waited = 0; waited < LEASH_CHECK_MS; waited += TICK_MS) {
    if (itemCount(bot, LEAD_ITEM) < before) return true;
    await delay(TICK_MS, ctx.signal);
  }
  return itemCount(bot, LEAD_ITEM) < before;
}

// A dropped item cannot be picked up for 10 ticks: standing on it at once picks up nothing (live test).
const PICKUP_DELAY_MS = 700;
const PICKUP_TRIES = 3;

/**
 * Takes the lead off (it drops) and picks it up again, trying a few times while the count is not back. Returns what
 * `measure` gave once the lead was off, before the pickup (E-056).
 */
async function releaseLead(ctx: StepContext, animal: BotEntity, deadline: number, measure: () => number): Promise<number> {
  const before = itemCount(ctx.bot, LEAD_ITEM);
  await ctx.bot.activateEntity(animal);
  const released = measure();
  for (let attempt = 0; attempt < PICKUP_TRIES && itemCount(ctx.bot, LEAD_ITEM) <= before; attempt++) {
    await delay(PICKUP_DELAY_MS, ctx.signal);
    await collectNearbyDrops(ctx, animal.position, deadline);
  }
  return released;
}
