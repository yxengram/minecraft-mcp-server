import test from 'ava';
import sinon from 'sinon';
import { Vec3 } from 'vec3';
import { registerInteractionTools } from '../src/tools/interaction-tools.js';
import { registerFollowTools } from '../src/tools/follow-tools.js';
import { asBot, createFactory } from './_helpers.js';
import { Autopilot } from '../src/autopilot/autopilot.js';
import { EventStore } from '../src/event-store.js';
import type { ExecutionContext } from 'ava';

const self = { id: 1, position: new Vec3(0, 64, 0) };

function entity(id: number, name: string, type: string, pos: Vec3) {
  return { id, name, type, position: pos, height: 1, isValid: true };
}

// follow-entity and flee-from now run as background tasks; cancel them when the test ends.
function autopilotFor(t: ExecutionContext, bot: Record<string, unknown>) {
  Object.assign(bot.pathfinder as object, { stop: sinon.stub() });
  Object.assign(bot, { clearControlStates: sinon.stub() });
  const autopilot = new Autopilot({ events: new EventStore() });
  autopilot.bind(asBot(bot)());
  t.teardown(() => autopilot.tasks.cancelAll('test finished'));
  return () => autopilot;
}

function baseBot<T extends Record<string, unknown>>(overrides: T) {
  return {
    entity: self,
    entities: {},
    pathfinder: { goto: sinon.stub().resolves(), setGoal: sinon.stub() },
    lookAt: sinon.stub().resolves(),
    ...overrides
  };
}

test('activate-block looks at and activates the block', async (t) => {
  const block = { name: 'lever', position: new Vec3(1, 64, 0) };
  const bot = baseBot({ blockAt: sinon.stub().returns(block), activateBlock: sinon.stub().resolves() });
  const { factory, getTool } = createFactory();
  registerInteractionTools(factory, asBot(bot));

  const result = await getTool('activate-block')!.execute({ x: 1, y: 64, z: 0 });

  t.true(bot.activateBlock.calledOnceWith(block));
  t.true(bot.lookAt.calledOnce);
  t.false(bot.pathfinder.goto.called);
  t.true(result.content[0].text.includes('Activated lever at (1, 64, 0)'));
});

test('activate-block walks closer and rejects air', async (t) => {
  const blockAt = sinon.stub();
  blockAt.onFirstCall().returns({ name: 'oak_door', position: new Vec3(20, 64, 0) });
  blockAt.onSecondCall().returns({ name: 'air' });
  const bot = baseBot({ blockAt, activateBlock: sinon.stub().resolves() });
  const { factory, getTool } = createFactory();
  registerInteractionTools(factory, asBot(bot));

  await getTool('activate-block')!.execute({ x: 20, y: 64, z: 0 });
  t.true(bot.pathfinder.goto.calledOnce);

  const air = await getTool('activate-block')!.execute({ x: 5, y: 64, z: 0 });
  t.true(air.isError);
  t.is(bot.activateBlock.callCount, 1);
});

test('activate-entity activates the nearest matching entity', async (t) => {
  const villager = entity(7, 'villager', 'mob', new Vec3(2, 64, 0));
  const bot = baseBot({ entities: { 7: villager }, activateEntity: sinon.stub().resolves() });
  const { factory, getTool } = createFactory();
  registerInteractionTools(factory, asBot(bot));

  const result = await getTool('activate-entity')!.execute({ type: 'villager' });

  t.true(bot.activateEntity.calledOnceWith(villager));
  t.false(bot.pathfinder.goto.called);
  t.true(result.content[0].text.includes('Interacted with villager (id 7)'));
});

test('activate-entity approaches distant entities and errors when none found', async (t) => {
  const bot = baseBot({ entities: { 7: entity(7, 'villager', 'mob', new Vec3(10, 64, 0)) }, activateEntity: sinon.stub().resolves() });
  const { factory, getTool } = createFactory();
  registerInteractionTools(factory, asBot(bot));

  await getTool('activate-entity')!.execute({ entityId: 7 });
  t.true(bot.pathfinder.goto.calledOnce);

  const none = await getTool('activate-entity')!.execute({ type: 'cow' });
  t.true(none.isError);
  t.true(none.content[0].text.includes('No cow found'));
});

test('sleep finds the nearest bed and sleeps', async (t) => {
  const bed = { name: 'red_bed', position: new Vec3(1, 64, 1) };
  const bot = baseBot({
    isSleeping: false,
    isABed: sinon.stub().returns(true),
    findBlock: sinon.stub().returns(bed),
    sleep: sinon.stub().resolves()
  });
  const { factory, getTool } = createFactory();
  registerInteractionTools(factory, asBot(bot));

  const result = await getTool('sleep')!.execute({});

  t.true(bot.sleep.calledOnceWith(bed));
  t.true(result.content[0].text.includes('Sleeping in red_bed'));
});

test('sleep reports missing bed, invalid bed position and already sleeping', async (t) => {
  const bot = baseBot({
    isSleeping: false,
    isABed: sinon.stub().returns(false),
    findBlock: sinon.stub().returns(null),
    blockAt: sinon.stub().returns({ name: 'stone', position: new Vec3(1, 64, 1) }),
    sleep: sinon.stub().resolves()
  });
  const { factory, getTool } = createFactory();
  registerInteractionTools(factory, asBot(bot));

  const none = await getTool('sleep')!.execute({});
  t.true(none.isError);
  t.true(none.content[0].text.includes('No bed found'));

  const invalid = await getTool('sleep')!.execute({ x: 1, y: 64, z: 1 });
  t.true(invalid.isError);

  bot.isSleeping = true;
  const already = await getTool('sleep')!.execute({});
  t.true(already.content[0].text.includes('Already sleeping'));
  t.false(bot.sleep.called);
});

