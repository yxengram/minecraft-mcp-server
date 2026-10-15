import test from 'ava';
import sinon from 'sinon';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { BotConnection } from '../src/bot-connection.js';
import { EventStore } from '../src/event-store.js';
import { serverRegistryName, trackServerRegistries } from '../src/server-registries.js';
import { describeItem, itemDetails } from '../src/tools/item-utils.js';
import { blockDetails, faceName } from '../src/tools/block-details.js';
import { entityDetails } from '../src/tools/entity-utils.js';
import { registerBlockTools } from '../src/tools/block-tools.js';
import { registerEventTools } from '../src/tools/event-tools.js';
import { registerInventoryTools } from '../src/tools/inventory-tools.js';
import { asBot, createFactory } from './_helpers.js';
import type mineflayer from 'mineflayer';

const registry = minecraftData('1.21.8');

function botWithRegistries(entries: Record<string, string[]> = {}) {
  const client = new EventEmitter();
  const bot = { version: '1.21.8', registry, _client: client } as unknown as mineflayer.Bot;
  trackServerRegistries(bot);
  for (const [id, keys] of Object.entries(entries)) {
    client.emit('registry_data', { id: `minecraft:${id}`, entries: keys.map(key => ({ key: `minecraft:${key}` })) });
  }
  return bot;
}

test('server registries map indexes to names per bot', (t) => {
  const bot = botWithRegistries({ 'worldgen/biome': ['badlands', 'desert'] });
  const other = botWithRegistries();

  t.is(serverRegistryName(bot, 'worldgen/biome', 1), 'desert');
  t.is(serverRegistryName(bot, 'worldgen/biome', 5), undefined);
  t.is(serverRegistryName(other, 'worldgen/biome', 1), undefined);
});

test('itemDetails reads durability, custom names and enchantments from components', (t) => {
  const bot = botWithRegistries({ enchantment: ['aqua_affinity', 'sharpness', 'unbreaking'] });
  const sword = {
    name: 'diamond_sword', count: 1, maxDurability: 1561, durabilityUsed: 100,
    components: [
      { type: 'enchantments', data: { enchantments: [{ id: 1, level: 3 }, { id: 2, level: 2 }] } },
      { type: 'custom_name', data: { type: 'string', value: 'Blade' } }
    ]
  };

  t.deepEqual(itemDetails(bot, sword), { customName: 'Blade', details: ['durability 1461/1561', 'sharpness III', 'unbreaking II'] });
  t.is(describeItem(bot, sword), 'diamond_sword x1 "Blade" (durability 1461/1561, sharpness III, unbreaking II)');
  t.is(describeItem(bot, sword, { withCount: false }), 'diamond_sword "Blade" (durability 1461/1561, sharpness III, unbreaking II)');
});

test('itemDetails handles books, legacy items and plain items', (t) => {
  const bot = botWithRegistries({ enchantment: ['mending'] });

  t.deepEqual(itemDetails(bot, { name: 'enchanted_book', count: 1, components: [{ type: 'stored_enchantments', data: { enchantments: [{ id: 0, level: 1 }] } }] }).details, ['mending I']);
  t.deepEqual(itemDetails(bot, { name: 'bow', count: 1, maxDurability: 384, durabilityUsed: 0, customName: 'Old', enchants: [{ name: 'power', lvl: 5 }] }),
    { customName: 'Old', details: ['durability 384/384', 'power V'] });
  t.is(describeItem(bot, { name: 'dirt', count: 12 }), 'dirt x12');
});

test('list-inventory and find-item append item details', async (t) => {
  const { factory, getTool } = createFactory();
  const bot = botWithRegistries({ enchantment: ['sharpness'] });
  const sword = { name: 'iron_sword', count: 1, slot: 36, maxDurability: 250, durabilityUsed: 50, components: [{ type: 'enchantments', data: { enchantments: [{ id: 0, level: 1 }] } }] };
  Object.assign(bot, { inventory: { items: () => [sword, { name: 'dirt', count: 3, slot: 37 }] } });
  registerInventoryTools(factory, () => bot);

  const list = (await getTool('list-inventory')!.execute({})).content[0].text;
  const found = (await getTool('find-item')!.execute({ nameOrType: 'sword' })).content[0].text;

  t.true(list.includes('- iron_sword (x1) in slot 36: durability 200/250, sharpness I'));
  t.true(list.includes('- dirt (x3) in slot 37\n'));
  t.is(found, 'Found 1 iron_sword in inventory (slot 36): durability 200/250, sharpness I');
});

function block(name: string, extra: Record<string, unknown> = {}) {
  return { name, type: 1, position: new Vec3(1, 64, 2), getProperties: () => ({}), ...extra };
}

