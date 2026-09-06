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
 * WHERE-clause use only, and that is the difference between this hatch
 * and a DECLARED index expression (MODEL-FORMAT §7A). An index over a
 * registered function makes the database unwritable from a connection
 * that has not registered the identical function; a fragment registered
 * here is a QUERY's, discovered from the caller's document at run time,
 * and indexing one would make a passing query a permanent schema
 * dependency nobody declared. A model's `indexes[].expression` carries
 * exactly that dependency in the model, where every store that opens it
 * is handed the same declaration and one that cannot honour it refuses
 * at open.
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
import { compileJsonQuery, analyzeQuery, JsonQueryRuntimeError } from '@jarenjs/json/query';

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
 *   compile: () => (docText: string, mount?: string) => number } | null}
 *   - the compiled function takes the row's document text and the
 *   conjunct's JSON Pointer in the CALLER's document (`/$where`, or
 *   `/$where/$and/<i>`), which the emitter passes as a literal: an
 *   engine error raised inside names the wrapper's path (`/$return/…`)
 *   and is rebased onto that mount, so the native mode and the residual
 *   report the same location while one registration still serves every
 *   document that carries the fragment
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
  const WRAPPER = '/$return';
  return {
    key,
    name: functionNameFor(key),
    compile: () => {
      // the SAME wrapper the analysis ran over: a compile that bound a
      // different name than the analysis would judge one document and
      // run another
      const compiled = compileJsonQuery(wrap(fragment), analyzeOpts);
      // two declared parameters on purpose: node:sqlite registers the
      // function with the arity `fn.length` reports, and the emitter
      // always passes the mount beside the document
      return (docText, mount) => {
        try {
          return compiled.ebv(JSON.parse(docText)) ? 1 : 0;
        }
        catch (error) {
          // the engine's own refusal, relocated from the wrapper onto
          // the caller's document; anything else propagates as it is
          if (error instanceof JsonQueryRuntimeError && typeof error.docPath === 'string'
            && error.docPath.startsWith(WRAPPER)) {
            throw new JsonQueryRuntimeError(error.code, error.reason,
              (typeof mount === 'string' ? mount : '/$where') + error.docPath.slice(WRAPPER.length),
              Object.hasOwn(error, 'cause') ? { cause: error.cause } : undefined);
          }
          throw error;
        }
      };
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

/**
 * The SQL identifier for one registered aggregate. Unlike a predicate
 * fragment, the identity IS the operator name — one registry, one
 * function per name — so the fingerprint has nothing to disambiguate.
 * @param {string} name
 * @returns {string}
 */
const aggregateNameFor = (name) => `jaren_a_${hashContent(name)}`;

/**
 * Register a pushable aggregate once per store and answer the SQL name
 * to call. The SQL fold accumulates the column's values and hands them
 * to the SAME pure function the residual would call, so the two sides
 * differ in who drives the loop and in nothing else.
 *
 * A `NULL` column value is SKIPPED, because the engine's sequence has no
 * item where the member is absent — which is why only a path the schema
 * types as a number that cannot hold `null` reaches here: a stored
 * `null` and an absent member are one value in SQL, and dropping a
 * present `null` would answer where the engine does not.
 *
 * `undefined` — what these summaries answer for an input they cannot
 * summarise — becomes SQL `NULL`, which the aggregate decoder reads back
 * as the empty answer, exactly as the engine's empty sequence does.
 * @param {any} connection
 * @param {Map<string, string>} registered - operator name → SQL name
 * @param {string} name - the registry operator name (`$mean`)
 * @param {{ fn: Function }} spec
 * @returns {string} the SQL function name to call
 */
export function registerAggregateOperator(connection, registered, name, spec) {
  const owned = registered.get(name);
  if (owned !== undefined) return owned;
  const sqlName = aggregateNameFor(name);
  connection.registerAggregate(sqlName, {
    start: () => [],
    step: (values, value) => {
      if (value !== null && value !== undefined) values.push(value);
      return values;
    },
    result: (values) => {
      const out = spec.fn(values);
      return out === undefined || out === null ? null : out;
    },
  });
  registered.set(name, sqlName);
  return sqlName;
}
