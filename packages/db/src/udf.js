//@ts-check
/**
 * @file The UDF escape hatch (capability-gated): between native SQL
 * and pulling rows sits registering a compiled predicate conjunct as a
 * DETERMINISTIC function used in the WHERE clause. Only fragments the
 * analysis proves deterministic and side-effect-free qualify — no
 * externals (their values change per call, and a deterministic
 * function must not close over changing state), no host functions, no
 * collations. Registration is keyed by `contentKey(fragment)` so
 * identical fragments share one registration per store.
 *
 * WHERE-clause use only: an INDEX over a registered function would
 * make the database unwritable from any connection that has not
 * registered the identical function — that schema-dependency hazard is
 * why the model format declares no UDF-expression indexes.
 *
 * Ring 3 extends the hatch to registry `pushable:'scalar'`
 * operators: a predicate fragment that uses a registered scalar operator
 * (`$sqrt`, `$pow`, …) compiles WITH the store's `{ functions,
 * extensions }` and pushes as the same deterministic UDF — SQLite drives
 * the row iteration and the operator runs inside the callback, instead
 * of every candidate crossing into the residual. The determinism rule is
 * unchanged (no externals, no collations); a registered operator the
 * pack did NOT mark `pushable:'scalar'` (a whole-series `$npv`, an
 * aggregate) stays the residual — Ring 2 keeps it correct.
 */

import { contentKey } from '@jarenjs/core/object';
import { compileJsonQuery, analyzeQuery } from '@jarenjs/json/query';

/**
 * Decide whether a raw predicate fragment qualifies for the hatch, and
 * build its registration if so.
 * @param {any} fragment - The raw conjunct (a JSON query expression
 *   over `$it`)
 * @param {{ functions?: any, extensions?: any, pushableScalar?: Set<string> } | null}
 *   [operators] - the store's registered operators (Ring 3); only its
 *   `pushable:'scalar'` subset is admitted. `null`/absent keeps the
 *   original engine-internal-only rule (no host function pushes).
 * @returns {{ key: string, name: string,
 *   compile: () => (docText: string) => number } | null}
 */
export function deterministicFragment(fragment, operators = null) {
  const analyzeOpts = operators === null
    ? undefined
    : { functions: operators.functions, extensions: operators.extensions };
  let dependencies;
  try {
    dependencies = analyzeQuery({ $let: { it: '$' }, $return: fragment }, analyzeOpts).dependencies;
  }
  catch {
    return null;
  }
  // determinism: a UDF registered `deterministic:true` must not close
  // over changing state — no externals, no collations, ever
  if (dependencies.externals.length > 0
    || dependencies.collations.length > 0) return null;
  // pushability: core operators are always fine; a REGISTERED operator or
  // host function is admitted only where the pack marked it
  // `pushable:'scalar'`. With no registry, any host function still
  // disqualifies (the original hatch was engine-internal fragments only).
  const pushable = operators === null ? null : operators.pushableScalar ?? new Set();
  const registered = operators === null ? null : operators.extensions;
  for (const name of dependencies.functions) {
    if (pushable === null || !pushable.has(name)) return null;
  }
  for (const name of dependencies.operators) {
    if (registered !== null && Object.prototype.hasOwnProperty.call(registered, name)
      && !pushable.has(name)) return null;
  }
  const key = contentKey(fragment);
  return {
    key,
    name: `jaren_p_${key.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}`,
    compile: () => {
      const compiled = compileJsonQuery({ $let: { it: '$' }, $return: fragment }, analyzeOpts);
      return (docText) => (compiled.ebv(JSON.parse(docText)) ? 1 : 0);
    },
  };
}

/**
 * Register a qualified fragment once per store.
 * @param {any} connection
 * @param {Set<string>} registered - The store's registration set
 * @param {{ key: string, name: string, compile: () => Function }} fragment
 * @returns {string} the function name to call in the WHERE clause
 */
export function registerFragment(connection, registered, fragment) {
  if (!registered.has(fragment.key)) {
    connection.registerFunction(fragment.name, { deterministic: true },
      fragment.compile());
    registered.add(fragment.key);
  }
  return fragment.name;
}
