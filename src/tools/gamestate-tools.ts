import { z } from "zod";
import mineflayer from 'mineflayer';
import minecraftData from 'minecraft-data';
import { ToolFactory } from '../tool-factory.js';
import { formatStat } from '../format.js';
import { describeItem } from './item-utils.js';
import { describeEntity, findNearbyEntities, formatPosition } from './entity-utils.js';
import { isWaterLike } from './terrain-utils.js';

const ARMOR_SLOTS = ['head', 'torso', 'legs', 'feet', 'off-hand'] as const;

function describeWeather(bot: mineflayer.Bot): string {
  if (bot.thunderState > 0) return 'thunderstorm';
  if (bot.isRaining) return 'rain';
  return 'clear';
}

const AIR_TICKS_PER_BUBBLE = 15;
const MAX_AIR = 20;

// mineflayer copies the air_supply metadata of every entity into bot.oxygenLevel, so it can show another
// mob's value; it is never read here. The bot's own entity metadata (index 1, the air supply in ticks) is only
// sent once it differs from the default (full air), so a missing value means full air (E-014). Out of the water
// air only refills, so the reading counts only while the head is in water.
// Day, night and weather only exist in the overworld; in the Nether the line said "day, weather: rain" (E-017). The
// time the bot reads there is not the overworld's (it showed 0 ticks), so none is given.
function timeLine(bot: mineflayer.Bot): string {
  const dimension = bot.game?.dimension?.replace(/^minecraft:/, '');
  if (dimension && dimension !== 'overworld') {
    return `Time: no day or night in ${dimension}; weather: none here`;
  }
  return `Time: ${bot.time.timeOfDay} ticks (${bot.time.isDay ? 'day' : 'night'}), weather: ${describeWeather(bot)}`;
}

export function airLevel(bot: mineflayer.Bot): number | undefined {
  if (!bot.entity) return undefined;
  const ticks = (bot.entity.metadata as unknown[] | undefined)?.[1];
  if (typeof ticks !== 'number' || !headInWaterNow(bot)) return MAX_AIR;
  return Math.max(0, Math.min(MAX_AIR, Math.round(ticks / AIR_TICKS_PER_BUBBLE)));
}

/** The block above the feet (where the eyes are when standing) is water; true when the world cannot be read. */
function headInWaterNow(bot: mineflayer.Bot): boolean {
  if (typeof bot.blockAt !== 'function' || !bot.entity.position) return true;
  return isWaterLike(bot.blockAt(bot.entity.position.floored().offset(0, 1, 0)));
}

const TICKS_PER_SECOND = 20;
// Effects longer than this are effectively permanent (servers use huge or -1 durations for infinite effects).
const INFINITE_EFFECT_TICKS = 32147;
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

// Armor points per piece, by material and slot (helmet, chestplate, leggings, boots).
const ARMOR_POINTS: Record<string, [number, number, number, number]> = {
  leather: [1, 3, 2, 1],
  copper: [2, 4, 3, 1],
  chainmail: [2, 5, 4, 1],
  golden: [2, 5, 3, 1],
  iron: [2, 6, 5, 2],
  diamond: [3, 8, 6, 3],
  netherite: [3, 8, 6, 3]
};
const ARMOR_PIECES = ['helmet', 'chestplate', 'leggings', 'boots'];

function formatDuration(ticks: number): string {
  if (ticks < 0 || ticks >= INFINITE_EFFECT_TICKS) return 'infinite';
  const seconds = Math.ceil(ticks / TICKS_PER_SECOND);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : `${seconds}s`;
}

function describeEffects(bot: mineflayer.Bot): string {
  // mineflayer stores effects keyed by effect id even though the typings declare an array.
  const effects = Object.values((bot.entity?.effects ?? {}) as unknown as Record<string, { id: number; amplifier: number; duration: number }>);
  if (effects.length === 0) return 'none';

  const known = minecraftData(bot.version).effects as unknown as Record<string, { displayName?: string; name?: string; type?: string }>;
  return effects.map(effect => {
    const info = known?.[effect.id];
    const name = info?.displayName ?? info?.name ?? `effect ${effect.id}`;
    const level = ROMAN[effect.amplifier] ?? String(effect.amplifier + 1);
    const kind = info?.type === 'bad' ? ', harmful' : info?.type === 'good' ? ', beneficial' : '';
    return `${name} ${level} (${formatDuration(effect.duration)}${kind})`;
  }).join(', ');
}

