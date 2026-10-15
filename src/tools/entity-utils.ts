import type { Bot } from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;

export type BotEntity = Bot['entity'];

export interface NearbyEntity {
  entity: BotEntity;
  distance: number;
}

export function entityLabel(entity: BotEntity): string {
  return entity.username || entity.name || entity.displayName || entity.type || 'unknown';
}

export function matchesEntityType(entity: BotEntity, type: string): boolean {
  if (!type) return true;
  const normalized = type.toLowerCase();
  if (normalized === 'player') return entity.type === 'player';
  if (normalized === 'mob') return entity.type === 'mob' || entity.type === 'hostile';
  if (normalized === 'hostile') return entity.type === 'hostile';
  return Boolean(entity.name && entity.name.toLowerCase().includes(normalized))
    || Boolean(entity.username && entity.username.toLowerCase() === normalized);
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
    .sort((a, b) => a.distance - b.distance);
}

export function formatPosition(position: { x: number; y: number; z: number }): string {
  return `(${Math.floor(position.x)}, ${Math.floor(position.y)}, ${Math.floor(position.z)})`;
}

export function describeEntity({ entity, distance }: NearbyEntity): string {
  const parts = [`${entityLabel(entity)} [${entity.type}]`, `id ${entity.id}`, `at ${formatPosition(entity.position)}`, `${distance.toFixed(1)} blocks away`];
  if (typeof entity.health === 'number') {
    parts.push(`health ${entity.health}`);
  }
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
