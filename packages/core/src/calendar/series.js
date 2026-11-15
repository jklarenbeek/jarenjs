//@ts-check

//#region Recurring series
// A series is one recurrence (or none) plus its extra dates (RDATE), its
// excluded dates (EXDATE) and its per-occurrence overrides, read into
// one occurrence set in a fixed order:
//
//   1. the rule's occurrences and the RDATEs together, one per
//      recurrenceId (an RDATE's length wins over the rule's);
//   2. minus the EXDATEs;
//   3. with the overrides applied by recurrenceId: a cancelled slot
//      disappears, a moved one keeps its recurrenceId with its new start
//      and end and `moved: true`.
//
// An override is looked up by its slot, not found by walking the whole
// series: a slot outside the horizon moved into it is asked of the rule
// at that one wall clock. An override whose slot the series never makes
// is an orphan, reported and never applied.

import { civilFromDays, daysFromCivil, isoWeekdayFromDays } from '../dates/civil.js';
import { CalendarError } from './errors.js';
import { admitValue, FIRST_DAY, LAST_DAY } from './model.js';
import {
  admitHorizon, admitKeys, answer, budgetOf, compileRecurrence, exactLength, expandPlan, inHorizon, isRecord, placeZoned,
  planFor, recurrenceIdOf, resolveWall, valueAt, walk, wallOf,
} from './recurrence.js';
import { admitProvider, identityOf } from './resolve.js';
import { WEEKDAYS } from './rrule.js';

const DAY = 86400000;
/** Wider than any zone offset either way. */
const MARGIN = 3 * DAY;
const ID_FORM = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(Z)?)?$/;

/**
 * An override of one slot of a series.
 * @typedef {Object} SeriesOverride
 * @property {string} recurrenceId - the slot, as an occurrence spells it
 * @property {'moved' | 'cancelled'} status
 * @property {import('./recurrence.js').StartValue} [start] - moved: the new start
 * @property {import('./recurrence.js').StartValue} [end] - moved: the new end; left out, the slot keeps its length
 * @property {unknown} [payload] - the caller's own data, carried on the moved occurrence and never read
 * @property {'THISANDFUTURE'} [range] - kept as data; expansion refuses it (`JY0021`)
 */

/**
 * A period an RDATE names: a start and an exclusive end of one kind.
 * @typedef {{ start: import('./recurrence.js').StartValue, end: import('./recurrence.js').StartValue }} SeriesPeriod
 */

/**
 * @typedef {Object} Series
 * @property {'series'} kind
 * @property {string} uid
 * @property {number} [sequence]
 * @property {string} [revision]
 * @property {import('./recurrence.js').CompiledRecurrence | null} base
 * @property {readonly (import('./recurrence.js').StartValue | SeriesPeriod)[]} rdates
 * @property {readonly import('./recurrence.js').StartValue[]} exdates
 * @property {readonly SeriesOverride[]} overrides
 */

/**
 * An occurrence of a series: a recurrence occurrence with the series'
 * `uid`, its `seriesRevision` when it has one, and `moved` and `payload`
 * when an override moved it.
 * @typedef {import('./recurrence.js').Occurrence & { uid: string, seriesRevision?: string, moved?: true, payload?: unknown }} SeriesOccurrence
 */

/**
 * @typedef {Object} SeriesExpansion
 * @property {'complete' | 'incomplete'} status
 * @property {readonly SeriesOccurrence[]} occurrences - in order of start
 * @property {import('./recurrence.js').RecurrenceCounts} counts
 * @property {import('./recurrence.js').RecurrenceExpansion['limit']} [limit]
 * @property {{ readonly count: number, readonly ids: readonly string[] }} orphans - overrides whose slot the series never makes
 */

/**
 * @typedef {Object} SeriesPlan
 * @property {string} uid
 * @property {string | undefined} revision
 * @property {'date' | 'floating' | 'utc' | 'zoned'} kind
 * @property {string | undefined} zone
 * @property {import('./recurrence.js').Plan | null} plan
 * @property {Map<string, { wall: number, endWall: number | undefined }>} rdates
 * @property {Set<string>} exdates
 * @property {Map<string, { status: 'moved' | 'cancelled', wall?: number, endWall?: number, payload?: unknown, hasPayload: boolean, index: number, range?: string }>} overrides
 */

