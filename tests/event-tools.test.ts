import test from 'ava';
import { registerEventTools } from '../src/tools/event-tools.js';
import { EventStore } from '../src/event-store.js';
import { createFactory } from './_helpers.js';

test('registerEventTools registers get-events tool', (t) => {
  const { factory, getTool } = createFactory();
  registerEventTools(factory, new EventStore());

  t.truthy(getTool('get-events'));
});

test('get-events reports no events when empty', async (t) => {
  const { factory, getTool } = createFactory();
  registerEventTools(factory, new EventStore());

  const result = await getTool('get-events')!.execute({});

  t.true(result.content[0].text.includes('No new events'));
  t.true(result.content[0].text.includes('nextSince: 0'));
});

test('get-events lists events and returns nextSince', async (t) => {
  const { factory, getTool } = createFactory();
  const store = new EventStore();
  store.addEvent('death', 'Bot died');
  store.addEvent('chat', 'Steve: hello');
  registerEventTools(factory, store);

  const result = await getTool('get-events')!.execute({});
  const text = result.content[0].text;

  t.true(text.includes('2 event(s)'));
  t.true(text.includes('[death] Bot died'));
  t.true(text.includes('[chat] Steve: hello'));
  t.true(text.includes('nextSince: 2'));
});

test('get-events honors since and types', async (t) => {
  const { factory, getTool } = createFactory();
  const store = new EventStore();
  store.addEvent('chat', 'old');
  store.addEvent('death', 'Bot died');
  store.addEvent('chat', 'new');
  registerEventTools(factory, store);

  const result = await getTool('get-events')!.execute({ since: 1, types: ['chat'] });
  const text = result.content[0].text;

  t.true(text.includes('new'));
  t.false(text.includes('old'));
  t.false(text.includes('Bot died'));
});
