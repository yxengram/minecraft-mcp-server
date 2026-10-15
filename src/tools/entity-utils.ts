import type { Bot } from 'mineflayer';
import { formatStat } from '../format.js';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;

export type BotEntity = Bot['entity'];

export interface NearbyEntity {
  entity: BotEntity;
  distance: number;
  details?: string[];
}

const DYE_COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
const SHEEP_SHEARED_FLAG = 0x10;
const SHEEP_COLOR_MASK = 0x0f;
const ARMOR_EQUIPMENT_SLOTS = [5, 4, 3, 2];

type DroppedItem = { name: string; count: number };

/** The item stack a dropped-item entity represents, if any. */
export function droppedItem(entity: BotEntity): DroppedItem | null {
  if (entity.name !== 'item') return null;
  try {
    const item = (entity as { getDroppedItem?: () => DroppedItem | null }).getDroppedItem?.();
    return item ? { name: item.name, count: item.count } : null;
  } catch {
    return null;
  }
}

function metadataValue(bot: Bot, entity: BotEntity, key: string): unknown {
  const keys = (bot.registry as { entitiesByName?: Record<string, { metadataKeys?: string[] }> } | undefined)
    ?.entitiesByName?.[entity.name ?? '']?.metadataKeys;
  const index = keys?.indexOf(key) ?? -1;
  return index >= 0 ? (entity.metadata as unknown[] | undefined)?.[index] : undefined;
}

function customName(entity: BotEntity): string | undefined {
  try {
    const name = entity.getCustomName?.();
    const text = name?.toString().trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

/** Details a player would notice by looking at the entity. */
export function entityDetails(bot: Bot, entity: BotEntity): string[] {
  const details: string[] = [];
  try {
    const name = customName(entity);
    if (name && entity.type !== 'player') details.push(`named "${name}"`);

    if (metadataValue(bot, entity, 'baby') === true) details.push('baby');

    const owner = metadataValue(bot, entity, 'owneruuid');
    if (typeof owner === 'string' && owner) {
      const ownerName = Object.values(bot.players ?? {}).find(player => player.uuid === owner)?.username;
      details.push(ownerName ? `tamed by ${ownerName}` : 'tamed');
    }

    if (entity.name === 'creeper') {
      const swelling = metadataValue(bot, entity, 'swell_dir');
      if (metadataValue(bot, entity, 'is_ignited') === true || (typeof swelling === 'number' && swelling > 0)) {
        details.push('ABOUT TO EXPLODE');
      }
      if (metadataValue(bot, entity, 'is_powered') === true) details.push('charged');
    }

    const wool = metadataValue(bot, entity, 'wool');
    if (typeof wool === 'number') {
      details.push(`${DYE_COLORS[wool & SHEEP_COLOR_MASK]} wool${wool & SHEEP_SHEARED_FLAG ? ', sheared' : ''}`);
    }

    const equipment = (entity.equipment ?? []) as ({ name: string } | null | undefined)[];
    const held = equipment[0];
    if (held?.name) details.push(`holding ${held.name}`);
    const worn = ARMOR_EQUIPMENT_SLOTS.map(slot => equipment[slot]?.name).filter(Boolean);
    if (worn.length > 0) details.push(`wearing ${worn.join(', ')}`);
  } catch {
    // Missing or unexpected metadata should never break entity listings.
  }
  return details;
}

export function entityLabel(entity: BotEntity): string {
  const item = droppedItem(entity);
  if (item) return `${item.name} x${item.count}`;
  return entity.username || entity.name || entity.displayName || entity.type || 'unknown';
}

export function matchesEntityType(entity: BotEntity, type: string): boolean {
  if (!type) return true;
  const normalized = type.toLowerCase();
  if (normalized === 'player') return entity.type === 'player';
  if (normalized === 'mob') return entity.type === 'mob' || entity.type === 'hostile';
  if (normalized === 'hostile') return entity.type === 'hostile';
  return Boolean(entity.name && entity.name.toLowerCase().includes(normalized))
    || Boolean(entity.username && entity.username.toLowerCase() === normalized)
    || Boolean(droppedItem(entity)?.name.includes(normalized));
}

export function findNearbyEntities(
  bot: Bot,
  { type = '', maxDistance = 32 }: { type?: string; maxDistance?: number } = {}
): NearbyEntity[] {
  const self = bot.entity;
  return Object.values(bot.entities ?? {})
    .filter(entity => entity !== self && entity.position && matchesEntityType(entity, type))
    .map(entity => ({ entity, distance: self.position.distanceTo(entity.position) }))
    .filter(({ distance }) => distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance)
    .map(nearby => ({ ...nearby, details: entityDetails(bot, nearby.entity) }));
}

export function formatPosition(position: { x: number; y: number; z: number }): string {
  return `(${Math.floor(position.x)}, ${Math.floor(position.y)}, ${Math.floor(position.z)})`;
}

export function describeEntity({ entity, distance, details = [] }: NearbyEntity): string {
  const kind = droppedItem(entity) ? 'dropped item' : entity.type;
  const parts = [`${entityLabel(entity)} [${kind}]`, `id ${entity.id}`, `at ${formatPosition(entity.position)}`, `${distance.toFixed(1)} blocks away`];
  if (typeof entity.health === 'number') {
    parts.push(`health ${formatStat(entity.health)}`);
  }
  parts.push(...details);
  return parts.join(', ');
}

export function resolveTargetEntity(
  bot: Bot,
  { entityId, type = '', maxDistance }: { entityId?: number; type?: string; maxDistance: number }
): { entity: BotEntity } | { error: string } {
  if (entityId !== undefined) {
    const entity = bot.entities?.[entityId];
    if (!entity || entity === bot.entity) {
      return { error: `No entity with id ${entityId} is currently loaded` };
    }
    return { entity };
  }

  if (type) {
    const nearest = findNearbyEntities(bot, { type, maxDistance })[0];
    if (!nearest) {
      return { error: `No ${type} found within ${maxDistance} blocks` };
    }
    return { entity: nearest.entity };
  }

  return { error: 'Provide either entityId or type' };
}

export async function approachEntity(bot: Bot, entity: BotEntity, reach: number): Promise<void> {
  if (bot.entity.position.distanceTo(entity.position) <= reach) return;
  const { x, y, z } = entity.position;
  await bot.pathfinder.goto(new goals.GoalNear(x, y, z, Math.min(2, reach)));
}
