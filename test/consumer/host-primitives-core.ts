import { pairedBootstrap, permutationTest } from '@jarenjs/core/stats';
import { reciprocalRankFusion, weightedScoreFusion } from '@jarenjs/core/search';
import { adx, cci, vwap, obv, volumeRatio, kdj, williamsR, annualizedReturn, sortino, calmar, beta } from '@jarenjs/core/finance';
import { compileTextEdits, applyTextEdits, type TextFile } from '@jarenjs/core/text/edits';
import { createProcessExecutor, type ProcessOutcome } from '@jarenjs/core/process-node';
import { createGuardedRefiner } from '@jarenjs/core/guarded';
const pairs = [[1, 2], [2, 3]] as const;
const lower: number = pairedBootstrap(pairs, { seed: 1, resamples: 10 }).lower;
const pValue: number = permutationTest(pairs, { seed: 1, resamples: 10 }).pValue;
const rank: number = reciprocalRankFusion([[{ id: 'a', rank: 1 }]])[0].contributions[0].rank;
weightedScoreFusion([[{ id: 'a', score: 1 }]], { weights: [1], normalize: 'none' });
const a = Float64Array.of(1, 2, 3);
void [adx(a, a, a), cci(a, a, a), vwap(a, a, a, a), obv(a, a), volumeRatio(a), kdj(a, a, a), williamsR(a, a, a),
  annualizedReturn(a, 12), sortino(a), calmar(a, 12), beta(a, a), lower, pValue, rank];
const compiled = compileTextEdits([], [{ op: 'create_file', path: 'test.js', replacement: 'export const x=1;\n' }]);
const files: TextFile[] = applyTextEdits([], compiled.hunks).files;
const executor = createProcessExecutor({ cwd: '.', allow: { version: { argv0: '/usr/bin/node', args: [/--version/] } } });
const outcome: ProcessOutcome = await executor.run({ name: 'version', args: ['--version'] });
const settlement: 'closed'|'unresolved'|'not-started' = outcome.settlement;
await executor.close();
const refiner = createGuardedRefiner({ read: async () => ({}), validateProposal: () => true,
  apply: value => value, validateCandidate: async () => true, planCommit: async value => value, commit: async value => value });
await refiner.prepareAsync({}, {}); void [files, settlement];
// @ts-expect-error no arbitrary kill signals
createProcessExecutor({ cwd: '.', allow: {}, killSignal: 'SIGUSR1' });
// @ts-expect-error exact numeric paired observations
pairedBootstrap([['a', 2]], { seed: 1, resamples: 10 });
