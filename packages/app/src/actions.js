//@ts-check
/**
 * @file Compiling the transition vocabulary of an app document: named
 * action documents and subscription entries. Everything here runs once,
 * at `createApp` time — the loop only ever calls compiled closures.
 *
 * An **action document** is a Jaren JSON Query document (QUERY-FORMAT.md)
 * evaluated with `$` bound to the current state and two externals:
 *
 *  - `$event`   — the serializable event data (`{ type, value, checked,
 *    key }`) when the dispatch came from the DOM, else `null`
 *  - `$payload` — the binding's `with` value, else `null`
 *
 * It returns a **transition object** (or nothing for a no-op):
 *
 *  - `state`   — the next state, whole
 *  - `patch`   — an RFC 6902 JSON Patch applied to the state (after
 *    `state`, when both are present)
 *  - `effects` — `[{ "run": name, "with"?: props }]` handed to the
 *    registered effect handlers
 */

import { compileJsonQuery } from '@jarenjs/json/query';
import { AppCompileError, toError, safeErrorMessage } from './errors.js';

/**
 * The compile-time options shared by every embedded query document.
 * @typedef {Object} ActionCompileOptions
 * @property {(schema: any, docPath: string) => ((value: any) => boolean)} [compileTypeTest]
 *   Enables `$valid`/`$assert`/`$as` schema operators inside action
 *   documents; typically `createTypeTestCompiler()` from
 *   `@jarenjs/validate/query`.
 */

/**
 * Compile the `actions` member of an app document.
 * @param {any} actions
 * @param {ActionCompileOptions} options
 * @returns {Map<string, any>} action name → compiled query
 */
export function compileActions(actions, options) {
  if (actions === undefined) return new Map();
  if (actions === null || typeof actions !== 'object' || Array.isArray(actions)) {
    throw new AppCompileError('JA0003',
      'the "actions" member must be an object of named action documents',
      '/actions');
  }
  const map = new Map();
  for (const name in actions) {
    try {
      map.set(name, compileJsonQuery(actions[name], options));
    }
    catch (err) {
      const cause = toError(err);
      throw new AppCompileError('JA0004',
        `action '${name}' failed to compile: ${safeErrorMessage(cause)}`,
        `/actions/${name}`, cause);
    }
  }
  return map;
}

/**
 * A compiled subscription entry.
 * @typedef {Object} CompiledSub
 * @property {string} run - The registered handler name.
 * @property {any} props - The entry's `with` value (`null` when absent).
 * @property {any} when - Compiled liveness query, or `null` (always live).
 * @property {any} withQuery - Compiled props query evaluated against the
 *   state (with `$item` bound per instance under `for`), or `null`.
 * @property {any} keyQuery - Compiled restart-key query, or `null` (the
 *   key derives from the resolved props by value).
 * @property {any} forQuery - Compiled fan-out query yielding the item
 *   set, or `null` (a single-instance subscription).
 */

/**
 * Compile one dynamic member of a subscription entry as a query,
 * closed-world: `externals` names the only variables the document may
 * leave free (`$item` under `for`, nothing otherwise), so a typo'd
 * variable is JA0008 at compile time instead of an unbound-external
 * error at runtime.
 * @param {any} entry
 * @param {number} i
 * @param {string} member
 * @param {ActionCompileOptions} options
 * @param {readonly string[]} externals
 * @returns {any} the compiled query, or `null` when absent
 */
function compileSubQuery(entry, i, member, options, externals) {
  const doc = entry[member];
  if (doc === undefined) return null;
  try {
    return compileJsonQuery(doc, { ...options, externals });
  }
  catch (err) {
    const cause = toError(err);
    throw new AppCompileError('JA0008',
      `subscription ${i} ('${entry.run}') has a "${member}" that failed to compile: ${safeErrorMessage(cause)}`,
      `/subs/${i}/${member}`, cause);
  }
}

/**
 * Compile the `subs` member of an app document:
 * `[{ "run": name, "with"?: props, "when"?: <EBV query>,
 *     "withQuery"?: query, "key"?: query, "for"?: query }]`.
 *
 * `with` is verbatim data; `withQuery` derives the props from the state
 * and makes the subscription DYNAMIC — it restarts when its resolved
 * key changes (`key` overrides the derived-from-props default). `for`
 * fans the declaration out to one instance per item of its result. The
 * combinations that would make one entry ambiguous are JA0008: `with`
 * beside `withQuery`, `with` beside `for`, and `key` without either
 * `withQuery` or `for`.
 * @param {any} subs
 * @param {ActionCompileOptions} options
 * @returns {CompiledSub[]}
 */
export function compileSubs(subs, options) {
  if (subs === undefined) return [];
  if (!Array.isArray(subs)) {
    throw new AppCompileError('JA0005',
      'the "subs" member must be an array of subscription entries',
      '/subs');
  }
  return subs.map((entry, i) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.run !== 'string' || entry.run === '') {
      throw new AppCompileError('JA0006',
        `subscription ${i} must be an object with a non-empty "run" name`,
        `/subs/${i}`);
    }
    let when = null;
    if (entry.when !== undefined) {
      try {
        when = compileJsonQuery(entry.when, options);
      }
      catch (err) {
        const cause = toError(err);
        throw new AppCompileError('JA0006',
          `subscription ${i} ('${entry.run}') has a "when" that failed to compile: ${safeErrorMessage(cause)}`,
          `/subs/${i}/when`, cause);
      }
    }
    if (entry.with !== undefined && entry.withQuery !== undefined) {
      throw new AppCompileError('JA0008',
        `subscription ${i} ('${entry.run}') carries both "with" and "withQuery" — one entry, one props source`,
        `/subs/${i}`);
    }
    if (entry.with !== undefined && entry.for !== undefined) {
      throw new AppCompileError('JA0008',
        `subscription ${i} ('${entry.run}') carries "with" beside "for" — fan-out props come from "withQuery" or default to the item`,
        `/subs/${i}`);
    }
    if (entry.key !== undefined && entry.withQuery === undefined && entry.for === undefined) {
      throw new AppCompileError('JA0008',
        `subscription ${i} ('${entry.run}') carries "key" without "withQuery" or "for" — a static subscription has no restart key`,
        `/subs/${i}`);
    }
    const instanceExternals = entry.for !== undefined ? ['item'] : [];
    const forQuery = compileSubQuery(entry, i, 'for', options, []);
    const withQuery = compileSubQuery(entry, i, 'withQuery', options, instanceExternals);
    const keyQuery = compileSubQuery(entry, i, 'key', options, instanceExternals);
    return { run: entry.run, props: entry.with ?? null, when, withQuery, keyQuery, forQuery };
  });
}
