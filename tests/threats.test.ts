// Verifies docs/BLUEPRINT.md F-023 against the F-010 contract (src/autopilot/threats.ts) and invariant I1 (G6).
// Expected values come from the contracts: creeper danger radius 7, low air <= 6 bubbles and health below 6 (F-013 defaults).
import test from 'ava';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { assessThreats, checkTarget, legalHostilesNear } from '../src/autopilot/threats.js';

const registry = minecraftData('1.21.8');
const HOSTILE = new Set(['zombie', 'skeleton', 'spider', 'creeper']);

type FakeEntity = Record<string, unknown> & { id: number };

/** Builds an entity metadata array with values placed at the index of each key for that entity type. */
function meta(name: string, values: Record<string, unknown>): unknown[] {
  const keys = registry.entitiesByName[name]?.metadataKeys as string[] | undefined;
  if (!keys) throw new Error(`no metadata keys for ${name}`);
  const result: unknown[] = [];
  for (const [key, value] of Object.entries(values)) {
    const index = keys.indexOf(key);
    if (index < 0) throw new Error(`${name} has no metadata key ${key}`);
    result[index] = value;
  }
  return result;
}

let nextId = 100;

function mob(name: string, x: number, z: number, extra: Record<string, unknown> = {}, y = 64): FakeEntity {
  return {
    id: nextId++,
    name,
    type: HOSTILE.has(name) ? 'hostile' : 'animal',
    position: new Vec3(x, y, z),
    isValid: true,
    metadata: [],
    ...extra
  };
}

function player(username: string, x: number, z: number): FakeEntity {
  return { id: nextId++, name: 'player', type: 'player', username, position: new Vec3(x, 64, z), isValid: true, metadata: [] };
}

function swellingCreeper(x: number, z: number): FakeEntity {
  return mob('creeper', x, z, { metadata: meta('creeper', { swell_dir: 1, is_ignited: false }) });
}

function ignitedCreeper(x: number, z: number): FakeEntity {
  return mob('creeper', x, z, { metadata: meta('creeper', { swell_dir: -1, is_ignited: true }) });
}

function idleCreeper(x: number, z: number): FakeEntity {
  return mob('creeper', x, z, { metadata: meta('creeper', { swell_dir: -1, is_ignited: false }) });
}

function tamedWolf(x: number, z: number): FakeEntity {
  return mob('wolf', x, z, { metadata: meta('wolf', { owneruuid: '0b1c2d3e-0000-4000-8000-000000000001' }) });
}

interface WorldOptions {
  entities?: FakeEntity[];
  /** Raw self metadata: index 0 is the shared flags byte, index 1 the air supply in ticks. */
  selfMetadata?: unknown[];
  lava?: Vec3[];
  health?: number;
  position?: Vec3;
}

/** The bot stands at (0.5, 64, 0.5), so offsets are measured from the middle of block (0, 64, 0). */
function world(options: WorldOptions = {}) {
  const self = { id: 1, name: 'player', type: 'player', username: 'Bot', position: options.position ?? new Vec3(0.5, 64, 0.5), metadata: options.selfMetadata ?? [] };
  const lava = new Set((options.lava ?? []).map(pos => `${pos.x},${pos.y},${pos.z}`));
  const entities: Record<number, unknown> = { 1: self };
  for (const entity of options.entities ?? []) entities[entity.id] = entity;
  const bot = {
    registry,
    entity: self,
    entities,
    players: {},
    health: options.health,
    blockAt: (pos: Vec3) => {
      const floored = pos.floored();
      return { name: lava.has(`${floored.x},${floored.y},${floored.z}`) ? 'lava' : 'air', position: floored };
    }
  };
  return { bot: bot as never, self };
}

/** Offsets from the bot's position (0.5, 64, 0.5). */
const at = (dx: number, dz: number): [number, number] => [0.5 + dx, 0.5 + dz];

function ids(threats: { entity: { id: number } }[]): number[] {
  return threats.map(threat => threat.entity.id);
}

