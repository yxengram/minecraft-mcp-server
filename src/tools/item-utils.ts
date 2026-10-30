import type mineflayer from 'mineflayer';
import minecraftData from 'minecraft-data';
import { componentToText } from '../text-component.js';
import { serverRegistryName } from '../server-registries.js';
import { quoteUntrusted } from '../format.js';

export function resolveItemsByName<T extends { name: string }>(
  items: T[],
  query: string,
  location = 'inventory'
): { items: T[] } | { error: string } {
  const normalized = query.trim().toLowerCase();
  const exact = items.filter(item => item.name === normalized);
  if (exact.length > 0) return { items: exact };

  const partial = items.filter(item => item.name.includes(normalized));
  const names = [...new Set(partial.map(item => item.name))];
  if (names.length === 0) return { error: `Couldn't find any item matching '${query}' in ${location}` };
  if (names.length > 1) return { error: `'${query}' is ambiguous, matches: ${names.join(', ')}. Use the exact name` };
  return { items: partial };
}

export function countItems(items: { count: number }[]): number {
  return items.reduce((sum, item) => sum + item.count, 0);
}

type ItemComponent = { type: string; data: unknown };

export interface DetailedItem {
  name: string;
  count: number;
  maxDurability?: number;
  durabilityUsed?: number;
  customName?: string | null;
  enchants?: { name: string; lvl: number }[];
  components?: ItemComponent[];
}

const ROMAN_LEVELS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

function enchantmentName(bot: mineflayer.Bot, id: number): string {
  return serverRegistryName(bot, 'enchantment', id)
    ?? (minecraftData(bot.version).enchantments as unknown as Record<number, { name?: string }> | undefined)?.[id]?.name
    ?? `enchantment ${id}`;
}

function componentEnchantments(bot: mineflayer.Bot, components: ItemComponent[]): string[] {
  return components
    .filter(component => component.type === 'enchantments' || component.type === 'stored_enchantments')
    .flatMap(component => ((component.data as { enchantments?: { id: number; level: number }[] })?.enchantments ?? [])
      .map(({ id, level }) => `${enchantmentName(bot, id)} ${ROMAN_LEVELS[level - 1] ?? level}`));
}

/** Details shown on an item's tooltip: custom name (raw; callers quote it, E-035), durability and enchantments. */
export function itemDetails(bot: mineflayer.Bot, item: DetailedItem): { customName?: string; details: string[] } {
  const details: string[] = [];
  let customName: string | undefined;
  try {
    const components = Array.isArray(item.components) ? item.components : [];
    const nameComponent = components.find(component => component.type === 'custom_name');
    customName = (nameComponent ? componentToText(nameComponent.data) : item.customName ?? '').trim() || undefined;

    if (typeof item.maxDurability === 'number' && item.maxDurability > 0) {
      const remaining = item.maxDurability - (item.durabilityUsed ?? 0);
      details.push(`durability ${remaining}/${item.maxDurability}`);
    }

    const enchantments = components.length > 0
      ? componentEnchantments(bot, components)
      : (item.enchants ?? []).map(({ name, lvl }) => `${name} ${ROMAN_LEVELS[lvl - 1] ?? lvl}`);
    details.push(...enchantments);
  } catch {
    // Unknown component layouts must not break inventory listings.
  }
  return { customName, details };
}

/** e.g. `diamond_sword "Blade" (durability 1461/1561, sharpness III)` */
export function describeItem(bot: mineflayer.Bot, item: DetailedItem, { withCount = true } = {}): string {
  const { customName, details } = itemDetails(bot, item);
  let text = withCount ? `${item.name} x${item.count}` : item.name;
  if (customName) text += ` ${quoteUntrusted(customName)}`;
  if (details.length > 0) text += ` (${details.join(', ')})`;
  return text;
}
