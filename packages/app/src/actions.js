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
 */

/**
 * Compile the `subs` member of an app document:
 * `[{ "run": name, "with"?: props, "when"?: <EBV query> }]`.
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
    return { run: entry.run, props: entry.with ?? null, when };
  });
}
