//@ts-check
/**
 * @file `@jarenjs/db/schedules` - the calendar half of recurring job
 * schedules (JOBS-FORMAT §11): reading a schedule definition, and the
 * arithmetic that decides which occurrences are due and when the next
 * one is. Everything here is JavaScript over `@jarenjs/core/calendar`
 * and the zone provider the host's runtime record carries; SQL only
 * stores the answers (epoch milliseconds, canonical text, JSON as
 * text), so both engines answer alike. No zone is ever assumed: a
 * series that names no zone of its own, given none, is `unresolved`
 * and never fires. It is a subpath of its own so a store that never
 * schedules carries no calendar: pass {@link jobSchedules}'s answer as
 * `openStore`'s `jobs.schedules`.
 * @module
 */
import {
  compileRecurrence, defineSeries, expandSeries, bindFloating, assertZone, dateValue, floatingValue, RECURRENCE_LIMITS,
} from '@jarenjs/core/calendar';
import { DbCompileError } from './errors.js';
import { readOptions, readOptionsOrNull } from './options.js';
import { chain, attempt } from './driver.js';
import { PAGE_LIMIT_DEFAULT } from './cursor.js';
import { JOB_SCHEDULES_TABLE } from './engine-metadata.js';
import { scheduleStatements, SCHEDULE_COLUMNS } from './dialects/job-schedules.js';
import { SCHEDULE_SEAMS } from './job-schedules.js';

const TICK_OPTIONS = Object.freeze(['limit']);

/** The members a schedule definition reads. */
const SCHEDULE_OPTIONS = Object.freeze(['id', 'kind', 'payload', 'series', 'zone', 'zoneSource', 'policy', 'missed', 'limits',
  'latenessMs']);
/**
 * Where a schedule's `latenessMs` is stored: a member of the `limits`
 * column's JSON beside the calendar's own limits, so no column is added
 * and a release that reads only the calendar's limits refuses the member
 * by name (`JY0014`, the schedule `stalled`) rather than firing late.
 */
const LATENESS = 'latenessMs';
const POLICIES = Object.freeze(['rfc5545', 'later', 'reject']);
const DAY = 86400000;
/** The horizons a search for the next occurrence widens through, in days; the last is the limit's whole horizon. */
const WINDOWS = Object.freeze([8, 64, 512, 4096]);
/** A sub-daily rule's period, in milliseconds per unit of its INTERVAL. */
const PERIODS = Object.freeze({ SECONDLY: 1000, MINUTELY: 60000, HOURLY: 3600000 });
/**
 * The periods a sub-daily rule's search looks past the tick first, each
 * window eight times the last, before the day windows: a rule due every
 * second finds its next occurrence in 64 seconds, not in eight days of
 * occurrences it would expand and bind for nothing.
 */
const SUB_DAILY_PERIODS = Object.freeze([64, 512, 4096, 32768]);

/**
 * The window sizes, in milliseconds, a search for a definition's next
 * occurrence widens through: a sub-daily rule's own periods first.
 * @param {any} series
 * @returns {number[]}
 */
function windowsOf(series) {
  const rule = series.base?.rrule;
  const period = rule === undefined ? undefined : PERIODS[/** @type {keyof typeof PERIODS} */ (rule.FREQ)];
  const days = WINDOWS.map((size) => size * DAY);
  if (period === undefined) return days;
  const own = SUB_DAILY_PERIODS.map((count) => count * period * (rule.INTERVAL ?? 1)).filter((size) => size < days[0]);
  return [...own, ...days];
}
/** Days of civil-date margin either side of a date series' horizon: no zone's offset reaches a day. */
const MARGIN_DAYS = 2;
const HOUR = 3600000;
/**
 * The offsets a zone's wall clock keeps from UTC, in milliseconds, when its
 * provider lists no changes: every zone of the tz database keeps within
 * UTC-12:00 and UTC+14:00 (the local mean times of the nineteenth century
 * aside), so a floating occurrence binds to an instant at most 14 hours
 * before its wall clock and 12 hours after it.
 */
const OFFSET_SPAN = Object.freeze({ min: -12 * HOUR, max: 14 * HOUR });
/** A rule's cycle, in milliseconds per unit of its INTERVAL: where a backward read of a backlog starts. */
const CYCLES = Object.freeze({ ...PERIODS, DAILY: DAY, WEEKLY: 7 * DAY, MONTHLY: 31 * DAY, YEARLY: 366 * DAY });
/** The wall-clock step, in milliseconds per unit of its INTERVAL, between the occurrences of a rule that has one. */
const STEPS = Object.freeze({ ...PERIODS, DAILY: DAY, WEEKLY: 7 * DAY });
/**
 * The members a rule may hold and keep its occurrences one step apart:
 * COUNT and UNTIL only end it, and WKST moves no WEEKLY occurrence without
 * BYDAY. Any BYxxx part (or BYSETPOS) breaks the step.
 */
