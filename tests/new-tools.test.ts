import test from 'ava';
import sinon from 'sinon';
import { Vec3 } from 'vec3';
import { registerEntityTools } from '../src/tools/entity-tools.js';
import { registerInventoryTools } from '../src/tools/inventory-tools.js';
import { registerPositionTools } from '../src/tools/position-tools.js';
import { registerGameStateTools } from '../src/tools/gamestate-tools.js';
import { asBot, createFactory } from './_helpers.js';

function entity(id: number, name: string, type: string, pos: Vec3, extra: Record<string, unknown> = {}) {
  return { id, name, type, position: pos, height: 2, isValid: true, ...extra };
}

const self = { id: 1, position: new Vec3(0, 64, 0) };

test('list-entities lists nearest first and excludes the bot', async (t) => {
  const { factory, getTool } = createFactory();
  const bot = {
    entity: self,
    entities: {
      1: self,
      2: entity(2, 'zombie', 'hostile', new Vec3(10, 64, 0), { health: 12 }),
      3: entity(3, 'cow', 'animal', new Vec3(3, 64, 0)),
      4: entity(4, 'skeleton', 'hostile', new Vec3(100, 64, 0))
    }
  };
  registerEntityTools(factory, asBot(bot));

  const text = (await getTool('list-entities')!.execute({})).content[0].text;

  t.true(text.includes('2 entity(s)'));
  t.true(text.indexOf('cow') < text.indexOf('zombie'));
  t.true(text.includes('health 12'));
  t.false(text.includes('skeleton'));
});

test('list-entities filters by type', async (t) => {
  const { factory, getTool } = createFactory();
  const bot = {
    entity: self,
    entities: {
      2: entity(2, 'zombie', 'hostile', new Vec3(10, 64, 0)),
      3: entity(3, 'cow', 'animal', new Vec3(3, 64, 0))
    }
  };
  registerEntityTools(factory, asBot(bot));

  const text = (await getTool('list-entities')!.execute({ type: 'hostile' })).content[0].text;

  t.true(text.includes('zombie'));
  t.false(text.includes('cow'));
});

test('list-entities reports none found', async (t) => {
  const { factory, getTool } = createFactory();
  registerEntityTools(factory, asBot({ entity: self, entities: {} }));

  const text = (await getTool('list-entities')!.execute({ type: 'zombie' })).content[0].text;

  t.true(text.includes('No zombie found within 32 blocks'));
});

test('list-players shows other players with and without entity', async (t) => {
  const { factory, getTool } = createFactory();
  const bot = {
    username: 'Bot',
    entity: self,
    players: {
      Bot: { username: 'Bot', ping: 0 },
      Steve: { username: 'Steve', ping: 12, entity: entity(5, 'player', 'player', new Vec3(4, 64, 3)) },
      Alex: { username: 'Alex', ping: 30 }
    }
  };
  registerEntityTools(factory, asBot(bot));

  const text = (await getTool('list-players')!.execute({})).content[0].text;

  t.true(text.includes('2 other player(s)'));
  t.true(text.includes('Steve (ping 12ms), at (4, 64, 3), 5.0 blocks away'));
  t.true(text.includes('Alex (ping 30ms), not in range'));
  t.false(text.includes('- Bot'));
});

test('list-players handles empty server', async (t) => {
  const { factory, getTool } = createFactory();
  registerEntityTools(factory, asBot({ username: 'Bot', entity: self, players: { Bot: { username: 'Bot' } } }));

  const text = (await getTool('list-players')!.execute({})).content[0].text;

  t.true(text.includes('No other players online'));
});

test('attack-entity attacks by id and reports result', async (t) => {
  const { factory, getTool } = createFactory();
  const zombie = entity(2, 'zombie', 'hostile', new Vec3(2, 64, 0));
  const bot = {
    entity: self,
    entities: { 2: zombie },
    lookAt: sinon.stub().resolves(),
    attack: sinon.stub().callsFake(() => { zombie.isValid = false; })
  };
  registerEntityTools(factory, asBot(bot));

  const result = await getTool('attack-entity')!.execute({ entityId: 2 });

  t.true(bot.attack.calledOnceWith(zombie));
  t.true(bot.lookAt.calledOnce);
  t.true(result.content[0].text.includes('Attacked zombie (id 2) 1 time(s)'));
  t.true(result.content[0].text.includes('target is gone'));
});

