// Contract: docs/BLUEPRINT.md F-033. Shared helpers for the live tests (test-live-world, test-scenarios): start the MCP
// server as a client would, wait for the bot, run commands, build and remove a walled arena at a fixed height, start
// a helper player, and print diagnostics when something fails. These scripts MODIFY THE WORLD; only use them in a
// throwaway world with cheats enabled.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A fixed altitude keeps repeated runs from stacking arenas on top of each other.
export const ARENA_Y = 240;
export const ARENA_RADIUS = 10;
// The --host the server is started with, which is also the key of its waypoints from before E-041.
export const SERVER_HOST = '127.0.0.1';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class SetupFailed extends Error {}

// E-038: the SDK client's default request timeout, which call() uses, and the time within which every reply must
// come unless the call gave an explicit long time limit (the server's 50 s budget, with room to spare).
export const CALL_TIMEOUT_MS = 60000;
const REPLY_DUE_MS = 55000;
// The tools whose explicit timeoutMs moves the call's deadline (E-038), with the time they may add after it (a move
// waits up to 10 s in a Nether portal); the server keeps REPLY_MARGIN_MS on top for the reply. Not collect-block or
// lead-animal: their timeoutMs only limits the task, and the reply still comes within the budget.
const EXTENDING_TOOLS = { 'move-to-position': 10000, 'goto-waypoint': 10000, 'clear-region': 0, 'fill-region': 0, 'dig-tunnel': 0, 'smelt-item': 0 };
const REPLY_MARGIN_MS = 5000;

/** How long a call may take when its explicit timeoutMs lets it reply after REPLY_DUE_MS; null when it may not. */
function longLimitMs(name, toolArgs) {
  const extra = EXTENDING_TOOLS[name];
  if (extra === undefined || typeof toolArgs.timeoutMs !== 'number') return null;
  const allowed = toolArgs.timeoutMs + extra + REPLY_MARGIN_MS;
  return allowed > REPLY_DUE_MS ? allowed : null;
}

/** The LAN port from the command line; refuses to run without --allow-world-changes. */
export function parseLiveArgs(what) {
  const args = process.argv.slice(2);
  const port = Number(args.find(arg => /^\d+$/.test(arg)) ?? 25565);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Pass a LAN port between 1 and 65535');
  }
  if (!args.includes('--allow-world-changes')) {
    console.error(
      `${what} modifies the world (builds an arena, summons entities, changes time and game mode, may kill the bot).\n` +
      'Only run it in a throwaway world with cheats enabled, and pass --allow-world-changes to confirm.'
    );
    process.exit(2);
  }
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;
  return { port, only, args };
}

export function responseText(result) {
  return result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
}

/**
 * One connected session: an MCP client driving the bot, plus the helpers the live tests share.
 * `serverEnv` adds environment variables for the server (the stdio transport only passes a whitelist).
 * The server always gets --allow-commands: the live tests build the arena with server commands sent through send-chat
 * (E-033).
 * The server's stderr is read from the start and every line is kept (`stderrLines()`), so the scripts can check what
 * it logged (E-036); a pipe nobody reads fills up and stalls a long run. The lines are not printed.
 * Every call() is timed (`durations`, `slowestCalls()`), and one that replies after 55 s without an explicit long
 * time limit fails (E-038).
 * `legacyWaypoints` (name → waypoint) are written to the temporary waypoint file under the bare --host key before the
 * server starts, as waypoints were kept before E-041; the server sees them as saved before waypoints were kept per world.
 */