const STEP_MEMBERS = Object.freeze(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'WKST']);

/**
 * A recurrence id's wall clock as epoch milliseconds of that wall clock
 * read as UTC: the slot the rule placed the occurrence in, whatever instant
 * it bound to.
 * @param {string} id @param {string} kind
 */
const wallOfId = (id, kind) => Date.parse(kind === 'date' ? `${id}T00:00:00Z` : kind === 'utc' ? id : `${id}Z`);

/**
 * How many occurrences of a schedule lie from `first` up to, not
 * including, `last` (two of its occurrences), counted by arithmetic on
 * their recurrence ids: the rule's slots are one step apart on the wall
 * clock. That count is exact only where every slot is an occurrence and
 * the slots bind to instants in their order: a series of a bare rule with
 * no BYxxx part, a SECONDLY to WEEKLY frequency, no RDATE, EXDATE or
 * override; a utc series at any of those steps, and a date, zoned or
 * floating one at a day or more (a zone's gap moves a sub-daily slot
 * past the next ones; no gap or fold is longer than a day, so a daily slot
 * binds at most where the next one does) under a policy
 * that binds every slot (not `reject`). Elsewhere the answer is null.
 * @param {ScheduleDefinition} definition
 * @param {{ recurrenceId: string } | undefined} first
 * @param {{ recurrenceId: string } | undefined} last
 * @returns {number | null}
 */
function occurrencesBetween(definition, first, last) {
  const series = definition.series;
  const rule = series.base?.rrule;
  if (first === undefined || last === undefined || rule === undefined
    || series.rdates.length + series.exdates.length + series.overrides.length !== 0) return null;
  for (const member of Object.keys(rule)) if (!STEP_MEMBERS.includes(member)) return null;
  const unit = STEPS[/** @type {keyof typeof STEPS} */ (rule.FREQ)];
  if (unit === undefined) return null;
  const kind = definition.seriesKind;
  if (kind !== 'utc' && (unit < DAY || definition.policy === 'reject' || series.base.policy === 'reject')) return null;
  const step = unit * (rule.INTERVAL ?? 1);
  const span = wallOfId(last.recurrenceId, kind) - wallOfId(first.recurrenceId, kind);
  return Number.isSafeInteger(span) && span >= 0 && span % step === 0 ? span / step : null;
}

/** @param {unknown} value @returns {value is Record<string, any>} */
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @param {string} member @param {string} message */
const refuse = (member, message) =>
  new DbCompileError('JD0013', `jobs.schedule option '${member}' ${message}`, `/jobs/schedule/${member}`);

/**
 * A stored or given compiled recurrence, compiled again: the calendar
 * reads only the values its own compile returned.
 * @param {any} value @param {string} member
 */
function reviveRule(value, member) {
  if (!isRecord(value) || value.kind !== 'recurrence')
    throw refuse(member, 'is a compiled recurrence ({ kind: \'recurrence\', dtstart, rrule, … })');
  const { kind: _kind, ...definition } = value;
  return compileRecurrence(/** @type {any} */ (definition));
}

/**
 * The series a definition names - a compiled recurrence or a series, as
 * values or as their JSON - with its kind, its own zone and its policy.
 * @param {unknown} value
 */
function reviveSeries(value) {
  /** @type {any} */
  let series;
  if (isRecord(value) && value.kind === 'recurrence')
    series = defineSeries({ uid: 'schedule', base: reviveRule(value, 'series') });
  else if (isRecord(value) && value.kind === 'series') {
    const { kind: _kind, base, ...rest } = value;
    series = defineSeries({ ...rest, base: base === null || base === undefined ? null : reviveRule(base, 'series') });
  }
  else throw refuse('series', 'is a compiled recurrence or a series ({ kind: \'recurrence\' } or { kind: \'series\' })');
  const first = series.base?.dtstart ?? (isRecord(series.rdates[0]?.start) ? series.rdates[0].start : series.rdates[0]);
  return {
    series,
    // a bare rule is stored as itself, a series as the series
    stored: value.kind === 'recurrence' ? series.base : series,
    kind: /** @type {'date' | 'floating' | 'utc' | 'zoned'} */ (first.kind),
    zone: first.kind === 'zoned' ? first.zone : null,
    policy: series.base?.policy ?? 'rfc5545',
  };
}

/**
 * @typedef {Object} ScheduleDefinition
 * @property {string} id
 * @property {string} kind
 * @property {string | null} payload - JSON text
 * @property {any} series - the revived series
 * @property {string} seriesText - its canonical JSON
 * @property {'date' | 'floating' | 'utc' | 'zoned'} seriesKind
 * @property {string | null} zone - the zone a zone-less series is bound in; a zoned series' own zone
 * @property {string | null} zoneSource
 * @property {'rfc5545' | 'later' | 'reject'} policy
 * @property {'skip' | 'once' | { catchUp: number }} missed
 * @property {Record<string, number> | null} limits
 * @property {number | null} latenessMs - how late a due occurrence may fire
 */

