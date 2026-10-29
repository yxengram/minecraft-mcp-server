// Contract: docs/BLUEPRINT.md F-043. Lists a villager's trades and trades with it by the number list-trades shows.
import { z } from "zod";
import mineflayer from 'mineflayer';
import { ToolFactory, type ToolContext } from '../tool-factory.js';
import { approachEntity, entityLabel, metadataValue, resolveTargetEntity } from './entity-utils.js';
import { throwIfAborted } from './movement-utils.js';

type BotEntity = mineflayer.Bot['entity'];
type Villager = Awaited<ReturnType<mineflayer.Bot['openVillager']>>;
type Trade = Villager['trades'][number];

const TRADE_REACH = 3;
const DEFAULT_SEARCH = 16;
export const OPEN_TIMEOUT_MS = 5000;
const TRADE_TIMEOUT_MS = 10000;
const TRADE_TIMEOUT_PER_TRADE_MS = 2000;

// Registry order of minecraft:villager_profession, which the villager_data metadata refers to by number.
const PROFESSIONS = [
  'none', 'armorer', 'butcher', 'cartographer', 'cleric', 'farmer', 'fisherman', 'fletcher', 'leatherworker',
  'librarian', 'mason', 'nitwit', 'shepherd', 'toolsmith', 'weaponsmith'
];

class Timeout extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Timeout()), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function profession(bot: mineflayer.Bot, entity: BotEntity): string | undefined {
  const data = metadataValue(bot, entity, 'villager_data') as Record<string, unknown> | undefined;
  const value = data?.villagerProfession ?? data?.profession;
  if (typeof value === 'string') return value.replace(/^minecraft:/, '');
  if (typeof value === 'number') return PROFESSIONS[value];
  return undefined;
}

export function describeVillager(bot: mineflayer.Bot, entity: BotEntity): string {
  const job = profession(bot, entity);
  const label = entityLabel(entity);
  return job && job !== 'none' ? `${label} (${job})` : label;
}

// While the trade window is open, mineflayer updates only the window's copy of the inventory (bot.inventory is synced
// when the window closes), so items are counted from the window.
function inventoryCounts(window: { items(): { name: string; count: number }[] }): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of window.items()) counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
  return counts;
}

function price(trade: Trade): number {
  return trade.realPrice ?? trade.inputItem1.count;
}

function second(trade: Trade) {
  return trade.hasItem2 && trade.inputItem2 ? trade.inputItem2 : null;
}

function usesLeft(trade: Trade): number {
  return Math.max(0, trade.maximumNbTradeUses - trade.nbTradeUses);
}

export function affordable(trade: Trade, counts: Map<string, number>): number {
  let times = Math.floor((counts.get(trade.inputItem1.name) ?? 0) / Math.max(1, price(trade)));
  const item2 = second(trade);
  if (item2) times = Math.min(times, Math.floor((counts.get(item2.name) ?? 0) / Math.max(1, item2.count)));
  return Math.min(times, usesLeft(trade));
}

export function describeTrade(trade: Trade, index: number, counts: Map<string, number>): string {
  const item2 = second(trade);
  const inputs = `${price(trade)} ${trade.inputItem1.name}${item2 ? ` + ${item2.count} ${item2.name}` : ''}`;
  const parts = [`${index}. ${inputs} -> ${trade.outputItem.count} ${trade.outputItem.name}`, `used ${trade.nbTradeUses} of ${trade.maximumNbTradeUses}`];
  if (trade.tradeDisabled || usesLeft(trade) === 0) parts.push('out of stock');
  parts.push(`you can afford ${affordable(trade, counts)} time(s)`);
  return parts.join('; ');
}

function summarize(changes: [string, number][]): string {
  return changes.sort((a, b) => b[1] - a[1]).map(([name, count]) => `${count} ${name}`).join(', ') || 'nothing';
}

/** What left and what came into the inventory between two counts. */
export function inventoryChange(before: Map<string, number>, after: Map<string, number>): { gave: string; got: string } {
  const gave: [string, number][] = [];
  const got: [string, number][] = [];
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const diff = (after.get(name) ?? 0) - (before.get(name) ?? 0);
    if (diff < 0) gave.push([name, -diff]);
    if (diff > 0) got.push([name, diff]);
  }
  return { gave: summarize(gave), got: summarize(got) };
}

function close(bot: mineflayer.Bot, villager: Villager): void {
  try {
    villager.close();
  } catch {
    try { bot.closeWindow(villager); } catch { /* already closed */ }
  }
}

