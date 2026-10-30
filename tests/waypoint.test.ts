import test from 'ava';
import sinon from 'sinon';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { WaypointStore } from '../src/waypoint-store.js';
import { registerWaypointTools } from '../src/tools/waypoint-tools.js';
import { ActionArbiter } from '../src/autopilot/action-arbiter.js';
import { TaskManager } from '../src/autopilot/task-manager.js';
import { returnHomeBehavior } from '../src/autopilot/behaviors/return-home.js';
import { guardBehavior } from '../src/autopilot/behaviors/guard.js';
import { EventStore } from '../src/event-store.js';
import { arriveAtGoal, asBot, createFactory } from './_helpers.js';

function tempFile(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-waypoints-')), 'nested', 'waypoints.json');
}

const waypoint = { x: 1, y: 2, z: 3, createdAt: 0 };

test('store persists waypoints across instances', (t) => {
  const file = tempFile();
  new WaypointStore(file, 'localhost').set('Home', waypoint);

  const reopened = new WaypointStore(file, 'localhost');

  t.deepEqual(reopened.get('home'), waypoint);
  t.deepEqual(Object.keys(reopened.list()), ['home']);
});

test('store separates namespaces and handles delete', (t) => {
  const file = tempFile();
  const a = new WaypointStore(file, 'a.example');
  const b = new WaypointStore(file, 'b.example');
  a.set('base', waypoint);

  t.is(b.get('base'), undefined);
  t.true(a.delete(' BASE '));
  t.false(a.delete('base'));
  t.deepEqual(a.list(), {});
});