/**
 * Read a schedule definition, refusing a malformed member `JD0013` and
 * an invalid recurrence with the calendar's own code, before anything is
 * stored. Every frequency the calendar enumerates is a schedule's.
 * @param {unknown} spec
 * @param {(value: unknown, what: string) => string} storedJson - the queue's payload serializer
 * @param {any} provider - the runtime's zone provider, or null
 * @returns {ScheduleDefinition}
 */
function readSchedule(spec, storedJson, provider) {
  if (!isRecord(spec)) throw new DbCompileError('JD0013', 'jobs.schedule takes a schedule definition object', '/jobs/schedule');
  readOptions(spec, SCHEDULE_OPTIONS, 'jobs.schedule');
  const { id, kind } = spec;
  if (typeof id !== 'string' || id === '') throw refuse('id', 'is a non-empty string - the schedule\'s identity');
  if (typeof kind !== 'string' || kind === '') throw refuse('kind', 'is a non-empty string - the handler its jobs run');
  const read = reviveSeries(spec.series);
  const own = read.kind === 'utc' || read.kind === 'zoned';
  let zone = read.zone;
  if (spec.zone !== undefined && spec.zone !== null) {
    if (own) throw refuse('zone', `binds a zone-less series; a ${read.kind} series has its own instants`);
    if (typeof spec.zone !== 'string' || spec.zone === '') throw refuse('zone', 'is a non-empty zone name');
    // checked now, never at a fire: an unknown zone, or a zone with no provider to read it
    assertZone(spec.zone, provider ?? undefined);
    zone = spec.zone;
  }
  if (spec.zoneSource !== undefined && (own || zone === null))
    throw refuse('zoneSource', 'records where a given zone came from; give it with a zone');
  if (spec.zoneSource !== undefined && (typeof spec.zoneSource !== 'string' || spec.zoneSource === ''))
    throw refuse('zoneSource', 'is a non-empty string');
  const policy = spec.policy ?? read.policy;
  if (!POLICIES.includes(policy)) throw refuse('policy', `is one of ${POLICIES.join(', ')}`);
  if (own && policy !== read.policy)
    throw refuse('policy', `is the rule's own for a ${read.kind} series ('${read.policy}'): compile the rule under '${policy}'`);
  const missed = spec.missed;
  if (!(missed === 'skip' || missed === 'once'
    || (isRecord(missed) && Object.keys(missed).length === 1 && Number.isSafeInteger(missed.catchUp) && missed.catchUp >= 1)))
    throw refuse('missed', 'is \'skip\', \'once\' or { catchUp: n } with n a whole number from 1');
  let limits = null;
  if (spec.limits !== undefined && spec.limits !== null) {
    if (!isRecord(spec.limits)) throw refuse('limits', `is { ${Object.keys(RECURRENCE_LIMITS).join('?, ')}? }`);
    for (const [name, value] of Object.entries(spec.limits)) {
      if (!Object.hasOwn(RECURRENCE_LIMITS, name)) throw refuse('limits', `holds no '${name}'`);
      if (!Number.isSafeInteger(value) || value < 0) throw refuse('limits', `'${name}' is a whole number from 0`);
    }
    limits = { ...spec.limits };
  }
  const latenessMs = spec.latenessMs ?? null;
  if (latenessMs !== null && !(Number.isSafeInteger(latenessMs) && latenessMs >= 1))
    throw refuse('latenessMs', 'is a positive whole number of milliseconds');
  return {
    id, kind,
    payload: spec.payload === undefined || spec.payload === null ? null : storedJson(spec.payload, 'schedule: "payload"'),
    series: read.series,
    seriesText: JSON.stringify(read.stored),
    seriesKind: read.kind,
    zone,
    zoneSource: spec.zoneSource ?? null,
    policy,
    missed: isRecord(missed) ? { catchUp: missed.catchUp } : missed,
    limits,
    latenessMs,
  };
}

/**
 * The `limits` column's text for a definition: the calendar's limits and
 * the lateness beside them, or NULL when there is neither.
 * @param {ScheduleDefinition} definition
 * @returns {string | null}
 */
function storedLimits(definition) {
  if (definition.latenessMs === null)
    return definition.limits === null ? null : JSON.stringify(definition.limits);
  return JSON.stringify({ ...definition.limits, [LATENESS]: definition.latenessMs });
}

/**
 * The `limits` column read back: the calendar's limits, and the lateness
 * stored beside them.
 * @param {unknown} text
 * @returns {{ limits: Record<string, number> | null, latenessMs: number | null }}
 */
function readLimits(text) {
  if (text === null || text === undefined) return { limits: null, latenessMs: null };
  const { [LATENESS]: latenessMs = null, ...limits } = JSON.parse(String(text));
  return { limits: Object.keys(limits).length === 0 ? null : limits, latenessMs };
}

