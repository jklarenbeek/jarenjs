//@ts-check

//#region Availability layers
// A caller describes availability as prioritized layers - opening hours,
// a closure, a busy event, an absence - and evaluates them over a
// half-open horizon. The answer partitions the horizon into available,
// busy and unknown spans, each naming the layers that decided it.
//
// Unknown is never free. Three things make time unknown, and none of
// them reads as available:
//
//   default     no layer claims the time (unless the caller says the
//               default is busy)
//   no-zone     a floating or date layer evaluated without a zone: its
//               spans name no instant, so every instant a day either
//               side of their wall clock is unknown (no offset reaches
//               a day)
//   incomplete  an expansion stopped at a limit: from the last point
//               the answer is proven to the end of the horizon
//
// Precedence follows RFC 7953's PRIORITY: 1 is the highest, 9 the lowest
// numbered, 0 (undefined) below them all. At one instant the highest
// ranked claims decide, and among equal ranks busy beats unknown, which
// beats available - a tie never opens time. A layer without bounds
// claims only its own spans, so the time between them falls through to
// the layers below or the default. A layer with bounds is an RFC 7953
// VAVAILABILITY: an available one claims its whole bounded period, the
// time outside its spans busy at its rank, of its BUSYTYPE (default
// busy-unavailable); a busy one still claims only its spans, and its
// gaps fall through. Equal-ranked busy types combine as RFC 7953 §4
// orders them: busy over busy-unavailable over busy-tentative.

import { mergeIntervals, subtractIntervals, findSlots } from '../series/interval.js';
import { parseDuration, durationToMs } from '../dates/duration.js';
import { CalendarError } from './errors.js';
import { admitValue } from './model.js';
import { toUtc } from './bind.js';
import { admitZoneName, identityOf, providerOf } from './resolve.js';
import { admitHorizon, admitKeys, budgetOf, horizonBound, isRecord, valueAt, wallOf } from './recurrence.js';
import { expandSeries, seriesKindOf } from './series.js';

const DAY = 86400000;
/** How far from its wall clock a zone-less value can fall: no offset reaches a day. */
const NO_ZONE_REACH = DAY;

const BUSY_TYPES = /* @__PURE__ */ Object.freeze(['busy', 'busy-unavailable', 'busy-tentative']);
/** @type {Readonly<Record<string, number>>} */
/** RFC 7953 §4: at one priority BUSY > BUSY-UNAVAILABLE > BUSY-TENTATIVE. */
const BUSY_STRENGTH = /* @__PURE__ */ Object.freeze({ 'busy-tentative': 0, 'busy-unavailable': 1, 'busy': 2 });
/** The reason an unknown span names when two layers of one rank leave it unknown for different reasons. */
const REASONS = /* @__PURE__ */ Object.freeze(['no-zone', 'incomplete']);
const STATES = /* @__PURE__ */ Object.freeze(['available', 'busy', 'unknown']);

/**
 * The default slot budget of {@link findAvailableSlots}: a search that
 * would return more stops there and says so.
 * @type {Readonly<{ maxSlots: number }>}
 */
export const AVAILABILITY_LIMITS = /* @__PURE__ */ Object.freeze({ maxSlots: 10000 });

/**
 * One layer of availability. `priority` is RFC 7953's PRIORITY (1 is the
 * highest, 9 the lowest numbered, 0 below them all); `mode` says what
 * the layer's spans are; `busyType` is a busy layer's kind of busy
 * (default `'busy'`), or a bounded available layer's for the time
 * outside its spans (RFC 7953 BUSYTYPE, default `'busy-unavailable'`).
 * The spans are a series (or the list
 * `weeklyPattern` returns) or explicit `spans`; `bounds` clips them,
 * either end open, and makes an available layer claim its whole bounded
 * period (busy outside its spans), as RFC 7953 does. `source` is the caller's provenance token, carried
 * and never read; `revision` is the caller's revision of the layer's
 * data, echoed on every span the layer decides.
 * @typedef {Object} AvailabilityLayer
 * @property {string} id
 * @property {number} priority
 * @property {'available' | 'busy'} mode
 * @property {'busy' | 'busy-unavailable' | 'busy-tentative'} [busyType]
 * @property {import('./series.js').Series | readonly import('./series.js').Series[]} [series]
 * @property {readonly (AvailabilitySpan | import('./model.js').DateValue | import('./model.js').DateRangeValue)[]} [spans]
 * @property {readonly [AvailabilityBound?, AvailabilityBound?]} [bounds]
 * @property {unknown} source
 * @property {string} [revision]
 */

/**
 * An instant (epoch milliseconds) or a temporal value; a date reads as
 * its first instant, and a floating or date value needs the zone.
 * @typedef {number | import('./model.js').TemporalValue | null | undefined} AvailabilityBound
 */

/**
 * An explicit span, either end open (left out, or `null`).
 * @typedef {{ start?: AvailabilityBound, end?: AvailabilityBound }} AvailabilitySpan
 */

/**
 * A layer's name in an answer.
 * @typedef {{ readonly id: string, readonly revision?: string }} AvailabilitySource
 */

