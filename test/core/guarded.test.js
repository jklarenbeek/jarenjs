//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createGuardedRefiner } from '@jarenjs/core/guarded';
import { checkCompile, CHECK_CODES } from '@jarenjs/core/check';
import { CodedError } from '@jarenjs/core/errors';

it('awaits async verdicts and plans without changing synchronous prepare', async () => {
  const original = { value: 1 }, proposal = { value: 2 }, writes = [];
  const engine = createGuardedRefiner({ read: async () => original,
    validateProposal: () => true, apply: (_previous, edit) => edit,
    validateCandidate: async (next, previous) => { next.value = 99; previous.value = 99; return true; },
    planCommit: async next => ({ plan: next }), commit: async plan => { writes.push(plan); return plan; },
  });
  assert.throws(() => engine.prepare(original, proposal), { name: 'GuardedRefinerError', code: 'JG0002' });
  assert.deepEqual((await engine.prepareAsync(original, proposal)).plan, { value: 2 });
  assert.equal((await engine.commit(proposal)).ok, true);
  assert.deepEqual(writes, [{ value: 2 }]);
  assert.deepEqual(original, { value: 1 }); assert.deepEqual(proposal, { value: 2 });
});

it('never commits rejected async checks/plans and recovers the serialized queue', async () => {
  for (const hook of ['validateProposal', 'apply', 'validateCandidate', 'planCommit']) {
    let fail = true, writes = 0;
    const hooks = { validateProposal: () => true, apply: doc => doc,
      validateCandidate: () => true, planCommit: doc => doc };
    const normal = hooks[hook];
    hooks[hook] = async (...args) => { if (fail) throw new Error('rejected'); return normal(...args); };
    const engine = createGuardedRefiner({ read: async () => ({ value: 1 }), ...hooks,
      commit: async plan => { writes++; return plan; } });
    const bad = await engine.commit({});
    assert.equal(bad.ok, false); assert.equal(writes, 0);
    fail = false;
    assert.equal((await engine.commit({})).ok, true); assert.equal(writes, 1);
  }
  for (const hook of ['validateCandidate', 'planCommit']) {
    const engine = createGuardedRefiner({ read: async () => ({}), validateProposal: () => true,
      apply: doc => doc, validateCandidate: () => true, planCommit: doc => doc,
      [hook]: async () => ({ valid: false, errors: ['denied'] }),
      commit: async () => assert.fail('invalid candidate committed') });
    // the text the check gave survives, as an error object a repair loop reads
    assert.deepEqual((await engine.commit({})).errors, [{ code: 'JG2001', docPath: '', message: 'denied' }]);
  }
});

it('captures a prepared plan before an asynchronous snapshot suspends', async () => {
  let resume;
  const engine = createGuardedRefiner({ read: async () => ({}), validateProposal: () => true,
    apply: doc => doc, validateCandidate: () => true, planCommit: doc => doc,
    snapshot: () => new Promise(resolve => { resume = resolve; }), restore: async () => {}, commit: async plan => plan });
  const prepared = { valid: true, plan: { value: 1 }, next: { value: 1 } };
  const result = engine.commitPrepared({}, prepared);
  prepared.plan.value = 99; resume(null);
  assert.deepEqual((await result).value, { value: 1 });
});

it('guards a non-ledger document and restores exactly once, keeping both failures', async () => {
  const original = { left: { count: 1 }, right: { count: 2 } };
  let restores = 0, writes = 0;
  const primary = new Error('commit failed'), secondary = new Error('restore failed');
  const engine = createGuardedRefiner({ read: async () => original, validateProposal: () => true,
    apply: (value, proposal) => { value.left.count = proposal; return value; },
    validateCandidate: (value) => value.left.count > 0, planCommit: (value) => value,
    snapshot: async () => 'token', restore: async () => { restores++; throw secondary; },
    commit: async () => { writes++; throw primary; },
  });
  assert.equal((await engine.commit(-1)).stage, 'validation');
  assert.equal(writes, 0);
  const result = await engine.commit(9);
  assert.equal(result.cause, primary);
  assert.equal(result.restoreError, secondary);
  assert.equal(restores, 1);
  assert.deepEqual(original, { left: { count: 1 }, right: { count: 2 } });
});

