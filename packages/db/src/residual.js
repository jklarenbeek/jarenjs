//@ts-check
/**
 * @file Residual compilation: the part of a query that stays in
 * JavaScript is a REAL compiled Jaren query — the same engine, the
 * same semantics — never a reimplementation.
 *
 * Two modes (ARCHITECTURE.md):
 *
 * - `set` — the whole original document compiled once, run over the
 *   materialized candidate array. Re-applying pushed conjuncts is
 *   idempotent, so SQL-side narrowing never changes the answer.
 * - `row` — only the projection stayed behind: each fetched row runs
 *   `{ $for: { it: '$[*]' }, $return: [ <ret> ] }` over the one-row
 *   array; the array wrapper packs the item sequence so an
 *   array-VALUED item stays unambiguous, and the per-row results
 *   concatenate in row order (streamable).
 */

import { compileJsonQuery } from '@jarenjs/json/query';

/**
 * Compile the whole document for set-mode evaluation. A profile's
 * engine limits ride into the compilation so the JavaScript portion is
 * bounded by the engine's own enforcement.
 * @param {any} document
 * @param {any} [limits]
 * @returns {(candidates: any[], externals: any) => any}
 */
export function compileSetResidual(document, limits) {
  const compiled = compileJsonQuery(document,
    limits === undefined ? undefined : { limits });
  return (candidates, externals) => compiled(candidates, externals);
}

/**
 * Compile the per-row projection for row-mode evaluation.
 * @param {any} returnExpression - The document's raw `$return` value
 * @param {any} [limits]
 * @returns {(row: any, externals: any) => any[]} the row's items
 */
export function compileRowResidual(returnExpression, limits) {
  const compiled = compileJsonQuery({
    $for: { it: '$[*]' },
    $return: [returnExpression],
  }, limits === undefined ? undefined : { limits });
  return (row, externals) => {
    const packed = compiled([row], externals);
    // one binding → exactly one packed array of that row's items
    return /** @type {any[]} */ (packed);
  };
}

/**
 * Map a flat item array onto the engine's result shape: an empty
 * sequence is `undefined`, a singleton is the item, anything longer is
 * the array (probed engine behaviour, pinned by the differential
 * tests).
 * @param {any[]} items
 * @returns {any}
 */
export function sequenceResult(items) {
  if (items.length === 0) return undefined;
  if (items.length === 1) return items[0];
  return items;
}
