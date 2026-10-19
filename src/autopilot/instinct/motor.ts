// Contract: docs/BLUEPRINT.md F-042. Motor code the macros share: running away safely, eating, holding ground. Moved
// unchanged from the reflexes (M3-M5, verified live); it decides nothing about what to do.
import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import minecraftData from 'minecraft-data';
import { ATTACK_REACH, engage } from '../combat.js';
import { delay } from '../task-manager.js';
import type { Policy } from '../policy.js';
import { BotEntity, entityLabel, refreshEntity } from '../../tools/entity-utils.js';
import { isPassable } from '../../tools/terrain-utils.js';
import { isHazard, isWater, yawToward } from '../hazards.js';

type Block = NonNullable<ReturnType<mineflayer.Bot['blockAt']>>;

const TICK_MS = 50;
const MAX_SAFE_DROP = 3;
// Not moving this far within a second while running away means the way is blocked: let the pathfinder find one.
const STUCK_MS = 1000;
const STUCK_PROGRESS = 0.5;
const PATHFINDER_FALLBACK_MS = 2000;
const FLEE_GOAL_DISTANCE = 12;
const HOLD_RANGE = 16;

// Food that hurts (poison, hunger, teleporting) or is too valuable to eat automatically.
const AVOID_FOODS = new Set([
  'rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken', 'chorus_fruit',
  'golden_apple', 'enchanted_golden_apple', 'golden_carrot', 'suspicious_stew'
]);

export function label(entity: BotEntity): string {
  return `${entityLabel(entity)} (id ${entity.id})`;
}

// ---- running away ------------------------------------------------------------------------------------------------

// Blocks the bot must not run into, on top of the hazards: cobwebs hold it in place.
const RUN_AVOID_BLOCKS = new Set(['cobweb']);

function blocksRunning(block: Block | null): boolean {
  return isHazard(block) || Boolean(block && RUN_AVOID_BLOCKS.has(block.name));
}

/** Height of a block's collision box; fences, walls and gates are 1.5 and cannot be jumped onto. */
function collisionTop(block: Block): number {
  return (block.shapes ?? []).reduce((top, shape) => Math.max(top, shape[4] ?? 0), 0);
}

/** Whether walking two blocks in this direction keeps the bot out of hazards and away from drops over 3 blocks. */
function directionIsSafe(bot: mineflayer.Bot, direction: Vec3): boolean {
  const feet = bot.entity.position.floored();
  const ownHeadroom = bot.blockAt(feet.offset(0, 2, 0));
  const visited = new Set<string>();
  // 2.2 rather than 2 so a diagonal direction (0.71 per axis) also reaches the second column out.
  for (const steps of [1, 2.2]) {
    const dx = Math.round(direction.x * steps);
    const dz = Math.round(direction.z * steps);
    const column = feet.offset(dx, 0, dz);
    if (column.equals(feet) || visited.has(column.toString())) continue;
    visited.add(column.toString());

    // Moving diagonally, the bot's 0.6-wide body also brushes the two side columns of the corner.
    if (dx !== 0 && dz !== 0) {
      for (const side of [feet.offset(dx, 0, dz - Math.sign(dz)), feet.offset(dx - Math.sign(dx), 0, dz)]) {
        if (blocksRunning(bot.blockAt(side)) || blocksRunning(bot.blockAt(side.offset(0, 1, 0)))) return false;
      }
    }

    const body = bot.blockAt(column);
    const head = bot.blockAt(column.offset(0, 1, 0));
    if (!body || !head || blocksRunning(body) || blocksRunning(head)) return false;
    if (!isPassable(body) || !isPassable(head)) {
      // One block in the way is fine if the bot can jump onto it: at most a full block tall (not a fence or wall),
      // with room above it and above the bot's own head.
      const above = bot.blockAt(column.offset(0, 2, 0));
      const jumpable = visited.size === 1 && isPassable(head) && above && isPassable(above)
        && collisionTop(body) <= 1 && ownHeadroom && isPassable(ownHeadroom);
      if (jumpable) continue;
      return false;
    }
    let ground = column.offset(0, -1, 0);
    let drop = 0;
    for (let block = bot.blockAt(ground); block && isPassable(block) && drop <= MAX_SAFE_DROP; block = bot.blockAt(ground)) {
      ground = ground.offset(0, -1, 0);
      drop++;
    }
    const floor = bot.blockAt(ground);
    if (!floor || drop > MAX_SAFE_DROP || blocksRunning(floor)) return false;
  }
  return true;
}