test('attack-entity repeats attacks and stops when target dies', async (t) => {
  const { factory, getTool } = createFactory();
  const zombie = entity(2, 'zombie', 'hostile', new Vec3(2, 64, 0));
  const bot = {
    entity: self,
    entities: { 2: zombie },
    lookAt: sinon.stub().resolves(),
    attack: sinon.stub().callsFake(() => { if (bot.attack.callCount === 2) zombie.isValid = false; })
  };
  registerEntityTools(factory, asBot(bot));

  const result = await getTool('attack-entity')!.execute({ entityId: 2, times: 5 });

  t.is(bot.attack.callCount, 2);
  t.true(result.content[0].text.includes('2 time(s)'));
});

test('attack-entity attacks nearest entity matching type', async (t) => {
  const { factory, getTool } = createFactory();
  const zombie = entity(2, 'zombie', 'hostile', new Vec3(2, 64, 0));
  const bot = {
    entity: self,
    entities: { 2: zombie, 3: entity(3, 'cow', 'animal', new Vec3(1, 64, 0)) },
    lookAt: sinon.stub().resolves(),
    attack: sinon.stub()
  };
  registerEntityTools(factory, asBot(bot));

  const result = await getTool('attack-entity')!.execute({ type: 'zombie' });

  t.true(bot.attack.calledOnceWith(zombie));
  t.true(result.content[0].text.includes('still alive'));
});

test('attack-entity refuses targets out of reach', async (t) => {
  const { factory, getTool } = createFactory();
  const bot = {
    entity: self,
    entities: { 2: entity(2, 'zombie', 'hostile', new Vec3(10, 64, 0)) },
    lookAt: sinon.stub().resolves(),
    attack: sinon.stub()
  };
  registerEntityTools(factory, asBot(bot));

  const result = await getTool('attack-entity')!.execute({ entityId: 2 });

  t.true(result.isError);
  t.true(result.content[0].text.includes('beyond reach'));
  t.false(bot.attack.called);
});

test('attack-entity errors on unknown id and missing arguments', async (t) => {
  const { factory, getTool } = createFactory();
  registerEntityTools(factory, asBot({ entity: self, entities: {} }));

  const unknown = await getTool('attack-entity')!.execute({ entityId: 99 });
  const missing = await getTool('attack-entity')!.execute({});

  t.true(unknown.isError);
  t.true(unknown.content[0].text.includes('id 99'));
  t.true(missing.isError);
});

function item(name: string, count: number, type = 1) {
  return { name, count, type, slot: 0 };
}

test('consume equips named item then consumes', async (t) => {
  const { factory, getTool } = createFactory();
  const bread = item('bread', 3);
  const bot = {
    inventory: { items: () => [bread] },
    equip: sinon.stub().resolves(),
    consume: sinon.stub().resolves(),
    heldItem: bread,
    health: 20,
    food: 18
  };
  registerInventoryTools(factory, asBot(bot));

  const result = await getTool('consume')!.execute({ itemName: 'bread' });

  t.true(bot.equip.calledOnceWith(bread, 'hand'));
  t.true(bot.consume.calledOnce);
  t.true(result.content[0].text.includes('Consumed bread'));
  t.true(result.content[0].text.includes('food: 18'));
});

test('consume uses held item when no name given and errors when empty-handed', async (t) => {
  const { factory, getTool } = createFactory();
  const bot = {
    inventory: { items: () => [] },
    equip: sinon.stub(),
    consume: sinon.stub().resolves(),
    heldItem: null as unknown,
    health: 20,
    food: 20
  };
  registerInventoryTools(factory, asBot(bot));

  const empty = await getTool('consume')!.execute({});
  t.true(empty.isError);
  t.false(bot.consume.called);

  bot.heldItem = item('apple', 1);
  const ok = await getTool('consume')!.execute({});
  t.true(bot.consume.calledOnce);
  t.false(bot.equip.called);
  t.true(ok.content[0].text.includes('Consumed apple'));
});

test('consume errors when named item is missing', async (t) => {
  const { factory, getTool } = createFactory();
  registerInventoryTools(factory, asBot({ inventory: { items: () => [] } }));

  const result = await getTool('consume')!.execute({ itemName: 'bread' });

  t.true(result.isError);
  t.true(result.content[0].text.includes("Couldn't find any item matching 'bread'"));
});

