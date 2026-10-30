import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { BotConnection } from '../src/bot-connection.js';
import { registerGameStateTools, armorPoints } from '../src/tools/gamestate-tools.js';
import { registerEntityTools } from '../src/tools/entity-tools.js';
import { entityDetails, findNearbyEntities } from '../src/tools/entity-utils.js';
import { asBot, createFactory } from './_helpers.js';
import type mineflayer from 'mineflayer';

const registry = minecraftData('1.21.8');
const keyIndex = (entity: string, key: string) => registry.entitiesByName[entity].metadataKeys!.indexOf(key);

function metadata(entity: string, values: Record<string, unknown>): unknown[] {
  const result: unknown[] = [];
  for (const [key, value] of Object.entries(values)) result[keyIndex(entity, key)] = value;
  return result;
}

function item(name: string, count = 1) {
  return { name, count, type: 1, slot: 0 };
}

function observationBot(overrides: Record<string, unknown> = {}) {
  const slots: Record<number, unknown> = {};
  return {
    version: '1.21.8',
    entity: { id: 1, position: new Vec3(0, 64, 0), effects: {} },
    entities: {},
    game: { dimension: 'overworld', gameMode: 'survival' },
    health: 20, food: 20, foodSaturation: 5,
    experience: { level: 3, points: 41 },
    time: { timeOfDay: 1000, isDay: true },
    isRaining: false, thunderState: 0, heldItem: null,
    getEquipmentDestSlot: (destination: string) => ({ head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 }[destination] ?? 36),
    inventory: { slots, items: () => [] },
    ...overrides
  };
}

test('get-observation lists status effects with level, duration and kind', async (t) => {
  const { factory, getTool } = createFactory();
  const bot = observationBot();
  bot.entity.effects = {
    18: { id: 18, amplifier: 0, duration: 100 },
    15: { id: 15, amplifier: 1, duration: 3700 },
    0: { id: 0, amplifier: 0, duration: -1 }
  };
  registerGameStateTools(factory, asBot(bot));

  const text = (await getTool('get-observation')!.execute({})).content[0].text;
  const effects = text.split('\n').find(line => line.startsWith('Effects:'))!;

  t.true(effects.includes('Poison I (5s, harmful)'));
  t.regex(effects, /II \(3:05, beneficial\)/);
  t.regex(effects, /Speed I \(infinite, beneficial\)/);
  t.true(text.includes('xp: level 3 (41 points)'));
});

test('get-observation reports no effects and armor from equipped pieces', async (t) => {
  const { factory, getTool } = createFactory();
  const bot = observationBot();
  Object.assign(bot.inventory.slots, { 5: item('iron_helmet'), 6: item('diamond_chestplate'), 8: item('leather_boots') });
  registerGameStateTools(factory, asBot(bot));

  const text = (await getTool('get-observation')!.execute({})).content[0].text;

  t.true(text.includes('Effects: none'));
  t.true(text.includes('Armor: 11/20'));
});

test('armorPoints handles turtle helmets, unknown items and empty slots', (t) => {
  const bot = observationBot();
  Object.assign(bot.inventory.slots, { 5: item('turtle_helmet'), 6: item('elytra'), 7: item('netherite_leggings') });

  t.is(armorPoints(asBot(bot)()), 8);
  t.is(armorPoints(asBot(observationBot())()), 0);
});

function worldBot(entities: Record<number, unknown>, players: Record<string, unknown> = {}) {
  const self = { id: 1, position: new Vec3(0, 64, 0) };
  return { registry, entity: self, entities: { 1: self, ...entities }, players };
}

test('dropped items show their item name and can be searched by it', async (t) => {
  const { factory, getTool } = createFactory();
  const drop = { id: 5, name: 'item', type: 'other', position: new Vec3(3, 64, 0), getDroppedItem: () => ({ name: 'diamond', count: 2 }) };
  registerEntityTools(factory, asBot(worldBot({ 5: drop })));

  const all = (await getTool('list-entities')!.execute({})).content[0].text;
  const search = (await getTool('list-entities')!.execute({ type: 'diamond' })).content[0].text;

  t.true(all.includes('diamond x2 [dropped item], id 5'));
  t.true(search.includes('Found 1 diamond(s)'));
});

test('entityDetails describes babies, names, owners, wool and equipment', (t) => {
  const bot = worldBot({}, { Steve: { username: 'Steve', uuid: 'uuid-steve' } });
  const zombie = {
    id: 2, name: 'zombie', type: 'hostile', position: new Vec3(1, 64, 0),
    metadata: metadata('zombie', { baby: true }),
    getCustomName: () => ({ toString: () => 'Bob' }),
    equipment: [{ name: 'iron_sword' }, null, { name: 'iron_boots' }, null, null, { name: 'golden_helmet' }]
  };
  const wolf = { id: 3, name: 'wolf', type: 'animal', position: new Vec3(2, 64, 0), metadata: metadata('wolf', { owneruuid: 'uuid-steve' }) };
  const stray = { id: 4, name: 'wolf', type: 'animal', position: new Vec3(2, 64, 0), metadata: metadata('wolf', { owneruuid: 'uuid-unknown' }) };
  const sheep = { id: 5, name: 'sheep', type: 'animal', position: new Vec3(2, 64, 0), metadata: metadata('sheep', { wool: 0x10 | 14 }) };

  t.deepEqual(entityDetails(asBot(bot)(), zombie as never), ['named "Bob"', 'baby', 'holding iron_sword', 'wearing golden_helmet, iron_boots']);
  t.deepEqual(entityDetails(asBot(bot)(), wolf as never), ['tamed by Steve']);
  t.deepEqual(entityDetails(asBot(bot)(), stray as never), ['tamed']);
  t.deepEqual(entityDetails(asBot(bot)(), sheep as never), ['red wool, sheared']);
});