/**
 * One span of an evaluation.
 * @typedef {Object} AvailabilitySpanState
 * @property {number} start - epoch milliseconds
 * @property {number} end - epoch milliseconds, exclusive
 * @property {'available' | 'busy' | 'unknown'} state
 * @property {'busy' | 'busy-unavailable' | 'busy-tentative'} [busyType] - busy spans only
 * @property {readonly AvailabilitySource[]} sources - the layers that decided it; none for the default
 * @property {'default' | 'no-zone' | 'incomplete'} [reason] - unknown spans only
 */

/**
 * What {@link evaluateAvailability} answers: the horizon tiled by spans,
 * whether every expansion completed, the provider the instants rest on,
 * and each layer's expansion.
 * @typedef {Object} AvailabilityResult
 * @property {{ readonly start: number, readonly end: number }} horizon
 * @property {readonly AvailabilitySpanState[]} spans - ascending, tiling the horizon
 * @property {boolean} complete - no layer stopped at a limit
 * @property {{ readonly limit: string, readonly layer: string }} [stoppedAt] - an incomplete
 *   evaluation only: the first layer, in the order given, that a limit stopped, and that limit
 * @property {{ readonly name: string, readonly revision: string } | null} provider
 * @property {{ readonly zone: string, readonly source: string } | null} binding - the zone floating layers were bound to
 * @property {'unknown' | 'busy'} default
 * @property {readonly { id: string, revision?: string, source: unknown, status: 'complete' | 'incomplete',
 *   complete: boolean, limit?: string, stoppedAt?: { readonly limit: string },
 *   counts: import('./recurrence.js').RecurrenceCounts }[]} layers - `status` and `limit` are the
 *   older spelling of `complete` and `stoppedAt`
 * @property {{ layers: number, spans: number, available: number, busy: number, unknown: number,
 *   emitted: number, work: number, providerCalls: number }} counts
 */

/** @typedef {{ start: number, end: number }} Span */

/**
 * Run `fn`, re-rooting a calendar refusal's path under `path`.
 * @template T
 * @param {string} path
 * @param {() => T} fn
 * @returns {T}
 */
function under(path, fn) {
  try {
    return fn();
  }
  catch (error) {
    if (!(error instanceof CalendarError))
      throw error;
    const inner = /** @type {any} */ (error);
    const rest = typeof inner.docPath === 'string' ? inner.docPath.replace(/^\/value(?=\/|$)/, '') : '';
    throw new CalendarError(inner.code, inner.reason, `${path}${rest === '/' ? '' : rest}`, inner.cause);
  }
}

/** @param {Span[]} list @param {number} low @param {number} high @returns {Span[]} */
function clip(list, low, high) {
  /** @type {Span[]} */
  const out = [];
  for (const { start, end } of list) {
    const s = start > low ? start : low;
    const e = end < high ? end : high;
    if (s < e)
      out.push({ start: s, end: e });
  }
  return out;
}

/**
 * Where a bound falls: one instant, or - for a zone-less value with no
 * zone - every instant within a day of its wall clock.
 * @param {unknown} value
 * @param {'start' | 'end'} side
 * @param {any} context
 * @param {string} path
 * @returns {{ early: number, late: number, literal: number, family: 'instant' | 'wall', noZone: boolean }}
 */
function placeBound(value, side, context, path) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value))
      throw new CalendarError('JY0013', `an instant is whole epoch milliseconds, not ${value}`, path);
    return { early: value, late: value, literal: value, family: 'instant', noZone: false };
  }
  const admitted = /** @type {any} */ (under(path, () => admitValue(value, side, '')));
  const kind = admitted.value.kind;
  if (kind === 'date-range')
    throw new CalendarError('JY0013', 'a bound is one instant or value; a date range is a span', `${path}/kind`);
  if (kind === 'utc')
    return { early: admitted.epoch, late: admitted.epoch, literal: admitted.epoch, family: 'instant', noZone: false };
  const placed = /** @type {any} */ (under(path, () => toUtc(value, { ...context.bind, bound: side })));
  const family = kind === 'zoned' ? 'instant' : 'wall';
  const literal = wallOf(admitted);
  if (placed.kind === 'unresolved')
    return { early: literal - NO_ZONE_REACH, late: literal + NO_ZONE_REACH, literal, family, noZone: true };
  const at = placed.kind === 'span' ? placed.start : placed.instant;
  return { early: at, late: at, literal: family === 'instant' ? at : literal, family, noZone: false };
}

/**
 * The instants one explicit span covers, into `known` or `noZone`.
 * @param {unknown} span
 * @param {any} context
 * @param {string} path
 * @param {Span[]} known
 * @param {Span[]} noZone
 */
