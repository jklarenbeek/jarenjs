import assert from 'node:assert/strict';
import { pairedBootstrap, permutationTest } from '@jarenjs/core/stats';
import { adx } from '@jarenjs/core/finance';
import { reciprocalRankFusion, weightedScoreFusion } from '@jarenjs/core/search';
import { compileTextEdits, applyTextEdits } from '@jarenjs/core/text/edits';
import { createGuardedRefiner } from '@jarenjs/core/guarded';
import { createProcessExecutor } from '@jarenjs/core/process-node';
assert.equal(pairedBootstrap([[1, 3], [2, 4]], { resamples: 100, seed: 1 }).lower, 2);
assert.equal(permutationTest([[1, 1]], { resamples: 10, seed: 1 }).pValue, 1);
assert.deepEqual(adx([1, 2, 3, 4], [1, 2, 3, 4], [1, 2, 3, 4], 2).adx, [null, null, null, 100]);
assert.equal(reciprocalRankFusion([[{ id: 'a', rank: 1 }]])[0].id, 'a');
assert.equal(weightedScoreFusion([[{ id: 'a', score: 2 }]], { weights: [2], normalize: 'none' })[0].score, 4);
const edits = compileTextEdits([], [{ op: 'create_file', path: 'note.md', replacement: 'created\n' }]);
assert.equal(applyTextEdits([], edits.hunks).files[0].text, 'created\n');
const refiner = createGuardedRefiner({ read: async () => ({}), validateProposal: () => true, apply: value => value,
  validateCandidate: async () => false, planCommit: value => value, commit: async () => { throw Error('must not commit'); } });
assert.equal((await refiner.commit({})).ok, false);
const executor = createProcessExecutor({ cwd: process.cwd(), tree: 'child',
  allow: { version: { argv0: process.execPath, args: [/--version/] } } });
try {
  const result = await executor.run({ name: 'version', args: ['--version'] });
  assert.equal(result.exitCode, 0); assert.equal(result.settlement, 'closed'); assert.ok(result.stdout.trim());
} finally { await executor.close(); }
