//@ts-check
/**
 * @file The UDF escape hatch (capability-gated): between native SQL
 * and pulling rows sits registering a compiled predicate conjunct as a
 * DETERMINISTIC function used in the WHERE clause. Only fragments the
 * analysis proves deterministic and side-effect-free qualify — no
 * externals (their values change per call, and a deterministic
 * function must not close over changing state), no host functions, no
 * collations. Registration is keyed by the fragment's COLLISION-FREE
 * structural identity, so identical fragments share one registration
 * per store and different fragments never do. A fingerprint could not
 * decide this: two colliding fragments would claim one SQL function
 * name, the second would silently reuse the first's predicate, and the
 * WHERE clause would filter on the wrong condition. The SQL identifier
 * still derives from a short fingerprint — names must be short — but a
 * fingerprint clash between DIFFERENT identities is disambiguated with
 * a suffix rather than collapsed.
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

import { semanticKey } from '@jarenjs/core/object';
import { hashContent } from '@jarenjs/core/string';
import { compileJsonQuery, analyzeQuery } from '@jarenjs/json/query';

/**
 * The SQL identifier for one fragment identity: a short fingerprint of
 * the identity, not the identity itself (SQLite names are not the place
 * for a whole serialized document). Distinct identities may collide
 * here; {@link registerFragment} disambiguates.
 * @param {string} identity
 * @returns {string}
 */
const functionNameFor = (identity) => `jaren_p_${hashContent(identity)}`;

/**
 * Decide whether a raw predicate fragment qualifies for the hatch, and
 * build its registration if so.
 * @param {any} fragment - The raw conjunct (a JSON query expression
 *   over `$it`)
 * @param {{ functions?: any, extensions?: any, pushableScalar?: Set<string> } | null}
 *   [operators] - the store's registered operators (Ring 3); only its
 *   `pushable:'scalar'` subset is admitted. `null`/absent keeps the
 *   original engine-internal-only rule (no host function pushes).
 * @param {string} [binding='it'] - the name the caller's document gave
 *   the collection binding. The fragment references it, so the wrapper
 *   below must bind it: under any other name every reference reads as an
 *   external, the determinism check below rejects the fragment, and the
 *   hatch silently never engages.
 * @returns {{ key: string, name: string,
 *   compile: () => (docText: string) => number } | null}
 */
export function deterministicFragment(fragment, operators = null, binding = 'it') {
  const analyzeOpts = operators === null
    ? undefined
    : { functions: operators.functions, extensions: operators.extensions };
  const wrap = (/** @type {any} */ body) => ({ $let: { [binding]: '$' }, $return: body });
  let dependencies;
  try {
    dependencies = analyzeQuery(wrap(fragment), analyzeOpts).dependencies;
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
  /** @type {string} */
  let key;
  try {
    key = semanticKey(fragment);
  }
  catch {
    // a fragment that cannot be keyed injectively must not be shared
    // under some other fragment's registration; the residual is always
    // correct, so it does not qualify for the hatch
    return null;
  }
  return {
    key,
    name: functionNameFor(key),
    compile: () => {
      // the SAME wrapper the analysis ran over: a compile that bound a
      // different name than the analysis would judge one document and
      // run another
      const compiled = compileJsonQuery(wrap(fragment), analyzeOpts);
      return (docText) => (compiled.ebv(JSON.parse(docText)) ? 1 : 0);
    },
  };
}

/**
 * Register a qualified fragment once per store, and answer the SQL name
 * to call. Identity is the fragment's structural key, so the same
 * fragment registers once and two different fragments always get two
 * different functions — even when their short names fingerprint alike,
 * which the suffix resolves.
 * @param {any} connection
 * @param {Map<string, string>} registered - The store's registrations,
 *   fragment identity → the SQL function name it owns
 * @param {{ key: string, name: string, compile: () => Function }} fragment
 * @returns {string} the function name to call in the WHERE clause
 */
export function registerFragment(connection, registered, fragment) {
  const owned = registered.get(fragment.key);
  if (owned !== undefined) return owned;
  const stem = functionNameFor(fragment.key);
  const taken = new Set(registered.values());
  let name = stem;
  for (let n = 2; taken.has(name); n++) name = `${stem}_${n}`;
  connection.registerFunction(name, { deterministic: true }, fragment.compile());
  registered.set(fragment.key, name);
  return name;
}
