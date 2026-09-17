//@ts-check
import { compareCodePoints } from '../string.js';

/** Validate each lane once; duplicate IDs would otherwise cast extra votes. */
function lanes(lists, maxItems, field) {
  if (!Array.isArray(lists) || lists.length > 1000 || !Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 1000000)
    throw new RangeError('fusion needs at most 1000 lists and a finite item budget');
  let count = 0;
  for (const list of lists) {
    if (!Array.isArray(list) || (count += list.length) > maxItems) throw new RangeError('fusion item budget exceeded');
    const seen = new Set();
    for (const row of list) {
      if (!row || typeof row.id !== 'string' || !row.id || row.id.length > 4096 || seen.has(row.id))
        throw new TypeError('fusion IDs must be nonempty and unique within each list');
      if (field === 'rank' ? !Number.isSafeInteger(row.rank) || row.rank < 1 : !Number.isFinite(row.score))
        throw new TypeError(`fusion ${field} is invalid`);
      seen.add(row.id);
    }
  }
}

function collect(rows, id, score, contribution) {
  const row = rows.get(id) ?? { id, score: 0, contributions: [] };
  row.score += score;
  if (!Number.isFinite(row.score)) throw new RangeError('fusion score overflow');
  row.contributions.push(contribution); rows.set(id, row);
}

const ordered = rows => [...rows.values()].sort((a, b) => b.score - a.score || compareCodePoints(a.id, b.id));

/**
 * Reciprocal-rank fusion over explicit one-based ranks; ties sort by code point ID.
 * @param {readonly (readonly { id: string, rank: number }[])[]} lists
 * @param {{ k?: number, maxItems?: number }} [options]
 * @returns {{ id: string, score: number, contributions: { list: number, rank: number }[] }[]}
 */
export function reciprocalRankFusion(lists, { k = 60, maxItems = 100000 } = {}) {
  lanes(lists, maxItems, 'rank');
  if (!Number.isFinite(k) || k <= 0) throw new RangeError('fusion k must be positive and finite');
  const rows = new Map();
  lists.forEach((list, index) => list.forEach(row => collect(rows, row.id, 1 / (k + row.rank), { list: index, rank: row.rank })));
  return ordered(rows);
}

/**
 * Weighted score fusion; normalize each present lane independently. Missing IDs
 * and constant normalized lanes contribute zero. Weights need not sum to one.
 * @param {readonly (readonly { id: string, score: number }[])[]} lists
 * @param {{ weights: readonly number[], normalize: 'minmax' | 'zscore' | 'none', maxItems?: number }} options
 * @returns {{ id: string, score: number, contributions: { list: number, rank: number, score: number, normalized: number, weight: number }[] }[]}
 */
export function weightedScoreFusion(lists, { weights, normalize, maxItems = 100000 }) {
  lanes(lists, maxItems, 'score');
  if (!Array.isArray(weights) || weights.length !== lists.length || weights.some(weight => !Number.isFinite(weight) || weight < 0)
    || !['minmax', 'zscore', 'none'].includes(normalize)) throw new TypeError('fusion needs aligned nonnegative weights and a normalization');
  const rows = new Map();
  lists.forEach((list, index) => {
    let lo = Infinity, hi = -Infinity, mean = 0, variance = 0;
    for (const row of list) { lo = Math.min(lo, row.score); hi = Math.max(hi, row.score); mean += row.score / list.length; }
    for (const row of list) variance += (row.score - mean) ** 2 / list.length;
    const scale = normalize === 'minmax' ? hi - lo : Math.sqrt(variance);
    list.forEach((row, rank) => {
      const normalized = normalize === 'none' ? row.score : scale === 0 ? 0
        : (row.score - (normalize === 'minmax' ? lo : mean)) / scale;
      if (!Number.isFinite(normalized) || normalize !== 'none' && !Number.isFinite(scale)) throw new RangeError('fusion normalization overflow');
      collect(rows, row.id, weights[index] * normalized, { list: index, rank: rank + 1, score: row.score, normalized, weight: weights[index] });
    });
  });
  return ordered(rows);
}
