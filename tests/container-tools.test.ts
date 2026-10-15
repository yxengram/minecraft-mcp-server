import test from 'ava';
import sinon from 'sinon';
import { Vec3 } from 'vec3';
import { registerContainerTools } from '../src/tools/container-tools.js';
import { asBot, createFactory } from './_helpers.js';

function setup(blockName = 'chest', contents: { name: string; count: number; type: number }[] = [], inventory: { name: string; count: number; type: number }[] = []) {
  const container = {
    containerItems: () => contents,
    deposit: sinon.stub().resolves(),
    withdraw: sinon.stub().resolves(),
    close: sinon.stub()
  };
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    blockAt: sinon.stub().returns({ name: blockName, position: new Vec3(1, 64, 0) }),
    pathfinder: { goto: sinon.stub().resolves() },
    openContainer: sinon.stub().resolves(container),
    inventory: { items: () => inventory }
  };
  const { factory, getTool } = createFactory();
  registerContainerTools(factory, asBot(bot));
  return { bot, container, getTool };
}

test('read-container lists aggregated contents and closes the container', async (t) => {
  const { container, getTool } = setup('chest', [
    { name: 'cobblestone', count: 64, type: 1 },
    { name: 'cobblestone', count: 10, type: 1 },
    { name: 'bread', count: 3, type: 2 }
  ]);

  const result = await getTool('read-container')!.execute({ x: 1, y: 64, z: 0 });

  t.true(result.content[0].text.includes('cobblestone x74, bread x3'));
  t.true(container.close.calledOnce);
});

test('read-container reports an empty container', async (t) => {
  const { getTool } = setup('barrel');

  const result = await getTool('read-container')!.execute({ x: 1, y: 64, z: 0 });

  t.true(result.content[0].text.includes('barrel at (1, 64, 0) is empty'));
});

test('read-container rejects non-container blocks without opening', async (t) => {
  const { bot, getTool } = setup('stone');

  const result = await getTool('read-container')!.execute({ x: 1, y: 64, z: 0 });

  t.true(result.isError);
  t.true(result.content[0].text.includes('No container'));
  t.false(bot.openContainer.called);
});

test('read-container walks closer when far away', async (t) => {
  const { bot, getTool } = setup();
  bot.entity.position = new Vec3(30, 64, 0);

  await getTool('read-container')!.execute({ x: 1, y: 64, z: 0 });

  t.true(bot.pathfinder.goto.calledOnce);
});

test('container-deposit deposits the requested count', async (t) => {
  const { container, getTool } = setup('chest', [], [{ name: 'cobblestone', count: 40, type: 7 }]);

  const result = await getTool('container-deposit')!.execute({ x: 1, y: 64, z: 0, itemName: 'cobblestone', count: 10 });

  t.true(container.deposit.calledOnceWith(7, null, 10));
  t.true(container.close.calledOnce);
  t.true(result.content[0].text.includes('Deposited 10 cobblestone into chest'));
});

test('container-deposit with all deposits everything and rejects too many', async (t) => {
  const { container, getTool } = setup('chest', [], [{ name: 'dirt', count: 5, type: 3 }, { name: 'dirt', count: 7, type: 3 }]);

  await getTool('container-deposit')!.execute({ x: 1, y: 64, z: 0, itemName: 'dirt', all: true });
  t.true(container.deposit.calledOnceWith(3, null, 12));

  const tooMany = await getTool('container-deposit')!.execute({ x: 1, y: 64, z: 0, itemName: 'dirt', count: 13 });
  t.true(tooMany.isError);
  t.is(container.deposit.callCount, 1);
});

test('container-deposit errors when item is not in inventory', async (t) => {
  const { bot, getTool } = setup();

  const result = await getTool('container-deposit')!.execute({ x: 1, y: 64, z: 0, itemName: 'diamond' });

  t.true(result.isError);
  t.false(bot.openContainer.called);
});

test('container-withdraw takes items out of the container', async (t) => {
  const { container, getTool } = setup('chest', [{ name: 'iron_ingot', count: 20, type: 9 }]);

  const result = await getTool('container-withdraw')!.execute({ x: 1, y: 64, z: 0, itemName: 'iron_ingot', count: 5 });

  t.true(container.withdraw.calledOnceWith(9, null, 5));
  t.true(container.close.calledOnce);
  t.true(result.content[0].text.includes('Withdrew 5 iron_ingot from chest'));
});

test('container-withdraw errors on missing item or too many and still closes', async (t) => {
  const { container, getTool } = setup('chest', [{ name: 'iron_ingot', count: 2, type: 9 }]);

  const missing = await getTool('container-withdraw')!.execute({ x: 1, y: 64, z: 0, itemName: 'gold_ingot' });
  const tooMany = await getTool('container-withdraw')!.execute({ x: 1, y: 64, z: 0, itemName: 'iron_ingot', count: 3 });

  t.true(missing.isError);
  t.true(missing.content[0].text.includes('in container'));
  t.true(tooMany.isError);
  t.false(container.withdraw.called);
  t.is(container.close.callCount, 2);
});

test('container-withdraw closes the container when withdrawing fails', async (t) => {
  const { container, getTool } = setup('chest', [{ name: 'iron_ingot', count: 2, type: 9 }]);
  container.withdraw.rejects(new Error('inventory full'));

  const result = await getTool('container-withdraw')!.execute({ x: 1, y: 64, z: 0, itemName: 'iron_ingot' });

  t.true(result.isError);
  t.true(result.content[0].text.includes('inventory full'));
  t.true(container.close.calledOnce);
});
