//@ts-check

//#region Recurring series
// A series is one recurrence (or none) plus its extra dates (RDATE), its
// excluded dates (EXDATE) and its per-occurrence overrides, read into
// one occurrence set in a fixed order:
//
//   1. the rule's occurrences and the RDATEs together, one per
//      recurrenceId (an RDATE's length wins over the rule's);
//   2. minus the EXDATEs (a zoned series' EXDATE in another zone or utc
//      removes every slot starting at its instant; such an RDATE is named
//      by the series' wall clock at its instant);
//   3. with the overrides that range over this and future occurrences
//      (RANGE=THISANDFUTURE) applied in recurrenceId order: each one, from
//      its own slot on, cancels every later slot or moves it by the
//      distance its start moved its own (in wall clock), with its length
//      and payload; a later one takes over from its slot on;
//   4. with the other overrides applied by recurrenceId: a cancelled slot
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
  planFor, recurrenceIdOf, resolveWall, valueAt, walk, wallAtInstant, wallOf,
} from './recurrence.js';
import { admitProvider, identityOf, providerOf } from './resolve.js';
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
 * @property {'THISANDFUTURE'} [range] - the override applies to its slot and every later slot of the series (RFC 5545 §3.8.4.4)
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
 * A series expansion's answer: `complete` and `stoppedAt` as a
 * recurrence expansion carries them, `status` and `limit` their older
 * spelling.
 * @typedef {Object} SeriesExpansion
 * @property {'complete' | 'incomplete'} status
 * @property {boolean} complete - no limit stopped the walk
 * @property {readonly SeriesOccurrence[]} occurrences - in order of start
 * @property {import('./recurrence.js').RecurrenceCounts} counts
 * @property {import('./recurrence.js').RecurrenceExpansion['limit']} [limit]
 * @property {import('./recurrence.js').RecurrenceExpansion['stoppedAt']} [stoppedAt]
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
 * @property {Map<string, SlotOverride>} overrides
 * @property {{ rdates: { start: any, end?: any, index: number }[], exdates: { value: any, index: number }[] }} foreign - a zoned
 *   series' RDATEs and EXDATEs in another zone or utc, admitted, read at expansion
 */

/**
 * An RDATE as one expansion reads it: its wall clock in the series' kind
 * (and zone), and for one given in another zone or utc its instant and,
 * for a period, its exact length.
 * @typedef {{ wall: number, endWall?: number, exact?: number, instant?: number }} SlotDate
 */

/**
 * An override as a series plan reads it.
 * @typedef {{ status: 'moved' | 'cancelled', idWall: number, wall?: number, endWall?: number, payload?: unknown, hasPayload: boolean,
 *   index: number, range?: string }} SlotOverride
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
 * A zoned series' value in another zone, or a utc value, admitted; for
 * any other value (or series) `undefined`, which {@link readStart} reads.
 * @param {unknown} value
 * @param {'start' | 'end'} side
 * @param {string} path
 * @param {{ kind?: string, zone?: string }} shape
 * @returns {any}
 */
