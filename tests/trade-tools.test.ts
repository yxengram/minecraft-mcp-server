// Contract: docs/BLUEPRINT.md F-043 / F-044. Expected texts come from the contract, not from the implementation.
import test from 'ava';
import sinon from 'sinon';
import { Vec3 } from 'vec3';
import { createFactory, asBot } from './_helpers.js';
import { registerTradeTools, OPEN_TIMEOUT_MS } from '../src/tools/trade-tools.js';

type Stack = { name: string; count: number };
type FakeTrade = {
  inputItem1: Stack; inputItem2?: Stack; hasItem2: boolean; outputItem: Stack;
  tradeDisabled: boolean; nbTradeUses: number; maximumNbTradeUses: number; realPrice: number;
};

function offer(input: Stack, output: Stack, { input2, used = 0, max = 12, price }: { input2?: Stack; used?: number; max?: number; price?: number } = {}): FakeTrade {
  return {
    inputItem1: input, inputItem2: input2, hasItem2: Boolean(input2), outputItem: output,
    tradeDisabled: false, nbTradeUses: used, maximumNbTradeUses: max, realPrice: price ?? input.count
  };
}

const VILLAGER_KEYS = ['shared_flags', 'air_supply', 'baby', 'villager_data'];

function villagerEntity(id: number, { position = new Vec3(2, 64, 0), profession = 5 }: { position?: Vec3; profession?: number } = {}) {
  const metadata: unknown[] = [];
  metadata[3] = { villagerType: 0, villagerProfession: profession, level: 1 };
  return { id, name: 'villager', type: 'mob', position, metadata };
}

/** A bot next to one villager whose trade window holds `trades` and an inventory of `items`. */
function setup({ trades = [] as FakeTrade[], items = [] as Stack[], entities = {} as Record<number, unknown>, opens = true } = {}) {
  const inventory = items.map(item => ({ ...item }));
  const window = {
    trades,
    items: () => inventory.filter(item => item.count > 0),
    close: sinon.stub()
  };
  const villager = villagerEntity(7);
  const self = { id: 1, position: new Vec3(0, 64, 0) };
  const bot = {
    entity: self,
    entities: { 1: self, 7: villager, ...entities },
    registry: { entitiesByName: { villager: { metadataKeys: VILLAGER_KEYS }, pig: { metadataKeys: VILLAGER_KEYS.slice(0, 3) } } },
    pathfinder: { goto: sinon.stub().resolves() },
    openVillager: sinon.stub().callsFake(() => (opens ? Promise.resolve(window) : new Promise(() => {}))),
    trade: sinon.stub().resolves(),
    closeWindow: sinon.stub()
  };
  const { factory, getTool } = createFactory();
  registerTradeTools(factory, asBot(bot));
  const run = (name: string, args: Record<string, unknown> = {}) => getTool(name)!.execute(args);
  /** Makes bot.trade move items like the server would: take the price, give the output, `times` times. */
  const exchange = (doneBeforeFailure?: number, error?: Error) => bot.trade.callsFake(async (_w: unknown, index: number, times: number) => {
    const trade = trades[index];
    for (let i = 0; i < (doneBeforeFailure ?? times); i++) {
      inventory.find(item => item.name === trade.inputItem1.name)!.count -= trade.realPrice;
      if (trade.inputItem2) inventory.find(item => item.name === trade.inputItem2!.name)!.count -= trade.inputItem2.count;
      const out = inventory.find(item => item.name === trade.outputItem.name);
      if (out) out.count += trade.outputItem.count; else inventory.push({ ...trade.outputItem });
    }
    if (error) throw error;
  });
  return { bot, window, run, exchange, inventory };
}

const text = (result: { content: { text: string }[] }) => result.content[0].text;

test('list-trades lists each trade with its price, stock and how many times the bot can afford it', async (t) => {
  const { run, window } = setup({
    trades: [
      offer({ name: 'emerald', count: 1 }, { name: 'bread', count: 6 }, { used: 2, max: 12 }),
      offer({ name: 'emerald', count: 5 }, { name: 'enchanted_book', count: 1 }, { input2: { name: 'book', count: 1 } }),
      offer({ name: 'wheat', count: 20 }, { name: 'emerald', count: 1 }, { used: 16, max: 16 })
    ],
    items: [{ name: 'emerald', count: 11 }, { name: 'book', count: 1 }, { name: 'wheat', count: 64 }]
  });
  const result = await run('list-trades');
  t.falsy(result.isError);
  t.is(text(result), [
    'villager (farmer) (id 7) offers 3 trade(s):',
    '1. 1 emerald -> 6 bread; used 2 of 12; you can afford 10 time(s)',
    '2. 5 emerald + 1 book -> 1 enchanted_book; used 0 of 12; you can afford 1 time(s)',
    '3. 20 wheat -> 1 emerald; used 16 of 16; out of stock; you can afford 0 time(s)'
  ].join('\n'));
  t.true(window.close.calledOnce, 'the trade window is closed');
});

test('list-trades uses the real price (demand and reputation), not the base price', async (t) => {
  const { run } = setup({
    trades: [offer({ name: 'emerald', count: 3 }, { name: 'bread', count: 6 }, { price: 5 })],
    items: [{ name: 'emerald', count: 11 }]
  });
  t.is(text(await run('list-trades')).split('\n')[1], '1. 5 emerald -> 6 bread; used 0 of 12; you can afford 2 time(s)');
});

test('list-trades says when a villager has no trades', async (t) => {
  const { run } = setup();
  t.is(text(await run('list-trades')), 'villager (farmer) (id 7) offers no trades (unemployed villagers and nitwits do not trade)');
});

