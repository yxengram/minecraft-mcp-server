import test from 'ava';
import { EventStore } from '../src/event-store.js';

test('adds events with increasing ids', (t) => {
  const store = new EventStore();
  const first = store.addEvent('chat', 'a: hi');
  const second = store.addEvent('death', 'Bot died');

  t.is(first.id, 1);
  t.is(second.id, 2);
  t.is(store.getLastId(), 2);
});

test('query without since returns latest events', (t) => {
  const store = new EventStore();
  for (let i = 0; i < 10; i++) store.addEvent('chat', `m${i}`);

  const result = store.query({ limit: 3 });

  t.deepEqual(result.events.map(e => e.message), ['m7', 'm8', 'm9']);
  t.is(result.nextSince, 10);
  t.false(result.dropped);
});

test('query with since returns only newer events', (t) => {
  const store = new EventStore();
  for (let i = 0; i < 5; i++) store.addEvent('chat', `m${i}`);

  const result = store.query({ since: 3 });

  t.deepEqual(result.events.map(e => e.id), [4, 5]);
  t.is(result.nextSince, 5);
});

test('query filters by type and still advances the cursor', (t) => {
  const store = new EventStore();
  store.addEvent('chat', 'hello');
  store.addEvent('death', 'died');
  store.addEvent('chat', 'again');

  const deaths = store.query({ since: 0, types: ['death'] });
  t.deepEqual(deaths.events.map(e => e.type), ['death']);
  t.is(deaths.nextSince, 3);

  const none = store.query({ since: 1, types: ['kicked'] });
  t.is(none.events.length, 0);
  t.is(none.nextSince, 3);
});

test('query truncated by limit returns cursor of last returned event', (t) => {
  const store = new EventStore();
  for (let i = 0; i < 6; i++) store.addEvent('chat', `m${i}`);

  const result = store.query({ since: 1, limit: 2 });

  t.deepEqual(result.events.map(e => e.id), [2, 3]);
  t.is(result.nextSince, 3);
});

test('keeps at most the max number of events and reports dropped', (t) => {
  const store = new EventStore();
  const max = store.getMaxEvents();
  for (let i = 0; i < max + 50; i++) store.addEvent('chat', `m${i}`);

  const result = store.query({ since: 1, limit: 100 });

  t.true(result.dropped);
  t.is(result.events[0].id, 51);
  t.is(store.query({ since: 0, limit: 1000 }).events.length, max);
});
