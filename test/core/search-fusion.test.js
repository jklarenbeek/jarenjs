//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { reciprocalRankFusion, weightedScoreFusion } from '@jarenjs/core/search';

it('fuses explicit ranks with exact lane provenance and stable ID ties', () => {
  const lists = [[{ id: 'a', rank: 1 }, { id: 'b', rank: 2 }], [{ id: 'b', rank: 1 }, { id: 'c', rank: 2 }]];
  const before = structuredClone(lists), result = reciprocalRankFusion(lists);
  assert.deepEqual(result.map(row => row.id), ['b', 'a', 'c']);
  assert.equal(result[0].score, 1 / 62 + 1 / 61);
  assert.deepEqual(result[0].contributions, [{ list: 0, rank: 2 }, { list: 1, rank: 1 }]);
  assert.deepEqual(lists, before);
  const tie = reciprocalRankFusion([[{ id: 'z', rank: 1 }, { id: 'a', rank: 1 }]]);
  assert.deepEqual(tie.map(row => row.id), ['a', 'z']);
  assert.deepEqual(reciprocalRankFusion([]), []);
});

it('defines minmax, population zscore, missing IDs and constant lanes', () => {
  const lists = [[{ id: 'a', score: 10 }, { id: 'b', score: 20 }], [{ id: 'a', score: 2 }, { id: 'c', score: 2 }]];
  const minmax = weightedScoreFusion(lists, { weights: [2, 3], normalize: 'minmax' });
  assert.deepEqual(minmax.map(row => [row.id, row.score]), [['b', 2], ['a', 0], ['c', 0]]);
  const zscore = weightedScoreFusion(lists, { weights: [2, 3], normalize: 'zscore' });
  assert.deepEqual(zscore.map(row => [row.id, row.score]), [['b', 2], ['c', 0], ['a', -2]]);
  const raw = weightedScoreFusion(lists, { weights: [2, 3], normalize: 'none' });
  assert.deepEqual(raw.map(row => [row.id, row.score]), [['b', 40], ['a', 26], ['c', 6]]);
  assert.deepEqual(raw[1].contributions[1], { list: 1, rank: 1, score: 2, normalized: 2, weight: 3 });
  assert.deepEqual(weightedScoreFusion([[]], { weights: [1], normalize: 'minmax' }), []);
});

it('refuses duplicate votes, invalid values, normalization and resource overflow', () => {
  assert.throws(() => reciprocalRankFusion([[{ id: 'a', rank: 1 }, { id: 'a', rank: 2 }]]));
  for (const rank of [0, 0.1, Infinity]) assert.throws(() => reciprocalRankFusion([[{ id: 'a', rank }]]));
  assert.throws(() => reciprocalRankFusion([], { k: 0 }));
  assert.throws(() => reciprocalRankFusion([[{ id: '', rank: 1 }]]));
  assert.throws(() => reciprocalRankFusion([[{ id: 'a', rank: 1 }, { id: 'b', rank: 2 }]], { maxItems: 1 }));
  assert.throws(() => weightedScoreFusion([[]], { weights: [], normalize: 'none' }));
  assert.throws(() => weightedScoreFusion([], { weights: [], normalize: 'bad' }));
  assert.throws(() => weightedScoreFusion([[{ id: 'a', score: NaN }]], { weights: [1], normalize: 'none' }));
  assert.throws(() => weightedScoreFusion([[{ id: 'a', score: 1e308 }]], { weights: [2], normalize: 'none' }));
  assert.throws(() => weightedScoreFusion([[{ id: 'a', score: -1e308 }, { id: 'b', score: 1e308 }]], { weights: [1], normalize: 'minmax' }));
});