function placeSpan(span, context, path, known, noZone) {
  if (!isRecord(span))
    throw new CalendarError('JY0013', 'a span is { start?, end? }, a date value or a date-range value', path);
  if (Object.hasOwn(span, 'kind')) {
    const admitted = /** @type {any} */ (under(path, () => admitValue(span, 'start', '')));
    const kind = admitted.value.kind;
    if (kind !== 'date' && kind !== 'date-range')
      throw new CalendarError('JY0013', `a span value is a date or a date range; a ${kind} value is one instant (use { start, end })`, `${path}/kind`);
    const placed = /** @type {any} */ (under(path, () => toUtc(span, context.bind)));
    if (placed.kind === 'unresolved') {
      const wall = admitted.days * DAY;
      const endWall = (kind === 'date' ? admitted.days + 1 : admitted.endDays) * DAY;
      noZone.push({ start: wall - NO_ZONE_REACH, end: endWall + NO_ZONE_REACH });
    }
    else if (placed.start < placed.end)
      known.push({ start: placed.start, end: placed.end });
    return;
  }
  admitKeys(span, ['start', 'end'], path, 'a span');
  const open = (/** @type {unknown} */ v) => v === undefined || v === null;
  const start = open(span.start) ? null : placeBound(span.start, 'start', context, `${path}/start`);
  const end = open(span.end) ? null : placeBound(span.end, 'end', context, `${path}/end`);
  if (start !== null && end !== null && start.family === end.family && !(end.literal > start.literal))
    throw new CalendarError('JY0013', 'a span ends after it starts', `${path}/end`);
  const low = start === null ? -Infinity : start.early;
  const high = end === null ? Infinity : end.late;
  if (start?.noZone || end?.noZone)
    noZone.push({ start: low, end: high });
  else if (low < high)
    known.push({ start: low, end: high });
}

/**
 * The one kind of a layer's series (or list of series).
 * @param {unknown} series
 * @param {string} path
 * @returns {'date' | 'floating' | 'utc' | 'zoned'}
 */
function kindOfSeries(series, path) {
  const list = Array.isArray(series) ? series : [series];
  const kinds = new Set(list.map((entry) => seriesKindOf(entry)));
  if (list.length === 0 || kinds.has(undefined))
    throw new CalendarError('JY0013', 'series is a series defineSeries returned, or a list of them', path);
  if (kinds.size > 1)
    throw new CalendarError('JY0013', 'the series of one layer are all of one kind', path);
  return /** @type {any} */ ([...kinds][0]);
}

/**
 * The instants a series covers inside `[low, high)`, binding a floating
 * or date series to the zone; an incomplete expansion keeps only a
 * prefix it can prove complete, and the rest is `incompleteFrom` on.
 * @param {unknown} series
 * @param {number} low
 * @param {number} high
 * @param {any} context
 * @param {string} path
 * @param {Span[]} known
 * @param {Span[]} noZone
 * @returns {{ incompleteFrom: number | undefined, limit: string | undefined, counts: { emitted: number, work: number, providerCalls: number } }}
 */
function placeSeries(series, low, high, context, path, known, noZone) {
  const kind = kindOfSeries(series, path);
  const wall = kind === 'date' || kind === 'floating';
  // a wall-clock series is walked a day past each end: no offset reaches further
  const expLow = wall ? Math.floor((low - DAY) / DAY) * DAY : low;
  const expHigh = wall ? Math.ceil((high + DAY) / DAY) * DAY : high;
  const horizonAt = (/** @type {number} */ at) => (wall ? valueAt(at % DAY === 0 ? 'date' : 'floating', at, undefined) : at);
  const expand = (/** @type {number} */ to) => under(path, () => expandSeries(/** @type {any} */ (series), {
    horizon: [horizonAt(expLow), horizonAt(to)], limits: context.limits, ...(kind === 'zoned' ? { provider: context.provider } : {}),
  }));
  let answer = expand(expHigh);
  const counts = { ...answer.counts };
  const limit = answer.limit;
  let incompleteFrom;
  if (answer.status === 'incomplete') {
    const last = answer.occurrences.at(-1);
    let candidate;
    if (limit === 'maxOccurrences' && last !== undefined)
      candidate = last.instants?.start ?? wallOf(admitValue(last.start, 'start', ''));
    else if (limit === 'maxHorizonDays')
      candidate = expLow + context.maxHorizonDays * DAY;
    if (kind === 'date' && candidate !== undefined)
      candidate = Math.floor(candidate / DAY) * DAY;
    // only a complete answer is trusted: the prefix is re-asked, and kept if it completes
    const prefix = candidate !== undefined && candidate > expLow ? expand(candidate) : undefined;
    if (prefix !== undefined) {
      counts.emitted += prefix.counts.emitted;
      counts.work += prefix.counts.work;
      counts.providerCalls += prefix.counts.providerCalls;
    }
    if (prefix?.status === 'complete') {
      answer = prefix;
      incompleteFrom = wall ? /** @type {number} */ (candidate) - NO_ZONE_REACH : candidate;
    }
    else {
      answer = { ...answer, occurrences: [] };
      incompleteFrom = -Infinity;
    }
  }
  for (const occurrence of answer.occurrences) {
    if (!wall) {
      const at = /** @type {{ start: number, end: number }} */ (occurrence.instants);
      if (at.start < at.end)
        known.push({ start: at.start, end: at.end });
      continue;
    }
    const start = /** @type {any} */ (under(path, () => toUtc(occurrence.start, context.bind)));
    if (start.kind === 'unresolved') {
      const startWall = wallOf(admitValue(occurrence.start, 'start', ''));
      const endWall = wallOf(admitValue(occurrence.end, 'end', ''));
      noZone.push({ start: startWall - NO_ZONE_REACH, end: endWall + NO_ZONE_REACH });
      continue;
    }
    const end = /** @type {any} */ (under(path, () => toUtc(occurrence.end, { ...context.bind, bound: 'end' })));
    const s = start.kind === 'span' ? start.start : start.instant;
    const e = end.kind === 'span' ? end.start : end.instant;
    // a time a gap moved can bind after its own end; such an occurrence covers nothing
    if (s < e)
      known.push({ start: s, end: e });
  }
  return { incompleteFrom, limit, counts };
}

