//@ts-check

//#region series spec compilation (section 8.16)
// The literal half of the five temporal operators. Everything a
// `$resample`, `$rolling`, `$asof` or `$time-bucket` needs to know
// before it sees a single row — the width, the aggregate, the fill
// policy, the wall clock, where the instant lives in a row — is read
// here, ONCE, at query compile time.
//
// That is the whole design. A spec is a **literal**, never an
// expression: it is captured verbatim by the 'raw' argument kind
// (normalize.js `makeRaw`), so nothing inside it is evaluated, nothing
// inside it can vary per row, and a misspelled member is a broken
// document rather than a surprise on the ten-thousandth sample. The
// alternative — a spec computed from the data — would make the kernel
// re-compile a boundary ladder per call and would put a typo beyond the
// reach of every gate a document has.
//
// Three rules run through it:
//
//   **Closed.** Each spec names its members exactly. An unknown one is
//   `JQ0003` with the near-miss named, because `minPeriod` for
//   `minPeriods` silently ignored is the bug that takes an afternoon.
//
//   **Compile what is authored, refuse what is not.** A bad duration, a
//   bad aggregate, a bad path, a zone with no provider: all `JQ0003`
//   against the member that carried them. Only what the DATA decides —
//   a row that is not a sample, an instant that names none — is
//   `JQ2001` at runtime.
//
//   **No second loop.** These helpers shape arguments for
//   `@jarenjs/core/series` and read its answers back. The bucketing,
//   the window, the join and the fill exist once, in the kernel; this
//   module is the door they are reached through from a document.

import { parseJSONPath, JSONPathSyntaxError } from '../path.js';
import { isSingularSegments, compileSingularGetter, NOTHING } from '../segments.js';
import {
  resolveClock,
  CLOCK_MEMBERS as KERNEL_CLOCK_MEMBERS,
  RESAMPLE_MEMBERS as KERNEL_RESAMPLE_MEMBERS,
  ROLLING_MEMBERS as KERNEL_ROLLING_MEMBERS,
} from '@jarenjs/core/series';
import { queryCompileError, queryRuntimeError } from './messages.js';
import { EMPTY, Seq, itemRef } from './runtime.js';

const hasOwn = Object.hasOwn;

/**
 * The one member of a kernel specification a DOCUMENT cannot carry.
 * `provider` is a pair of functions and JSON has no such value, so a
 * named zone reaches the kernel through `options.zoneProvider` at
 * compile time instead. Everything else these operators admit is
 * whatever `@jarenjs/core/series` admits, read from the kernel rather
 * than restated here — one list, one place, and a member added to a
 * kernel reaches the language in the same change.
 */
const NOT_IN_A_DOCUMENT = Object.freeze(['provider']);

/** @param {readonly string[]} members @returns {readonly string[]} */
const spellable = (members) =>
  Object.freeze(members.filter((name) => !NOT_IN_A_DOCUMENT.includes(name)));

/**
 * The calendar context every clock-reading spec carries, and the one
 * `$time-bucket` takes as its own literal. `zone` is an IANA name — only
 * `'UTC'` resolves without a provider (this suite bundles no tzdb) —
 * `offset` is minutes east of UTC, and `disambiguation` says what a
 * local time that happens twice, or never, resolves to.
 */
export const CLOCK_MEMBERS = spellable(KERNEL_CLOCK_MEMBERS);

/** `$resample`: the bucket contract, plus where a row keeps its members. */
export const RESAMPLE_MEMBERS = spellable(KERNEL_RESAMPLE_MEMBERS);

/** `$rolling`: a window measured in time, and how much of one counts. */
export const ROLLING_MEMBERS = spellable(KERNEL_ROLLING_MEMBERS);

/**
 * `$asof`: which way to look, how far, and what makes two rows
 * comparable. The one list NOT read from the kernel: `asOfJoin` takes
 * nested `left`/`right` selector records, and a spec that stays one
 * flat literal is what makes "compiled once" true — so the document
 * spells `by`, `leftAt` and `rightAt`, and `compileAsOfSpec` below is
 * the single place that translation happens.
 */
