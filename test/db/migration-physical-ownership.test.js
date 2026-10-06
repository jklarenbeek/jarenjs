//@ts-check
/** Borrowed migration reads release their own statements on every outcome. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { migrationIdentity } from './migration-fixture.js';
import { migrate, shapeHash, explainMapping } from '@jarenjs/db';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { nodeWorkerPoolDriver } from '@jarenjs/db/node-pool';
import { nodeProcessDriver } from '@jarenjs/db/node-process';
import { readSchema } from '../../packages/db/src/introspect.js';
import { textKeyDecoding } from '../../packages/db/src/physical.js';
import { normalizeEntities } from '../../packages/db/src/model.js';
import { planEntity } from '../../packages/db/src/ddl.js';
import { walkPhysicalRows, transformPhysicalRows } from '../../packages/db/src/physical-transform.js';
import { sqliteDatabasePath, verifyShadowOwnership } from '../../packages/db/src/migration-target.js';
import { useStatementOnce, isThenable } from '../../packages/db/src/driver.js';

const MODEL = { $model: '0.1', entities: { Row: {
  schema: { type: 'object', properties: {
    id: { type: 'string', 'x-entity': { key: true } }, value: { type: 'integer' },
  } },
  physical: { table: 'rows', columns: {
    id: { name: 'id', codec: 'text', null: 'reject' },
    value: { name: 'value', codec: 'integer', null: 'reject' },
  } },
} } };
const ROWS = [{ id: 'a', value: 1 }, { id: 'b', value: 2 }];
const SEED = "CREATE TABLE rows(id TEXT PRIMARY KEY,value INTEGER NOT NULL); INSERT INTO rows VALUES('a',1),('b',2)";
const ASSERTION = { kind: 'query', collection: 'Row', model: MODEL, assert: false, expect: 'ebv' };
const document = (steps) => ({ $migration: '0.2', identity: migrationIdentity(MODEL), id: 'borrowed-physical',
  from: shapeHash(MODEL), to: shapeHash(MODEL), steps });

/** @type {[string, (maxStatements: number) => any][]} */
const HOSTS = [
  ['worker', (maxStatements) => nodeWorkerDriver({ maxStatements })],
  ['pool', (maxStatements) => nodeWorkerPoolDriver({ readers: 0, worker: { maxStatements } })],
];
if (!process.versions.bun) HOSTS.push(['process', (maxStatements) => nodeProcessDriver({ maxStatements })]);

/** @param {(maxStatements: number) => any} driver @param {number} capacity
 * @param {(connection: any) => Promise<void>} run */
async function withConnection(driver, capacity, run) {
  const connection = await driver(capacity).open(':memory:');
  try { await run(connection); }
  finally { await connection.close(); }
}

/** @param {any} connection @param {any} [model] */
function mappingFor(connection, model = MODEL) {
  const all = explainMapping(model);
  return planEntity('Row', all.entities.Row, all, connection.dialect).physical;
}

for (const [host, driver] of HOSTS) {
  it(`${host}: 100 decoder reads fit four statement slots and retain the borrowed connection`, async () => {
    await withConnection(driver, 4, async (connection) => {
      for (let call = 0; call < 100; call++) {
        const decoding = await textKeyDecoding(connection);
        assert.equal(decoding.keepsLeadingBom, true);
        assert.equal(decoding.decoder.decode(new TextEncoder().encode('\uFEFFx')), '\uFEFFx');
      }
      await connection.exec('CREATE TEMP TABLE still_open(n INTEGER)');
    });
  });

  it(`${host}: 100 schema inventories fit eight statement slots with identical catalog answers`, async () => {
    await withConnection(driver, 8, async (connection) => {
      await connection.exec(SEED);
      const first = await readSchema(connection);
      assert.equal(first.tables[0].name, 'rows');
      assert.deepEqual(first.tables[0].primaryKey, ['id']);
      for (let call = 1; call < 100; call++) assert.deepEqual(await readSchema(connection), first);
      await connection.exec('CREATE TEMP TABLE still_open(n INTEGER)');
    });
  });

  it(`${host}: 100 independent-shadow checks fit one statement slot per borrowed connection`, async () => {
    await withConnection(driver, 1, async (connection) => {
      await withConnection(driver, 1, async (shadow) => {
        for (let call = 0; call < 100; call++) {
          assert.equal(await sqliteDatabasePath(connection), null);
          await verifyShadowOwnership(connection, shadow, {});
        }
        await shadow.exec('CREATE TEMP TABLE still_open(n INTEGER)');
      });
      await connection.exec('CREATE TEMP TABLE still_open(n INTEGER)');
    });
  });

  for (const outcome of ['success', 'handler refusal', 'cancellation']) {
    it(`${host}: 100 physical walks release their pages after ${outcome}`, async () => {
      await withConnection(driver, 64, async (connection) => {
        await connection.exec(SEED);
        const mapping = mappingFor(connection);
        const failure = new Error(outcome);
        for (let call = 0; call < 100; call++) {
          const rows = [];
          let checks = 0;
          const walk = () => walkPhysicalRows(connection, mapping, 1, (batch) => {
            rows.push(...batch);
            if (outcome === 'handler refusal') throw failure;
          }, () => {
            checks++;
            if (outcome === 'cancellation' && checks === 3) throw failure;
          });
          if (outcome === 'success') {
            await walk();
            assert.deepEqual(rows, ROWS);
          }
          else {
            await assert.rejects(walk, (error) => error === failure);
            assert.deepEqual(rows, ROWS.slice(0, 1));
          }
        }
        await connection.exec('CREATE TEMP TABLE still_open(n INTEGER)');
      });
    });
  }

  it(`${host}: physical view offset pages release within one 100-row walk`, async () => {
    await withConnection(driver, 32, async (connection) => {
      await connection.exec("CREATE TABLE source(id TEXT PRIMARY KEY,value INTEGER NOT NULL); WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100) INSERT INTO source SELECT printf('%03d',x),x FROM n; CREATE VIEW rows AS SELECT * FROM source");
      const model = structuredClone(MODEL);
      model.entities.Row.physical.kind = 'view';
      const rows = [];
      await walkPhysicalRows(connection, mappingFor(connection, model), 1, (batch) => rows.push(...batch));
      assert.deepEqual(rows, Array.from({ length: 100 }, (_, index) => ({
        id: String(index + 1).padStart(3, '0'), value: index + 1,
      })));
    });
  });

  for (const transform of [false, true]) {
    it(`${host}: 100 physical ${transform ? 'transform rollbacks' : 'assertion refusals'} retain JD0023 at capacity 64`, async () => {
      await withConnection(driver, 64, async (connection) => {
        await connection.exec(SEED);
        const steps = transform ? [{ kind: 'jslt', collection: 'Row', model: MODEL,
          stylesheet: [{ match: '$', body: { value: { $add: ['$.value', 1] } } }] }, ASSERTION] : [ASSERTION];
        const migration = document(steps);
        for (let call = 0; call < 100; call++) {
          await assert.rejects(() => migrate({ connection }, [migration], {
            baseline: MODEL, shadow: false, batchSize: 1,
          }), { code: 'JD0023' }, `call ${call}`);
        }
        assert.deepEqual(await useStatementOnce(connection, 'SELECT id,value FROM rows ORDER BY id',
          (statement) => statement.all([])), ROWS);
        assert.equal(await useStatementOnce(connection,
          "SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='_jaren_migrations'",
          (statement) => statement.get([]).then((row) => row.n)), 0);
        await connection.exec('CREATE TEMP TABLE still_open(n INTEGER)');
      });
    });
  }
}