const LAYER_KEYS = /* @__PURE__ */ Object.freeze(['id', 'priority', 'mode', 'busyType', 'series', 'spans', 'bounds', 'source', 'revision']);

/**
 * Read one layer and place its claims inside the horizon.
 * @param {unknown} layer
 * @param {number} index
 * @param {any} context
 */
function placeLayer(layer, index, context) {
  const path = `/layers/${index}`;
  if (!isRecord(layer))
    throw new CalendarError('JY0014', 'a layer is { id, priority, mode, series | spans, bounds?, busyType?, source, revision? }', path);
  admitKeys(layer, LAYER_KEYS, path, 'a layer');
  const { id, priority, mode, busyType, revision } = layer;
  if (typeof id !== 'string' || id === '')
    throw new CalendarError('JY0014', 'a layer\'s id is a non-empty string', `${path}/id`);
  if (!Number.isInteger(priority) || priority < 0 || priority > 9)
    throw new CalendarError('JY0014', `priority is RFC 7953's 0-9 (1 the highest, 0 undefined and lowest), not ${String(priority)}`, `${path}/priority`);
  if (mode !== 'available' && mode !== 'busy')
    throw new CalendarError('JY0014', `mode is 'available' or 'busy', not ${String(mode)}`, `${path}/mode`);
  const bounded = layer.bounds !== undefined && layer.bounds !== null;
  // an unbounded available layer has no time outside its spans to type
  if (busyType !== undefined && ((mode !== 'busy' && !bounded) || !BUSY_TYPES.includes(busyType))) {
    throw new CalendarError('JY0014', mode !== 'busy' && !bounded ? 'busyType goes with mode \'busy\', or with bounds on an available layer'
      : `busyType is one of ${BUSY_TYPES.join(', ')}, not ${String(busyType)}`, `${path}/busyType`);
  }
  if (revision !== undefined && (typeof revision !== 'string' || revision === ''))
    throw new CalendarError('JY0014', 'revision is a non-empty string', `${path}/revision`);
  if (!Object.hasOwn(layer, 'source') || layer.source === undefined)
    throw new CalendarError('JY0014', 'a layer carries its source, the caller\'s provenance token', `${path}/source`);
  if ((layer.series === undefined) === (layer.spans === undefined))
    throw new CalendarError('JY0014', 'a layer has series or spans, exactly one', path);
  const bounds = layer.bounds ?? [];
  if (!Array.isArray(bounds) || bounds.length > 2)
    throw new CalendarError('JY0014', 'bounds is [start?, end?), either end open', `${path}/bounds`);
  const { low, high } = context;
  const open = (/** @type {unknown} */ v) => v === undefined || v === null;
  const from = open(bounds[0]) ? null : placeBound(bounds[0], 'start', context, `${path}/bounds/0`);
  const to = open(bounds[1]) ? null : placeBound(bounds[1], 'end', context, `${path}/bounds/1`);
  if (from !== null && to !== null && from.family === to.family && !(to.literal > from.literal))
    throw new CalendarError('JY0014', 'bounds end after they start', `${path}/bounds/1`);
  // the instants the layer surely spans, and those it may span
  const sure = { start: Math.max(low, from?.late ?? low), end: Math.min(high, to?.early ?? high) };
  const reach = { start: Math.max(low, from?.early ?? low), end: Math.min(high, to?.late ?? high) };
  /** @type {Span[]} */
  const known = [];
  /** @type {Span[]} */
  const noZone = [];
  let placed = { incompleteFrom: /** @type {number | undefined} */ (undefined), limit: /** @type {string | undefined} */ (undefined),
    counts: { emitted: 0, work: 0, providerCalls: 0 } };
  if (layer.spans !== undefined) {
    if (!Array.isArray(layer.spans))
      throw new CalendarError('JY0014', 'spans is a list', `${path}/spans`);
    layer.spans.forEach((span, i) => placeSpan(span, context, `${path}/spans/${i}`, known, noZone));
  }
  else if (reach.start < reach.end)
    placed = placeSeries(layer.series, reach.start, reach.end, context, `${path}/series`, known, noZone);
  else kindOfSeries(layer.series, `${path}/series`);
  const sureKnown = sure.start < sure.end ? clip(known, sure.start, sure.end) : [];
  // a bounded available layer claims its whole period, so where its bounds are unsure all of it is unknown
  const holds = bounded && mode === 'available';
  const unsure = reach.start < reach.end ? subtractIntervals([reach], sure.start < sure.end ? [sure] : []) : [];
  const fringe = holds ? unsure : sure.start < sure.end ? subtractIntervals(clip(known, reach.start, reach.end), [sure]) : clip(known, reach.start, reach.end);
  const unknownZone = mergeIntervals([...clip(noZone, reach.start, reach.end), ...fringe]);
  const tail = placed.incompleteFrom === undefined ? [] : clip([{ start: placed.incompleteFrom, end: Infinity }], reach.start, reach.end);
  const incomplete = tail.length === 0 ? [] : subtractIntervals(tail, unknownZone);
  const claimed = subtractIntervals(sureKnown, [...unknownZone, ...incomplete]);
  // inside its bounds, an available layer's time outside its spans is busy at its rank, of its busy type
  const gaps = holds && sure.start < sure.end ? subtractIntervals([sure], [...sureKnown, ...unknownZone, ...incomplete]) : [];
  /** @type {{ start: number, end: number, claim: string }[]} */
  const pieces = [];
  for (const span of claimed)
    pieces.push({ ...span, claim: mode });
  for (const span of gaps)
    pieces.push({ ...span, claim: 'gap' });
  for (const span of unknownZone)
    pieces.push({ ...span, claim: 'no-zone' });
  for (const span of incomplete)
    pieces.push({ ...span, claim: 'incomplete' });
  const source = revision === undefined ? Object.freeze({ id }) : Object.freeze({ id, revision });
  return {
    id, rank: priority === 0 ? 10 : priority, busyType: busyType ?? (mode === 'busy' ? 'busy' : 'busy-unavailable'), source, pieces,
    entry: Object.freeze({
      ...source, source: layer.source, status: placed.incompleteFrom === undefined ? 'complete' : 'incomplete',
      complete: placed.incompleteFrom === undefined,
      ...(placed.incompleteFrom !== undefined ? { limit: placed.limit, stoppedAt: Object.freeze({ limit: placed.limit }) } : {}),
      counts: Object.freeze(placed.counts),
    }),
  };
}

