//@ts-check
/** Queue SQL vocabulary shared by SQLite and PostgreSQL job execution. */
import { JOBS_TABLE, JOB_CHECKPOINTS_TABLE } from '../engine-metadata.js';

/** The schema declaration also supplies upgrade definitions and verification data.
 * @param {any} dialect @returns {any} */
export function jobSchema(dialect) {
  const strategy = dialect.jobs ?? {};
  const numeric = strategy.numericType ?? 'INTEGER';
  const required = 'NOT NULL', zero = 'NOT NULL DEFAULT 0';
  const text = strategy.textType ?? 'TEXT';
  const tables = [
    { name: JOBS_TABLE, keys: ['id'], columns: [
      ['id', text, 'PRIMARY KEY'], ['kind', text, required], ['payload', text, ''],
      ['state', text, "NOT NULL DEFAULT 'pending'"], ['run_at', numeric, required],
      ['attempts', numeric, zero], ['max_attempts', numeric, required],
      ['lease_until', numeric, ''], ['lease_owner', text, ''],
      ['lease_generation', numeric, zero, true], ['lease_token', text, '', true],
      ['last_error', text, ''], ['result', text, ''],
      ['created_at', numeric, required], ['updated_at', numeric, required],
    ] },
    { name: JOB_CHECKPOINTS_TABLE, keys: ['run_id', 'node_id'], columns: [
      ['run_id', text, required], ['node_id', text, required],
      ['value', text, required], ['generation', numeric, zero, true],
    ] },
  ];
  const q = dialect.quoteIdentifier;
  const declaration = (column) => `${q(column[0])} ${column[1]} ${column[2]}`.trim();
  const create = tables.map((table) => `CREATE TABLE IF NOT EXISTS ${q(table.name)} (`
    + table.columns.map(declaration).join(', ')
    + (table.keys.length > 1 ? `, PRIMARY KEY (${table.keys.map(q).join(', ')})` : '') + ');')
    .join('\n') + `\nCREATE INDEX IF NOT EXISTS ${q(`${JOBS_TABLE}_claim`)} ON ${q(JOBS_TABLE)} (state, run_at);`;
  const added = tables.flatMap((table) => table.columns.filter((column) => column[3])
    .map((column) => ({ table: table.name, name: column[0],
      sql: `ALTER TABLE ${q(table.name)} ADD COLUMN ${declaration(column)}` })));
  return { tables, create, added };
}

/** All values stay parameters; backend strategies add only trusted SQL vocabulary.
 * @param {any} dialect @returns {any} */