/** @type {WeakMap<object, SeriesPlan>} */
const SERIES = new WeakMap();

/**
 * Read a start value of the series' kind (and zone) on a whole second.
 * @param {unknown} value
 * @param {'start' | 'end'} side
 * @param {string} path
 * @param {{ kind?: string, zone?: string }} shape - filled from the first value when empty
 * @returns {number} its wall clock (an instant for utc)
 */
function readStart(value, side, path, shape) {
  const admitted = /** @type {any} */ (admitValue(value, side, path));
  const kind = admitted.value.kind;
  if (kind === 'date-range')
    throw new CalendarError('JY0013', 'a series slot is a date, floating, utc or zoned value, not a date range', `${path}/kind`);
  if (shape.kind === undefined) {
    shape.kind = kind;
    shape.zone = admitted.value.zone;
  }
  if (kind !== shape.kind)
    throw new CalendarError('JY0013', `the series is of ${shape.kind} values, not ${kind}`, `${path}/kind`);
  if (kind === 'zoned' && admitted.value.zone !== shape.zone)
    throw new CalendarError('JY0013', `the series is in '${shape.zone}', not '${admitted.value.zone}'`, `${path}/zone`);
  const wall = wallOf(admitted);
  if (wall % 1000 !== 0)
    throw new CalendarError('JY0013', 'a series slot falls on a whole second, as its recurrenceId does', path);
  return wall;
}

/**
 * The wall clock a recurrenceId names, refusing any but the canonical
 * spelling of the series' kind.
 * @param {unknown} id
 * @param {string} kind
 * @param {string} path
 * @returns {number}
 */
function readId(id, kind, path) {
  const form = typeof id === 'string' ? ID_FORM.exec(id) : null;
  if (form !== null) {
    const days = daysFromCivil(Number(form[1]), Number(form[2]), Number(form[3]));
    const wall = days * DAY + ((Number(form[4] ?? 0) * 60 + Number(form[5] ?? 0)) * 60 + Number(form[6] ?? 0)) * 1000;
    const civil = civilFromDays(days);
    if (civil.month === Number(form[2]) && civil.day === Number(form[3]) && days >= FIRST_DAY
      && recurrenceIdOf(/** @type {any} */ (kind), wall) === id)
      return wall;
  }
  const spelling = kind === 'date' ? 'YYYY-MM-DD' : kind === 'utc' ? 'YYYY-MM-DDTHH:MM:SSZ' : 'YYYY-MM-DDTHH:MM:SS';
  throw new CalendarError('JY0014', `a recurrenceId of a ${kind} series is spelled ${spelling}, not ${
    typeof id === 'string' ? `'${id}'` : typeof id}`, path);
}

/**
 * Define a recurring series: a compiled recurrence (or `null`), extra
 * dates, excluded dates and overrides. Every input is read and frozen
 * here; nothing is expanded.
 *
 * - `rdates` are values of the series' kind, or periods `{ start, end }`
 *   whose length overrides the rule's.
 * - `exdates` are values of the series' kind; each removes the slot it
 *   names.
 * - `overrides` are `{ recurrenceId, status: 'moved' | 'cancelled',
 *   start?, end?, payload?, range? }`, one per recurrenceId. A moved
 *   override names its new `start` (and `end`, or keeps the slot's
 *   length); `payload` is carried, never read.
 * - All values share the base's kind (and zone, for a zoned series).
 * @param {{ uid: string, sequence?: number, revision?: string, base?: import('./recurrence.js').CompiledRecurrence | null,
 *   rdates?: (import('./recurrence.js').StartValue | SeriesPeriod)[], exdates?: import('./recurrence.js').StartValue[],
 *   overrides?: SeriesOverride[] }} definition
 * @returns {Series}
 * @throws {CalendarError} `JY0014` for a malformed member or a
 *   recurrenceId given twice, `JY0013` for a value of another kind
 * @example
 * defineSeries({
 *   uid: 'standup',
 *   base: compileRecurrence({ dtstart: floatingValue('2026-01-05', '09:00'), duration: 'PT15M', rrule: 'FREQ=WEEKLY;BYDAY=MO,WE' }),
 *   exdates: [floatingValue('2026-01-07', '09:00')],
 *   overrides: [{ recurrenceId: '2026-01-12T09:00:00', status: 'cancelled' }],
 * });
 */