const OPTION_KEYS = /* @__PURE__ */ Object.freeze(['horizon', 'zone', 'zoneSource', 'zoneProvider', 'provider', 'runtime', 'policy', 'limits', 'default']);

/**
 * Evaluate availability layers over a half-open horizon: the horizon cut
 * into ascending, non-overlapping spans that are `available`, `busy`
 * (with a `busyType`) or `unknown` (with a `reason`), each naming the
 * layers that decided it.
 *
 * - At each instant the highest-ranked claims decide (RFC 7953: priority
 *   1 the highest, 9 the lowest numbered, 0 below them all); among
 *   equal ranks busy beats unknown beats available, and busy types
 *   combine as RFC 7953 §4 orders them: `busy` over `busy-unavailable`
 *   over `busy-tentative`.
 * - A layer without `bounds` claims only its spans. A layer with
 *   `bounds` (either end open) is an RFC 7953 VAVAILABILITY: an
 *   available one claims its whole bounded period, the time outside its
 *   spans busy at its rank, of its `busyType` (RFC 7953 BUSYTYPE,
 *   default `busy-unavailable`), and sourced to it; a busy one claims
 *   only its spans, and its gaps fall through.
 * - Open bounds are clipped to the horizon before any algebra.
 * - Floating and date layers bind through {@link bindFloating} to
 *   `zone` (recorded with `zoneSource`). Without a zone their spans are
 *   `unknown` with `reason: 'no-zone'` over every instant a day either
 *   side of their wall clock - never available.
 * - A series is expanded under `limits` (each layer its own budget). An
 *   expansion that stops keeps the prefix it can prove complete, and the
 *   rest of its reach is `unknown` with `reason: 'incomplete'`; the
 *   layer's entry in `layers` names the limit and its counts.
 * - Time no layer claims is `unknown` with `reason: 'default'`, or busy
 *   (`busy-unavailable`) with `default: 'busy'`. Nothing is available
 *   unless a layer says so.
 *
 * @param {readonly AvailabilityLayer[]} layers
 * @param {{ horizon: [unknown, unknown], zone?: string | null, zoneSource?: string,
 *   policy?: 'rfc5545' | 'later' | 'reject',
 *   limits?: import('./recurrence.js').RecurrenceLimits, default?: 'unknown' | 'busy' }
 *   & import('./resolve.js').ZoneProviderOptions} options -
 *   the horizon in epoch milliseconds or utc values
 * @returns {AvailabilityResult}
 * @throws {CalendarError} `JY0014` for a malformed layer or option, `JY0013`
 *   for a malformed span or bound, and what binding and expansion throw
 *   (a missing `policy` with a zone is `JY0006`)
 * @example
 * const result = evaluateAvailability([
 *   { id: 'hours', priority: 5, mode: 'available', series: weeklyPattern({ days: { mon: [['09:00', '17:00']] } }), source: 'contract' },
 *   { id: 'leave', priority: 1, mode: 'busy', spans: [dateValue('2026-03-02')], source: 'leave' },
 * ], { horizon: [utcValue('2026-03-02T00:00:00Z'), utcValue('2026-03-10T00:00:00Z')],
 *   zone: 'Europe/Amsterdam', zoneSource: 'location', provider, policy: 'rfc5545' });
 */