// --- assessThreats: creepers -------------------------------------------------

test('a swelling creeper within 7 blocks is the top threat even when a zombie is closer', (t) => {
  const zombie = mob('zombie', ...at(2, 0));
  const creeper = swellingCreeper(...at(0, 6));
  const { bot } = world({ entities: [zombie, creeper] });

  const summary = assessThreats(bot);

  t.is(summary.creeper?.entity.id, creeper.id, 'the swelling creeper is reported as the creeper threat');
  t.is(summary.top?.entity.id, creeper.id, 'the swelling creeper outranks the closer zombie');
  t.deepEqual(ids(summary.hostiles), [zombie.id, creeper.id], 'creeper priority does not reorder the distance-sorted list');
  t.true(Math.abs((summary.creeper?.distance ?? NaN) - 6) < 1e-6);
});

test('an ignited creeper (flint and steel, swell_dir -1) within 7 blocks is the top threat', (t) => {
  const zombie = mob('zombie', ...at(-2, 0));
  const creeper = ignitedCreeper(...at(5, 0));
  const { bot } = world({ entities: [zombie, creeper] });

  const summary = assessThreats(bot);

  t.is(summary.creeper?.entity.id, creeper.id);
  t.is(summary.top?.entity.id, creeper.id);
  t.is(summary.hostiles[0]?.entity.id, zombie.id);
});

test('a creeper that is not swelling is not the creeper threat, even when close', (t) => {
  const creeper = idleCreeper(...at(3, 0));
  const { bot } = world({ entities: [creeper] });

  const summary = assessThreats(bot);

  t.is(summary.creeper, null);
  t.deepEqual(ids(summary.hostiles), [creeper.id], 'an idle creeper is still a hostile');
});

test('a swelling creeper 10 blocks away is not the creeper threat; the nearest hostile is the top threat', (t) => {
  const zombie = mob('zombie', ...at(0, 4));
  const creeper = swellingCreeper(...at(10, 0));
  const { bot } = world({ entities: [zombie, creeper] });

  const summary = assessThreats(bot);

  t.is(summary.creeper, null, 'creepers beyond 7 blocks are not the explosion threat');
  t.is(summary.top?.entity.id, zombie.id);
  t.true(ids(summary.hostiles).includes(creeper.id), 'the far creeper is still listed as a hostile');
});

// --- assessThreats: hostiles ----------------------------------------------------

test('hostiles are sorted nearest first with their distances', (t) => {
  const zombie = mob('zombie', ...at(8, 0));
  const skeleton = mob('skeleton', ...at(0, -3));
  const spider = mob('spider', ...at(-5, 0));
  const { bot } = world({ entities: [zombie, skeleton, spider] });

  const summary = assessThreats(bot);

  t.deepEqual(ids(summary.hostiles), [skeleton.id, spider.id, zombie.id]);
  const distances = summary.hostiles.map(threat => threat.distance);
  [3, 5, 8].forEach((expected, i) => t.true(Math.abs(distances[i] - expected) < 1e-6, `distance ${i}: expected ${expected}, got ${distances[i]}`));
  t.is(summary.top?.entity.id, skeleton.id, 'with no swelling creeper the nearest hostile is the top threat');
  t.is(summary.creeper, null);
});

test('only hostile mobs inside the radius count; players, passive and neutral mobs do not', (t) => {
  const near = mob('zombie', ...at(4, 0));
  const far = mob('zombie', ...at(12, 0));
  const pig = mob('pig', ...at(1, 0));
  const steve = player('Steve', ...at(0, 1));
  const enderman = mob('enderman', ...at(-1, 0));
  const { bot } = world({ entities: [near, far, pig, steve, enderman] });

  const summary = assessThreats(bot, { radius: 10 });

  t.deepEqual(ids(summary.hostiles), [near.id]);
});