it('serializes accepted writes and captures the caller proposal before queuing', async () => {
  let document = { count: 0 }; const writes = [];
  const engine = createGuardedRefiner({ read: async () => document, validateProposal: () => true,
    apply: (previous, proposal) => ({ count: previous.count + proposal.increment }),
    validateCandidate: () => true, planCommit: value => value,
    commit: async next => { await Promise.resolve(); document = next; writes.push(next.count); return next; },
  });
  const proposal = { increment: 1 }; const first = engine.commit(proposal); proposal.increment = 90;
  const second = engine.commit({ increment: 2 });
  assert.deepEqual((await first).value, { count: 1 });
  assert.deepEqual((await second).value, { count: 3 });
  assert.deepEqual(writes, [1, 3]);
});

it('a refused plan names its errors as the shape and candidate stages do', async () => {
  const unnamed = { code: 'JG2001', docPath: '', message: 'the value was rejected by a check that named no error' };
  /** @param {Record<string, (...args: any[]) => any>} hooks */
  const engine = (hooks) => {
    const writes = [];
    const refiner = createGuardedRefiner({ read: () => ({ n: 1 }), validateProposal: () => true, apply: (doc) => doc,
      validateCandidate: () => true, planCommit: (doc) => doc, commit: (plan) => { writes.push(plan); return plan; },
      ...hooks });
    return { refiner, writes };
  };
  for (const refusal of [{ valid: false }, { valid: false, errors: [] }, { valid: false, errors: null }, { valid: false, errors: 'no' }]) {
    const label = JSON.stringify(refusal);
    const { refiner, writes } = engine({ planCommit: () => refusal });
    assert.deepEqual(refiner.prepare({ n: 1 }, {}), { valid: false, errors: [unnamed] }, label);
    assert.deepEqual(await refiner.prepareAsync({ n: 1 }, {}), { valid: false, errors: [unnamed] }, label);
    assert.deepEqual(await refiner.commit({}), { ok: false, stage: 'validation', errors: [unnamed] }, label);
    assert.deepEqual(writes, [], label);
    // the same answer from the shape and candidate checks reads alike
    for (const hook of ['validateProposal', 'validateCandidate'])
      assert.deepEqual(engine({ [hook]: () => refusal }).refiner.prepare({ n: 1 }, {}), { valid: false, errors: [unnamed] }, `${hook} ${label}`);
  }
  // a plan's own errors pass on as they are, as one list when it names one error outside a list
  const errors = [{ code: 'PLAN', docPath: '/n', message: 'no room' }];
  assert.equal(engine({ planCommit: () => ({ valid: false, errors }) }).refiner.prepare({ n: 1 }, {}).errors, errors);
  assert.deepEqual(await engine({ planCommit: async () => ({ valid: false, errors: errors[0] }) }).refiner.prepareAsync({ n: 1 }, {}),
    { valid: false, errors });
  // a plan that is not a refusal still commits, whatever it is
  for (const plan of [false, {}, 0, null, { valid: true }, { valid: 'no' }]) {
    const { refiner, writes } = engine({ planCommit: () => plan });
    const prepared = refiner.prepare({ n: 1 }, {});
    assert.equal(prepared.valid, true, JSON.stringify(plan));
    assert.equal((await refiner.commit({})).ok, true, JSON.stringify(plan));
    assert.deepEqual(writes, [plan], JSON.stringify(plan));
  }
});