export const ASOF_MEMBERS = Object.freeze([
  'direction', 'tolerance', 'by', 'leftAt', 'rightAt',
]);

/** What a local time that happens twice, or never, may resolve to. */
const DISAMBIGUATIONS = Object.freeze(['reject', 'earlier', 'later']);

/** The spec members that are singular paths into a row rather than values. */
const SELECTOR_MEMBERS = Object.freeze(['at', 'value', 'by', 'leftAt', 'rightAt']);

/** A compile refusal whose reason is a catalog message (./messages.js).
 * @param {string} code @param {string} messageId @param {Record<string, any>} params
 * @param {string} docPath @param {unknown} [cause] */
function compileError(code, messageId, params, docPath, cause) {
  return queryCompileError(code, messageId, params, docPath, cause === undefined ? undefined : { cause });
}

/**
 * The nearest admitted member to a misspelling, by a cheap edit-distance
 * proxy: same first letter and a length within one, or a case-folded
 * match. Enough to catch `minPeriod`, `Every` and `agregate`, and it
 * never guesses when nothing is close.
 * @param {string} name
 * @param {readonly string[]} allowed
 * @returns {string | null} the member it meant, or null
 */
function nearMiss(name, allowed) {
  const lower = name.toLowerCase();
  for (const candidate of allowed) {
    const other = candidate.toLowerCase();
    if (other === lower
      || (other.startsWith(lower) && other.length - lower.length <= 2)
      || (lower.startsWith(other) && lower.length - other.length <= 2))
      return candidate;
  }
  return null;
}

/**
 * One captured spec literal, confirmed to be an object naming only
 * admitted members.
 * @param {any} value - the raw node's frozen value
 * @param {readonly string[]} allowed - the closed member list
 * @param {string} operator - the operator's name, for the message
 * @param {string} docPath - the spec argument's pointer
 * @returns {any} the same object
 * @throws {JsonQueryCompileError} JQ0003
 */
export function requireSpec(value, allowed, operator, docPath) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw compileError('JQ0003', 'query/series-spec-object', { operator, got: itemRef(value) }, docPath);
  }
  for (const name of Object.keys(value)) {
    if (!allowed.includes(name)) {
      const suggestion = nearMiss(name, allowed);
      const admitted = allowed.map((m) => `'${m}'`).join(', ');
      throw suggestion === null
        ? compileError('JQ0003', 'query/series-spec-member', { operator, name, allowed: admitted }, docPath)
        : compileError('JQ0003', 'query/series-spec-member-suggest', { operator, name, suggestion, allowed: admitted }, docPath);
    }
  }
  return value;
}

/**
 * A spec member that must be one of a closed set of names.
 * @param {any} value
 * @param {readonly string[]} allowed
 * @param {string} member
 * @param {string} docPath
 * @returns {string}
 */
export function requireEnum(value, allowed, member, docPath) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw compileError('JQ0003', 'query/series-member-enum', { member, allowed: allowed.map((a) => `'${a}'`).join(', '),
      got: typeof value === 'string' ? JSON.stringify(value) : itemRef(value) }, docPath);
  }
  return value;
}

/**
 * A spec member that must be a finite number.
 * @param {any} value
 * @param {string} member
 * @param {string} docPath
 * @returns {number}
 */
export function requireNumber(value, member, docPath) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw compileError('JQ0003', 'query/series-member-number', { member, got: itemRef(value) }, docPath);
  }
  return value;
}

/**
 * A spec member naming an instant: epoch milliseconds or an RFC 3339
 * string. The kernel converts it; this only refuses what is not one of
 * the two spellings, so the message names the member rather than a row.
 * @param {any} value
 * @param {string} member
 * @param {string} docPath
 * @returns {number | string}
 */
export function requireInstant(value, member, docPath) {
  if (typeof value === 'number' && Number.isFinite(value))
    return value;
  if (typeof value === 'string')
    return value;
  throw compileError('JQ0003', 'query/series-member-instant', { member, got: itemRef(value) }, docPath);
}

