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
  compileRecurrence, defineSeries, expandSeries, bindFloating, assertZone, dateValue, RECURRENCE_LIMITS,
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
const SCHEDULE_OPTIONS = Object.freeze(['id', 'kind', 'payload', 'series', 'zone', 'zoneSource', 'policy', 'missed', 'limits']);
const POLICIES = Object.freeze(['rfc5545', 'later', 'reject']);
const DAY = 86400000;
/** The horizons a search for the next occurrence widens through, in days; the last is the limit's whole horizon. */
const WINDOWS = Object.freeze([8, 64, 512, 4096]);
/** Days of civil-date margin either side of a floating horizon: no zone's offset reaches a day. */
const MARGIN_DAYS = 2;

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
 */

/**
 * Read a schedule definition, refusing a malformed member `JD0013` and
 * an invalid recurrence with the calendar's own code (`JY0020` for a
 * frequency the calendar does not enumerate), before anything is stored.
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
  };
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
    limits: row.limits === null || row.limits === undefined ? null : JSON.parse(row.limits),
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
 * The occurrences of a schedule after `from` (inclusive or not) through
 * `until`, and the first one after `until`: the horizon widens until one
 * is found, the series ends, or a limit stops the search.
 * @param {ScheduleDefinition} definition - a resolvable one: a zone-less series has its zone
 * @param {any} provider
 * @param {{ from: number, inclusive: boolean, until: number }} span
 * @returns {{ due: { recurrenceId: string, at: number }[], next: { recurrenceId: string, at: number } | null,
 *   stall: null | { limit: string, counts: { emitted: number, work: number, providerCalls: number } }
 *     | { code: string, message: string, recurrenceId: string } }}
 */
function occurrencesAfter(definition, provider, span) {
  const { from, inclusive, until } = span;
  const counts = { emitted: 0, work: 0, providerCalls: 0 };
  const maxDays = definition.limits?.maxHorizonDays ?? RECURRENCE_LIMITS.maxHorizonDays;
  const floating = definition.seriesKind === 'floating' || definition.seriesKind === 'date';
  const spanDays = Math.ceil((until - from) / DAY) + 2 * MARGIN_DAYS + 1;
  const instantOf = (/** @type {any} */ occurrence) => {
    if (!floating) return occurrence.instants.start;
    const bound = bindFloating(occurrence.start, {
      zone: definition.zone, provider, policy: definition.policy,
      ...(definition.zoneSource === null ? {} : { source: definition.zoneSource }),
    });
    return bound.kind === 'instant' ? bound.instant : bound.start;
  };
  for (let i = 0; ; i++) {
    const last = i >= WINDOWS.length || WINDOWS[i] >= maxDays - spanDays;
    const size = last ? maxDays - spanDays : WINDOWS[i];
    if (size < 1) return { due: [], next: null, stall: { limit: 'maxHorizonDays', counts } };
    const high = until + size * DAY;
    const horizon = floating
      ? [civilDate(from, /** @type {string} */ (definition.zone), provider, -MARGIN_DAYS),
        civilDate(high, /** @type {string} */ (definition.zone), provider, MARGIN_DAYS)]
      : [from, high];
    const answer = expandSeries(definition.series, {
      horizon, limits: definition.limits ?? undefined, provider: provider ?? undefined });
    counts.emitted += answer.counts.emitted;
    counts.work += answer.counts.work;
    counts.providerCalls += answer.counts.providerCalls;
    const found = [];
    /** @type {any} */
    let refused = null;
    for (const occurrence of answer.occurrences) {
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
      if (inclusive ? at >= from : at > from) found.push({ recurrenceId: occurrence.recurrenceId, at });
    }
    found.sort((a, b) => a.at - b.at || (a.recurrenceId < b.recurrenceId ? -1 : a.recurrenceId > b.recurrenceId ? 1 : 0));
    const due = found.filter((occurrence) => occurrence.at <= until);
    const next = found.find((occurrence) => occurrence.at > until) ?? null;
    if (next !== null) return { due, next, stall: null };
    if (refused !== null) return { due, next: null, stall: refused };
    // the last spellable day is an end, not a stall
    if (answer.status === 'incomplete' && answer.limit !== 'calendar-end')
      return { due, next: null, stall: { limit: /** @type {string} */ (answer.limit), counts } };
    if (last || answer.status === 'incomplete') return { due, next: null, stall: null };
  }
}

/**
 * Which due occurrences fire. An occurrence is missed when a later one
 * was due too by the time a tick saw it; the latest due ones (all those
 * at the latest instant) always fire. `skip` fires no missed one,
 * `once` the latest missed one, `{ catchUp: n }` the latest n.
 * @param {{ recurrenceId: string, at: number }[]} due - in order
 * @param {'skip' | 'once' | { catchUp: number }} missed
 */
function firedOf(due, missed) {
  if (due.length === 0) return { fire: [], skipped: 0 };
  const latest = due[due.length - 1].at;
  const late = due.filter((occurrence) => occurrence.at < latest);
  const current = due.slice(late.length);
  const take = missed === 'skip' ? 0 : missed === 'once' ? Math.min(1, late.length) : Math.min(missed.catchUp, late.length);
  return { fire: [...late.slice(late.length - take), ...current], skipped: late.length - take };
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
    limits: row.limits === null || row.limits === undefined ? null : JSON.parse(row.limits),
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
 * value-or-promise.
 * @param {{ connection: any, prepared: (key: string, text?: string) => any, now: () => number,
 *   bracket: (fn: () => any) => any, wake: () => void, storedJson: (value: unknown, what: string) => string,
 *   adopt: boolean, maxAttempts: number, provider: any }} context
 */
function attach(context) {
  const { connection, prepared: preparedJob, now, bracket, wake, storedJson, adopt, maxAttempts, provider } = context;
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
   */
  const standing = (definition, from, inclusive, until) => {
    if (definition.zone === null && definition.seriesKind !== 'utc') return { state: 'unresolved', due: [], next: null, stall: null };
    const out = occurrencesAfter(definition, provider, { from, inclusive, until });
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
    return chain(ensureSchedules(), () => connection.transaction(() => chain(
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
          definition.limits === null ? null : JSON.stringify(definition.limits), state,
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
    return chain(schedulesPresent(), (present) => !present ? Object.freeze({ fired: Object.freeze([]), skipped: 0, advanced: 0, more: false })
      : chain(connection.transaction(() => {
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
              outcome = standing(definition, lastRunAt ?? Number(row.created_at), lastRunAt === null, at);
            }
            catch (error) {
              const failure = /** @type {any} */ (error);
              if (typeof failure?.code !== 'string' || !failure.code.startsWith('JY')) throw error;
              outcome = { state: 'stalled', due: [], next: null, stall: { code: failure.code, message: failure.message } };
            }
            const { fire, skipped: passed } = firedOf(outcome.due, JSON.parse(row.missed));
            const counts = JSON.parse(row.counts);
            counts.fired += fire.length;
            counts.skipped += passed;
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
      }));
  };

  return { schedule, unschedule, schedules, tick };
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
