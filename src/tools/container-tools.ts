import { z } from "zod";
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { Vec3 } from 'vec3';
import { ToolFactory } from '../tool-factory.js';
import { coerceCoordinates } from './coordinate-utils.js';
import { countItems, resolveItemsByName } from './item-utils.js';

const CONTAINER_PATTERN = /(chest|barrel|shulker_box|hopper|dispenser|dropper)$/;
const CONTAINER_REACH = 4;

type OpenContainer = Awaited<ReturnType<mineflayer.Bot['openContainer']>>;

async function withContainer<T>(
  bot: mineflayer.Bot,
  x: number,
  y: number,
  z: number,
  action: (container: OpenContainer, blockName: string) => Promise<T>
): Promise<T> {
  const pos = new Vec3(x, y, z).floored();
  const block = bot.blockAt(pos);

  if (!block || !CONTAINER_PATTERN.test(block.name)) {
    throw new Error(`No container (chest, barrel, shulker box, hopper, dispenser or dropper) at (${pos.x}, ${pos.y}, ${pos.z})`);
  }

  if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > CONTAINER_REACH) {
    await bot.pathfinder.goto(new goals.GoalNear(pos.x, pos.y, pos.z, 2));
  }

  const container = await bot.openContainer(block);
  try {
    return await action(container, block.name);
  } finally {
    container.close();
  }
}

function summarize(items: { name: string; count: number }[]): string {
  const totals = new Map<string, number>();
  items.forEach(item => totals.set(item.name, (totals.get(item.name) ?? 0) + item.count));
  return [...totals.entries()].map(([name, count]) => `${name} x${count}`).join(', ');
}

export function registerContainerTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  const coordinates = {
    x: z.coerce.number().describe("X coordinate of the container"),
    y: z.coerce.number().describe("Y coordinate of the container"),
    z: z.coerce.number().describe("Z coordinate of the container")
  };

  factory.registerTool(
    "read-container",
    "Look inside a chest, barrel, shulker box, hopper, dispenser or dropper. Opens it, lists the contents and closes it again",
    coordinates,
    async ({ x, y, z }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));
      const bot = getBot();

      return withContainer(bot, x, y, z, async (container, blockName) => {
        const items = container.containerItems();
        const where = `${blockName} at (${Math.floor(x)}, ${Math.floor(y)}, ${Math.floor(z)})`;
        if (items.length === 0) {
          return factory.createResponse(`The ${where} is empty`);
        }
        return factory.createResponse(`The ${where} contains: ${summarize(items)}`);
      });
    }
  );

  factory.registerTool(
    "container-deposit",
    "Put items from the bot's inventory into a container",
    {
      ...coordinates,
      itemName: z.string().trim().min(1).describe("Name of the item to deposit"),
      count: z.coerce.number().int().min(1).optional().describe("Number of items to deposit (default: 1)"),
      all: z.boolean().optional().describe("Deposit every matching item (overrides count)")
    },
    async ({ x, y, z, itemName, count = 1, all = false }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));
      const bot = getBot();

      const resolved = resolveItemsByName(bot.inventory.items(), itemName);
      if ('error' in resolved) {
        return factory.createErrorResponse(resolved.error);
      }

      const available = countItems(resolved.items);
      const amount = all ? available : count;
      if (amount > available) {
        return factory.createErrorResponse(`Only ${available} ${resolved.items[0].name} in inventory, cannot deposit ${amount}`);
      }

      return withContainer(bot, x, y, z, async (container, blockName) => {
        await container.deposit(resolved.items[0].type, null, amount);
        return factory.createResponse(`Deposited ${amount} ${resolved.items[0].name} into ${blockName}`);
      });
    }
  );

  factory.registerTool(
    "container-withdraw",
    "Take items out of a container into the bot's inventory",
    {
      ...coordinates,
      itemName: z.string().trim().min(1).describe("Name of the item to withdraw"),
      count: z.coerce.number().int().min(1).optional().describe("Number of items to withdraw (default: 1)"),
      all: z.boolean().optional().describe("Withdraw every matching item (overrides count)")
    },
    async ({ x, y, z, itemName, count = 1, all = false }) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));
      const bot = getBot();

      return withContainer(bot, x, y, z, async (container, blockName) => {
        const resolved = resolveItemsByName(container.containerItems(), itemName, 'container');
        if ('error' in resolved) {
          return factory.createErrorResponse(resolved.error);
        }

        const available = countItems(resolved.items);
        const amount = all ? available : count;
        if (amount > available) {
          return factory.createErrorResponse(`Only ${available} ${resolved.items[0].name} in container, cannot withdraw ${amount}`);
        }

        await container.withdraw(resolved.items[0].type, null, amount);
        return factory.createResponse(`Withdrew ${amount} ${resolved.items[0].name} from ${blockName}`);
      });
    }
  );
}
