// Contract: docs/BLUEPRINT.md F-010. Pure reads of the game state: no movement, no decisions, no network.
import type mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { BotEntity, entityLabel, metadataValue } from '../tools/entity-utils.js';
import { airLevel } from '../tools/gamestate-tools.js';

/** The policy's attack rules (F-014 combat group); callers pass the current policy's values. */
export interface CombatRules {
  attackPlayers: boolean;
  /** Leave neutral mobs alone unless their type is named explicitly. */
  avoidNeutral: boolean;
}

export const DEFAULT_COMBAT_RULES: CombatRules = { attackPlayers: false, avoidNeutral: true };

export interface TargetRules extends Partial<CombatRules> {
  /** Entity names the caller asked for explicitly (hunt), which makes passive and neutral mobs of that type legal. */
  allowTypes?: string[];
}

export type TargetCheck = { legal: true } | { legal: false; reason: string };

// Decided by entity name rather than minecraft-data's category, which calls hoglins animals and endermen hostile.
export const HOSTILE_MOBS = new Set([
  'blaze', 'bogged', 'breeze', 'cave_spider', 'creaking', 'creeper', 'drowned', 'elder_guardian', 'ender_dragon',
  'endermite', 'evoker', 'ghast', 'giant', 'guardian', 'hoglin', 'husk', 'illusioner', 'magma_cube', 'phantom',
  'piglin_brute', 'pillager', 'ravager', 'shulker', 'silverfish', 'skeleton', 'slime', 'spider', 'stray', 'vex',
  'vindicator', 'warden', 'witch', 'wither', 'wither_skeleton', 'zoglin', 'zombie', 'zombie_villager'
]);

// Only dangerous when provoked, and hitting one can turn a whole group against the bot (zombified piglins).
// Never attacked unless the caller names the type explicitly. Tentative list (BLUEPRINT F-010).
export const NEUTRAL_MOBS = new Set([
  'enderman', 'piglin', 'zombified_piglin', 'wolf', 'bee', 'polar_bear', 'llama', 'trader_llama', 'panda',
  'goat', 'dolphin', 'iron_golem', 'snow_golem'
]);

export const CREEPER_DANGER_RADIUS = 7;
export const DEFAULT_THREAT_RADIUS = 16;
export const DEFAULT_LOW_HEALTH = 6;
export const DEFAULT_LOW_AIR = 6;
const ON_FIRE_FLAG = 0x01;

export interface Threat {
  entity: BotEntity;
  distance: number;
}

export interface ThreatSummary {
  /** Hostile mobs within the radius, nearest first. */
  hostiles: Threat[];
  /** The nearest swelling or ignited creeper within 7 blocks. */
  creeper: Threat | null;
  /** The most urgent threat: a swelling creeper, otherwise the nearest hostile. */
  top: Threat | null;
  onFire: boolean;
  inLava: boolean;
  /** Air bubbles 0–20, undefined when unknown. */
  air: number | undefined;
  lowAir: boolean;
  health: number | undefined;
  lowHealth: boolean;
  /** Horizontal unit vector pointing away from the hostiles' centroid; zero when there is nothing to flee from. */
  fleeDirection: Vec3;
}

export interface ThreatOptions {
  radius?: number;
  lowHealth?: number;
  lowAir?: number;
}

export function isPlayer(entity: BotEntity): boolean {
  return entity.type === 'player' || Boolean(entity.username);
}

// Horses, donkeys, mules, llamas and camels keep "tamed" as a bit of their flags byte, not as an owner uuid.
const HORSE_FAMILY = new Set(['horse', 'donkey', 'mule', 'llama', 'trader_llama', 'camel', 'skeleton_horse', 'zombie_horse']);
const HORSE_TAMED_FLAG = 0x02;
// Wolves, cats and parrots also set this bit of their flags byte when tamed.
const TAMABLE_TAMED_FLAG = 0x04;
const TAMABLE = new Set(['wolf', 'cat', 'parrot']);

export function isTamed(bot: mineflayer.Bot, entity: BotEntity): boolean {
  if (metadataValue(bot, entity, 'owneruuid')) return true;
  const name = entity.name ?? '';
  const flag = HORSE_FAMILY.has(name) ? HORSE_TAMED_FLAG : TAMABLE.has(name) ? TAMABLE_TAMED_FLAG : 0;
  if (!flag) return false;
  const flags = metadataValue(bot, entity, 'flags');
  return typeof flags === 'number' && (flags & flag) !== 0;
}

export function isSwellingCreeper(bot: mineflayer.Bot, entity: BotEntity): boolean {
  if (entity.name !== 'creeper') return false;
  const swelling = metadataValue(bot, entity, 'swell_dir');
  return metadataValue(bot, entity, 'is_ignited') === true || (typeof swelling === 'number' && swelling > 0);
}