export function evaluateAvailability(layers, options) {
  if (!isRecord(options))
    throw new CalendarError('JY0014', 'evaluation options are { horizon, zone?, zoneSource?, zoneProvider?, runtime?, policy?, limits?, default? }', '/options');
  admitKeys(options, OPTION_KEYS, '/options', 'an availability evaluation');
  const [low, high] = admitHorizon('utc', options.horizon);
  const fallback = options.default ?? 'unknown';
  if (fallback !== 'unknown' && fallback !== 'busy')
    throw new CalendarError('JY0014', `default is 'unknown' or 'busy', never available; not ${String(fallback)}`, '/options/default');
  const zone = options.zone === undefined || options.zone === null ? null : under('/options', () => admitZoneName(options.zone));
  const provider = providerOf(options);
  if (provider !== undefined && !isRecord(provider))
    throw new CalendarError('JY0004', 'the provider is an object with the seam\'s members', '/options/provider');
  const identity = provider === undefined ? null : under('/options', () => identityOf(provider));
  const budget = budgetOf(options.limits);
  if (!Array.isArray(layers))
    throw new CalendarError('JY0014', 'layers is a list', '/layers');
  const bind = { zone, source: options.zoneSource, provider, policy: options.policy };
  const context = { low, high, bind, provider, limits: options.limits, maxHorizonDays: budget.limits.maxHorizonDays };
  const ids = new Set();
  const placed = layers.map((layer, i) => {
    const one = placeLayer(layer, i, context);
    if (ids.has(one.id))
      throw new CalendarError('JY0014', `two layers are named '${one.id}'`, `/layers/${i}/id`);
    ids.add(one.id);
    return one;
  });
  const spans = combine(placed, low, high, fallback);
  const counts = { layers: placed.length, spans: spans.length, available: 0, busy: 0, unknown: 0, emitted: 0, work: 0, providerCalls: 0 };
  for (const span of spans)
    counts[span.state]++;
  for (const { entry } of placed) {
    counts.emitted += entry.counts.emitted;
    counts.work += entry.counts.work;
    counts.providerCalls += entry.counts.providerCalls;
  }
  // the first layer, in the order given, that a limit stopped
  const stopped = placed.find(({ entry }) => entry.status !== 'complete')?.entry;
  return Object.freeze({
    horizon: Object.freeze({ start: low, end: high }),
    spans: Object.freeze(spans),
    complete: stopped === undefined,
    ...(stopped === undefined ? {} : { stoppedAt: Object.freeze({ limit: stopped.limit, layer: stopped.id }) }),
    provider: identity,
    binding: zone === null ? null : Object.freeze({ zone, source: options.zoneSource ?? 'unrecorded' }),
    default: fallback,
    layers: Object.freeze(placed.map(({ entry }) => entry)),
    counts: Object.freeze(counts),
  });
}

/**
 * Sweep every layer's claims into the spans of the answer.
 * @param {ReturnType<typeof placeLayer>[]} placed
 * @param {number} low
 * @param {number} high
 * @param {'unknown' | 'busy'} fallback
 * @returns {AvailabilitySpanState[]}
 */
function combine(placed, low, high, fallback) {
  /** @type {[number, number, number][]} at, +1 or -1, piece index */
  const events = [];
  /** @type {{ layer: number, claim: string }[]} */
  const pieces = [];
  placed.forEach((layer, l) => {
    for (const piece of layer.pieces) {
      events.push([piece.start, 1, pieces.length], [piece.end, -1, pieces.length]);
      pieces.push({ layer: l, claim: piece.claim });
    }
  });
  // at one instant a piece ends before the next begins: one layer's pieces touch, never overlap
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  /** @type {(string | null)[]} what each layer claims now (its pieces never overlap) */
  const claims = placed.map(() => null);
  /** @type {number[]} how many layers of each rank claim now */
  const ranks = new Array(11).fill(0);
  /** @type {number[][]} */
  const byRank = Array.from({ length: 11 }, () => []);
  placed.forEach((layer, l) => byRank[layer.rank].push(l));
  /** @type {AvailabilitySpanState[]} */
  const out = [];
  let at = low;
  let e = 0;
  /** @type {string} */
  let lastKey = '';
  while (at < high) {
    while (e < events.length && events[e][0] <= at) {
      const [, delta, p] = events[e++];
      const { layer, claim } = pieces[p];
      claims[layer] = delta > 0 ? claim : null;
      ranks[placed[layer].rank] += delta;
    }
    const next = e < events.length && events[e][0] < high ? events[e][0] : high;
    const span = decide(placed, claims, ranks, byRank, fallback);
    const key = `${span.state}|${span.busyType ?? ''}|${span.reason ?? ''}|${span.sources.map((s) => s.id).join('\u0000')}`;
    if (out.length > 0 && key === lastKey)
      out[out.length - 1].end = next;
    else {
      out.push({ start: at, end: next, ...span });
      lastKey = key;
    }
    at = next;
  }
  return out.map((span) => Object.freeze(span));
}

/**
 * The state of one elementary span from the claims of its top rank.
 * @param {ReturnType<typeof placeLayer>[]} placed
 * @param {(string | null)[]} claims
 * @param {number[]} ranks
 * @param {number[][]} byRank
 * @param {'unknown' | 'busy'} fallback
 * @returns {Omit<AvailabilitySpanState, 'start' | 'end'>}
 */
