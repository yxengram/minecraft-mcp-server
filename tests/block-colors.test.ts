import test from 'ava';
import { blockColor, shade, toHex } from '../src/tools/block-colors.js';

test('blockColor uses exact colors for common blocks', (t) => {
  t.deepEqual(blockColor('water'), [63, 118, 228]);
  t.deepEqual(blockColor('grass_block'), [127, 178, 56]);
});

test('blockColor applies naming rules', (t) => {
  t.deepEqual(blockColor('deepslate_diamond_ore'), [93, 236, 245]);
  t.deepEqual(blockColor('oak_leaves'), [58, 125, 34]);
  t.deepEqual(blockColor('cherry_leaves'), [240, 168, 200]);
  t.deepEqual(blockColor('spruce_log'), [107, 82, 51]);
  t.deepEqual(blockColor('light_blue_wool'), [58, 175, 217]);
  t.deepEqual(blockColor('blue_concrete'), [53, 57, 157]);
});

test('blockColor falls back to a stable color for unknown blocks', (t) => {
  const first = blockColor('some_future_block');
  t.deepEqual(blockColor('some_future_block'), first);
  t.notDeepEqual(blockColor('another_future_block'), first);
  first.forEach(channel => t.true(channel >= 0 && channel <= 255));
});

test('shade clamps and toHex formats', (t) => {
  t.deepEqual(shade([200, 100, 0], 2), [255, 200, 0]);
  t.deepEqual(shade([200, 100, 50], 0.5), [100, 50, 25]);
  t.is(toHex([255, 8, 171]), '#FF08AB');
});