test('the bot itself and a tamed wolf are not listed as hostiles', (t) => {
  const wolf = tamedWolf(...at(2, 0));
  const { bot } = world({ entities: [wolf] });

  const summary = assessThreats(bot);

  t.deepEqual(summary.hostiles, []);
  t.is(summary.top, null);
});

// --- assessThreats: self state ------------------------------------------------

test('being on fire is read from bit 0 of the shared flags', (t) => {
  t.true(assessThreats(world({ selfMetadata: [0x01] }).bot).onFire);
  t.true(assessThreats(world({ selfMetadata: [0x01 | 0x02 | 0x08] }).bot).onFire, 'other flags set alongside burning');
  t.false(assessThreats(world({ selfMetadata: [0x02] }).bot).onFire, 'crouching alone is not burning');
  t.false(assessThreats(world({ selfMetadata: [0] }).bot).onFire);
  t.false(assessThreats(world().bot).onFire, 'no metadata is not burning');
});

test('standing in lava is detected at the feet or at the head', (t) => {
  t.true(assessThreats(world({ lava: [new Vec3(0, 64, 0)] }).bot).inLava, 'lava at the feet');
  t.true(assessThreats(world({ lava: [new Vec3(0, 65, 0)] }).bot).inLava, 'lava at the head');
  t.false(assessThreats(world({ lava: [new Vec3(1, 64, 0), new Vec3(0, 63, 0)] }).bot).inLava, 'lava beside or below is not being in lava');
  t.false(assessThreats(world().bot).inLava);
});

test('low air is detected at 6 bubbles or fewer', (t) => {
  const drowning = assessThreats(world({ selfMetadata: [0, 60] }).bot);
  t.is(drowning.air, 4);
  t.true(drowning.lowAir);

  const boundary = assessThreats(world({ selfMetadata: [0, 90] }).bot);
  t.is(boundary.air, 6);
  t.true(boundary.lowAir, '6 bubbles is low (the default instinct.lowAir is 6: air <= 6 is a cue)');

  const full = assessThreats(world({ selfMetadata: [0, 300] }).bot);
  t.is(full.air, 20);
  t.false(full.lowAir);
});

test('low health is detected below the default threshold of 6', (t) => {
  const hurt = assessThreats(world({ health: 4 }).bot);
  t.is(hurt.health, 4);
  t.true(hurt.lowHealth);

  t.false(assessThreats(world({ health: 6 }).bot).lowHealth, 'exactly 6 is not below the threshold');
  t.false(assessThreats(world({ health: 20 }).bot).lowHealth);
});

// --- assessThreats: flee direction --------------------------------------------

function assertUnitHorizontal(t: import('ava').ExecutionContext, v: Vec3, expected: [number, number]) {
  t.is(v.y, 0, 'the flee direction is horizontal');
  t.true(Math.abs(Math.hypot(v.x, v.z) - 1) < 1e-6, `unit length expected, got ${Math.hypot(v.x, v.z)}`);
  t.true(Math.abs(v.x - expected[0]) < 1e-6, `x: expected ${expected[0]}, got ${v.x}`);
  t.true(Math.abs(v.z - expected[1]) < 1e-6, `z: expected ${expected[1]}, got ${v.z}`);
}

test('the flee direction points away from a single hostile and ignores height', (t) => {
  const zombie = mob('zombie', ...at(10, 0), {}, 70);
  const { bot } = world({ entities: [zombie] });

  assertUnitHorizontal(t, assessThreats(bot).fleeDirection, [-1, 0]);
});

test('the flee direction points away from the centroid of several hostiles', (t) => {
  const a = mob('zombie', ...at(10, 0));
  const b = mob('skeleton', ...at(0, 10), {}, 61);
  const { bot } = world({ entities: [a, b] });

  assertUnitHorizontal(t, assessThreats(bot).fleeDirection, [-Math.SQRT1_2, -Math.SQRT1_2]);
});