test('entity details appear in list-entities and never break on odd metadata', async (t) => {
  const { factory, getTool } = createFactory();
  const cow = { id: 6, name: 'cow', type: 'animal', position: new Vec3(2, 64, 0), health: 7.5, metadata: metadata('cow', { baby: true }) };
  const broken = { id: 7, name: 'pig', type: 'animal', position: new Vec3(4, 64, 0), getCustomName: () => { throw new Error('bad'); } };
  const bot = worldBot({ 6: cow, 7: broken });
  registerEntityTools(factory, asBot(bot));

  const text = (await getTool('list-entities')!.execute({})).content[0].text;

  t.true(text.includes('cow [animal], id 6, at (2, 64, 0), 2.0 blocks away, health 7.5, baby'));
  t.true(text.includes('pig [animal], id 7'));
  t.is(findNearbyEntities(asBot(bot)()).length, 2);
});

function fakeBot() {
  const bot = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const client = new EventEmitter();
  const entities: Record<number, unknown> = {};
  Object.assign(bot, {
    _client: client,
    entity: { id: 1, position: new Vec3(0, 64, 0) },
    entities,
    health: 20,
    username: 'Bot',
    quit: sinon.stub()
  });
  return { bot, client, entities };
}

function connectionWithFakeBot() {
  const onEvent = sinon.stub();
  const onSystemMessage = sinon.stub();
  const connection = new BotConnection({ host: 'localhost', port: 25565, username: 'Bot' }, { onLog: sinon.stub(), onChatMessage: sinon.stub(), onEvent, onSystemMessage });
  const fake = fakeBot();
  (connection as unknown as { registerEventHandlers: (bot: unknown) => void }).registerEventHandlers(fake.bot as unknown as mineflayer.Bot);
  return { ...fake, onEvent, onSystemMessage };
}

test('damaged events name the damage type and attacker', (t) => {
  const { bot, client, entities, onEvent } = connectionWithFakeBot();
  client.emit('registry_data', { id: 'minecraft:damage_type', entries: [{ key: 'minecraft:arrow' }, { key: 'minecraft:magic' }] });
  entities[40] = { id: 40, name: 'skeleton', type: 'hostile' };
  entities[41] = { id: 41, name: 'arrow', type: 'projectile' };

  client.emit('damage_event', { entityId: 1, sourceTypeId: 0, sourceCauseId: 41, sourceDirectId: 42 });
  bot.health = 17;
  bot.emit('health');

  client.emit('damage_event', { entityId: 1, sourceTypeId: 1, sourceCauseId: 0, sourceDirectId: 0 });
  bot.health = 16;
  bot.emit('health');

  t.true(onEvent.calledWith('damaged', 'Health dropped from 20 to 17 (arrow from skeleton (id 40) via arrow)'));
  t.true(onEvent.calledWith('damaged', 'Health dropped from 17 to 16 (magic)'));
});

test('damaged events ignore damage to other entities and stale damage info', (t) => {
  const clock = sinon.useFakeTimers();
  t.teardown(() => clock.restore());
  const { bot, client, onEvent } = connectionWithFakeBot();

  client.emit('damage_event', { entityId: 99, sourceTypeId: 0, sourceCauseId: 0, sourceDirectId: 0 });
  bot.health = 18;
  bot.emit('health');
  client.emit('damage_event', { entityId: 1, sourceTypeId: 5, sourceCauseId: 0, sourceDirectId: 0 });
  clock.tick(5000);
  bot.health = 15;
  bot.emit('health');

  t.true(onEvent.calledWith('damaged', 'Health dropped from 20 to 18'));
  t.true(onEvent.calledWith('damaged', 'Health dropped from 18 to 15'));
});

test('system messages, action bar text and titles are forwarded with their kind', (t) => {
  const { bot, client, onSystemMessage } = connectionWithFakeBot();

  // E-035: chat with a sender is the playerChat handler's; chat without one (console /say) is a system line.
  bot.emit('message', { toString: () => '<Steve> hi' }, 'chat', '0b1c2d3e-0000-4000-8000-000000000001');
  bot.emit('message', { toString: () => '[Server] restart soon' }, 'chat');
  bot.emit('message', { toString: () => 'Teleported Bot to 1, 2, 3' }, 'system');
  bot.emit('message', { toString: () => 'legacy action bar' }, 'game_info');
  bot.emit('message', { toString: () => '   ' }, 'system');
  bot.emit('title', 'Welcome', 'title');
  bot.emit('title', { text: 'to the server' }, 'subtitle');
  client.emit('action_bar', { text: { type: 'compound', value: { text: { type: 'string', value: 'You may not rest now' } } } });

  t.deepEqual(onSystemMessage.getCalls().map(call => call.args), [
    ['system', '[Server] restart soon'],
    ['system', 'Teleported Bot to 1, 2, 3'],
    ['action_bar', 'legacy action bar'],
    ['title', 'Welcome'],
    ['subtitle', 'to the server'],
    ['action_bar', 'You may not rest now']
  ]);
});
