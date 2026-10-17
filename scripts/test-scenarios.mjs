// Contract: docs/BLUEPRINT.md F-032. Scenario tests: the same dangerous or social situations under three
// configurations, to see what the autopilot adds. MODIFIES THE WORLD (summons mobs, sets the bot on fire, lets it
// starve, may kill it); only run it in a throwaway world with cheats enabled.
//
//   npm run build
//   npm run test:scenarios -- <LAN_PORT> --allow-world-changes [--only <scenario>] [--rounds <n>]
//
// Configurations:
//   llm-only            reflexes off: only what the LLM's tools would do (nobody reacts in time)
//   reflexes            default policy, no decision model
//   reflexes+decisions  default policy with the decision model (needs OPENROUTER_API_KEY; skipped without it)
// The reflexes configuration must pass every scenario; the others are for comparison.
import { createArena, parseLiveArgs, SetupFailed, sleep, ARENA_RADIUS } from './lib/live-arena.mjs';

const { port, only, args } = parseLiveArgs('The scenario test');
const rounds = Math.max(1, Number(args.includes('--rounds') ? args[args.indexOf('--rounds') + 1] : 1) || 1);
const BOT_NAME = 'MCPWorldTest';
const HELPER_NAME = 'MCPHelper';
const key = process.env.OPENROUTER_API_KEY;

const REFLEXES_OFF = {
  reflexes: {
    creeperEvade: { enabled: false }, hazardEscape: { enabled: false }, lowHealthRetreat: { enabled: false },
    selfDefense: { enabled: false }, autoEat: { enabled: false }
  }
};
const CONFIGS = [
  { name: 'llm-only', policy: REFLEXES_OFF, withKey: false },
  { name: 'reflexes', policy: null, withKey: false, required: true },
  { name: 'reflexes+decisions', policy: null, withKey: true }
];

// ---- scenarios: each returns { ok, detail } and must leave the arena reusable ---------------------------------------