test('with no threats the summary is empty and the flee direction is zero', (t) => {
  const pig = mob('pig', ...at(3, 0));
  const { bot } = world({ entities: [pig] });

  const summary = assessThreats(bot);

  t.deepEqual(summary.hostiles, []);
  t.is(summary.creeper, null);
  t.is(summary.top, null);
  t.is(Math.hypot(summary.fleeDirection.x, summary.fleeDirection.y, summary.fleeDirection.z), 0);
});

test('the same state gives the same result', (t) => {
  const entities = [mob('zombie', ...at(6, 2)), mob('spider', ...at(-3, 4)), swellingCreeper(...at(1, 5))];
  const { bot } = world({ entities, health: 10, selfMetadata: [0, 200] });

  const first = assessThreats(bot);
  const second = assessThreats(bot);

  t.deepEqual(ids(second.hostiles), ids(first.hostiles));
  t.is(second.top?.entity.id, first.top?.entity.id);
  t.deepEqual([second.fleeDirection.x, second.fleeDirection.z], [first.fleeDirection.x, first.fleeDirection.z]);
  t.deepEqual([second.onFire, second.inLava, second.air, second.health], [first.onFire, first.inLava, first.air, first.health]);
});

// --- assessThreats: bad data --------------------------------------------------

test('entities with missing or unreadable data are skipped without throwing', (t) => {
  const zombie = mob('zombie', ...at(3, 0));
  const noPosition = { id: 201, name: 'zombie', type: 'hostile', isValid: true, metadata: [] };
  const noName = { id: 202, type: 'hostile', position: new Vec3(1.5, 64, 0.5), isValid: true };
  const throwingPosition = { id: 203, name: 'zombie', type: 'hostile', isValid: true, get position(): Vec3 { throw new Error('boom'); } };
  const throwingMetadata = {
    id: 204, name: 'creeper', type: 'hostile', isValid: true, position: new Vec3(2.5, 64, 0.5),
    get metadata(): unknown[] { throw new Error('boom'); }
  };
  const throwingName = { id: 205, type: 'hostile', isValid: true, position: new Vec3(1.5, 64, 1.5), get name(): string { throw new Error('boom'); } };
  const { bot } = world({ entities: [zombie, noPosition, noName, throwingPosition, throwingMetadata, throwingName] });

  let summary: ReturnType<typeof assessThreats> | undefined;
  t.notThrows(() => { summary = assessThreats(bot); });
  const reported = ids(summary?.hostiles ?? []);
  t.true(reported.includes(zombie.id), 'a valid hostile is still reported next to bad entities');
  for (const bad of [201, 202, 203, 205]) t.false(reported.includes(bad), `entity ${bad} is not reported`);
  t.is(summary?.creeper ?? null, null, 'an unreadable creeper is not reported as swelling');
});

// F-010 失败处理: 实体数据缺失或异常时视为非威胁并跳过 — an entity whose metadata throws must not be half-listed.
test('a creeper whose metadata cannot be read is skipped, not listed as a hostile', (t) => {
  const zombie = mob('zombie', ...at(3, 0));
  const throwingMetadata = {
    id: 204, name: 'creeper', type: 'hostile', isValid: true, position: new Vec3(2.5, 64, 0.5),
    get metadata(): unknown[] { throw new Error('boom'); }
  };
  const { bot } = world({ entities: [zombie, throwingMetadata] });

  let summary: ReturnType<typeof assessThreats> | undefined;
  t.notThrows(() => { summary = assessThreats(bot); });
  t.deepEqual(ids(summary?.hostiles ?? []), [zombie.id]);
  t.is(summary?.top?.entity.id, zombie.id);
});

// --- checkTarget --------------------------------------------------------------

