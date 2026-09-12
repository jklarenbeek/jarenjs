//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createGuardedRefiner } from '@jarenjs/core/guarded';

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
