//@ts-check
/**
 * @file `rule()` and `stylesheet()` — the rule object of JSLT-FORMAT
 * §2.2 and the envelope of §2.1, emitted as plain deep-frozen JSON in
 * one member order (`mode`, `match`, `priority`, `body`; `$jslt`,
 * `unmatched`, `modes`, `rules` — the order Appendix A writes). A
 * `match` is a JSONPath string, `{ path?, schema? }` — the schema a
 * schema-pen builder or a document — or absent for the unconditional
 * rule; a body is `body()`'s document, a callback captured as one, or a
 * query document verbatim. What the pen refuses is what the compiler
 * would refuse and the pen can already see (`JT0001`–`JT0003`,
 * mirrored as `JL0101`/`JL0102`); everything else — path syntax, the
 * body's operators, the schema — is the compiler's.
 */

import { deepFreeze, setObjectMember, isJsonObject } from '@jarenjs/core/object';
import { LinqBuildError } from '../errors.js';
import { isSchemaBuilder, schemaOf } from '../schema/brand.js';
import { describeValue, requireJson, requireNameMap } from '../json-boundary.js';
import { body } from './body.js';

const DISPOSITIONS = ['share', 'fresh', 'error'];

/** A JSON value, copied: the document is a value of its own. @param {any} v */
const copy = (v) => JSON.parse(JSON.stringify(v));

/**
 * The `match` member (§3.1), or `undefined` for the unconditional rule.
 * @param {any} match
 * @returns {any}
 */
function readMatch(match) {
  if (match === undefined || match === null) return undefined;
  if (typeof match === 'string') return match;
  if (!isJsonObject(match)) {
    throw new LinqBuildError('JL0101',
      `rule() match is a JSONPath string or { path?, schema? }, got ${describeValue(match)}`,
      '/match');
  }
  const keys = Object.keys(match);
  if (keys.length === 0) {
    throw new LinqBuildError('JL0102',
      'rule() match {} would match nothing — write no match for the unconditional rule '
      + '(JSLT-FORMAT §3.1, the compiler\'s JT0003)', '/match');
  }
  for (const key of keys) {
    if (key !== 'path' && key !== 'schema') {
      throw new LinqBuildError('JL0101',
        `rule() match takes 'path' and/or 'schema', not '${key}' (JSLT-FORMAT §3.1)`,
        `/match/${key}`);
    }
  }
  const out = {};
  if (match.path !== undefined) {
    if (typeof match.path !== 'string') {
      throw new LinqBuildError('JL0101',
        `rule() match.path is an RFC 9535 query string, got ${describeValue(match.path)}`,
        '/match/path');
    }
    out.path = match.path;
  }
  if (match.schema !== undefined) {
    out.schema = isSchemaBuilder(match.schema)
      ? schemaOf(match.schema)
      : copy(requireJson(match.schema, 'rule() match.schema'));
  }
  return out;
}

/**
 * The `body` member: a callback captured as `body(fn)`, or a document
 * verbatim (a `body()` result, or a hand-written query document).
 * @param {any} value
 */
function readBody(value) {
  if (typeof value === 'function') return body(value);
  if (value === undefined) {
    throw new LinqBuildError('JL0101',
      'rule() takes a body: a callback (value, x) => …, body(…), or a query document',
      '/body');
  }
  return copy(requireJson(value, 'rule() body'));
}

/**
 * One template rule (§2.2): `{ mode?, match?, priority?, body }`.
 * @param {any} match - a JSONPath string, `{ path?, schema? }`, or `null`
 * @param {any} bodyOrFn - `body(…)`, a callback, or a query document
 * @param {{ mode?: string, priority?: number }} [options]
 * @returns {any} the rule document, deep-frozen
 */
