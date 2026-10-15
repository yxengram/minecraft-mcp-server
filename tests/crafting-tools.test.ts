import test from 'ava';
import sinon from 'sinon';
import { registerCraftingTools } from '../src/tools/crafting-tools.js';
import { ToolFactory } from '../src/tool-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BotConnection } from '../src/bot-connection.js';
import type mineflayer from 'mineflayer';
import minecraftData from 'minecraft-data';
import { Vec3 } from 'vec3';

function flattenRecipes(recipes: unknown): unknown[] {
  const all: unknown[] = [];
  if (Array.isArray(recipes)) return recipes;
  if (recipes && typeof recipes === 'object') {
    for (const v of Object.values(recipes as Record<string, unknown>)) {
      if (Array.isArray(v)) all.push(...v);
    }
  }
  return all;
}

function resolveItemNameFromMcData(mcData: unknown, value: unknown): string | null {
  const data = mcData as Record<string, unknown>;
  const items = data.items as Record<string, { name?: unknown }> | undefined;
  if (!items) return null;

  if (typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (value === 0) return null;
    const item = items[String(value)];
    return typeof item?.name === 'string' ? item.name : null;
  }

  if (Array.isArray(value)) {
    for (const v of value) {
      const name = resolveItemNameFromMcData(mcData, v);
      if (name) return name;
    }
    return null;
  }

  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (typeof v.name === 'string') return v.name;
    if (typeof v.id === 'number') {
      if (v.id === 0) return null;
      const item = items[String(v.id)];
      return typeof item?.name === 'string' ? item.name : null;
    }
  }

  return null;
}

function countRecipeIngredients(mcData: unknown, recipe: unknown): Record<string, number> {
  const r = recipe as Record<string, unknown>;
  const counts: Record<string, number> = {};

  if (Array.isArray(r.inShape)) {
    for (const row of r.inShape as unknown[]) {
      if (!Array.isArray(row)) continue;
      for (const cell of row) {
        const name = resolveItemNameFromMcData(mcData, cell);
        if (!name) continue;
        counts[name] = (counts[name] || 0) + 1;
      }
    }
    return counts;
  }

  if (Array.isArray(r.ingredients)) {
    for (const ing of r.ingredients as unknown[]) {
      const name = resolveItemNameFromMcData(mcData, ing);
      if (!name) continue;
      counts[name] = (counts[name] || 0) + 1;
    }
  }

  return counts;
}

test('registerCraftingTools registers all 4 tools', (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const mockBot = {} as Partial<mineflayer.Bot>;
  const getBot = () => mockBot as mineflayer.Bot;

  registerCraftingTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const toolNames = toolCalls.map(call => call.args[0]);

  t.true(toolNames.includes('list-recipes'));
  t.true(toolNames.includes('craft-item'));
  t.true(toolNames.includes('get-recipe'));
  t.true(toolNames.includes('can-craft'));
});

test('can-craft with empty inventory returns missing items', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const mockBot = {
    version: '1.21.11',
    inventory: {
      items: () => []
    }
  } as unknown as mineflayer.Bot;
  const getBot = () => mockBot;

  registerCraftingTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const canCraftCall = toolCalls.find(call => call.args[0] === 'can-craft');
  const executor = canCraftCall!.args[3];

  const result = await executor({ itemName: 'stick' });

  const text = result.content[0].text.toLowerCase();
  t.true(text.includes('cannot craft'));
  t.true(text.includes('missing'));
  t.true(text.includes('- '));
});

test('get-recipe returns recipe structure for valid item', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const mockBot = {
    version: '1.21.8',
    inventory: {
      items: () => []
    }
  } as unknown as mineflayer.Bot;
  const getBot = () => mockBot;

  registerCraftingTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const getRecipeCall = toolCalls.find(call => call.args[0] === 'get-recipe');
  const executor = getRecipeCall!.args[3];

  const result = await executor({ itemName: 'stick' });

  const mcData = minecraftData('1.21.8');
  const recipes = flattenRecipes((mcData as unknown as { recipes: unknown }).recipes);
  const stickId = (mcData as unknown as { itemsByName: Record<string, { id: number }> }).itemsByName.stick.id;
  const stickRecipe = recipes.find((recipe) => {
    const r = recipe as Record<string, unknown>;
    const res = r.result as Record<string, unknown> | undefined;
    return !!res && typeof res.id === 'number' && res.id === stickId;
  });
  t.truthy(stickRecipe);
  const ingredientCounts = countRecipeIngredients(mcData, stickRecipe);
  const ingredientNames = Object.keys(ingredientCounts);

  const text = result.content[0].text.toLowerCase();
  t.true(text.includes('ingredients'));
  t.true(ingredientNames.some(n => text.includes(n.toLowerCase())));
  t.true(Array.isArray(result.content));
});