test('blockDetails lists state, light, biome and sign text', (t) => {
  const bot = botWithRegistries({ 'worldgen/biome': ['badlands', 'desert'] });
  const sign = block('oak_sign', {
    getProperties: () => ({ rotation: 4, waterlogged: false }),
    light: 7, skyLight: 15,
    biome: { id: 1, name: '' },
    getSignText: () => ['hello\nworld\n\n', '\n\n\n']
  });

  t.deepEqual(blockDetails(bot, sign as never), [
    'State: rotation=4, waterlogged=false',
    'Light: 7 from blocks, 15 from the sky',
    'Biome: desert',
    'Sign text (front): "hello / world"'
  ]);
  t.deepEqual(blockDetails(bot, block('oak_sign', { getSignText: () => ['', ''] }) as never), ['Sign text: blank']);
  t.deepEqual(blockDetails(bot, block('stone', { biome: { id: 0, name: 'plains' } }) as never), ['Biome: plains']);
  t.deepEqual(blockDetails(bot, block('stone', { getProperties: () => { throw new Error('bad'); } }) as never), []);
});

test('get-block-info keeps the first line and adds details', async (t) => {
  const { factory, getTool } = createFactory();
  const bot = botWithRegistries();
  Object.assign(bot, { blockAt: () => block('oak_door', { getProperties: () => ({ open: true }), light: 0, skyLight: 15 }) });
  registerBlockTools(factory, () => bot);

  const text = (await getTool('get-block-info')!.execute({ x: 1, y: 64, z: 2 })).content[0].text;

  t.is(text, 'Found oak_door (type: 1) at position (1, 64, 2)\nState: open=true\nLight: 0 from blocks, 15 from the sky');
});

function cursorBot(overrides: Record<string, unknown>) {
  const bot = botWithRegistries();
  Object.assign(bot, {
    entity: { id: 1, position: new Vec3(0.5, 64, 0.5), yaw: Math.PI / 2, pitch: -0.5, eyeHeight: 1.62 },
    entities: {},
    blockAtCursor: () => null,
    entityAtCursor: () => null,
    ...overrides
  });
  return bot;
}

test('get-cursor-target describes facing and the targeted block face', async (t) => {
  const { factory, getTool } = createFactory();
  const target = block('chest', { position: new Vec3(-2, 63, 0), face: 1 });
  registerBlockTools(factory, () => cursorBot({ blockAtCursor: () => target }));

  const text = (await getTool('get-cursor-target')!.execute({})).content[0].text;

  t.true(text.startsWith('Facing west, looking down (pitch -29°)'));
  t.regex(text, /Looking at chest at \(-2, 63, 0\), [\d.]+ blocks away, top/);
  t.is(faceName(5), 'east side');
});

test('get-cursor-target prefers a closer entity and reports nothing in range', async (t) => {
  const first = createFactory();
  const pig = { id: 7, name: 'pig', type: 'animal', position: new Vec3(-1, 64, 0.5) };
  registerBlockTools(first.factory, () => cursorBot({ entityAtCursor: () => pig, blockAtCursor: () => block('stone', { position: new Vec3(-5, 64, 0) }) }));
  const withEntity = (await first.getTool('get-cursor-target')!.execute({})).content[0].text;
  t.true(withEntity.includes('Looking at entity: pig [animal], id 7'));

  const second = createFactory();
  registerBlockTools(second.factory, () => cursorBot({ entity: { id: 1, position: new Vec3(0, 64, 0), yaw: 0, pitch: 0 } }));
  const nothing = (await second.getTool('get-cursor-target')!.execute({ maxDistance: 4 })).content[0].text;
  t.true(nothing.startsWith('Facing north, looking straight ahead (pitch 0°)'));
  t.true(nothing.includes('Nothing within 4 blocks'));
});

test('entityDetails warns about creepers that are about to explode', (t) => {
  const keys = registry.entitiesByName.creeper.metadataKeys!;
  const metadata: unknown[] = [];
  metadata[keys.indexOf('swell_dir')] = 1;
  metadata[keys.indexOf('is_powered')] = true;
  const bot = { registry, players: {} } as unknown as mineflayer.Bot;

  t.deepEqual(entityDetails(bot, { id: 2, name: 'creeper', type: 'hostile', metadata } as never), ['ABOUT TO EXPLODE', 'charged']);
  t.deepEqual(entityDetails(bot, { id: 3, name: 'creeper', type: 'hostile', metadata: [] } as never), []);
});

function connectionWithFakeBot() {
  const onEvent = sinon.stub();
  const connection = new BotConnection({ host: 'localhost', port: 25565, username: 'Bot' }, { onLog: sinon.stub(), onChatMessage: sinon.stub(), onEvent });
  const bot = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const client = new EventEmitter();
  const self = { id: 1, position: new Vec3(0, 64, 0) };
  const entities: Record<number, unknown> = { 1: self };
  Object.assign(bot, { _client: client, entity: self, entities, health: 20, username: 'Bot', quit: sinon.stub() });
  (connection as unknown as { registerEventHandlers: (b: unknown) => void }).registerEventHandlers(bot);
  return { client, entities, onEvent };
}

