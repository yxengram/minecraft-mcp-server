// Verifies docs/BLUEPRINT.md F-022 against the F-014 contract (src/autopilot/policy.ts) and the policy part of
// invariant I2 (G6). Expected values come from the contracts, not from what the implementation happens to output:
// - F-014: groups reflexes and combat (chat and decisions arrive in M4); combat.attackPlayers defaults to false and
//   combat.avoidNeutral to true; unknown fields rejected; health and food 0-20; distances 1-32; the source is llm or
//   startup only; on any validation error all errors are returned and the policy is unchanged; every time
//   attackPlayers is switched on a warning is returned; after an update every reader sees the new values at once.
// - F-013: low-health-retreat health 6 within 16 blocks, auto-eat food 14; the reflexes work without the LLM, so all
//   are enabled by default. (hazard-escape and reflexes.hazardEscape were removed in M8, E-011.)
// - E-011 (M8): the instinct group: enabled true, intent '' (at most 300 characters, only the LLM may set it), lowAir
//   6 (0-20), reaskMs 1500 (whole ms, 500-10000), actThreshold and urgentThreshold within 0-1 (0.4 and 0.6 after the
//   M8 threshold probe), maxCallsPerMinute 90 (whole number, 1-600).
// - Not in the F-014 text (from the M3 assignment and F-011): selfDefense stance defaults to 'auto' (rules until M5)
//   and combat.retreatHealth defaults to 6 (combat's retreat health).
// No timers or bots are involved, so the tests need no fake clock. Each test uses its own PolicyStore.
import test, { ExecutionContext } from 'ava';
import {
  DEFAULT_DECISION_MODEL, DEFAULT_POLICY, Policy, PolicySource, PolicyStore, UpdateResult, describePolicy, policySchema
} from '../src/autopilot/policy.js';

const EXPECTED_DEFAULTS: Policy = {
  reflexes: {
    creeperEvade: { enabled: true },
    lowHealthRetreat: { enabled: true, health: 6, radius: 16 },
    selfDefense: { enabled: true, stance: 'auto' },
    autoEat: { enabled: true, food: 14 }
  },
  // M8 group (E-011); thresholds from the M8 probe.
  instinct: { enabled: true, intent: '', lowAir: 6, reaskMs: 1500, actThreshold: 0.4, urgentThreshold: 0.6, maxCallsPerMinute: 90 },
  combat: { attackPlayers: false, avoidNeutral: true, retreatHealth: 6 },
  // M4 groups (F-014): nobody is authorized by default; thresholds set by the M5 probe (PLAN M5).
  chat: { triage: true, commandsFrom: [], replyInChat: true },
  decisions: { enabled: true, model: DEFAULT_DECISION_MODEL, actThreshold: 0.95, cautiousThreshold: 0.5, combatThreshold: 0.6, maxCallsPerMinute: 30 }
};

type Accepted = Extract<UpdateResult, { ok: true }>;

/** The defaults with some fields changed, as a plain (unfrozen) object. */
function expected(change: (policy: Policy) => void = () => undefined): Policy {
  const policy = structuredClone(EXPECTED_DEFAULTS);
  change(policy);
  return policy;
}

/** A plain deep copy, so later comparisons do not depend on the store keeping the same object. */
function snapshot(policy: Policy): Policy {
  return structuredClone(policy);
}

function accepted(t: ExecutionContext, result: UpdateResult, what: string): Accepted {
  if (!result.ok) {
    throw new Error(`expected ${what} to be accepted, got errors: ${result.errors.join(' | ')}`);
  }
  t.true(result.ok);
  return result;
}

function rejected(t: ExecutionContext, result: UpdateResult, what: string): string[] {
  if (result.ok) {
    throw new Error(`expected ${what} to be rejected, but it was accepted (changed: ${result.changed.join(', ') || 'nothing'})`);
  }
  t.true(result.errors.length > 0, `${what}: a rejection must carry at least one error`);
  return result.errors;
}

/** A store already moved off the defaults, so "unchanged" cannot pass by coincidence with the defaults. */
function storeOffDefaults(t: ExecutionContext): { store: PolicyStore; before: Policy } {
  const store = new PolicyStore();
  accepted(t, store.update({ reflexes: { autoEat: { food: 10 }, selfDefense: { stance: 'flee' } }, combat: { retreatHealth: 8 } }, 'llm'),
    'the setup update');
  const before = snapshot(store.get());
  t.deepEqual(before, expected(p => {
    p.reflexes.autoEat.food = 10;
    p.reflexes.selfDefense.stance = 'flee';
    p.combat.retreatHealth = 8;
  }), 'setup: the store should hold the setup values');
  return { store, before };
}

// ---------------------------------------------------------------------------------------------------------------
// Defaults

test('a new store holds the F-014 defaults', t => {
  const store = new PolicyStore();
  t.deepEqual(store.get(), EXPECTED_DEFAULTS);
  t.false(store.get().combat.attackPlayers, 'attackPlayers must default to false (I1)');
  t.true(store.get().combat.avoidNeutral, 'avoidNeutral must default to true');
});

test('DEFAULT_POLICY matches the contract defaults and is not changed by store updates', t => {
  t.deepEqual(DEFAULT_POLICY, EXPECTED_DEFAULTS);
  const store = new PolicyStore();
  accepted(t, store.update({
    reflexes: { creeperEvade: { enabled: false }, lowHealthRetreat: { radius: 4 }, autoEat: { food: 3 } },
    combat: { attackPlayers: true, avoidNeutral: false }
  }, 'llm'), 'an update touching both groups');
  store.reset();
  t.deepEqual(DEFAULT_POLICY, EXPECTED_DEFAULTS, 'updating and resetting a store must not modify the exported defaults');
});

