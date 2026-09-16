//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { postgresDialect } from '@jarenjs/db/postgres';
import { jobSchema } from '../../packages/db/src/dialects/jobs.js';

const dialect = postgresDialect();
const schema = jobSchema(dialect);

// Independent catalog fixture: native adoption must reject incompatible storage
// before workers can trust its lease records, without repairing anything.
function catalog() {
  const rows = [];
  const object = (owner, type, name, metadata, sql = null) =>
    rows.push({ schema: 'tenant', owner, type, name, metadata, sql });
  for (const [table, keys, text, numeric, nullable, defaults] of [
    ['_jaren_jobs', ['id'],
      'id kind payload state lease_owner lease_token last_error result',
      'run_at attempts max_attempts lease_until lease_generation created_at updated_at',
      'payload lease_until lease_owner lease_token last_error result',
      { state: "'pending'::text", attempts: '0', lease_generation: '0' }],
    ['_jaren_job_checkpoints', ['run_id', 'node_id'], 'run_id node_id value',
      'generation', '', { generation: '0' }],
  ]) {
    object(table, 'table', table, { kind: 'r' });
    object(table, 'constraint', `${table}_pkey`, { kind: 'p', columns: keys,
      deferrable: false, validated: true });
    object(table, 'index', `${table}_pkey`, { primary: true, valid: true, ready: true });
    for (const [type, names] of [['text', text], ['numeric', numeric]])
      for (const name of names.split(' ')) object(table, 'column', name, {
        type, typeKind: 'b', generated: '', identity: '',
        nullable: nullable.split(' ').includes(name), collation: type === 'text' ? 'C' : null,
      }, defaults[name] ?? null);
  }
  object('_jaren_jobs', 'index', '_jaren_jobs_claim', { valid: true, ready: true,
    unique: false, method: 'btree', predicate: null, expressions: null, keyCount: 2 });
  return rows;
}

function connection(rows, keys = ['state', 'run_at']) {
  return { dialect, async prepare(sql) {
    if (sql === 'SELECT current_schema() AS name') return { get: async () => ({ name: 'tenant' }) };
    if (sql === dialect.introspect.catalog()) return { all: async () => rows };
    assert.equal(sql, dialect.introspect.indexColumns('_jaren_jobs_claim'));
    return { all: async () => keys.map((name) => ({ name })) };
  }, exec() { assert.fail('adoption must not write or repair infrastructure'); } };
}

describe('PostgreSQL queue catalog admission', () => {
  it('accepts complete native metadata and ignores same-named objects in another schema', async () => {
    const rows = catalog();
    const foreign = structuredClone(rows).map((row) => ({ ...row, schema: 'other', metadata: {} }));
    await dialect.jobs.verify(connection([...foreign, ...rows]), schema);
    await dialect.jobs.verify(connection(rows.map((row) => ({ ...row,
      metadata: JSON.stringify(row.metadata) }))), schema);
  });

  for (const [label, type, name, mutation, message] of [
    ['view', 'table', '_jaren_jobs', { kind: 'v' }, /job table/],
    ['different primary key', 'constraint', '_jaren_jobs_pkey', { columns: ['kind'] }, /job table/],
    ['deferred primary key', 'constraint', '_jaren_jobs_pkey', { deferrable: true }, /job table/],
    ['unvalidated key', 'constraint', '_jaren_jobs_pkey', { validated: false }, /job table/],
    ['integer epoch', 'column', 'run_at', { type: 'integer' }, /job column/],
    ['domain epoch', 'column', 'run_at', { typeKind: 'd' }, /job column/],
    ['nullable fence', 'column', 'lease_generation', { nullable: true }, /job column/],
    ['generated token', 'column', 'lease_token', { generated: 's' }, /job column/],
    ['identity counter', 'column', 'attempts', { identity: 'a' }, /job column/],
    ['locale ordering', 'column', 'id', { collation: 'default' }, /job column/],
    ['invalid primary index', 'index', '_jaren_jobs_pkey', { valid: false }, /primary key/],
    ['unready primary index', 'index', '_jaren_jobs_pkey', { ready: false }, /primary key/],
    ['invalid claim index', 'index', '_jaren_jobs_claim', { valid: false }, /job index/],
    ['unique claim index', 'index', '_jaren_jobs_claim', { unique: true }, /job index/],
    ['partial claim index', 'index', '_jaren_jobs_claim', { predicate: 'state IS NOT NULL' }, /job index/],
    ['expression claim index', 'index', '_jaren_jobs_claim', { expressions: 'lower(state)' }, /job index/],
    ['hash claim index', 'index', '_jaren_jobs_claim', { method: 'hash' }, /job index/],
    ['extra claim key', 'index', '_jaren_jobs_claim', { keyCount: 3 }, /job index/],
  ]) it(`refuses ${label} without DDL`, async () => {
    const rows = catalog();
    Object.assign(rows.find((row) => row.type === type && row.name === name).metadata, mutation);
    await assert.rejects(dialect.jobs.verify(connection(rows), schema), message);
  });

  it('refuses missing infrastructure, changed defaults, foreign index ownership and reordered keys', async () => {
    for (const name of ['_jaren_jobs', '_jaren_jobs_pkey', 'lease_token', '_jaren_jobs_claim'])
      await assert.rejects(dialect.jobs.verify(connection(catalog().filter((row) => row.name !== name)), schema),
        /existing job/);
    const rows = catalog();
    rows.find((row) => row.name === 'attempts').sql = '1';
    await assert.rejects(dialect.jobs.verify(connection(rows), schema), /job column/);
    const other = catalog();
    other.find((row) => row.name === '_jaren_jobs_claim').owner = 'other';
    await assert.rejects(dialect.jobs.verify(connection(other), schema), /job index/);
    await assert.rejects(dialect.jobs.verify(connection(catalog(), ['run_at', 'state']), schema), /different keys/);
  });

  it('awaits the transaction-scoped initialization lock and propagates acquisition failure', async () => {
    const failure = new Error('lock unavailable');
    await assert.rejects(dialect.jobs.initialize({ async exec(sql) {
      assert.equal(sql, 'SELECT pg_catalog.pg_advisory_xact_lock(1246907990, pg_catalog.hashtext(current_schema()))');
      throw failure;
    } }), (error) => error === failure);
  });
});