function foreignOf(value, side, path, shape) {
  if (shape.kind !== 'zoned' || !isRecord(value) || !(value.kind === 'utc' || (value.kind === 'zoned' && value.zone !== shape.zone)))
    return undefined;
  const admitted = /** @type {any} */ (admitValue(value, side, path));
  if (wallOf(admitted) % 1000 !== 0)
    throw new CalendarError('JY0013', 'a series slot falls on a whole second, as its recurrenceId does', path);
  return admitted;
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
 *   length); `payload` is carried, never read. `range: 'THISANDFUTURE'`
 *   applies the override to its slot and every later one.
 * - All values share the base's kind (and zone, for a zoned series),
 *   except that a zoned series' RDATEs and EXDATEs may be zoned values
 *   in another zone or utc values, read at their instants when expanded.
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
  /** @type {SeriesPlan['foreign']} */
  const foreign = { rdates: [], exdates: [] };
  const rdatesOut = rdatesIn.map((entry, i) => {
    const path = `/rdates/${i}`;
    const period = isRecord(entry) && !Object.hasOwn(entry, 'kind');
    if (period && Object.keys(entry).some((key) => key !== 'start' && key !== 'end'))
      throw new CalendarError('JY0014', 'a period is { start, end }', path);
    const startPath = period ? `${path}/start` : path;
    const away = foreignOf(period ? entry.start : entry, 'start', startPath, shape);
    const awayEnd = period ? foreignOf(entry.end, 'end', `${path}/end`, shape) : undefined;
    if (away !== undefined || awayEnd !== undefined) {
      // read at its instant when expanded; a side in the series' own zone is read in it
      const own = (/** @type {unknown} */ value, /** @type {'start' | 'end'} */ side, /** @type {string} */ at) => {
        readStart(value, side, at, shape);
        return admitValue(value, side, at);
      };
      foreign.rdates.push({ start: away ?? own(period ? entry.start : entry, 'start', startPath), index: i,
        ...(period ? { end: awayEnd ?? own(entry.end, 'end', `${path}/end`) } : {}) });
      return period ? Object.freeze({ start: entry.start, end: entry.end }) : entry;
    }
    const wall = readStart(period ? entry.start : entry, 'start', startPath, shape);
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
    const away = foreignOf(entry, 'start', `/exdates/${i}`, shape);
    if (away !== undefined)
      foreign.exdates.push({ value: away, index: i });
    else
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
    const idWall = readId(id, shape.kind, `${path}/recurrenceId`);
    if (overrides.has(id))
      throw new CalendarError('JY0014', `the slot ${id} has two overrides`, `${path}/recurrenceId`);
    if (entry.range !== undefined && entry.range !== 'THISANDFUTURE')
      throw new CalendarError('JY0014', `range is 'THISANDFUTURE' or absent, not ${String(entry.range)}`, `${path}/range`);
    /** @type {any} */
    const read = { status: entry.status, idWall, payload: entry.payload, hasPayload: Object.hasOwn(entry, 'payload'), index: i, range: entry.range };
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
  SERIES.set(series, { uid, revision, kind: shape.kind, zone: shape.zone, plan, rdates, exdates, overrides, foreign });
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
 * What one expansion of a series reads of its dates: the RDATEs by
 * recurrenceId, those in another zone or utc placed at their instants
 * and named by the series' wall clock there, and the instants of the
 * EXDATEs in another zone or utc.
 * @typedef {{ rdates: Map<string, SlotDate>, away: Set<number> }} SeriesView
 */

/**
 * The instant a zoned series' value names, in its own zone (or as utc),
 * under the series' policy; `undefined` when the budget ran out.
 * @param {Context} context
 * @param {any} admitted
 * @returns {number | undefined}
 * @throws {CalendarError} `JY0002`/`JY0003` under `reject` for a time in a gap or fold
 */
function instantOf(context, admitted) {
  if (admitted.value.kind === 'utc')
    return admitted.epoch;
  const at = resolveWall(context.resolver, context.budget, wallOf(admitted), admitted.value.zone);
  if (at?.refused !== undefined)
    throw at.refused;
  return at?.instant;
}

/**
 * Read a series' dates for one expansion; `undefined` when the budget
 * ran out. An RDATE in another zone or utc is named by the series' wall
 * clock at its instant; one whose wall clock the series reads as another
 * instant (the second pass of a repeated hour) is refused, since its
 * recurrenceId would name the other.
 * @param {SeriesPlan} series
 * @param {Context} context
 * @returns {SeriesView | undefined}
 * @throws {CalendarError} `JY0013` for such an RDATE, `JY0014` for a period ending before it starts
 */
function viewOf(series, context) {
  const view = { rdates: series.rdates, away: new Set() };
  if (series.foreign.rdates.length === 0 && series.foreign.exdates.length === 0)
    return view;
  const resolver = { ...context.resolver, zone: series.zone };
  for (const { value } of series.foreign.exdates) {
    const instant = instantOf(context, value);
    if (instant === undefined)
      return undefined;
    view.away.add(instant);
  }
  /** @type {Map<string, SlotDate>} */
  const rdates = new Map(series.rdates);
  for (const { start, end, index } of series.foreign.rdates) {
    const instant = instantOf(context, start);
    const endInstant = instant === undefined || end === undefined ? undefined : instantOf(context, end);
    if (instant === undefined || (end !== undefined && endInstant === undefined))
      return undefined;
    const wall = wallAtInstant(resolver, context.budget, instant);
    const back = wall === undefined ? undefined : resolveWall(resolver, context.budget, wall);
    if (wall === undefined || back === undefined)
      return undefined;
    if (back.refused !== undefined)
      throw back.refused;
    const id = recurrenceIdOf('zoned', wall);
    const path = end === undefined ? `/rdates/${index}` : `/rdates/${index}/start`;
    if (back.instant !== instant) {
      throw new CalendarError('JY0013', `the RDATE starts at ${new Date(instant).toISOString()}, which reads ${id} in '${series.zone}', `
        + `a wall clock the series reads as ${new Date(back.instant).toISOString()}`, path);
    }
    if (endInstant !== undefined && endInstant < instant)
      throw new CalendarError('JY0014', 'a period ends at or after its start', `/rdates/${index}/end`);
    if (!rdates.has(id))
      rdates.set(id, { wall, instant, ...(endInstant !== undefined ? { exact: endInstant - instant } : {}) });
  }
  view.rdates = rdates;
  return view;
}

/**
 * Whether an EXDATE in another zone or utc removes a slot: its start
 * instant (the series' reading of its wall clock, or a foreign RDATE's
 * own) is one an EXDATE names. `undefined` when the budget ran out.
 * @param {SeriesPlan} series
 * @param {Context} context
 * @param {SeriesView} view
 * @param {string} id
 * @param {number} wall
 * @returns {boolean | undefined}
 */
function awayExcludes(series, context, view, id, wall) {
  if (view.away.size === 0)
    return false;
  let instant = view.rdates.get(id)?.instant;
  if (instant === undefined) {
    const at = resolveWall({ ...context.resolver, zone: series.zone }, context.budget, wall);
    if (at === undefined)
      return undefined;
    instant = at.instant;
  }
  return view.away.has(instant);
}

/**
 * Whether a series makes a slot: not an EXDATE's, and an RDATE's or the
 * base rule's. `undefined` when the budget ran out.
 * @param {SeriesPlan} series
 * @param {Context} context
 * @param {SeriesView} view
 * @param {string} id
 * @param {number} wall - the slot's wall clock
 * @returns {boolean | undefined}
 */
function seriesMakes(series, context, view, id, wall) {
  if (series.exdates.has(id))
    return false;
  const away = awayExcludes(series, context, view, id, wall);
  if (away !== false)
    return away === undefined ? undefined : false;
  if (view.rdates.has(id))
    return true;
  return series.plan === null ? false : baseMakes(series.plan, context, wall);
}

/**
 * The overrides of a series that range over this and future occurrences
 * and whose own slot it makes, in recurrenceId order; the others are
 * orphans. `undefined` when the budget ran out.
 * @param {SeriesPlan} series
 * @param {Context} context
 * @param {SeriesView} view
 * @param {string[]} orphans
 * @returns {(SlotOverride & { id: string })[] | undefined}
 */
function rangesOf(series, context, view, orphans) {
  const out = [];
  for (const [id, override] of series.overrides) {
    if (override.range === undefined)
      continue;
    const made = seriesMakes(series, context, view, id, override.idWall);
    if (made === undefined)
      return undefined;
    if (made)
      out.push({ id, ...override });
    else
      orphans.push(id);
  }
  return out.sort((a, b) => a.idWall - b.idWall);
}

/**
 * The range override a slot falls under: the last one at or before it.
 * @param {(SlotOverride & { id: string })[]} ranges
 * @param {number} wall - the slot's wall clock (its recurrenceId's)
 * @returns {(SlotOverride & { id: string }) | undefined}
 */
function rangeOver(ranges, wall) {
  let found;
  for (const range of ranges) {
    if (range.idWall > wall)
      break;
    found = range;
  }
  return found;
}

/**
 * Expand one series into `out`; answer false when the budget ran out.
 *
 * With range overrides the rule is read in runs, one per range, each
 * asked for a capped number of slots. A run stopped at its cap leaves
 * later slots unread, none starting before the last one read (a zoned
 * one: before it less two days, an offset's change and a gap's). When
 * such a start could fall among the first `maxOccurrences` of the
 * answer, the run is read again with twice the cap; so the answer holds
 * as many as the limit allows when that many exist, in order.
 * @param {SeriesPlan} series
 * @param {Context} context
 * @param {{ key: number, uid: string, occurrence: any }[]} out
 * @param {string[]} orphans
 * @returns {boolean}
 */
function expandOne(series, context, out, orphans) {
  const { budget, low, high } = context;
  const { plan } = series;
  const zoned = series.kind === 'zoned';
  const max = budget.limits.maxOccurrences;
  const view = viewOf(series, context);
  if (view === undefined)
    return false;
  const ranges = rangesOf(series, context, view, orphans);
  if (ranges === undefined)
    return false;
  // a slot a moved range keeps its length from the range's end, when it names one
  /** @param {SlotOverride | undefined} range */
  const rangeLength = (range) => (range?.endWall === undefined ? undefined : range.endWall - /** @type {number} */ (range.wall));
  let baseLength = { days: series.kind === 'date' ? 1 : 0, exact: 0 };
  /** @param {string} id */
  const lengthOf = (id) => {
    const rdate = view.rdates.get(id);
    if (rdate?.exact !== undefined)
      return { days: 0, exact: rdate.exact };
    return rdate?.endWall === undefined ? baseLength : { days: 0, exact: rdate.endWall - rdate.wall };
  };
  /**
   * A slot under a moved range: its start moved by the range's distance,
   * its length the range's or its own.
   * @param {string} id
   * @param {number} wall
   * @param {number | undefined} endWall - an RDATE period's end
   * @param {SlotOverride} range
   */
  const shifted = (id, wall, endWall, range) => {
    const by = /** @type {number} */ (range.wall) - range.idWall;
    const length = rangeLength(range);
    const built = build(series, context, id, wall + by, length !== undefined ? wall + by + length
      : endWall === undefined ? undefined : endWall + by, lengthOf(id));
    if (built) {
      built.occurrence.moved = true;
      if (range.hasPayload)
        built.occurrence.payload = range.payload;
    }
    return built;
  };
  /** @type {any} */
  let resolver;
  /** @type {{ range?: SlotOverride, from: number, to: number, by: number, extra: number }[]} */
  const runs = [];
  if (plan !== null) {
    resolver = plan.kind === 'zoned' ? { ...context.resolver, zone: plan.zone } : undefined;
    const exact = resolver === undefined ? plan.length.ms : exactLength(plan, resolver, budget);
    if (exact === undefined)
      return false;
    baseLength = { days: plan.length.days, exact };
    const span = plan.length.days * DAY + exact;
    // the slots before the first range as they are, then each moved
    // range's own run of slots over the horizon moved back by its distance
    runs.push({ from: -Infinity, to: Infinity, by: 0, extra: 0 });
    for (const range of ranges) {
      runs[runs.length - 1].to = range.idWall;
      const length = rangeLength(range);
      runs.push({ range, from: range.idWall, to: Infinity, by: (range.wall ?? range.idWall) - range.idWall,
        extra: Math.max(0, (length ?? span) - span) });
    }
  }
  // the rule may lose one occurrence to each EXDATE and override, so it
  // is asked for that many more than the answer keeps
  const caps = runs.map(() => max + series.exdates.size + view.away.size + series.overrides.size);
  const orphansBefore = orphans.length;
  for (;;) {
    orphans.length = orphansBefore;
    /** @type {Map<string, { key: number, occurrence: any }>} */
    const slots = new Map();
    /** @type {{ run: number, bound: number }[]} */
    const stopped = [];
    for (const [i, run] of runs.entries()) {
      if (run.range?.status === 'cancelled')
        continue;
      const margin = zoned && run.range !== undefined ? MARGIN : 0;
      // the horizon is clipped to the run's own slots: by wall clock, or
      // for a zoned series by the instants they can have (no offset is a day)
      const from = Math.max(low - run.by - run.extra - margin, run.from - (zoned ? DAY : 0));
      const to = Math.min(high - run.by + margin, run.to + (zoned ? DAY : 0));
      if (!(to > from))
        continue;
      const sub = { ...budget, limits: { ...budget.limits, maxOccurrences: caps[i] }, limit: undefined };
      const { occurrences } = expandPlan(/** @type {any} */ (plan), from, to, sub, resolver, Infinity);
      budget.work = sub.work;
      budget.providerCalls = sub.providerCalls;
      if (sub.limit !== undefined) {
        // the rule's answer up to either of these is whole: the layers still apply to it
        if (sub.limit !== 'maxOccurrences' && sub.limit !== 'calendar-end') {
          budget.limit = sub.limit;
          return false;
        }
        if (ranges.length === 0 || sub.limit === 'calendar-end')
          budget.limit = sub.limit;
      }
      // the earliest start a slot of this run past the last one read can take
      let edge = run.from + run.by;
      for (const occurrence of occurrences) {
        const wall = ranges.length === 0 ? 0 : readId(occurrence.recurrenceId, series.kind, '/overrides');
        if (ranges.length > 0 && !(wall >= run.from && wall < run.to))
          continue;
        // an EXDATE in another zone or utc removes the slot that starts at its instant
        const away = view.away.size > 0 && view.away.has(occurrence.instants.start);
        if (run.range === undefined) {
          edge = occurrence.instants?.start ?? wallOfOccurrence(occurrence);
          if (!away)
            slots.set(occurrence.recurrenceId, { key: edge, occurrence });
          continue;
        }
        if (away) {
          edge = occurrence.instants.start + run.by;
          continue;
        }
        const built = shifted(occurrence.recurrenceId, wall, undefined, run.range);
        if (built === undefined)
          return false;
        edge = built?.key ?? (occurrence.instants?.start ?? wall) + run.by;
        if (built !== null)
          slots.set(occurrence.recurrenceId, built);
      }
      if (ranges.length > 0 && sub.limit === 'maxOccurrences')
        stopped.push({ run: i, bound: edge - (zoned ? 2 * DAY : 0) });
    }
    for (const [id, rdate] of view.rdates) {
      if (budget.work + 1 > budget.limits.maxWork) {
        budget.limit = 'maxWork';
        return false;
      }
      budget.work++;
      const range = rangeOver(ranges, rdate.wall);
      if (range?.status === 'cancelled')
        continue;
      const away = awayExcludes(series, context, view, id, rdate.wall);
      if (away === undefined)
        return false;
      if (away) {
        slots.delete(id);
        continue;
      }
      if (range !== undefined) {
        const built = shifted(id, rdate.wall, rdate.endWall, range);
        if (built === undefined)
          return false;
        if (built === null)
          slots.delete(id);
        else
          slots.set(id, built);
        continue;
      }
      const length = lengthOf(id);
      const reach = rdate.endWall ?? rdate.wall + length.days * DAY + length.exact;
      // a zoned slot this far outside the horizon needs no provider call to tell
      const far = zoned && (rdate.wall >= high + MARGIN || reach <= low - MARGIN);
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
      if (override.range !== undefined)
        continue;
      if (!slots.has(id)) {
        const made = seriesMakes(series, context, view, id, override.idWall);
        if (made === undefined)
          return false;
        if (!made) {
          orphans.push(id);
          continue;
        }
      }
      slots.delete(id);
      if (override.status === 'cancelled')
        continue;
      // under a moved range that names a length, the slot keeps that length
      const length = rangeLength(rangeOver(ranges, override.idWall));
      const wall = /** @type {number} */ (override.wall);
      const built = build(series, context, id, wall, override.endWall ?? (length === undefined ? undefined : wall + length), lengthOf(id));
      if (built === undefined)
        return false;
      if (built !== null) {
        built.occurrence.moved = true;
        if (override.hasPayload)
          built.occurrence.payload = override.payload;
        slots.set(id, built);
      }
    }
    if (stopped.length > 0) {
      // the start the answer's last kept slot has, when the slots fill it
      const keys = [...slots.values()].map((slot) => slot.key).sort((a, b) => a - b);
      const last = keys.length >= max ? keys[max - 1] : Infinity;
      const short = stopped.filter((stop) => stop.bound < high && stop.bound <= last);
      if (short.length > 0) {
        for (const stop of short)
          caps[stop.run] *= 2;
        continue;
      }
      if (stopped.some((stop) => stop.bound < high))
        budget.limit = 'maxOccurrences';
    }
    for (const slot of slots.values()) {
      const occurrence = { ...slot.occurrence, uid: series.uid };
      if (series.revision !== undefined)
        occurrence.seriesRevision = series.revision;
      out.push({ key: slot.key, uid: series.uid, occurrence: Object.freeze(occurrence) });
    }
    return true;
  }
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
 * @param {{ horizon: [unknown, unknown], limits?: import('./recurrence.js').RecurrenceLimits }
 *   & import('./resolve.js').ZoneProviderOptions} options
 * @returns {SeriesExpansion}
 * An override with `range: 'THISANDFUTURE'` (RFC 5545 §3.8.4.4) applies
 * to its own slot and every later slot (the rule's and the RDATEs', by
 * recurrenceId), in recurrenceId order, a later one taking over from its
 * own slot on: cancelled, it removes them; moved, it moves each by the
 * distance its start lies from its own recurrenceId (wall clock; a
 * zoned series' moved times resolve under its policy), with the length
 * its `end` gives (else each slot keeps its own) and its payload. An
 * override without a range still wins for its one slot. A range whose
 * own slot the series does not make is an orphan and moves nothing.
 * A zoned series' RDATE in another zone or utc adds the slot the series'
 * wall clock names at its instant; such an EXDATE removes every slot
 * that starts at its instant (RFC 5545 §3.8.5.1).
 * @throws {CalendarError} what {@link expandRecurrence} throws; `JY0014`
 *   for a list mixing kinds or a series `defineSeries` did not return, or
 *   a period in another zone that ends before it starts; `JY0013` for an
 *   RDATE whose instant the series' wall clock there does not name
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
  }
  if (!isRecord(options))
    throw new CalendarError('JY0014', 'expansion options are { horizon, limits?, zoneProvider?, runtime? }', '/options');
  admitKeys(options, ['horizon', 'limits', 'zoneProvider', 'provider', 'runtime'], '/options', 'a series expansion');
  const budget = budgetOf(options.limits);
  const [low, wanted] = admitHorizon(kind, options.horizon);
  const high = Math.min(wanted, low + budget.limits.maxHorizonDays * DAY);
  const named = providerOf(options);
  let resolver;
  if (kind === 'zoned') {
    const provider = admitProvider(admitProvider(named, 'candidates'), 'toParts');
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
