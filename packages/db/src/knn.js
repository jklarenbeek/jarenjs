//@ts-check
/**
 * @file The candidate cut of a k-nearest plan: the arithmetic between
 * the scores a statement fetched and the row identities the engine
 * will decide over. No vector arithmetic lives here — a score is
 * `derive.js`'s, through `@jarenjs/core/vector` — and no SQL: the
 * fetch of the winners is the dialect's. This is the one place the
 * margin is applied and the one place candidate identities are
 * batched for it.
 */

/**
 * The inclusive score margin of the cut. The column's score is a dot
 * product over binary32-normalized forms; the engine's key is the
 * cosine of the raw doubles; measured, the two differ by at most
 * ~1e-8. Any margin of at least twice that makes the engine's top
 * `offset + limit` a SUBSET of the candidates: were a row the engine
 * ranks inside the window cut, some candidate the engine ranks outside
 * it would have to score higher by the column and lower by the engine,
 * which two scores within half the margin of each other cannot do.
 * This is a hundred times that bound — it admits, in practice, only
 * true ties, and those the engine breaks by the document's own keys.
 */
export const KNN_MARGIN = 1e-6;

/**
 * The most identities one fetch statement binds: under the parameter
 * cap of every SQLite build the store runs on. A guard, not a design —
 * a k-nearest window is a handful of rows, and this only matters for a
 * collection of many exact duplicates.
 */
export const IDENTITY_CHUNK = 512;

/** @param {any} a @param {any} b */
const byIdentity = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The rows a k-nearest window can contain, from the scored fetch.
 *
 * `m = offset + limit` rows are needed. When at least `m` rows scored,
 * the candidates are every scored row within `margin` of the m-th best
 * score — ties at the boundary included by construction. When fewer
 * did, the window reaches the unrankable tail (NULL columns, or a
 * collection smaller than the window), which only the documents can
 * order: every row is then a candidate, and the collection is no
 * larger than the window.
 * @param {{ identity: any, score: number | null }[]} rows - one per
 *   fetched row; `score` is `null` where the column held no vector
 * @param {number} m - `offset + limit`
 * @param {number} margin
 * @returns {{ identities: any[], scored: number, full: boolean }} the
 *   candidate identities in ascending identity order — the
 *   collection's own order, which a stable sort over the candidates
 *   must see — with how many rows scored and whether every row was
 *   taken
 */
export function cutCandidates(rows, m, margin) {
  let scored = 0;
  for (const row of rows) if (row.score !== null) scored++;
  if (scored < m) {
    return { identities: rows.map((row) => row.identity).sort(byIdentity), scored, full: true };
  }
  if (m <= 0) return { identities: [], scored, full: false };
  const scores = new Float64Array(scored);
  let at = 0;
  for (const row of rows) if (row.score !== null) scores[at++] = row.score;
  scores.sort();
  const threshold = scores[scored - m] - margin;
  const identities = [];
  for (const row of rows) {
    if (row.score !== null && row.score >= threshold) identities.push(row.identity);
  }
  identities.sort(byIdentity);
  return { identities, scored, full: false };
}

/**
 * The identities sliced into fetch batches: at most `IDENTITY_CHUNK`
 * each, and each padded with `null` to the next power of two — a NULL
 * in an IN list matches no row — so a handful of prepared statements
 * serve every candidate count instead of one per count seen.
 * @param {any[]} identities - in the order they should be fetched
 * @returns {{ size: number, params: any[] }[]}
 */
export function identityBatches(identities) {
  const batches = [];
  for (let start = 0; start < identities.length; start += IDENTITY_CHUNK) {
    const slice = identities.slice(start, start + IDENTITY_CHUNK);
    let size = 1;
    while (size < slice.length) size *= 2;
    const params = [...slice];
    while (params.length < size) params.push(null);
    batches.push({ size, params });
  }
  return batches;
}
