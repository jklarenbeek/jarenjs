//@ts-check
/** A migration's bounded update cache owns both evictions and final disposal. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { nodeWorkerPoolDriver } from '@jarenjs/db/node-pool';
import { nodeProcessDriver } from '@jarenjs/db/node-process';
import { explainMapping, normalizeEntities } from '../../packages/db/src/model.js';
import { planEntity } from '../../packages/db/src/ddl.js';
import { transformPhysicalRows } from '../../packages/db/src/physical-transform.js';
import { chain, isThenable, useStatementOnce } from '../../packages/db/src/driver.js';

const FIELDS = Array.from({ length: 7 }, (_, index) => `v${index}`);
const MODEL = { $model: '0.1', entities: { Row: {
  schema: { type: 'object', properties: {
    id: { type: 'string', 'x-entity': { key: true } },
    ...Object.fromEntries(FIELDS.map((field) => [field, { type: 'integer' }])),
  } },
  physical: { table: 'rows', columns: {
    id: { name: 'id', codec: 'text', null: 'reject' },
    ...Object.fromEntries(FIELDS.map((field) => [field, { name: field, codec: 'integer', null: 'reject' }])),
  } },
  invariants: [{ name: 'still_present', on: ['update'], enforcement: 'store',
    assert: { '$exists-row': { entity: 'Ref', match: { id: '$.new.id' } } } }],
}, Ref: {
  schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } } } },
  physical: { table: 'refs', columns: { id: { name: 'id', codec: 'text', null: 'reject' } } },
} } };
const SEED = `CREATE TABLE rows(id TEXT PRIMARY KEY,${FIELDS.map((field) => `${field} INTEGER NOT NULL`).join(',')});
  WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100)
  INSERT INTO rows SELECT printf('%03d',x),${FIELDS.map(() => '0').join(',')} FROM n;
  CREATE TABLE refs(id TEXT PRIMARY KEY); INSERT INTO refs SELECT id FROM rows`;
const rowsAfter = (changed) => Array.from({ length: 100 }, (_, index) => ({
  id: String(index + 1).padStart(3, '0'),
  ...Object.fromEntries(FIELDS.map((field, bit) => [field, changed ? ((index + 1) >> bit) & 1 : 0])),
}));

/** @param {any} connection */
function targetFor(connection) {
  const mapping = explainMapping(MODEL);
  return { entity: normalizeEntities(MODEL).get('Row'),
    mapping: planEntity('Row', mapping.entities.Row, mapping, connection.dialect).physical };
}

/** Delay preparation and complete methods independently to expose premature disposal.
 * @param {any} native @param {boolean} asynchronous */
function observed(native, asynchronous) {
  const records = [];
  const violations = [];
  let live = 0, peak = 0;
  const connection = { ...native, prepare(sql, options) {
    const prepared = native.prepare(sql, options);
    const record = { sql, finalized: 0, active: 0 };
    records.push(record);
    peak = Math.max(peak, ++live);
    const statement = {};
    for (const method of ['run', 'get', 'all']) {
      statement[method] = (...args) => {
        assert.equal(record.finalized, 0, `use after finalization: ${sql}`);
        record.active++;
        const run = () => prepared[method](...args);
        if (asynchronous) return Promise.resolve().then(run).finally(() => { record.active--; });
        try { return run(); }
        finally { record.active--; }
      };
    }
    statement.finalize = () => {
      if (record.active !== 0) violations.push(`active statement finalized: ${sql}`);
      if (record.finalized !== 0) violations.push(`statement finalized twice: ${sql}`);
      record.finalized++;
      live--;
      prepared.finalize?.();
    };
    return asynchronous ? Promise.resolve(statement) : statement;
  } };
  return { connection, records, violations, live: () => live, peak: () => peak };
}

const nativeDriver = process.versions.bun
  ? (await import('@jarenjs/db/bun')).bunDriver()
  : (await import('@jarenjs/db/node')).nodeDriver();

