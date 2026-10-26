// M19 safety changes (BLUEPRINT F-048). Each case names the clause of its E row; the expected values come from the
// contract and invariant I1, not from what the code happens to print.
import test from 'ava';
import sinon from 'sinon';
import { Vec3 } from 'vec3';
import { registerEntityTools } from '../src/tools/entity-tools.js';
import { PolicyStore } from '../src/autopilot/policy.js';
import type { Autopilot } from '../src/autopilot/autopilot.js';
import { asBot, createFactory } from './_helpers.js';

// ---------------------------------------------------------------------------------------------------------------
// E-022 (first part): attack-entity never hits a player unless the policy turned combat.attackPlayers on.
// Tamed animals, the sword sweep and the type-selection rules wait for Q21 and are not tested here yet.
// ---------------------------------------------------------------------------------------------------------------

const self = { id: 1, position: new Vec3(0, 64, 0) };
const PLAYER_REASON = 'MCPHelper is a player; players are never attacked';
const REFUSED = `${PLAYER_REASON}; attack-entity did not attack`;

function player(id = 5, pos = new Vec3(2, 64, 0)) {
  return { id, name: 'player', type: 'player', username: 'MCPHelper', position: pos, height: 1.8, isValid: true };
}

function zombie(id = 2, pos = new Vec3(2, 64, 0)) {
  return { id, name: 'zombie', type: 'hostile', position: pos, height: 1.95, isValid: true };
}

/** The tool reads the rules through getAutopilot().policy, so a real PolicyStore stands in for the Autopilot. */
function autopilotWith(policy = new PolicyStore()) {
  return { policy, getAutopilot: () => ({ policy }) as unknown as Autopilot };
}

function allowPlayers(policy: PolicyStore, on: boolean) {
  const result = policy.update({ combat: { attackPlayers: on } }, 'llm');
  if (!result.ok) throw new Error(result.errors.join('; '));
}

function fakeBot(entities: Record<number, unknown>) {
  return { entity: self, entities, lookAt: sinon.stub().resolves(), attack: sinon.stub() };
}

test('E-022: without the Autopilot the default rules apply and a player is never attacked', async (t) => {
  const { factory, getTool } = createFactory();
  const target = player();
  const bot = fakeBot({ 5: target });
  registerEntityTools(factory, asBot(bot));

  const result = await getTool('attack-entity')!.execute({ entityId: 5 });

  t.true(result.isError);
  t.true(result.content[0].text.includes(REFUSED));
  t.false(bot.attack.called);
});

test('E-022: with attackPlayers off (the default policy) a player by id is refused and never hit', async (t) => {
  const { factory, getTool } = createFactory();
  const bot = fakeBot({ 5: player() });
  const { getAutopilot } = autopilotWith();
  registerEntityTools(factory, asBot(bot), getAutopilot);

  const result = await getTool('attack-entity')!.execute({ entityId: 5, times: 3 });

  t.true(result.isError);
  t.true(result.content[0].text.includes(REFUSED));
  t.is(bot.attack.callCount, 0);
});

test('E-022: a player chosen by type is refused the same way', async (t) => {
  const { factory, getTool } = createFactory();
  const bot = fakeBot({ 5: player() });
  const { getAutopilot } = autopilotWith();
  registerEntityTools(factory, asBot(bot), getAutopilot);

  const result = await getTool('attack-entity')!.execute({ type: 'player' });

  t.true(result.isError);
  t.true(result.content[0].text.includes(REFUSED));
  t.false(bot.attack.called);
});

test('E-022: with attackPlayers on a player can be attacked and the reply is unchanged', async (t) => {
  const { factory, getTool } = createFactory();
  const target = player();
  const bot = fakeBot({ 5: target });
  const { policy, getAutopilot } = autopilotWith();
  allowPlayers(policy, true);
  registerEntityTools(factory, asBot(bot), getAutopilot);

  const result = await getTool('attack-entity')!.execute({ entityId: 5 });

  t.falsy(result.isError);
  t.true(bot.attack.calledOnceWith(target));
  t.is(result.content[0].text, 'Attacked MCPHelper (id 5) 1 time(s); target is still alive');
});

test('E-022: a policy change between hits stops the sequence before the next hit and says why', async (t) => {
  const { factory, getTool } = createFactory();
  const target = player();
  const bot = fakeBot({ 5: target });
  const { policy, getAutopilot } = autopilotWith();
  allowPlayers(policy, true);
  // set-policy turns attackPlayers off right after the second hit.
  bot.attack.callsFake(() => { if (bot.attack.callCount === 2) allowPlayers(policy, false); });
  registerEntityTools(factory, asBot(bot), getAutopilot);

  const result = await getTool('attack-entity')!.execute({ entityId: 5, times: 5 });

  t.falsy(result.isError);
  t.is(bot.attack.callCount, 2);
  t.is(result.content[0].text, `Attacked MCPHelper (id 5) 2 time(s); stopped: ${PLAYER_REASON}; target is still alive`);
});

test('E-022: the rules are read again after the look, so a change before the first hit means no hit at all', async (t) => {
  const { factory, getTool } = createFactory();
  const bot = fakeBot({ 5: player() });
  const { policy, getAutopilot } = autopilotWith();
  allowPlayers(policy, true);
  bot.lookAt.callsFake(async () => { allowPlayers(policy, false); });
  registerEntityTools(factory, asBot(bot), getAutopilot);

  const result = await getTool('attack-entity')!.execute({ entityId: 5, times: 3 });

  t.true(result.isError);
  t.true(result.content[0].text.includes(REFUSED));
  t.false(bot.attack.called);
});

test('E-022: a player killed during the sequence still ends with "target is gone"', async (t) => {
  const { factory, getTool } = createFactory();
  const target = player();
  const bot = fakeBot({ 5: target });
  const { policy, getAutopilot } = autopilotWith();
  allowPlayers(policy, true);
  bot.attack.callsFake(() => { if (bot.attack.callCount === 2) target.isValid = false; });
  registerEntityTools(factory, asBot(bot), getAutopilot);

  const result = await getTool('attack-entity')!.execute({ entityId: 5, times: 5 });

  t.falsy(result.isError);
  t.is(bot.attack.callCount, 2);
  t.true(result.content[0].text.startsWith('Attacked MCPHelper (id 5) 2 time(s); target is gone'));
  t.false(result.content[0].text.includes('stopped:'));
});

test('E-022: with the Autopilot wired in, a hostile mob by id is still attacked as before', async (t) => {
  const { factory, getTool } = createFactory();
  const target = zombie();
  const bot = fakeBot({ 2: target });
  const { getAutopilot } = autopilotWith();
  registerEntityTools(factory, asBot(bot), getAutopilot);

  const result = await getTool('attack-entity')!.execute({ entityId: 2 });

  t.falsy(result.isError);
  t.true(bot.attack.calledOnceWith(target));
  t.is(result.content[0].text, 'Attacked zombie (id 2) 1 time(s); target is still alive');
});