/** Whether the bot may attack this entity. Players only with attackPlayers; tamed animals never (invariant I1). */
export function checkTarget(bot: mineflayer.Bot, entity: BotEntity | null | undefined, rules: TargetRules = {}): TargetCheck {
  try {
    if (!entity || entity === bot.entity) return { legal: false, reason: 'not a valid target' };
    const label = entityLabel(entity);
    if (entity.isValid === false) return { legal: false, reason: `${label} is gone` };

    if (isPlayer(entity)) {
      return (rules.attackPlayers ?? DEFAULT_COMBAT_RULES.attackPlayers)
        ? { legal: true }
        : { legal: false, reason: `${label} is a player; players are never attacked` };
    }

    const name = entity.name;
    if (!name) return { legal: false, reason: 'unknown entity' };
    if (isTamed(bot, entity)) return { legal: false, reason: `${label} is tamed; tamed animals are never attacked` };
    if (rules.allowTypes?.includes(name)) return { legal: true };
    if (NEUTRAL_MOBS.has(name)) {
      return (rules.avoidNeutral ?? DEFAULT_COMBAT_RULES.avoidNeutral)
        ? { legal: false, reason: `${label} is neutral and is only attacked when named explicitly` }
        : { legal: true };
    }
    if (HOSTILE_MOBS.has(name)) return { legal: true };
    return { legal: false, reason: `${label} is not hostile` };
  } catch {
    return { legal: false, reason: 'unreadable entity data' };
  }
}

/**
 * Mobs the bot may attack within `radius` of `center`, nearest to the center first: hostile mobs, plus neutral ones
 * when the policy turned avoidNeutral off.
 */
export function legalHostilesNear(bot: mineflayer.Bot, center: Vec3, radius: number, rules: TargetRules = {}): Threat[] {
  const found: Threat[] = [];
  const withNeutral = (rules.avoidNeutral ?? DEFAULT_COMBAT_RULES.avoidNeutral) === false;
  for (const entity of Object.values(bot.entities ?? {})) {
    try {
      if (!entity?.position || !entity.name || !(HOSTILE_MOBS.has(entity.name) || (withNeutral && NEUTRAL_MOBS.has(entity.name)))) continue;
      const distance = entity.position.distanceTo(center);
      if (distance > radius || !checkTarget(bot, entity, rules).legal) continue;
      found.push({ entity, distance });
    } catch {
      // Skip entities with missing or odd data.
    }
  }
  return found.sort((a, b) => a.distance - b.distance);
}

function onFire(bot: mineflayer.Bot): boolean {
  // Index 0 is the shared flags byte on every entity; bit 0 means burning.
  const flags = (bot.entity?.metadata as unknown[] | undefined)?.[0];
  return typeof flags === 'number' && (flags & ON_FIRE_FLAG) !== 0;
}

function inLava(bot: mineflayer.Bot): boolean {
  const feet = bot.entity.position.floored();
  return bot.blockAt(feet)?.name === 'lava' || bot.blockAt(feet.offset(0, 1, 0))?.name === 'lava';
}

function awayFrom(self: Vec3, threats: Threat[]): Vec3 {
  if (threats.length === 0) return new Vec3(0, 0, 0);
  const centroid = threats
    .reduce((sum, { entity }) => sum.add(entity.position), new Vec3(0, 0, 0))
    .scaled(1 / threats.length);
  const away = new Vec3(self.x - centroid.x, 0, self.z - centroid.z);
  const length = Math.hypot(away.x, away.z);
  return length < 1e-6 ? new Vec3(0, 0, 0) : away.scaled(1 / length);
}

export function assessThreats(bot: mineflayer.Bot, options: ThreatOptions = {}): ThreatSummary {
  const radius = options.radius ?? DEFAULT_THREAT_RADIUS;
  const self = bot.entity.position;
  const hostiles: Threat[] = [];
  let creeper: Threat | null = null;

  for (const entity of Object.values(bot.entities ?? {})) {
    try {
      if (!entity || entity === bot.entity || !entity.position || entity.isValid === false) continue;
      if (!entity.name || !HOSTILE_MOBS.has(entity.name) || isTamed(bot, entity)) continue;
      const distance = self.distanceTo(entity.position);
      if (distance > radius) continue;
      // Read everything before listing it, so an entity whose data throws is skipped entirely.
      const swelling = distance <= CREEPER_DANGER_RADIUS && isSwellingCreeper(bot, entity);
      const threat = { entity, distance };
      hostiles.push(threat);
      if (swelling && (!creeper || distance < creeper.distance)) creeper = threat;
    } catch {
      // Missing or odd entity data is treated as no threat.
    }
  }
  hostiles.sort((a, b) => a.distance - b.distance);

  const air = airLevel(bot);
  const health = typeof bot.health === 'number' ? bot.health : undefined;
  return {
    hostiles,
    creeper,
    top: creeper ?? hostiles[0] ?? null,
    onFire: onFire(bot),
    inLava: inLava(bot),
    air,
    lowAir: air !== undefined && air <= (options.lowAir ?? DEFAULT_LOW_AIR),
    health,
    lowHealth: health !== undefined && health < (options.lowHealth ?? DEFAULT_LOW_HEALTH),
    fleeDirection: awayFrom(self, hostiles)
  };
}