test('list-recipes returns proper structure', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const mockBot = {
    version: '1.21.8',
    inventory: {
      items: () => [
        { name: 'oak_planks', count: 64, slot: 0 }
      ]
    }
  } as unknown as mineflayer.Bot;
  const getBot = () => mockBot;

  registerCraftingTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const listRecipesCall = toolCalls.find(call => call.args[0] === 'list-recipes');
  const executor = listRecipesCall!.args[3];

  const result = await executor({ outputItem: undefined });

  const text = result.content[0].text.toLowerCase();
  t.true(text.length > 0);
  t.true(text.includes('stick'));
  t.true(Array.isArray(result.content));
});

test('craft-item returns error when recipe not available', async (t) => {
  const mockServer = {
    tool: sinon.stub()
  } as unknown as McpServer;
  const mockConnection = {
    checkConnectionAndReconnect: sinon.stub().resolves({ connected: true })
  } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const mockBot = {
    version: '1.21.8',
    inventory: {
      items: () => []
    }
  } as unknown as mineflayer.Bot;
  const getBot = () => mockBot;

  registerCraftingTools(factory, getBot);

  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const craftItemCall = toolCalls.find(call => call.args[0] === 'craft-item');
  const executor = craftItemCall!.args[3];

  const result = await executor({ outputItem: 'stick', amount: 1 });

  t.true(result.content[0].text.length > 0);
  t.true(!!result.isError);
  t.true(Array.isArray(result.content));
});

test('craft-item crafts successfully when ingredients are available', async (t) => {
  const mcData = minecraftData('1.21.8');
  const recipes = flattenRecipes((mcData as unknown as { recipes: unknown }).recipes);
  const stickId = (mcData as unknown as { itemsByName: Record<string, { id: number }> }).itemsByName.stick.id;

  const stickRecipe = recipes.find((recipe) => {
    const r = recipe as Record<string, unknown>;
    const result = r.result as Record<string, unknown> | undefined;
    return !!result && typeof result.id === 'number' && result.id === stickId;
  });

  t.truthy(stickRecipe);

  const ingredientCounts = countRecipeIngredients(mcData, stickRecipe);
  const inventoryItems = Object.entries(ingredientCounts).map(([name, count], idx) => ({ name, count, slot: idx }));

  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const craftStub = sinon.stub().callsFake(async () => { inventoryItems.push({ name: 'stick', count: 4, slot: 99 }); });
  const mockBot = {
    version: '1.21.8',
    inventory: { items: () => inventoryItems },
    craft: craftStub
  } as unknown as mineflayer.Bot;

  registerCraftingTools(factory, () => mockBot);
  const toolCalls = (mockServer.tool as sinon.SinonStub).getCalls();
  const craftItemCall = toolCalls.find(call => call.args[0] === 'craft-item');
  const executor = craftItemCall!.args[3];

  const result = await executor({ outputItem: 'stick', amount: 1 });

  t.true(craftStub.called);
  t.false(!!result.isError);
  t.true(result.content[0].text.toLowerCase().includes('successfully crafted'));
});

test('uses real minecraft-data recipes for version 1.21.8', async (t) => {
  const mcData = minecraftData('1.21.8');
  
  t.truthy(mcData.recipes);
  const isValid = mcData.recipes && (Array.isArray(mcData.recipes) || typeof mcData.recipes === 'object');
  t.true(isValid);
});

test('craft-item explains that a 3x3 recipe needs a crafting table', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const craft = sinon.stub().resolves();
  const mockBot = {
    version: '1.21.8',
    inventory: { items: () => [{ name: 'oak_planks', count: 8, slot: 0 }] },
    recipesFor: () => [],
    findBlock: () => null,
    craft
  } as unknown as mineflayer.Bot;

  registerCraftingTools(factory, () => mockBot);
  const craftItemCall = (mockServer.tool as sinon.SinonStub).getCalls().find(call => call.args[0] === 'craft-item');

  const result = await craftItemCall!.args[3]({ outputItem: 'chest' });

  t.true(result.isError);
  t.true(result.content[0].text.includes('chest needs a crafting table'));
  t.false(result.content[0].text.includes('cherry_planks'));
  t.false(craft.called);
});


function realChestRecipe() {
  const mcData = minecraftData('1.21.8');
  const chestId = (mcData as unknown as { itemsByName: Record<string, { id: number }> }).itemsByName.chest.id;
  const recipe = flattenRecipes((mcData as unknown as { recipes: unknown }).recipes).find((candidate) => {
    const result = (candidate as { result?: { id?: number } }).result;
    return result?.id === chestId;
  });
  const [name, count] = Object.entries(countRecipeIngredients(mcData, recipe))[0];
  return { recipe, inventory: [{ name, count, slot: 0 }] };
}