export function createArena({ port, botName, helperName, clientName, serverArgs = [], serverEnv = {}, legacyWaypoints }) {
  const waypointDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-live-world-'));
  const waypointFile = path.join(waypointDir, 'waypoints.json');
  if (legacyWaypoints) fs.writeFileSync(waypointFile, JSON.stringify({ [SERVER_HOST]: legacyWaypoints }, null, 2));
  const client = new Client({ name: clientName, version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(new URL('../../dist/main.js', import.meta.url)),
      '--host', SERVER_HOST,
      '--port', String(port),
      '--username', botName,
      '--waypoint-file', waypointFile,
      '--allow-commands',
      ...serverArgs
    ],
    stderr: 'pipe',
    env: { ...getDefaultEnvironment(), ...Object.fromEntries(Object.entries(serverEnv).filter(([, value]) => value)) }
  });
  // The SDK hands out this stream before the server starts, so nothing it writes is missed.
  const stderr = [];
  let partialLine = '';
  transport.stderr?.on('data', chunk => {
    const lines = (partialLine + chunk.toString()).split(/\r?\n/);
    partialLine = lines.pop();
    stderr.push(...lines);
  });
  /** Every complete line the server has written to stderr so far, plus an unfinished last one. */
  const stderrLines = () => (partialLine ? [...stderr, partialLine] : [...stderr]);

  const covered = new Set();
  const results = [];
  // How long each call() took, in order (E-038).
  const durations = [];
  const arena = { cx: 0, y0: ARENA_Y, cz: 0, ready: false, helper: null };

  /**
   * Calls a tool and checks isError. A reply must come within REPLY_DUE_MS (E-038): a slower one fails the step,
   * unless the call gives a tool whose explicit timeoutMs moves the deadline; such a call must pass a client `timeout`
   * that covers it. `onprogress` goes to client.callTool, which then asks the server for progress notifications
   * (E-039); they do not lengthen the client timeout.
   */
  async function call(name, toolArgs = {}, { expectError = false, timeout = CALL_TIMEOUT_MS, onprogress } = {}) {
    covered.add(name);
    const longLimit = longLimitMs(name, toolArgs);
    if (longLimit !== null && timeout < longLimit) {
      throw new Error(`${name} with timeoutMs ${toolArgs.timeoutMs} may reply after ${longLimit / 1000} s: pass a client timeout of at least ${longLimit} ms`);
    }
    const started = Date.now();
    let result;
    try {
      result = await client.callTool({ name, arguments: toolArgs }, undefined, onprogress ? { timeout, onprogress } : { timeout });
    } finally {
      durations.push({ name, ms: Date.now() - started });
    }
    const ms = Date.now() - started;
    if (longLimit === null && ms > REPLY_DUE_MS) {
      throw new Error(`${name}(${JSON.stringify(toolArgs)}) replied after ${(ms / 1000).toFixed(1)} s; without an explicit long time limit a reply must come within ${REPLY_DUE_MS / 1000} s`);
    }
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

  // Returns send-chat's reply, which names the server command it ran (E-033).
  async function cmd(command) {
    const text = await call('send-chat', { message: command });
    await sleep(700);
    return text;
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

  async function block(x, y, z) {
    return (await call('get-block-info', { x, y, z })).match(/Found (\w+)/)?.[1];
  }

  async function placeAndVerify(itemName, x, y, z) {
    await call('equip-item', { itemName });
    const text = await call('place-block', { x, y, z });
    expect(text.startsWith('Placed block'), `place-block ${itemName} at ${x}, ${y}, ${z}: ${text}`);
    const placed = await block(x, y, z);
    expect(placed === itemName, `place-block reported success but found ${placed} at ${x}, ${y}, ${z}`);
  }

  async function distanceTo(type) {
    const text = await call('list-entities', { type, maxDistance: 32 });
    return Number(text.match(/([\d.]+) blocks away/)?.[1] ?? Infinity);
  }

  async function printDiagnostics() {
    try {
      const where = responseText(await client.callTool({ name: 'get-position', arguments: {} }));
      const events = responseText(await client.callTool({ name: 'get-events', arguments: { limit: 8 } }));
      console.log(`    diagnostics: ${where}\n    ${events.split('\n').filter(Boolean).join('\n    ')}`);
    } catch (error) {
      console.log(`    diagnostics unavailable: ${error.message}`);
    }
  }

  // If an earlier step left the bot off the arena, say so and put it back so later steps stay independent.
  async function ensureOnArena() {
    if (!arena.ready) return;
    const [x, y, z] = await position();
    // Standing a little higher is fine (for example on blocks the pathfinder placed); falling is not.
    if (y >= arena.y0 && Math.abs(x - arena.cx) < ARENA_RADIUS && Math.abs(z - arena.cz) < ARENA_RADIUS) return;
    console.log(`  ! bot left the arena and was at (${x}, ${y}, ${z}); teleporting it back`);
    await printDiagnostics();
    await cmd(`/tp @s ${arena.cx} ${arena.y0} ${arena.cz}`);
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

  function startHelper() {
    return new Promise((resolve, reject) => {
      const bot = mineflayer.createBot({ host: '127.0.0.1', port, username: helperName });
      bot.once('spawn', () => resolve(bot));
      bot.once('error', reject);
      bot.once('kicked', reason => reject(new Error(`Helper kicked: ${JSON.stringify(reason)}`)));
    });
  }

  /** Connects the MCP client and waits until the bot is in the game. Returns the tool list. */
  async function connect() {
    await client.connect(transport);
    const { tools } = await client.listTools();
    console.log(`MCP tools: ${tools.length}`);
    await waitFor(async () => {
      const result = await client.callTool({ name: 'get-position', arguments: {} });
      return !result.isError && /Current position/.test(responseText(result));
    }, 'bot to spawn', 30000);
    await sleep(2000);
    return tools;
  }

  /** Builds the walled arena above the bot and brings the helper into it. Throws SetupFailed when it cannot. */
  async function setup() {
    const ok = await step('setup: operator check and arena', async () => {
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

      const [x, , z] = await position();
      Object.assign(arena, { cx: x, y0: ARENA_Y, cz: z });
      const { cx, y0, cz } = arena;
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
      arena.helper = await startHelper();
      await cmd(`/gamemode creative ${helperName}`);
      const helperSpot = new Vec3(cx + 0.5, y0, cz - 6.5);
      let arrived = false;
      for (let attempt = 0; attempt < 3 && !arrived; attempt++) {
        await cmd(`/tp ${helperName} ${cx} ${y0} ${cz - 7}`);
        try {
          await waitFor(() => arena.helper.entity?.position.distanceTo(helperSpot) < 2, 'the helper to arrive', 4000);
          arrived = true;
        } catch {
          // retry the teleport
        }
      }
      expect(arrived, `${helperName} could not be moved into the arena`);
      await sleep(1000);
      arena.ready = true;
    });
    if (!ok) throw new SetupFailed('Setup failed, skipping the remaining steps');
  }

  /** Removes the arena and leaves both players on solid ground below it, so they do not log in mid-air next time. */
  async function cleanup() {
    arena.ready = false;
    return step('cleanup: remove the arena', async () => {
      const { cx, y0, cz } = arena;
      const r = ARENA_RADIUS;
      await cmd(`/spreadplayers ${cx} ${cz} 0 8 under ${y0 - 20} false ${botName}`);
      await cmd(`/spreadplayers ${cx} ${cz} 0 8 under ${y0 - 20} false ${helperName}`);
      await cmd(`/fill ${cx - r} ${y0 - 1} ${cz - r} ${cx + r} ${y0 + 6} ${cz + r} air`);
      await cmd(`/kill @e[type=!player,x=${cx},y=${y0},z=${cz},distance=..24]`);
      await cmd('/time set day');
    });
  }

  async function close() {
    arena.helper?.quit();
    await client.close();
    fs.rmSync(waypointDir, { recursive: true, force: true });
  }

  /** The `count` slowest calls so far, e.g. "collect-block 44.8 s, dig-tunnel 21.3 s". */
  function slowestCalls(count = 5) {
    return [...durations].sort((a, b) => b.ms - a.ms).slice(0, count)
      .map(({ name, ms }) => `${name} ${(ms / 1000).toFixed(1)} s`).join(', ');
  }

  return {
    arena, client, covered, results, durations,
    call, expect, expectIncludes, waitFor, cmd, position, inventoryCount, waitForCount, block, placeAndVerify,
    distanceTo, printDiagnostics, step, connect, setup, cleanup, close, stderrLines, slowestCalls
  };
}