test('store rejects empty names and refuses to overwrite a corrupted file', (t) => {
  const file = tempFile();
  const store = new WaypointStore(file, 'localhost');
  t.throws(() => store.set('  ', waypoint), { message: /empty/ });

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{not json');
  t.throws(() => store.list(), { message: /corrupted/ });
  t.throws(() => store.set('x', waypoint), { message: /corrupted/ });
  t.is(fs.readFileSync(file, 'utf8'), '{not json');
});

function setup() {
  const store = new WaypointStore(tempFile(), 'localhost');
  const bot = {
    entity: { position: new Vec3(10.7, 64.2, -3.5) },
    game: { dimension: 'overworld' },
    pathfinder: { goto: sinon.stub().resolves(), stop: sinon.stub(), setGoal: sinon.stub() }
  };
  const { factory, getTool } = createFactory();
  registerWaypointTools(factory, asBot(bot), store);
  return { store, bot, getTool };
}

test('set-waypoint saves the current position by default', async (t) => {
  const { store, getTool } = setup();

  const result = await getTool('set-waypoint')!.execute({ name: 'Home', note: 'my base' });

  t.true(result.content[0].text.includes("Saved waypoint 'home' at (10, 64, -4)"));
  t.like(store.get('home'), { x: 10, y: 64, z: -4, dimension: 'overworld', note: 'my base' });
});

test('set-waypoint accepts coordinates, updates, and rejects partial coordinates', async (t) => {
  const { store, getTool } = setup();

  await getTool('set-waypoint')!.execute({ name: 'mine', x: 100, y: 12, z: 50 });
  const updated = await getTool('set-waypoint')!.execute({ name: 'mine', x: 101, y: 12, z: 50 });
  const partial = await getTool('set-waypoint')!.execute({ name: 'bad', x: 1 });

  t.true(updated.content[0].text.includes('Updated waypoint'));
  t.is(store.get('mine')!.x, 101);
  t.true(partial.isError);
  t.is(store.get('bad'), undefined);
});

test('list-waypoints shows distance and dimension mismatch', async (t) => {
  const { store, getTool } = setup();
  const empty = await getTool('list-waypoints')!.execute({});
  t.true(empty.content[0].text.includes('No waypoints saved'));

  store.set('spawn', { x: 10, y: 64, z: -4, dimension: 'overworld', createdAt: 0, note: 'start' });
  store.set('portal', { x: 0, y: 64, z: 0, dimension: 'the_nether', createdAt: 0 });

  const text = (await getTool('list-waypoints')!.execute({})).content[0].text;

  t.true(text.includes('- spawn: (10, 64, -4)'));
  t.true(text.includes('- start'));
  t.true(text.includes('in the_nether (bot is in overworld)'));
});

test('delete-waypoint removes or reports unknown', async (t) => {
  const { store, getTool } = setup();
  store.set('a', waypoint);

  const ok = await getTool('delete-waypoint')!.execute({ name: 'a' });
  const missing = await getTool('delete-waypoint')!.execute({ name: 'a' });

  t.true(ok.content[0].text.includes("Deleted waypoint 'a'"));
  t.true(missing.isError);
});

test('goto-waypoint paths to the saved location', async (t) => {
  const { store, bot, getTool } = setup();
  store.set('home', { ...waypoint, x: 5, y: 70, z: 9, dimension: 'overworld' });
  // The pathfinder really gets the bot there; goto-waypoint checks the arrival (M7).
  bot.pathfinder.goto.callsFake(arriveAtGoal(bot));

  const result = await getTool('goto-waypoint')!.execute({ name: 'home', range: 3 });

  const goal = bot.pathfinder.goto.firstCall.args[0];
  t.is(goal.x, 5);
  t.is(goal.y, 70);
  t.is(goal.z, 9);
  t.is(goal.rangeSq, 9);
  t.true(result.content[0].text.includes("Arrived near waypoint 'home'"));
});

test('M7: goto-waypoint reports an error when the pathfinder finishes without getting the bot there', async (t) => {
  const { store, bot, getTool } = setup();
  store.set('home', { ...waypoint, x: 20, y: 70, z: 9, dimension: 'overworld' });
  bot.pathfinder.goto.resolves();

  const result = await getTool('goto-waypoint')!.execute({ name: 'home', range: 2 });

  t.true(result.isError);
  t.regex(result.content[0].text, /^Failed: Did not reach waypoint 'home': stopped at \(-?\d+, -?\d+, -?\d+\), [\d.]+ blocks from the target: the pathfinder found no way closer$/);
});

test('goto-waypoint rejects unknown waypoints and other dimensions', async (t) => {
  const { store, bot, getTool } = setup();
  store.set('portal', { ...waypoint, dimension: 'the_nether' });

  const unknown = await getTool('goto-waypoint')!.execute({ name: 'nope' });
  const wrongDimension = await getTool('goto-waypoint')!.execute({ name: 'portal' });

  t.true(unknown.isError);
  t.true(wrongDimension.isError);
  t.true(wrongDimension.content[0].text.includes('the_nether'));
  t.false(bot.pathfinder.goto.called);
});

test('goto-waypoint times out and stops the pathfinder', async (t) => {
  const { store, bot, getTool } = setup();
  store.set('far', { ...waypoint, dimension: 'overworld' });
  bot.pathfinder.goto = sinon.stub().returns(new Promise(() => {}));

  const result = await getTool('goto-waypoint')!.execute({ name: 'far', timeoutMs: 60 });

  t.true(result.isError);
  t.true(result.content[0].text.includes('timed out'));
  t.true(bot.pathfinder.stop.calledOnce);
});

// ---------------------------------------------------------------------------------------------------------------
// E-041 (Q30): waypoints are kept per host and world fingerprint, "<host>|seed:<hex>". The entries under the bare host
// key from before are legacy waypoints: list-waypoints lists them apart, every lookup by name refuses them with the
// migration error until set-waypoint saves them again, and only delete-waypoint removes them. Without a fingerprint
// the host key is the namespace, exactly as before (the cases above run that way).
// ---------------------------------------------------------------------------------------------------------------

const HOST = 'localhost';
const WORLD_A = '0123456789abcdef';
const WORLD_B = 'fedcba9876543211';
const legacyHome = { x: 20, y: 64, z: 0, dimension: 'overworld', note: 'old base', createdAt: 0 };
const legacyMine = { x: 100, y: 12, z: 50, dimension: 'overworld', createdAt: 0 };

/** The E-041 migration error, word for word. */
const migrationError = (name: string, place: string) =>
  `Waypoint '${name}' was saved before waypoints were kept per world and may belong to another world: ${place}. ` +
  'If it is in this world, save it again with set-waypoint, then retry';
// The fixed parts of the list-waypoints sentence; the "…" between them is the legacy waypoints.
const LEGACY_LIST_START = 'Saved before waypoints were kept per world (they may belong to another world on this host): ';
const LEGACY_LIST_END = '; to keep one here, call set-waypoint with its name and coordinates';

function seedFile(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function readFile(file: string): Record<string, Record<string, unknown>> {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function legacyLine(text: string): string | undefined {
  return text.split('\n').find(line => line.startsWith(LEGACY_LIST_START));
}

/** The waypoint tools on a localhost store set to `world`, whose file already holds `legacy` under the host key. */
function worldSetup(legacy: Record<string, unknown> = { home: legacyHome, mine: legacyMine }, world: string | null = WORLD_A) {
  const file = tempFile();
  seedFile(file, { [HOST]: legacy });
  const store = new WaypointStore(file, HOST);
  store.setWorld(world);
  const bot = {
    entity: { position: new Vec3(10.7, 64.2, -3.5) },
    game: { dimension: 'overworld' },
    pathfinder: { goto: sinon.stub().resolves(), stop: sinon.stub(), setGoal: sinon.stub() }
  };
  const { factory, getTool } = createFactory();
  registerWaypointTools(factory, asBot(bot), store);
  return { file, store, bot, getTool };
}

const registry = minecraftData('1.21.8');

/** return-home and guard reading `store`, in the daytime, with a pathfinder that gets the bot to a goal at once. */
function taskWorld(store: WaypointStore) {
  const self = { id: 1, position: new Vec3(0, 64, 0) };
  const emitter = new EventEmitter();
  const moveTo = (goal: { x?: number; y?: number; z?: number } | null) => {
    if (goal && goal.x !== undefined) self.position = new Vec3(goal.x, goal.y!, goal.z!);
  };
  const pathfinder = {
    goal: null as unknown,
    goto: sinon.spy(async (goal: { x?: number; y?: number; z?: number }) => moveTo(goal)),
    setGoal: sinon.spy((goal: { x?: number; y?: number; z?: number } | null) => {
      pathfinder.goal = goal;
      moveTo(goal);
    }),
    stop: sinon.stub()
  };
  const bot = {
    version: '1.21.8',
    registry,
    entity: self,
    entities: { 1: self },
    players: {},
    health: 20,
    heldItem: null,
    game: { dimension: 'overworld' },
    time: { timeOfDay: 6000 },
    thunderState: 0,
    isSleeping: false,
    inventory: { items: () => [] },
    pathfinder,
    clearControlStates: sinon.stub(),
    lookAt: sinon.stub().resolves(),
    attack: sinon.stub(),
    _client: new EventEmitter(),
    on: (event: string, listener: (...args: unknown[]) => void) => emitter.on(event, listener),
    removeListener: (event: string, listener: (...args: unknown[]) => void) => emitter.removeListener(event, listener),
    isABed: () => false,
    findBlock: sinon.stub().returns(null)
  };
  const arbiter = new ActionArbiter({ stopBody: () => { pathfinder.goal = null; } });
  const tasks = new TaskManager({
    getBot: () => bot as never,
    getArbiter: () => arbiter,
    events: new EventStore(),
    services: { waypoints: store },
    behaviors: [returnHomeBehavior, guardBehavior] as never
  });
  return { tasks, pathfinder };
}

test('E-041 store: two world fingerprints on the same host do not see each other\'s waypoints', (t) => {
  const file = tempFile();
  const a = new WaypointStore(file, HOST);
  a.setWorld(WORLD_A);
  const b = new WaypointStore(file, HOST);
  b.setWorld(WORLD_B);

  a.set('Home', { ...waypoint, x: 1 });
  t.is(b.get('home'), undefined);
  t.deepEqual(b.list(), {});
  b.set('home', { ...waypoint, x: 2 });
  t.is(a.get('home')!.x, 1, 'the other world\'s home is its own');
  t.is(b.get('home')!.x, 2);
  t.false(b.delete('base'));
  a.set('base', waypoint);
  t.false(b.delete('base'), 'a waypoint of world A cannot be deleted from world B');
  t.deepEqual(Object.keys(a.list()).sort(), ['base', 'home']);

  // Neither world is the other's legacy: legacy waypoints are only those under the bare host key.
  t.deepEqual(a.legacyList(), {});
  t.deepEqual(Object.keys(readFile(file)).sort(), [`${HOST}|seed:${WORLD_A}`, `${HOST}|seed:${WORLD_B}`]);

  // One store follows the world it is set to.
  a.setWorld(WORLD_B);
  t.is(a.get('home')!.x, 2);
  t.is(a.get('base'), undefined);
  a.setWorld(WORLD_A);
  t.is(a.get('home')!.x, 1);
});

test('E-041 store: with a null fingerprint the host key is the namespace, as without setWorld, and there are no legacy waypoints', (t) => {
  const file = tempFile();
  seedFile(file, { [HOST]: { home: legacyHome } });
  const store = new WaypointStore(file, HOST);
  store.setWorld(WORLD_A);
  t.is(store.get('home'), undefined);
  store.setWorld(null);

  t.deepEqual(store.get('home'), legacyHome);
  t.deepEqual(store.list(), { home: legacyHome });
  t.deepEqual(store.legacyList(), {});
  t.is(store.legacyGet('home'), undefined);
  t.false(store.legacyDelete('home'));
  store.set('mine', legacyMine);
  t.deepEqual(readFile(file), { [HOST]: { home: legacyHome, mine: legacyMine } });
  t.deepEqual(new WaypointStore(file, HOST).list(), store.list(), 'the same as a store never given a world');
  t.true(store.delete('home'));
});

test('E-041 store: legacy waypoints are the host key\'s, read while a fingerprint is set; set writes only this world', (t) => {
  const file = tempFile();
  seedFile(file, { [HOST]: { home: legacyHome } });
  const store = new WaypointStore(file, HOST);
  t.deepEqual(store.legacyList(), {}, 'nothing is legacy before a fingerprint is set');
  store.setWorld(WORLD_A);

  t.deepEqual(store.legacyList(), { home: legacyHome });
  t.deepEqual(store.legacyGet(' HOME '), legacyHome, 'names are normalized as before');
  t.is(store.get('home'), undefined);
  store.set('home', waypoint);
  t.deepEqual(store.get('home'), waypoint);
  t.deepEqual(readFile(file), { [HOST]: { home: legacyHome }, [`${HOST}|seed:${WORLD_A}`]: { home: waypoint } });
  // Another host on the same file, in a world of the same fingerprint: the localhost key is not its legacy.
  const other = new WaypointStore(file, 'other.example');
  other.setWorld(WORLD_A);
  t.deepEqual(other.legacyList(), {}, 'another host has none');
  t.is(other.legacyGet('home'), undefined);
  t.false(other.legacyDelete('home'));
  t.deepEqual(readFile(file), { [HOST]: { home: legacyHome }, [`${HOST}|seed:${WORLD_A}`]: { home: waypoint } }, 'the file is untouched');
});

test('E-041 list-waypoints lists legacy waypoints apart, after this world\'s, without those this world has a waypoint of that name for', async (t) => {
  const { store, getTool } = worldSetup();
  store.set('home', { x: 10, y: 64, z: -4, dimension: 'overworld', createdAt: 0 });

  const text = (await getTool('list-waypoints')!.execute({})).content[0].text;

  t.true(text.startsWith('1 waypoint(s):\n\n- home: (10, 64, -4), 1 blocks away\n'), text);
  const line = legacyLine(text);
  t.truthy(line, text);
  t.true(text.indexOf('- home:') < text.indexOf(LEGACY_LIST_START), 'after this world\'s waypoints');
  // The waypoints in "…": name, coordinates and dimension, which set-waypoint needs to save one again.
  t.is(line, `${LEGACY_LIST_START}mine (100, 12, 50) in overworld${LEGACY_LIST_END}`);
});

test('E-041 list-waypoints with only legacy waypoints still lists them, after "No waypoints saved"', async (t) => {
  const { getTool } = worldSetup({ home: legacyHome, mine: legacyMine, old: { x: 1, y: 2, z: 3, createdAt: 0 } });

  const text = (await getTool('list-waypoints')!.execute({})).content[0].text;

  t.true(text.startsWith('No waypoints saved'), text);
  t.is(legacyLine(text), `${LEGACY_LIST_START}home (20, 64, 0) in overworld, mine (100, 12, 50) in overworld, old (1, 2, 3)${LEGACY_LIST_END}`);
});

test('E-041 with a fingerprint and no legacy waypoint left to list, list-waypoints replies as before', async (t) => {
  const empty = worldSetup({});
  t.is((await empty.getTool('list-waypoints')!.execute({})).content[0].text, 'No waypoints saved');

  // Every legacy name has a waypoint of this world: nothing is listed apart, not even an empty sentence.
  const ownHome = { x: 10, y: 64, z: -4, dimension: 'overworld', createdAt: 0 };
  const shadowed = worldSetup({ home: legacyHome });
  shadowed.store.set('home', ownHome);
  const plain = worldSetup({ home: ownHome }, null);

  const text = (await shadowed.getTool('list-waypoints')!.execute({})).content[0].text;

  t.is(text, '1 waypoint(s):\n\n- home: (10, 64, -4), 1 blocks away\n');
  t.is(text, (await plain.getTool('list-waypoints')!.execute({})).content[0].text, 'the same reply as without a fingerprint');
});

test('E-041 without a fingerprint the host key\'s waypoints are listed and used as before, with nothing apart', async (t) => {
  const { bot, getTool } = worldSetup(undefined, null);
  bot.pathfinder.goto.callsFake(arriveAtGoal(bot));

  const list = (await getTool('list-waypoints')!.execute({})).content[0].text;
  const gone = await getTool('goto-waypoint')!.execute({ name: 'home', range: 0 });

  t.true(list.startsWith('2 waypoint(s):'), list);
  t.true(list.includes('- home: (20, 64, 0)'));
  t.true(list.includes('- mine: (100, 12, 50)'));
  t.false(list.includes('Saved before waypoints were kept per world'));
  t.is(gone.isError, undefined, gone.content[0].text);
  t.true(gone.content[0].text.startsWith("Arrived near waypoint 'home'"));
});

test('E-041 goto-waypoint refuses a legacy waypoint with the migration error and does not move', async (t) => {
  const { bot, getTool } = worldSetup({
    home: legacyHome,
    portal: { x: 0, y: 70, z: 0, dimension: 'the_nether', createdAt: 0 },
    old: { x: 1, y: 2, z: 3, createdAt: 0 }
  });

  const home = await getTool('goto-waypoint')!.execute({ name: ' Home ' });
  const portal = await getTool('goto-waypoint')!.execute({ name: 'portal' });
  const old = await getTool('goto-waypoint')!.execute({ name: 'old' });
  const unknown = await getTool('goto-waypoint')!.execute({ name: 'nope' });

  t.true(home.isError);
  t.is(home.content[0].text, `Failed: ${migrationError('home', '(20, 64, 0) in overworld')}`);
  t.true(portal.isError);
  t.is(portal.content[0].text, `Failed: ${migrationError('portal', '(0, 70, 0) in the_nether')}`, 'not the dimension error: it is not this world\'s yet');
  t.is(old.content[0].text, `Failed: ${migrationError('old', '(1, 2, 3)')}`, 'a legacy waypoint saved without a dimension');
  t.is(unknown.content[0].text, "Failed: No waypoint named 'nope'");
  t.true(bot.pathfinder.goto.notCalled);
  t.true(bot.pathfinder.setGoal.notCalled);
});

test('E-041 return-home and guard (waypoint) refuse a legacy waypoint with the migration error and do not move', async (t) => {
  const { store } = worldSetup();
  const { tasks, pathfinder } = taskWorld(store);

  const home = await tasks.start('return-home', {});
  const named = await tasks.start('return-home', { waypoint: 'MINE' });
  const guard = await tasks.start('guard', { waypoint: 'home' });

  t.deepEqual(home, { ok: false, error: migrationError('home', '(20, 64, 0) in overworld') }, 'go_home starts return-home with these params');
  t.deepEqual(named, { ok: false, error: migrationError('mine', '(100, 12, 50) in overworld') });
  t.deepEqual(guard, { ok: false, error: migrationError('home', '(20, 64, 0) in overworld') });
  t.is(tasks.currentTask(), null);
  t.true(pathfinder.goto.notCalled);
  t.true(pathfinder.setGoal.notCalled);
});

// Serial: the fake clock must not catch the real timers of the cases that run concurrently.
test.serial('E-041 once set-waypoint saves it again, goto-waypoint, return-home and guard use it, and it is no longer listed apart', async (t) => {
  const clock = sinon.useFakeTimers({ now: 1_700_000_000_000 });
  t.teardown(() => clock.restore());
  const { store, bot, getTool } = worldSetup();
  bot.pathfinder.goto.callsFake(arriveAtGoal(bot));
  const { tasks, pathfinder } = taskWorld(store);

  const saved = await getTool('set-waypoint')!.execute({ name: 'home', x: 20, y: 64, z: 0 });
  t.is(saved.content[0].text, "Saved waypoint 'home' at (20, 64, 0)", 'a new waypoint of this world, not an update');

  const gone = await getTool('goto-waypoint')!.execute({ name: 'home', range: 0 });
  t.is(gone.isError, undefined, gone.content[0].text);
  t.true(gone.content[0].text.startsWith("Arrived near waypoint 'home' (20, 64, 0)"));

  const started = await tasks.start('return-home', {});
  t.true(started.ok, started.ok ? undefined : started.error);
  await clock.tickAsync(1000);
  const final = await tasks.waitForEnd(started.ok ? started.task.id : '');
  t.is(final.status, 'done');
  t.true((final.result ?? '').startsWith("Arrived at waypoint 'home'"), final.result);
  t.true(pathfinder.goto.called);

  const guard = await tasks.start('guard', { waypoint: 'home' });
  t.true(guard.ok, guard.ok ? undefined : guard.error);
  await clock.tickAsync(500);
  t.is(tasks.currentTask()?.status, 'running');
  const cancelled = tasks.cancel(undefined, 'test over');
  await clock.tickAsync(2100);
  await cancelled;

  const list = (await getTool('list-waypoints')!.execute({})).content[0].text;
  t.is(legacyLine(list), `${LEGACY_LIST_START}mine (100, 12, 50) in overworld${LEGACY_LIST_END}`);
});

test('E-041 delete-waypoint deletes a legacy waypoint when this world has none of that name, and says it was one', async (t) => {
  const { file, store, getTool } = worldSetup();
  store.set('mine', waypoint);

  const current = await getTool('delete-waypoint')!.execute({ name: 'mine' });
  t.is(current.content[0].text, "Deleted waypoint 'mine'", 'this world\'s waypoint first, with the reply as before');
  t.deepEqual(readFile(file)[HOST], { home: legacyHome, mine: legacyMine }, 'the legacy one of that name stays');

  const legacy = await getTool('delete-waypoint')!.execute({ name: 'Home' });
  t.is(legacy.isError, undefined);
  t.true(legacy.content[0].text.startsWith("Deleted waypoint 'home'"), legacy.content[0].text);
  t.true(legacy.content[0].text.includes('saved before waypoints were kept per world'), 'the reply says it was a legacy waypoint');
  t.deepEqual(readFile(file)[HOST], { mine: legacyMine });

  const again = await getTool('delete-waypoint')!.execute({ name: 'home' });
  t.true(again.isError);
  t.is(again.content[0].text, "Failed: No waypoint named 'home'");
});

test('E-041 the file keeps the legacy key as it was: saving and deleting this world\'s waypoints never touch it', async (t) => {
  const { file, getTool } = worldSetup();
  const before = readFile(file)[HOST];

  await getTool('set-waypoint')!.execute({ name: 'home', x: 20, y: 64, z: 0 });
  await getTool('set-waypoint')!.execute({ name: 'base' });
  await getTool('set-waypoint')!.execute({ name: 'base', x: 1, y: 2, z: 3 });
  await getTool('delete-waypoint')!.execute({ name: 'base' });
  await getTool('list-waypoints')!.execute({});
  await getTool('goto-waypoint')!.execute({ name: 'mine' });

  const data = readFile(file);
  t.deepEqual(data[HOST], before);
  t.deepEqual(Object.keys(data[`${HOST}|seed:${WORLD_A}`]), ['home']);
});