export function defineSeries(definition) {
  if (!isRecord(definition))
    throw new CalendarError('JY0014', 'a series is defined by { uid, base, rdates, exdates, overrides }', '/');
  admitKeys(definition, ['uid', 'sequence', 'revision', 'base', 'rdates', 'exdates', 'overrides'], '', 'a series');
  const { uid, sequence, revision } = definition;
  if (typeof uid !== 'string' || uid === '')
    throw new CalendarError('JY0014', 'uid is a non-empty string', '/uid');
  if (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 0))
    throw new CalendarError('JY0014', 'sequence is a whole number from 0', '/sequence');
  if (revision !== undefined && (typeof revision !== 'string' || revision === ''))
    throw new CalendarError('JY0014', 'revision is a non-empty string', '/revision');
  const base = definition.base ?? null;
  const plan = base === null ? null : planFor(base);
  /** @type {{ kind?: any, zone?: string }} */
  const shape = plan === null ? {} : { kind: plan.kind, zone: plan.zone };
  const lists = /** @type {const} */ (['rdates', 'exdates', 'overrides']);
  for (const name of lists) {
    if (definition[name] !== undefined && !Array.isArray(definition[name]))
      throw new CalendarError('JY0014', `${name} is a list`, `/${name}`);
  }
  const rdatesIn = definition.rdates ?? [];
  if (plan === null && rdatesIn.length === 0)
    throw new CalendarError('JY0014', 'a series has a base recurrence, rdates, or both', '/base');
  /** @type {SeriesPlan['rdates']} */
  const rdates = new Map();
  const rdatesOut = rdatesIn.map((entry, i) => {
    const path = `/rdates/${i}`;
    const period = isRecord(entry) && !Object.hasOwn(entry, 'kind');
    if (period && Object.keys(entry).some((key) => key !== 'start' && key !== 'end'))
      throw new CalendarError('JY0014', 'a period is { start, end }', path);
    const wall = readStart(period ? entry.start : entry, 'start', period ? `${path}/start` : path, shape);
    let endWall;
    if (period) {
      endWall = readStart(entry.end, 'end', `${path}/end`, shape);
      if (endWall < wall)
        throw new CalendarError('JY0014', 'a period ends at or after its start', `${path}/end`);
    }
    const id = recurrenceIdOf(shape.kind, wall);
    if (!rdates.has(id))
      rdates.set(id, { wall, endWall });
    return period ? Object.freeze({ start: entry.start, end: entry.end }) : entry;
  });
  const exdates = new Set();
  const exdatesOut = (definition.exdates ?? []).map((entry, i) => {
    exdates.add(recurrenceIdOf(shape.kind, readStart(entry, 'start', `/exdates/${i}`, shape)));
    return entry;
  });
  /** @type {SeriesPlan['overrides']} */
  const overrides = new Map();
  const overridesOut = (definition.overrides ?? []).map((entry, i) => {
    const path = `/overrides/${i}`;
    if (!isRecord(entry))
      throw new CalendarError('JY0014', 'an override is { recurrenceId, status, start?, end?, payload?, range? }', path);
    for (const key of Object.keys(entry)) {
      if (!['recurrenceId', 'status', 'start', 'end', 'payload', 'range'].includes(key))
        throw new CalendarError('JY0014', `an override carries no '${key}'`, `${path}/${key}`);
    }
    const id = entry.recurrenceId;
    readId(id, shape.kind, `${path}/recurrenceId`);
    if (overrides.has(id))
      throw new CalendarError('JY0014', `the slot ${id} has two overrides`, `${path}/recurrenceId`);
    if (entry.range !== undefined && entry.range !== 'THISANDFUTURE')
      throw new CalendarError('JY0014', `range is 'THISANDFUTURE' or absent, not ${String(entry.range)}`, `${path}/range`);
    /** @type {any} */
    const read = { status: entry.status, payload: entry.payload, hasPayload: Object.hasOwn(entry, 'payload'), index: i, range: entry.range };
    if (entry.status === 'moved') {
      if (entry.start === undefined)
        throw new CalendarError('JY0014', 'a moved override names its new start', `${path}/start`);
      read.wall = readStart(entry.start, 'start', `${path}/start`, shape);
      if (entry.end !== undefined) {
        read.endWall = readStart(entry.end, 'end', `${path}/end`, shape);
        if (read.endWall < read.wall)
          throw new CalendarError('JY0014', 'a moved override ends at or after its start', `${path}/end`);
      }
    }
    else if (entry.status === 'cancelled') {
      for (const key of ['start', 'end']) {
        if (entry[key] !== undefined)
          throw new CalendarError('JY0014', `a cancelled override has no ${key}`, `${path}/${key}`);
      }
    }
    else
      throw new CalendarError('JY0014', `status is 'moved' or 'cancelled', not ${String(entry.status)}`, `${path}/status`);
    overrides.set(id, read);
    return Object.freeze({ ...entry });
  });
  const series = Object.freeze({
    kind: /** @type {'series'} */ ('series'),
    uid,
    ...(sequence !== undefined ? { sequence } : {}),
    ...(revision !== undefined ? { revision } : {}),
    base,
    rdates: Object.freeze(rdatesOut),
    exdates: Object.freeze(exdatesOut),
    overrides: Object.freeze(overridesOut),
  });
  SERIES.set(series, { uid, revision, kind: shape.kind, zone: shape.zone, plan, rdates, exdates, overrides });
  return series;
}

