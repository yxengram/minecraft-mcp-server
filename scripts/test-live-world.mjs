// Full live test: exercises every MCP tool against a real server and MODIFIES THE WORLD.
// Only run it in a throwaway world with cheats enabled (the bot must be allowed to run commands).
//
//   npm run build
//   npm run test:live:world -- <LAN_PORT> --allow-world-changes
//
// It builds a floating stone arena at y=240 above the bot (removed again at the end), gives itself items, summons entities, changes
// time and game mode, and kills the bot at the end to test death/respawn events. A second
// in-process bot (MCPHelper) acts as another player for chat, whisper and follow tests.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const port = Number(args.find(arg => /^\d+$/.test(arg)) ?? 25565);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('Pass a LAN port between 1 and 65535');
}
if (!args.includes('--allow-world-changes')) {
  console.error(
    'This test modifies the world (builds an arena, summons entities, changes time and game mode, kills the bot).\n' +
    'Only run it in a throwaway world with cheats enabled, and pass --allow-world-changes to confirm.'
  );
  process.exit(2);
}

const BOT_NAME = 'MCPWorldTest';
const HELPER_NAME = 'MCPHelper';
// A fixed altitude keeps repeated runs from stacking arenas on top of each other.
const ARENA_Y = 240;
const ARENA_RADIUS = 10;

const waypointDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-live-world-'));
const client = new Client({ name: 'minecraft-world-test', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    fileURLToPath(new URL('../dist/main.js', import.meta.url)),
    '--host', '127.0.0.1',
    '--port', String(port),
    '--username', BOT_NAME,
    '--waypoint-file', path.join(waypointDir, 'waypoints.json')
  ],
  stderr: 'ignore'
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const covered = new Set();
const results = [];
let helper;

function responseText(result) {
  return result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
}

async function call(name, toolArgs = {}, { expectError = false, timeout = 120000 } = {}) {
  covered.add(name);
  const result = await client.callTool({ name, arguments: toolArgs }, undefined, { timeout });
  const text = responseText(result);
  if (Boolean(result.isError) !== expectError) {
    throw new Error(`${name}(${JSON.stringify(toolArgs)}) ${expectError ? 'should have failed' : 'failed'}: ${text}`);
  }
  return text;
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function expectIncludes(text, fragment, context) {
  expect(text.includes(fragment), `${context}: expected "${fragment}" in:\n${text}`);
}

async function waitFor(check, description, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last) return last;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function cmd(command) {
  await call('send-chat', { message: command });
  await sleep(700);
}

async function position() {
  const text = await call('get-position');
  return text.match(/\((-?\d+), (-?\d+), (-?\d+)\)/).slice(1).map(Number);
}

async function inventoryCount(itemName) {
  const text = await call('list-inventory');
  return [...text.matchAll(new RegExp(`- ${itemName} \\(x(\\d+)\\)`, 'g'))].reduce((sum, m) => sum + Number(m[1]), 0);
}

async function waitForCount(itemName, predicate, description) {
  let last;
  try {
    await waitFor(async () => predicate(last = await inventoryCount(itemName)), description);
  } catch {
    throw new Error(`Timed out waiting for ${description} (have ${last} ${itemName})`);
  }
}

async function placeAndVerify(itemName, x, y, z) {
  await call('equip-item', { itemName });
  const text = await call('place-block', { x, y, z });
  expect(text.startsWith('Placed block'), `place-block ${itemName} at ${x}, ${y}, ${z}: ${text}`);
  const placed = await block(x, y, z);
  expect(placed === itemName, `place-block reported success but found ${placed} at ${x}, ${y}, ${z}`);
}

async function block(x, y, z) {
  return (await call('get-block-info', { x, y, z })).match(/Found (\w+)/)?.[1];
}

async function distanceTo(type) {
  const text = await call('list-entities', { type, maxDistance: 32 });
  return Number(text.match(/([\d.]+) blocks away/)?.[1] ?? Infinity);
}

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
let arenaReady = false;

// If an earlier step left the bot off the arena, say so and put it back so later steps stay independent.
async function ensureOnArena() {
  if (!arenaReady) return;
  const [x, y, z] = await position();
  // Standing a little higher is fine (for example on blocks the pathfinder placed); falling is not.
  if (y >= y0 && Math.abs(x - cx) < ARENA_RADIUS && Math.abs(z - cz) < ARENA_RADIUS) return;
  console.log(`  ! bot left the arena and was at (${x}, ${y}, ${z}); teleporting it back`);
  await printDiagnostics();
  await cmd(`/tp @s ${cx} ${y0} ${cz}`);
  await sleep(1000);
}

async function step(name, fn) {
  await ensureOnArena();
  process.stdout.write(`- ${name} ... `);
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('ok');
    return true;
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
    console.log(`FAILED\n    ${error.message.split('\n').join('\n    ')}`);
    await printDiagnostics();
    return false;
  }
}

class SetupFailed extends Error {}

async function printDiagnostics() {
  try {
    const where = responseText(await client.callTool({ name: 'get-position', arguments: {} }));
    const events = responseText(await client.callTool({ name: 'get-events', arguments: { limit: 8 } }));
    console.log(`    diagnostics: ${where}\n    ${events.split('\n').filter(Boolean).join('\n    ')}`);
  } catch (error) {
    console.log(`    diagnostics unavailable: ${error.message}`);
  }
}

function startHelper() {
  return new Promise((resolve, reject) => {
    const bot = mineflayer.createBot({ host: '127.0.0.1', port, username: HELPER_NAME });
    bot.once('spawn', () => resolve(bot));
    bot.once('error', reject);
    bot.once('kicked', reason => reject(new Error(`Helper kicked: ${JSON.stringify(reason)}`)));
  });
}

let eventCursor = 0;

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  console.log(`MCP tools: ${tools.length}`);

  await waitFor(async () => {
    const result = await client.callTool({ name: 'get-position', arguments: {} });
    return !result.isError && /Current position/.test(responseText(result));
  }, 'bot to spawn', 30000);
  await sleep(2000);

  const setupOk = await step('setup: operator check and arena', async () => {
    // The bot may log in mid-air (for example where a previous arena was removed); creative mode
    // keeps it from dying of fall damage until it is teleported into the new arena.
    await cmd('/gamemode creative @s');
    await cmd('/clear @s');
    await cmd('/give @s dirt 1');
    try {
      await waitFor(async () => (await inventoryCount('dirt')) === 1, 'the /give command', 5000);
    } catch {
      throw new Error('The bot could not run commands. Enable cheats for the LAN world');
    }

    const [x, y, z] = await position();
    [cx, y0, cz] = [x, ARENA_Y, z];
    const r = ARENA_RADIUS;
    await cmd(`/fill ${cx - r} ${y0 - 1} ${cz - r} ${cx + r} ${y0 - 1} ${cz + r} stone`);
    await cmd(`/fill ${cx - r} ${y0} ${cz - r} ${cx + r} ${y0 + 6} ${cz + r} air`);
    // A 2-block wall around the edge keeps the bots from sliding or being knocked off the platform.
    await cmd(`/fill ${cx - r} ${y0} ${cz - r} ${cx + r} ${y0 + 1} ${cz - r} stone`);
    await cmd(`/fill ${cx - r} ${y0} ${cz + r} ${cx + r} ${y0 + 1} ${cz + r} stone`);
    await cmd(`/fill ${cx - r} ${y0} ${cz - r} ${cx - r} ${y0 + 1} ${cz + r} stone`);
    await cmd(`/fill ${cx + r} ${y0} ${cz - r} ${cx + r} ${y0 + 1} ${cz + r} stone`);
    await cmd('/gamemode survival @s');
    await cmd('/time set day');
    await cmd('/weather clear');
    await cmd(`/tp @s ${cx} ${y0} ${cz}`);
    await cmd(`/kill @e[type=!player,distance=..48]`);
    await cmd('/clear @s');
    await sleep(1500);
    expect((await block(cx, y0 - 1, cz)) === 'stone', 'arena floor was not built');

    // The helper may log in mid-air where a previous arena was removed, so make it fall-proof and
    // confirm it actually arrived before relying on it.
    helper = await startHelper();
    await cmd(`/gamemode creative ${HELPER_NAME}`);
    const helperSpot = new Vec3(cx + 0.5, y0, cz - 6.5);
    let arrived = false;
    for (let attempt = 0; attempt < 3 && !arrived; attempt++) {
      await cmd(`/tp ${HELPER_NAME} ${cx} ${y0} ${cz - 7}`);
      try {
        await waitFor(() => helper.entity?.position.distanceTo(helperSpot) < 2, 'the helper to arrive', 4000);
        arrived = true;
      } catch {
        // retry the teleport
      }
    }
    expect(arrived, `${HELPER_NAME} could not be moved into the arena`);
    await sleep(1000);
    arenaReady = true;
  });

  if (!setupOk) throw new SetupFailed('Setup failed, skipping the remaining steps');

  await step('read-only basics', async () => {
    expectIncludes(await call('detect-gamemode'), 'survival', 'detect-gamemode');
    const observation = await call('get-observation');
    expectIncludes(observation, 'Health:', 'get-observation');
    expect(!observation.includes('undefined'), `get-observation contains undefined:\n${observation}`);
    expectIncludes(await call('get-block-info', { x: cx, y: y0 - 1, z: cz }), 'stone', 'get-block-info');
    expectIncludes(await call('find-blocks', { blockType: 'stone', maxDistance: 4, count: 3 }), 'Found 3 stone', 'find-blocks');
    expectIncludes(await call('list-inventory'), 'empty', 'list-inventory');
  });

  await step('policy: get-policy and set-policy', async () => {
    const defaults = await call('get-policy');
    expectIncludes(defaults, 'autoEat: on', 'get-policy defaults');
    expectIncludes(defaults, 'attackPlayers: false', 'get-policy defaults');
    expectIncludes(defaults, 'Reflex checks:', 'get-policy reflex timing');
    // A local cursor: the shared eventCursor is only set by the next step.
    const since = Number((await call('get-events', { limit: 1 })).match(/nextSince: (\d+)/)[1]);
    try {
      expectIncludes(await call('set-policy', { reflexes: { autoEat: { enabled: false } } }), 'Changed: reflexes.autoEat.enabled', 'set-policy autoEat off');
      expectIncludes(await call('get-policy'), 'autoEat: off', 'get-policy after set-policy');

      // A misspelled nested field is rejected and changes nothing.
      expectIncludes(await call('set-policy', { reflexes: { autoEat: { enable: true } } }, { expectError: true }), 'enable', 'set-policy misspelled field');
      expectIncludes(await call('get-policy'), 'autoEat: off', 'get-policy after a rejected set-policy');

      expectIncludes(await call('set-policy', { combat: { attackPlayers: true } }), 'warning: attackPlayers enabled', 'set-policy attackPlayers warning');
      const events = await call('get-events', { since, types: ['policy'], limit: 20 });
      expectIncludes(events, '[policy] set-policy changed reflexes.autoEat.enabled', 'policy event for autoEat');
      expectIncludes(events, '[policy] warning: attackPlayers enabled by set-policy', 'policy warning event');
    } finally {
      // Restore the defaults even if a check failed, so later steps never run with attackPlayers on.
      await call('set-policy', { reflexes: { autoEat: { enabled: true } }, combat: { attackPlayers: false } });
    }
    const restored = await call('get-policy');
    expectIncludes(restored, 'autoEat: on', 'get-policy after restoring the defaults');
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

  await step('events: pickup, damage, death and respawn', async () => {
    const pickups = await call('get-events', { types: ['item_picked_up'], limit: 100 });
    expectIncludes(pickups, 'Picked up', 'item_picked_up events');
    await cmd(`/damage ${BOT_NAME} 2`);
    await waitFor(async () => (await call('get-events', { since: eventCursor, types: ['damaged'] })).includes('Health dropped'), 'damaged event');
    await cmd('/kill @s');
    await waitFor(async () => (await call('get-events', { since: eventCursor, types: ['death'] })).includes('Bot died'), 'death event');
    await waitFor(async () => (await call('get-events', { since: eventCursor, types: ['spawn'] })).includes('Bot spawned'), 'respawn event');
  });

  arenaReady = false;
  await step('cleanup: remove the arena', async () => {
    const r = ARENA_RADIUS;
    // Leave both bots on solid ground below the arena, so they do not log in mid-air next time.
    await cmd(`/spreadplayers ${cx} ${cz} 0 8 under ${y0 - 20} false ${BOT_NAME}`);
    await cmd(`/spreadplayers ${cx} ${cz} 0 8 under ${y0 - 20} false ${HELPER_NAME}`);
    await cmd(`/fill ${cx - r} ${y0 - 1} ${cz - r} ${cx + r} ${y0 + 6} ${cz + r} air`);
    await cmd(`/kill @e[type=!player,x=${cx},y=${y0},z=${cz},distance=..24]`);
    await cmd('/time set day');
  });

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
  helper?.quit();
  await client.close();
  fs.rmSync(waypointDir, { recursive: true, force: true });
}
