import { z } from "zod";
import mineflayer from 'mineflayer';
import type { Item } from 'prismarine-item';
import { Vec3 } from 'vec3';
import { REPLY_MARGIN_MS, ToolFactory, allowFor, defaultLimitMs, type ToolContext } from '../tool-factory.js';
import { coerceCoordinates } from './coordinate-utils.js';

const FURNACE_BLOCKS = new Set(['furnace', 'blast_furnace', 'smoker']);
const TAKE_FUEL_TIMEOUT_MS = 5000;

/**
 * Why the leftover fuel cannot go back to the inventory, or null (E-014). It must fit whole (mineflayer's shift-click
 * never finishes when only part of it fits), and an empty slot must be left for the smelted output, which mineflayer
 * would otherwise throw on the ground.
 */
function fuelTakeOutProblem(furnace: mineflayer.Furnace, fuel: Item): string | null {
  const slots = furnace.slots.slice(furnace.inventoryStart, furnace.inventoryEnd);
  const empty = slots.filter(slot => !slot).length;
  const stackRoom = slots
    .filter((slot): slot is Item => Boolean(slot) && slot!.type === fuel.type && slot!.name === fuel.name)
    .reduce((room, slot) => room + Math.max(0, (slot.stackSize ?? 64) - slot.count), 0);
  const emptyAfter = stackRoom >= fuel.count ? empty : empty - 1;
  if (emptyAfter < 0) return 'the inventory is full';
  if (emptyAfter < 1) return 'no free inventory slot would be left for the output';
  return null;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  promise.catch(() => {});
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function registerFurnaceTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "smelt-item",
    "Smelt items using a furnace-like block",
    {
      x: z.coerce.number().describe("X coordinate"),
      y: z.coerce.number().describe("Y coordinate"),
      z: z.coerce.number().describe("Z coordinate"),
      inputItem: z.string().trim().min(1).describe("Name of item to smelt"),
      inputCount: z.number().int().positive().optional().describe("Amount of input to smelt (default: 1)"),
      fuelItem: z.string().trim().min(1).describe("Name of fuel item"),
      fuelCount: z.number().int().positive().optional().describe("Amount of fuel to use (default: 1)"),
      takeOutput: z.boolean().optional().describe("Whether to take output when ready (default: true)"),
      timeoutMs: z.number().int().positive().optional().describe(
        `How long to wait for the whole batch in ms (default: 10 s per item plus 10 s, at most about ${factory.callLimitMs - REPLY_MARGIN_MS}, ` +
        `so that the reply arrives within ${Math.round(factory.callLimitMs / 1000)} s; the furnace keeps smelting what is left; ` +
        'a longer wait needs an MCP client that waits that long)'
      )
    },
    async ({
      x,
      y,
      z,
      inputItem,
      inputCount = 1,
      fuelItem,
      fuelCount = 1,
      takeOutput = true,
      timeoutMs
    }: {
      x: number;
      y: number;
      z: number;
      inputItem: string;
      inputCount?: number;
      fuelItem: string;
      fuelCount?: number;
      takeOutput?: boolean;
      timeoutMs?: number;
    }, ctx: ToolContext) => {
      ({ x, y, z } = coerceCoordinates(x, y, z));

      const bot = getBot();

      const furnacePos = new Vec3(x, y, z);
      const furnaceBlock = bot.blockAt(furnacePos);

      if (!furnaceBlock || !FURNACE_BLOCKS.has(furnaceBlock.name)) {
        return factory.createErrorResponse(`No furnace block found at (${x}, ${y}, ${z})`);
      }

      const items = bot.inventory.items();
      // An exact name first: "sand" must not pick red_sand (E-013).
      const match = (wanted: string) =>
        items.find((item) => item.name === wanted.toLowerCase()) ?? items.find((item) => item.name.includes(wanted.toLowerCase()));
      const input = match(inputItem);
      if (!input) {
        return factory.createErrorResponse(`Couldn't find any item matching '${inputItem}' in inventory`);
      }

      const fuel = match(fuelItem);
      if (!fuel) {
        return factory.createErrorResponse(`Couldn't find any fuel item matching '${fuelItem}' in inventory`);
      }

      const resolvedInputCount = Math.min(inputCount, input.count);
      const resolvedFuelCount = Math.min(fuelCount, fuel.count);

      const furnace = await bot.openFurnace(furnaceBlock);
      const cleanup = () => {
        try {
          furnace.close();
        } catch {
          // ignore
        }
      };

      try {
        const existingInput = furnace.inputItem();
        if (existingInput && existingInput.name !== input.name) {
          return factory.createErrorResponse(`Furnace input slot is occupied by ${existingInput.name}`);
        }

        // Leftover fuel of another kind goes back to the inventory so the requested fuel fits (E-014).
        const existingFuel = furnace.fuelItem();
        let tookFuel = '';
        if (existingFuel && existingFuel.name !== fuel.name) {
          // mineflayer updates this item while moving it: keep what the slot held.
          const { name: oldName, count: oldCount } = existingFuel;
          try {
            const problem = fuelTakeOutProblem(furnace, existingFuel);
            if (problem) throw new Error(problem);
            await withTimeout(furnace.takeFuel(), TAKE_FUEL_TIMEOUT_MS, 'taking it out did not finish');
            if (furnace.fuelItem()) throw new Error('the inventory has no room for all of it');
          } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            return factory.createErrorResponse(
              `Furnace fuel slot holds ${oldCount} ${oldName} and it could not be taken out (${reason}): ` +
              `pass fuelItem '${oldName}' to smelt with it, or make room in the inventory`
            );
          }
          tookFuel = `; took ${oldCount} ${oldName} out of the fuel slot first`;
        }

        await furnace.putFuel(fuel.type, fuel.metadata ?? null, resolvedFuelCount);
        await furnace.putInput(input.type, input.metadata ?? null, resolvedInputCount);

        if (!takeOutput) {
          return factory.createResponse(
            `Started smelting ${resolvedInputCount} ${input.name} with ${resolvedFuelCount} ${fuel.name}${tookFuel}`
          );
        }

        // Take the output as it comes until the batch is done (E-013); taking only the first item left the rest in the
        // furnace, where it also blocked the next batch. The default wait ends in time for the reply (E-038); a timeoutMs
        // the caller gave is kept, and the call's deadline moves to make room for it.
        if (timeoutMs !== undefined) allowFor(ctx, timeoutMs);
        const waitMs = timeoutMs ?? Math.min(resolvedInputCount * 10000 + 10000, defaultLimitMs(ctx));
        const deadline = Date.now() + waitMs;
        let taken = 0;
        let outputName = '';
        while (Date.now() < deadline) {
          // After an abort nothing more is taken out; the furnace closes as the call ends (E-027).
          ctx.throwIfAborted();
          const output = await waitForOutput(furnace, deadline - Date.now(), ctx.signal);
          ctx.throwIfAborted();
          if (!output) break;
          const item = await furnace.takeOutput();
          if (!item) break;
          taken += item.count;
          outputName = item.name;
          // Furnace recipes give one item per input: done once the whole batch is out.
          if (taken >= resolvedInputCount || (!furnace.inputItem() && !furnace.outputItem())) break;
        }
        if (taken === 0) {
          // The input and fuel went in: say where they are, so the LLM does not take it that nothing happened (E-031).
          return factory.createErrorResponse(`No output after ${waitMs}ms; the input and fuel are in the furnace at (${x}, ${y}, ${z})${tookFuel}`);
        }
        const left = furnace.inputItem()?.count ?? 0;
        const rest = left ? `; ${left} ${input.name} still in the furnace (stopped after ${waitMs}ms); it keeps smelting in the furnace` : '';
        return factory.createResponse(`Smelted ${taken} ${outputName}${rest}${tookFuel}`);
      } finally {
        cleanup();
      }
    }
  );
}

/** Resolves null after `timeoutMs`, or at once when `signal` is aborted. */
async function waitForOutput(furnace: mineflayer.Furnace, timeoutMs: number, signal?: AbortSignal): Promise<Item | null> {
  const existing = furnace.outputItem();
  if (existing) {
    return existing;
  }

  return new Promise((resolve) => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const onUpdate = () => {
      const output = furnace.outputItem();
      if (output) {
        cleanup();
        resolve(output);
      }
    };

    const onAbort = () => {
      cleanup();
      resolve(null);
    };

    const cleanup = () => {
      furnace.removeListener('update', onUpdate);
      signal?.removeEventListener('abort', onAbort);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    };

    furnace.on('update', onUpdate);
    signal?.addEventListener('abort', onAbort, { once: true });

    timeoutId = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);
  });
}