it('a synchronous preparation over an asynchronous hook throws the registered JG0002', async () => {
  const unhandled = [], onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const hooks = { validateProposal: 'shape', apply: 'apply', validateCandidate: 'candidate', planCommit: 'plan' };
    for (const [hook, stage] of Object.entries(hooks)) {
      const ran = [], applied = [];
      const sync = {
        validateProposal: () => { ran.push('validateProposal'); return true; },
        apply: (document, proposal) => { ran.push('apply'); return { ...document, ...proposal }; },
        validateCandidate: () => { ran.push('validateCandidate'); return true; },
        planCommit: next => { ran.push('planCommit'); return { plan: next }; },
      };
      const engine = createGuardedRefiner({ read: () => ({ n: 1 }), ...sync,
        [hook]: () => { ran.push(hook); return Promise.reject(new Error('settled later')); },
        applyFailure: error => { applied.push(error); return { code: 'APPLY', docPath: '', message: 'apply failed' }; },
        commit: () => assert.fail('a refused preparation committed') });
      assert.throws(() => engine.prepare({ n: 1 }, { m: 2 }), error => {
        assert.equal(error.name, 'GuardedRefinerError');
        assert.equal(error.code, 'JG0002');
        assert.equal(error.reason, `the ${hook} hook answered a promise, which the synchronous prepare cannot await \u2014 `
          + 'call prepareAsync or commit, or answer synchronously');
        assert.equal(error.docPath, undefined);
        return true;
      }, stage);
      assert.deepEqual(ran, Object.keys(hooks).slice(0, Object.keys(hooks).indexOf(hook) + 1), `${stage}: later hooks never run`);
      assert.deepEqual(applied, [], `${stage}: applyFailure never reads the refusal`);
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, [], 'the refused promise is settled, never left unhandled');
  }
  finally { process.off('unhandledRejection', onUnhandled); }
});

it('a hook that throws a JG0002 of its own is reported, not rethrown', () => {
  const own = Object.assign(new Error('JG0002: own'), { code: 'JG0002' });
  const engine = createGuardedRefiner({ read: () => ({}), validateProposal: () => true, apply: d => d,
    validateCandidate: () => { throw own; }, planCommit: n => n, commit: () => null });
  assert.deepEqual(engine.prepare({}, {}), { valid: false, errors: [
    { code: 'JG0002', docPath: '', message: 'JG0002: own', stage: 'candidate' }] });
});

it('a hook that throws undefined is reported under JG2002', () => {
  const engine = createGuardedRefiner({ read: () => ({}), validateProposal: () => true, apply: d => d,
    validateCandidate: () => { throw undefined; }, planCommit: n => n, commit: () => null });
  assert.deepEqual(engine.prepare({}, {}), { valid: false, errors: [
    { code: 'JG2002', docPath: '', message: 'undefined', stage: 'candidate' }] });
});

it('a synchronous preparation over synchronous hooks answers as before', () => {
  const make = over => createGuardedRefiner({ read: () => ({ n: 1 }), validateProposal: () => true,
    apply: (document, proposal) => ({ ...document, ...proposal }), validateCandidate: () => true,
    planCommit: next => ({ plan: next }), commit: () => null, ...over });
  assert.deepEqual(make({}).prepare({ n: 1 }, { m: 2 }),
    { valid: true, errors: [], next: { n: 1, m: 2 }, plan: { n: 1, m: 2 } });
  assert.deepEqual(make({ validateProposal: () => false }).prepare({ n: 1 }, { m: 2 }),
    { valid: false, errors: [{ code: 'JG2001', docPath: '', message: 'the value was rejected by a check that named no error' }] });
  assert.deepEqual(make({ apply: () => { throw new TypeError('bad edit'); } }).prepare({ n: 1 }, { m: 2 }),
    { valid: false, errors: [{ code: 'JG2002', docPath: '', message: 'bad edit', stage: 'apply' }] });
  assert.deepEqual(make({ apply: () => { throw new TypeError('bad edit'); }, applyFailure: error => ({ code: 'APPLY', message: error.message }) })
    .prepare({ n: 1 }, { m: 2 }), { valid: false, errors: [{ code: 'APPLY', message: 'bad edit' }] });
  assert.deepEqual(make({ planCommit: () => ({ valid: false, errors: [{ code: 'P1', docPath: '/n', message: 'no' }] }) })
    .prepare({ n: 1 }, { m: 2 }), { valid: false, errors: [{ code: 'P1', docPath: '/n', message: 'no' }] });
});