/**
 * A stored row read back as a definition: the same reader, so a row is
 * computed exactly as the schedule that wrote it.
 * @param {any} row
 * @returns {ScheduleDefinition}
 */
function definitionOfRow(row) {
  const read = reviveSeries(JSON.parse(row.series));
  return {
    id: row.id, kind: row.kind, payload: row.payload ?? null,
    series: read.series, seriesText: row.series, seriesKind: read.kind,
    zone: row.zone ?? read.zone, zoneSource: row.zone_source ?? null,
    policy: row.policy, missed: JSON.parse(row.missed),
    ...readLimits(row.limits),
  };
}

/**
 * The civil date `shift` days from the one an instant reads in a zone.
 * @param {number} at @param {string} zone @param {any} provider @param {number} shift
 */
function civilDate(at, zone, provider, shift) {
  const parts = provider.toParts(at, zone);
  const day = new Date(0);
  day.setUTCFullYear(parts.year, parts.month - 1, parts.day + shift);
  const pad = (n, width) => String(n).padStart(width, '0');
  return dateValue(`${pad(day.getUTCFullYear(), 4)}-${pad(day.getUTCMonth() + 1, 2)}-${pad(day.getUTCDate(), 2)}`);
}

/**
 * The floating value a UTC reading of an instant spells, cut to the second.
 * @param {number} ms
 */
function wallValue(ms) {
  const text = new Date(Math.floor(ms / 1000) * 1000).toISOString();
  return floatingValue(text.slice(0, 10), text.slice(11, 19));
}

/**
 * The wall clock a floating series is expanded over so that every
 * occurrence binding into the instants `[low, high]` is in it: those
 * instants read under each offset the zone keeps around them. A provider
 * that lists its changes (`offsetChanges`) names them, from a day before
 * `low` (a gap moves a time by less than a day) to a day after `high`;
 * without the list, every offset a zone keeps ({@link OFFSET_SPAN}).
 * @param {ScheduleDefinition} definition @param {any} provider @param {number} low @param {number} high
 */
function wallBand(definition, provider, low, high) {
  const zone = /** @type {string} */ (definition.zone);
  let { min, max } = OFFSET_SPAN;
  if (typeof provider.offsetChanges === 'function') {
    const offsets = [provider.toParts(low, zone).offset, provider.toParts(high, zone).offset];
    for (const change of provider.offsetChanges(low - DAY, high + DAY, zone)) offsets.push(change.before, change.after);
    min = Math.min(...offsets) * 60000;
    max = Math.max(...offsets) * 60000;
  }
  return { horizon: [wallValue(low + min), wallValue(high + max + 1000)], max };
}

/**
 * The occurrences of a schedule after `from` (inclusive or not) through
 * `until`, and the first one after `until`: the horizon widens until one
 * is found, the series ends, or a limit stops the search. A floating
 * series is expanded over the wall clock its instants can read
 * ({@link wallBand}) and bound occurrence by occurrence; the limits
 * count the occurrences that bind into the span (`maxOccurrences`) and the
 * provider calls the binding makes (`maxProviderCalls`), so the wall
 * clock either side of the span is work, as a zoned walk's is.
 * @param {ScheduleDefinition} definition - a resolvable one: a zone-less series has its zone
 * @param {any} provider
 * @param {{ from: number, inclusive: boolean, until: number }} span
 * @returns {{ due: { recurrenceId: string, at: number }[], next: { recurrenceId: string, at: number } | null,
 *   stall: null | { limit: string, counts: { emitted: number, work: number, providerCalls: number } }
 *     | { code: string, message: string, recurrenceId: string } }}
 */
