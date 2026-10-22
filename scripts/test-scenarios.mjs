// Contract: docs/BLUEPRINT.md F-032. Scenario tests: the same dangerous or social situations under three
// configurations, to see what the autopilot adds. MODIFIES THE WORLD (summons mobs, sets the bot on fire, lets it
// starve, may kill it); only run it in a throwaway world with cheats enabled.
//
//   npm run build
//   npm run test:scenarios -- <LAN_PORT> --allow-world-changes [--only <scenario>] [--rounds <n>]
//
// Configurations (M9, BLUEPRINT E-012):
//   llm-only  instinct off: only what the LLM's tools would do (nobody reacts in time)
//   no-key    default policy without a decision model: the instinct is offline, so dangers are only reported to the
//             LLM and the bot does not act on them (by design)
//   instinct  default policy with the decision model (needs OPENROUTER_API_KEY; skipped without it)
// The instinct configuration must pass every scenario except the stress tests (STRESS_TESTS); the other
// configurations are for comparison.
import { createArena, parseLiveArgs, SetupFailed, sleep, ARENA_RADIUS } from './lib/live-arena.mjs';

const { port, only, args } = parseLiveArgs('The scenario test');
const rounds = Math.max(1, Number(args.includes('--rounds') ? args[args.indexOf('--rounds') + 1] : 1) || 1);
const BOT_NAME = 'MCPWorldTest';
const HELPER_NAME = 'MCPHelper';
const key = process.env.OPENROUTER_API_KEY;

const AUTOPILOT_OFF = { instinct: { enabled: false } };
// Reported but never required to pass (user decision, 2026-10-18): a creeper lit 4 blocks away leaves the decision
// model about 0.7 s, and its answers sometimes take 1.0-1.3 s (PLAN M9, Q11).
const STRESS_TESTS = new Set(['creeper-ambush']);

const CONFIGS = [
  { name: 'llm-only', policy: AUTOPILOT_OFF, withKey: false },
  { name: 'no-key', policy: null, withKey: false },
  { name: 'instinct', policy: null, withKey: true, required: true }
];

// ---- scenarios: each returns { ok, detail } and must leave the arena reusable ---------------------------------------

/**
 * Opens the arena's west wall onto an 80-block runway with 2-high walls (so the bot cannot fall off the sky platform);
 * `floor(far, near)` builds its floor between those x. Runs `run`, then removes the runway and closes the wall.
 */
async function withRunway(s, floor, run) {
  const { cmd } = s;
  const { cx, y0, cz } = s.arena;
  const r = ARENA_RADIUS;
  const far = cx - r - 80;
  await floor(far, cx - r);
  await cmd(`/fill ${far} ${y0} ${cz - 5} ${cx - r - 1} ${y0 + 1} ${cz - 5} stone`);
  await cmd(`/fill ${far} ${y0} ${cz + 5} ${cx - r - 1} ${y0 + 1} ${cz + 5} stone`);
  await cmd(`/fill ${far} ${y0} ${cz - 4} ${far} ${y0 + 1} ${cz + 4} stone`);
  await cmd(`/fill ${cx - r} ${y0} ${cz - 4} ${cx - r} ${y0 + 1} ${cz + 4} air`);
  await cmd(`/tp @s ${cx} ${y0} ${cz}`);
  await sleep(500);
  try {
    return await run();
  } finally {
    await cmd(`/tp @s ${cx} ${y0} ${cz}`);
    await cmd(`/fill ${far} ${y0 - 5} ${cz - 5} ${cx - r - 1} ${y0 + 2} ${cz + 5} air`);
    await cmd(`/fill ${cx - r} ${y0} ${cz - 4} ${cx - r} ${y0 + 1} ${cz + 4} stone`);
  }
}

/**
 * Night scenarios count the mobs they summon: invisible light blocks 2 above the floor stop natural spawns in the
 * arena (and the runway), and the phantoms that come to a player who has not slept for days are killed every second
 * by `clearPhantoms` (M14: both spoiled zombie-wave once). The arena cleanup removes the light blocks.
 */