test('stores are independent: updating one does not change another or a new one', t => {
  const a = new PolicyStore();
  const b = new PolicyStore();
  accepted(t, a.update({ combat: { attackPlayers: true }, reflexes: { autoEat: { enabled: false } } }, 'llm'), 'update of store a');
  t.deepEqual(b.get(), EXPECTED_DEFAULTS);
  t.deepEqual(new PolicyStore().get(), EXPECTED_DEFAULTS);
});

// ---------------------------------------------------------------------------------------------------------------
// Partial updates

test('a partial update changes only the named field and every reader sees it at once', t => {
  const store = new PolicyStore();
  const result = accepted(t, store.update({ reflexes: { lowHealthRetreat: { health: 4 } } }, 'llm'), 'health 4');
  const want = expected(p => { p.reflexes.lowHealthRetreat.health = 4; });
  t.deepEqual(result.policy, want, 'the result carries the new policy');
  t.deepEqual(store.get(), want, 'get() returns the new value immediately, siblings (radius, enabled) untouched');
  t.deepEqual(result.changed, ['reflexes.lowHealthRetreat.health']);
  t.deepEqual(result.warnings, []);
});

test('successive partial updates in both groups accumulate; startup is an accepted source', t => {
  const store = new PolicyStore();
  accepted(t, store.update({ reflexes: { autoEat: { enabled: false } } }, 'llm'), 'autoEat off');
  accepted(t, store.update({ combat: { retreatHealth: 9 } }, 'startup'), 'retreatHealth 9 from startup');
  accepted(t, store.update({ reflexes: { selfDefense: { stance: 'fight' } }, instinct: { lowAir: 3 } }, 'llm'),
    'stance fight and lowAir 3');
  t.deepEqual(store.get(), expected(p => {
    p.reflexes.autoEat.enabled = false;
    p.combat.retreatHealth = 9;
    p.reflexes.selfDefense.stance = 'fight';
    p.instinct.lowAir = 3;
  }));
});

test('changing the update object after the call does not change the policy', t => {
  const store = new PolicyStore();
  const raw = { reflexes: { autoEat: { food: 12 } }, combat: { retreatHealth: 7 } };
  accepted(t, store.update(raw, 'llm'), 'food 12 and retreatHealth 7');
  raw.reflexes.autoEat.food = 1;
  raw.combat.retreatHealth = 1;
  t.is(store.get().reflexes.autoEat.food, 12);
  t.is(store.get().combat.retreatHealth, 7);
});

// ---------------------------------------------------------------------------------------------------------------
// Validation: unknown fields

const UNKNOWN_FIELD_CASES: { level: string; typo: string; update: Record<string, unknown> }[] = [
  {
    level: 'top-level group',
    typo: 'reflxes',
    update: { reflxes: { autoEat: { food: 5 } }, combat: { retreatHealth: 3 } }
  },
  {
    level: 'reflex name',
    typo: 'autoEet',
    update: { reflexes: { autoEet: { food: 5 }, creeperEvade: { enabled: false } } }
  },
  {
    level: 'reflex field',
    typo: 'fod',
    update: { reflexes: { autoEat: { fod: 5, enabled: false } } }
  },
  {
    level: 'combat field',
    typo: 'attackPlayer',
    update: { combat: { attackPlayer: true, retreatHealth: 3 } }
  }
];

for (const { level, typo, update } of UNKNOWN_FIELD_CASES) {
  test(`an unknown ${level} ('${typo}') is rejected and the valid part of the update is not applied`, t => {
    const { store, before } = storeOffDefaults(t);
    const errors = rejected(t, store.update(update, 'llm'), `an update with '${typo}'`);
    t.true(errors.some(error => error.includes(typo)), `an error should name '${typo}': ${errors.join(' | ')}`);
    t.deepEqual(store.get(), before, 'the policy must be unchanged');
  });
}

test('unknown fields at every level in one update are all reported, and nothing changes', t => {
  const { store, before } = storeOffDefaults(t);
  const errors = rejected(t, store.update({
    reflxes: {},
    reflexes: { autoEet: { food: 5 }, autoEat: { fod: 5, enabled: false } },
    combat: { attackPlayers: true }
  }, 'llm'), 'an update with three typos');
  t.true(errors.length >= 3, `expected one error per bad object, got ${errors.length}: ${errors.join(' | ')}`);
  for (const typo of ['reflxes', 'autoEet', 'fod']) {
    t.true(errors.some(error => error.includes(typo)), `an error should name '${typo}': ${errors.join(' | ')}`);
  }
  t.deepEqual(store.get(), before);
  t.false(store.get().combat.attackPlayers, 'the valid attackPlayers part must not be applied');
});

// ---------------------------------------------------------------------------------------------------------------
// Validation: ranges and types

