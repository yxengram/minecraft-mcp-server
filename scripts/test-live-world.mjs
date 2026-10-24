// Full live test: exercises every MCP tool against a real server and MODIFIES THE WORLD.
// Only run it in a throwaway world with cheats enabled (the bot must be allowed to run commands).
//
//   npm run build
//   npm run test:live:world -- <LAN_PORT> --allow-world-changes
//
// It builds a floating stone arena at y=240 above the bot (removed again at the end), gives itself items, summons entities, changes
// time and game mode, and kills the bot at the end to test death/respawn events. A second
// in-process bot (MCPHelper) acts as another player for chat, whisper and follow tests.
// With OPENROUTER_API_KEY set, the decision model is used as well; without it, the no-key behavior is checked.

import { Vec3 } from 'vec3';
import { createArena, parseLiveArgs, responseText, SetupFailed, sleep } from './lib/live-arena.mjs';

const { port } = parseLiveArgs('This test');
const BOT_NAME = 'MCPWorldTest';
const HELPER_NAME = 'MCPHelper';
const hasDecisionKey = Boolean(process.env.OPENROUTER_API_KEY);

const session = createArena({
  port,
  botName: BOT_NAME,
  helperName: HELPER_NAME,
  clientName: 'minecraft-world-test',
  serverEnv: { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY }
});
const {
  client, covered, results, call, expect, expectIncludes, waitFor, cmd, position, inventoryCount, waitForCount, block,
  placeAndVerify, distanceTo, step
} = session;

async function startTask(behavior, params) {
  const started = await call('start-task', { behavior, params });
  expectIncludes(started, 'Started task', `start-task ${behavior}`);
  return started.match(/task (t\d+)/)[1];
}

// Waits for the task's final event (done, failed or cancelled) and fails unless it is task_done.
async function waitForTaskEnd(id, description, timeoutMs = 60000) {
  const line = await waitFor(async () => {
    const events = await call('get-events', { since: eventCursor, types: ['task_done', 'task_failed', 'task_cancelled'], limit: 100 });
    return events.split('\n').find(text => text.includes(`] ${id} `));
  }, description, timeoutMs);
  expect(line.includes(`[task_done] ${id} `), `${description}: the task did not finish successfully:\n${line}`);
  return line;
}

let cx, y0, cz;
let helper;
let eventCursor = 0;

