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
 *
 * An **awaiting action** is the single-member object `{ "$await": { start?,
 * run, with?, slot?, then?, catch? } }` (APP-FORMAT §3.3). `$await` is no
 * query operator, so the form cannot be an action that compiled before;
 * its members are compiled here, once, each where the runtime evaluates
 * it: `start` as an ordinary action document, `with` over `$event` and
 * `$payload`, `then` with `$result` and `catch` with `$error` beside them.
 */

import { isJsonObject } from '@jarenjs/core/object';
import { escapePointerToken } from '@jarenjs/core/string';
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

/** The members an `$await` object takes, in the order a refusal names them. */
const AWAIT_MEMBERS = ['start', 'run', 'with', 'slot', 'then', 'catch'];

/**
 * A compiled awaiting action (APP-FORMAT §3.3): every member a query
 * compiled once, or `null` where the document leaves it out.
 */
export class AwaitingAction {
  /**
   * @param {any} start - The start transition's query.
   * @param {string} run - The registered effect awaited.
   * @param {any} withQuery - The effect props' query.
   * @param {string | null} slot - The await identity; `null` = the action name.
   * @param {any} then - The success continuation's query.
   * @param {any} catchQuery - The failure continuation's query.
   */
  constructor(start, run, withQuery, slot, then, catchQuery) {
    this.start = start;
    this.run = run;
    this.with = withQuery;
    this.slot = slot;
    this.then = then;
    this.catch = catchQuery;
  }
}

/**
 * Compile one `{ "$await": … }` action, refusing what the runtime could
 * not run as `JA0004` at the member's own location.
 * @param {string} name
 * @param {Record<string, any>} doc
 * @param {string} docPath - The action's pointer.
 * @param {ActionCompileOptions} options
 * @returns {AwaitingAction}
 */
function compileAwaitingAction(name, doc, docPath, options) {
  const refuse = (/** @type {string} */ reason, /** @type {string} */ at, /** @type {Error | undefined} */ cause) =>
    new AppCompileError('JA0004', `action '${name}': ${reason}`, at, cause);
  const sibling = Object.keys(doc).find((key) => key !== '$await');
  if (sibling !== undefined) {
    throw refuse(`an awaiting action is the single member {"$await": ...}; found '${sibling}' beside it`,
      `${docPath}/${escapePointerToken(sibling)}`, undefined);
  }
  const at = `${docPath}/$await`;
  const spec = doc.$await;
  if (!isJsonObject(spec)) throw refuse('"$await" must be an object naming at least the effect it runs', at, undefined);
  for (const key of Object.keys(spec)) {
    if (!AWAIT_MEMBERS.includes(key)) {
      throw refuse(`unknown member '${key}' — "$await" takes ${AWAIT_MEMBERS.slice(0, -1).join(', ')} and catch`,
        `${at}/${escapePointerToken(key)}`, undefined);
    }
  }
  if (typeof spec.run !== 'string' || spec.run === '') {
    throw refuse('"run" must name a registered effect (a non-empty string)', `${at}/run`, undefined);
  }
  if (spec.slot !== undefined && (typeof spec.slot !== 'string' || spec.slot === '')) {
    throw refuse('"slot" must be a non-empty string', `${at}/slot`, undefined);
  }
  /**
   * @param {string} member
   * @param {readonly string[] | undefined} externals - The variables it may
   *   leave free; `undefined` for the start, an ordinary action document.
   */
  const member = (member, externals) => {
    if (spec[member] === undefined) return null;
    try {
      return compileJsonQuery(spec[member], externals === undefined ? options : { ...options, externals });
    }
    catch (err) {
      const cause = toError(err);
      throw refuse(`its "${member}" failed to compile: ${safeErrorMessage(cause)}`, `${at}/${member}`, cause);
    }
  };
  return new AwaitingAction(
    member('start', undefined),
    spec.run,
    member('with', ['event', 'payload']),
    spec.slot ?? null,
    member('then', ['event', 'payload', 'result']),
    member('catch', ['event', 'payload', 'error']));
}

/**
 * Compile the `actions` member of an app document.
 * @param {any} actions
 * @param {ActionCompileOptions} options
 * @returns {Map<string, any>} action name → compiled query, or an
 *   {@link AwaitingAction} for an `{ "$await": … }` entry
 */
export function compileActions(actions, options) {
  if (actions === undefined) return new Map();
  if (!isJsonObject(actions)) {
    throw new AppCompileError('JA0003',
      'the "actions" member must be an object of named action documents',
      '/actions');
  }
  const map = new Map();
  for (const name in actions) {
    const doc = actions[name];
    const docPath = `/actions/${escapePointerToken(name)}`;
    if (isJsonObject(doc) && Object.hasOwn(doc, '$await')) {
      map.set(name, compileAwaitingAction(name, doc, docPath, options));
      continue;
    }
    try {
      map.set(name, compileJsonQuery(doc, options));
    }
    catch (err) {
      const cause = toError(err);
      throw new AppCompileError('JA0004',
        `action '${name}' failed to compile: ${safeErrorMessage(cause)}`,
        docPath, cause);
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
    if (!isJsonObject(entry)
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