async function lightForNight(s, { runway = false } = {}) {
  const { cx, y0, cz } = s.arena;
  const r = ARENA_RADIUS - 1;
  await s.cmd(`/fill ${cx - r} ${y0 + 2} ${cz - r} ${cx + r} ${y0 + 2} ${cz + r} light[level=15]`);
  if (runway) await s.cmd(`/fill ${cx - ARENA_RADIUS - 80} ${y0 + 2} ${cz - 4} ${cx - ARENA_RADIUS} ${y0 + 2} ${cz + 4} light[level=15]`);
}

const clearPhantoms = s => s.cmd('/kill @e[type=phantom,distance=..64]');

const SCENARIOS = {
  /**
   * A guard task against three zombies with AI, at night as zombie waves are in the game; success: all dead within 60 s
   * and the bot alive. (In daylight the fire-resistant zombies burn without dying and set the bot on fire with every
   * hit, which no real wave does; M9.)
   */
  async 'zombie-wave'(s) {
    const { cmd, call, arena } = s;
    await lightForNight(s);
    await cmd('/time set midnight');
    for (const item of ['iron_sword', 'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']) await cmd(`/give @s ${item}`);
    for (const [item, slot] of [['iron_helmet', 'head'], ['iron_chestplate', 'torso'], ['iron_leggings', 'legs'], ['iron_boots', 'feet']]) {
      await call('equip-item', { itemName: item, destination: slot }).catch(() => {});
    }
    const id = (await call('start-task', { behavior: 'guard', params: { radius: 9 } })).match(/task (t\d+)/)?.[1];
    const since = await s.cursor();
    for (const [dx, dz] of [[6, 0], [-6, 3], [0, -6]]) await call('send-chat', { message: `/summon zombie ${arena.cx + dx} ${arena.y0} ${arena.cz + dz} {PersistenceRequired:1b,Tags:["wave"]}` });
    await sleep(600);
    await cmd('/effect give @e[type=zombie,distance=..32] minecraft:fire_resistance 120 0 true');
    const t0 = Date.now();
    let alive = 3;
    while (Date.now() - t0 < 60000) {
      await clearPhantoms(s);
      alive = await s.countTagged('wave');
      if (alive === 0 || await s.died(since)) break;
      await sleep(1000);
    }
    if (id) await call('cancel-task', { id }).catch(() => {});
    await cmd('/time set day');
    const died = await s.died(since);
    return { ok: alive === 0 && !died, detail: `${3 - alive}/3 killed in ${((Date.now() - t0) / 1000).toFixed(0)}s${died ? ', bot died' : ''}, health ${await s.health()}` };
  },

  /**
   * Night, no weapon and no armor; two zombies walk up from 6 blocks east, as on the task test's day 3: running works
   * for a while (the arena opens west onto the 80-block runway), but the zombies keep coming back, and with bare hands
   * the bot cannot fight two. The arena and the runway stand on 5 blocks of dirt. Success: alive after 45 s (M14:
   * dig_in).
   */
  async 'zombie-chase'(s) {
    const { cmd, arena } = s;
    const { cx, y0, cz } = arena;
    const dirt = async (x1, z1, x2, z2) => {
      await cmd(`/fill ${x1} ${y0 - 5} ${z1} ${x2} ${y0 - 2} ${z2} dirt`);
      await cmd(`/fill ${x1} ${y0 - 1} ${z1} ${x2} ${y0 - 1} ${z2} grass_block`);
    };
    const r = ARENA_RADIUS - 1;
    await dirt(cx - r, cz - r, cx + r, cz + r);
    return withRunway(s, (far, near) => dirt(far, cz - 5, near, cz + 5), async () => {
      await lightForNight(s, { runway: true });
      await cmd('/time set midnight');
      const since = await s.cursor();
      for (const dz of [-2, 2]) await cmd(`/summon zombie ${cx + 6} ${y0} ${cz + dz} {PersistenceRequired:1b}`);
      const t0 = Date.now();
      while (Date.now() - t0 < 45000 && !(await s.died(since))) {
        await clearPhantoms(s);
        await sleep(1000);
      }
      const died = await s.died(since);
      const instinct = await s.eventsSince(since, ['instinct']);
      // What the instinct started and how its actions ended, in order: "flee, flee done, dig_in, dig_in done".
      const steps = instinct.map(line => {
        const chose = line.match(/→ (\w+) p=[\d.]+.*→ started/);
        if (chose) return chose[1];
        const ended = line.match(/\[instinct\] (\w+) → (timeout|failed|interrupted)?/);
        return ended ? `${ended[1]} ${ended[2] ?? 'done'}` : null;
      }).filter(Boolean);
      await cmd('/kill @e[type=zombie,distance=..120]');
      await cmd('/time set day');
      return { ok: !died, detail: `${died ? 'bot died' : 'alive after 45 s'}; instinct: ${steps.join(', ') || 'nothing'}; health ${await s.health()}` };
    });
  },

  /**
   * An unlit creeper about 9 blocks away walks up to the bot, as creepers do in the game. The arena wall on the far side
   * is opened onto an 80-block walled runway (2-high walls, so the bot cannot fall off the sky platform), because in the
   * open the bot can get away, and inside a 20-block walled arena it is only cornered. Success: within 25 s the bot is alive, and if the creeper exploded the bot was at least 7 blocks
   * away (M9).
   */
  async 'creeper-approach'(s) {
    const { call, cmd } = s;
    const { cx, y0, cz } = s.arena;
    const r = ARENA_RADIUS;
    return withRunway(s, (far, near) => cmd(`/fill ${far} ${y0 - 1} ${cz - 5} ${near} ${y0 - 1} ${cz + 5} stone`), async () => {
      try {
        return await creeperApproach(s);
      } finally {
        await cmd(`/kill @e[type=creeper,distance=..120]`);
      }
    });
  },

  /** Stress test (not required): an ignited creeper 4 blocks away; success: at least 7 blocks away when it explodes, alive. */
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

  /** Under water below a stone ceiling, with an air pocket at the end of the pool; success: gets to air, alive (M8). */
  async 'drowning-pocket'(s) {
    return drowning(s, { pocket: true });
  },

  /** The same pool without a pocket but with a stone pickaxe; success: digs up through the ceiling to air, alive (M8). */
  async 'drowning-dig'(s) {
    await s.cmd('/give @s stone_pickaxe');
    return drowning(s, { pocket: false });
  },

  /**
   * The same pool with an air pocket, but the LLM says it is diving on purpose (instinct.intent). Success: the instinct
   * starts no action while the bot still has 12 air or more, and the bot still gets out alive (M9).
   */
  async 'intent-dive'(s) {
    await s.call('set-policy', { instinct: { intent: 'exploring an underwater cave on purpose; I will surface when air gets low' } });
    try {
      const result = await drowning(s, { pocket: true });
      const started = (await s.eventsSince(s.drowningSince, ['instinct'])).find(line => /→ started /.test(line));
      const air = Number(started?.match(/(\d+) air left/)?.[1] ?? NaN);
      const ok = result.ok && Number.isFinite(air) && air < 12;
      return { ok, detail: `${started ? `first action at ${air} air` : 'no action started'}; ${result.detail}` };
    } finally {
      await s.call('set-policy', { instinct: { intent: '' } });
    }
  },

  /**
   * A lava pool let into the floor, level with it as the lake in the live death was (M16): 5 blocks wide (too wide to
   * jump) and across the whole arena but for a 1-block path along the south wall, right beside the lava. The bot has
   * cobblestone it could bridge with: before M16 the pathfinder bridged it. Then a target on the pool's west shore.
   * Success: both moves arrive, with no lava damage, no death and no block placed into the pool.
   */
  async 'lava-shore'(s) {
    const { cmd, call, arena } = s;
    const { cx, y0, cz } = arena;
    const r = ARENA_RADIUS - 1;
    const pool = [cx - 2, cz - r, cx + 2, cz + r - 1];
    const fillPool = async (y, block) => cmd(`/fill ${pool[0]} ${y} ${pool[1]} ${pool[2]} ${y} ${pool[3]} ${block}`);
    // Out of the way first: the bot starts in the middle of the arena, where the pool goes.
    await call('move-to-position', { x: cx - 6, y: y0, z: cz, range: 0, timeoutMs: 20000 });
    // Stone under the pool so the lava cannot run out of the sky platform; the pool replaces the floor.
    await fillPool(y0 - 2, 'stone');
    await fillPool(y0 - 1, 'lava');
    await cmd('/give @s cobblestone 32');
    await sleep(500);
    const since = await s.cursor();
    const results = [];
    let bridged = 0;
    try {
      for (const [name, x, z] of [['across', cx + 6, cz], ['back to the west shore', cx - 3, cz]]) {
        let reply;
        try {
          reply = await call('move-to-position', { x, y: y0, z, range: 0, timeoutMs: 60000 }, { timeout: 90000 });
        } catch (error) {
          reply = `Failed: ${error.message}`;
        }
        results.push(`${name}: ${reply.startsWith('Successfully') ? 'arrived' : reply.slice(0, 120)}`);
      }
      // Bridging means placing blocks into the pool or into the air above it (where the pathfinder built its bridge once
      // lava was no longer replaceable).
      for (let x = pool[0]; x <= pool[2]; x++) {
        for (let z = pool[1]; z <= pool[3]; z++) {
          if (!(await call('get-block-info', { x, y: y0 - 1, z })).includes('Found lava')) bridged++;
          if (!(await call('get-block-info', { x, y: y0, z })).includes('Found air')) bridged++;
        }
      }
    } finally {
      await fillPool(y0, 'air');
      await fillPool(y0 - 1, 'stone');
      await fillPool(y0 - 2, 'air');
    }
    const burns = (await s.eventsSince(since, ['damaged'])).filter(line => line.includes('(lava)')).length;
    const died = await s.died(since);
    const arrived = results.every(line => line.endsWith('arrived'));
    return {
      ok: arrived && burns === 0 && !died && bridged === 0,
      detail: `${results.join('; ')}; lava damage ${burns} time(s); ${bridged} lava cell(s) bridged${died ? ', bot died' : ''}`
    };
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

/**
 * A sealed water pool inside a stone block: 5x3x3 of water whose ceiling is solid stone, so swimming straight up
 * cannot reach air. With `pocket`, the east end has two blocks of air above the water to swim to.
 */
async function drowning(s, { pocket }) {
  const { cmd, call } = s;
  const { cx, y0, cz } = s.arena;
  const [x0, x1, z0, z1] = [cx + 2, cx + 8, cz - 2, cz + 2];
  await cmd(`/fill ${x0} ${y0} ${z0} ${x1} ${y0 + 5} ${z1} stone`);
  await cmd(`/fill ${x0 + 1} ${y0} ${z0 + 1} ${x1 - 1} ${y0 + 2} ${z1 - 1} water`);
  if (pocket) await cmd(`/fill ${x1 - 1} ${y0 + 3} ${z0 + 1} ${x1 - 1} ${y0 + 4} ${z1 - 1} air`);
  const since = await s.cursor();
  s.drowningSince = since;
  await call('send-chat', { message: `/tp @s ${x0 + 2} ${y0} ${cz}` });
  const t0 = Date.now();
  let escaped = null;
  while (Date.now() - t0 < 30000) {
    if (await s.died(since)) break;
    escaped = (await s.eventsSince(since, ['instinct'])).find(line => /\] (swim_to_air|dig_up|swim_up) → (?!failed|timeout|interrupted)/.test(line));
    if (escaped) break;
    await sleep(500);
  }
  const died = await s.died(since);
  const how = escaped ? `${escaped.replace(/^.*\] /, '')} after ${((Date.now() - t0) / 1000).toFixed(1)}s` : 'did not get out';
  const result = { ok: Boolean(escaped) && !died, detail: `${how}${died ? ', bot drowned' : ''}, air ${(await call('get-observation')).match(/air: (\d+)/)?.[1]}/20, health ${await s.health()}` };
  // Take the pool away so the next scenario starts on open ground.
  await cmd(`/tp @s ${cx} ${y0} ${cz}`);
  await cmd(`/fill ${x0} ${y0} ${z0} ${x1} ${y0 + 5} ${z1} air`);
  return result;
}


/** The chase itself: a creeper 9 blocks east of the bot, watched for 25 s. */
async function creeperApproach(s) {
  const { call } = s;
  const [px, , pz] = await s.position();
  const since = await s.cursor();
  await call('send-chat', { message: `/summon creeper ${px + 9} ${s.arena.y0} ${pz} {PersistenceRequired:1b}` });
  let distance = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    const explosion = (await s.eventsSince(since, ['explosion']))[0];
    if (explosion) {
      const at = explosion.match(/Explosion at \((-?\d+), (-?\d+), (-?\d+)\)/);
      const [bx, , bz] = await s.position();
      if (at) distance = Math.hypot(bx - Number(at[1]), bz - Number(at[3]));
      break;
    }
    if (await s.died(since)) break;
    await sleep(250);
  }
  await sleep(500);
  const died = await s.died(since);
  const ran = (await s.eventsSince(since, ['instinct'])).filter(line => /→ started run_from_creeper/.test(line)).length;
  const exploded = distance !== null;
  return {
    ok: !died && (!exploded || distance >= 7),
    detail: `${exploded ? `exploded ${distance.toFixed(1)} blocks away` : 'never exploded in 25 s'}; run_from_creeper started ${ran} time(s)${died ? ', bot died' : ''}, health ${await s.health()}`
  };
}