test('craft-item walks to a distant crafting table before crafting', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const table = { name: 'crafting_table', position: new Vec3(10, 64, 0) };
  const { recipe, inventory } = realChestRecipe();
  const goto = sinon.stub().resolves();
  const craft = sinon.stub().callsFake(async () => { inventory.push({ name: 'chest', count: 1, slot: 9 }); });
  const mockBot = {
    version: '1.21.8',
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => inventory },
    recipesFor: (_id: number, _meta: null, _min: number, craftingTable: unknown) => (craftingTable ? [recipe] : []),
    findBlock: () => table,
    pathfinder: { goto },
    craft
  } as unknown as mineflayer.Bot;

  registerCraftingTools(factory, () => mockBot);
  const craftItemCall = (mockServer.tool as sinon.SinonStub).getCalls().find(call => call.args[0] === 'craft-item');

  const result = await craftItemCall!.args[3]({ outputItem: 'chest' });

  t.falsy(result.isError);
  t.true(goto.calledOnce);
  t.true(goto.calledBefore(craft));
  t.is(craft.firstCall.args[2], table);
});

test('craft-item reports the real failure when crafting throws', async (t) => {
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);

  const { recipe, inventory } = realChestRecipe();
  const mockBot = {
    version: '1.21.8',
    entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => inventory },
    recipesFor: () => [recipe],
    findBlock: () => ({ position: new Vec3(1, 64, 0) }),
    craft: sinon.stub().rejects(new Error('Recipe requires craftingTable, but one was not supplied'))
  } as unknown as mineflayer.Bot;

  registerCraftingTools(factory, () => mockBot);
  const craftItemCall = (mockServer.tool as sinon.SinonStub).getCalls().find(call => call.args[0] === 'craft-item');

  const result = await craftItemCall!.args[3]({ outputItem: 'chest' });

  t.true(result.isError);
  t.true(result.content[0].text.includes('requires craftingTable'));
  t.true(result.content[0].text.includes('Place a crafting table nearby'));
});

function stickBot(craft: (inventory: { name: string; count: number; slot: number }[]) => Promise<void>, extra: Record<string, unknown> = {}) {
  const mcData = minecraftData('1.21.8');
  const stickId = (mcData as unknown as { itemsByName: Record<string, { id: number }> }).itemsByName.stick.id;
  const recipe = flattenRecipes((mcData as unknown as { recipes: unknown }).recipes)
    .find(candidate => (candidate as { result?: { id?: number } }).result?.id === stickId);
  const inventory = Object.entries(countRecipeIngredients(mcData, recipe)).map(([name, count], slot) => ({ name, count, slot }));
  const craftStub = sinon.stub().callsFake(() => craft(inventory));
  const mockServer = { tool: sinon.stub() } as unknown as McpServer;
  const mockConnection = { checkConnectionAndReconnect: sinon.stub().resolves({ connected: true }) } as unknown as BotConnection;
  const factory = new ToolFactory(mockServer, mockConnection);
  const bot = { version: '1.21.8', inventory: { items: () => inventory }, recipesFor: () => [recipe], craft: craftStub, ...extra } as unknown as mineflayer.Bot;
  registerCraftingTools(factory, () => bot);
  const executor = (mockServer.tool as sinon.SinonStub).getCalls().find(call => call.args[0] === 'craft-item')!.args[3];
  return { executor, bot, craftStub };
}

test('craft-item reports when crafting does not add the item to the inventory', async (t) => {
  const { executor, craftStub } = stickBot(async () => {});

  const result = await executor({ outputItem: 'stick' });

  t.true(result.isError);
  t.true(result.content[0].text.includes('did not add any stick to the inventory'));
  t.is(craftStub.callCount, 2);
});

test('craft-item reports partial success honestly', async (t) => {
  let calls = 0;
  const { executor } = stickBot(async (inventory) => { if (calls++ === 0) inventory.push({ name: 'stick', count: 4, slot: 20 }); });

  const result = await executor({ outputItem: 'stick', amount: 3 });

  t.falsy(result.isError);
  t.true(result.content[0].text.startsWith('Crafted stick 1 of 3 time(s); stopped: crafting did not add any stick'));
});

test('craft-item puts leftovers from the crafting grid and cursor back into the inventory', async (t) => {
  const slots: unknown[] = [];
  const putAway = sinon.stub().resolves();
  const putSelectedItemRange = sinon.stub().resolves();
  const { executor, bot } = stickBot(async (inventory) => {
    inventory.push({ name: 'stick', count: 4, slot: 20 });
    slots[3] = { name: 'oak_planks' };
  }, { putAway, putSelectedItemRange });
  Object.assign(bot.inventory, { slots, selectedItem: { name: 'oak_planks' }, inventoryStart: 9, inventoryEnd: 45 });

  const result = await executor({ outputItem: 'stick' });

  t.falsy(result.isError);
  t.true(putSelectedItemRange.calledOnceWith(9, 45));
  t.true(putAway.calledOnceWith(3));
});
