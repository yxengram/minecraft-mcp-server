import { z } from "zod";
import mineflayer from 'mineflayer';
import { ToolFactory } from '../tool-factory.js';
import { formatStat } from '../format.js';
import { countItems, itemDetails, resolveItemsByName } from './item-utils.js';

function detailSuffix(bot: mineflayer.Bot, item: Parameters<typeof itemDetails>[1]): string {
  const { customName, details } = itemDetails(bot, item);
  const parts = [...(customName ? [`"${customName}"`] : []), ...details];
  return parts.length > 0 ? `: ${parts.join(', ')}` : '';
}

const EQUIPMENT_DESTINATIONS = ['hand', 'head', 'torso', 'legs', 'feet', 'off-hand'] as const;

export function registerInventoryTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "list-inventory",
    "List all items in the bot's inventory",
    {},
    async () => {
      const bot = getBot();
      const items = bot.inventory.items();

      if (items.length === 0) {
        return factory.createResponse("Inventory is empty");
      }

      let inventoryText = `Found ${items.length} items in inventory:\n\n`;
      items.forEach(item => {
        inventoryText += `- ${item.name} (x${item.count}) in slot ${item.slot}${detailSuffix(bot, item)}\n`;
      });

      return factory.createResponse(inventoryText);
    }
  );

  factory.registerTool(
    "find-item",
    "Find a specific item in the bot's inventory",
    {
      nameOrType: z.string().describe("Name or type of item to find")
    },
    async ({ nameOrType }) => {
      const bot = getBot();
      const items = bot.inventory.items();
      const item = items.find((item) =>
        item.name.includes(nameOrType.toLowerCase())
      );

      if (item) {
        return factory.createResponse(`Found ${item.count} ${item.name} in inventory (slot ${item.slot})${detailSuffix(bot, item)}`);
      } else {
        return factory.createResponse(`Couldn't find any item matching '${nameOrType}' in inventory`);
      }
    }
  );

  factory.registerTool(
    "equip-item",
    "Equip a specific item",
    {
      itemName: z.string().describe("Name of the item to equip"),
      destination: z.string().optional().describe("Where to equip the item (default: 'hand')")
    },
    async ({ itemName, destination = 'hand' }) => {
      const bot = getBot();
      const items = bot.inventory.items();
      const item = items.find((item) =>
        item.name.includes(itemName.toLowerCase())
      );

      if (!item) {
        return factory.createResponse(`Couldn't find any item matching '${itemName}' in inventory`);
      }

      await bot.equip(item, destination as mineflayer.EquipmentDestination);
      return factory.createResponse(`Equipped ${item.name} to ${destination}`);
    }
  );

  factory.registerTool(
    "consume",
    "Eat or drink an item. Uses the currently held item, or equips the named item first",
    {
      itemName: z.string().optional().describe("Name of the food/potion to consume (default: the currently held item)")
    },
    async ({ itemName }) => {
      const bot = getBot();

      if (itemName) {
        const resolved = resolveItemsByName(bot.inventory.items(), itemName);
        if ('error' in resolved) {
          return factory.createErrorResponse(resolved.error);
        }
        await bot.equip(resolved.items[0], 'hand');
      }

      const held = bot.heldItem;
      if (!held) {
        return factory.createErrorResponse("Nothing in hand to consume");
      }

      await bot.consume();
      return factory.createResponse(`Consumed ${held.name}. Health: ${formatStat(bot.health)}, food: ${formatStat(bot.food)}`);
    }
  );

  factory.registerTool(
    "toss-item",
    "Drop items from the inventory on the ground",
    {
      itemName: z.string().describe("Name of the item to drop"),
      count: z.coerce.number().int().min(1).optional().describe("Number of items to drop (default: 1)")
    },
    async ({ itemName, count = 1 }) => {
      const bot = getBot();
      const resolved = resolveItemsByName(bot.inventory.items(), itemName);
      if ('error' in resolved) {
        return factory.createErrorResponse(resolved.error);
      }

      const available = countItems(resolved.items);
      if (count > available) {
        return factory.createErrorResponse(`Only ${available} ${resolved.items[0].name} in inventory, cannot drop ${count}`);
      }

      await bot.toss(resolved.items[0].type, null, count);
      return factory.createResponse(`Dropped ${count} ${resolved.items[0].name}`);
    }
  );

  factory.registerTool(
    "unequip-item",
    "Take off an equipped item and put it back in the inventory",
    {
      destination: z.enum(EQUIPMENT_DESTINATIONS).optional().describe("Equipment slot to clear (default: 'hand')")
    },
    async ({ destination = 'hand' }: { destination?: typeof EQUIPMENT_DESTINATIONS[number] }) => {
      const bot = getBot();
      const item = bot.inventory.slots[bot.getEquipmentDestSlot(destination)];

      if (!item) {
        return factory.createResponse(`Nothing equipped in '${destination}'`);
      }

      await bot.unequip(destination);
      return factory.createResponse(`Unequipped ${item.name} from ${destination}`);
    }
  );
}