function decide(placed, claims, ranks, byRank, fallback) {
  const top = ranks.findIndex((n) => n > 0);
  if (top < 0) {
    return fallback === 'busy'
      ? { state: 'busy', busyType: 'busy-unavailable', sources: Object.freeze([]) }
      : { state: 'unknown', sources: Object.freeze([]), reason: 'default' };
  }
  /** @type {Record<string, AvailabilitySource[]>} */
  const found = { available: [], busy: [], unknown: [] };
  let busyType = 'busy-tentative';
  let reason = 'incomplete';
  for (const l of byRank[top]) {
    const claim = claims[l];
    if (claim === null)
      continue;
    const layer = placed[l];
    if (claim === 'busy' || claim === 'gap') {
      found.busy.push(layer.source);
      if (BUSY_STRENGTH[layer.busyType] > BUSY_STRENGTH[busyType])
        busyType = layer.busyType;
    }
    else if (claim === 'available')
      found.available.push(layer.source);
    else {
      found.unknown.push(layer.source);
      if (REASONS.indexOf(claim) < REASONS.indexOf(reason))
        reason = claim;
    }
  }
  const byId = (/** @type {AvailabilitySource} */ a, /** @type {AvailabilitySource} */ b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  if (found.busy.length > 0)
    return { state: 'busy', busyType: /** @type {any} */ (busyType), sources: Object.freeze(found.busy.sort(byId)) };
  if (found.unknown.length > 0)
    return { state: 'unknown', sources: Object.freeze(found.unknown.sort(byId)), reason: /** @type {any} */ (reason) };
  return { state: 'available', sources: Object.freeze(found.available.sort(byId)) };
}
//#endregion

//#region Reading an answer
/** @type {WeakSet<object>} answers already read, so a hot loop of questions pays once */
const ADMITTED = new WeakSet();

/**
 * Read an answer of {@link evaluateAvailability} - the frozen one, or one
 * that went through JSON and back.
 * @param {unknown} result
 * @returns {AvailabilityResult}
 */
export function admitResult(result) {
  if (result !== null && typeof result === 'object' && ADMITTED.has(result))
    return /** @type {AvailabilityResult} */ (result);
  const shape = 'an evaluation is what evaluateAvailability answers: { horizon, spans, ... }';
  if (!isRecord(result) || !isRecord(result.horizon) || !Array.isArray(result.spans))
    throw new CalendarError('JY0014', shape, '/result');
  const { start, end } = result.horizon;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || !(end > start))
    throw new CalendarError('JY0014', 'the horizon is { start, end } in whole epoch milliseconds', '/result/horizon');
  let at = start;
  result.spans.forEach((/** @type {any} */ span, /** @type {number} */ i) => {
    if (!isRecord(span) || span.start !== at || !Number.isSafeInteger(span.end) || !(span.end > span.start)
      || !STATES.includes(span.state) || !Array.isArray(span.sources)) {
      throw new CalendarError('JY0014', 'the spans are { start, end, state, sources } tiling the horizon in order', `/result/spans/${i}`);
    }
    // a busy type is what free/busy shows: only a busy span has one, and only one of the three
    if (span.state === 'busy' ? !BUSY_TYPES.includes(span.busyType) : span.busyType !== undefined)
      throw new CalendarError('JY0014', `a busy span's busyType is one of ${BUSY_TYPES.join(', ')}, and no other span has one`, `/result/spans/${i}/busyType`);
    at = span.end;
  });
  if (at !== end)
    throw new CalendarError('JY0014', 'the spans tile the horizon to its end', '/result/spans');
  ADMITTED.add(result);
  return /** @type {AvailabilityResult} */ (result);
}

/**
 * Is the whole of `interval` available? One unknown or busy instant
 * makes it not, and the answer says which:
 *
 * - `state` is `'available'` only when every instant is; `'busy'` when
 *   any instant is busy; otherwise `'unknown'` (time outside the
 *   evaluated horizon is unknown with `reason: 'outside-horizon'`).
 * - `reasons` lists every span of the interval that is not available,
 *   clipped to it, with its state, busy type or reason, and sources.
 * - `sources` names the layers that decided the answer: the available
 *   layers when it is available, else those behind its `reasons`.
 *
 * @param {AvailabilityResult} result
 * @param {{ start: unknown, end: unknown }} interval - epoch milliseconds or utc values
 * @returns {{ readonly state: 'available' | 'busy' | 'unknown',
 *   readonly reasons: readonly Readonly<Omit<AvailabilitySpanState, 'reason'> & { reason?: string }>[],
 *   readonly sources: readonly AvailabilitySource[] }}
 * @throws {CalendarError} `JY0014` for a malformed result or interval
 * @example
 * availabilityOf(result, { start: utcValue('2026-03-03T09:00:00Z'), end: utcValue('2026-03-03T12:00:00Z') }).state; // 'available'
 */
export function availabilityOf(result, interval) {
  const { horizon, spans } = admitResult(result);
  if (!isRecord(interval))
    throw new CalendarError('JY0014', 'the interval is { start, end }', '/interval');
  admitKeys(interval, ['start', 'end'], '/interval', 'an interval');
  const start = horizonBound('utc', interval.start, 'start', '/interval/start');
  const end = horizonBound('utc', interval.end, 'end', '/interval/end');
  if (!(end > start))
    throw new CalendarError('JY0014', 'the interval ends after it starts', '/interval/end');
  /** @type {any[]} */
  const reasons = [];
  /** @type {Map<string, AvailabilitySource>} */
  const available = new Map();
  if (start < horizon.start)
    reasons.push(Object.freeze({ start, end: Math.min(end, horizon.start), state: 'unknown', sources: Object.freeze([]), reason: 'outside-horizon' }));
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (spans[mid].end <= start)
      lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < spans.length && spans[i].start < end; i++) {
    const span = spans[i];
    if (span.state === 'available') {
      for (const source of span.sources)
        available.set(source.id, source);
      continue;
    }
    reasons.push(Object.freeze({ ...span, start: Math.max(span.start, start), end: Math.min(span.end, end) }));
  }
  if (end > horizon.end)
    reasons.push(Object.freeze({ start: Math.max(start, horizon.end), end, state: 'unknown', sources: Object.freeze([]), reason: 'outside-horizon' }));
  const state = reasons.length === 0 ? 'available' : reasons.some((r) => r.state === 'busy') ? 'busy' : 'unknown';
  /** @type {Map<string, AvailabilitySource>} */
  const decided = new Map();
  if (state !== 'available') {
    for (const reason of reasons) {
      for (const source of reason.sources)
        decided.set(source.id, source);
    }
  }
  const sources = [...(state === 'available' ? available : decided).values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return Object.freeze({ state, reasons: Object.freeze(reasons), sources: Object.freeze(sources) });
}

