import { z } from "zod";
import mineflayer from 'mineflayer';
import minecraftData from 'minecraft-data';
import { ToolFactory, type ToolContext } from '../tool-factory.js';
import { log } from '../logger.js';
import pathfinderPkg from 'mineflayer-pathfinder';
const { goals } = pathfinderPkg;
import { gotoWithTimeout } from './movement-utils.js';

const CRAFTING_TABLE_REACH = 4;
const CRAFT_SETTLE_MS = 250;
const CRAFT_SYNC_WAIT_MS = 600;
const CRAFT_TRIES = 2;
const PLAYER_CRAFTING_GRID = [1, 2, 3, 4];

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function countInInventory(bot: mineflayer.Bot, name: string): number {
  return bot.inventory.items().filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
}

// On some servers mineflayer's crafting occasionally leaves ingredients in the 2x2 grid or on the cursor
// when crafts run back to back. Put anything left there back into the inventory.
async function settleCraftingGrid(bot: mineflayer.Bot): Promise<void> {
  await sleep(CRAFT_SETTLE_MS);
  const inventory = bot.inventory as unknown as {
    selectedItem?: unknown; slots?: unknown[]; inventoryStart?: number; inventoryEnd?: number;
  };
  if (bot.currentWindow || !Array.isArray(inventory.slots)) return;
  try {
    if (inventory.selectedItem && typeof bot.putSelectedItemRange === 'function') {
      await bot.putSelectedItemRange(inventory.inventoryStart ?? 9, inventory.inventoryEnd ?? 45, bot.inventory, null);
    }
    for (const slot of PLAYER_CRAFTING_GRID) {
      if (inventory.slots[slot] && typeof bot.putAway === 'function') await bot.putAway(slot);
    }
  } catch (error) {
    log('warn', `Could not clear the crafting grid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface RecipeIngredient {
  name: string;
  count: number;
}

interface InventoryItem {
  name: string;
  count: number;
}

type McDataItemsById = Record<string, { name?: unknown }>;

function normalizeItemName(value: string): string {
  return value.trim().toLowerCase();
}

function classifyNameMatch(resultName: string, query: string): { exact: boolean; partial: boolean } {
  const resultNorm = normalizeItemName(resultName);
  const queryNorm = normalizeItemName(query);
  return {
    exact: resultNorm === queryNorm,
    partial: resultNorm.includes(queryNorm)
  };
}

type RecipeEvaluation = {
  canCraft: boolean;
  missingTotal: number;
  missing: RecipeIngredient[];
};

type RecipeIngredientOptions = {
  options: string[];
  count: number;
};

function resolveItemNames(value: unknown, itemsById: McDataItemsById): string[] {
  if (!value) return [];

  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const v of value) {
      const name = resolveItemName(v, itemsById);
      if (name) out.push(name);
    }
    return Array.from(new Set(out));
  }

  const single = resolveItemName(value, itemsById);
  return single ? [single] : [];
}

function parseRecipeIngredientOptions(recipe: unknown, itemsById: McDataItemsById): RecipeIngredientOptions[] {
  if (!recipe) return [];

  const r = recipe as Record<string, unknown>;

  const addOptions = (counts: Map<string, { options: string[]; count: number }>, options: string[]) => {
    if (options.length === 0) return;
    const key = [...options].sort().join('|');
    const existing = counts.get(key);
    if (existing) existing.count += 1;
    else counts.set(key, { options: [...options], count: 1 });
  };

  if (Array.isArray(r.inShape)) {
    const counts = new Map<string, { options: string[]; count: number }>();
    for (const row of r.inShape as unknown[]) {
      if (!Array.isArray(row)) continue;
      for (const cell of row) {
        const options = resolveItemNames(cell, itemsById);
        addOptions(counts, options);
      }
    }
    return Array.from(counts.values());
  }

  if (Array.isArray(r.ingredients)) {
    const counts = new Map<string, { options: string[]; count: number }>();
    for (const ingredient of r.ingredients as unknown[]) {
      const options = resolveItemNames(ingredient, itemsById);
      addOptions(counts, options);
    }
    return Array.from(counts.values());
  }

  return [];
}

function formatOptionsLabel(options: string[]): string {
  if (options.length === 0) return 'unresolved ingredient (no options found)';
  if (options.length === 1) return options[0];

  const shown = options.slice(0, 3).join(', ');
  const suffix = options.length > 3 ? ', …' : '';
  return `one of: ${shown}${suffix}`;
}

function evaluateRecipeMissing(recipe: unknown, inventory: InventoryItem[], itemsById: McDataItemsById): RecipeEvaluation {
  const ingredients = parseRecipeIngredientOptions(recipe, itemsById);
  const missing: RecipeIngredient[] = [];
  let missingTotal = 0;

  for (const { options, count } of ingredients) {
    const have = inventory
      .filter(i => options.includes(i.name))
      .reduce((sum, i) => sum + i.count, 0);

    if (have < count) {
      const deficit = count - have;
      missingTotal += deficit;
      missing.push({ name: formatOptionsLabel(options), count: deficit });
    }
  }

  return { canCraft: missingTotal === 0, missingTotal, missing };
}

type CandidateRecipe = {
  recipe: unknown;
  resultName: string;
  resultCount: number;
  exactMatch: boolean;
  craftingTable?: unknown;
};

/** Raw minecraft-data recipes larger than 2x2 can only be crafted at a crafting table. */
function rawRecipeNeedsTable(recipe: unknown): boolean {
  const r = recipe as { inShape?: unknown[][]; ingredients?: unknown[] };
  if (Array.isArray(r.inShape)) {
    return r.inShape.length > 2 || r.inShape.some(row => Array.isArray(row) && row.length > 2);
  }
  return Array.isArray(r.ingredients) && r.ingredients.length > 4;
}

async function moveWithinReach(bot: mineflayer.Bot, table: unknown, signal?: AbortSignal): Promise<void> {
  const position = (table as { position?: { x: number; y: number; z: number } }).position;
  const pathfinder = (bot as unknown as { pathfinder?: mineflayer.Bot['pathfinder'] }).pathfinder;
  if (!position || !pathfinder || !bot.entity?.position) return;
  const distance = bot.entity.position.distanceTo(position as never);
  if (distance > CRAFTING_TABLE_REACH) {
    await gotoWithTimeout(bot, new goals.GoalNear(position.x, position.y, position.z, 2), undefined, signal);
  }
}

function collectCandidateRecipes(recipes: unknown[], query: string, itemsById: McDataItemsById): CandidateRecipe[] {
  const exact: CandidateRecipe[] = [];
  const partial: CandidateRecipe[] = [];

  for (const recipe of recipes) {
    const result = getRecipeResult(recipe, itemsById);
    if (!result) continue;

    const match = classifyNameMatch(result.name, query);
    if (!match.partial) continue;

    const candidate: CandidateRecipe = {
      recipe,
      resultName: result.name,
      resultCount: result.count,
      exactMatch: match.exact
    };

    if (match.exact) exact.push(candidate);
    else partial.push(candidate);
  }

  return exact.length > 0 ? exact : partial;
}

function resolveItemName(value: unknown, itemsById: McDataItemsById): string | null {
  if (!value) return null;

  if (typeof value === 'string') return value;

  if (typeof value === 'number') {
    if (value === 0) return null;
    const item = itemsById[String(value)];
    return typeof item?.name === 'string' ? item.name : null;
  }

  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;

    if (typeof v.name === 'string') return v.name;
    if (typeof v.id === 'number') {
      if (v.id === 0) return null;
      const item = itemsById[String(v.id)];
      return typeof item?.name === 'string' ? item.name : null;
    }
  }

  return null;
}

function parseRecipeIngredients(recipe: unknown, itemsById: McDataItemsById): RecipeIngredient[] {
  const ingredients: RecipeIngredient[] = [];

  if (!recipe) return ingredients;

  const r = recipe as Record<string, unknown>;

  if (Array.isArray(r.inShape)) {
    const countMap: Record<string, number> = {};
    for (const row of r.inShape as unknown[]) {
      if (Array.isArray(row)) {
        for (const item of row) {
          const options = resolveItemNames(item, itemsById);
          if (options.length === 0) continue;
          const label = formatOptionsLabel(options);
          countMap[label] = (countMap[label] || 0) + 1;
        }
      }
    }
    for (const [name, count] of Object.entries(countMap)) {
      ingredients.push({ name, count });
    }

    if (ingredients.length > 0) return ingredients;
  }

  if (Array.isArray(r.ingredients)) {
    const countMap: Record<string, number> = {};
    for (const ingredient of r.ingredients as unknown[]) {
      const options = resolveItemNames(ingredient, itemsById);
      if (options.length === 0) continue;
      const label = formatOptionsLabel(options);
      countMap[label] = (countMap[label] || 0) + 1;
    }
    for (const [name, count] of Object.entries(countMap)) {
      ingredients.push({ name, count });
    }
  }

  return ingredients;
}

function getRecipeResult(recipe: unknown, itemsById: McDataItemsById): { name: string; count: number } | null {
  if (!recipe) return null;

  const r = recipe as Record<string, unknown>;
  const result = r.result;

  if (!result) return null;

  if (typeof result === 'string') {
    return { name: result, count: 1 };
  }

  if (typeof result === 'number') {
    const name = resolveItemName(result, itemsById);
    return name ? { name, count: 1 } : null;
  }

  if (result && typeof result === 'object') {
    const resultObj = result as Record<string, unknown>;
    const name = resolveItemName(resultObj, itemsById);
    const count = typeof resultObj.count === 'number' && Number.isFinite(resultObj.count) ? resultObj.count : 1;
    return name ? { name, count } : null;
  }

  return null;
}

function canCraftRecipe(recipe: unknown, inventory: InventoryItem[], itemsById: McDataItemsById): boolean {
  return evaluateRecipeMissing(recipe, inventory, itemsById).canCraft;
}

function collectCandidateRecipesFromBot(
  bot: mineflayer.Bot,
  mcData: unknown,
  query: string,
  itemsById: McDataItemsById,
  craftingTable: unknown | null
): CandidateRecipe[] {
  const data = mcData as Record<string, unknown>;
  const itemsByName = data.itemsByName as Record<string, { id?: unknown }> | undefined;
  if (!itemsByName) return [];

  const q = normalizeItemName(query);
  const exact: CandidateRecipe[] = [];
  const partial: CandidateRecipe[] = [];

  const pushRecipesFor = (name: string, id: number, exactMatch: boolean) => {
    const recipesFor = (bot as unknown as { recipesFor?: (...args: unknown[]) => unknown[] }).recipesFor;
    if (typeof recipesFor !== 'function') return;
    const recipes = recipesFor(id, null, 1, craftingTable) as unknown[];
    for (const recipe of recipes) {
      const result = getRecipeResult(recipe, itemsById);
      const resultName = result?.name ?? name;
      const resultCount = result?.count ?? 1;
      const candidate: CandidateRecipe = { recipe, resultName, resultCount, exactMatch, craftingTable: craftingTable ?? undefined };
      if (exactMatch) exact.push(candidate);
      else partial.push(candidate);
    }
  };

  const exactEntry = itemsByName[q];
  if (exactEntry && typeof exactEntry.id === 'number') {
    pushRecipesFor(q, exactEntry.id, true);
    return exact;
  }

  for (const [name, meta] of Object.entries(itemsByName)) {
    const match = classifyNameMatch(name, q);
    if (!match.partial) continue;
    if (typeof meta?.id === 'number') pushRecipesFor(name, meta.id, false);
  }

  return partial;
}

function findNearbyCraftingTable(bot: mineflayer.Bot, mcData: unknown): unknown | null {
  const data = mcData as Record<string, unknown>;
  const blocksByName = data.blocksByName as Record<string, { id?: unknown }> | undefined;
  const craftingTableId = blocksByName?.crafting_table?.id;
  if (typeof craftingTableId !== 'number') return null;

  const findBlock = (bot as unknown as { findBlock?: (opts: unknown) => unknown }).findBlock;
  if (typeof findBlock !== 'function') return null;

  try {
    return findBlock({ matching: craftingTableId, maxDistance: 16, count: 1 });
  } catch {
    return null;
  }
}

function getAllRecipes(mcData: unknown): unknown[] {
  const data = mcData as Record<string, unknown>;
  const recipes = data.recipes;

  if (Array.isArray(recipes)) {
    return recipes;
  }

  if (typeof recipes === 'object' && recipes !== null) {
    const recipeObj = recipes as Record<string, unknown>;
    const allRecipes: unknown[] = [];
    for (const recipeList of Object.values(recipeObj)) {
      if (Array.isArray(recipeList)) {
        allRecipes.push(...recipeList);
      }
    }
    return allRecipes;
  }

  return [];
}

export function registerCraftingTools(factory: ToolFactory, getBot: () => mineflayer.Bot): void {
  factory.registerTool(
    "list-recipes",
    "List all available crafting recipes the bot can make with current inventory",
    {
      outputItem: z.string().trim().min(1).optional().describe("Optional: filter recipes by output item name")
    },
    async ({ outputItem }) => {
      const bot = getBot();
      const mcData = minecraftData(bot.version);
      const itemsById = (mcData as unknown as { items: McDataItemsById }).items;
      const recipes = getAllRecipes(mcData);
      const inventory = bot.inventory.items().map(item => ({ name: item.name, count: item.count }));

      if (!recipes || recipes.length === 0) {
        return factory.createResponse("No recipes available for this Minecraft version");
      }

      const availableRecipes: Array<{ name: string; count: number; ingredients: RecipeIngredient[]; exactMatch?: boolean }> = [];

      for (const recipe of recipes) {
        const result = getRecipeResult(recipe, itemsById);
        if (!result) continue;

        const match = outputItem ? classifyNameMatch(result.name, outputItem) : { exact: false, partial: true };
        if (outputItem && !match.partial) continue;

        if (canCraftRecipe(recipe, inventory, itemsById)) {
          const ingredients = parseRecipeIngredients(recipe, itemsById);
          availableRecipes.push({
            name: result.name,
            count: result.count,
            ingredients,
            exactMatch: outputItem ? match.exact : undefined
          });
        }
      }

      if (outputItem) {
        const hasExact = availableRecipes.some(r => r.exactMatch);
        if (hasExact) {
          for (let i = availableRecipes.length - 1; i >= 0; i--) {
            if (!availableRecipes[i].exactMatch) availableRecipes.splice(i, 1);
          }
        }
      }

      if (availableRecipes.length === 0) {
        return factory.createResponse(`No craftable recipes found${outputItem ? ` for ${outputItem}` : ''} with current inventory`);
      }

      let output = `Found ${availableRecipes.length} craftable recipe(s):\n\n`;
      availableRecipes.forEach((recipe, index) => {
        output += `${index + 1}. ${recipe.name} (x${recipe.count})\n`;
        output += `   Ingredients: ${recipe.ingredients.map(i => `${i.name} x${i.count}`).join(", ")}\n\n`;
      });

      return factory.createResponse(output);
    }
  );

  factory.registerTool(
    "craft-item",
    "Craft an item using a crafting recipe",
    {
      outputItem: z.string().trim().min(1).describe("Name of the item to craft"),
      amount: z.number().int().min(1).optional().describe("Number of times to craft (default: 1)")
    },
    async ({ outputItem, amount = 1 }, ctx: ToolContext) => {
      const outputQuery = normalizeItemName(outputItem);

      const bot = getBot();
      const mcData = minecraftData(bot.version);
      const itemsById = (mcData as unknown as { items: McDataItemsById }).items;
      const recipes = getAllRecipes(mcData);

      if (!recipes || recipes.length === 0) {
        return factory.createErrorResponse("No recipes available");
      }

      let craftedCount = 0;
      let lastError = "";

      const table = findNearbyCraftingTable(bot, mcData);
      const candidatesFromBotNoTable = collectCandidateRecipesFromBot(bot, mcData, outputQuery, itemsById, null);
      const candidatesFromBotWithTable = table ? collectCandidateRecipesFromBot(bot, mcData, outputQuery, itemsById, table) : [];
      const candidatesFromBot = candidatesFromBotNoTable.length > 0 ? candidatesFromBotNoTable : candidatesFromBotWithTable;
      // mineflayer only returns recipes it can craft right now; fall back to raw data to explain what is missing.
      const usingRawRecipes = candidatesFromBot.length === 0;
      const candidates = usingRawRecipes ? collectCandidateRecipes(recipes, outputQuery, itemsById) : candidatesFromBot;
      let needsTable = false;

      for (let attempt = 0; attempt < amount; attempt++) {
        const currentInventory = bot.inventory.items().map(item => ({ name: item.name, count: item.count }));
        let craftedThisAttempt = false;
        let bestCannotCraft: { missingTotal: number; message: string } | null = null;

        for (const candidate of candidates) {
          const evaluation = evaluateRecipeMissing(candidate.recipe, currentInventory, itemsById);

          if (!evaluation.canCraft) {
            let msg = `Cannot craft ${candidate.resultName}. Missing:\n`;
            for (const { name, count } of evaluation.missing) {
              msg += `- ${name} x${count}\n`;
            }
            if (!bestCannotCraft || evaluation.missingTotal < bestCannotCraft.missingTotal) {
              bestCannotCraft = { missingTotal: evaluation.missingTotal, message: msg };
            }
            continue;
          }

          if (usingRawRecipes && rawRecipeNeedsTable(candidate.recipe)) {
            if (!table) {
              needsTable = true;
              continue;
            }
            candidate.craftingTable = table;
          }

          for (let tries = 0; tries < CRAFT_TRIES && !craftedThisAttempt; tries++) {
            // After an abort no further craft or retry starts (E-027).
            ctx.throwIfAborted();
            const before = countInInventory(bot, candidate.resultName);
            try {
              if (candidate.craftingTable) {
                await moveWithinReach(bot, candidate.craftingTable, ctx.signal);
                ctx.throwIfAborted();
                await bot.craft(candidate.recipe as Parameters<typeof bot.craft>[0], 1, candidate.craftingTable as Parameters<typeof bot.craft>[2]);
              } else {
                await bot.craft(candidate.recipe as Parameters<typeof bot.craft>[0], 1);
              }
              await settleCraftingGrid(bot);
              ctx.throwIfAborted();
              if (countInInventory(bot, candidate.resultName) <= before) await sleep(CRAFT_SYNC_WAIT_MS);
              if (countInInventory(bot, candidate.resultName) <= before) {
                throw new Error(`crafting did not add any ${candidate.resultName} to the inventory`);
              }
              craftedCount++;
              craftedThisAttempt = true;
              log('info', `Crafted ${candidate.resultName}`);
            } catch (err) {
              // The tool factory's stop makes the walk to the table fail with the pathfinder's own error.
              ctx.throwIfAborted();
              lastError = err instanceof Error ? err.message : String(err);
              log('warn', `Failed to craft ${outputItem}: ${lastError}`);
              await settleCraftingGrid(bot);
            }
          }
          if (craftedThisAttempt) break;
        }

        if (!craftedThisAttempt && attempt === 0) {
          if (needsTable && !lastError) {
            return factory.createErrorResponse(
              `${outputItem} needs a crafting table. Place one within 16 blocks of the bot and try again.`
            );
          }
          if (lastError) {
            const hint = /crafting ?table/i.test(lastError) ? ' Place a crafting table nearby and try again.' : '';
            return factory.createErrorResponse(`Failed to craft ${outputItem}: ${lastError}.${hint}`);
          }
          if (bestCannotCraft) {
            return factory.createErrorResponse(bestCannotCraft.message);
          }
          return factory.createErrorResponse(`Failed to craft ${outputItem}: ${lastError || 'Recipe not found or missing ingredients'}`);
        }

        if (!craftedThisAttempt) {
          break;
        }
      }

      if (craftedCount === 0) {
        return factory.createErrorResponse(`Failed to craft ${outputItem}: ${lastError || "Missing ingredients or recipe not found"}`);
      }

      if (craftedCount < amount) {
        return factory.createResponse(
          `Crafted ${outputItem} ${craftedCount} of ${amount} time(s); stopped: ${lastError || 'ran out of ingredients'}`
        );
      }
      return factory.createResponse(`Successfully crafted ${outputItem} ${craftedCount} time(s)`);
    }
  );

  factory.registerTool(
    "get-recipe",
    "Get detailed information about a specific recipe",
    {
      itemName: z.string().trim().min(1).describe("Name of the item to get recipe for")
    },
    async ({ itemName }) => {
      const bot = getBot();
      const mcData = minecraftData(bot.version);
      const itemsById = (mcData as unknown as { items: McDataItemsById }).items;
      const recipes = getAllRecipes(mcData);
      const inventory = bot.inventory.items().map(item => ({ name: item.name, count: item.count }));

      if (!recipes || recipes.length === 0) {
        return factory.createErrorResponse("No recipes available");
      }

      const table = findNearbyCraftingTable(bot, mcData);
      const candidatesFromBotNoTable = collectCandidateRecipesFromBot(bot, mcData, itemName, itemsById, null);
      const candidatesFromBotWithTable = table ? collectCandidateRecipesFromBot(bot, mcData, itemName, itemsById, table) : [];
      const candidatesFromBot = candidatesFromBotNoTable.length > 0 ? candidatesFromBotNoTable : candidatesFromBotWithTable;
      const candidates = candidatesFromBot.length > 0 ? candidatesFromBot : collectCandidateRecipes(recipes, itemName, itemsById);
      const matchingRecipes = candidates
        .map((c) => {
          const ingredients = parseRecipeIngredients(c.recipe, itemsById);
          const evaluation = evaluateRecipeMissing(c.recipe, inventory, itemsById);
          return {
            result: c.resultName,
            resultCount: c.resultCount,
            ingredients,
            canCraft: evaluation.canCraft,
            missingTotal: evaluation.missingTotal
          };
        })
        .sort((a, b) => {
          if (a.canCraft !== b.canCraft) return a.canCraft ? -1 : 1;
          return a.missingTotal - b.missingTotal;
        });

      if (matchingRecipes.length === 0) {
        return factory.createResponse(`No recipes found for ${itemName}`);
      }

      let output = `Recipe(s) for ${itemName}:\n\n`;

      matchingRecipes.forEach((recipe, index) => {
        output += `${index + 1}. Output: ${recipe.result} (x${recipe.resultCount})`;
        output += recipe.canCraft ? ' [craftable]\n' : ` [missing: ${recipe.missingTotal}]\n`;
        output += `   Ingredients:\n`;

        for (const ingredient of recipe.ingredients) {
          output += `   - ${ingredient.name} x${ingredient.count}\n`;
        }
        output += '\n';
      });

      return factory.createResponse(output);
    }
  );

  factory.registerTool(
    "can-craft",
    "Check if the bot can craft a specific item with current inventory",
    {
      itemName: z.string().trim().min(1).describe("Name of the item to check")
    },
    async ({ itemName }) => {
      const bot = getBot();
      const mcData = minecraftData(bot.version);
      const itemsById = (mcData as unknown as { items: McDataItemsById }).items;
      const recipes = getAllRecipes(mcData);
      const inventory = bot.inventory.items().map(item => ({ name: item.name, count: item.count }));

      if (!recipes || recipes.length === 0) {
        return factory.createErrorResponse("No recipes available");
      }

      const table = findNearbyCraftingTable(bot, mcData);
      const candidatesFromBotNoTable = collectCandidateRecipesFromBot(bot, mcData, itemName, itemsById, null);
      const candidatesFromBotWithTable = table ? collectCandidateRecipesFromBot(bot, mcData, itemName, itemsById, table) : [];
      const candidatesFromBot = candidatesFromBotNoTable.length > 0 ? candidatesFromBotNoTable : candidatesFromBotWithTable;
      const candidates = candidatesFromBot.length > 0 ? candidatesFromBot : collectCandidateRecipes(recipes, itemName, itemsById);
      if (candidates.length === 0) return factory.createResponse(`No recipe found for ${itemName}`);

      let bestCannotCraft: { missingTotal: number; message: string } | null = null;

      for (const candidate of candidates) {
        const evaluation = evaluateRecipeMissing(candidate.recipe, inventory, itemsById);

        if (evaluation.canCraft) {
          return factory.createResponse(`Yes, can craft ${candidate.resultName}. Have all required ingredients.`);
        }

        let output = `Cannot craft ${candidate.resultName}. Missing:\n`;
        for (const { name, count } of evaluation.missing) {
          output += `- ${name} x${count}\n`;
        }

        if (!bestCannotCraft || evaluation.missingTotal < bestCannotCraft.missingTotal) {
          bestCannotCraft = { missingTotal: evaluation.missingTotal, message: output };
        }
      }

      return factory.createResponse(bestCannotCraft?.message ?? `No recipe found for ${itemName}`);
    }
  );
}
