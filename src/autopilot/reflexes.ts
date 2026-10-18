// Contract: docs/BLUEPRINT.md F-013. The four remaining reflexes, highest priority first. The first two are critical
// (manual commands wait for them); self-defense and auto-eat are routine (manual commands interrupt them). Fire, lava
// and water moved to the instinct in M8 (F-036 to F-040); the rest follow in M9.
import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import minecraftData from 'minecraft-data';
import { PRIORITY } from './action-arbiter.js';
import { checkTarget, isPlayer, isTamed, NEUTRAL_MOBS, ThreatSummary } from './threats.js';
import { ATTACK_REACH, bestWeaponName, currentCombatTarget, engage } from './combat.js';
import { delay } from './task-manager.js';
import type { ReflexDefinition, ReflexRunContext } from './reflex-engine.js';
import type { Policy, Stance } from './policy.js';
import type { CombatSituation, CombatStance } from '../decisions/decision-hooks.js';
import { armorPoints } from '../tools/gamestate-tools.js';
import { stopPathfinder } from '../tools/movement-utils.js';
import { BotEntity, entityLabel, refreshEntity } from '../tools/entity-utils.js';
import { describeOffset, isPassable } from '../tools/terrain-utils.js';
import { isHazard, isWater, yawToward } from './hazards.js';

type Block = NonNullable<ReturnType<mineflayer.Bot['blockAt']>>;

const TICK_MS = 50;
export const CREEPER_SAFE_DISTANCE = 8;
const SELF_DEFENSE_FLEE_DISTANCE = 16;
const AUTO_EAT_HOSTILE_RADIUS = 8;
const MAX_SAFE_DROP = 3;
// Not moving this far within a second while running away means the way is blocked: let the pathfinder find one.
const STUCK_MS = 1000;
const STUCK_PROGRESS = 0.5;
const PATHFINDER_FALLBACK_MS = 2000;
const FLEE_GOAL_DISTANCE = 12;
// 'auto' stance without a decision model (M5): fight when healthy and not outnumbered, otherwise flee.
const AUTO_FIGHT_MIN_HEALTH = 10;
const AUTO_FIGHT_MAX_HOSTILES = 2;

// Food that hurts (poison, hunger, teleporting) or is too valuable to eat automatically.
const AVOID_FOODS = new Set([
  'rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken', 'chorus_fruit',
  'golden_apple', 'enchanted_golden_apple', 'golden_carrot', 'suspicious_stew'
]);

function label(entity: BotEntity): string {
  return `${entityLabel(entity)} (id ${entity.id})`;
}

