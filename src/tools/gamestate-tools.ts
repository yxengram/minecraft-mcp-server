import { z } from "zod";
import mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import { describeEntity, findNearbyEntities, formatPosition } from './entity-utils.js';

const ARMOR_SLOTS = ['head', 'torso', 'legs', 'feet', 'off-hand'] as const;

function describeWeather(bot: mineflayer.Bot): string {
  if (bot.thunderState > 0) return 'thunderstorm';
  if (bot.isRaining) return 'rain';
  return 'clear';
}

function describeEquipment(bot: mineflayer.Bot): string {
  const equipped = ARMOR_SLOTS
    .map(destination => {
      const item = bot.inventory.slots[bot.getEquipmentDestSlot(destination)];
      return item ? `${destination}: ${item.name}` : null;
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
        `Health: ${bot.health}/20, food: ${bot.food}/20, saturation: ${bot.foodSaturation}, air: ${typeof bot.oxygenLevel === 'number' ? `${bot.oxygenLevel}/20` : 'full'}, xp level: ${bot.experience?.level ?? 0}`,
        `Time: ${bot.time.timeOfDay} ticks (${bot.time.isDay ? 'day' : 'night'}), weather: ${describeWeather(bot)}`,
        `Held item: ${held ? `${held.name} x${held.count}` : 'nothing'}`,
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
