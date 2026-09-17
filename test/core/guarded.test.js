//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createGuardedRefiner } from '@jarenjs/core/guarded';

it('awaits async verdicts and plans without changing synchronous prepare', async () => {
  const original = { value: 1 }, proposal = { value: 2 }, writes = [];
  const engine = createGuardedRefiner({ read: async () => original,
    validateProposal: () => true, apply: (_previous, edit) => edit,
    validateCandidate: async (next, previous) => { next.value = 99; previous.value = 99; return true; },
    planCommit: async next => ({ plan: next }), commit: async plan => { writes.push(plan); return plan; },
  });
  const sync = engine.prepare(original, proposal);
  assert.equal(sync.valid, false);
  assert.match(sync.errors[0].message, /prepareAsync/);
  assert.equal(sync.then, undefined);
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
    assert.deepEqual((await engine.commit({})).errors, ['denied']);
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