function rotate(direction: Vec3, degrees: number): Vec3 {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return new Vec3(direction.x * cos - direction.z * sin, 0, direction.x * sin + direction.z * cos);
}

function awayFrom(self: Vec3, threats: Vec3[]): Vec3 {
  const centroid = threats.reduce((sum, position) => sum.add(position), new Vec3(0, 0, 0)).scaled(1 / threats.length);
  const away = new Vec3(self.x - centroid.x, 0, self.z - centroid.z);
  const length = Math.hypot(away.x, away.z);
  // Standing right on top of the threat: any direction will do.
  return length < 1e-6 ? new Vec3(1, 0, 0) : away.scaled(1 / length);
}

/**
 * Runs from the given positions until `done()` says so. Sprinting with control states starts on the same tick (a
 * creeper fuse is only 1.5 s), with a safety check two blocks ahead; when no direction is safe or the bot is stuck,
 * the pathfinder takes over for a moment. Controls are set again every tick, because a manual command that was
 * preempted may still clear them when its own timer fires.
 */
export async function runAway(
  bot: mineflayer.Bot,
  signal: AbortSignal,
  threats: () => Vec3[],
  done: () => boolean
): Promise<void> {
  let checkpoint = { position: bot.entity.position.clone(), time: Date.now() };
  let pathfinderUntil = 0;
  let fleeGoal: InstanceType<typeof goals.GoalXZ> | null = null;

  while (!done()) {
    signal.throwIfAborted();
    const positions = threats();
    if (positions.length === 0) return;
    const self = bot.entity.position;
    const away = awayFrom(self, positions);
    const now = Date.now();

    if (now - checkpoint.time >= STUCK_MS) {
      if (self.distanceTo(checkpoint.position) < STUCK_PROGRESS) pathfinderUntil = now + PATHFINDER_FALLBACK_MS;
      checkpoint = { position: self.clone(), time: now };
    }

    const direction = now < pathfinderUntil
      ? null
      : [0, 45, -45, 90, -90].map(angle => rotate(away, angle)).find(candidate => directionIsSafe(bot, candidate)) ?? null;

    if (direction) {
      if (bot.pathfinder.goal) bot.pathfinder.setGoal(null);
      fleeGoal = null;
      void bot.look(yawToward(direction), 0, true).catch(() => {});
      bot.setControlState('forward', true);
      bot.setControlState('sprint', true);
      const ahead = bot.blockAt(self.floored().offset(Math.round(direction.x), 0, Math.round(direction.z)));
      bot.setControlState('jump', Boolean(ahead && !isPassable(ahead)) || isWater(bot.blockAt(self.floored())));
    } else if (!fleeGoal || bot.pathfinder.goal !== fleeGoal) {
      // Let the pathfinder drive; setGoal clears our controls once and it sets its own on every tick.
      const target = self.plus(away.scaled(FLEE_GOAL_DISTANCE));
      fleeGoal = new goals.GoalXZ(Math.floor(target.x), Math.floor(target.z));
      bot.pathfinder.setGoal(fleeGoal, true);
    }

    await delay(TICK_MS, signal);
  }
}

// ---- eating ------------------------------------------------------------------------------------------------------

type InventoryItem = ReturnType<mineflayer.Bot['inventory']['items']>[number];

export function bestFood(bot: mineflayer.Bot): InventoryItem | null {
  let foods: Record<string, { foodPoints: number; saturation: number }>;
  try {
    foods = minecraftData(bot.version).foodsByName as Record<string, { foodPoints: number; saturation: number }>;
  } catch {
    return null;
  }
  return bot.inventory.items()
    .filter(item => foods[item.name] && !AVOID_FOODS.has(item.name))
    .sort((a, b) => foods[b.name].foodPoints - foods[a.name].foodPoints || foods[b.name].saturation - foods[a.name].saturation)[0] ?? null;
}