export function rule(match, bodyOrFn, options = undefined) {
  const out = {};
  if (options !== undefined) {
    if (!isJsonObject(options)) {
      throw new LinqBuildError('JL0101',
        `rule() options are { mode?, priority? }, got ${describeValue(options)}`);
    }
    for (const key of Object.keys(options)) {
      if (key !== 'mode' && key !== 'priority') {
        throw new LinqBuildError('JL0101', `rule() does not take '${key}' (JSLT-FORMAT §2.2)`);
      }
    }
    if (options.mode !== undefined) {
      if (typeof options.mode !== 'string') {
        throw new LinqBuildError('JL0101',
          `rule() mode is a string naming the rule's mode, got ${describeValue(options.mode)}`,
          '/mode');
      }
      out.mode = options.mode;
    }
  }
  const m = readMatch(match);
  if (m !== undefined) out.match = m;
  if (options !== undefined && options.priority !== undefined) {
    const p = options.priority;
    if (typeof p !== 'number' || !Number.isFinite(p) || Object.is(p, -0)) {
      throw new LinqBuildError('JL0101',
        `rule() priority is a finite JSON number, got ${describeValue(p)}`, '/priority');
    }
    out.priority = p;
  }
  out.body = readBody(bodyOrFn);
  return deepFreeze(out);
}

/**
 * A disposition (§5): one of the three, or `JL0101`.
 * @param {any} value
 * @param {string} where
 */
function readDisposition(value, where) {
  if (DISPOSITIONS.includes(value)) return value;
  throw new LinqBuildError('JL0101',
    `${where} is one of 'share', 'fresh' or 'error' (JSLT-FORMAT §5), got `
    + `${typeof value === 'string' ? `'${value}'` : describeValue(value)}`, `/${where}`);
}

/**
 * The stylesheet envelope (§2.1): `{ $jslt: '0.1', unmatched?, modes?,
 * rules }`, deep-frozen. (The bare-array form is the rules array
 * itself; the envelope says what the document is.)
 * @param {readonly any[]} rules - rule documents, from `rule()` or by hand
 * @param {{ unmatched?: string, modes?: Record<string, { unmatched: string }> }} [options]
 * @returns {any} the stylesheet document
 */
export function stylesheet(rules, options = undefined) {
  if (!Array.isArray(rules)) {
    throw new LinqBuildError('JL0101',
      `stylesheet() takes an array of rules, got ${describeValue(rules)}`, '/rules');
  }
  const out = { $jslt: '0.1' };
  if (options !== undefined) {
    if (!isJsonObject(options)) {
      throw new LinqBuildError('JL0101',
        `stylesheet() options are { unmatched?, modes? }, got ${describeValue(options)}`);
    }
    for (const key of Object.keys(options)) {
      if (key !== 'unmatched' && key !== 'modes') {
        throw new LinqBuildError('JL0101',
          `stylesheet() does not take '${key}' (JSLT-FORMAT §2.1)`);
      }
    }
    if (options.unmatched !== undefined) {
      out.unmatched = readDisposition(options.unmatched, 'unmatched');
    }
    if (options.modes !== undefined) {
      if (!isJsonObject(options.modes)) {
        throw new LinqBuildError('JL0101',
          `stylesheet() modes is { name: { unmatched } }, got ${describeValue(options.modes)}`,
          '/modes');
      }
      requireNameMap(options.modes, 'stylesheet() modes', '/modes');
      const modes = {};
      for (const name of Object.keys(options.modes)) {
        const mode = options.modes[name];
        if (!isJsonObject(mode) || Object.keys(mode).length !== 1 || mode.unmatched === undefined) {
          throw new LinqBuildError('JL0101',
            `stylesheet() mode '${name}' is { unmatched } and nothing else (JSLT-FORMAT §2.1)`,
            `/modes/${name}`);
        }
        setObjectMember(modes, name,
          { unmatched: readDisposition(mode.unmatched, `modes/${name}/unmatched`) });
      }
      out.modes = modes;
    }
  }
  out.rules = rules.map((r, i) => {
    if (!isJsonObject(r)) {
      throw new LinqBuildError('JL0101',
        `stylesheet() rule ${i} is an object — rule(match, body) — got ${describeValue(r)}`,
        `/rules/${i}`);
    }
    if (r.body === undefined) {
      throw new LinqBuildError('JL0101',
        `stylesheet() rule ${i} has no body (JSLT-FORMAT §2.2, the compiler's JT0002)`,
        `/rules/${i}/body`);
    }
    return copy(requireJson(r, `stylesheet() rule ${i}`));
  });
  return deepFreeze(out);
}