/**
 * What a series expansion shares across its series.
 * @typedef {Object} Context
 * @property {import('./recurrence.js').Budget} budget
 * @property {number} low
 * @property {number} high
 * @property {any} resolver - a zoned series' resolver (its zone set per series)
 */

/**
 * Build an occurrence from a start wall clock and an explicit end or a
 * length; `undefined` when the budget ran out, `null` when it falls
 * outside the horizon.
 * @param {SeriesPlan} series
 * @param {Context} context
 * @param {string} id
 * @param {number} wall
 * @param {number | undefined} endWall
 * @param {{ days: number, exact: number }} length
 * @returns {undefined | null | { occurrence: any, key: number }}
 */
function build(series, context, id, wall, endWall, length) {
  const { kind, zone } = series;
  const { budget, low, high } = context;
  if (kind !== 'zoned') {
    const end = endWall ?? wall + length.days * DAY + length.exact;
    if (!inHorizon(wall, end, low, high))
      return null;
    if (Math.floor(end / DAY) > LAST_DAY) {
      budget.limit = 'calendar-end';
      return null;
    }
    /** @type {any} */
    const occurrence = { recurrenceId: id, start: valueAt(kind, wall, undefined), end: valueAt(kind, end, undefined) };
    if (kind === 'utc')
      occurrence.instants = Object.freeze({ start: wall, end });
    return { occurrence, key: wall };
  }
  const resolver = { ...context.resolver, zone };
  const at = resolveWall(resolver, budget, wall);
  if (at === undefined)
    return undefined;
  const placed = placeZoned(resolver, budget, id, at, wall, endWall, length, low, high);
  if (placed === undefined)
    return undefined;
  if (placed === false)
    budget.limit = 'calendar-end';
  return placed ? { occurrence: placed, key: at.instant } : null;
}

/**
 * Whether the base rule makes a slot: a walk over that one wall clock,
 * and, for a zoned rule ending at a UTC UNTIL,, that clock resolved and
 * compared with it (one provider call). `undefined` when the budget ran
 * out first.
 * @param {import('./recurrence.js').Plan} plan
 * @param {Context} context
 * @param {number} wall
 * @returns {boolean | undefined}
 */
function baseMakes(plan, context, wall) {
  let found = false;
  const reason = walk(plan, wall, wall, context.budget, () => {
    found = true;
    return 'stopped';
  });
  if (!found)
    return reason === 'stopped' ? undefined : false;
  if (plan.untilInstant === undefined)
    return true;
  const at = resolveWall({ ...context.resolver, zone: plan.zone }, context.budget, wall);
  return at === undefined ? undefined : at.instant <= plan.untilInstant;
}

/**
 * Expand one series into `out`; answer false when the budget ran out.
 * @param {SeriesPlan} series
 * @param {Context} context
 * @param {{ key: number, uid: string, occurrence: any }[]} out
 * @param {string[]} orphans
 * @returns {boolean}
 */