/** Eats the best food, then puts the previously held item back in hand. Stops eating at once if aborted. */
// mineflayer's consume() ends as soon as the held item changes, so a late slot update from equipping the food can end
// it at once without eating anything (the survival test's "ate cooked_beef (food 17 → 17) (0.0s)"; E-016).
const EQUIP_SETTLE_MS = 500;
const EAT_SETTLE_MS = 300;

function foodCount(bot: mineflayer.Bot, name: string): number {
  return bot.inventory.items().filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
}

export async function eat(bot: mineflayer.Bot, signal: AbortSignal): Promise<string | null> {
  const food = bestFood(bot);
  if (!food || bot.food >= 20) return null;
  const before = bot.food;
  const previous = bot.heldItem;
  await bot.equip(food, 'hand');
  signal.throwIfAborted();
  for (let waited = 0; bot.heldItem?.name !== food.name && waited < EQUIP_SETTLE_MS; waited += TICK_MS) await delay(TICK_MS, signal);
  // One more tick, so the slot update that confirms the equip has arrived before eating starts.
  await delay(TICK_MS, signal);
  const stop = () => {
    try {
      bot.deactivateItem();
    } catch {
      // Not eating any more.
    }
  };
  let ate = false;
  for (let attempt = 0; attempt < 2 && !ate; attempt++) {
    const start = { count: foodCount(bot, food.name), food: bot.food, saturation: bot.foodSaturation };
    signal.addEventListener('abort', stop, { once: true });
    try {
      await bot.consume();
    } finally {
      signal.removeEventListener('abort', stop);
    }
    signal.throwIfAborted();
    const eaten = () => foodCount(bot, food.name) < start.count || bot.food > start.food || bot.foodSaturation > start.saturation;
    // The slot and hunger updates can come a little after the "finished eating" status.
    for (let waited = 0; !eaten() && waited < EAT_SETTLE_MS; waited += TICK_MS) await delay(TICK_MS, signal);
    ate = eaten();
  }
  if (!ate) throw new Error(`did not eat ${food.name}: eating was interrupted`);
  if (previous && previous.name !== food.name) {
    const again = bot.inventory.items().find(item => item.name === previous.name);
    if (again) await bot.equip(again, 'hand').catch(() => {});
  }
  return `ate ${food.name} (food ${before} → ${bot.food})`;
}

// ---- holding ground ----------------------------------------------------------------------------------------------

/**
 * 'hold' (F-042): stand still and hit the attacker only while it is within reach; never chase, never run.
 * Ends when the attacker is gone or more than 16 blocks away.
 */
export async function holdGround(bot: mineflayer.Bot, attacker: BotEntity, signal: AbortSignal, policy: Policy): Promise<string> {
  const post = bot.entity.position.clone();
  for (;;) {
    signal.throwIfAborted();
    const live = refreshEntity(bot, attacker);
    if (!live) return `held ground; ${label(attacker)} is gone`;
    const distance = bot.entity.position.distanceTo(live.position);
    if (distance > HOLD_RANGE) return `held ground; ${label(attacker)} left`;
    if (distance <= ATTACK_REACH) {
      const fight = await engage(bot, live, {
        signal,
        maxChase: ATTACK_REACH,
        anchor: () => post,
        retreatHealth: policy.combat.retreatHealth,
        rules: { attackPlayers: false, avoidNeutral: policy.combat.avoidNeutral }
      });
      // A macro either does its job or fails and says why (F-039); the menu never offers an illegal target anyway.
      if (fight.outcome === 'illegal_target') throw new Error(fight.detail);
      if (fight.outcome === 'killed' || fight.outcome === 'retreated') return `held ground: ${fight.detail}`;
    } else {
      void bot.lookAt(live.position.offset(0, (live.height ?? 1) * 0.9, 0), true).catch(() => {});
    }
    await delay(TICK_MS, signal);
  }
}