function searchSpan(definition, provider, span) {
  const { from, inclusive, until } = span;
  const counts = { emitted: 0, work: 0, providerCalls: 0 };
  const maxDays = definition.limits?.maxHorizonDays ?? RECURRENCE_LIMITS.maxHorizonDays;
  const floating = definition.seriesKind === 'floating';
  const dated = definition.seriesKind === 'date';
  const spanDays = Math.ceil((until - from) / DAY) + 2 * MARGIN_DAYS + 1;
  const maxOccurrences = definition.limits?.maxOccurrences ?? RECURRENCE_LIMITS.maxOccurrences;
  const maxProviderCalls = definition.limits?.maxProviderCalls ?? RECURRENCE_LIMITS.maxProviderCalls;
  // a floating series' occurrences outside the span are the binding's work: the expansion is
  // bounded by maxWork, and the span's own occurrences and the binding's calls are counted here
  const limits = floating
    ? { ...definition.limits, maxOccurrences: definition.limits?.maxWork ?? RECURRENCE_LIMITS.maxWork }
    : definition.limits ?? undefined;
  const meter = { calls: 0 };
  const metered = floating ? {
    ...provider,
    toParts: (/** @type {any[]} */ ...args) => { meter.calls += 1; return provider.toParts(...args); },
    candidates: (/** @type {any[]} */ ...args) => { meter.calls += 1; return provider.candidates(...args); },
  } : provider;
  const instantOf = (/** @type {any} */ occurrence) => {
    if (!floating && !dated) return occurrence.instants.start;
    const bound = bindFloating(occurrence.start, {
      zone: definition.zone, provider: metered, policy: definition.policy,
      ...(definition.zoneSource === null ? {} : { source: definition.zoneSource }),
    });
    return bound.kind === 'instant' ? bound.instant : bound.start;
  };
  const windows = windowsOf(definition.series);
  for (let i = 0; ; i++) {
    const last = i >= windows.length || windows[i] >= (maxDays - spanDays) * DAY;
    const size = last ? (maxDays - spanDays) * DAY : windows[i];
    if (size < DAY && last) return { due: [], next: null, stall: { limit: 'maxHorizonDays', counts } };
    const high = until + size;
    meter.calls = 0;
    const band = floating ? wallBand(definition, metered, from, high) : null;
    const horizon = band !== null ? band.horizon
      : dated
        ? [civilDate(from, /** @type {string} */ (definition.zone), provider, -MARGIN_DAYS),
          civilDate(high, /** @type {string} */ (definition.zone), provider, MARGIN_DAYS)]
        : [from, high];
    const answer = expandSeries(definition.series, { horizon, limits, provider: provider ?? undefined });
    counts.work += answer.counts.work;
    let found = [];
    /** @type {any} */
    let refused = null;
    /** @type {string | null} */
    let stopped = answer.status === 'incomplete' && answer.limit !== 'calendar-end' ? /** @type {string} */ (answer.limit) : null;
    /** Past this instant the occurrences are not all bound: a binding the calls' limit stopped. */
    let proven = Infinity;
    for (const occurrence of answer.occurrences) {
      if (floating && answer.counts.providerCalls + meter.calls >= maxProviderCalls) {
        // every occurrence not bound yet starts at or after this one's wall clock, so binds at most
        // the largest offset before it
        stopped = 'maxProviderCalls';
        proven = Date.parse(`${occurrence.start.date}T${occurrence.start.time}Z`) - /** @type {any} */ (band).max;
        break;
      }
      let at;
      try {
        at = instantOf(occurrence);
      }
      catch (error) {
        // an occurrence its policy refuses to bind (a gap or fold under
        // 'reject') stops the schedule there: the ones before it stand
        const failure = /** @type {any} */ (error);
        if (typeof failure?.code !== 'string' || !failure.code.startsWith('JY')) throw error;
        refused = { code: failure.code, message: failure.message, recurrenceId: occurrence.recurrenceId };
        break;
      }
      if ((inclusive ? at >= from : at > from) && (!floating || at <= high))
        found.push({ recurrenceId: occurrence.recurrenceId, at });
    }
    counts.providerCalls += answer.counts.providerCalls + meter.calls;
    found.sort((a, b) => a.at - b.at || (a.recurrenceId < b.recurrenceId ? -1 : a.recurrenceId > b.recurrenceId ? 1 : 0));
    if (proven !== Infinity) found = found.filter((occurrence) => occurrence.at < proven);
    if (floating && found.length > maxOccurrences) {
      found = found.slice(0, maxOccurrences);
      stopped = 'maxOccurrences';
    }
    counts.emitted += floating ? found.length : answer.counts.emitted;
    const due = found.filter((occurrence) => occurrence.at <= until);
    const next = found.find((occurrence) => occurrence.at > until) ?? null;
    if (next !== null) return { due, next, stall: null };
    if (refused !== null) return { due, next: null, stall: refused };
    // the last spellable day is an end, not a stall
    if (stopped !== null) return { due, next: null, stall: { limit: stopped, counts } };
    if (last || answer.status === 'incomplete') return { due, next: null, stall: null };
  }
}

/**
 * The occurrences of a schedule due after `from` through `until`, and its
 * next one ({@link searchSpan}). When a tick's backlog is longer than the
 * limits let one search read, it is read from the tick backwards: a span
 * ending at the tick, a few of the rule's cycles wide and widening
 * eightfold, until it holds the `keep` latest missed occurrences and the
 * latest due ones beside them — all that `missed` can fire. The
 * occurrences before that span are passed: counted (`passedBefore`) where
 * the rule's step counts them ({@link occurrencesBetween}), from the first
 * one the whole search read to the first one the span read, and otherwise
 * passed without being counted (`uncounted`). A tick's backlog never stalls
 * a schedule; a span its limits cannot read whatever its width does.
 * @param {ScheduleDefinition} definition @param {any} provider
 * @param {{ from: number, inclusive: boolean, until: number }} span
 * @param {number | null} [keep] - the missed occurrences `missed` fires (0, 1 or n), or no backward read
 */