const nativeDriver = process.versions.bun
  ? (await import('@jarenjs/db/bun')).bunDriver()
  : (await import('@jarenjs/db/node')).nodeDriver();

/** Observe completed uses without changing their return timing or receiver.
 * @param {any} connection @param {any[]} records @param {boolean} asynchronous
 * @param {string} cleanup */
function observe(connection, records, asynchronous, cleanup) {
  return { ...connection, prepare(sql, options) {
    const native = connection.prepare(sql, options);
    const record = { sql, finalized: 0 };
    records.push(record);
    const statement = {};
    for (const method of ['get', 'all', 'run']) {
      statement[method] = (...args) => {
        assert.equal(record.finalized, 0, `read after finalization: ${sql}`);
        return native[method](...args);
      };
    }
    if (cleanup !== 'absent') statement.finalize = () => {
      record.finalized++;
      assert.equal(record.finalized, 1, `duplicate finalization: ${sql}`);
      native.finalize?.();
      if (cleanup === 'throw') throw new Error('cleanup threw');
      if (cleanup === 'reject') return Promise.reject(new Error('cleanup rejected'));
    };
    return asynchronous ? Promise.resolve(statement) : statement;
  } };
}

for (const asynchronous of [false, true]) {
  for (const cleanup of ['return', 'throw', 'reject', 'absent']) {
    for (const fails of [false, true]) {
      it(`physical transform ${asynchronous ? 'async' : 'sync'} ${fails ? 'failure' : 'success'} preserves its result with ${cleanup} cleanup`, async () => {
        const native = await nativeDriver.open(':memory:');
        const records = [];
        const connection = observe(native, records, asynchronous, cleanup);
        const failure = new Error('the caller refused the second row');
        try {
          native.exec(SEED);
          const target = { entity: normalizeEntities(MODEL).get('Row'), mapping: mappingFor(connection) };
          const apply = () => native.transaction(() => transformPhysicalRows(connection, target, {
            apply(row) {
              if (fails && row.id === 'b') throw failure;
              return { ...row, value: row.value + 1 };
            },
            fail(message) { throw new Error(message); },
          }, { batchSize: 1, migration: 'owned-transform', collection: 'Row' }));
          if (fails) {
            if (asynchronous) await assert.rejects(apply, (error) => error === failure);
            else assert.throws(apply, (error) => error === failure);
          }
          else {
            const result = apply();
            assert.equal(isThenable(result), asynchronous);
            assert.equal(await result, 2);
          }
          assert.ok(records.some((record) => record.sql.startsWith('UPDATE ')));
          assert.ok(records.some((record) => record.sql.includes('WHERE "id" = ?')));
          if (cleanup !== 'absent') assert.ok(records.every((record) => record.finalized === 1),
            JSON.stringify(records.filter((record) => record.finalized !== 1)));
          const rows = native.prepare('SELECT id,value FROM rows ORDER BY id').all([]).map((row) => ({ ...row }));
          assert.deepEqual(rows, fails ? ROWS : ROWS.map((row) => ({ ...row, value: row.value + 1 })));
        }
        finally { await native.close(); }
      });
    }
  }
}
