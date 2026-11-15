//@ts-check
/** Recurring-schedule SQL shared by SQLite and PostgreSQL (JOBS-FORMAT §11): read only by `@jarenjs/db/schedules`. */
import { JOB_SCHEDULES_TABLE } from '../engine-metadata.js';

/** The schedule table's columns, in declaration order. */
export const SCHEDULE_COLUMNS = Object.freeze(['id', 'kind', 'payload', 'series', 'zone', 'zone_source', 'policy',
  'missed', 'limits', 'state', 'next_run_at', 'next_recurrence_id', 'last_run_at', 'last_recurrence_id',
  'provider_revision', 'counts', 'stall', 'created_at', 'updated_at']);

/**
 * The recurring-schedule table: epoch milliseconds in the queue's number
 * type, canonical text, and JSON held as text, so both engines store and
 * compare the same values. It stands apart from {@link jobSchema}'s
 * tables: the first schedule a store writes creates it, so a queue that
 * never schedules keeps exactly the tables it had.
 * @param {any} dialect @returns {{ table: string, columns: readonly string[], create: string }}
 */
export function scheduleSchema(dialect) {
  const strategy = dialect.jobs ?? {};
  const numeric = strategy.numericType ?? 'INTEGER';
  const text = strategy.textType ?? 'TEXT';
  const q = dialect.quoteIdentifier;
  const types = { next_run_at: numeric, last_run_at: numeric, created_at: numeric, updated_at: numeric };
  const required = new Set(['kind', 'series', 'missed', 'state', 'counts', 'created_at', 'updated_at']);
  const declaration = (name) => `${q(name)} ${types[name] ?? text}${name === 'id' ? ' PRIMARY KEY'
    : required.has(name) ? ' NOT NULL' : ''}`;
  return {
    table: JOB_SCHEDULES_TABLE,
    columns: SCHEDULE_COLUMNS,
    create: `CREATE TABLE IF NOT EXISTS ${q(JOB_SCHEDULES_TABLE)} (${SCHEDULE_COLUMNS.map(declaration).join(', ')});\n`
      + `CREATE INDEX IF NOT EXISTS ${q(`${JOB_SCHEDULES_TABLE}_due`)} ON ${q(JOB_SCHEDULES_TABLE)} (state, next_run_at);`,
  };
}

/** The schedule statements; every value stays a parameter, and the
 * backend's queue strategy adds only its lock spellings.
 * @param {any} dialect @returns {any} */
export function scheduleStatements(dialect) {
  const strategy = dialect.jobs ?? {};
  const p = (i) => dialect.parameterRef(i, 'job');
  const schedules = dialect.quoteIdentifier(JOB_SCHEDULES_TABLE);
  const scheduleNames = SCHEDULE_COLUMNS.map((name) => dialect.quoteIdentifier(name));
  const advanced = ['state', 'next_run_at', 'next_recurrence_id', 'last_run_at', 'last_recurrence_id',
    'provider_revision', 'counts', 'stall', 'updated_at'];
  return {
    schema: scheduleSchema(dialect),
    // a schedule is written whole; its first write keeps its created_at
    schedulePut: `INSERT INTO ${schedules} (${scheduleNames.join(',')}) VALUES (${scheduleNames.map((_, i) => p(i + 1)).join(',')}) `
      + `ON CONFLICT (id) DO UPDATE SET ${scheduleNames.slice(1, -2).concat(scheduleNames.slice(-1))
        .map((name) => `${name}=excluded.${name}`).join(', ')}`,
    // read for a rewrite: the row is held until the write commits
    scheduleGet: `SELECT * FROM ${schedules} WHERE id=${p(1)}${strategy.rowLock ?? ''}`,
    scheduleList: `SELECT * FROM ${schedules} ORDER BY id`,
    scheduleDelete: `DELETE FROM ${schedules} WHERE id=${p(1)}`,
    // the due rows, earliest first; a NULL next_run_at is never due. Rows
    // another ticker holds are passed over, as a claim passes over a job
    scheduleDue: `SELECT * FROM ${schedules} WHERE state='active' AND next_run_at<=${p(1)} ORDER BY next_run_at, id LIMIT ${p(2)}${strategy.claimLock ?? ''}`,
    // guarded by the next_run_at the tick read, so one due row advances once
    scheduleAdvance: `UPDATE ${schedules} SET ${advanced.map((name, i) => `${name}=${p(i + 1)}`).join(', ')} `
      + `WHERE id=${p(advanced.length + 1)} AND next_run_at=${p(advanced.length + 2)}`,
  };
}