function expandOne(series, context, out, orphans) {
  const { budget, low, high } = context;
  const { plan } = series;
  /** @type {Map<string, { key: number, occurrence: any }>} */
  const slots = new Map();
  let baseLength = { days: series.kind === 'date' ? 1 : 0, exact: 0 };
  if (plan !== null) {
    const resolver = plan.kind === 'zoned' ? { ...context.resolver, zone: plan.zone } : undefined;
    const exact = resolver === undefined ? plan.length.ms : exactLength(plan, resolver, budget);
    if (exact === undefined)
      return false;
    baseLength = { days: plan.length.days, exact };
    // the rule may lose one occurrence to each EXDATE and override, so it
    // is asked for that many more than the answer keeps
    const cap = budget.limits.maxOccurrences + series.exdates.size + series.overrides.size;
    const sub = { ...budget, limits: { ...budget.limits, maxOccurrences: cap }, limit: undefined };
    const { occurrences } = expandPlan(plan, low, high, sub, resolver, Infinity);
    budget.work = sub.work;
    budget.providerCalls = sub.providerCalls;
    if (sub.limit !== undefined) {
      budget.limit = sub.limit;
      // the rule's answer up to either of these is whole: the layers still apply to it
      if (sub.limit !== 'maxOccurrences' && sub.limit !== 'calendar-end')
        return false;
    }
    for (const occurrence of occurrences)
      slots.set(occurrence.recurrenceId, { key: occurrence.instants?.start ?? wallOfOccurrence(occurrence), occurrence });
  }
  /** @param {string} id */
  const lengthOf = (id) => {
    const rdate = series.rdates.get(id);
    return rdate?.endWall === undefined ? baseLength : { days: 0, exact: rdate.endWall - rdate.wall };
  };
  for (const [id, rdate] of series.rdates) {
    if (budget.work + 1 > budget.limits.maxWork) {
      budget.limit = 'maxWork';
      return false;
    }
    budget.work++;
    const length = lengthOf(id);
    const reach = rdate.endWall ?? rdate.wall + length.days * DAY + length.exact;
    // a zoned slot this far outside the horizon needs no provider call to tell
    const far = series.kind === 'zoned' && (rdate.wall >= high + MARGIN || reach <= low - MARGIN);
    const built = far ? null : build(series, context, id, rdate.wall, rdate.endWall, length);
    if (built === undefined)
      return false;
    if (built === null)
      slots.delete(id);
    else
      slots.set(id, built);
  }
  for (const id of series.exdates)
    slots.delete(id);
  for (const [id, override] of series.overrides) {
    if (!slots.has(id)) {
      let made = false;
      if (!series.exdates.has(id)) {
        made = series.rdates.has(id);
        if (!made && plan !== null) {
          const makes = baseMakes(plan, context, readId(id, series.kind, '/overrides'));
          if (makes === undefined)
            return false;
          made = makes;
        }
      }
      if (!made) {
        orphans.push(id);
        continue;
      }
    }
    slots.delete(id);
    if (override.status === 'cancelled')
      continue;
    const built = build(series, context, id, /** @type {number} */ (override.wall), override.endWall, lengthOf(id));
    if (built === undefined)
      return false;
    if (built !== null) {
      built.occurrence.moved = true;
      if (override.hasPayload)
        built.occurrence.payload = override.payload;
      slots.set(id, built);
    }
  }
  for (const slot of slots.values()) {
    const occurrence = { ...slot.occurrence, uid: series.uid };
    if (series.revision !== undefined)
      occurrence.seriesRevision = series.revision;
    out.push({ key: slot.key, uid: series.uid, occurrence: Object.freeze(occurrence) });
  }
  return true;
}

/**
 * The wall clock of a date or floating occurrence's start.
 * @param {any} occurrence
 * @returns {number}
 */
function wallOfOccurrence(occurrence) {
  return wallOf(admitValue(occurrence.start, 'start', ''));
}

/**
 * Expand a series - or a list of series of one kind, such as
 * {@link weeklyPattern} returns - inside a half-open horizon, under one
 * shared budget. The horizon, limits and provider read as in
 * {@link expandRecurrence}; the answer adds `orphans`, the overrides
 * whose slot the series never makes, by id. A slot whose end passes
 * 9999-12-31 is left out and the answer is `incomplete` with
 * `limit: 'calendar-end'`; the other slots stay.
 * @param {Series | readonly Series[]} series
 * @param {{ horizon: [unknown, unknown], limits?: import('./recurrence.js').RecurrenceLimits,
 *   provider?: import('../series/zone.js').ZoneProvider }} options
 * @returns {SeriesExpansion}
 * @throws {CalendarError} what {@link expandRecurrence} throws; `JY0021`
 *   for an override ranging over this and future occurrences; `JY0014`
 *   for a list mixing kinds or a series `defineSeries` did not return
 */