export function jobStatements(dialect) {
  const strategy = dialect.jobs ?? {};
  const p = (i) => dialect.parameterRef(i, 'job');
  const jobs = dialect.quoteIdentifier(JOBS_TABLE);
  const checkpoints = dialect.quoteIdentifier(JOB_CHECKPOINTS_TABLE);
  // A settling statement always guards the attempt token and its live expiry.
  const fence = (i) => `state='leased' AND lease_token=${p(i)} AND lease_until>${p(i + 1)}`;
  const update = (set, where, returning = '') => `UPDATE ${jobs} SET ${set} WHERE ${where}${returning}`;
  const release = 'lease_until=NULL, lease_token=NULL';
  const settle = (set, start) => update(set, `id=${p(start)} AND ${fence(start + 1)}`);
  const cancelled = `state='cancelled', last_error='cancelled', ${release}, updated_at=${p(1)}`;
  const readCheckpoint = (columns, where) => `SELECT ${columns} FROM ${checkpoints} WHERE run_id=${p(1)} AND ${where}`;
  const checkLease = `SELECT id FROM ${jobs} WHERE id=${p(1)} AND ${fence(2)}${strategy.rowLock ?? ''}`;
  return {
    schema: jobSchema(dialect),
    enqueue: `INSERT INTO ${jobs} (id,kind,payload,state,run_at,max_attempts,created_at,updated_at) VALUES (${p(1)},${p(2)},${p(3)},'pending',${p(4)},${p(5)},${p(6)},${p(7)}) ON CONFLICT (id) DO NOTHING`,
    get: `SELECT * FROM ${jobs} WHERE id=${p(1)}`,
    counts: `SELECT state, COUNT(*) AS n FROM ${jobs} GROUP BY state`,
    pendingKinds: `SELECT kind, COUNT(*) AS n FROM ${jobs} WHERE state IN ('pending', 'failed') GROUP BY kind`,
    claim: (count) => update(`state='leased', lease_owner=${p(1)}, lease_until=${p(2)}, lease_generation=lease_generation+1, lease_token=${p(3)}, attempts=attempts+1, updated_at=${p(4)}`, `id = (SELECT id FROM ${jobs} WHERE (state='pending' OR state='failed' OR (state='leased' AND lease_until<${p(5)})) AND run_at<=${p(6)} AND kind IN (${Array.from({ length: count }, (_, i) => p(i + 7)).join(', ')}) ORDER BY run_at, created_at, id LIMIT 1${strategy.claimLock ?? ''})`, ' RETURNING *'),
    fenceRow: `SELECT state, lease_token, lease_until, lease_generation FROM ${jobs} WHERE id=${p(1)}`,
    assertLease: checkLease,
    renew: update(`lease_until=${p(1)}, lease_token=${p(2)}, updated_at=${p(3)}`, `id=${p(4)} AND ${fence(5)}`, ' RETURNING *'),
    complete: settle(`state='done', result=${p(1)}, ${release}, updated_at=${p(2)}`, 3),
    dead: settle(`state='dead', last_error=${p(1)}, ${release}, updated_at=${p(2)}`, 3),
    retry: settle(`state='failed', last_error=${p(1)}, ${release}, run_at=${p(2)}, updated_at=${p(3)}`, 4),
    cpIdentity: readCheckpoint('value', `node_id=${p(2)} AND generation<=${p(3)}`),
    cpHasValues: readCheckpoint('1 AS present', `node_id<>${p(2)} AND generation<=${p(3)} LIMIT 1`),
    cpLoad: readCheckpoint('node_id, value', `generation<=${p(2)}`),
    cpFence: checkLease,
    cpSave: `INSERT INTO ${checkpoints} (run_id,node_id,value,generation) VALUES (${p(1)},${p(2)},${p(3)},${p(4)}) ON CONFLICT (run_id,node_id) DO UPDATE SET value=excluded.value, generation=excluded.generation`,
    cpPrune: `DELETE FROM ${checkpoints} WHERE run_id=${p(1)} AND generation<=${p(2)}`,
    cancelQueued: update(cancelled, `id=${p(2)} AND state IN ('pending', 'failed')`),
    cancelLeased: settle(cancelled, 2),
    requeue: update(`state='pending', run_at=${p(1)}, ${release}, lease_owner=NULL, updated_at=${p(2)}`, `id=${p(3)} AND (state IN ('failed', 'dead', 'cancelled') OR (state='leased' AND lease_until<${p(4)}))`),
    resetJob: update(`state='pending', attempts=0, result=NULL, last_error=NULL, run_at=${p(1)}, updated_at=${p(2)}, ${release}, lease_owner=NULL, lease_generation=lease_generation+1`, `id=${p(3)} AND lease_generation=${p(4)} AND state<>'done' AND (state<>'leased' OR lease_until<=${p(5)})`),
    resetCheckpoints: `DELETE FROM ${checkpoints} WHERE run_id=${p(1)}`,
    page: (state, kind, after, limit) => {
      const conditions = [`id>${p(1)}`], params = [after ?? ''];
      if (state !== undefined) { params.push(state); conditions.push(`state=${p(params.length)}`); }
      if (kind !== undefined) { params.push(kind); conditions.push(`kind=${p(params.length)}`); }
      params.push(limit);
      return { sql: `SELECT * FROM ${jobs} WHERE ${conditions.join(' AND ')} ORDER BY id LIMIT ${p(params.length)}`, params };
    },
    sweep: (bounded) => {
      const selection = `SELECT id FROM ${jobs} WHERE state IN ('done', 'dead', 'cancelled') AND updated_at<${p(1)} ORDER BY updated_at, id${bounded ? ` LIMIT ${p(2)}` : ''}`;
      return strategy.sweep ? [strategy.sweep(selection, jobs, checkpoints)] : [
        `DELETE FROM ${checkpoints} WHERE run_id IN (${selection})`,
        `DELETE FROM ${jobs} WHERE id IN (${selection})`,
      ];
    },
  };
}