try {
  const tools = await session.connect();
  await session.setup();
  ({ cx, y0, cz, helper } = session.arena);

  await step('read-only basics', async () => {
    expectIncludes(await call('detect-gamemode'), 'survival', 'detect-gamemode');
    const observation = await call('get-observation');
    expectIncludes(observation, 'Health:', 'get-observation');
    expect(!observation.includes('undefined'), `get-observation contains undefined:\n${observation}`);
    expectIncludes(await call('get-block-info', { x: cx, y: y0 - 1, z: cz }), 'stone', 'get-block-info');
    expectIncludes(await call('find-blocks', { blockType: 'stone', maxDistance: 4, count: 3 }), 'Found 3 stone', 'find-blocks');
    expectIncludes(await call('list-inventory'), 'empty', 'list-inventory');
  });

  await step('decisions: list-decision-models', async () => {
    const text = await call('list-decision-models');
    if (hasDecisionKey) {
      expect(/\d+ decision model\(s\); in use: /.test(text), `list-decision-models with a key:\n${text}`);
      expect(/^- \S+/m.test(text), `list-decision-models lists no model:\n${text}`);
    } else {
      expectIncludes(text, 'Not configured', 'list-decision-models without a key');
    }
    expectIncludes(await call('get-policy'), hasDecisionKey ? 'Decision model: enabled' : 'Decision model: disabled', 'get-policy decision status');
  });

  await step('policy: get-policy and set-policy', async () => {
    const defaults = await call('get-policy');
    expectIncludes(defaults, 'food 14', 'get-policy defaults');
    expectIncludes(defaults, 'attackPlayers: false', 'get-policy defaults');
    expectIncludes(defaults, 'Instinct checks:', 'get-policy instinct timing');
    // A local cursor: the shared eventCursor is only set by the next step.
    const since = Number((await call('get-events', { limit: 1 })).match(/nextSince: (\d+)/)[1]);
    try {
      expectIncludes(await call('set-policy', { instinct: { food: 10 } }), 'Changed: instinct.food', 'set-policy instinct.food');
      expectIncludes(await call('get-policy'), 'food 10', 'get-policy after set-policy');

      // A misspelled nested field is rejected and changes nothing.
      expectIncludes(await call('set-policy', { instinct: { fod: 14 } }, { expectError: true }), 'fod', 'set-policy misspelled field');
      expectIncludes(await call('get-policy'), 'food 10', 'get-policy after a rejected set-policy');

      expectIncludes(await call('set-policy', { combat: { attackPlayers: true } }), 'warning: attackPlayers enabled', 'set-policy attackPlayers warning');
      const events = await call('get-events', { since, types: ['policy'], limit: 20 });
      expectIncludes(events, '[policy] set-policy changed instinct.food', 'policy event for instinct.food');
      expectIncludes(events, '[policy] warning: attackPlayers enabled by set-policy', 'policy warning event');
    } finally {
      // Restore the defaults even if a check failed, so later steps never run with attackPlayers on.
      await call('set-policy', { instinct: { food: 14 }, combat: { attackPlayers: false } });
    }
    const restored = await call('get-policy');
    expectIncludes(restored, 'food 14', 'get-policy after restoring the defaults');
    expectIncludes(restored, 'attackPlayers: false', 'get-policy after restoring the defaults');
  });

  await step('players, chat and whispers', async () => {
    expectIncludes(await call('list-players'), HELPER_NAME, 'list-players');
    expectIncludes(await call('find-entity', { type: 'player', maxDistance: 16 }), HELPER_NAME, 'find-entity');
    expectIncludes(await call('list-entities', { type: 'player' }), HELPER_NAME, 'list-entities');

    helper.chat('hello from the helper');
    await waitFor(async () => (await call('read-chat', { count: 5 })).includes('hello from the helper'), 'read-chat');
    helper.whisper(BOT_NAME, 'secret message');
    await waitFor(async () => (await call('get-events', { types: ['whisper'] })).includes('secret message'), 'whisper event');
    const joined = await call('get-events', { types: ['player_joined'], limit: 100 });
    expectIncludes(joined, `${HELPER_NAME} joined`, 'get-events player_joined');
    eventCursor = Number((await call('get-events', { limit: 1 })).match(/nextSince: (\d+)/)[1]);
  });

  await step('movement', async () => {
    await call('move-to-position', { x: cx + 3, y: y0, z: cz + 3, range: 0, timeoutMs: 20000 });
    const [px, , pz] = await position();
    expect(px === cx + 3 && pz === cz + 3, `move-to-position ended at ${px}, ${pz}`);

    await call('look-at', { x: cx - 5, y: y0, z: cz + 3 });
    await call('jump');
    await sleep(500);
    await call('move-in-direction', { direction: 'forward', duration: 400 });
    const [mx] = await position();
    expect(mx < cx + 3, 'move-in-direction forward after look-at west did not move west');

    const pending = client.callTool({ name: 'move-to-position', arguments: { x: cx - 9, y: y0, z: cz - 9 } }, undefined, { timeout: 60000 });
    await sleep(300);
    await call('stop-pathfinding');
    expect((await pending).isError, 'stop-pathfinding did not cancel the running move');
    await call('move-to-position', { x: cx, y: y0, z: cz, range: 0, timeoutMs: 20000 });
  });

  await step('waypoints', async () => {
    expectIncludes(await call('set-waypoint', { name: 'Arena', x: cx, y: y0, z: cz, note: 'center' }), "Saved waypoint 'arena'", 'set-waypoint');
    expectIncludes(await call('list-waypoints'), '- arena:', 'list-waypoints');
    await call('move-to-position', { x: cx + 5, y: y0, z: cz + 5, range: 0, timeoutMs: 20000 });
    await call('goto-waypoint', { name: 'arena', range: 0, timeoutMs: 20000 });
    const [px, , pz] = await position();
    expect(px === cx && pz === cz, `goto-waypoint ended at ${px}, ${pz}`);
    await call('delete-waypoint', { name: 'arena' });
    await call('goto-waypoint', { name: 'arena' }, { expectError: true });
  });

  await step('follow and flee', async () => {
    await call('follow-entity', { type: HELPER_NAME, range: 2 });
    await waitFor(async () => (await distanceTo(HELPER_NAME)) <= 3.5, 'bot to reach the helper', 15000);
    await call('stop-pathfinding');
    await call('flee-from', { type: HELPER_NAME, distance: 7 });
    await waitFor(async () => (await distanceTo(HELPER_NAME)) >= 6.5, 'bot to flee from the helper', 15000);
    await call('stop-pathfinding');
    await call('move-to-position', { x: cx, y: y0, z: cz, range: 0, timeoutMs: 20000 });
  });

  await step('tasks: start, interrupt with a manual command, resume, cancel', async () => {
    const started = await call('start-task', { behavior: 'follow', params: { target: HELPER_NAME, range: 2 } });
    expectIncludes(started, 'Started task', 'start-task');
    const id = started.match(/task (t\d+)/)[1];
    await waitFor(async () => (await distanceTo(HELPER_NAME)) <= 3.5, 'the follow task to reach the helper', 15000);
    expectIncludes(await call('list-tasks'), `${id} follow [running]`, 'list-tasks running');

    const moved = await call('move-to-position', { x: cx + 4, y: y0, z: cz + 4, range: 0, timeoutMs: 20000 });
    expectIncludes(moved, `Interrupted before this command: task ${id} follow`, 'interruption report');
    expectIncludes(moved, `resume-task ${id}`, 'interruption report advice');
    expectIncludes(await call('list-tasks'), `${id} follow [paused]`, 'list-tasks paused');
    await sleep(1500);
    expect((await distanceTo(HELPER_NAME)) > 6, 'a manually paused task must not keep following');

    expectIncludes(await call('resume-task', { id }), `Resumed task ${id}`, 'resume-task');
    await waitFor(async () => (await distanceTo(HELPER_NAME)) <= 3.5, 'the resumed task to reach the helper again', 15000);
    expectIncludes(await call('cancel-task', { id }), `Cancelled task ${id}`, 'cancel-task');

    const events = await call('get-events', { since: eventCursor, types: ['task_started', 'task_paused', 'task_resumed', 'task_cancelled'], limit: 50 });
    for (const type of ['task_started', 'task_paused', 'task_resumed', 'task_cancelled']) {
      expectIncludes(events, `[${type}] ${id} follow`, `${type} event`);
    }
    await call('move-to-position', { x: cx, y: y0, z: cz, range: 0, timeoutMs: 20000 });
  });

  await step('inventory', async () => {
    await cmd('/give @s golden_apple 1');
    await cmd('/give @s dirt 16');
    await cmd('/give @s iron_helmet 1');
    await waitForCount('dirt', count => count >= 16, 'items to arrive');

    expectIncludes(await call('find-item', { nameOrType: 'helmet' }), 'iron_helmet', 'find-item');
    await call('equip-item', { itemName: 'iron_helmet', destination: 'head' });
    expectIncludes(await call('get-observation', { maxEntities: 0 }), 'head: iron_helmet', 'equip-item head');
    await call('unequip-item', { destination: 'head' });
    expectIncludes(await call('get-observation', { maxEntities: 0 }), 'Equipment: none', 'unequip-item');

    const dirtBefore = await inventoryCount('dirt');
    await call('toss-item', { itemName: 'dirt', count: 2 });
    await waitForCount('dirt', count => count === dirtBefore - 2, 'toss-item to drop 2 dirt');
    await call('consume', { itemName: 'golden_apple' }, { timeout: 30000 });
    await waitForCount('golden_apple', count => count === 0, 'golden apple to be eaten');
    await cmd(`/kill @e[type=item,distance=..16]`);
  });

  await step('perception: effects, armor, entity details, messages, damage source', async () => {
    await cmd('/give @s iron_helmet 1');
    await waitForCount('iron_helmet', count => count >= 1, 'a helmet');
    await call('equip-item', { itemName: 'iron_helmet', destination: 'head' });
    await cmd('/effect give @s minecraft:night_vision 60 0');
    const observation = await call('get-observation', { maxEntities: 0 });
    expectIncludes(observation, 'Night Vision I', 'get-observation effects');
    expectIncludes(observation, 'Armor: 2/20', 'get-observation armor');
    await call('unequip-item', { destination: 'head' });
    await cmd('/effect clear @s');

    await cmd(`/summon pig ${cx - 3} ${y0} ${cz - 3} {NoAI:1b,Age:-24000,CustomName:"Bacon"}`);
    await waitFor(async () => (await call('list-entities', { type: 'pig' })).includes('named "Bacon", baby'), 'baby pig details');
    await call('toss-item', { itemName: 'dirt', count: 1 });
    await waitFor(async () => (await call('list-entities', { type: 'dirt', maxDistance: 8 })).includes('dirt x1 [dropped item]'), 'dropped item name');

    await cmd('/title @s actionbar {"text":"mcp action bar"}');
    const messages = await call('read-chat', { count: 20 });
    expectIncludes(messages, '[action bar] mcp action bar', 'read-chat action bar');
    expectIncludes(messages, '[system] Summoned new Bacon', 'read-chat system message');

    await sleep(1500);
    await cmd(`/damage ${BOT_NAME} 1 minecraft:mob_attack by @e[type=pig,limit=1,sort=nearest]`);
    await waitFor(async () => (await call('get-events', { types: ['damaged'], limit: 5 })).includes('mob_attack from pig'), 'damage source');
    await cmd('/kill @e[type=pig,distance=..16]');
    await cmd('/kill @e[type=item,distance=..16]');
  });

  await step('perception: item and block details, cursor, sounds, wait-for-event', async () => {
    await cmd('/give @s diamond_sword[damage=100,enchantments={sharpness:3},custom_name="Blade"]');
    await waitFor(async () => (await call('list-inventory')).includes('"Blade", durability 1461/1561, sharpness III'), 'item details');

    await cmd(`/setblock ${cx - 2} ${y0} ${cz + 3} oak_sign[rotation=4]{front_text:{messages:["mcp","test","",""]}}`);
    await sleep(500);
    const info = await call('get-block-info', { x: cx - 2, y: y0, z: cz + 3 });
    expectIncludes(info, 'Sign text (front): "mcp / test"', 'get-block-info sign text');
    expectIncludes(info, 'State: ', 'get-block-info state');
    expectIncludes(info, 'Light: ', 'get-block-info light');
    expectIncludes(info, 'Biome: ', 'get-block-info biome');

    await call('move-to-position', { x: cx, y: y0, z: cz, range: 0, timeoutMs: 20000 });
    await call('look-at', { x: cx + 0.5, y: y0 - 1, z: cz + 2.5 });
    const cursor = await call('get-cursor-target');
    expectIncludes(cursor, 'Looking at stone', 'get-cursor-target block');
    expectIncludes(cursor, ', top', 'get-cursor-target face');

    for (const [toolArgs, trigger, expected] of [
      [{ types: ['sound'], timeoutMs: 10000 }, '/playsound minecraft:entity.creeper.primed hostile @s ~2 ~ ~', 'entity.creeper.primed'],
      [{ types: ['never'], hostileWithin: 6, timeoutMs: 10000 }, `/summon zombie ${cx - 4} ${y0} ${cz} {NoAI:1b,PersistenceRequired:1b}`, 'Hostile mob within 6 blocks: zombie']
    ]) {
      covered.add('wait-for-event');
      const pending = client.callTool({ name: 'wait-for-event', arguments: toolArgs }, undefined, { timeout: 30000 });
      await sleep(500);
      await cmd(trigger);
      expectIncludes(responseText(await pending), expected, `wait-for-event ${JSON.stringify(toolArgs)}`);
    }
    expectIncludes(await call('wait-for-event', { types: ['never'], timeoutMs: 500 }), 'Nothing happened', 'wait-for-event timeout');
    await cmd('/kill @e[type=zombie,distance=..16]');
    await cmd(`/setblock ${cx - 2} ${y0} ${cz + 3} air`);
  });

  await step('blocks: place, dig, fill, clear, tunnel', async () => {
    await placeAndVerify('dirt', cx + 3, y0, cz);
    await call('dig-block', { x: cx + 3, y: y0, z: cz });
    expect((await block(cx + 3, y0, cz)) === 'air', 'dig-block did not remove the block');

    expectIncludes(await call('fill-region', { x1: cx + 3, y1: y0, z1: cz - 1, x2: cx + 4, y2: y0, z2: cz, blockName: 'dirt' }), 'placed 4', 'fill-region');
    expectIncludes(await call('clear-region', { x1: cx + 3, y1: y0, z1: cz - 1, x2: cx + 4, y2: y0, z2: cz }), 'dug 4', 'clear-region');
    for (const [x, z] of [[cx + 3, cz - 1], [cx + 4, cz]]) {
      expect((await block(x, y0, z)) === 'air', `clear-region left a block at ${x}, ${z}`);
    }

    await call('move-to-position', { x: cx - 2, y: y0, z: cz + 6, range: 0, timeoutMs: 20000 });
    await cmd(`/fill ${cx - 6} ${y0} ${cz + 6} ${cx - 3} ${y0 + 1} ${cz + 6} stone`);
    await sleep(500);
    expectIncludes(await call('dig-tunnel', { direction: 'west', length: 4, height: 2 }), 'dug 8', 'dig-tunnel');
    await cmd(`/kill @e[type=item,distance=..16]`);
  });

  await step('activate-block (lever)', async () => {
    await cmd(`/setblock ${cx + 2} ${y0} ${cz - 3} lever[face=floor,powered=false]`);
    await sleep(500);
    await call('activate-block', { x: cx + 2, y: y0, z: cz - 3 });
    await waitFor(() => helper.blockAt(new Vec3(cx + 2, y0, cz - 3))?.getProperties().powered === true,
      'the lever to be powered', 5000);
  });

  await step('collect-block', async () => {
    await cmd(`/fill ${cx - 5} ${y0} ${cz - 5} ${cx - 5} ${y0 + 2} ${cz - 5} oak_log`);
    await sleep(500);
    expectIncludes(await call('collect-block', { blockType: 'oak_log', count: 3, timeoutMs: 60000 }), 'Mined 3 of 3 oak_log', 'collect-block');
    await waitForCount('oak_log', count => count >= 3, 'logs to be picked up');
  });

  await step('crafting', async () => {
    expectIncludes(await call('get-recipe', { itemName: 'chest' }), 'chest', 'get-recipe');
    expectIncludes(await call('can-craft', { itemName: 'chest' }), 'Missing', 'can-craft without planks');
    await call('craft-item', { outputItem: 'oak_planks', amount: 2 });
    await waitForCount('oak_planks', count => count >= 8, 'planks to be crafted');
    expectIncludes(await call('list-recipes', { outputItem: 'crafting_table' }), 'crafting_table', 'list-recipes');

    expectIncludes(await call('craft-item', { outputItem: 'chest' }, { expectError: true }), 'needs a crafting table', 'craft-item without a table');
    await call('craft-item', { outputItem: 'crafting_table' });
    await placeAndVerify('crafting_table', cx + 2, y0, cz + 4);
    await cmd('/give @s oak_planks 4');
    await waitForCount('oak_planks', count => count >= 8, 'extra planks');
    await call('craft-item', { outputItem: 'chest' });
    await waitForCount('chest', count => count >= 1, 'chest to be crafted');
  });

  await step('containers', async () => {
    await placeAndVerify('chest', cx + 4, y0, cz + 4);
    const at = { x: cx + 4, y: y0, z: cz + 4 };
    expectIncludes(await call('read-container', at), 'is empty', 'read-container');
    await call('container-deposit', { ...at, itemName: 'dirt', count: 5 });
    expectIncludes(await call('read-container', at), 'dirt x5', 'container-deposit');
    await call('container-withdraw', { ...at, itemName: 'dirt', count: 2 });
    expectIncludes(await call('read-container', at), 'dirt x3', 'container-withdraw');
    await call('container-withdraw', { ...at, itemName: 'diamond' }, { expectError: true });
  });

  await step('vision: scan-area and render-map', async () => {
    const scan = await call('scan-area', { radius: 12 });
    expectIncludes(scan, 'View: surface', 'scan-area view');
    expectIncludes(scan, 'Surface: stone', 'scan-area surface');
    expectIncludes(scan, '- chest x1', 'scan-area notable blocks');
    expectIncludes(scan, '- crafting_table x1', 'scan-area notable blocks');
    expectIncludes(scan, HELPER_NAME, 'scan-area entities');
    expectIncludes(await call('scan-area', { radius: 6, view: 'current-level' }), 'Open space at this level', 'scan-area current-level');

    for (const toolArgs of [{ radius: 16 }, { mode: 'slice', radius: 12 }, { mode: 'slice', axis: 'z', radius: 12 }]) {
      covered.add('render-map');
      const result = await client.callTool({ name: 'render-map', arguments: toolArgs }, undefined, { timeout: 60000 });
      expect(!result.isError, `render-map ${JSON.stringify(toolArgs)} failed: ${responseText(result)}`);
      const image = result.content.find(item => item.type === 'image');
      expect(image?.mimeType === 'image/png', `render-map ${JSON.stringify(toolArgs)} returned no PNG`);
      const png = Buffer.from(image.data, 'base64');
      expect(png.subarray(1, 4).toString() === 'PNG' && png.length > 500, `render-map ${JSON.stringify(toolArgs)} returned an invalid PNG`);
      expectIncludes(responseText(result), 'Colors: ', `render-map ${JSON.stringify(toolArgs)} legend`);
    }
  });

  await step('smelt-item', async () => {
    await cmd('/give @s furnace 1');
    await cmd('/give @s raw_iron 1');
    await cmd('/give @s coal 1');
    await waitForCount('coal', count => count >= 1, 'furnace items');
    await placeAndVerify('furnace', cx + 4, y0, cz + 6);
    expectIncludes(await call('smelt-item', { x: cx + 4, y: y0, z: cz + 6, inputItem: 'raw_iron', fuelItem: 'coal', timeoutMs: 30000 }, { timeout: 60000 }),
      'Smelted', 'smelt-item');
    await waitForCount('iron_ingot', count => count >= 1, 'iron ingot');
  });

  await step('entities: attack, interact, ride', async () => {
    await call('move-to-position', { x: cx, y: y0, z: cz, range: 0, timeoutMs: 20000 });
    await cmd(`/summon pig ${cx - 2} ${y0} ${cz} {NoAI:1b,Health:1f}`);
    await sleep(1000);
    const pigId = Number((await call('list-entities', { type: 'pig' })).match(/id (\d+)/)[1]);
    await call('activate-entity', { entityId: pigId });
    expectIncludes(await call('attack-entity', { entityId: pigId, times: 3 }), 'target is gone', 'attack-entity');

    await cmd(`/summon minecart ${cx + 1} ${y0} ${cz - 2}`);
    await sleep(1000);
    await call('mount-entity', { type: 'minecart' });
    await sleep(1500);
    expectIncludes(await call('dismount'), 'Dismounted', 'dismount');
    expectIncludes(await call('dismount'), 'Not riding anything', 'dismount when not riding');
    await cmd('/kill @e[type=minecart,distance=..16]');
  });

  await step('trading with a villager', async () => {
    await call('move-to-position', { x: cx, y: y0, z: cz, range: 0, timeoutMs: 20000 });
    await cmd('/clear @s emerald');
    await cmd('/clear @s bread');
    // A still farmer with one fixed trade: 1 emerald -> 6 bread, 3 uses.
    await cmd(`/summon villager ${cx - 2} ${y0} ${cz + 2} {NoAI:1b,Invulnerable:1b,VillagerData:{profession:"minecraft:farmer",level:2,type:"minecraft:plains"},Offers:{Recipes:[{buy:{id:"minecraft:emerald",count:1},sell:{id:"minecraft:bread",count:6},maxUses:3,rewardExp:0b}]}}`);
    await cmd(`/summon pig ${cx + 2} ${y0} ${cz + 2} {NoAI:1b}`);
    await cmd('/give @s emerald 5');
    await waitForCount('emerald', count => count >= 5, 'emeralds');
    await sleep(1000);
    const list = await call('list-trades');
    expectIncludes(list, '(farmer)', 'list-trades profession');
    expectIncludes(list, '1. 1 emerald -> 6 bread; used 0 of 3; you can afford 3 time(s)', 'list-trades');
    expectIncludes(await call('trade', { index: 1, times: 2 }), 'gave 2 emerald, got 12 bread', 'trade');
    await waitForCount('bread', count => count >= 12, 'bread from the trade');
    expectIncludes(await call('trade', { index: 1, times: 2 }, { expectError: true }), 'has only 1 use(s) left', 'trade beyond the stock');
    expectIncludes(await call('trade', { index: 2 }, { expectError: true }), 'There is no trade 2', 'trade number not listed');
    expectIncludes(await call('list-trades', { type: 'pig' }, { expectError: true }), 'is not a villager', 'list-trades with a pig');
    await cmd('/kill @e[type=villager,distance=..16]');
    await cmd('/kill @e[type=pig,distance=..16]');
  });

  await step('ground-height (M18)', async () => {
    await call('move-to-position', { x: cx, y: y0, z: cz, range: 0, timeoutMs: 20000 });
    expectIncludes(await call('ground-height', { x: cx + 3, z: cz + 3 }), `ground at y=${y0 - 1} (stone), stand at y=${y0}`, 'ground-height on the arena floor');
    expectIncludes(await call('ground-height', { x: cx + 3000, z: cz }), 'not loaded', 'ground-height far away');
    const line = await call('ground-height', { direction: 'east', distance: 8, step: 4 });
    expect(line.split('\n').filter(text => text.startsWith('- ')).length === 2, `ground-height along a line:\n${line}`);
    await cmd(`/setblock ${cx + 4} ${y0} ${cz - 4} water`);
    try {
      await sleep(500);
      expectIncludes(await call('ground-height', { x: cx + 4, z: cz - 4 }), `water surface at y=${y0}`, 'ground-height on water');
    } finally {
      await cmd(`/fill ${cx - 9} ${y0} ${cz - 9} ${cx + 9} ${y0 + 2} ${cz + 9} air replace water`);
    }
  });

  await step('lead-animal: by lure and on a lead (M18)', async () => {
    await call('move-to-position', { x: cx, y: y0, z: cz, range: 0, timeoutMs: 20000 });
    await cmd('/kill @e[type=cow,distance=..32]');
    await cmd('/clear @s wheat');
    await cmd('/clear @s lead');
    await cmd(`/summon cow ${cx - 6} ${y0} ${cz - 6}`);
    await cmd('/give @s wheat 4');
    await waitForCount('wheat', count => count >= 4, 'wheat');
    await sleep(1000);
    const cowNear = async (x, z) => {
      const text = await call('list-entities', { type: 'cow', maxDistance: 32 });
      const at = text.match(/cow \[animal\], id \d+, at \((-?\d+), (-?\d+), (-?\d+)\)/);
      return at && Math.hypot(Number(at[1]) - x, Number(at[3]) - z) <= 3;
    };
    try {
      expectIncludes(await call('lead-animal', { type: 'cow', x: cx + 6, y: y0, z: cz + 6, method: 'lure', timeoutMs: 120000 }, { timeout: 150000 }),
        'by lure (wheat)', 'lead-animal by lure');
      expect(await cowNear(cx + 6, cz + 6), 'the cow is not by the lure target');
      await cmd('/give @s lead 1');
      await waitForCount('lead', count => count >= 1, 'a lead');
      expectIncludes(await call('lead-animal', { type: 'cow', x: cx - 6, y: y0, z: cz - 6, method: 'leash', timeoutMs: 120000 }, { timeout: 150000 }),
        'on a lead', 'lead-animal on a lead');
      expect(await cowNear(cx - 6, cz - 6), 'the cow is not by the lead target');
      await waitForCount('lead', count => count >= 1, 'the lead back in the inventory');
      await cmd('/clear @s lead');
      expectIncludes(await call('lead-animal', { type: 'cow', x: cx, y: y0, z: cz, method: 'leash' }, { expectError: true }), 'No lead', 'lead-animal with no lead left');
    } finally {
      await cmd('/kill @e[type=cow,distance=..32]');
      await cmd('/clear @s wheat');
    }
  });

  await step('tasks: guard the helper (kills hostiles, spares animals)', async () => {
    // The helper stays in creative mode (set up above), so the zombie cannot hurt it.
    await cmd(`/gamemode creative ${HELPER_NAME}`);
    await cmd(`/tp ${HELPER_NAME} ${cx} ${y0} ${cz - 7}`);
    await call('move-to-position', { x: cx, y: y0, z: cz - 4, range: 0, timeoutMs: 20000 });
    const id = await startTask('guard', { target: HELPER_NAME, radius: 8 });
    await sleep(1000);

    // A pig inside the radius must be left alone; the zombie must be killed.
    await cmd(`/summon pig ${cx - 3} ${y0} ${cz - 6} {NoAI:1b,PersistenceRequired:1b,CustomName:"Wilbur"}`);
    await cmd(`/summon zombie ${cx + 3} ${y0} ${cz - 5} {NoAI:1b,PersistenceRequired:1b}`);
    // Keep daylight from burning the zombie, so the kill is the bot's.
    await cmd('/effect give @e[type=zombie,distance=..32] minecraft:fire_resistance 60 0 true');
    await waitFor(async () => (await call('get-events', { since: eventCursor, types: ['task_progress'], limit: 100 }))
      .includes(`[task_progress] ${id} guard: killed zombie`), 'the guard task to kill the zombie', 30000);
    expect((await distanceTo('zombie')) === Infinity, 'the zombie is still alive after the kill report');
    expectIncludes(await call('list-tasks'), `${id} guard [running]`, 'list-tasks guard running');
    expectIncludes(await call('cancel-task', { id }), `Cancelled task ${id}`, 'cancel-task guard');
    expectIncludes(await call('list-entities', { type: 'pig', maxDistance: 32 }), 'named "Wilbur"', 'pig inside the guard radius');

    await cmd('/kill @e[type=zombie,distance=..32]');
    await cmd('/kill @e[type=pig,distance=..32]');
    await cmd('/kill @e[type=item,distance=..32]');
    await call('move-to-position', { x: cx, y: y0, z: cz, range: 0, timeoutMs: 20000 });
  });

  await step('tasks: gather', async () => {
    const logs = [[cx - 6, cz - 2], [cx - 6, cz], [cx - 6, cz + 2]];
    for (const [x, z] of logs) await cmd(`/setblock ${x} ${y0} ${z} oak_log`);
    await sleep(500);
    const before = await inventoryCount('oak_log');
    const id = await startTask('gather', { blockType: 'oak_log', count: 3 });
    expectIncludes(await waitForTaskEnd(id, 'the gather task to finish', 90000), 'Mined 3 of 3 oak_log', 'gather result');
    await waitForCount('oak_log', count => count >= before + 3, 'gathered logs to be picked up');
    for (const [x, z] of logs) {
      expect((await block(x, y0, z)) === 'air', `gather left an oak_log at ${x}, ${z}`);
    }
    await cmd('/kill @e[type=item,distance=..32]');
  });

  await step('tasks: hunt (and never players)', async () => {
    await call('move-to-position', { x: cx, y: y0, z: cz, range: 0, timeoutMs: 20000 });
    await cmd(`/summon cow ${cx - 4} ${y0} ${cz - 3} {NoAI:1b,PersistenceRequired:1b}`);
    await sleep(1000);
    const before = await inventoryCount('beef');
    const id = await startTask('hunt', { animal: 'cow' });
    expectIncludes(await waitForTaskEnd(id, 'the hunt task to finish', 60000), 'Killed 1 of 1 cow', 'hunt result');
    await waitForCount('beef', count => count > before, 'beef from the hunted cow');

    expectIncludes(await call('start-task', { behavior: 'hunt', params: { animal: 'player' } }, { expectError: true }),
      'Players cannot be hunted', 'start-task hunt player');
    await cmd('/kill @e[type=cow,distance=..32]');
    await cmd('/kill @e[type=item,distance=..32]');
  });

  await step('tasks: return-home (daytime)', async () => {
    expectIncludes(await call('set-waypoint', { name: 'home', x: cx - 4, y: y0, z: cz }), "Saved waypoint 'home'", 'set-waypoint home');
    await call('move-to-position', { x: cx + 5, y: y0, z: cz + 1, range: 0, timeoutMs: 20000 });
    await cmd('/time set day');
    const id = await startTask('return-home', {});
    const done = await waitForTaskEnd(id, 'the return-home task to finish', 60000);
    expectIncludes(done, "Arrived at waypoint 'home'", 'return-home result');
    expectIncludes(done, 'daytime', 'return-home result');
    const [px, , pz] = await position();
    expect(Math.hypot(px - (cx - 4), pz - cz) <= 3, `return-home ended at ${px}, ${pz}`);
    await call('delete-waypoint', { name: 'home' });
    await call('move-to-position', { x: cx, y: y0, z: cz, range: 0, timeoutMs: 20000 });
  });

  await step('sleep and wake', async () => {
    await cmd(`/setblock ${cx - 3} ${y0} ${cz + 3} red_bed[part=foot,facing=east]`);
    await cmd(`/setblock ${cx - 2} ${y0} ${cz + 3} red_bed[part=head,facing=east]`);
    await cmd('/time set midnight');
    await sleep(1000);
    expectIncludes(await call('sleep', {}), 'Sleeping in red_bed', 'sleep');
    expectIncludes(await call('sleep', {}), 'Already sleeping', 'sleep twice');
    expectIncludes(await call('wake'), 'Woke up', 'wake');
    await cmd('/time set day');
  });

  await step('use-item: buckets, and activate-block when nothing changes (M15)', async () => {
    try {
      await bucketChecks();
    } finally {
      // Water left on the arena floor spreads and pushes the bot around in every later step.
      await cmd(`/fill ${cx - 9} ${y0} ${cz - 9} ${cx + 9} ${y0 + 5} ${cz + 9} air replace water`);
      await cmd(`/fill ${cx - 9} ${y0} ${cz - 9} ${cx + 9} ${y0 + 5} ${cz + 9} air replace lava`);
      await cmd('/clear @s lava_bucket');
      await cmd('/clear @s water_bucket');
    }
  });

  async function bucketChecks() {
    await call('move-to-position', { x: cx, y: y0, z: cz, range: 0, timeoutMs: 20000 });
    await cmd('/clear @s water_bucket');
    await cmd('/clear @s bucket');
    await cmd('/give @s water_bucket');
    await waitForCount('water_bucket', count => count >= 1, 'a water bucket');
    await call('equip-item', { itemName: 'water_bucket' });
    expectIncludes(await call('activate-block', { x: cx + 2, y: y0 - 1, z: cz + 2 }), 'no visible change', 'activate-block with a bucket');
    expect((await block(cx + 2, y0, cz + 2)) === 'air', 'activate-block poured water');
    expectIncludes(await call('use-item', { itemName: 'water_bucket', x: cx + 2, y: y0, z: cz + 2 }), 'the cell is now water', 'use-item pours water');
    expect((await block(cx + 2, y0, cz + 2)) === 'water', 'no water after use-item');
    expectIncludes(await call('use-item', { itemName: 'bucket', x: cx + 2, y: y0, z: cz + 2 }), 'holding water_bucket', 'use-item fills the bucket');
    await waitFor(async () => (await block(cx + 2, y0, cz + 2)) === 'air', 'the water to be gone', 5000);
    expectIncludes(await call('use-item', { itemName: 'water_bucket', x: cx + 2, y: y0 + 4, z: cz + 2 }, { expectError: true }),
      'no solid block next to it', 'use-item into the air');
    await cmd('/give @s lava_bucket');
    await waitForCount('lava_bucket', count => count >= 1, 'a lava bucket');
    expectIncludes(await call('use-item', { itemName: 'lava_bucket', x: cx + 1, y: y0, z: cz }, { expectError: true }),
      'in or next to the bot', 'use-item refuses lava next to the bot');
  }

  await step('dig-block: obsidian with a diamond pickaxe, and no pickaxe (M15)', async () => {
    await cmd('/clear @s obsidian');
    await cmd('/give @s diamond_pickaxe');
    await waitForCount('diamond_pickaxe', count => count >= 1, 'a diamond pickaxe');
    await cmd(`/setblock ${cx + 2} ${y0} ${cz - 2} obsidian`);
    await sleep(500);
    const started = Date.now();
    const dug = await call('dig-block', { x: cx + 2, y: y0, z: cz - 2 }, { timeout: 90000 });
    const seconds = (Date.now() - started) / 1000;
    expectIncludes(dug, 'with diamond_pickaxe', 'dig-block picks the pickaxe');
    // 9.4 s in the game; before M15 mineflayer waited 75 s.
    expect(seconds < 20, `digging obsidian took ${seconds.toFixed(1)} s`);
    expect((await block(cx + 2, y0, cz - 2)) === 'air', 'the obsidian is still there');
    await call('move-to-position', { x: cx + 2, y: y0, z: cz - 2, range: 0, timeoutMs: 20000 });
    await waitForCount('obsidian', count => count >= 1, 'the obsidian drop');
    await cmd('/clear @s diamond_pickaxe');
    await cmd(`/setblock ${cx + 3} ${y0} ${cz - 2} obsidian`);
    await sleep(500);
    expectIncludes(await call('dig-block', { x: cx + 3, y: y0, z: cz - 2 }, { expectError: true }), 'Cannot harvest obsidian', 'dig-block without a pickaxe');
    await cmd(`/setblock ${cx + 3} ${y0} ${cz - 2} air`);
  });

  await step('portals: light, walk in, sleep refused in the Nether, walk back (M15)', async () => {
    try {
      await portalChecks();
    } finally {
      // Whatever happened, bring the bot back to the overworld arena and remove the frame.
      if (!(await call('get-observation')).includes('dimension: overworld')) {
        await cmd(`/execute in minecraft:overworld run tp @s ${cx} ${y0} ${cz}`);
        await sleep(3000);
      }
      await cmd(`/fill ${cx + 2} ${y0} ${cz + 6} ${cx + 5} ${y0 + 3} ${cz + 6} air`);
      await cmd(`/fill ${cx + 2} ${y0 - 1} ${cz + 6} ${cx + 5} ${y0 - 1} ${cz + 6} stone`);
      await cmd('/clear @s flint_and_steel');
      for (const name of ['live-portal', 'live-portal-nether']) {
        try { await call('delete-waypoint', { name }); } catch { /* not saved */ }
      }
    }
  });

  async function portalChecks() {
    await call('move-to-position', { x: cx, y: y0, z: cz, range: 0, timeoutMs: 20000 });
    // A frame on the arena edge: interior x cx+3..cx+4, y y0..y0+2, z cz+6; the bottom row replaces the floor.
    await cmd(`/fill ${cx + 2} ${y0 - 1} ${cz + 6} ${cx + 5} ${y0 + 3} ${cz + 6} obsidian`);
    await cmd(`/fill ${cx + 3} ${y0} ${cz + 6} ${cx + 4} ${y0 + 2} ${cz + 6} air`);
    await cmd('/give @s flint_and_steel');
    await cmd('/effect give @s fire_resistance 300 0 true');
    await waitForCount('flint_and_steel', count => count >= 1, 'flint and steel');
    await call('move-to-position', { x: cx + 3, y: y0, z: cz + 4, range: 0, timeoutMs: 20000 });
    await call('equip-item', { itemName: 'flint_and_steel' });
    const lit = await call('activate-block', { x: cx + 3, y: y0 - 1, z: cz + 6 });
    expect(!lit.includes('no visible change'), `lighting the portal was reported as no change: ${lit}`);
    await waitFor(async () => (await block(cx + 3, y0, cz + 6)) === 'nether_portal', 'the portal to light', 5000);
    await call('set-waypoint', { name: 'live-portal', x: cx + 3, y: y0, z: cz + 6 });
    expectIncludes(await call('goto-waypoint', { name: 'live-portal', timeoutMs: 20000 }, { timeout: 40000 }), 'now in the_nether', 'goto-waypoint into the portal');
    expectIncludes(await call('sleep', {}, { expectError: true }), 'Beds explode in the_nether', 'sleep in the Nether');
    expectIncludes(await call('get-observation'), 'no day or night in the_nether', 'get-observation in the Nether');
    const [nx, ny, nz] = await position();
    await call('set-waypoint', { name: 'live-portal-nether' });
    // Ghasts can blow up the Nether side while the bot waits out the cooldown: remember its cells and their axis.
    const portalCells = [...(await call('find-blocks', { blockType: 'nether_portal', maxDistance: 4, count: 6 }))
      .matchAll(/\((-?\d+), (-?\d+), (-?\d+)\)/g)].map(m => m.slice(1).map(Number));
    const axis = (await call('get-block-info', { x: nx, y: ny, z: nz })).match(/axis=(\w)/)?.[1] ?? 'x';
    // Arriving in a portal does not count as entering it: step out before walking back in.
    let out = false;
    for (const [dx, dz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      try {
        await call('move-to-position', { x: nx + dx, y: ny, z: nz + dz, range: 0, timeoutMs: 8000 });
      } catch {
        continue;
      }
      if ((await block(...(await position()))) !== 'nether_portal') { out = true; break; }
    }
    expect(out, 'could not step out of the Nether portal');
    // The portal cooldown after a trip (about 15 s) restarts whenever the bot touches a portal.
    await sleep(17000);
    let repaired = 0;
    for (const [x, y, z] of portalCells) {
      if ((await block(x, y, z)) !== 'nether_portal') {
        await cmd(`/setblock ${x} ${y} ${z} nether_portal[axis=${axis}]`);
        repaired++;
      }
    }
    if (repaired > 0) console.log(`    (the Nether side lost ${repaired} portal block(s), probably to a ghast; restored by command)`);
    expectIncludes(await call('goto-waypoint', { name: 'live-portal-nether', timeoutMs: 20000 }, { timeout: 40000 }), 'now in overworld', 'goto-waypoint back');
    const [bx, , bz] = await position();
    expect(Math.hypot(bx - (cx + 3.5), bz - (cz + 6.5)) <= 3, `came back at ${bx}, ${bz}, not by the arena portal`);
    await call('move-to-position', { x: cx, y: y0, z: cz, range: 0, timeoutMs: 20000 });
  }

  await step('fly-to (creative)', async () => {
    await call('move-to-position', { x: cx, y: y0, z: cz, range: 0, timeoutMs: 20000 });
    await cmd('/gamemode creative @s');
    await sleep(1000);
    await call('fly-to', { x: cx + 2, y: y0 + 3, z: cz + 2 }, { timeout: 30000 });
    const [, py] = await position();
    expect(py >= y0 + 2, `fly-to ended at y=${py}`);
    await cmd('/gamemode survival @s');
    await sleep(1500);
  });

  await step('a move stops when the bot dies (M16)', async () => {
    await call('move-to-position', { x: cx - 8, y: y0, z: cz - 8, range: 0, timeoutMs: 20000 });
    const moving = call('move-to-position', { x: cx + 8, y: y0, z: cz + 8, range: 0, timeoutMs: 30000 }, { expectError: true, timeout: 60000 });
    await sleep(600);
    await cmd('/kill @s');
    const reply = await moving;
    expectIncludes(reply, 'The bot died during move-to-position', 'move-to-position after a death');
    expectIncludes(reply, 'the command was stopped', 'move-to-position after a death');
    // The respawned bot must not walk on toward the old target.
    const [ax, , az] = await position();
    await sleep(3000);
    const [bx, , bz] = await position();
    expect(Math.hypot(bx - ax, bz - az) <= 2, `after the respawn the bot moved from ${ax}, ${az} to ${bx}, ${bz}`);
    await cmd(`/tp @s ${cx} ${y0} ${cz}`);
    await sleep(1000);
  });

  await step('events: pickup, damage, death and respawn', async () => {
    const pickups = await call('get-events', { types: ['item_picked_up'], limit: 100 });
    expectIncludes(pickups, 'Picked up', 'item_picked_up events');
    await cmd(`/damage ${BOT_NAME} 2`);
    await waitFor(async () => (await call('get-events', { since: eventCursor, types: ['damaged'] })).includes('Health dropped'), 'damaged event');
    await cmd('/kill @s');
    await waitFor(async () => (await call('get-events', { since: eventCursor, types: ['death'] })).includes('Bot died'), 'death event');
    await waitFor(async () => (await call('get-events', { since: eventCursor, types: ['spawn'] })).includes('Bot spawned'), 'respawn event');
  });

  await session.cleanup();

  const notCovered = tools.map(tool => tool.name).filter(name => !covered.has(name));
  results.push({ name: 'coverage', ok: notCovered.length === 0, error: `not exercised: ${notCovered.join(', ')}` });

  const failed = results.filter(result => !result.ok);
  console.log(`\nExercised ${covered.size} of ${tools.length} tools`);
  if (notCovered.length > 0) console.log(`Not exercised: ${notCovered.join(', ')}`);
  console.log(failed.length === 0
    ? 'Live world test passed'
    : `Live world test failed: ${failed.map(result => result.name).join(', ')}`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (error) {
  if (error instanceof SetupFailed) {
    console.log(`\n${error.message}\nLive world test failed: setup`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
} finally {
  await session.close();
}