export function expandSeries(series, options) {
  const list = (Array.isArray(series) ? series : [series]).map((entry, i) => {
    const plan = entry !== null && typeof entry === 'object' ? SERIES.get(entry) : undefined;
    if (plan === undefined)
      throw new CalendarError('JY0014', 'expand a series defineSeries returned', Array.isArray(series) ? `/series/${i}` : '/series');
    return plan;
  });
  if (list.length === 0)
    throw new CalendarError('JY0014', 'the list of series is empty', '/series');
  const kind = list[0].kind;
  for (const [i, entry] of list.entries()) {
    if (entry.kind !== kind)
      throw new CalendarError('JY0014', `the series are all of one kind; ${entry.uid} is ${entry.kind}, not ${kind}`, `/series/${i}`);
    for (const override of entry.overrides.values()) {
      if (override.range !== undefined) {
        throw new CalendarError('JY0021', `${entry.uid}: an override ranging over this and future occurrences is not expanded`,
          `/overrides/${override.index}/range`);
      }
    }
  }
  if (!isRecord(options))
    throw new CalendarError('JY0014', 'expansion options are { horizon, limits?, provider? }', '/options');
  admitKeys(options, ['horizon', 'limits', 'provider'], '/options', 'a series expansion');
  const budget = budgetOf(options.limits);
  const [low, wanted] = admitHorizon(kind, options.horizon);
  const high = Math.min(wanted, low + budget.limits.maxHorizonDays * DAY);
  let resolver;
  if (kind === 'zoned') {
    const provider = admitProvider(admitProvider(options.provider, 'candidates'), 'toParts');
    resolver = { provider, identity: identityOf(provider), policy: 'rfc5545' };
  }
  /** @type {{ key: number, uid: string, occurrence: any }[]} */
  const out = [];
  /** @type {string[]} */
  const orphans = [];
  for (const entry of list) {
    const policy = entry.plan?.policy ?? 'rfc5545';
    if (!expandOne(entry, { budget, low, high, resolver: resolver && { ...resolver, policy } }, out, orphans))
      break;
  }
  out.sort((a, b) => a.key - b.key || (a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0)
    || (a.occurrence.recurrenceId < b.occurrence.recurrenceId ? -1 : 1));
  let limit = budget.limit;
  if (out.length > budget.limits.maxOccurrences) {
    out.length = budget.limits.maxOccurrences;
    limit = 'maxOccurrences';
  }
  if (limit === undefined && wanted > high)
    limit = 'maxHorizonDays';
  return /** @type {SeriesExpansion} */ (answer(out.map((entry) => entry.occurrence), budget, limit, {
    orphans: Object.freeze({ count: orphans.length, ids: Object.freeze(orphans.sort()) }),
  }));
}

/**
 * The kind of a series {@link defineSeries} returned - `'date'`,
 * `'floating'`, `'utc'` or `'zoned'` - or `undefined` for anything else.
 * @param {unknown} series
 * @returns {'date' | 'floating' | 'utc' | 'zoned' | undefined}
 */
export function seriesKindOf(series) {
  return series !== null && typeof series === 'object' ? SERIES.get(series)?.kind : undefined;
}

const DAY_KEYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);