test('wake wakes only when sleeping', async (t) => {
  const bot = baseBot({ isSleeping: false, wake: sinon.stub().resolves() });
  const { factory, getTool } = createFactory();
  registerInteractionTools(factory, asBot(bot));

  const idle = await getTool('wake')!.execute({});
  t.true(idle.content[0].text.includes('Not sleeping'));
  t.false(bot.wake.called);

  bot.isSleeping = true;
  await getTool('wake')!.execute({});
  t.true(bot.wake.calledOnce);
});

test('mount-entity mounts the nearest matching entity', async (t) => {
  const horse = entity(9, 'horse', 'animal', new Vec3(1, 64, 0));
  const bot = baseBot({ entities: { 9: horse }, mount: sinon.stub() });
  const { factory, getTool } = createFactory();
  registerInteractionTools(factory, asBot(bot));

  const mounted = await getTool('mount-entity')!.execute({ type: 'horse' });

  t.true(bot.mount.calledOnceWith(horse));
  t.true(mounted.content[0].text.includes('Mounting horse'));
});

test('dismount does nothing when not riding', async (t) => {
  const bot = baseBot({ dismount: sinon.stub(), setControlState: sinon.stub(), vehicle: null as unknown });
  const { factory, getTool } = createFactory();
  registerInteractionTools(factory, asBot(bot));

  const result = await getTool('dismount')!.execute({});

  t.true(result.content[0].text.includes('Not riding'));
  t.false(bot.dismount.called);
});

test('dismount succeeds without sneaking when dismount() works', async (t) => {
  const bot = baseBot({ vehicle: { id: 9 } as unknown, dismount: sinon.stub(), setControlState: sinon.stub() });
  bot.dismount.callsFake(() => { bot.vehicle = null; });
  const { factory, getTool } = createFactory();
  registerInteractionTools(factory, asBot(bot));

  const result = await getTool('dismount')!.execute({});

  t.is(result.content[0].text, 'Dismounted');
  t.false(bot.setControlState.called);
});

test('dismount falls back to sneaking when the server ignores dismount()', async (t) => {
  const bot = baseBot({ vehicle: { id: 9 } as unknown, dismount: sinon.stub(), setControlState: sinon.stub() });
  bot.setControlState.callsFake((control: string, state: boolean) => { if (control === 'sneak' && !state) bot.vehicle = null; });
  const { factory, getTool } = createFactory();
  registerInteractionTools(factory, asBot(bot));

  const result = await getTool('dismount')!.execute({});

  t.is(result.content[0].text, 'Dismounted');
  t.deepEqual(bot.setControlState.getCalls().map(c => c.args), [['sneak', true], ['sneak', false]]);
});

test('dismount reports an error when the bot stays on the vehicle', async (t) => {
  const bot = baseBot({ vehicle: { id: 9 } as unknown, dismount: sinon.stub(), setControlState: sinon.stub() });
  const { factory, getTool } = createFactory();
  registerInteractionTools(factory, asBot(bot));

  const result = await getTool('dismount')!.execute({});

  t.true(result.isError);
  t.true(result.content[0].text.includes('Still riding'));
});

test('follow-entity sets a dynamic follow goal', async (t) => {
  const steve = { ...entity(5, 'player', 'player', new Vec3(5, 64, 0)), username: 'Steve' };
  const bot = baseBot({ entities: { 5: steve } });
  const { factory, getTool } = createFactory();
  registerFollowTools(factory, asBot(bot), autopilotFor(t, bot));

  const result = await getTool('follow-entity')!.execute({ type: 'Steve', range: 4 });

  t.true(bot.pathfinder.setGoal.calledOnce);
  const [goal, dynamic] = bot.pathfinder.setGoal.firstCall.args;
  t.is(goal.entity, steve);
  t.is(goal.rangeSq, 16);
  t.true(dynamic);
  t.true(result.content[0].text.includes('Following Steve'));
});

test('flee-from sets an inverted dynamic goal', async (t) => {
  const zombie = entity(2, 'zombie', 'hostile', new Vec3(3, 64, 0));
  const bot = baseBot({ entities: { 2: zombie } });
  const { factory, getTool } = createFactory();
  registerFollowTools(factory, asBot(bot), autopilotFor(t, bot));

  const result = await getTool('flee-from')!.execute({ entityId: 2, distance: 20 });

  const [goal, dynamic] = bot.pathfinder.setGoal.firstCall.args;
  t.is(goal.goal.entity, zombie);
  t.true(dynamic);
  t.true(result.content[0].text.includes('Fleeing from zombie'));
});

test('follow-entity and flee-from error when target is missing', async (t) => {
  const bot = baseBot({});
  const { factory, getTool } = createFactory();
  registerFollowTools(factory, asBot(bot), autopilotFor(t, bot));

  const follow = await getTool('follow-entity')!.execute({ type: 'Steve' });
  const flee = await getTool('flee-from')!.execute({});

  t.true(follow.isError);
  t.true(flee.isError);
  t.false(bot.pathfinder.setGoal.called);
});