function occurrencesAfter(definition, provider, span, keep = null) {
  const whole = searchSpan(definition, provider, span);
  const stall = /** @type {any} */ (whole.stall);
  if (keep === null || whole.next !== null || stall === null || stall.limit === undefined || stall.limit === 'maxHorizonDays')
    return whole;
  const rule = definition.series.base?.rrule;
  const cycle = (rule === undefined ? DAY : CYCLES[/** @type {keyof typeof CYCLES} */ (rule.FREQ)] * (rule.INTERVAL ?? 1));
  for (let width = cycle * (keep + 1); span.until - width > span.from; width *= 8) {
    const tail = searchSpan(definition, provider, { from: span.until - width, inclusive: true, until: span.until });
    const limited = /** @type {any} */ (tail.stall)?.limit !== undefined;
    if (limited) return whole;
    if (new Set(tail.due.map((occurrence) => occurrence.at)).size > keep || tail.stall !== null) {
      const passedBefore = occurrencesBetween(definition, whole.due[0], tail.due[0]);
      return passedBefore === null ? { ...tail, uncounted: true } : { ...tail, passedBefore };
    }
  }
  return whole;
}

/**
 * Which due occurrences fire. One due more than `latenessMs` before the
 * tick's instant is skipped, whatever `missed` says - the latest one too.
 * Of the rest, an occurrence is missed when a later one was due too by
 * the time a tick saw it; the latest due ones (all those at the latest
 * instant) fire. `skip` fires no missed one, `once` the latest missed
 * one, `{ catchUp: n }` the latest n.
 * @param {{ recurrenceId: string, at: number }[]} due - in order
 * @param {'skip' | 'once' | { catchUp: number }} missed
 * @param {number | null} latenessMs - how late an occurrence may fire, or no bound
 * @param {number} at - the tick's instant
 */
function firedOf(due, missed, latenessMs, at) {
  const timely = latenessMs === null ? due : due.filter((occurrence) => at - occurrence.at <= latenessMs);
  const tooLate = due.length - timely.length;
  if (timely.length === 0) return { fire: [], skipped: tooLate };
  const latest = timely[timely.length - 1].at;
  const late = timely.filter((occurrence) => occurrence.at < latest);
  const current = timely.slice(late.length);
  const take = missed === 'skip' ? 0 : missed === 'once' ? Math.min(1, late.length) : Math.min(missed.catchUp, late.length);
  return { fire: [...late.slice(late.length - take), ...current], skipped: late.length - take + tooLate };
}

/** @param {unknown} value */
const epoch = (value) => (value === null || value === undefined ? null : Number(value));

/**
 * A stored schedule, surfaced camel-cased and frozen.
 * @param {any} row
 */
function publicSchedule(row) {
  return Object.freeze({
    id: row.id,
    kind: row.kind,
    payload: row.payload === null || row.payload === undefined ? null : JSON.parse(row.payload),
    series: JSON.parse(row.series),
    zone: row.zone ?? null,
    zoneSource: row.zone_source ?? null,
    policy: row.policy,
    missed: JSON.parse(row.missed),
    ...readLimits(row.limits),
    state: row.state,
    nextRunAt: epoch(row.next_run_at),
    nextRecurrenceId: row.next_recurrence_id ?? null,
    lastRunAt: epoch(row.last_run_at),
    lastRecurrenceId: row.last_recurrence_id ?? null,
    providerRevision: row.provider_revision ?? null,
    counts: JSON.parse(row.counts),
    stall: row.stall === null || row.stall === undefined ? null : JSON.parse(row.stall),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  });
}

/**
 * The schedule operations over one queue engine's connection (§11):
 * `schedule`, `unschedule`, `schedules` and `tick`, each the engine's
 * value-or-promise. `writing` is the queue's transaction for work that
 * reads before it writes.
 * @param {{ connection: any, prepared: (key: string, text?: string) => any, now: () => number,
 *   bracket: (fn: () => any) => any, writing: (fn: () => any) => any, wake: () => void,
 *   storedJson: (value: unknown, what: string) => string,
 *   adopt: boolean, maxAttempts: number, provider: any }} context
 */