const soundAt = (x: number, y: number, z: number, extra: Record<string, unknown>) => ({ x: x * 8, y: y * 8, z: z * 8, volume: 1, ...extra });

test('hostile, named and loud sounds become events with a likely source', (t) => {
  const { client, entities, onEvent } = connectionWithFakeBot();
  entities[5] = { id: 5, name: 'zombie', type: 'hostile', position: new Vec3(6, 64, 0) };

  client.emit('sound_effect', soundAt(6, 64, 0, { sound: { soundId: 99 }, soundCategory: 'hostile' }));
  client.emit('sound_effect', soundAt(0, 64, -3, { sound: { data: { soundName: 'minecraft:entity.creeper.primed' } }, soundCategory: 'hostile' }));
  client.emit('sound_effect', soundAt(0, 64, 40, { sound: { soundId: 1 }, soundCategory: 'block', volume: 4 }));
  client.emit('entity_sound_effect', { sound: { soundId: 3 }, soundCategory: 'hostile', entityId: 5, volume: 1 });

  t.deepEqual(onEvent.getCalls().filter(call => call.args[0] === 'sound').map(call => call.args[1]), [
    'hostile sound from zombie (id 5), 6 blocks east',
    'entity.creeper.primed, 3 blocks north',
    'block sound, 40 blocks south (loud)'
  ]);
});

test('quiet, distant and own sounds are ignored', (t) => {
  const { client, onEvent } = connectionWithFakeBot();

  client.emit('sound_effect', soundAt(2, 64, 0, { sound: { soundId: 1 }, soundCategory: 'block' }));
  client.emit('sound_effect', soundAt(100, 64, 0, { sound: { soundId: 1 }, soundCategory: 'hostile' }));
  client.emit('entity_sound_effect', { sound: { soundId: 1 }, soundCategory: 'player', entityId: 1, volume: 1 });

  t.false(onEvent.calledWith('sound'));
});

test('explosions become events', (t) => {
  const { client, onEvent } = connectionWithFakeBot();

  client.emit('explosion', { center: { x: 8.5, y: 64, z: 8.5 }, radius: 3 });

  t.true(onEvent.calledWith('explosion', 'Explosion at (8, 64, 8), 13 blocks southeast'));
});

function waitSetup(bot: Record<string, unknown>) {
  const { factory, getTool } = createFactory();
  const store = new EventStore();
  registerEventTools(factory, store, asBot(bot));
  return { store, wait: getTool('wait-for-event')! };
}

const baseBot = () => ({ entity: { id: 1, position: new Vec3(0, 64, 0) }, entities: {}, health: 20 });

test('wait-for-event returns new matching events and ignores older ones', async (t) => {
  const { store, wait } = waitSetup(baseBot());
  store.addEvent('chat', 'old message');

  const pending = wait.execute({ types: ['damaged'], timeoutMs: 3000 });
  setTimeout(() => { store.addEvent('chat', 'not this'); store.addEvent('damaged', 'Health dropped from 20 to 18'); }, 300);
  const text = (await pending).content[0].text;

  t.true(text.startsWith('Event(s) after'));
  t.true(text.includes('[damaged] Health dropped from 20 to 18'));
  t.false(text.includes('old message'));
  t.false(text.includes('not this'));
});

test('wait-for-event returns for hostile mobs, low health and timeouts', async (t) => {
  const bot = baseBot();
  const hostile = waitSetup(bot);
  setTimeout(() => { (bot.entities as Record<number, unknown>)[4] = { id: 4, name: 'zombie', type: 'hostile', position: new Vec3(3, 64, 0) }; }, 200);
  const hostileText = (await hostile.wait.execute({ types: ['never'], hostileWithin: 5, timeoutMs: 3000 })).content[0].text;
  t.true(hostileText.startsWith('Hostile mob within 5 blocks: zombie [hostile], id 4'));

  const hurt = { ...baseBot(), health: 6.25 };
  const healthText = (await waitSetup(hurt).wait.execute({ healthBelow: 8, timeoutMs: 1000 })).content[0].text;
  t.is(healthText, 'Health is 6.3, below 8');

  const idle = (await waitSetup(baseBot()).wait.execute({ timeoutMs: 300 })).content[0].text;
  t.true(idle.startsWith('Nothing happened within 0.3s'));
});

test('wait-for-event is only registered when the bot is available', (t) => {
  const { factory, getTool } = createFactory();
  registerEventTools(factory, new EventStore());
  t.truthy(getTool('get-events'));
  t.falsy(getTool('wait-for-event'));
});