/**
 * A positive fixed width in milliseconds.
 * @param {unknown} spec
 * @param {string} path
 * @returns {number}
 */
function widthOf(spec, path) {
  let ms = spec;
  if (typeof spec === 'string') {
    const parts = parseDuration(spec);
    ms = parts === null ? NaN : durationToMs(parts);
  }
  if (typeof ms !== 'number' || !Number.isSafeInteger(ms) || ms <= 0)
    throw new CalendarError('JY0014', 'a width is a positive whole number of milliseconds or a fixed ISO 8601 duration (PT30M)', path);
  return ms;
}

const SLOT_KEYS = /* @__PURE__ */ Object.freeze(['duration', 'step', 'alignment', 'limits']);

/**
 * Every place a span of `duration` fits inside the available time of an
 * evaluation - never in unknown or busy time. It is `findSlots` over the
 * available spans only: touching available spans are one window, each
 * window is walked from its first start in `step` increments (default:
 * back to back, or the alignment when one is given), and every start is
 * a multiple of `alignment` counted from the epoch (UTC) when given.
 * A search that would pass `limits.maxSlots` (default 10000) stops
 * there: `complete: false` with `stoppedAt: { limit: 'maxSlots' }`
 * (and, in the older spelling, `status: 'incomplete'` with
 * `limit: 'maxSlots'`).
 * @param {AvailabilityResult} result
 * @param {{ duration: number | string, step?: number | string, alignment?: number | string,
 *   limits?: { maxSlots?: number } }} options - widths in milliseconds or fixed ISO 8601 durations
 * @returns {{ readonly status: 'complete' | 'incomplete', readonly complete: boolean,
 *   readonly slots: readonly { start: number, end: number }[],
 *   readonly counts: { readonly emitted: number }, readonly limit?: 'maxSlots',
 *   readonly stoppedAt?: { readonly limit: 'maxSlots' } }}
 * @throws {CalendarError} `JY0014` for a malformed result or option, or a
 *   step that is not a multiple of the alignment
 * @example
 * findAvailableSlots(result, { duration: 'PT1H', alignment: 'PT30M' }).slots[0];
 */
export function findAvailableSlots(result, options) {
  const { spans } = admitResult(result);
  if (!isRecord(options))
    throw new CalendarError('JY0014', 'slot options are { duration, step?, alignment?, limits? }', '/options');
  admitKeys(options, SLOT_KEYS, '/options', 'a slot search');
  const duration = widthOf(options.duration, '/options/duration');
  const alignment = options.alignment === undefined ? undefined : widthOf(options.alignment, '/options/alignment');
  const step = options.step === undefined ? alignment ?? duration : widthOf(options.step, '/options/step');
  if (alignment !== undefined && step % alignment !== 0)
    throw new CalendarError('JY0014', 'the step is a multiple of the alignment, so every start stays aligned', '/options/step');
  let maxSlots = AVAILABILITY_LIMITS.maxSlots;
  if (options.limits !== undefined) {
    if (!isRecord(options.limits))
      throw new CalendarError('JY0014', 'limits is { maxSlots? }', '/options/limits');
    admitKeys(options.limits, ['maxSlots'], '/options/limits', 'slot limits');
    if (options.limits.maxSlots !== undefined) {
      maxSlots = options.limits.maxSlots;
      if (!Number.isSafeInteger(maxSlots) || maxSlots < 0)
        throw new CalendarError('JY0014', 'maxSlots is a whole number from 0', '/options/limits/maxSlots');
    }
  }
  const open = spans.filter((span) => span.state === 'available').map(({ start, end }) => ({ start, end }));
  /** @type {Span[]} */
  const slots = [];
  let limited = false;
  for (const window of open.length === 0 ? [] : mergeIntervals(open)) {
    const first = alignment === undefined ? window.start : Math.ceil(window.start / alignment) * alignment;
    if (first + duration > window.end)
      continue;
    const fits = Math.floor((window.end - duration - first) / step) + 1;
    const take = Math.min(fits, maxSlots - slots.length);
    if (take > 0) {
      // pushed one by one: a raised limit can put more slots in one window than a call takes arguments
      for (const slot of findSlots([{ start: first, end: first + (take - 1) * step + duration }], { duration, step }))
        slots.push(slot);
    }
    if (take < fits) {
      limited = true;
      break;
    }
  }
  return Object.freeze({
    status: limited ? 'incomplete' : 'complete',
    complete: !limited,
    slots: Object.freeze(slots.map((slot) => Object.freeze(slot))),
    counts: Object.freeze({ emitted: slots.length }),
    ...(limited ? { limit: /** @type {const} */ ('maxSlots'), stoppedAt: Object.freeze({ limit: /** @type {const} */ ('maxSlots') }) } : {}),
  });
}
//#endregion

