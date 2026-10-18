import test from 'ava';
import sinon from 'sinon';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Vec3 } from 'vec3';
import { WaypointStore } from '../src/waypoint-store.js';
import { registerWaypointTools } from '../src/tools/waypoint-tools.js';
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