// ---- running ---------------------------------------------------------------------------------------------------

function extend(session) {
  const { call, cmd, arena } = session;
  const s = Object.create(session);
  s.cursor = async () => Number((await call('get-events', { limit: 1 })).match(/nextSince: (\d+)/)[1]);
  s.eventsSince = async (since, types) => (await call('get-events', { since, types, limit: 100 })).split('\n').filter(line => line.startsWith('#'));
  s.died = async since => (await s.eventsSince(since, ['death'])).length > 0;
  s.health = async () => Number((await call('get-observation')).match(/Health: ([\d.]+)/)?.[1] ?? NaN);
  s.food = async () => Number((await call('get-observation')).match(/food: ([\d.]+)/)?.[1] ?? NaN);
  // Only the mobs a scenario summoned with this tag: zombies that spawn by themselves nearby must not count (M14).
  s.countTagged = async tag => {
    const since = await s.cursor();
    await cmd(`/execute if entity @e[tag=${tag}]`);
    const answer = (await s.eventsSince(since, ['system'])).find(line => /Test (passed|failed)/.test(line)) ?? '';
    return Number(answer.match(/count: (\d+)/)?.[1] ?? (answer.includes('failed') ? 0 : NaN));
  };
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
    await cmd(`/fill ${cx - r} ${y0} ${cz - r} ${cx + r} ${y0 + 6} ${cz + r} air`);
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
        table.push({ round, config: config.name, scenario: name, result: outcome.ok ? 'pass' : 'FAIL', detail: outcome.detail, required: config.required && !STRESS_TESTS.has(name) });
      }
      await s.reset();
      await session.cleanup();
    } catch (error) {
      setupFailed = setupFailed || error instanceof SetupFailed;
      console.error(error instanceof SetupFailed ? error.message : error);
      for (const name of scenarioNames) {
        if (!table.some(row => row.round === round && row.config === config.name && row.scenario === name)) {
          table.push({ round, config: config.name, scenario: name, result: 'FAIL', detail: 'setup failed', required: config.required && !STRESS_TESTS.has(name) });
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
for (const row of table) console.log(`| ${row.round} | ${row.scenario}${STRESS_TESTS.has(row.scenario) ? ' (stress)' : ''} | ${row.config} | ${row.result} | ${row.detail} |`);
const requiredFailures = table.filter(row => row.required && row.result !== 'pass');
console.log(requiredFailures.length === 0 && !setupFailed
  ? '\nScenario test passed: every required scenario passed in the instinct configuration'
  : `\nScenario test failed: ${requiredFailures.map(row => `${row.scenario} (round ${row.round})`).join(', ') || 'setup'}`);
process.exitCode = requiredFailures.length === 0 && !setupFailed ? 0 : 1;