/**
 * A spec member naming a span: a finite count of milliseconds or an ISO
 * 8601 duration string. The kernel decides whether the duration is one
 * it can walk; this refuses the shapes that are not spans at all.
 * @param {any} value
 * @param {string} member
 * @param {string} docPath
 * @returns {number | string}
 */
export function requireSpan(value, member, docPath) {
  if (typeof value === 'number' && Number.isFinite(value))
    return value;
  if (typeof value === 'string')
    return value;
  throw compileError('JQ0003', 'query/series-member-duration', { member, got: itemRef(value) }, docPath);
}

/**
 * A **row selector**: the query language's singular-path spelling, with
 * `$` reading as the ROW rather than as the document — `'$.on'`,
 * `'$[\'recorded at\']'`, `'$.meta.at'`. Compiled once into a direct
 * property walk (`compileSingularGetter`), so nothing is parsed per row.
 *
 * A bare member name is the common case, and it is handed to the kernel
 * as a name rather than as a closure: `canonicalSeries`'s no-copy fast
 * path is only available to a series already spelled `at`/`value`, and
 * a closure would take it away from every caller who did not need one.
 *
 * @param {any} value - the raw spec member
 * @param {string} member - its name, for the message
 * @param {string} docPath - the spec argument's pointer
 * @returns {string | ((item: any) => any)} a member name, or a reader
 * @throws {JsonQueryCompileError} JQ0003 for a non-singular or invalid path
 */
export function compileSelector(value, member, docPath) {
  if (typeof value !== 'string') {
    throw compileError('JQ0003', 'query/series-member-path', { member, got: itemRef(value) }, docPath);
  }
  let ast;
  try {
    ast = parseJSONPath(value);
  }
  catch (e) {
    throw e instanceof JSONPathSyntaxError
      ? compileError('JQ0003', 'query/series-member-path-detail', { member, detail: e.message }, docPath, e)
      : compileError('JQ0003', 'query/series-member-not-path', { member }, docPath, e);
  }
  const segments = ast.segments;
  if (segments.length === 0) {
    throw compileError('JQ0003', 'query/series-member-whole-row', { member }, docPath);
  }
  if (!isSingularSegments(segments)) {
    throw compileError('JQ0003', 'query/series-member-singular', { member }, docPath);
  }
  if (segments.length === 1 && segments[0].selectors[0].kind === 'name')
    return segments[0].selectors[0].name;
  const walk = compileSingularGetter(segments, true);
  return (item) => {
    const found = walk(item, item);
    return found === NOTHING ? undefined : found;
  };
}

/**
 * The wall clock a spec's calendar boundaries fall on, resolved once.
 *
 * UTC and a fixed offset need nothing. A named zone needs the tzdb this
 * suite deliberately does not bundle, and a JSON document cannot
 * carry one — so the provider arrives through the compilation's
 * `zoneProvider` option, and a named zone without one is a refusal
 * naming the seam rather than a silent fall back to UTC that is right
 * for eight months of the year.
 *
 * @param {any} spec - the captured spec (or calendar context)
 * @param {any} provider - `options.zoneProvider`, or null
 * @param {string} docPath
 * @returns {{ zone?: string, offset?: number, provider?: any, disambiguation?: string }}
 *   the clock options the kernel takes
 * @throws {JsonQueryCompileError} JQ0003
 */
export function compileClock(spec, provider, docPath) {
  /** @type {any} */
  const clock = {};
  if (hasOwn(spec, 'zone')) {
    if (typeof spec.zone !== 'string') {
      throw compileError('JQ0003', 'query/series-zone', { got: itemRef(spec.zone) }, docPath);
    }
    clock.zone = spec.zone;
    if (spec.zone !== 'UTC') {
      if (provider === null) {
        throw compileError('JQ0003', 'query/series-zone-provider', { zone: spec.zone }, docPath);
      }
      clock.provider = provider;
    }
  }
  if (hasOwn(spec, 'offset'))
    clock.offset = requireNumber(spec.offset, 'offset', docPath);
  if (hasOwn(spec, 'disambiguation'))
    clock.disambiguation = requireEnum(spec.disambiguation, DISAMBIGUATIONS, 'disambiguation', docPath);
  // the kernel owns the remaining refusals (a zone and an offset at
  // once); raising them here keeps them compile-time
  try {
    resolveClock(clock);
  }
  catch (e) {
    throw compileError('JQ0003', 'query/series-calendar', { detail: e instanceof Error ? e.message : 'is invalid' }, docPath, e);
  }
  return clock;
}

