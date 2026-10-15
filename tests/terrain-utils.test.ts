import test from 'ava';
import { Vec3 } from 'vec3';
import {
  columnAt, compassDirection, describeOffset, isUnderRoof, resolveView, scanSurface
} from '../src/tools/terrain-utils.js';
import { createVisionBot } from './_world.js';
import type mineflayer from 'mineflayer';

const asBot = (bot: unknown) => bot as mineflayer.Bot;

test('compassDirection maps offsets to 8 directions with north as -Z', (t) => {
  t.is(compassDirection(0, -5), 'north');
  t.is(compassDirection(5, -5), 'northeast');
  t.is(compassDirection(5, 0), 'east');
  t.is(compassDirection(3, 3), 'southeast');
  t.is(compassDirection(0, 5), 'south');
  t.is(compassDirection(-4, 4), 'southwest');
  t.is(compassDirection(-5, 0), 'west');
  t.is(compassDirection(-5, -5), 'northwest');
  t.is(compassDirection(0, 0), 'here');
});

test('describeOffset handles singular, plural and vertical offsets', (t) => {
  t.is(describeOffset(1, 0), '1 block east');
  t.is(describeOffset(0, -7), '7 blocks north');
  t.is(describeOffset(0, 0, -3), '3 blocks below');
  t.is(describeOffset(0, 0, 1), '1 block above');
  t.is(describeOffset(0, 0), 'right here');
});

test('scanSurface finds the top solid block, skipping plants but not water', (t) => {
  const bot = createVisionBot({
    blockAt: (x, y, z) => {
      if (x > 3) return null;
      if (x === -3 && z === -3) return y <= 20 ? 'stone' : 'air';
      if (x === 2 && z === 0) return y <= 62 ? 'sand' : y <= 63 ? 'water' : 'air';
      if (y === 64 && x === 1) return 'short_grass';
      return y <= 63 ? (y === 63 ? 'grass_block' : 'dirt') : 'air';
    }
  });

  const grid = scanSurface(asBot(bot), 4, 'surface');

  t.is(grid.view, 'surface');
  t.is(grid.startY, 96);
  t.deepEqual(columnAt(grid, 0, 0), { state: 'surface', y: 63, name: 'grass_block' });
  t.deepEqual(columnAt(grid, 1, 0), { state: 'surface', y: 63, name: 'grass_block' });
  t.deepEqual(columnAt(grid, 2, 0), { state: 'surface', y: 63, name: 'water' });
  t.deepEqual(columnAt(grid, 4, 0), { state: 'unloaded' });
  t.deepEqual(columnAt(grid, -3, -3), { state: 'none' });
  t.is(columnAt(grid, 5, 0), undefined);
});

test('auto view switches to current-level under a solid roof but not under leaves', (t) => {
  const roofed = createVisionBot({ blockAt: (_x, y) => (y <= 63 || y === 68 ? 'stone' : 'air') });
  const leafy = createVisionBot({ blockAt: (_x, y) => (y <= 63 ? 'stone' : y === 68 ? 'oak_leaves' : 'air') });

  t.true(isUnderRoof(asBot(roofed)));
  t.is(resolveView(asBot(roofed), 'auto'), 'current-level');
  t.is(scanSurface(asBot(roofed), 2).startY, 65);
  t.false(isUnderRoof(asBot(leafy)));
  t.is(resolveView(asBot(leafy), 'auto'), 'surface');
  t.is(resolveView(asBot(roofed), 'surface'), 'surface');
});

test('scanSurface uses the bot position as the grid center', (t) => {
  const bot = createVisionBot({ blockAt: (_x, y) => (y <= 10 ? 'stone' : 'air'), position: new Vec3(100.7, 11, -20.2) });

  const grid = scanSurface(asBot(bot), 1, 'surface');

  t.is(grid.centerX, 100);
  t.is(grid.centerZ, -21);
  t.is(grid.feetY, 11);
});
