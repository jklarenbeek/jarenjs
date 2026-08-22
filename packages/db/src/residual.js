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
 *   the planner's one-row document over the one-row array; the array
 *   wrapper packs the item sequence so an array-VALUED item stays
 *   unambiguous, and the per-row results concatenate in row order
 *   (streamable).
 *
 * Neither mode builds a query document here. The collection binding is
 * named by the caller's document — `it`, `user`, anything — so a wrapper
 * synthesized in this file could only guess it, and a guess that
 * disagreed with the projection's references would surface as an
 * unbound-external error at request time rather than at compile time.
 * The planner knows the name and hands both modes something complete.
 */

import { compileJsonQuery } from '@jarenjs/json/query';

/**
 * The compile options for a residual: the profile's engine limits plus
 * the store's registered operators (Ring 2 — a registered operator runs
 * in the residual, so the residual compilation must carry its
 * `{ functions, extensions }` or it would fail `JQ0002`/`JQ0010`).
 * Returns `undefined` when neither is present, so a store opened with no
 * profile and no registry compiles byte-identically to before.
 * @param {any} limits
 * @param {{ functions?: any, extensions?: any } | null} [operators]
 * @returns {any}
 */
function residualOptions(limits, operators) {
  const functions = operators?.functions;
  const extensions = operators?.extensions;
  if (limits === undefined && functions === undefined && extensions === undefined)
    return undefined;
  /** @type {any} */
  const options = {};
  if (limits !== undefined) options.limits = limits;
  if (functions !== undefined) options.functions = functions;
  if (extensions !== undefined) options.extensions = extensions;
  return options;
}

/**
 * Compile the whole document for set-mode evaluation. A profile's
 * engine limits ride into the compilation so the JavaScript portion is
 * bounded by the engine's own enforcement.
 * @param {any} document
 * @param {any} [limits]
 * @param {{ functions?: any, extensions?: any } | null} [operators] -
 *   the store's registered operators, so the residual can evaluate them
 * @returns {(candidates: any[], externals: any) => any}
 */
export function compileSetResidual(document, limits, operators) {
  const compiled = compileJsonQuery(document, residualOptions(limits, operators));
  return (candidates, externals) => compiled(candidates, externals);
}

/**
 * Compile the per-row projection for row-mode evaluation.
 * @param {any} rowDocument - The planner's complete one-row document
 *   (`{ $for: { <the document's own binding>: '$[*]' },
 *   $return: [ <its $return> ] }`). It arrives whole because the binding
 *   and the projection that references it must agree, and the planner is
 *   the only place that knows the name.
 * @param {any} [limits]
 * @param {{ functions?: any, extensions?: any } | null} [operators]
 * @returns {(row: any, externals: any) => any[]} the row's items
 */
export function compileRowResidual(rowDocument, limits, operators) {
  const compiled = compileJsonQuery(rowDocument, residualOptions(limits, operators));
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