test('trading with something that is not a villager is refused before anything opens', async (t) => {
  const pig = { id: 9, name: 'pig', type: 'animal', position: new Vec3(1, 64, 0), metadata: [] };
  const { run, bot } = setup({ entities: { 9: pig } });
  for (const tool of ['list-trades', 'trade']) {
    const result = await run(tool, { entityId: 9, index: 1 });
    t.true(result.isError);
    t.regex(text(result), /pig \(id 9\) is not a villager: only villagers can be traded with \(wandering traders are not supported\)/);
  }
  t.true(bot.openVillager.notCalled);
});

test('without entityId or type the nearest villager is used', async (t) => {
  const { run, bot } = setup({ trades: [offer({ name: 'emerald', count: 1 }, { name: 'bread', count: 6 })] });
  await run('list-trades');
  t.is(bot.openVillager.firstCall.args[0].id, 7);
});

test.serial('a villager that does not open a trade window within 5 s gives a clear error', async (t) => {
  const clock = sinon.useFakeTimers();
  try {
    const { run } = setup({ opens: false });
    const pending = run('list-trades');
    await clock.tickAsync(OPEN_TIMEOUT_MS + 10);
    const result = await pending;
    t.true(result.isError);
    t.regex(text(result), /villager \(farmer\) \(id 7\) did not open a trade window within 5s \(baby villagers cannot trade\)/);
  } finally {
    clock.restore();
  }
});

test('trade refuses a number that is not in the list', async (t) => {
  const { run, bot, window } = setup({ trades: [offer({ name: 'emerald', count: 1 }, { name: 'bread', count: 6 })], items: [{ name: 'emerald', count: 5 }] });
  const result = await run('trade', { index: 2 });
  t.true(result.isError);
  t.regex(text(result), /There is no trade 2: villager \(farmer\) offers 1 trade\(s\); use list-trades/);
  t.true(bot.trade.notCalled);
  t.true(window.close.calledOnce);
});

test('trade refuses a trade that is out of stock or has too few uses left', async (t) => {
  const trades = [
    offer({ name: 'emerald', count: 1 }, { name: 'bread', count: 6 }, { used: 12, max: 12 }),
    offer({ name: 'emerald', count: 1 }, { name: 'cookie', count: 8 }, { used: 10, max: 12 })
  ];
  const { run, bot } = setup({ trades, items: [{ name: 'emerald', count: 20 }] });
  t.regex(text(await run('trade', { index: 1 })), /Trade 1 is out of stock \(used 12 of 12\)/);
  t.regex(text(await run('trade', { index: 2, times: 3 })), /Trade 2 has only 2 use\(s\) left \(used 10 of 12\)/);
  t.true(bot.trade.notCalled);
});

test('trade says what is missing without calling the trade when the bot cannot pay', async (t) => {
  const { run, bot } = setup({
    trades: [offer({ name: 'emerald', count: 5 }, { name: 'enchanted_book', count: 1 }, { input2: { name: 'book', count: 1 } })],
    items: [{ name: 'emerald', count: 7 }]
  });
  const result = await run('trade', { index: 1, times: 2 });
  t.true(result.isError);
  t.regex(text(result), /Not enough for 2 trade\(s\): needs 10 emerald and 2 book, you have 7 and 0/);
  t.true(bot.trade.notCalled);
});

test('trade reports what was given and received, counted from the inventory', async (t) => {
  const { run, bot, window, exchange } = setup({
    trades: [offer({ name: 'emerald', count: 1 }, { name: 'bread', count: 6 })],
    items: [{ name: 'emerald', count: 5 }]
  });
  exchange();
  const result = await run('trade', { index: 1, times: 2 });
  t.falsy(result.isError);
  t.is(text(result), 'Traded 2 time(s) with villager (farmer) (id 7): gave 2 emerald, got 12 bread');
  t.deepEqual(bot.trade.firstCall.args.slice(1), [0, 2], 'list number 1 is mineflayer index 0');
  t.true(window.close.calledOnce);
});

test('a trade that fails part way reports how many trades went through', async (t) => {
  const { run, window, exchange } = setup({
    trades: [offer({ name: 'emerald', count: 1 }, { name: 'bread', count: 6 })],
    items: [{ name: 'emerald', count: 5 }]
  });
  exchange(1, new Error('window closed'));
  const result = await run('trade', { index: 1, times: 3 });
  t.true(result.isError);
  t.regex(text(result), /Trade failed after 1 of 3 trade\(s\): window closed/);
  t.true(window.close.calledOnce);
});

test.serial('a trade that never finishes times out and the window is closed', async (t) => {
  const clock = sinon.useFakeTimers();
  try {
    const { run, bot, window } = setup({
      trades: [offer({ name: 'emerald', count: 1 }, { name: 'bread', count: 6 })],
      items: [{ name: 'emerald', count: 5 }]
    });
    bot.trade.returns(new Promise(() => {}));
    const pending = run('trade', { index: 1 });
    await clock.tickAsync(13000);
    const result = await pending;
    t.true(result.isError);
    t.regex(text(result), /Trade failed after 0 of 1 trade\(s\): timed out/);
    t.true(window.close.calledOnce);
  } finally {
    clock.restore();
  }
});

test('a villager without a known profession is described as just villager', async (t) => {
  const { run, bot } = setup();
  (bot.entities[7] as { metadata: unknown[] }).metadata = [];
  t.is(text(await run('list-trades')), 'villager (id 7) offers no trades (unemployed villagers and nitwits do not trade)');
});