/**
 * Weekly opening hours, availability or per-weekday rules as floating
 * series: one `FREQ=WEEKLY;BYDAY=…` series per distinct `[from, to)`
 * slot, each named `weekly:<from>-<to>`. A day is `true` (all day),
 * `false` or absent (none), or a list of `[from, to]` times; `to` may be
 * `24:00`, the end of the day. Expand the list with {@link expandSeries}
 * over a horizon of floating or date values, then bind the occurrences
 * to a zone with {@link bindFloating}.
 * @param {{ days: Partial<Record<'mon'|'tue'|'wed'|'thu'|'fri'|'sat'|'sun', boolean | [string, string][]>>,
 *   wkst?: 'MO'|'TU'|'WE'|'TH'|'FR'|'SA'|'SU' }} pattern
 * @returns {readonly Series[]}
 * @throws {CalendarError} `JY0014` for an unknown day, a slot that is
 *   not `[from, to]` or does not end after it starts; the time codes
 *   `JY0008`-`JY0013` for a time
 * @example
 * const hours = weeklyPattern({ days: { mon: [['09:00', '17:00']], sat: [['10:00', '24:00']], sun: false } });
 * expandSeries(hours, { horizon: [dateValue('2026-03-02'), dateValue('2026-03-09')] }).occurrences.length; // 2
 */
export function weeklyPattern(pattern) {
  if (!isRecord(pattern) || !isRecord(pattern.days))
    throw new CalendarError('JY0014', 'a weekly pattern is { days: { mon, tue, ... }, wkst? }', '/days');
  for (const key of Object.keys(pattern)) {
    if (key !== 'days' && key !== 'wkst')
      throw new CalendarError('JY0014', `a weekly pattern carries no '${key}'`, `/${key}`);
  }
  const { days, wkst } = pattern;
  /** @type {Map<string, { from: string, to: string, length: number, weekdays: number[] }>} */
  const slots = new Map();
  for (const key of Object.keys(days)) {
    const weekday = DAY_KEYS.indexOf(key);
    if (weekday < 0)
      throw new CalendarError('JY0014', `a day is one of ${DAY_KEYS.join(', ')}, not '${key}'`, `/days/${key}`);
    const value = days[key];
    if (value === false || value === undefined)
      continue;
    const list = value === true ? [['00:00', '24:00']] : value;
    if (!Array.isArray(list))
      throw new CalendarError('JY0014', `a day is true, false or a list of [from, to] times`, `/days/${key}`);
    for (const [j, slot] of list.entries()) {
      const path = `/days/${key}/${j}`;
      if (!Array.isArray(slot) || slot.length !== 2)
        throw new CalendarError('JY0014', 'a slot is [from, to]', path);
      const from = timeOf(slot[0], 'start', `${path}/0`);
      const to = timeOf(slot[1], 'end', `${path}/1`);
      if (!(to.ms > from.ms))
        throw new CalendarError('JY0014', `a slot ends after it starts; ${slot[1]} is not after ${slot[0]}`, `${path}/1`);
      const id = `${from.text}-${to.text}`;
      const entry = slots.get(id) ?? { from: from.text, to: to.text, length: to.ms - from.ms, weekdays: [] };
      if (!entry.weekdays.includes(weekday))
        entry.weekdays.push(weekday);
      slots.set(id, entry);
    }
  }
  const out = [];
  for (const [id, slot] of [...slots.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    let day = FIRST_DAY;
    while (!slot.weekdays.includes(isoWeekdayFromDays(day) - 1))
      day++;
    const date = valueAt('date', day * DAY, undefined);
    const base = compileRecurrence({
      dtstart: { kind: 'floating', date: /** @type {any} */ (date).date, time: slot.from },
      duration: `PT${slot.length / 1000}S`,
      rrule: { FREQ: 'WEEKLY', BYDAY: slot.weekdays.sort((a, b) => a - b).map((weekday) => WEEKDAYS[weekday]) },
      ...(wkst !== undefined ? { wkst } : {}),
    });
    out.push(defineSeries({ uid: `weekly:${id}`, base }));
  }
  return Object.freeze(out);
}

/**
 * A slot time, read as a floating value's time would be.
 * @param {unknown} text
 * @param {'start' | 'end'} side
 * @param {string} path
 * @returns {{ text: string, ms: number }}
 */
function timeOf(text, side, path) {
  let admitted;
  try {
    admitted = /** @type {any} */ (admitValue({ kind: 'floating', date: '2000-01-03', time: text }, side, ''));
  }
  catch (error) {
    const coded = /** @type {CalendarError} */ (error);
    throw new CalendarError(coded.code, coded.reason, path);
  }
  const ms = wallOf(admitted) - admitted.days * DAY;
  if (ms % 1000 !== 0)
    throw new CalendarError('JY0013', 'a slot time falls on a whole second', path);
  const seconds = ms / 1000;
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return { text: `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`, ms };
}
//#endregion