const SCENARIOS = {
  /** A guard task against three zombies with AI; success: all dead within 60 s and the bot alive. */
  async 'zombie-wave'(s) {
    const { cmd, call, arena } = s;
    for (const item of ['iron_sword', 'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']) await cmd(`/give @s ${item}`);
    for (const [item, slot] of [['iron_helmet', 'head'], ['iron_chestplate', 'torso'], ['iron_leggings', 'legs'], ['iron_boots', 'feet']]) {
      await call('equip-item', { itemName: item, destination: slot }).catch(() => {});
    }
    const id = (await call('start-task', { behavior: 'guard', params: { radius: 9 } })).match(/task (t\d+)/)?.[1];
    const since = await s.cursor();
    for (const [dx, dz] of [[6, 0], [-6, 3], [0, -6]]) await call('send-chat', { message: `/summon zombie ${arena.cx + dx} ${arena.y0} ${arena.cz + dz} {PersistenceRequired:1b}` });
    await sleep(600);
    await cmd('/effect give @e[type=zombie,distance=..32] minecraft:fire_resistance 120 0 true');
    const t0 = Date.now();
    let alive = 3;
    while (Date.now() - t0 < 60000) {
      alive = await s.countMobs('zombie');
      if (alive === 0 || await s.died(since)) break;
      await sleep(1000);
    }
    if (id) await call('cancel-task', { id }).catch(() => {});
    const died = await s.died(since);
    return { ok: alive === 0 && !died, detail: `${3 - alive}/3 killed in ${((Date.now() - t0) / 1000).toFixed(0)}s${died ? ', bot died' : ''}, health ${await s.health()}` };
  },

  /** An ignited creeper 4 blocks away; success: the bot is at least 7 blocks away when it explodes, and alive. */
  async 'creeper-ambush'(s) {
    const { call } = s;
    const [px, , pz] = await s.position();
    const since = await s.cursor();
    await call('send-chat', { message: `/summon creeper ${px + 4} ${s.arena.y0} ${pz} {ignited:1b}` });
    const spawn = { x: px + 4.5, z: pz + 0.5 };
    let distance = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      if ((await s.eventsSince(since, ['explosion'])).length > 0) {
        const [bx, , bz] = await s.position();
        distance = Math.hypot(bx + 0.5 - spawn.x, bz + 0.5 - spawn.z);
        break;
      }
      await sleep(150);
    }
    await sleep(500);
    const died = await s.died(since);
    return { ok: distance !== null && distance >= 7 && !died, detail: `${distance === null ? 'no explosion seen' : `${distance.toFixed(1)} blocks away`}${died ? ', bot died' : ''}, health ${await s.health()}` };
  },

  /** Food drops below 14 with bread in the inventory; success: the bot eats within 15 s. */
  async hunger(s) {
    const { cmd } = s;
    await cmd('/give @s bread 4');
    await cmd('/effect give @s minecraft:hunger 30 255 true');
    await s.waitFor(async () => (await s.food()) < 12, 'food to drop', 30000);
    await cmd('/effect clear @s minecraft:hunger');
    const before = await s.inventoryCount('bread');
    const t0 = Date.now();
    let eaten = false;
    while (Date.now() - t0 < 15000) {
      if ((await s.inventoryCount('bread')) < before) { eaten = true; break; }
      await sleep(500);
    }
    return { ok: eaten, detail: eaten ? `ate within ${((Date.now() - t0) / 1000).toFixed(1)}s, food ${await s.food()}` : `did not eat in 15s (food ${await s.food()})` };
  },

  /** Set on fire with water 3 blocks away; success: no more fire damage within 6 s. */
  async fire(s) {
    const { cmd, call } = s;
    const [px, , pz] = await s.position();
    await cmd(`/setblock ${px - 3} ${s.arena.y0 - 1} ${pz} water`);
    await sleep(500);
    let since = await s.cursor();
    await call('send-chat', { message: `/setblock ${px} ${s.arena.y0} ${pz} fire` });
    const t0 = Date.now();
    let lastFire = 0;
    while (Date.now() - t0 < 15000) {
      const text = await call('get-events', { since, types: ['damaged'], limit: 100 });
      if (text.split('\n').some(line => /fire/.test(line))) lastFire = Date.now() - t0;
      since = Number(text.match(/nextSince: (\d+)/)?.[1] ?? since);
      if (lastFire && Date.now() - t0 - lastFire > 2500) break;
      await sleep(200);
    }
    return { ok: lastFire > 0 && lastFire <= 6000, detail: lastFire ? `last fire damage ${(lastFire / 1000).toFixed(1)}s after ignition` : 'never caught fire' };
  },

  /** A player asks the bot for help, then says "follow me"; success: chat_request within 3 s and no following. */
  async 'chat-triage'(s) {
    const helper = s.arena.helper;
    let since = await s.cursor();
    const t0 = Date.now();
    helper.chat(`${BOT_NAME}, can you help me?`);
    let request = null;
    while (Date.now() - t0 < 5000 && !request) {
      request = (await s.eventsSince(since, ['chat_request'])).find(line => line.includes('can you help me'));
      if (!request) await sleep(100);
    }
    const ms = Date.now() - t0;
    since = await s.cursor();
    helper.chat(`${BOT_NAME}, follow me`);
    await sleep(3000);
    const started = (await s.eventsSince(since, ['task_started'])).length;
    const how = request ? (request.includes('rule:') ? 'by rule' : 'by the decision model') : '';
    return { ok: Boolean(request) && ms <= 3000 && started === 0, detail: `${request ? `reported ${how} in ${(ms / 1000).toFixed(1)}s` : 'not reported'}; "follow me" ${started ? 'started a task' : 'did not start a task'}` };
  }
};

// ---- running ---------------------------------------------------------------------------------------------------

