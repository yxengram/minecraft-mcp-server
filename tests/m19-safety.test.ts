// M19 safety changes (BLUEPRINT F-048). Each case names the clause of its E row; the expected values come from the
// contract and invariant I1, not from what the code happens to print.
import test from 'ava';
import sinon from 'sinon';
import { Vec3 } from 'vec3';
import minecraftData from 'minecraft-data';
import { registerEntityTools } from '../src/tools/entity-tools.js';
import { registerChatTools } from '../src/tools/chat-tools.js';
import { MessageStore } from '../src/message-store.js';
import { PolicyStore } from '../src/autopilot/policy.js';
import type { Autopilot } from '../src/autopilot/autopilot.js';
import { asBot, createFactory } from './_helpers.js';

// ---------------------------------------------------------------------------------------------------------------
// E-022: attack-entity follows invariant I1. Players only with combat.attackPlayers on; tamed animals never (no way
// to force it); no sword hit whose sweep would reach a player or a pet; by type, the nearest target the bot may
// attack, where 'mob', 'hostile' or part of a name names nothing; a target that turns illegal mid-way stops the
// sequence. The first part (players) came first; the rest followed Q21 (2026-10-29).
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

// The bot is verified with 26.1.2; tamed animals are read from that version's metadata layout.
const registry = minecraftData('26.1.2');