test('a player is an illegal target by default and legal only with attackPlayers true (I1)', (t) => {
  const steve = player('Steve', ...at(2, 0));
  const { bot } = world({ entities: [steve] });

  const byDefault = checkTarget(bot, steve as never);
  t.false(byDefault.legal);
  if (!byDefault.legal) t.true(byDefault.reason.length > 0, 'an illegal result explains why');

  t.false(checkTarget(bot, steve as never, { attackPlayers: false }).legal);
  t.false(checkTarget(bot, steve as never, { allowTypes: ['player'] }).legal, 'naming players in allowTypes does not bypass attackPlayers');
  t.false(checkTarget(bot, steve as never, { allowTypes: ['player'], attackPlayers: false }).legal);
  t.true(checkTarget(bot, steve as never, { attackPlayers: true }).legal);
});

test('a player recognised only by its username is still a player (I1)', (t) => {
  const alex = { id: 300, username: 'Alex', type: 'other', position: new Vec3(2.5, 64, 0.5), isValid: true };
  const { bot } = world({ entities: [alex] });

  t.false(checkTarget(bot, alex as never).legal);
});

test('the bot itself is never a target', (t) => {
  const { bot, self } = world();

  t.false(checkTarget(bot, self as never).legal);
  t.false(checkTarget(bot, self as never, { attackPlayers: true }).legal);
});

test('a tamed wolf is illegal even when wolves are allowed and players may be attacked', (t) => {
  const wolf = tamedWolf(...at(2, 0));
  const { bot } = world({ entities: [wolf] });

  t.false(checkTarget(bot, wolf as never).legal);
  t.false(checkTarget(bot, wolf as never, { allowTypes: ['wolf'] }).legal);
  t.false(checkTarget(bot, wolf as never, { allowTypes: ['wolf'], attackPlayers: true }).legal);
  const result = checkTarget(bot, wolf as never, { allowTypes: ['wolf'] });
  if (!result.legal) t.true(result.reason.length > 0);
});

test('an untamed wolf is legal only when wolves are named in allowTypes', (t) => {
  const wolf = mob('wolf', ...at(2, 0));
  const { bot } = world({ entities: [wolf] });

  t.false(checkTarget(bot, wolf as never).legal);
  t.false(checkTarget(bot, wolf as never, { attackPlayers: true }).legal);
  t.false(checkTarget(bot, wolf as never, { allowTypes: ['pig'] }).legal);
  t.true(checkTarget(bot, wolf as never, { allowTypes: ['wolf'] }).legal);
});

test('default neutral mobs are illegal targets', (t) => {
  const { bot } = world();
  for (const name of ['enderman', 'zombified_piglin', 'piglin', 'polar_bear', 'bee', 'wolf']) {
    const entity = mob(name, ...at(2, 0));
    t.false(checkTarget(bot, entity as never).legal, `${name} is illegal by default`);
    t.false(checkTarget(bot, entity as never, { attackPlayers: true }).legal, `${name} stays illegal with attackPlayers`);
  }
});

test('a passive mob is illegal by default and legal only when its type is named (hunt)', (t) => {
  const pig = mob('pig', ...at(2, 0));
  const cow = mob('cow', ...at(-2, 0));
  const { bot } = world({ entities: [pig, cow] });

  t.false(checkTarget(bot, pig as never).legal);
  t.true(checkTarget(bot, pig as never, { allowTypes: ['pig'] }).legal);
  t.false(checkTarget(bot, cow as never, { allowTypes: ['pig'] }).legal, 'naming pigs does not make cows legal');
});

test('hostile mobs are legal targets', (t) => {
  const { bot } = world();
  for (const name of ['zombie', 'skeleton', 'creeper', 'spider']) {
    t.true(checkTarget(bot, mob(name, ...at(2, 0)) as never).legal, `${name} is legal`);
  }
});

