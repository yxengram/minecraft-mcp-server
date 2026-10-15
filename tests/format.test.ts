import test from 'ava';
import { formatStat } from '../src/format.js';

test('formatStat rounds to one decimal place', (t) => {
  t.is(formatStat(13.333332061767578), '13.3');
  t.is(formatStat(19.96), '20');
  t.is(formatStat(20), '20');
  t.is(formatStat(0.25), '0.3');
});

test('formatStat handles missing values', (t) => {
  t.is(formatStat(undefined), 'unknown');
  t.is(formatStat(Number.NaN), 'unknown');
});