function fakeBot(entities: Record<number, unknown>, heldItem?: string) {
  return {
    registry, entity: self, entities, heldItem: heldItem ? { name: heldItem } : null,
    lookAt: sinon.stub().resolves(), attack: sinon.stub()
  };
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

test('E-022: a player chosen by type is refused: no player the bot may attack, with the reason', async (t) => {
  const { factory, getTool } = createFactory();
  const bot = fakeBot({ 5: player() });
  const { getAutopilot } = autopilotWith();
  registerEntityTools(factory, asBot(bot), getAutopilot);

  const result = await getTool('attack-entity')!.execute({ type: 'player' });

  t.true(result.isError);
  // Since the second part, a type whose matches are all illegal gets the type-selection error (E-022 (3)).
  t.is(result.content[0].text, `Failed: No player the bot may attack within 4.5 blocks: ${PLAYER_REASON}`);
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

test('E-022: a target that vanishes during the look is not hit, and that is not a refusal', async (t) => {
  const { factory, getTool } = createFactory();
  const target = zombie();
  const bot = fakeBot({ 2: target });
  const { getAutopilot } = autopilotWith();
  bot.lookAt.callsFake(async () => { target.isValid = false; });
  registerEntityTools(factory, asBot(bot), getAutopilot);

  const result = await getTool('attack-entity')!.execute({ entityId: 2, times: 3 });

  t.falsy(result.isError);
  t.false(bot.attack.called);
  t.true(result.content[0].text.startsWith('Attacked zombie (id 2) 0 time(s); target is gone'));
  t.false(result.content[0].text.includes('stopped:'));
});

test('E-022: a player that vanishes during the look, with attackPlayers on, ends as "target is gone", not a refusal', async (t) => {
  const { factory, getTool } = createFactory();
  const target = player();
  const bot = fakeBot({ 5: target });
  const { policy, getAutopilot } = autopilotWith();
  allowPlayers(policy, true);
  bot.lookAt.callsFake(async () => { target.isValid = false; });
  registerEntityTools(factory, asBot(bot), getAutopilot);

  const result = await getTool('attack-entity')!.execute({ entityId: 5, times: 3 });

  t.falsy(result.isError);
  t.false(bot.attack.called);
  t.true(result.content[0].text.startsWith('Attacked MCPHelper (id 5) 0 time(s); target is gone'));
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

// --- E-022 (second part, Q21): tamed animals, named types, the sword sweep -------------------------------------

const OWNER = '0b1c2d3e-0000-4000-8000-000000000001';
const TAMED_REASON = 'wolf is tamed; tamed animals are never attacked';
const TARGET_AT = new Vec3(2, 64, 0);
// One block beside the target and about 2.24 blocks from the bot: a sword sweep would hit it.
const BESIDE = new Vec3(2, 64, 1);
const DESCRIPTION_END = 'Never hits players (unless combat.attackPlayers is on) or tamed animals, and holds back a sword hit whose sweep would reach them';

function sweepReason(bystander: string, target: string) {
  return `${bystander} is next to ${target}; a sword sweep would hit it too. Hold a non-sword item (equip-item) or wait until they move apart`;
}

/** An entity metadata array with each value at the index of its key for that entity type. */
function meta(name: string, values: Record<string, unknown>): unknown[] {
  const keys = registry.entitiesByName[name]?.metadataKeys as string[] | undefined;
  if (!keys) throw new Error(`no metadata keys for ${name}`);
  const result: unknown[] = [];
  for (const [key, value] of Object.entries(values)) {
    const index = keys.indexOf(key);
    if (index < 0) throw new Error(`${name} has no metadata key ${key}`);
    result[index] = value;
  }
  return result;
}

/** A mob with mineflayer's type for its name (26.1.2): allay and iron_golem are 'mob', wolf and cow 'animal'. */
function mob(id: number, name: string, pos: Vec3, metadata: unknown[] = []) {
  return { id, name, type: registry.entitiesByName[name]?.type ?? 'mob', position: pos, height: 1.8, isValid: true, metadata };
}

type FakeEntity = { id: number; position: Vec3 };

/** Registers the tool on a fake bot with these entities and a real PolicyStore, and runs one call. */
async function attackWith(
  entities: FakeEntity[],
  args: Record<string, unknown>,
  { policy = new PolicyStore(), heldItem, setup }: { policy?: PolicyStore; heldItem?: string; setup?: (bot: ReturnType<typeof fakeBot>) => void } = {}
) {
  const { factory, getTool } = createFactory();
  const bot = fakeBot(Object.fromEntries(entities.map(entity => [entity.id, entity])), heldItem);
  setup?.(bot);
  registerEntityTools(factory, asBot(bot), () => ({ policy }) as unknown as Autopilot);
  const result = await getTool('attack-entity')!.execute(args);
  return { bot, result, text: result.content[0].text };
}

function setCombat(policy: PolicyStore, combat: Record<string, unknown>) {
  const result = policy.update({ combat }, 'llm');
  if (!result.ok) throw new Error(result.errors.join('; '));
}

test('E-022: the tool description ends with the I1 sentence', (t) => {
  const { factory, getTool } = createFactory();
  registerEntityTools(factory, asBot(fakeBot({})));

  t.true(getTool('attack-entity')!.description.endsWith(DESCRIPTION_END));
});

// (2) Tamed animals are always refused, also with attackPlayers on; there is no parameter to force it.
for (const [label, name, metadata, reason] of [
  ['a wolf with an owner uuid', 'wolf', () => meta('wolf', { owneruuid: OWNER }), TAMED_REASON],
  ['a wolf with the tamed flag 0x04', 'wolf', () => meta('wolf', { flags: 0x04 }), TAMED_REASON],
  ['a horse with the tamed flag 0x02', 'horse', () => meta('horse', { flags: 0x02 }), 'horse is tamed; tamed animals are never attacked']
] as const) {
  for (const attackPlayers of [false, true]) {
    test(`E-022: ${label} by id is refused and never hit (attackPlayers ${attackPlayers})`, async (t) => {
      const policy = new PolicyStore();
      setCombat(policy, { attackPlayers });
      const pet = mob(3, name, TARGET_AT, metadata());

      const { bot, result, text } = await attackWith([pet], { entityId: 3, times: 3 }, { policy });

      t.true(result.isError);
      t.is(text, `Failed: ${reason}; attack-entity did not attack`);
      t.is(bot.attack.callCount, 0);
    });
  }
}

// The contract does not say which reply comes first for an illegal target out of reach, only that it is never hit.
test('E-022: a tamed wolf out of reach is never hit', async (t) => {
  const pet = mob(3, 'wolf', new Vec3(10, 64, 0), meta('wolf', { owneruuid: OWNER }));

  const { bot, result } = await attackWith([pet], { entityId: 3 });

  t.true(result.isError);
  t.false(bot.attack.called);
});

// (3) Named targets: by id, or a type that is the whole name. Generic types and parts of names name nothing.
for (const name of ['pig', 'cow']) {
  test(`E-022: a ${name} by id is attacked and the reply is unchanged`, async (t) => {
    const animal = mob(3, name, TARGET_AT);

    const { bot, result, text } = await attackWith([animal], { entityId: 3 });

    t.falsy(result.isError);
    t.true(bot.attack.calledOnceWith(animal));
    t.is(text, `Attacked ${name} (id 3) 1 time(s); target is still alive`);
  });
}

for (const args of [{ entityId: 3 }, { type: 'enderman' }, { type: 'Enderman' }]) {
  test(`E-022: with avoidNeutral on, an enderman named by ${JSON.stringify(args)} is attacked`, async (t) => {
    const policy = new PolicyStore();
    t.true(policy.get().combat.avoidNeutral, 'the default policy leaves neutral mobs alone');
    const enderman = mob(3, 'enderman', TARGET_AT);

    const { bot, result, text } = await attackWith([enderman], args, { policy });

    t.falsy(result.isError);
    t.true(bot.attack.calledOnceWith(enderman));
    t.is(text, 'Attacked enderman (id 3) 1 time(s); target is still alive');
  });
}

test("E-022: type 'mob' passes over the nearer iron golem (neutral) and allay (passive) and hits the zombie", async (t) => {
  const golem = mob(3, 'iron_golem', new Vec3(1.5, 64, 0));
  const allay = mob(4, 'allay', new Vec3(0, 64, 2));
  const zombie = mob(6, 'zombie', new Vec3(3, 64, 0));

  const { bot, result, text } = await attackWith([golem, allay, zombie], { type: 'mob' });

  t.falsy(result.isError);
  t.true(bot.attack.calledOnceWith(zombie));
  t.is(text, 'Attacked zombie (id 6) 1 time(s); target is still alive');
});

test("E-022: type 'mob' with only a neutral and a passive mob in reach attacks nothing and gives the nearest one's reason", async (t) => {
  const golem = mob(3, 'iron_golem', new Vec3(1.5, 64, 0));
  const allay = mob(4, 'allay', new Vec3(0, 64, 2));

  const { bot, result, text } = await attackWith([golem, allay], { type: 'mob' });

  t.true(result.isError);
  t.is(text, 'Failed: No mob the bot may attack within 4.5 blocks: iron_golem is neutral and is only attacked when named explicitly');
  t.false(bot.attack.called);
});

test("E-022: type 'mob' never names a passive mob, even when it is the only match", async (t) => {
  const allay = mob(4, 'allay', new Vec3(0, 64, 2));

  const { bot, text } = await attackWith([allay], { type: 'mob' });

  t.is(text, 'Failed: No mob the bot may attack within 4.5 blocks: allay is not hostile');
  t.false(bot.attack.called);
});

test("E-022: with a generic type, neutral mobs follow avoidNeutral: off, the nearest iron golem is attacked", async (t) => {
  const policy = new PolicyStore();
  setCombat(policy, { avoidNeutral: false });
  const golem = mob(3, 'iron_golem', new Vec3(1.5, 64, 0));
  const zombie = mob(6, 'zombie', new Vec3(3, 64, 0));

  const { bot, text } = await attackWith([golem, zombie], { type: 'mob' }, { policy });

  t.true(bot.attack.calledOnceWith(golem));
  t.is(text, 'Attacked iron_golem (id 3) 1 time(s); target is still alive');
});

test("E-022: type 'piglin' passes over the nearer zombified piglin (only part of its name) and hits the piglin", async (t) => {
  const zombified = mob(3, 'zombified_piglin', new Vec3(1, 64, 1));
  const piglin = mob(4, 'piglin', new Vec3(0, 64, 3));

  const { bot, result, text } = await attackWith([zombified, piglin], { type: 'piglin' });

  t.falsy(result.isError);
  t.true(bot.attack.calledOnceWith(piglin));
  t.is(text, 'Attacked piglin (id 4) 1 time(s); target is still alive');
});

// (4) Selecting by type skips the entities that may not be attacked.
test("E-022: type 'wolf' passes over the nearer tamed wolf and hits the wild one in reach", async (t) => {
  const pet = mob(3, 'wolf', new Vec3(1.5, 64, 0), meta('wolf', { owneruuid: OWNER }));
  const wild = mob(4, 'wolf', new Vec3(0, 64, 3.5), meta('wolf', { flags: 0 }));

  const { bot, result, text } = await attackWith([pet, wild], { type: 'wolf' });

  t.falsy(result.isError);
  t.true(bot.attack.calledOnceWith(wild));
  t.is(text, 'Attacked wolf (id 4) 1 time(s); target is still alive');
});

test("E-022: type 'wolf' with only a tamed wolf in reach attacks nothing", async (t) => {
  const pet = mob(3, 'wolf', new Vec3(1.5, 64, 0), meta('wolf', { owneruuid: OWNER }));
  const farWild = mob(4, 'wolf', new Vec3(8, 64, 0));

  const { bot, result, text } = await attackWith([pet, farWild], { type: 'wolf' });

  t.true(result.isError);
  t.is(text, `Failed: No wolf the bot may attack within 4.5 blocks: ${TAMED_REASON}`);
  t.false(bot.attack.called);
});

test('E-022: a type that matches nothing in reach keeps the old reply', async (t) => {
  const { text } = await attackWith([mob(4, 'wolf', new Vec3(8, 64, 0))], { type: 'wolf' });

  t.is(text, 'Failed: No wolf found within 4.5 blocks. Move closer first');
});

// (5) The sword sweep: no hit while a player or a pet stands next to the target.
for (const [label, bystander, name] of [
  ['a player', () => player(5, BESIDE.clone()), 'MCPHelper'],
  ['a tamed wolf', () => mob(5, 'wolf', BESIDE.clone(), meta('wolf', { owneruuid: OWNER })), 'wolf']
] as const) {
  test(`E-022: holding a sword with ${label} next to the target, the bot does not swing`, async (t) => {
    const target = zombie(2, TARGET_AT.clone());

    const { bot, result, text } = await attackWith([target, bystander()], { entityId: 2, times: 3 }, { heldItem: 'diamond_sword' });

    t.true(result.isError);
    t.is(text, `Failed: ${sweepReason(name, 'zombie')}; attack-entity did not attack`);
    t.is(bot.attack.callCount, 0);
  });
}

test('E-022: holding a sword with only a cow next to the target, the bot swings as before', async (t) => {
  const target = zombie(2, TARGET_AT.clone());
  const cow = mob(5, 'cow', BESIDE.clone());

  const { bot, result, text } = await attackWith([target, cow], { entityId: 2 }, { heldItem: 'iron_sword' });

  t.falsy(result.isError);
  t.true(bot.attack.calledOnceWith(target));
  t.is(text, 'Attacked zombie (id 2) 1 time(s); target is still alive');
});

for (const heldItem of ['iron_axe', undefined]) {
  test(`E-022: holding ${heldItem ?? 'nothing'} (no sweep), a player next to the target does not stop the hit`, async (t) => {
    const target = zombie(2, TARGET_AT.clone());

    const { bot, result } = await attackWith([target, player(5, BESIDE.clone())], { entityId: 2 }, { heldItem });

    t.falsy(result.isError);
    t.true(bot.attack.calledOnceWith(target));
  });
}

test('E-022: with attackPlayers on, a sword sweep still may not reach a player beside the target', async (t) => {
  const policy = new PolicyStore();
  setCombat(policy, { attackPlayers: true });
  const target = zombie(2, TARGET_AT.clone());

  const { bot, text } = await attackWith([target, player(5, BESIDE.clone())], { entityId: 2 }, { policy, heldItem: 'diamond_sword' });

  t.is(text, `Failed: ${sweepReason('MCPHelper', 'zombie')}; attack-entity did not attack`);
  t.false(bot.attack.called);
});

test('E-022: with attackPlayers on, a player may be the target but another player beside it holds back the sword', async (t) => {
  const policy = new PolicyStore();
  setCombat(policy, { attackPlayers: true });
  const target = player(5, TARGET_AT.clone());
  const alex = { ...player(6, BESIDE.clone()), username: 'Alex' };

  const { bot, text } = await attackWith([target, alex], { entityId: 5 }, { policy, heldItem: 'diamond_sword' });

  t.is(text, `Failed: ${sweepReason('Alex', 'MCPHelper')}; attack-entity did not attack`);
  t.false(bot.attack.called);
});

// (6) A target that turns illegal mid-way stops the sequence before the next hit.
test('E-022: a player stepping next to the target after the 2nd hit (sword in hand) stops it before the 3rd', async (t) => {
  const target = zombie(2, TARGET_AT.clone());

  const { bot, result, text } = await attackWith([target], { entityId: 2, times: 5 }, {
    heldItem: 'diamond_sword',
    setup: fake => fake.attack.callsFake(() => {
      if (fake.attack.callCount === 2) fake.entities[5] = player(5, BESIDE.clone());
    })
  });

  t.falsy(result.isError);
  t.is(bot.attack.callCount, 2);
  // The sweep is checked after the 3rd look, right before the hit it holds back (E-022 (5)).
  t.is(bot.lookAt.callCount, 3);
  t.true(text.includes('2 time(s); stopped:'));
  t.is(text, `Attacked zombie (id 2) 2 time(s); stopped: ${sweepReason('MCPHelper', 'zombie')}; target is still alive`);
});

test('E-022: a player stepping next to the target during the look (sword in hand) means no hit at all', async (t) => {
  const target = zombie(2, TARGET_AT.clone());

  const { bot, result, text } = await attackWith([target], { entityId: 2, times: 3 }, {
    heldItem: 'diamond_sword',
    setup: fake => fake.lookAt.callsFake(async () => { fake.entities[5] = player(5, BESIDE.clone()); })
  });

  t.true(result.isError);
  t.is(text, `Failed: ${sweepReason('MCPHelper', 'zombie')}; attack-entity did not attack`);
  t.false(bot.attack.called);
});

test('E-022: a wolf tamed after the 2nd hit is not hit a 3rd time', async (t) => {
  const wolf = mob(3, 'wolf', TARGET_AT.clone(), meta('wolf', { flags: 0 }));

  const { bot, text } = await attackWith([wolf], { entityId: 3, times: 5 }, {
    setup: fake => fake.attack.callsFake(() => {
      if (fake.attack.callCount === 2) wolf.metadata = meta('wolf', { owneruuid: OWNER });
    })
  });

  t.is(bot.attack.callCount, 2);
  t.is(text, `Attacked wolf (id 3) 2 time(s); stopped: ${TAMED_REASON}; target is still alive`);
});

// (7) A target killed during the sequence ends as before.
test('E-022: a target killed by the 2nd hit, sword in hand and a cow beside it, ends with "target is gone"', async (t) => {
  const target = zombie(2, TARGET_AT.clone());

  const { bot, result, text } = await attackWith([target, mob(5, 'cow', BESIDE.clone())], { entityId: 2, times: 5 }, {
    heldItem: 'diamond_sword',
    setup: fake => fake.attack.callsFake(() => { if (fake.attack.callCount === 2) target.isValid = false; })
  });

  t.falsy(result.isError);
  t.is(bot.attack.callCount, 2);
  t.true(text.startsWith('Attacked zombie (id 2) 2 time(s); target is gone'));
  t.false(text.includes('stopped:'));
});

test('E-022: a target that is already gone is not refused: the call ends with "target is gone"', async (t) => {
  const target = { ...player(5, TARGET_AT.clone()), isValid: false };

  const { bot, result, text } = await attackWith([target], { entityId: 5 });

  t.falsy(result.isError);
  t.false(bot.attack.called);
  t.true(text.startsWith('Attacked MCPHelper (id 5) 0 time(s); target is gone'));
});

// ---------------------------------------------------------------------------------------------------------------
// E-033: send-chat runs no server command unless the server was started with --allow-commands (Q22). The check looks
// at the pieces mineflayer's bot.chat sends: a message that starts with / goes out whole as one command, so it must be
// a single line, with or without the option; any other message is split at line breaks and cut every 256 characters,
// and each piece that starts with / is a command. /msg, /tell, /w, /me, /teammsg and /tm always work. Refused means
// nothing is sent at all.
// ---------------------------------------------------------------------------------------------------------------

const SINGLE_LINE = 'Nothing was sent: commands must be a single line (a message that starts with / is sent as one command, so it cannot contain line breaks or control characters)';
const serverCommand = (name: string) =>
  `"/${name}" is a server command and this MCP server was started without --allow-commands, so nothing was sent. Plain chat and /msg, /tell, /w, /me, /teammsg, /tm always work; other commands need the user to add --allow-commands to the server's arguments and restart it`;
const DESCRIPTION_OFF = 'Send a chat message in-game. Chat commands (/msg, /tell, /w, /me, /teammsg, /tm) always work; other server commands are refused because this server was started without --allow-commands';
const DESCRIPTION_ON = 'Send a chat message in-game, or run a server command (this server was started with --allow-commands)';

function sendChat(options?: { allowCommands?: boolean }, extra: Record<string, unknown> = {}) {
  const { factory, getTool } = createFactory();
  // supportFeature answers as a 1.11+ server (26.1.2 among them) does, so mineflayer's 256-character chunks apply.
  const bot = { chat: sinon.stub(), supportFeature: (_feature: string) => false, ...extra };
  registerChatTools(factory, asBot(bot), new MessageStore(), options);
  const tool = getTool('send-chat')!;
  const send = async (message: string) => {
    const result = await tool.execute({ message });
    return { result, text: result.content[0].text };
  };
  return { bot, tool, send };
}

const OFF = undefined;
const ON = { allowCommands: true };

// src/main.ts passes { allowCommands: false } when the option is not given; leaving the argument out is the same.
for (const [label, options] of [['left out', OFF], ['false', { allowCommands: false }]] as const) {
  test(`E-033: by default (option ${label}) "/give @s diamond" is refused and bot.chat is never called`, async (t) => {
    const { bot, send } = sendChat(options);

    const { result, text } = await send('/give @s diamond');

    t.true(result.isError);
    t.true(text.includes(serverCommand('give')), text);
    t.false(bot.chat.called);
  });
}

test('E-033: by default "hello\\n/op x" is refused: its second line goes out as a command', async (t) => {
  const { bot, send } = sendChat(OFF);

  const { result, text } = await send('hello\n/op x');

  t.true(result.isError);
  t.true(text.includes(serverCommand('op')), text);
  t.false(bot.chat.called);
});

test('E-033: by default a 300-character line whose 257th character starts "/op x" is refused', async (t) => {
  const { bot, send } = sendChat(OFF);
  const message = 'a'.repeat(256) + '/op x' + 'b'.repeat(39);
  t.is(message.length, 300);

  const { result, text } = await send(message);

  t.true(result.isError);
  t.true(text.includes(serverCommand('op')), text);
  t.false(bot.chat.called);
});

// The same line with the / one character earlier: the second piece starts with "o", so it is plain chat.
test('E-033: a / inside a long line that does not start a piece is plain chat and is sent', async (t) => {
  const { bot, send } = sendChat(OFF);
  const message = 'a'.repeat(255) + '/op x' + 'b'.repeat(40);

  const { result, text } = await send(message);

  t.falsy(result.isError);
  t.true(bot.chat.calledOnceWithExactly(message));
  t.is(text, `Sent message: "${message}"`);
});

for (const [label, options] of [['by default', OFF], ['with allowCommands', ON]] as const) {
  test(`E-033: ${label} "/msg Steve hi\\n/op Eve" is refused as not a single line`, async (t) => {
    const { bot, send } = sendChat(options);

    const { result, text } = await send('/msg Steve hi\n/op Eve');

    t.true(result.isError);
    t.true(text.includes('commands must be a single line'), text);
    t.true(text.includes(SINGLE_LINE), text);
    t.false(bot.chat.called);
  });

  for (const control of ['\u0007', '\t', '\r', '\u0000', '\u001f', '\u007f']) {
    test(`E-033: ${label} "/me hi" with U+${control.charCodeAt(0).toString(16).padStart(4, '0')} is refused as not a single line`, async (t) => {
      const { bot, send } = sendChat(options);

      const { result, text } = await send(`/me hi${control}`);

      t.true(result.isError);
      t.true(text.includes(SINGLE_LINE), text);
      t.false(bot.chat.called);
    });
  }

  for (const message of [
    '/msg Steve hi', '/tell Steve hi', '/w Steve hi', '/me waves', '/minecraft:tell Steve hi', 'hi\n/msg Steve x',
    '/teammsg hi team', '/tm hi team', 'hello world'
  ]) {
    test(`E-033: ${label} ${JSON.stringify(message)} is sent once as written, with the plain chat reply`, async (t) => {
      const { bot, send } = sendChat(options);

      const { result, text } = await send(message);

      t.falsy(result.isError);
      t.true(bot.chat.calledOnceWithExactly(message));
      t.is(text, `Sent message: "${message}"`);
    });
  }
}

test('E-033: with allowCommands "/time set day" is sent and the reply names the command it ran', async (t) => {
  const { bot, send } = sendChat(ON);

  const { result, text } = await send('/time set day');

  t.falsy(result.isError);
  t.true(bot.chat.calledOnceWithExactly('/time set day'));
  t.true(text.includes('ran 1 command: /time set day'), text);
  t.is(text, 'Sent message: "/time set day" (ran 1 command: /time set day)');
});

test('E-033: with allowCommands a command on a later line is sent, and the reply names it', async (t) => {
  const { bot, send } = sendChat(ON);

  const { text } = await send('hello\n/op x');

  t.true(bot.chat.calledOnceWithExactly('hello\n/op x'));
  t.is(text, 'Sent message: "hello\n/op x" (ran 1 command: /op x)');
});

test('E-033: with allowCommands two server commands are listed, chat commands are not', async (t) => {
  const { bot, send } = sendChat(ON);
  const message = 'hi\n/time set day\n/msg Steve x\n/weather clear';

  const { text } = await send(message);

  t.true(bot.chat.calledOnceWithExactly(message));
  t.is(text, `Sent message: "${message}" (ran 2 commands: /time set day, /weather clear)`);
});

test('E-033: the error names the first refused command, not a chat command before it', async (t) => {
  const { bot, send } = sendChat(OFF);

  const { result, text } = await send('hi\n/msg Steve x\n/give @s diamond\n/op Eve');

  t.true(result.isError);
  t.true(text.includes(serverCommand('give')), text);
  t.false(bot.chat.called);
});

test('E-033: the command name is read in lower case and without the minecraft: prefix', async (t) => {
  const { bot, send } = sendChat(OFF);

  const upper = await send('/GIVE @s diamond');
  const namespaced = await send('/Minecraft:Give @s diamond');
  const chat = await send('/MINECRAFT:MSG Steve hi');

  t.true(upper.text.includes(serverCommand('give')), upper.text);
  t.true(namespaced.text.includes(serverCommand('give')), namespaced.text);
  t.falsy(chat.result.isError);
  t.true(bot.chat.calledOnceWithExactly('/MINECRAFT:MSG Steve hi'));
});

// mineflayer cuts chat at 100 characters on servers before 1.11 (lessCharsInChat); the pieces follow it.
test('E-033: on a server where mineflayer cuts chat at 100 characters, a / at the 101st character is a command', async (t) => {
  const { bot, send } = sendChat(OFF, { supportFeature: (feature: string) => feature === 'lessCharsInChat' });

  const { result, text } = await send('a'.repeat(100) + '/op x');

  t.true(result.isError);
  t.true(text.includes(serverCommand('op')), text);
  t.false(bot.chat.called);
});

test('E-033: the description says whether the server was started with --allow-commands', (t) => {
  t.is(sendChat(OFF).tool.description, DESCRIPTION_OFF);
  t.is(sendChat({ allowCommands: false }).tool.description, DESCRIPTION_OFF);
  t.is(sendChat(ON).tool.description, DESCRIPTION_ON);
});