test('toss-item drops requested count', async (t) => {
  const { factory, getTool } = createFactory();
  const bot = {
    inventory: { items: () => [item('cobblestone', 40, 7), item('cobblestone', 10, 7)] },
    toss: sinon.stub().resolves()
  };
  registerInventoryTools(factory, asBot(bot));

  const result = await getTool('toss-item')!.execute({ itemName: 'cobblestone', count: 45 });

  t.true(bot.toss.calledOnceWith(7, null, 45));
  t.true(result.content[0].text.includes('Dropped 45 cobblestone'));
});

test('toss-item defaults to one item and rejects too many', async (t) => {
  const { factory, getTool } = createFactory();
  const bot = {
    inventory: { items: () => [item('dirt', 5, 3)] },
    toss: sinon.stub().resolves()
  };
  registerInventoryTools(factory, asBot(bot));

  await getTool('toss-item')!.execute({ itemName: 'dirt' });
  t.true(bot.toss.calledOnceWith(3, null, 1));

  const tooMany = await getTool('toss-item')!.execute({ itemName: 'dirt', count: 6 });
  t.true(tooMany.isError);
  t.true(tooMany.content[0].text.includes('Only 5 dirt'));
  t.is(bot.toss.callCount, 1);
});

test('toss-item rejects ambiguous names and prefers exact match', async (t) => {
  const { factory, getTool } = createFactory();
  const bot = {
    inventory: { items: () => [item('iron_ingot', 3, 10), item('iron_axe', 1, 11), item('iron', 2, 12)] },
    toss: sinon.stub().resolves()
  };
  registerInventoryTools(factory, asBot(bot));

  await getTool('toss-item')!.execute({ itemName: 'iron' });
  t.true(bot.toss.calledOnceWith(12, null, 1));

  const bot2 = { inventory: { items: () => [item('iron_ingot', 3, 10), item('iron_axe', 1, 11)] }, toss: sinon.stub() };
  const second = createFactory();
  registerInventoryTools(second.factory, asBot(bot2));
  const ambiguous = await second.getTool('toss-item')!.execute({ itemName: 'iron' });
  t.true(ambiguous.isError);
  t.true(ambiguous.content[0].text.includes('ambiguous'));
  t.false(bot2.toss.called);
});

test('unequip-item unequips equipped slot', async (t) => {
  const { factory, getTool } = createFactory();
  const helmet = item('iron_helmet', 1);
  const bot = {
    getEquipmentDestSlot: sinon.stub().returns(5),
    inventory: { slots: { 5: helmet } },
    unequip: sinon.stub().resolves()
  };
  registerInventoryTools(factory, asBot(bot));

  const result = await getTool('unequip-item')!.execute({ destination: 'head' });

  t.true(bot.unequip.calledOnceWith('head'));
  t.true(result.content[0].text.includes('Unequipped iron_helmet from head'));
});

test('unequip-item reports empty slot without calling unequip', async (t) => {
  const { factory, getTool } = createFactory();
  const bot = {
    getEquipmentDestSlot: sinon.stub().returns(36),
    inventory: { slots: {} },
    unequip: sinon.stub().resolves()
  };
  registerInventoryTools(factory, asBot(bot));

  const result = await getTool('unequip-item')!.execute({});

  t.false(bot.unequip.called);
  t.true(result.content[0].text.includes("Nothing equipped in 'hand'"));
});

test('stop-pathfinding stops pathfinder and clears controls', async (t) => {
  const { factory, getTool } = createFactory();
  const bot = {
    pathfinder: { stop: sinon.stub(), setGoal: sinon.stub() },
    clearControlStates: sinon.stub()
  };
  registerPositionTools(factory, asBot(bot));

  const result = await getTool('stop-pathfinding')!.execute({});

  t.true(bot.pathfinder.stop.calledOnce);
  t.true(bot.pathfinder.setGoal.calledOnceWith(null));
  t.true(bot.pathfinder.stop.calledBefore(bot.pathfinder.setGoal));
  t.true(bot.clearControlStates.calledOnce);
  t.true(result.content[0].text.includes('Stopped'));
});