const OUT_OF_RANGE_CASES: { name: string; field: string; update: Record<string, unknown> }[] = [
  { name: 'lowHealthRetreat.health -1', field: 'health', update: { reflexes: { lowHealthRetreat: { health: -1, enabled: false } } } },
  { name: 'lowHealthRetreat.health 21', field: 'health', update: { reflexes: { lowHealthRetreat: { health: 21, enabled: false } } } },
  { name: 'autoEat.food -1', field: 'food', update: { reflexes: { autoEat: { food: -1, enabled: false } } } },
  { name: 'autoEat.food 21', field: 'food', update: { reflexes: { autoEat: { food: 21, enabled: false } } } },
  { name: 'instinct.lowAir 21', field: 'lowAir', update: { instinct: { lowAir: 21, enabled: false } } },
  { name: 'instinct.lowAir -1', field: 'lowAir', update: { instinct: { lowAir: -1, enabled: false } } },
  { name: 'instinct.reaskMs 499', field: 'reaskMs', update: { instinct: { reaskMs: 499, enabled: false } } },
  { name: 'instinct.reaskMs 10001', field: 'reaskMs', update: { instinct: { reaskMs: 10001, enabled: false } } },
  { name: 'instinct.reaskMs 1500.5', field: 'reaskMs', update: { instinct: { reaskMs: 1500.5, enabled: false } } },
  { name: 'instinct.actThreshold 1.1', field: 'actThreshold', update: { instinct: { actThreshold: 1.1, enabled: false } } },
  { name: 'instinct.actThreshold -0.1', field: 'actThreshold', update: { instinct: { actThreshold: -0.1, enabled: false } } },
  { name: 'instinct.urgentThreshold 1.1', field: 'urgentThreshold', update: { instinct: { urgentThreshold: 1.1, enabled: false } } },
  { name: 'instinct.urgentThreshold -0.1', field: 'urgentThreshold', update: { instinct: { urgentThreshold: -0.1, enabled: false } } },
  { name: 'instinct.maxCallsPerMinute 0', field: 'maxCallsPerMinute', update: { instinct: { maxCallsPerMinute: 0, enabled: false } } },
  { name: 'instinct.maxCallsPerMinute 601', field: 'maxCallsPerMinute', update: { instinct: { maxCallsPerMinute: 601, enabled: false } } },
  { name: 'instinct.maxCallsPerMinute 2.5', field: 'maxCallsPerMinute', update: { instinct: { maxCallsPerMinute: 2.5, enabled: false } } },
  { name: 'instinct.intent of 301 characters', field: 'intent', update: { instinct: { intent: 'x'.repeat(301), enabled: false } } },
  { name: 'combat.retreatHealth 21', field: 'retreatHealth', update: { combat: { retreatHealth: 21, avoidNeutral: false } } },
  { name: 'combat.retreatHealth -1', field: 'retreatHealth', update: { combat: { retreatHealth: -1, avoidNeutral: false } } },
  { name: 'lowHealthRetreat.radius 0', field: 'radius', update: { reflexes: { lowHealthRetreat: { radius: 0, health: 3 } } } },
  { name: 'lowHealthRetreat.radius 0.5', field: 'radius', update: { reflexes: { lowHealthRetreat: { radius: 0.5, health: 3 } } } },
  { name: 'lowHealthRetreat.radius 33', field: 'radius', update: { reflexes: { lowHealthRetreat: { radius: 33, health: 3 } } } },
  { name: 'lowHealthRetreat.radius -5', field: 'radius', update: { reflexes: { lowHealthRetreat: { radius: -5, health: 3 } } } }
];

for (const { name, field, update } of OUT_OF_RANGE_CASES) {
  test(`out-of-range ${name} is rejected and the policy is unchanged`, t => {
    const { store, before } = storeOffDefaults(t);
    const errors = rejected(t, store.update(update, 'llm'), name);
    t.true(errors.some(error => error.includes(field)), `an error should name '${field}': ${errors.join(' | ')}`);
    t.deepEqual(store.get(), before);
  });
}

test('two out-of-range values in one update are both reported', t => {
  const { store, before } = storeOffDefaults(t);
  const errors = rejected(t, store.update({ reflexes: { autoEat: { food: 25 } }, combat: { retreatHealth: -3 } }, 'llm'),
    'food 25 and retreatHealth -3');
  t.true(errors.length >= 2, `expected both errors, got: ${errors.join(' | ')}`);
  t.true(errors.some(error => error.includes('food')));
  t.true(errors.some(error => error.includes('retreatHealth')));
  t.deepEqual(store.get(), before);
});

test('range boundaries are inclusive: 0 and 20 for health, food and air, 1 and 32 for the radius', t => {
  const store = new PolicyStore();
  accepted(t, store.update({
    reflexes: { lowHealthRetreat: { health: 0, radius: 1 }, autoEat: { food: 0 } },
    instinct: { lowAir: 0 },
    combat: { retreatHealth: 0 }
  }, 'llm'), 'the lower bounds');
  t.deepEqual(store.get(), expected(p => {
    p.reflexes.lowHealthRetreat.health = 0;
    p.reflexes.lowHealthRetreat.radius = 1;
    p.reflexes.autoEat.food = 0;
    p.instinct.lowAir = 0;
    p.combat.retreatHealth = 0;
  }));
  accepted(t, store.update({
    reflexes: { lowHealthRetreat: { health: 20, radius: 32 }, autoEat: { food: 20 } },
    instinct: { lowAir: 20 },
    combat: { retreatHealth: 20 }
  }, 'llm'), 'the upper bounds');
  t.deepEqual(store.get(), expected(p => {
    p.reflexes.lowHealthRetreat.health = 20;
    p.reflexes.lowHealthRetreat.radius = 32;
    p.reflexes.autoEat.food = 20;
    p.instinct.lowAir = 20;
    p.combat.retreatHealth = 20;
  }));
});

const WRONG_TYPE_CASES: { name: string; update: Record<string, unknown> }[] = [
  { name: "creeperEvade.enabled 'yes'", update: { reflexes: { creeperEvade: { enabled: 'yes' } } } },
  { name: "lowHealthRetreat.health '4'", update: { reflexes: { lowHealthRetreat: { health: '4' } } } },
  { name: 'autoEat.food null', update: { reflexes: { autoEat: { food: null } } } },
  { name: "combat.attackPlayers 'true'", update: { combat: { attackPlayers: 'true' } } },
  { name: 'combat.attackPlayers 1', update: { combat: { attackPlayers: 1 } } },
  { name: 'reflexes.autoEat false (group given as a value)', update: { reflexes: { autoEat: false } } },
  { name: 'combat as an array', update: { combat: [] } }
];

