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
 */

import { contentKey } from '@jarenjs/core/object';
import { compileJsonQuery, analyzeQuery } from '@jarenjs/json/query';

/**
 * Decide whether a raw predicate fragment qualifies for the hatch, and
 * build its registration if so.
 * @param {any} fragment - The raw conjunct (a JSON query expression
 *   over `$it`)
 * @returns {{ key: string, name: string,
 *   compile: () => (docText: string) => number } | null}
 */
export function deterministicFragment(fragment) {
  let dependencies;
  try {
    dependencies = analyzeQuery({ $let: { it: '$' }, $return: fragment }).dependencies;
  }
  catch {
    return null;
  }
  if (dependencies.externals.length > 0
    || dependencies.functions.length > 0
    || dependencies.collations.length > 0) return null;
  const key = contentKey(fragment);
  return {
    key,
    name: `jaren_p_${key.replace(/[^A-Za-z0-9]/g, '').slice(0, 24)}`,
    compile: () => {
      const compiled = compileJsonQuery({ $let: { it: '$' }, $return: fragment });
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