function observationBot(overrides: Record<string, unknown> = {}) {
  return {
    entity: { id: 1, position: new Vec3(10.5, 64, -3.2) },
    entities: {},
    game: { dimension: 'overworld', gameMode: 'survival' },
    health: 14,
    food: 17,
    foodSaturation: 3,
    oxygenLevel: 20,
    experience: { level: 5 },
    time: { timeOfDay: 6000, isDay: true },
    isRaining: false,
    thunderState: 0,
    heldItem: item('iron_sword', 1),
    getEquipmentDestSlot: (destination: string) => ({ head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 }[destination] ?? 36),
    inventory: {
      slots: { 5: item('iron_helmet', 1) },
      items: () => [item('cobblestone', 30), item('cobblestone', 10), item('bread', 4)]
    },
    ...overrides
  };
}

test('get-observation summarizes the bot state', async (t) => {
  const { factory, getTool } = createFactory();
  registerGameStateTools(factory, asBot(observationBot({
    entities: { 2: entity(2, 'zombie', 'hostile', new Vec3(8, 64, -3)) }
  })));

  const text = (await getTool('get-observation')!.execute({})).content[0].text;

  t.true(text.includes('Position: (10, 64, -4)'));
  t.true(text.includes('dimension: overworld'));
  t.true(text.includes('Health: 14/20, food: 17/20'));
  t.true(text.includes('xp level: 5'));
  t.true(text.includes('6000 ticks (day), weather: clear'));
  t.true(text.includes('Held item: iron_sword x1'));
  t.true(text.includes('Equipment: head: iron_helmet'));
  t.true(text.includes('cobblestone x40, bread x4'));
  t.true(text.includes('zombie [hostile]'));
});

test('get-observation rounds fractional health', async (t) => {
  const { factory, getTool } = createFactory();
  registerGameStateTools(factory, asBot(observationBot({ health: 13.333332061767578, foodSaturation: 2.4000000953674316 })));

  const text = (await getTool('get-observation')!.execute({})).content[0].text;

  t.true(text.includes('Health: 13.3/20'));
  t.true(text.includes('saturation: 2.4'));
});

test('get-observation handles empty surroundings', async (t) => {
  const { factory, getTool } = createFactory();
  registerGameStateTools(factory, asBot(observationBot({
    heldItem: null,
    isRaining: true,
    thunderState: 1,
    time: { timeOfDay: 18000, isDay: false },
    inventory: { slots: {}, items: () => [] }
  })));

  const text = (await getTool('get-observation')!.execute({})).content[0].text;

  t.true(text.includes('Held item: nothing'));
  t.true(text.includes('Equipment: none'));
  t.true(text.includes('Inventory: empty'));
  t.true(text.includes('(night), weather: thunderstorm'));
  t.true(text.includes('Nearby entities (within 16 blocks): none'));
});

test('get-observation reports full air when the server has not sent oxygen data', async (t) => {
  const { factory, getTool } = createFactory();
  registerGameStateTools(factory, asBot(observationBot({ oxygenLevel: undefined })));

  const text = (await getTool('get-observation')!.execute({})).content[0].text;

  t.true(text.includes('air: 20/20'));
  t.false(text.includes('undefined'));
});

test('get-observation reads air from the bot entity instead of the shared oxygenLevel', async (t) => {
  const { factory, getTool } = createFactory();
  const bot = observationBot({ oxygenLevel: 229 });
  (bot.entity as { metadata?: unknown[] }).metadata = [0, 90];
  registerGameStateTools(factory, asBot(bot));

  const text = (await getTool('get-observation')!.execute({})).content[0].text;

  t.true(text.includes('air: 6/20'));
});

test('get-observation ignores out of range oxygenLevel without entity metadata', async (t) => {
  const { factory, getTool } = createFactory();
  registerGameStateTools(factory, asBot(observationBot({ oxygenLevel: 229 })));

  const text = (await getTool('get-observation')!.execute({})).content[0].text;

  t.true(text.includes('air: 20/20'));
});

test('get-observation limits listed entities', async (t) => {
  const { factory, getTool } = createFactory();
  const entities: Record<number, unknown> = {};
  for (let i = 0; i < 5; i++) entities[i + 2] = entity(i + 2, 'cow', 'animal', new Vec3(i + 1, 64, 0));
  registerGameStateTools(factory, asBot(observationBot({ entities })));

  const text = (await getTool('get-observation')!.execute({ maxEntities: 2 })).content[0].text;

  t.true(text.includes('5 found, nearest 2 shown'));
  t.is(text.split('\n- ').length - 1, 2);
});