for (const { name, update } of WRONG_TYPE_CASES) {
  test(`a wrong type (${name}) is rejected and the policy is unchanged`, t => {
    const { store, before } = storeOffDefaults(t);
    rejected(t, store.update(update, 'llm'), name);
    t.deepEqual(store.get(), before);
    t.false(store.get().combat.attackPlayers, 'attackPlayers can only be switched on with a real true');
  });
}

test('an invalid self-defense stance is rejected; fight, flee and auto are accepted', t => {
  const { store, before } = storeOffDefaults(t);
  for (const stance of ['attack', 'Fight', 'hold', '', 1]) {
    const errors = rejected(t, store.update({ reflexes: { selfDefense: { stance, enabled: false } } }, 'llm'),
      `stance ${JSON.stringify(stance)}`);
    t.true(errors.some(error => error.includes('stance')), `an error should name 'stance': ${errors.join(' | ')}`);
    t.deepEqual(store.get(), before, `stance ${JSON.stringify(stance)} must leave the policy unchanged`);
  }
  for (const stance of ['fight', 'auto', 'flee'] as const) {
    accepted(t, store.update({ reflexes: { selfDefense: { stance } } }, 'llm'), `stance ${stance}`);
    t.is(store.get().reflexes.selfDefense.stance, stance);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Invariant I2: only the LLM (set-policy) and startup configuration may change the policy

for (const source of ['chat', 'whisper', 'LLM', 'Startup', '', 'player']) {
  test(`I2: an update from source '${source}' is rejected and changes nothing`, t => {
    const { store, before } = storeOffDefaults(t);
    rejected(t, store.update({
      combat: { attackPlayers: true, avoidNeutral: false },
      reflexes: { creeperEvade: { enabled: false } }
    }, source as unknown as PolicySource), `the '${source}' update`);
    t.deepEqual(store.get(), before);
    t.false(store.get().combat.attackPlayers, 'chat must never be able to switch attackPlayers on');
  });
}

test('I2: a missing source is rejected', t => {
  const { store, before } = storeOffDefaults(t);
  rejected(t, store.update({ reflexes: { autoEat: { enabled: false } } }, undefined as unknown as PolicySource), 'an update without a source');
  t.deepEqual(store.get(), before);
});

// ---------------------------------------------------------------------------------------------------------------
// Warnings

test('switching attackPlayers on returns a warning every time it goes from off to on', t => {
  const store = new PolicyStore();
  const first = accepted(t, store.update({ combat: { attackPlayers: true } }, 'llm'), 'attackPlayers on');
  t.is(first.warnings.length, 1, `expected one warning, got: ${JSON.stringify(first.warnings)}`);
  t.regex(first.warnings[0] ?? '', /attackPlayers/);
  t.true(store.get().combat.attackPlayers);

  const off = accepted(t, store.update({ combat: { attackPlayers: false } }, 'llm'), 'attackPlayers off');
  t.deepEqual(off.warnings, [], 'switching it off is not a warning');
  t.false(store.get().combat.attackPlayers);

  const second = accepted(t, store.update({ combat: { attackPlayers: true } }, 'llm'), 'attackPlayers on again');
  t.is(second.warnings.length, 1, 'the second off -> on switch must warn again');
  t.regex(second.warnings[0] ?? '', /attackPlayers/);
});

// F-014: "每次设为 true 都返回一条警告" — every request to attack players is reported, even when it is already on.
test('setting attackPlayers to true when it is already on reports no change but warns again', t => {
  const store = new PolicyStore();
  accepted(t, store.update({ combat: { attackPlayers: true } }, 'llm'), 'attackPlayers on');
  const again = accepted(t, store.update({ combat: { attackPlayers: true } }, 'llm'), 'attackPlayers on while already on');
  t.deepEqual(again.changed, []);
  t.is(again.warnings.length, 1);
  t.regex(again.warnings[0] ?? '', /attackPlayers/);
  t.true(store.get().combat.attackPlayers);
});

test('switching attackPlayers on from startup also returns a warning', t => {
  const store = new PolicyStore();
  const result = accepted(t, store.update({ combat: { attackPlayers: true } }, 'startup'), 'attackPlayers on from startup');
  t.is(result.warnings.length, 1);
  t.regex(result.warnings[0] ?? '', /attackPlayers/);
});

test('switching avoidNeutral off returns a warning; switching it back on does not', t => {
  const store = new PolicyStore();
  const off = accepted(t, store.update({ combat: { avoidNeutral: false } }, 'llm'), 'avoidNeutral off');
  t.is(off.warnings.length, 1, `expected one warning, got: ${JSON.stringify(off.warnings)}`);
  t.regex(off.warnings[0] ?? '', /avoidNeutral/);
  t.false(store.get().combat.avoidNeutral);

  const offAgain = accepted(t, store.update({ combat: { avoidNeutral: false } }, 'llm'), 'avoidNeutral off while already off');
  t.deepEqual(offAgain.warnings, []);

  const on = accepted(t, store.update({ combat: { avoidNeutral: true } }, 'llm'), 'avoidNeutral on');
  t.deepEqual(on.warnings, [], 'going back to the safe default is not a warning');
  t.true(store.get().combat.avoidNeutral);
});

test('switching attackPlayers on and avoidNeutral off together returns both warnings', t => {
  const store = new PolicyStore();
  const result = accepted(t, store.update({ combat: { attackPlayers: true, avoidNeutral: false } }, 'llm'), 'both risky changes');
  t.is(result.warnings.length, 2, `expected two warnings, got: ${JSON.stringify(result.warnings)}`);
  t.true(result.warnings.some(w => w.includes('attackPlayers')));
  t.true(result.warnings.some(w => w.includes('avoidNeutral')));
});

test('ordinary changes return no warnings', t => {
  const store = new PolicyStore();
  const result = accepted(t, store.update({
    reflexes: { creeperEvade: { enabled: false }, autoEat: { food: 18 }, selfDefense: { stance: 'flee' } },
    combat: { retreatHealth: 10 }
  }, 'llm'), 'non-risky changes');
  t.deepEqual(result.warnings, []);
});

test('a rejected update that would switch attackPlayers on neither applies it nor warns', t => {
  const store = new PolicyStore();
  const result = store.update({ combat: { attackPlayers: true }, reflexes: { autoEat: { food: 21 } } }, 'llm');
  rejected(t, result, 'attackPlayers on with food 21');
  t.false('warnings' in result, 'a rejected update carries errors, not warnings');
  t.false(store.get().combat.attackPlayers);
  // The switch still counts as new once a valid update makes it.
  const later = accepted(t, store.update({ combat: { attackPlayers: true } }, 'llm'), 'attackPlayers on');
  t.is(later.warnings.length, 1);
});

// ---------------------------------------------------------------------------------------------------------------
// Empty and no-op updates

for (const [name, raw] of [['{}', {}], ['undefined', undefined], ['null', null]] as const) {
  test(`an empty update (${name}) is an error and changes nothing`, t => {
    const { store, before } = storeOffDefaults(t);
    rejected(t, store.update(raw, 'llm'), `the empty update ${name}`);
    t.deepEqual(store.get(), before);
  });
}

for (const [name, raw] of [["'attackPlayers=true'", 'attackPlayers=true'], ['42', 42], ['[]', []], ['true', true]] as const) {
  test(`a non-object update (${name}) is rejected and changes nothing`, t => {
    const { store, before } = storeOffDefaults(t);
    rejected(t, store.update(raw, 'llm'), `the update ${name}`);
    t.deepEqual(store.get(), before);
  });
}

// F-014 does not say whether a group with no fields is an error; either way it must change nothing and warn about
// nothing. (Since every update must set at least one field, these are now reported as errors.)
for (const [name, raw] of [['{ combat: {} }', { combat: {} }], ['{ reflexes: {} }', { reflexes: {} }],
  ['{ reflexes: { autoEat: {} } }', { reflexes: { autoEat: {} } }]] as const) {
  test(`an update naming a group but no field (${name}) changes nothing`, t => {
    const { store, before } = storeOffDefaults(t);
    const result = store.update(raw, 'llm');
    if (result.ok) {
      t.deepEqual(result.changed, []);
      t.deepEqual(result.warnings, []);
    }
    t.deepEqual(store.get(), before);
  });
}

test('an update with the current values reports no change', t => {
  const { store, before } = storeOffDefaults(t);
  const result = accepted(t, store.update({
    reflexes: { autoEat: { food: 10, enabled: true }, selfDefense: { stance: 'flee' } },
    combat: { retreatHealth: 8, attackPlayers: false, avoidNeutral: true }
  }, 'llm'), 'the same values again');
  t.deepEqual(result.changed, []);
  t.deepEqual(result.warnings, []);
  t.deepEqual(result.policy, before);
  t.deepEqual(store.get(), before);
});

test('only the fields that actually differ are reported as changed', t => {
  const { store } = storeOffDefaults(t);
  const result = accepted(t, store.update({
    reflexes: { autoEat: { food: 10, enabled: false } },
    combat: { retreatHealth: 8, avoidNeutral: true }
  }, 'llm'), 'one new value among current ones');
  t.deepEqual(result.changed, ['reflexes.autoEat.enabled']);
});

// ---------------------------------------------------------------------------------------------------------------
// Reset

test('reset() returns the defaults and get() shows them', t => {
  const store = new PolicyStore();
  accepted(t, store.update({
    reflexes: {
      creeperEvade: { enabled: false },
      lowHealthRetreat: { enabled: false, health: 12, radius: 30 },
      selfDefense: { enabled: false, stance: 'fight' },
      autoEat: { enabled: false, food: 2 }
    },
    instinct: { enabled: false, intent: 'diving on purpose', lowAir: 2, reaskMs: 9000, actThreshold: 0.9, urgentThreshold: 0.1, maxCallsPerMinute: 5 },
    combat: { attackPlayers: true, avoidNeutral: false, retreatHealth: 15 }
  }, 'llm'), 'every field changed');
  const reset = store.reset();
  t.deepEqual(reset, EXPECTED_DEFAULTS);
  t.deepEqual(store.get(), EXPECTED_DEFAULTS);
  t.deepEqual(store.get(), new PolicyStore().get(), 'after reset the store matches a freshly started one');
  t.true(Object.isFrozen(reset));
});

test('after reset, switching attackPlayers on warns again', t => {
  const store = new PolicyStore();
  accepted(t, store.update({ combat: { attackPlayers: true } }, 'llm'), 'attackPlayers on');
  store.reset();
  t.false(store.get().combat.attackPlayers);
  const result = accepted(t, store.update({ combat: { attackPlayers: true } }, 'llm'), 'attackPlayers on after reset');
  t.is(result.warnings.length, 1);
});

// ---------------------------------------------------------------------------------------------------------------
// Immutability of what readers get

function assertDeepFrozen(t: ExecutionContext, policy: Policy, label: string): void {
  t.true(Object.isFrozen(policy), `${label}: the policy object is frozen`);
  t.true(Object.isFrozen(policy.reflexes), `${label}: reflexes is frozen`);
  t.true(Object.isFrozen(policy.combat), `${label}: combat is frozen`);
  t.true(Object.isFrozen(policy.instinct), `${label}: instinct is frozen`);
  for (const [name, settings] of Object.entries(policy.reflexes)) {
    t.true(Object.isFrozen(settings), `${label}: reflexes.${name} is frozen`);
  }
}

test('get() returns a deeply frozen policy that cannot be changed by writing to it', t => {
  const store = new PolicyStore();
  const policy = store.get();
  assertDeepFrozen(t, policy, 'initial');
  t.throws(() => { (policy.combat as { attackPlayers: boolean }).attackPlayers = true; }, { instanceOf: TypeError });
  t.throws(() => { (policy.reflexes.autoEat as { food: number }).food = 1; }, { instanceOf: TypeError });
  t.throws(() => { (policy as { combat: unknown }).combat = { attackPlayers: true }; }, { instanceOf: TypeError });
  t.deepEqual(store.get(), EXPECTED_DEFAULTS, 'the failed writes left the policy unchanged');

  const result = accepted(t, store.update({ reflexes: { autoEat: { food: 9 } } }, 'llm'), 'food 9');
  assertDeepFrozen(t, result.policy, 'update result');
  assertDeepFrozen(t, store.get(), 'after update');
});

test('an earlier get() result is not mutated by a later update or reset', t => {
  const store = new PolicyStore();
  const first = store.get();
  accepted(t, store.update({ combat: { attackPlayers: true, retreatHealth: 3 }, reflexes: { autoEat: { enabled: false } } }, 'llm'),
    'a later update');
  t.deepEqual(first, EXPECTED_DEFAULTS, 'the earlier reader still sees one consistent (old) version');
  const second = store.get();
  t.not(second, first);
  t.true(second.combat.attackPlayers);
  t.is(second.combat.retreatHealth, 3);
  t.false(second.reflexes.autoEat.enabled);

  store.reset();
  t.true(second.combat.attackPlayers, 'reset must not rewrite a policy object a reader already holds');
  t.is(second.combat.retreatHealth, 3);
});

// ---------------------------------------------------------------------------------------------------------------
// Readable summary

test('describePolicy names every reflex and combat setting and reflects updated values', t => {
  const store = new PolicyStore();
  const defaults = describePolicy(store.get());
  for (const name of ['creeperEvade', 'lowHealthRetreat', 'selfDefense', 'autoEat',
    'attackPlayers', 'avoidNeutral', 'retreatHealth', 'Instinct', 'lowAir', 'urgentThreshold', 'intent']) {
    t.true(defaults.includes(name), `the summary should mention ${name}`);
  }
  accepted(t, store.update({ reflexes: { selfDefense: { stance: 'flee' }, autoEat: { food: 11 } } }, 'llm'), 'flee and food 11');
  const updated = describePolicy(store.get());
  t.not(updated, defaults);
  t.true(updated.includes('flee'));
  t.true(updated.includes('11'));
});

// ---------------------------------------------------------------------------------------------------------------
// Review fix 10: an update that sets no value at all is an error, and every update that sets attackPlayers to true
// warns, even when it is already on (F-014 "每次设为 true 都返回一条警告"; F-014 失败处理: errors leave the policy as it
// was). These are stricter than the either-way test above, which stays as it is.

const NO_VALUE_UPDATES: [string, unknown][] = [
  ['{ reflexes: {} }', { reflexes: {} }],
  ['{ reflexes: { autoEat: {} } }', { reflexes: { autoEat: {} } }],
  ['{ combat: {} }', { combat: {} }],
  ['{ reflexes: { autoEat: {}, creeperEvade: {} }, combat: {} }', { reflexes: { autoEat: {}, creeperEvade: {} }, combat: {} }],
  // A field given as undefined (possible from code, never over JSON) is not a value either.
  ['{ combat: { attackPlayers: undefined } }', { combat: { attackPlayers: undefined } }]
];

for (const [name, raw] of NO_VALUE_UPDATES) {
  for (const source of ['llm', 'startup'] as const) {
    test(`fix 10: an update that names groups but sets no value (${name}, from ${source}) is an error and changes nothing`, t => {
      const { store, before } = storeOffDefaults(t);
      const held = store.get();
      const result = store.update(raw, source);
      rejected(t, result, `the update ${name}`);
      t.false('warnings' in result, 'a rejected update carries errors, not warnings');
      t.is(store.get(), held, 'the stored policy object is not replaced');
      t.deepEqual(store.get(), before);
    });
  }
}

test('fix 10: after an update with no value is rejected, a real update still applies normally', t => {
  const { store, before } = storeOffDefaults(t);
  rejected(t, store.update({ reflexes: { autoEat: {} } }, 'llm'), '{ reflexes: { autoEat: {} } }');
  const result = accepted(t, store.update({ reflexes: { autoEat: { food: 12 } } }, 'llm'), 'food 12');
  t.deepEqual(result.changed, ['reflexes.autoEat.food']);
  t.deepEqual(store.get(), { ...before, reflexes: { ...before.reflexes, autoEat: { ...before.reflexes.autoEat, food: 12 } } });
});

test('fix 10: setting attackPlayers to true three times in a row warns three times; only the first is a change', t => {
  const store = new PolicyStore();
  const results = [1, 2, 3].map(n => accepted(t, store.update({ combat: { attackPlayers: true } }, 'llm'), `attackPlayers on #${n}`));
  t.deepEqual(results.map(result => result.warnings.length), [1, 1, 1], `warnings: ${JSON.stringify(results.map(r => r.warnings))}`);
  for (const result of results) t.regex(result.warnings[0] ?? '', /attackPlayers/);
  t.deepEqual(results[0].changed, ['combat.attackPlayers']);
  t.deepEqual(results[1].changed, []);
  t.deepEqual(results[2].changed, []);
  t.true(store.get().combat.attackPlayers);
});

test('fix 10: attackPlayers true sent again together with another change warns again; only the other field changes', t => {
  const store = new PolicyStore();
  accepted(t, store.update({ combat: { attackPlayers: true } }, 'llm'), 'attackPlayers on');
  const again = accepted(t, store.update({ combat: { attackPlayers: true, retreatHealth: 9 } }, 'llm'),
    'attackPlayers on again with retreatHealth 9');
  t.deepEqual(again.changed, ['combat.retreatHealth']);
  t.is(again.warnings.filter(warning => warning.includes('attackPlayers')).length, 1, `warnings: ${JSON.stringify(again.warnings)}`);
  t.is(store.get().combat.retreatHealth, 9);
});

test('fix 10: attackPlayers true from startup while it is already on warns again too', t => {
  const store = new PolicyStore();
  accepted(t, store.update({ combat: { attackPlayers: true } }, 'llm'), 'attackPlayers on from the LLM');
  const again = accepted(t, store.update({ combat: { attackPlayers: true } }, 'startup'), 'attackPlayers on again from startup');
  t.deepEqual(again.changed, []);
  t.is(again.warnings.length, 1);
  t.regex(again.warnings[0] ?? '', /attackPlayers/);
});

test('fix 10: attackPlayers false while it is already off neither changes nor warns', t => {
  const store = new PolicyStore();
  const result = accepted(t, store.update({ combat: { attackPlayers: false } }, 'llm'), 'attackPlayers off while off');
  t.deepEqual(result.changed, []);
  t.deepEqual(result.warnings, []);
});

// Found while writing the fix-10 tests (not one of the review fixes): a field given explicitly as undefined next to a
// real value passes validation and is copied into the policy, so the store then holds `attackPlayers: undefined`
// (no longer a valid policy) and reports `combat.attackPlayers` as changed. F-014 says a partial update changes only
// the fields it sets and the policy is always valid. It cannot happen over MCP (JSON has no undefined), only from
// code such as a startup update. policy.ts now drops undefined fields before validating.
test('a field given as undefined next to a real value is ignored or rejected; the policy stays valid', t => {
  const store = new PolicyStore();
  const result = store.update({ combat: { attackPlayers: undefined, retreatHealth: 8 } }, 'startup');
  if (result.ok) {
    t.deepEqual(result.changed, ['combat.retreatHealth'], 'only the field with a value changes');
    t.false(store.get().combat.attackPlayers, 'attackPlayers keeps its value (false)');
  } else {
    t.deepEqual(store.get(), EXPECTED_DEFAULTS);
  }
  t.true(policySchema.safeParse(store.get()).success, `the stored policy must stay valid: ${JSON.stringify(store.get())}`);
});

// ---- M4: chat and decisions groups (F-014) ----------------------------------------------------------------------

test('M4: nobody may send chat commands by default, and only the LLM can authorize someone', t => {
  const store = new PolicyStore();
  t.deepEqual(store.get().chat.commandsFrom, []);

  const startup = store.update({ chat: { commandsFrom: ['Steve'] } }, 'startup');
  t.false(startup.ok, 'startup settings cannot authorize players');
  t.deepEqual(store.get().chat.commandsFrom, []);

  const llm = accepted(t, store.update({ chat: { commandsFrom: ['Steve', 'Alex_2'] } }, 'llm'), 'authorize');
  t.deepEqual(store.get().chat.commandsFrom, ['Steve', 'Alex_2']);
  t.deepEqual(llm.changed, ['chat.commandsFrom']);
  t.is(llm.warnings.length, 1, 'every change of the list returns a notice');
  t.regex(llm.warnings[0], /notice: chat commands are now accepted from Steve, Alex_2/);

  const revoked = accepted(t, store.update({ chat: { commandsFrom: [] } }, 'llm'), 'revoke');
  t.regex(revoked.warnings[0], /accepted from nobody \(removed Steve, Alex_2\)/);
});

test('M4: commandsFrom only takes valid Minecraft usernames', t => {
  const store = new PolicyStore();
  for (const name of ['ab', 'a'.repeat(17), 'Steve!', 'two words', '']) {
    t.false(store.update({ chat: { commandsFrom: [name] } }, 'llm').ok, `"${name}" is rejected`);
  }
  t.deepEqual(store.get().chat.commandsFrom, []);
});

test('M4: the cautious threshold cannot be above the act threshold, and probabilities stay within 0-1', t => {
  const store = new PolicyStore();
  t.false(store.update({ decisions: { cautiousThreshold: 0.97 } }, 'llm').ok, 'cautious 0.97 above act 0.95');
  t.false(store.update({ decisions: { actThreshold: 1.2 } }, 'llm').ok);
  t.false(store.update({ decisions: { maxCallsPerMinute: 0 } }, 'llm').ok);
  t.true(store.update({ decisions: { actThreshold: 0.95, cautiousThreshold: 0.9 } }, 'llm').ok);
});

test('M4: reset keeps the startup decision model and clears the authorized players', t => {
  const store = new PolicyStore({ decisionModel: 'vendor/model-2026-09-01' });
  t.is(store.get().decisions.model, 'vendor/model-2026-09-01');
  t.true(store.update({ chat: { commandsFrom: ['Steve'] }, decisions: { model: 'other/model' } }, 'llm').ok);

  store.reset();
  t.is(store.get().decisions.model, 'vendor/model-2026-09-01');
  t.deepEqual(store.get().chat.commandsFrom, []);
  t.is(new PolicyStore().get().decisions.model, DEFAULT_DECISION_MODEL);
});

test('M4: describePolicy shows the chat and decision settings', t => {
  const store = new PolicyStore();
  t.true(store.update({ chat: { commandsFrom: ['Steve'] } }, 'llm').ok);
  const text = describePolicy(store.get());
  t.regex(text, /commandsFrom: Steve/);
  t.regex(text, /actThreshold: 0\.95, cautiousThreshold: 0\.5, combatThreshold: 0\.6/);
});

// ---- M8: the instinct group (E-011, F-014) ------------------------------------------------------------------------

test('M8: the instinct defaults: on, no intent, lowAir 6, re-ask every 1500 ms, thresholds 0.4 and 0.6, 90 calls a minute', t => {
  t.deepEqual(new PolicyStore().get().instinct, {
    enabled: true, intent: '', lowAir: 6, reaskMs: 1500, actThreshold: 0.4, urgentThreshold: 0.6, maxCallsPerMinute: 90
  });
});

test('M8: a partial instinct update changes only the given field', t => {
  const { store, before } = storeOffDefaults(t);
  const result = accepted(t, store.update({ instinct: { reaskMs: 3000 } }, 'llm'), 'reaskMs 3000');
  t.deepEqual(result.changed, ['instinct.reaskMs']);
  t.deepEqual(store.get(), { ...before, instinct: { ...before.instinct, reaskMs: 3000 } });
  accepted(t, store.update({ instinct: { enabled: false } }, 'llm'), 'instinct off');
  t.deepEqual(store.get().instinct, { ...EXPECTED_DEFAULTS.instinct, reaskMs: 3000, enabled: false });
});

test('M8: instinct bounds are inclusive: reaskMs 500 and 10000, maxCallsPerMinute 1 and 600, thresholds 0 and 1, intent 300 characters', t => {
  const store = new PolicyStore();
  accepted(t, store.update({ instinct: { reaskMs: 500, maxCallsPerMinute: 1, actThreshold: 0, urgentThreshold: 0, intent: '' } }, 'llm'), 'the lower bounds');
  t.deepEqual(store.get().instinct, { ...EXPECTED_DEFAULTS.instinct, reaskMs: 500, maxCallsPerMinute: 1, actThreshold: 0, urgentThreshold: 0 });
  const intent = 'y'.repeat(300);
  accepted(t, store.update({ instinct: { reaskMs: 10000, maxCallsPerMinute: 600, actThreshold: 1, urgentThreshold: 1, intent } }, 'llm'), 'the upper bounds');
  t.deepEqual(store.get().instinct, { ...EXPECTED_DEFAULTS.instinct, reaskMs: 10000, maxCallsPerMinute: 600, actThreshold: 1, urgentThreshold: 1, intent });
});

test('M8: instinct.intent can be set by the LLM, and is refused from startup with nothing changed', t => {
  const store = new PolicyStore();
  const llm = accepted(t, store.update({ instinct: { intent: 'diving to the ocean monument on purpose' } }, 'llm'), 'intent from the LLM');
  t.deepEqual(llm.changed, ['instinct.intent']);
  t.is(store.get().instinct.intent, 'diving to the ocean monument on purpose');

  const before = snapshot(store.get());
  const errors = rejected(t, store.update({ instinct: { intent: 'set at startup', lowAir: 3 } }, 'startup'), 'intent from startup');
  t.deepEqual(errors, ['instinct.intent can only be set by the LLM (set-policy)']);
  t.deepEqual(store.get(), before, 'neither the intent nor the other field in that update is applied');

  // Other instinct fields may still come from startup.
  accepted(t, store.update({ instinct: { lowAir: 3 } }, 'startup'), 'lowAir from startup');
  t.is(store.get().instinct.lowAir, 3);
});

test('M8: an unknown field under instinct is rejected and nothing changes', t => {
  const { store, before } = storeOffDefaults(t);
  const errors = rejected(t, store.update({ instinct: { lowair: 3, enabled: false } }, 'llm'), 'instinct.lowair');
  t.true(errors.some(error => error.includes('lowair')), errors.join(' | '));
  t.deepEqual(store.get(), before);
});

test('M8: reflexes.hazardEscape no longer exists and is rejected as an unknown field', t => {
  const { store, before } = storeOffDefaults(t);
  const errors = rejected(t, store.update({ reflexes: { hazardEscape: { enabled: false } } }, 'llm'), 'reflexes.hazardEscape');
  t.true(errors.some(error => error.includes('hazardEscape')), errors.join(' | '));
  t.deepEqual(store.get(), before);
});

test('M8: reset restores the instinct defaults, including an empty intent', t => {
  const store = new PolicyStore();
  accepted(t, store.update({ instinct: { enabled: false, intent: 'testing in lava', lowAir: 12, actThreshold: 0.9 } }, 'llm'), 'instinct changes');
  store.reset();
  t.deepEqual(store.get().instinct, EXPECTED_DEFAULTS.instinct);
});

test('M8: the empty-update error names every group, the instinct included', t => {
  const errors = rejected(t, new PolicyStore().update({ instinct: {} }, 'llm'), '{ instinct: {} }');
  t.deepEqual(errors, ['no policy fields given; groups are reflexes, instinct, combat, chat and decisions (see get-policy)']);
});

test('M8: describePolicy shows the instinct settings and the intent', t => {
  const store = new PolicyStore();
  const defaults = describePolicy(store.get());
  // The wording is tentative (F-018); only the facts are checked.
  const lineWith = (text: string, word: string) => text.split('\n').find(line => line.includes(word)) ?? '';
  t.regex(defaults, /Instinct/);
  t.regex(lineWith(defaults, 'lowAir'), /\bon\b/);
  t.regex(lineWith(defaults, 'lowAir'), /lowAir\D*6\b/);
  t.regex(lineWith(defaults, 'actThreshold'), /actThreshold\D*0\.4\b/);
  t.regex(lineWith(defaults, 'urgentThreshold'), /urgentThreshold\D*0\.6\b/);
  t.false(defaults.includes('swimming under the lake for clay'));
  accepted(t, store.update({ instinct: { intent: 'swimming under the lake for clay', enabled: false } }, 'llm'), 'intent and off');
  const updated = describePolicy(store.get());
  t.true(lineWith(updated, 'intent').includes('swimming under the lake for clay'), updated);
  t.regex(lineWith(updated, 'lowAir'), /\boff\b/);
});