// The values a hook, snapshot, commit or restore may throw, and the record
// each is reported as: the reading `checkCompile` gives a throw, under the
// registered `JG2002` when the value carries no code that is text.
const THROWN = [
  ['a TypeError', () => new TypeError('bad edit'), { code: 'JG2002', docPath: '', message: 'bad edit' }],
  ['a numeric code and docPath', () => Object.assign(new Error('n'), { code: 42, docPath: 7 }),
    { code: 'JG2002', docPath: '', message: 'n' }],
  ['an empty code', () => Object.assign(new Error('e'), { code: '', docPath: '/x' }), { code: 'JG2002', docPath: '/x', message: 'e' }],
  ['a CodedError', () => new CodedError('JsonQueryError', 'JQ0002', "unknown operator '$bogus'", '/a'),
    { code: 'JQ0002', docPath: '/a', message: "unknown operator '$bogus'" }],
  ['a CodedError with no location', () => new CodedError('JsonQueryError', 'JQ0003', 'no location'),
    { code: 'JQ0003', docPath: '', message: 'no location' }],
  ['a text', () => 'plain', { code: 'JG2002', docPath: '', message: 'plain' }],
  ['null', () => null, { code: 'JG2002', docPath: '', message: 'null' }],
  ['undefined', () => undefined, { code: 'JG2002', docPath: '', message: 'undefined' }],
];

it('a throw from a hook is read as checkCompile reads it, under the registered JG2002', () => {
  assert.ok('JG2002' in CHECK_CODES);
  const read = checkCompile((thrown) => { throw thrown; }, { fallbackCode: 'JG2002' });
  for (const [name, make, expected] of THROWN) {
    assert.deepEqual(read(make()).errors[0], expected, name);
    for (const [stage, hook] of [['shape', 'validateProposal'], ['apply', 'apply'], ['candidate', 'validateCandidate'], ['plan', 'planCommit']]) {
      const engine = createGuardedRefiner({ read: () => ({}), validateProposal: () => true, apply: d => d,
        validateCandidate: () => true, planCommit: n => n, commit: () => null, [hook]: () => { throw make(); } });
      assert.deepEqual(engine.prepare({}, {}), { valid: false, errors: [{ ...expected, stage }] }, `${name} from ${hook}`);
    }
  }
});

it('a throw from snapshot, commit or restore is read the same way', async () => {
  const base = { read: () => ({ n: 1 }), validateProposal: () => true, apply: d => d, validateCandidate: () => true,
    planCommit: n => n };
  for (const [name, make, expected] of THROWN) {
    const snapshot = await createGuardedRefiner({ ...base, commit: () => null, snapshot: () => { throw make(); }, restore: () => null })
      .commit({});
    assert.deepEqual(snapshot.errors, [{ ...expected, stage: 'snapshot' }], `${name} from snapshot`);
    const committed = await createGuardedRefiner({ ...base, commit: () => { throw make(); } }).commit({});
    assert.deepEqual(committed.errors, [{ ...expected, stage: 'commit' }], `${name} from commit`);
    // a restore that throws undefined is indistinguishable from one that
    // succeeded (`restoreError` is the thrown value), so it is not read here
    if (name === 'undefined')
      continue;
    const restored = await createGuardedRefiner({ ...base, commit: () => { throw new TypeError('disk'); },
      snapshot: () => 't', restore: () => { throw make(); } }).commit({});
    assert.deepEqual(restored.errors, [{ code: 'JG2002', docPath: '', message: 'disk', stage: 'commit' },
      { ...expected, stage: 'restore' }], `${name} from restore`);
  }
});