function attach(context) {
  const { connection, prepared: preparedJob, now, bracket, writing, wake, storedJson, adopt, maxAttempts, provider } = context;
  const sql = scheduleStatements(connection.dialect);
  /** A schedule statement, prepared once through the queue's own cache and failure wrap. @param {string} key */
  const prepared = (key, text = sql[key]) => preparedJob(key, text);
  const scheduleTable = sql.schema;
  /** Whether the schedule table is known to exist; checked again until it is. */
  let schedulesExist = false;
  const schedulesPresent = () => schedulesExist ? true : chain(
    prepared('scheduleColumns', connection.dialect.introspect.columns(JOB_SCHEDULES_TABLE)).all([]),
    (/** @type {any[]} */ rows) => {
      if (rows.length === 0) return false;
      const names = new Set(rows.map((row) => row.name));
      const missing = scheduleTable.columns.filter((name) => !names.has(name));
      if (missing.length > 0) {
        throw new DbCompileError('JD0002', `the schedule table ${JOB_SCHEDULES_TABLE} lacks ${missing.join(', ')}: `
          + 'it needs an explicit schema migration', '/jobs/schedule');
      }
      schedulesExist = true;
      return true;
    });
  /** The first schedule a store writes creates the table, so a queue that never schedules keeps the tables it had. */
  const ensureSchedules = () => chain(schedulesPresent(), (present) => {
    if (present) return undefined;
    if (adopt) {
      throw new DbCompileError('JD0002', `the schedule table ${JOB_SCHEDULES_TABLE} does not exist and an adopted store `
        + '({ adopt: true }) creates nothing: open the store once without adopt to create it', '/jobs/schedule');
    }
    return chain(attempt(() => bracket(() => chain(connection.dialect.jobs?.initialize?.(connection),
      () => connection.exec(scheduleTable.create))), (error) => new DbCompileError('JD0002',
      `the schedule table could not be created (${error?.message ?? String(error)}) — a read-only store creates nothing`,
      '/jobs/schedule', error)), () => { schedulesExist = true; });
  });

  /**
   * Where a schedule stands from a cursor: its due occurrences through
   * `until`, its next one, and the state that leaves it in. A zone-less
   * series with no zone is `unresolved`; a series with no occurrence left
   * is `ended`; a search a limit stopped is `stalled`, with its counts.
   * @param {any} definition - a schedule definition the seam read
   * @param {number} from @param {boolean} inclusive @param {number} until
   * @param {number | null} [keep] - for a tick, the missed occurrences its policy fires
   */
  const standing = (definition, from, inclusive, until, keep = null) => {
    if (definition.zone === null && definition.seriesKind !== 'utc') return { state: 'unresolved', due: [], next: null, stall: null };
    const out = occurrencesAfter(definition, provider, { from, inclusive, until }, keep);
    return { ...out, state: out.next !== null ? 'active' : out.stall !== null ? 'stalled' : 'ended' };
  };
  /** @param {any} definition */
  const revisionOf = (definition) => (definition.zone === null ? null : provider?.identity?.revision ?? null);

  /**
   * Write a recurring schedule (§11): validated and computed now, so an
   * invalid rule, an unknown zone or a zone with no provider refuses
   * here and never at a fire. Writing an existing id replaces its
   * definition and keeps its history: the next occurrence is the first
   * after its last fired one (or from its creation, when none fired).
   * @param {any} spec
   */
  const schedule = (spec) => {
    const definition = readSchedule(spec, storedJson, provider);
    return chain(ensureSchedules(), () => writing(() => chain(
      prepared('scheduleGet').get([definition.id]), (/** @type {any} */ existing) => {
        const at = now();
        const createdAt = existing === undefined ? at : Number(existing.created_at);
        const lastRunAt = existing?.last_run_at === null || existing?.last_run_at === undefined
          ? null : Number(existing.last_run_at);
        const from = lastRunAt ?? createdAt;
        const { state, next, stall } = standing(definition, from, lastRunAt === null,
          lastRunAt === null ? from - 1 : from);
        const values = [definition.id, definition.kind, definition.payload, definition.seriesText,
          definition.zone, definition.zoneSource, definition.policy, JSON.stringify(definition.missed),
          storedLimits(definition), state,
          next?.at ?? null, next?.recurrenceId ?? null, lastRunAt, existing?.last_recurrence_id ?? null,
          revisionOf(definition), existing?.counts ?? JSON.stringify({ fired: 0, skipped: 0 }),
          stall === null ? null : JSON.stringify(stall), createdAt, at];
        return chain(prepared('schedulePut').run(values), () =>
          publicSchedule(Object.fromEntries(SCHEDULE_COLUMNS.map((name, i) => [name, values[i]]))));
      })));
  };

  /** Remove a schedule; the jobs it already fired stay queued. `false` when there was none.
   * @param {string} id */
  const unschedule = (id) => {
    if (typeof id !== 'string' || id === '') throw new TypeError('unschedule: id is a non-empty string');
    return chain(schedulesPresent(), (present) => !present ? false
      : chain(prepared('scheduleDelete').run([id]), (out) => Number(out.changes ?? 0) > 0));
  };

  /** Every schedule, by id. */
  const schedules = () => chain(schedulesPresent(), (present) => !present ? Object.freeze([])
    : chain(prepared('scheduleList').all([]), (/** @type {any[]} */ rows) => Object.freeze(rows.map(publicSchedule))));

  /**
   * Fire the due schedules, earliest first, at most `limit` of them, in
   * one transaction: each due occurrence the `missed` policy keeps is
   * enqueued as job `${scheduleId}@${recurrenceId}` (the idempotent
   * enqueue, so no occurrence fires twice), and the schedule advances to
   * its next occurrence, guarded by the one it was due at. A schedule
   * whose computation fails or is stopped by a limit is left `stalled`
   * with the reason; it never fails the tick.
   * @param {{ limit?: number }} [tickOptions]
   */
  const tick = (tickOptions = undefined) => {
    readOptionsOrNull(tickOptions, TICK_OPTIONS, 'jobs.tick');
    const limit = tickOptions?.limit ?? PAGE_LIMIT_DEFAULT;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('tick: limit is a positive integer');
    /** @type {string[]} */
    const fired = [];
    let skipped = 0;
    const idle = () => Object.freeze({ fired: Object.freeze([]), skipped: 0, advanced: 0, more: false });
    // nothing due answers from a read alone: the write lock is taken only
    // when there is a row to advance, and the due rows are read again under it
    return chain(schedulesPresent(), (present) => !present ? idle()
      : chain(prepared('scheduleDue').all([now(), limit]), (/** @type {any[]} */ due) => due.length === 0 ? idle()
      : chain(writing(() => {
        fired.length = 0;
        skipped = 0;
        const at = now();
        return chain(prepared('scheduleDue').all([at, limit]), (/** @type {any[]} */ rows) => {
          const step = (i) => {
            if (i >= rows.length) return rows.length;
            const row = rows[i];
            const lastRunAt = row.last_run_at === null || row.last_run_at === undefined ? null : Number(row.last_run_at);
            /** @type {any} */
            let outcome;
            let definition = null;
            // a fault of this process refuses the tick and leaves every row as it was;
            // only a fault of the schedule's own data stalls it
            if (provider === null && row.zone !== null && row.zone !== undefined) {
              throw new DbCompileError('JD0016', `jobs.tick met schedule '${row.id}' in zone ${row.zone}: `
                + 'a tick needs the runtime\'s zone provider (runtime.zoneProvider)', '/jobs/tick');
            }
            try {
              definition = definitionOfRow(row);
              const missed = JSON.parse(row.missed);
              outcome = standing(definition, lastRunAt ?? Number(row.created_at), lastRunAt === null, at,
                missed === 'skip' ? 0 : missed === 'once' ? 1 : missed.catchUp);
            }
            catch (error) {
              const failure = /** @type {any} */ (error);
              if (typeof failure?.code !== 'string' || !failure.code.startsWith('JY')) throw error;
              outcome = { state: 'stalled', due: [], next: null, stall: { code: failure.code, message: failure.message } };
            }
            const { fire, skipped: late } = firedOf(outcome.due, JSON.parse(row.missed), readLimits(row.limits).latenessMs, at);
            // a backlog read from the tick backwards passed the occurrences before the span it read
            const passed = late + (outcome.passedBefore ?? 0);
            const counts = JSON.parse(row.counts);
            counts.fired += fire.length;
            counts.skipped += passed;
            // ... or passed them without counting them, where the rule's step does not count them
            if (outcome.uncounted === true) counts.uncounted = (counts.uncounted ?? 0) + 1;
            skipped += passed;
            const latest = outcome.due.length === 0 ? null : outcome.due[outcome.due.length - 1];
            const advance = () => chain(prepared('scheduleAdvance').run([
              outcome.state, outcome.next?.at ?? null, outcome.next?.recurrenceId ?? null,
              latest?.at ?? lastRunAt, latest?.recurrenceId ?? row.last_recurrence_id ?? null,
              definition === null ? row.provider_revision ?? null : revisionOf(definition),
              JSON.stringify(counts), outcome.stall === null ? null : JSON.stringify(outcome.stall), at,
              row.id, row.next_run_at]), () => step(i + 1));
            const enqueueAll = (j) => {
              if (j >= fire.length) return advance();
              const jobId = `${row.id}@${fire[j].recurrenceId}`;
              return chain(preparedJob('enqueue').run([jobId, row.kind, row.payload ?? null, fire[j].at,
                maxAttempts, at, at]), () => {
                fired.push(jobId);
                return enqueueAll(j + 1);
              });
            };
            return enqueueAll(0);
          };
          return step(0);
        });
      }), (advanced) => {
        if (fired.length > 0) wake();
        return Object.freeze({ fired: Object.freeze(fired), skipped, advanced, more: advanced === limit });
      })));
  };

  return {
    schedule, unschedule, schedules, tick,
    // a worker's own view of the table (§6): whether it is known to
    // exist, read without a statement, and the probe that learns it
    known: () => schedulesExist,
    present: schedulesPresent,
  };
}

/**
 * Enable recurring job schedules on a store: pass the answer as
 * `openStore(model, { jobs: { schedules: jobSchedules() } })`. Without
 * it every schedule call refuses `JD0016`.
 * @returns {import('../types/schedules.js').JobSchedules}
 * @example
 * import { jobSchedules } from '@jarenjs/db/schedules';
 * const store = await openStore(model, { driver, runtime, jobs: { schedules: jobSchedules() } });
 */
export function jobSchedules() {
  const seam = Object.freeze({ attach });
  SCHEDULE_SEAMS.add(seam);
  return /** @type {any} */ (seam);
}