test('missing or unreadable entity data gives an illegal result without throwing', (t) => {
  const { bot } = world();
  const cases: [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['no name', { id: 400, type: 'hostile', position: new Vec3(1, 64, 0), isValid: true }],
    ['no position or name', { id: 401 }],
    ['throwing name', { id: 402, type: 'hostile', isValid: true, get name(): string { throw new Error('boom'); } }],
    ['throwing type', { id: 403, name: 'zombie', isValid: true, get type(): string { throw new Error('boom'); } }],
    ['throwing metadata', { id: 404, name: 'wolf', type: 'animal', isValid: true, get metadata(): unknown[] { throw new Error('boom'); } }]
  ];
  for (const [label, entity] of cases) {
    let result: ReturnType<typeof checkTarget> | undefined;
    t.notThrows(() => { result = checkTarget(bot, entity as never, { allowTypes: ['wolf'] }); }, label);
    t.false(result?.legal ?? true, `${label} is not a legal target`);
  }
});

// --- legalHostilesNear --------------------------------------------------------

test('legalHostilesNear measures from the given center and keeps only legal hostiles', (t) => {
  const center = new Vec3(100.5, 64, 100.5);
  const nearCenter = mob('zombie', 103.5, 100.5);
  const fartherFromCenter = mob('skeleton', 100.5, 106.5);
  const nearBot = mob('zombie', ...at(2, 0));
  const outside = mob('spider', 100.5, 115.5);
  const pig = mob('pig', 101.5, 100.5);
  const steve = player('Steve', 99.5, 100.5);
  const enderman = mob('enderman', 100.5, 101.5);
  const wolf = mob('wolf', 100.5, 99.5);
  const { bot } = world({ entities: [fartherFromCenter, nearCenter, nearBot, outside, pig, steve, enderman, wolf] });

  const found = legalHostilesNear(bot, center, 10);

  t.deepEqual(ids(found), [nearCenter.id, fartherFromCenter.id], 'nearest to the center first; others excluded');
  t.true(Math.abs(found[0].distance - 3) < 1e-6, `distance from the center: expected 3, got ${found[0]?.distance}`);
  t.true(Math.abs(found[1].distance - 6) < 1e-6);
});

test('legalHostilesNear never returns players, even with attackPlayers true', (t) => {
  const center = new Vec3(0.5, 64, 0.5);
  const steve = player('Steve', ...at(2, 0));
  const zombie = mob('zombie', ...at(0, 4));
  const { bot } = world({ entities: [steve, zombie] });

  t.deepEqual(ids(legalHostilesNear(bot, center, 10, { attackPlayers: true })), [zombie.id]);
});

test('legalHostilesNear skips entities with missing or unreadable data', (t) => {
  const center = new Vec3(0.5, 64, 0.5);
  const zombie = mob('zombie', ...at(3, 0));
  const noPosition = { id: 501, name: 'zombie', type: 'hostile', isValid: true };
  const throwingPosition = { id: 502, name: 'zombie', type: 'hostile', isValid: true, get position(): Vec3 { throw new Error('boom'); } };
  const { bot } = world({ entities: [zombie, noPosition, throwingPosition] });

  let found: ReturnType<typeof legalHostilesNear> = [];
  t.notThrows(() => { found = legalHostilesNear(bot, center, 10); });
  t.deepEqual(ids(found), [zombie.id]);
});

// --- checkTarget: tamed animals beyond owneruuid (invariant I1) ---------------
// Horse-family mobs (incl. llama and camel) mark "tamed" as bit 0x02 of their 'flags' byte; wolves, cats and
// parrots mark it as bit 0x04. F-010: 被驯服的动物永远不合法 — even when the caller names the type in allowTypes.

const HORSE_TAMED = 0x02;
const TAMABLE_TAMED = 0x04;