export function registerTradeTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  const target = {
    entityId: z.coerce.number().int().optional().describe("Entity id of the villager (from list-entities)"),
    type: z.string().optional().describe("If no entityId is given, use the nearest entity of this type (default: villager)"),
    maxDistance: z.coerce.number().finite().positive().optional().describe(`Search distance when using type (default: ${DEFAULT_SEARCH})`)
  };

  async function open(bot: mineflayer.Bot, args: { entityId?: number; type?: string; maxDistance?: number }, signal: AbortSignal):
    Promise<{ villager: Villager; entity: BotEntity; label: string } | { error: string }> {
    const resolved = resolveTargetEntity(bot, { entityId: args.entityId, type: args.type ?? 'villager', maxDistance: args.maxDistance ?? DEFAULT_SEARCH });
    if ('error' in resolved) return { error: resolved.error };
    const entity = resolved.entity;
    if (entity.name !== 'villager') {
      return { error: `${entityLabel(entity)} (id ${entity.id}) is not a villager: only villagers can be traded with (wandering traders are not supported)` };
    }
    const label = describeVillager(bot, entity);
    await approachEntity(bot, entity, TRADE_REACH, signal);
    throwIfAborted(signal);
    const opening = bot.openVillager(entity);
    try {
      return { villager: await withTimeout(opening, OPEN_TIMEOUT_MS), entity, label };
    } catch (error) {
      // A window that opens after the timeout must not stay open.
      opening.then(late => close(bot, late), () => {});
      if (error instanceof Timeout) {
        return { error: `${label} (id ${entity.id}) did not open a trade window within ${OPEN_TIMEOUT_MS / 1000}s (baby villagers cannot trade)` };
      }
      throw error;
    }
  }

  factory.registerTool(
    "list-trades",
    "List what a villager offers: the price, how often each trade can still be used and how many times you can afford it. Walks to the villager. Use the numbers with trade",
    target,
    async (args: { entityId?: number; type?: string; maxDistance?: number }, ctx: ToolContext) => {
      const bot = getBot();
      const opened = await open(bot, args, ctx.signal);
      if ('error' in opened) return factory.createErrorResponse(opened.error);
      const { villager, entity, label } = opened;
      try {
        const trades = villager.trades ?? [];
        if (trades.length === 0) {
          return factory.createResponse(`${label} (id ${entity.id}) offers no trades (unemployed villagers and nitwits do not trade)`);
        }
        const counts = inventoryCounts(villager);
        const lines = trades.map((trade, i) => describeTrade(trade, i + 1, counts));
        return factory.createResponse([`${label} (id ${entity.id}) offers ${trades.length} trade(s):`, ...lines].join('\n'));
      } finally {
        close(bot, villager);
      }
    },
    { body: true }
  );

  factory.registerTool(
    "trade",
    "Trade with a villager: use trade number `index` from list-trades `times` times. Walks to the villager",
    {
      ...target,
      index: z.coerce.number().int().min(1).describe("Trade number as shown by list-trades (starting at 1)"),
      times: z.coerce.number().int().min(1).max(64).optional().describe("How many times to make the trade (default: 1)")
    },
    async (args: { entityId?: number; type?: string; maxDistance?: number; index: number; times?: number }, ctx: ToolContext) => {
      const bot = getBot();
      const times = args.times ?? 1;
      const opened = await open(bot, args, ctx.signal);
      if ('error' in opened) return factory.createErrorResponse(opened.error);
      const { villager, entity, label } = opened;
      try {
        const trades = villager.trades ?? [];
        const trade = trades[args.index - 1];
        if (!trade) {
          return factory.createErrorResponse(`There is no trade ${args.index}: ${label} offers ${trades.length} trade(s); use list-trades`);
        }
        const used = `used ${trade.nbTradeUses} of ${trade.maximumNbTradeUses}`;
        const left = trade.tradeDisabled ? 0 : usesLeft(trade);
        if (left === 0) return factory.createErrorResponse(`Trade ${args.index} is out of stock (${used})`);
        if (left < times) return factory.createErrorResponse(`Trade ${args.index} has only ${left} use(s) left (${used})`);

        const before = inventoryCounts(villager);
        if (affordable(trade, before) < times) {
          const item2 = second(trade);
          const needs = `${price(trade) * times} ${trade.inputItem1.name}${item2 ? ` and ${item2.count * times} ${item2.name}` : ''}`;
          const has = `${before.get(trade.inputItem1.name) ?? 0}${item2 ? ` and ${before.get(item2.name) ?? 0}` : ''}`;
          return factory.createErrorResponse(`Not enough for ${times} trade(s): needs ${needs}, you have ${has}`);
        }

        const output = trade.outputItem;
        try {
          await withTimeout(bot.trade(villager, args.index - 1, times), TRADE_TIMEOUT_MS + TRADE_TIMEOUT_PER_TRADE_MS * times);
        } catch (error) {
          const gained = (inventoryCounts(villager).get(output.name) ?? 0) - (before.get(output.name) ?? 0);
          const done = Math.max(0, Math.floor(gained / Math.max(1, output.count)));
          const reason = error instanceof Timeout ? 'timed out' : (error as Error).message;
          return factory.createErrorResponse(`Trade failed after ${done} of ${times} trade(s): ${reason}`);
        }
        const { gave, got } = inventoryChange(before, inventoryCounts(villager));
        return factory.createResponse(`Traded ${times} time(s) with ${label} (id ${entity.id}): gave ${gave}, got ${got}`);
      } finally {
        close(bot, villager);
      }
    },
    { body: true }
  );
}