/** The seven aggregates, for both `$resample` and `$rolling`. */
export const AGGREGATES = Object.freeze([
  'sum', 'mean', 'min', 'max', 'first', 'last', 'count']);

/** The five fill policies. */
export const FILLS = Object.freeze(['omit', 'null', 'zero', 'locf', 'linear']);

/** Which way an as-of join looks for its match. */
export const DIRECTIONS = Object.freeze(['backward', 'forward', 'nearest']);

/**
 * Copy the members a spec authored into the shape the kernel takes,
 * compiling each through its own rule. Members absent from the document
 * stay absent, so the kernel's own defaults are the only defaults.
 * @param {any} spec - the captured literal
 * @param {any} provider - `options.zoneProvider`, or null
 * @param {string} docPath
 * @param {Record<string, (value: any, member: string, docPath: string) => any>} rules
 * @returns {any} the kernel spec
 */
export function buildKernelSpec(spec, provider, docPath, rules) {
  /** @type {any} */
  const out = compileClock(spec, provider, docPath);
  for (const member of Object.keys(rules)) {
    if (!hasOwn(spec, member))
      continue;
    const value = SELECTOR_MEMBERS.includes(member)
      ? compileSelector(spec[member], member, docPath)
      : rules[member](spec[member], member, docPath);
    out[member] = value;
  }
  return out;
}

/**
 * The rows a series operand carries.
 *
 * Both spellings a document actually has work, and neither is ambiguous
 * because a sample is an object: a path that fans out (`$.rows[*]`)
 * arrives as a sequence of rows, and a path that does not (`$.rows`)
 * arrives as the one array item that holds them. The empty sequence is
 * an empty series — no rows is data, not an error.
 *
 * @param {any} v - the evaluated operand
 * @param {string} docPath
 * @returns {any[]}
 * @throws {JsonQueryRuntimeError} JQ2001 when it is not rows at all
 */
export function seriesArg(v, docPath) {
  if (v === EMPTY)
    return [];
  if (v instanceof Seq)
    return v.items;
  if (Array.isArray(v))
    return v;
  if (v !== null && typeof v === 'object')
    return [v];
  throw queryRuntimeError('JQ2001', 'query/expected-series', { got: itemRef(v) }, docPath);
}

/**
 * One half-open interval operand: a record with a `start` and an `end`.
 * The kernel decides whether the bounds name instants and whether the
 * span is a span; this only refuses what is not a record.
 * @param {any} v
 * @param {string} docPath
 * @returns {any}
 * @throws {JsonQueryRuntimeError} JQ2001
 */
export function intervalArg(v, docPath) {
  if (v === null || typeof v !== 'object' || Array.isArray(v) || v instanceof Seq) {
    throw queryRuntimeError('JQ2001', 'query/expected-interval', { got: itemRef(v) }, docPath);
  }
  return v;
}

/**
 * The kernel's refusals, in this language's vocabulary. Everything the
 * temporal kernel throws is a `TypeError` about the DATA it was handed —
 * a row that is not a sample, an instant that names none, a local time
 * that never happened — which is exactly what `JQ2001` is for. A host
 * failure that is not a `TypeError` is not laundered.
 * @param {unknown} e
 * @param {string} docPath
 * @returns {JsonQueryRuntimeError}
 */
export function seriesRefusal(e, docPath) {
  if (!(e instanceof TypeError))
    throw e;
  return queryRuntimeError('JQ2001', 'query/detail', { detail: e.message }, docPath, { cause: e });
}

//#endregion