for (const asynchronous of [false, true]) {
  for (const refuses of [false, true]) {
    it(`physical transform releases more than 64 update shapes after ${asynchronous ? 'async' : 'sync'} ${refuses ? 'refusal' : 'success'}`, async () => {
      const native = await nativeDriver.open(':memory:');
      try {
        native.exec(SEED);
        const observedUse = observed(native, asynchronous);
        const { connection, records, violations } = observedUse;
        const failure = new Error('refused row100 after cache eviction');
        const run = () => native.transaction(() => transformPhysicalRows(connection, targetFor(connection), {
          apply(row) {
            if (refuses && row.id === '100') throw failure;
            return rowsAfter(true)[Number(row.id) - 1];
          },
          fail(message) { throw new Error(message); },
        }, { batchSize: 1, migration: 'shape-lifetime', collection: 'Row',
          onProgress({ transformed }) {
            if (transformed > 64) {
              const updates = records.filter((record) => record.sql.startsWith('UPDATE '));
              assert.equal(updates.filter((record) => record.finalized === 0).length, 64);
              assert.equal(updates.filter((record) => record.finalized === 1).length, transformed - 64);
            }
          } }));
        if (refuses) {
          if (asynchronous) await assert.rejects(run, (error) => error === failure);
          else assert.throws(run, (error) => error === failure);
        }
        else {
          const result = run();
          assert.equal(isThenable(result), asynchronous);
          assert.equal(await result, 100);
        }
        assert.equal(records.filter((record) => record.sql.startsWith('UPDATE ')).length, refuses ? 99 : 100);
        assert.ok(records.some((record) => record.sql.startsWith('SELECT EXISTS')));
        assert.ok(records.every((record) => record.finalized === 1));
        assert.equal(observedUse.live(), 0);
        // 64 cached writes +2 walk statements +entity get/probe +the new write
        // prepared before the LRU evicts its old entry. Capacity is unchanged.
        assert.equal(observedUse.peak(), 69);
        assert.deepEqual(violations, []);
        const rows = native.prepare('SELECT * FROM rows ORDER BY id').all([]).map((row) => ({ ...row }));
        assert.deepEqual(rows, rowsAfter(!refuses));
      }
      finally { await native.close(); }
    });
  }
}

/** @type {[string, (capacity: number) => any][]} */
const HOSTS = [
  ['worker', (capacity) => nodeWorkerDriver({ maxStatements: capacity })],
  ['pool', (capacity) => nodeWorkerPoolDriver({ readers: 0, worker: { maxStatements: capacity } })],
];
if (!process.versions.bun) HOSTS.push(['process', (capacity) => nodeProcessDriver({ maxStatements: capacity })]);

for (const [host, driver] of HOSTS) {
  for (const refuses of [false, true]) {
    it(`${host}: 100-shape ${refuses ? 'refusal' : 'success'} fits the observed 69-statement peak and default request limit`, async () => {
      const connection = await driver(69).open(':memory:');
      const failure = new Error('refused row100 after cache eviction');
      try {
        await connection.exec(SEED);
        const run = () => connection.transaction((scope) => transformPhysicalRows(scope, targetFor(scope), {
          apply(row) {
            if (refuses && row.id === '100') throw failure;
            return rowsAfter(true)[Number(row.id) - 1];
          },
          fail(message) { throw new Error(message); },
        }, { batchSize: 1, migration: 'bounded-shapes', collection: 'Row' }));
        if (refuses) await assert.rejects(run, (error) => error === failure);
        else assert.equal(await run(), 100);
        assert.deepEqual(await useStatementOnce(connection, 'SELECT * FROM rows ORDER BY id',
          (statement) => chain(statement.all([]), (rows) => rows.map((row) => ({ ...row })))), rowsAfter(!refuses));
        await connection.exec('CREATE TEMP TABLE still_open(n INTEGER)');
      }
      finally { await connection.close(); }
    });
  }
}