function extend(session) {
  const { call, cmd, arena } = session;
  const s = Object.create(session);
  s.cursor = async () => Number((await call('get-events', { limit: 1 })).match(/nextSince: (\d+)/)[1]);
  s.eventsSince = async (since, types) => (await call('get-events', { since, types, limit: 100 })).split('\n').filter(line => line.startsWith('#'));
  s.died = async since => (await s.eventsSince(since, ['death'])).length > 0;
  s.health = async () => Number((await call('get-observation')).match(/Health: ([\d.]+)/)?.[1] ?? NaN);
  s.food = async () => Number((await call('get-observation')).match(/food: ([\d.]+)/)?.[1] ?? NaN);
  s.countMobs = async type => {
    const text = await call('list-entities', { type, maxDistance: 32 });
    return (text.match(new RegExp(`${type} \\[`, 'g')) ?? []).length;
  };
  // Back to a clean arena between scenarios: no mobs, intact floor, full health and food, empty inventory, no task.
  s.reset = async () => {
    const { cx, y0, cz } = arena;
    const r = ARENA_RADIUS - 1;
    await cmd('/kill @e[type=!player,distance=..40]');
    await cmd(`/fill ${cx - r} ${y0 - 5} ${cz - r} ${cx + r} ${y0 - 1} ${cz + r} stone`);
    await cmd(`/fill ${cx - r} ${y0} ${cz - r} ${cx + r} ${y0 + 4} ${cz + r} air`);
    await cmd('/effect clear @s');
    await cmd('/clear @s');
    await cmd('/effect give @s minecraft:instant_health 1 5 true');
    await cmd('/effect give @s minecraft:saturation 1 20 true');
    await call('cancel-task').catch(() => {});
    await call('stop-pathfinding').catch(() => {});
    await cmd(`/tp @s ${cx} ${y0} ${cz}`);
    await cmd(`/tp ${HELPER_NAME} ${cx} ${y0} ${cz - 7}`);
    await sleep(1000);
  };
  return s;
}

const scenarioNames = Object.keys(SCENARIOS).filter(name => !only || name === only);
if (scenarioNames.length === 0) {
  console.error(`Unknown scenario '${only}'. Scenarios: ${Object.keys(SCENARIOS).join(', ')}`);
  process.exit(2);
}

const table = [];
let setupFailed = false;
for (let round = 1; round <= rounds; round++) {
  for (const config of CONFIGS) {
    if (config.withKey && !key) {
      for (const name of scenarioNames) table.push({ round, config: config.name, scenario: name, result: 'skipped', detail: 'no OPENROUTER_API_KEY' });
      continue;
    }
    console.log(`\n=== round ${round}, configuration ${config.name}`);
    const session = createArena({
      port,
      botName: BOT_NAME,
      helperName: HELPER_NAME,
      clientName: 'minecraft-scenario-test',
      serverEnv: config.withKey ? { OPENROUTER_API_KEY: key } : {}
    });
    const s = extend(session);
    try {
      await session.connect();
      await session.setup();
      if (config.policy) await session.call('set-policy', config.policy);
      for (const name of scenarioNames) {
        await s.reset();
        let outcome = { ok: false, detail: 'did not run' };
        await session.step(`${config.name}: ${name}`, async () => {
          outcome = await SCENARIOS[name](s);
          if (!outcome.ok) throw new Error(outcome.detail);
        });
        table.push({ round, config: config.name, scenario: name, result: outcome.ok ? 'pass' : 'FAIL', detail: outcome.detail, required: config.required });
      }
      await s.reset();
      await session.cleanup();
    } catch (error) {
      setupFailed = setupFailed || error instanceof SetupFailed;
      console.error(error instanceof SetupFailed ? error.message : error);
      for (const name of scenarioNames) {
        if (!table.some(row => row.round === round && row.config === config.name && row.scenario === name)) {
          table.push({ round, config: config.name, scenario: name, result: 'FAIL', detail: 'setup failed', required: config.required });
        }
      }
    } finally {
      await session.close();
      // Give the server a moment to drop the old bot before the next configuration logs in with the same name.
      await sleep(3000);
    }
  }
}

console.log('\n| round | scenario | configuration | result | details |\n|---|---|---|---|---|');
for (const row of table) console.log(`| ${row.round} | ${row.scenario} | ${row.config} | ${row.result} | ${row.detail} |`);
const requiredFailures = table.filter(row => row.required && row.result !== 'pass');
console.log(requiredFailures.length === 0 && !setupFailed
  ? '\nScenario test passed: every scenario passed with reflexes on'
  : `\nScenario test failed: ${requiredFailures.map(row => `${row.scenario} (round ${row.round})`).join(', ') || 'setup'}`);
process.exitCode = requiredFailures.length === 0 && !setupFailed ? 0 : 1;