test('tamed horse, donkey, llama and camel (flags bit 0x02) are illegal even when their type is named', (t) => {
  const { bot } = world();
  for (const name of ['horse', 'donkey', 'llama', 'camel']) {
    const tamed = mob(name, ...at(2, 0), { metadata: meta(name, { flags: HORSE_TAMED }) });
    t.false(checkTarget(bot, tamed as never).legal, `tamed ${name} is illegal by default`);
    const named = checkTarget(bot, tamed as never, { allowTypes: [name] });
    t.false(named.legal, `tamed ${name} is illegal even with allowTypes [${name}]`);
    if (!named.legal) t.true(named.reason.length > 0, `tamed ${name}: an illegal result explains why`);
    t.false(checkTarget(bot, tamed as never, { allowTypes: [name], attackPlayers: true }).legal, `tamed ${name} stays illegal with attackPlayers`);

    // Other bits of the flags byte set alongside the tamed bit (0x08 bred, 0x20 rearing) do not hide it.
    const busy = mob(name, ...at(2, 0), { metadata: meta(name, { flags: HORSE_TAMED | 0x08 | 0x20 }) });
    t.false(checkTarget(bot, busy as never, { allowTypes: [name] }).legal, `tamed ${name} with other flag bits is illegal`);
  }
});

test('an untamed horse is legal when horses are named in allowTypes', (t) => {
  const { bot } = world();
  const plain = mob('horse', ...at(2, 0), { metadata: meta('horse', { flags: 0 }) });
  const noMetadata = mob('horse', ...at(2, 0));
  const bred = mob('horse', ...at(2, 0), { metadata: meta('horse', { flags: 0x08 }) });

  for (const [label, horse] of [['flags 0', plain], ['no metadata', noMetadata], ['bred bit only', bred]] as const) {
    t.true(checkTarget(bot, horse as never, { allowTypes: ['horse'] }).legal, `untamed horse (${label}) is legal with allowTypes [horse]`);
    t.false(checkTarget(bot, horse as never).legal, `untamed horse (${label}) is not hostile, so illegal by default`);
    t.false(checkTarget(bot, horse as never, { allowTypes: ['pig'] }).legal, `untamed horse (${label}) is illegal when only pigs are named`);
  }
});

test('a wolf tamed only through flags bit 0x04 (no owneruuid) is illegal even when wolves are named', (t) => {
  const { bot } = world();
  const wolf = mob('wolf', ...at(2, 0), { metadata: meta('wolf', { flags: TAMABLE_TAMED }) });
  const sittingWolf = mob('wolf', ...at(2, 0), { metadata: meta('wolf', { flags: TAMABLE_TAMED | 0x01 }) });

  for (const [label, entity] of [['tamed', wolf], ['tamed and sitting', sittingWolf]] as const) {
    t.false(checkTarget(bot, entity as never).legal, `${label} wolf is illegal by default`);
    const named = checkTarget(bot, entity as never, { allowTypes: ['wolf'] });
    t.false(named.legal, `${label} wolf is illegal even with allowTypes [wolf]`);
    if (!named.legal) t.true(named.reason.length > 0);
    t.false(checkTarget(bot, entity as never, { allowTypes: ['wolf'], attackPlayers: true }).legal, `${label} wolf stays illegal with attackPlayers`);
  }

  // Control: the same wolf without the tamed bit is legal when named, so the 0x04 bit is what makes it illegal.
  const wild = mob('wolf', ...at(2, 0), { metadata: meta('wolf', { flags: 0 }) });
  t.true(checkTarget(bot, wild as never, { allowTypes: ['wolf'] }).legal);
});

test('a cat with an owner uuid is illegal even when cats are named', (t) => {
  const { bot } = world();
  const cat = mob('cat', ...at(2, 0), { metadata: meta('cat', { owneruuid: '0b1c2d3e-0000-4000-8000-000000000002' }) });

  t.false(checkTarget(bot, cat as never).legal);
  const named = checkTarget(bot, cat as never, { allowTypes: ['cat'] });
  t.false(named.legal, 'a tamed cat is illegal even with allowTypes [cat]');
  if (!named.legal) t.true(named.reason.length > 0);
  t.false(checkTarget(bot, cat as never, { allowTypes: ['cat'], attackPlayers: true }).legal);

  // Control: a stray cat (no owner, no tamed bit) is legal when named.
  const stray = mob('cat', ...at(2, 0), { metadata: meta('cat', { flags: 0 }) });
  t.true(checkTarget(bot, stray as never, { allowTypes: ['cat'] }).legal);
});