function where(bot: mineflayer.Bot, position: Vec3): string {
  const self = bot.entity.position;
  return describeOffset(Math.round(position.x - self.x), Math.round(position.z - self.z));
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
async function eat(bot: mineflayer.Bot, signal: AbortSignal): Promise<string | null> {
  const food = bestFood(bot);
  if (!food || bot.food >= 20) return null;
  const before = bot.food;
  const previous = bot.heldItem;
  await bot.equip(food, 'hand');
  signal.throwIfAborted();
  const stop = () => {
    try {
      bot.deactivateItem();
    } catch {
      // Not eating any more.
    }
  };
  signal.addEventListener('abort', stop, { once: true });
  try {
    await bot.consume();
  } finally {
    signal.removeEventListener('abort', stop);
  }
  signal.throwIfAborted();
  if (previous && previous.name !== food.name) {
    const again = bot.inventory.items().find(item => item.name === previous.name);
    if (again) await bot.equip(again, 'hand').catch(() => {});
  }
  return `ate ${food.name} (food ${before} → ${bot.food})`;
}

// ---- the reflexes ------------------------------------------------------------------------------------------------

const creeperEvade: ReflexDefinition = {
  name: 'creeper-evade',
  priority: PRIORITY.CRITICAL_REFLEX,
  cooldownMs: 500,
  maxDurationMs: 3000,
  enabled: policy => policy.reflexes.creeperEvade.enabled,
  trigger: ({ bot, threats }) => {
    const creeper = threats.creeper;
    if (!creeper) return null;
    return { fire: `${label(creeper.entity)} about to explode ${where(bot, creeper.entity.position)}` };
  },
  async run({ bot, signal, threats }) {
    const creeper = threats.creeper!.entity;
    let live: BotEntity | null = creeper;
    const distance = () => (live ? bot.entity.position.distanceTo(live.position) : Infinity);
    await runAway(bot, signal, () => {
      live = refreshEntity(bot, creeper);
      return live ? [live.position] : [];
    }, () => distance() >= CREEPER_SAFE_DISTANCE);
    return live ? `moved ${distance().toFixed(1)} blocks away` : 'the creeper is gone';
  }
};

const lowHealthRetreat: ReflexDefinition = {
  name: 'low-health-retreat',
  priority: PRIORITY.CRITICAL_REFLEX,
  cooldownMs: 5000,
  maxDurationMs: 10000,
  enabled: policy => policy.reflexes.lowHealthRetreat.enabled,
  trigger: ({ policy, threats }) => {
    const { health, radius } = policy.reflexes.lowHealthRetreat;
    const current = threats.health;
    // Also at combat.retreatHealth, where fights disengage: that handoff relies on this reflex to move away (F-011).
    if (current === undefined || (current >= health && current > policy.combat.retreatHealth)) return null;
    const near = threats.hostiles.filter(threat => threat.distance <= radius);
    if (near.length === 0) return null;
    return { fire: `health ${current} with ${near.length} hostile(s) within ${radius} blocks (nearest ${label(near[0].entity)})` };
  },
  async run({ bot, signal, policy, threats }) {
    const radius = policy.reflexes.lowHealthRetreat.radius;
    const hostiles = threats.hostiles.filter(threat => threat.distance <= radius).map(threat => threat.entity);
    const near = () => hostiles.map(entity => refreshEntity(bot, entity)).filter((entity): entity is BotEntity =>
      Boolean(entity) && entity!.position.distanceTo(bot.entity.position) <= radius);
    await runAway(bot, signal, () => near().map(entity => entity.position), () => near().length === 0);
    if (bot.pathfinder.goal) bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    const ate = await eat(bot, signal).catch(error => {
      signal.throwIfAborted();
      return `could not eat: ${error instanceof Error ? error.message : error}`;
    });
    return `got more than ${radius} blocks away from the hostiles${ate ? `; ${ate}` : ''}`;
  }
};

// judgeable: the stance was 'auto' against a legal hostile, so the decision model may refine the rule's choice (M5).
type DefensePlan = { act: 'fight' | 'flee'; reason: string; judgeable: boolean } | { note: string };

/** What self-defense does about a hit: fight or flee (by stance), or only report it. Never against players (I1). */
function defensePlan(bot: mineflayer.Bot, attacker: BotEntity, policy: Policy, threats: ThreatSummary, type: string): DefensePlan {
  if (isPlayer(attacker)) return { note: `hit by player ${label(attacker)}; not fighting back (players are never attacked by reflexes)` };
  const rules = { attackPlayers: false, avoidNeutral: policy.combat.avoidNeutral };
  const legality = checkTarget(bot, attacker, rules);
  if (!legality.legal) {
    // A neutral mob that turned on the bot (iron golem, wolf pack, zombified piglins) is not fought by default: run.
    if (attacker.name && NEUTRAL_MOBS.has(attacker.name) && !isTamed(bot, attacker)) {
      return { act: 'flee', reason: `hit by ${label(attacker)} (${type}); neutral mobs are not fought (avoidNeutral) → flee`, judgeable: false };
    }
    return { note: `hit by ${label(attacker)}; not fighting back (${legality.reason})` };
  }
  const stance = policy.reflexes.selfDefense.stance;
  // The attacker counts even when it is not on the hostile list (a neutral mob with avoidNeutral off).
  const hostiles = threats.hostiles.length + (threats.hostiles.some(threat => threat.entity.id === attacker.id) ? 0 : 1);
  const act = resolveStance(stance, threats.health, hostiles);
  return { act, reason: `hit by ${label(attacker)} (${type}); stance ${stance} → ${act}`, judgeable: stance === 'auto' };
}

function resolveStance(stance: Stance, health: number | undefined, hostiles: number): 'fight' | 'flee' {
  if (stance !== 'auto') return stance;
  return (health ?? 20) >= AUTO_FIGHT_MIN_HEALTH && hostiles <= AUTO_FIGHT_MAX_HOSTILES ? 'fight' : 'flee';
}

const selfDefense: ReflexDefinition = {
  name: 'self-defense',
  priority: PRIORITY.ROUTINE_REFLEX,
  cooldownMs: 2000,
  maxDurationMs: 20000,
  enabled: policy => policy.reflexes.selfDefense.enabled,
  trigger: ({ bot, damage, policy, threats }) => {
    if (damage?.attackerId === undefined) return null;
    const attacker = bot.entities?.[damage.attackerId];
    if (!attacker || attacker === bot.entity) return null;
    // Already fighting it (a guard or hunt task, or self-defense itself): getting hit back is part of that fight.
    if (currentCombatTarget(bot) === attacker.id) return null;
    const plan = defensePlan(bot, attacker, policy, threats, damage.type);
    return 'note' in plan ? plan : { fire: plan.reason };
  },
  async run({ bot, signal, policy, damage, threats, judgeCombat }) {
    const attacker = bot.entities[damage!.attackerId!];
    const plan = defensePlan(bot, attacker, policy, threats, damage!.type);
    if ('note' in plan) return plan.note;

    // 'auto': act on the rule at once and switch if the decision model, asked in the background, disagrees (F-013).
    let mode = plan.act as CombatStance;
    let switchTo: CombatStance | null = null;
    let via = plan.judgeable ? 'rule' : 'policy';
    const run = { alive: true };
    let situation: CombatSituation | null = null;
    try {
      if (plan.judgeable && judgeCombat) situation = combatSituation(bot, attacker, threats);
    } catch {
      // Without the facts there is nothing to ask: the rule decides (I5).
    }
    if (situation && judgeCombat) {
      judgeCombat(attacker.id, situation).then(judgment => {
        // An answer that arrives after the reflex ended is only recorded (the judge writes the event).
        if (!run.alive || !('stance' in judgment)) return;
        via = `${judgment.source} p=${judgment.probability.toFixed(2)}`;
        if (judgment.stance !== mode) switchTo = judgment.stance;
      }).catch(() => {});
    }

    try {
      for (;;) {
        const switching = () => switchTo !== null;
        let result: string;
        if (mode === 'fight') {
          const fight = await engage(bot, attacker, {
            signal,
            shouldStop: switching,
            maxChase: SELF_DEFENSE_FLEE_DISTANCE,
            retreatHealth: policy.combat.retreatHealth,
            rules: { attackPlayers: false, avoidNeutral: policy.combat.avoidNeutral }
          });
          result = `fought back: ${fight.detail}`;
        } else if (mode === 'hold') {
          result = await holdGround(bot, attacker, signal, switching, policy);
        } else {
          let live: BotEntity | null = attacker;
          await runAway(bot, signal, () => {
            live = refreshEntity(bot, attacker);
            return live ? [live.position] : [];
          }, () => switching() || !live || bot.entity.position.distanceTo(live.position) >= SELF_DEFENSE_FLEE_DISTANCE);
          result = `fled from ${label(attacker)}`;
        }
        signal.throwIfAborted();
        if (switchTo) {
          // Still our lease: clear the previous mode's goal and keys before the next one takes over.
          stopPathfinder(bot);
          bot.clearControlStates();
          mode = switchTo;
          switchTo = null;
          continue;
        }
        return `${result} (${mode} by ${via})`;
      }
    } finally {
      run.alive = false;
    }
  }
};

/** The facts the decision model sees about a fight: numbers and mob types only, never names. */
function combatSituation(bot: mineflayer.Bot, attacker: BotEntity, threats: ThreatSummary): CombatSituation {
  const within = threats.hostiles.filter(threat => threat.distance <= SELF_DEFENSE_FLEE_DISTANCE);
  const hostiles = within.map(threat => ({ type: threat.entity.name ?? 'unknown', distance: threat.distance }));
  if (!within.some(threat => threat.entity.id === attacker.id)) {
    hostiles.unshift({ type: attacker.name ?? 'unknown', distance: bot.entity.position.distanceTo(attacker.position) });
  }
  return {
    health: typeof bot.health === 'number' ? bot.health : 20,
    food: typeof bot.food === 'number' ? bot.food : 20,
    armorPoints: armorPoints(bot),
    weapon: bestWeaponName(bot),
    attacker: { type: attacker.name ?? 'unknown', distance: bot.entity.position.distanceTo(attacker.position) },
    hostiles
  };
}

/**
 * 'hold' (tentative, F-016): stand still and hit the attacker only while it is within reach; never chase, never run.
 * Ends when the attacker is gone or more than 16 blocks away.
 */
async function holdGround(bot: mineflayer.Bot, attacker: BotEntity, signal: AbortSignal, switching: () => boolean, policy: Policy): Promise<string> {
  const post = bot.entity.position.clone();
  for (;;) {
    signal.throwIfAborted();
    if (switching()) return `held ground against ${label(attacker)}`;
    const live = refreshEntity(bot, attacker);
    if (!live) return `held ground; ${label(attacker)} is gone`;
    const distance = bot.entity.position.distanceTo(live.position);
    if (distance > SELF_DEFENSE_FLEE_DISTANCE) return `held ground; ${label(attacker)} left`;
    if (distance <= ATTACK_REACH) {
      const fight = await engage(bot, live, {
        signal,
        shouldStop: switching,
        maxChase: ATTACK_REACH,
        anchor: () => post,
        retreatHealth: policy.combat.retreatHealth,
        rules: { attackPlayers: false, avoidNeutral: policy.combat.avoidNeutral }
      });
      if (fight.outcome === 'killed' || fight.outcome === 'retreated' || fight.outcome === 'illegal_target') return `held ground: ${fight.detail}`;
    } else {
      void bot.lookAt(live.position.offset(0, (live.height ?? 1) * 0.9, 0), true).catch(() => {});
    }
    await delay(TICK_MS, signal);
  }
}

const autoEat: ReflexDefinition = {
  name: 'auto-eat',
  priority: PRIORITY.ROUTINE_REFLEX,
  cooldownMs: 5000,
  maxDurationMs: 3000,
  enabled: policy => policy.reflexes.autoEat.enabled,
  trigger: ({ bot, policy, threats }) => {
    const threshold = policy.reflexes.autoEat.food;
    if (typeof bot.food !== 'number' || bot.food >= threshold || bot.food >= 20) return null;
    if (threats.hostiles.some(threat => threat.distance <= AUTO_EAT_HOSTILE_RADIUS)) return null;
    const food = bestFood(bot);
    return food ? { fire: `food ${bot.food} below ${threshold}; eating ${food.name}` } : null;
  },
  async run({ bot, signal }: ReflexRunContext) {
    return (await eat(bot, signal)) ?? 'nothing to eat';
  }
};

/** All reflexes, highest priority first (BLUEPRINT F-013). */
export const REFLEXES: ReflexDefinition[] = [creeperEvade, lowHealthRetreat, selfDefense, autoEat];
