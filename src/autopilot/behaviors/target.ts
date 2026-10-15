import { z } from 'zod';
import type mineflayer from 'mineflayer';
import { BotEntity, entityLabel, resolveTargetEntity } from '../../tools/entity-utils.js';

export const DEFAULT_SEARCH_DISTANCE = 32;

export const targetShape = {
  entityId: z.coerce.number().int().optional().describe('Entity id from list-entities'),
  target: z.string().trim().min(1).optional().describe('Player name or entity type, used when no entityId is given'),
  maxDistance: z.coerce.number().finite().positive().default(DEFAULT_SEARCH_DISTANCE).describe(`Search distance (default: ${DEFAULT_SEARCH_DISTANCE})`)
};

export const needsTarget = (params: { entityId?: number; target?: string }) => params.entityId !== undefined || params.target !== undefined;
export const TARGET_REQUIRED = 'Provide entityId or target';

export function resolveTarget(bot: mineflayer.Bot, params: { entityId?: number; target?: string; maxDistance: number }): { error: string } | { value: BotEntity } {
  const resolved = resolveTargetEntity(bot, { entityId: params.entityId, type: params.target, maxDistance: params.maxDistance });
  return 'error' in resolved ? resolved : { value: resolved.entity };
}

export function describeTarget(params: { entityId?: number; target?: string }): string {
  return params.target ?? `entity ${params.entityId}`;
}

export function targetLabel(entity: BotEntity): string {
  return `${entityLabel(entity)} (id ${entity.id})`;
}