export function armorPoints(bot: mineflayer.Bot): number {
  let total = 0;
  for (const destination of ['head', 'torso', 'legs', 'feet'] as const) {
    const item = bot.inventory.slots[bot.getEquipmentDestSlot(destination)];
    if (!item) continue;
    if (item.name === 'turtle_helmet') {
      total += 2;
      continue;
    }
    const [material, piece] = item.name.split(/_(?=helmet|chestplate|leggings|boots)/);
    const points = ARMOR_POINTS[material]?.[ARMOR_PIECES.indexOf(piece)];
    if (typeof points === 'number') total += points;
  }
  return total;
}

function describeEquipment(bot: mineflayer.Bot): string {
  const equipped = ARMOR_SLOTS
    .map(destination => {
      const item = bot.inventory.slots[bot.getEquipmentDestSlot(destination)];
      return item ? `${destination}: ${describeItem(bot, item, { withCount: false })}` : null;
    })
    .filter(Boolean);
  return equipped.length > 0 ? equipped.join(', ') : 'none';
}

function summarizeInventory(bot: mineflayer.Bot): string {
  const totals = new Map<string, number>();
  bot.inventory.items().forEach(item => totals.set(item.name, (totals.get(item.name) ?? 0) + item.count));

  if (totals.size === 0) return 'empty';
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} x${count}`)
    .join(', ');
}

export function registerGameStateTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "detect-gamemode",
    "Detect the gamemode on game",
    {},
    async () => {
      const bot = getBot();
      return factory.createResponse(`Bot gamemode: "${bot.game.gameMode}"`);
    }
  );

  factory.registerTool(
    "get-observation",
    "Get a one-call snapshot of the bot's situation: vitals, position, time, weather, held item, equipment, inventory summary, and nearby entities",
    {
      radius: z.coerce.number().finite().positive().optional().describe("Radius for nearby entities (default: 16)"),
      maxEntities: z.coerce.number().int().min(0).max(50).optional().describe("Maximum number of nearby entities to list (default: 10)")
    },
    async ({ radius = 16, maxEntities = 10 }) => {
      const bot = getBot();
      const position = bot.entity.position;
      const held = bot.heldItem;

      const lines = [
        `Position: ${formatPosition(position)} (exact: ${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}), dimension: ${bot.game.dimension}, gamemode: ${bot.game.gameMode}`,
        `Health: ${formatStat(bot.health)}/20, food: ${formatStat(bot.food)}/20, saturation: ${formatStat(bot.foodSaturation)}, air: ${airLevel(bot) ?? MAX_AIR}/${MAX_AIR}`,
        `Effects: ${describeEffects(bot)}`,
        `Armor: ${armorPoints(bot)}/20, xp: level ${bot.experience?.level ?? 0} (${bot.experience?.points ?? 0} points)`,
        timeLine(bot),
        `Held item: ${held ? describeItem(bot, held) : 'nothing'}`,
        `Equipment: ${describeEquipment(bot)}`,
        `Inventory: ${summarizeInventory(bot)}`
      ];

      const nearby = findNearbyEntities(bot, { maxDistance: radius });
      if (nearby.length === 0) {
        lines.push(`Nearby entities (within ${radius} blocks): none`);
      } else {
        const shown = nearby.slice(0, maxEntities);
        lines.push(`Nearby entities (within ${radius} blocks): ${nearby.length} found${shown.length < nearby.length ? `, nearest ${shown.length} shown` : ''}`);
        shown.forEach(item => lines.push(`- ${describeEntity(item)}`));
      }

      return factory.createResponse(lines.join('\n'));
    }
  );
}
