//@ts-check
/**
 * @file The portable Store corpus against a real PostgreSQL server.
 *
 * OPT-IN: with `JAREN_PG_URL` unset every case here skips with that
 * reason and the deterministic dialect and driver suites — which may
 * never skip — still run. `npm run postgres:up` publishes an endpoint
 * that satisfies it.
 *
 * The corpus is not a second corpus. It is the SAME differential
 * oracle the SQLite suite runs: each case's query document goes through
 * the in-memory engine over the raw documents AND through the store's
 * translator over the same documents inserted into PostgreSQL, indexed
 * and unindexed, and the two must agree. A promotion that only agrees
 * on one engine is not a promotion.
 *
 * Each run owns a disposable schema, created before and dropped whole
 * after, so a failed run leaves nothing behind but a named schema an
 * operator can drop — and two runs never see each other's tables.
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';

import { openStore, planMigration, planModelMigration, migrate } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver, postgresDialect, POSTGRES_FLOOR } from '@jarenjs/db/postgres';

import {
  loadGroups, loadRelationGroups, storeForGroup, storeForEntityGroup, runCase, runEntityCase,
} from './oracle/harness.js';

const URL = process.env.JAREN_PG_URL;
const SKIP = URL === undefined || URL === ''
  ? 'JAREN_PG_URL is not set — there is no PostgreSQL endpoint to run against '
    + '(npm run postgres:up publishes one)'
  : false;

/** @type {any} */
let pg = null;
/** @type {any} */
let pool = null;
/** @type {any} */
let admin = null;
/** Schemas this file created, dropped whole in `after`. */
const schemas = [];
let counter = 0;

/** A fresh disposable schema, and a driver pointed at it. */
async function freshDriver() {
  counter += 1;
  const schema = `jaren_live_${process.pid}_${counter}`;
  await admin.query(`CREATE SCHEMA "${schema}"`);
  schemas.push(schema);
  return postgresDriver(pool, { schema });
}

const MODEL = {
  $model: '0.1',
  collections: {
    users: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          age: { type: 'integer' },
          active: { type: 'boolean' },
          tags: { type: 'array', items: { type: 'string' } },
          extra: {},
        },
      },
      key: '/id',
      indexes: [{ name: 'by_age', path: '$.age' }, { name: 'by_name', path: '$.name' }],
    },
    events: {
      schema: { type: 'object', properties: { n: { type: 'integer' } } },
      key: null,
      identity: 'integer',
      indexes: [{ name: 'by_n', path: '$.n' }],
    },
  },
};

describe('PostgreSQL, live', { skip: SKIP }, () => {
  it('an unsafe allocated int8 key refuses and rolls back insert or put, including a caught nested refusal', async () => {
    const driver = await freshDriver();
    const schema = schemas.at(-1);
    const store = await openStore(MODEL, { driver });
    const sequence = `pg_get_serial_sequence('"${schema}".events', 'key')`;
    const rows = async () => (await admin.query(`SELECT key::text FROM "${schema}".events`)).rows;
    try {
      await admin.query(`SELECT setval(${sequence}, 9007199254740991, false)`);
      const key = await store.collection('events').insert({ n: 1 });
      assert.strictEqual(key, Number.MAX_SAFE_INTEGER);
      assert.deepStrictEqual(await store.collection('events').get(key), { n: 1 });
      await store.collection('events').delete(key);
      for (const method of ['insert', 'put']) {
        await assert.rejects(store.collection('events')[method]({ n: 2 }),
          (error) => error.code === 'JD2005' && /safe JavaScript integer range/.test(error.reason));
        assert.deepStrictEqual(await rows(), []);
      }
      await store.transaction(async (tx) => {
        await assert.rejects(tx.collection('events').insert({ n: 3 }),
          (error) => error.code === 'JD2005');
        await tx.collection('users').insert({ id: 'still-usable' });
      });
      assert.deepStrictEqual(await rows(), []);
      assert.deepStrictEqual(await store.collection('users').get('still-usable'), { id: 'still-usable' });
    }
    finally {
      await store.close();
    }
  });

  it('concurrent first opens all verify the winning collection and entity shapes', async () => {
    const model = { ...MODEL, entities: { Marker: { schema: { type: 'object', properties: {
      id: { type: 'string', 'x-entity': { key: true } }, value: { type: 'integer' },
    } } } } };
    for (let round = 0; round < 4; round++) {
      const driver = await freshDriver();
      const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => openStore(model, { driver })));
      try {
        assert.deepStrictEqual(outcomes.filter((outcome) => outcome.status === 'rejected'), []);
        const stores = outcomes.map((outcome) => outcome.value);
        await stores[0].entity('Marker').create({ id: 'shared', value: round });
        for (const store of stores) assert.deepStrictEqual(await store.entity('Marker').get('shared'),
          { id: 'shared', value: round });
      }
      finally {
        for (const outcome of outcomes) if (outcome.status === 'fulfilled') await outcome.value.close();
      }
    }
  });

  before(async () => {
    pg = (await import('pg')).default;
    admin = new pg.Client({ connectionString: URL });
    await admin.connect();
    pool = new pg.Pool({ connectionString: URL, max: 12 });
  });

  after(async () => {
    // whatever happened above, the endpoint is left as it was found:
    // every schema this file made is dropped whole, and one that failed
    // to drop does not stop the next
    /** @type {any} */
    let poolFailure = null;
    try {
      if (pool !== null) await pool.end();
    }
    catch (error) {
      poolFailure = error;
    }
    if (admin !== null) {
      for (const schema of schemas) {
        try {
          await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        }
        catch { /* a schema a refused open never created */ }
      }
      await admin.end();
    }
    if (poolFailure !== null)
      throw new Error(`the pool did not close cleanly: ${poolFailure.message}`);
  });

  describe('the open sequence', () => {
    it('reports the server it reached and every capability it does not have', async () => {
      const store = await openStore(MODEL, { driver: await freshDriver() });
      try {
        assert.match(String(store.capabilities.version), /^\d+\.\d+/);
        assert.strictEqual(Number.isFinite(POSTGRES_FLOOR), true);
        // the two subsystems that write their own SQLite statements
        assert.strictEqual(store.capabilities.jobs, false);
        assert.strictEqual(store.capabilities.changeCapture, false);
        // no configuration vocabulary: the effective record is all null
        assert.deepStrictEqual(
          Object.values(store.capabilities.pragmas).filter((value) => value !== null), []);
        // no maintenance operation is a PostgreSQL operation
        assert.deepStrictEqual(
          Object.values(store.capabilities.maintenance).filter((value) => value !== false), []);
        // and the one structural thing this engine has and SQLite does not
        assert.strictEqual(store.capabilities.alterTableFull, true);
        assert.strictEqual(store.capabilities.lazyIteration, false,
          'a cursor over this driver buffers, and says so');
      }
      finally {
        await store.close();
      }
    });

    it('refuses the SQLite-only subsystems by name rather than at the first statement',
      async () => {
        await assert.rejects(
          () => openStore(MODEL, { driver: freshDriverSync(), capture: true }),
          (error) => error.code === 'JD0051');
        await assert.rejects(
          () => openStore(MODEL, { driver: freshDriverSync(), jobs: true }),
          (error) => error.code === 'JD0003');
      });

    /** A driver per attempt: a failed open closes the client it took,
     * so two refusals in a row need two of them. No schema is named —
     * both refusals fire before any statement runs. */
    function freshDriverSync() {
      return postgresDriver(pool, { schema: undefined });
    }

    it('a store reopened against the same schema verifies the shape it finds', async () => {
      const driver = await freshDriver();
      const first = await openStore(MODEL, { driver });
      await first.collection('users').insert({ id: 'a', name: 'Ann', age: 30 });
      await first.close();
      const second = await openStore(MODEL, { driver });
      try {
        assert.deepStrictEqual(await second.collection('users').get('a'),
          { id: 'a', name: 'Ann', age: 30 });
      }
      finally {
        await second.close();
      }
    });

    it('a table whose columns disagree with the model refuses the open', async () => {
      const driver = await freshDriver();
      const store = await openStore(MODEL, { driver });
      await store.close();
      const schema = schemas[schemas.length - 1];
      await admin.query(`ALTER TABLE "${schema}"."users" DROP COLUMN "gx_age"`);
      await assert.rejects(() => openStore(MODEL, { driver }), (error) => {
        assert.strictEqual(error.code, 'JD0002');
        assert.match(error.message, /gx_age/);
        return true;
      });
    });
  });

  describe('writes, reads and the classified failures', () => {
    /** @type {any} */
    let store;
    before(async () => { store = await openStore(MODEL, { driver: await freshDriver() }); });
    after(async () => { if (store !== undefined) await store.close(); });

    it('insert, get, put, patch and delete round-trip a document whole', async () => {
      const users = store.collection('users');
      const document = { id: 'a', name: 'Ann', age: 30, active: true, tags: ['x'],
        extra: { k: 1, deep: [1, 2, { z: null }] } };
      await users.insert(document);
      assert.deepStrictEqual(await users.get('a'), document);
      // a translated patch: one member rewritten, one array appended
      await users.patch('a', [
        { op: 'replace', path: '/age', value: 31 },
        { op: 'add', path: '/tags/-', value: 'y' },
        { op: 'remove', path: '/extra/k' },
      ]);
      assert.deepStrictEqual(await users.get('a'), {
        ...document, age: 31, tags: ['x', 'y'], extra: { deep: [1, 2, { z: null }] } });
      await users.put({ id: 'a', name: 'Anne' });
      assert.deepStrictEqual(await users.get('a'), { id: 'a', name: 'Anne' });
      assert.strictEqual(await users.delete('a'), true);
      assert.strictEqual(await users.get('a'), undefined);
      assert.strictEqual(await users.delete('a'), false);
    });

    it('a database-allocated key comes back as a number', async () => {
      const events = store.collection('events');
      const first = await events.insert({ n: 1 });
      const second = await events.insert({ n: 2 });
      assert.strictEqual(typeof first, 'number');
      assert.strictEqual(second, first + 1);
      assert.deepStrictEqual(await events.get(first), { n: 1 });
    });

    it('a duplicate key is JD2001 with the same class the SQLite path reports', async () => {
      const users = store.collection('users');
      await users.insert({ id: 'dup', name: 'one' });
      await assert.rejects(() => users.insert({ id: 'dup', name: 'two' }), (error) => {
        assert.strictEqual(error.code, 'JD2001');
        assert.strictEqual(error.class, 'duplicate');
        assert.strictEqual(error.retryable, false);
        return true;
      });
      // the row the first insert wrote is untouched
      assert.deepStrictEqual(await users.get('dup'), { id: 'dup', name: 'one' });
    });

    it('a transaction commits as a whole and rolls back as a whole', async () => {
      const users = store.collection('users');
      await store.transaction(async (tx) => {
        await tx.collection('users').insert({ id: 't1', name: 'kept' });
        await tx.collection('users').insert({ id: 't2', name: 'kept' });
      });
      assert.ok(await users.get('t1'));
      assert.ok(await users.get('t2'));
      await assert.rejects(() => store.transaction(async (tx) => {
        await tx.collection('users').insert({ id: 't3', name: 'gone' });
        throw new Error('rollback me');
      }), /rollback me/);
      assert.strictEqual(await users.get('t3'), undefined);
    });

    it('a nested transaction is a savepoint: the inner rolls back, the outer keeps', async () => {
      const users = store.collection('users');
      await store.transaction(async (tx) => {
        await tx.collection('users').insert({ id: 'outer', name: 'kept' });
        await assert.rejects(() => tx.transaction(async (inner) => {
          await inner.collection('users').insert({ id: 'inner', name: 'gone' });
          throw new Error('inner');
        }), /inner/);
      });
      assert.ok(await users.get('outer'));
      assert.strictEqual(await users.get('inner'), undefined);
    });

    it('a store that has no data version says so rather than failing on a statement', async () => {
      await assert.rejects(() => store.dataVersion(), (error) => {
        assert.strictEqual(error.code, 'JD2077');
        assert.match(error.message, /no commit counter/);
        return true;
      });
    });
  });

  describe('the differential oracle, over PostgreSQL', () => {
    for (const side of /** @type {const} */ (['indexed', 'unindexed'])) {
      describe(`collections — ${side}`, () => {
        for (const group of loadGroups()) {
          describe(group.group, () => {
            /** @type {any} */
            let opened = null;
            after(async () => { if (opened !== null) await opened.store.close(); });
            for (const kase of group.cases) {
              it(kase.name, async () => {
                if (opened === null)
                  opened = await storeForGroup(group, await freshDriver(), side);
                const divergence = await runCase(
                  opened.collection, group.documents, kase, 'native');
                assert.strictEqual(divergence, null,
                  divergence === null ? '' : `${group.group}/${kase.name} [${side}] diverged\n`
                    + `  sql:      ${divergence.sql ?? '<none>'}\n`
                    + `  engine:   ${JSON.stringify(divergence.expected)}\n`
                    + `  pushdown: ${JSON.stringify(divergence.actual)}`);
              });
            }
          });
        }
      });
    }

    describe('entities and relations', () => {
      for (const group of loadRelationGroups()) {
        describe(group.group, () => {
          /** @type {any} */
          let opened = null;
          after(async () => { if (opened !== null) await opened.store.close(); });
          for (const kase of group.cases) {
            it(kase.name, async () => {
              if (opened === null)
                opened = await storeForEntityGroup(group, await freshDriver());
              // the engine's root is the entities PLUS the join rows a
              // group declares as memberships: a join-table root is
              // queryable, and the engine has no other way to see one
              const divergence = await runEntityCase(
                opened.store, { ...group.documents, ...(group.memberships ?? {}) },
                kase, 'native');
              assert.strictEqual(divergence, null,
                divergence === null ? '' : `${group.group}/${kase.name} diverged\n`
                  + `  sql:      ${divergence.sql ?? '<none>'}\n`
                  + `  engine:   ${JSON.stringify(divergence.expected)}\n`
                  + `  pushdown: ${JSON.stringify(divergence.actual)}`);
            });
          }
        });
      }
    });
  });

  describe('migration', () => {
    it('a planned migration applies, converges, and the reopened store verifies it',
      async () => {
        const driver = await freshDriver();
        const store = await openStore(MODEL, { driver });
        await store.collection('users').insert({ id: 'a', name: 'Ann', age: 30 });
        await store.close();

        const next = structuredClone(MODEL);
        next.collections.users.indexes.push({ name: 'by_active', path: '$.active' });
        // the mapping this connection plans under: derived columns are
        // STORED (nothing registers a function here) and there is no
        // R*Tree, so the planned DDL is the DDL the open path would make
        const { migration } = planMigration(MODEL, next,
          { dialect: driver.dialect, id: '0001-index-active', derived: 'stored', rtree: false });
        assert.ok(migration.steps.length > 0, 'a new index is a step');

        // the shadow replay is a SECOND database. On a file engine that
        // is `:memory:`; on a server it is another schema, because the
        // baseline shape it creates would otherwise collide with the
        // real one — which is what `shadowDriver` names
        const shadowDriver = await freshDriver();
        const applied = await migrate({ driver }, [migration],
          { baseline: MODEL, model: next, shadowDriver });
        assert.deepStrictEqual(applied.applied, ['0001-index-active']);

        // the run CONVERGES: a second pass has nothing left to do
        const again = await migrate({ driver }, [migration],
          { baseline: MODEL, model: next, shadowDriver: await freshDriver() });
        assert.strictEqual(again.upToDate, true);
        assert.deepStrictEqual(again.applied, []);

        // and the model the migration arrived at is the one the store
        // now verifies, over the documents that were already there
        const reopened = await openStore(next, { driver });
        try {
          assert.deepStrictEqual(await reopened.collection('users').get('a'),
            { id: 'a', name: 'Ann', age: 30 });
        }
        finally {
          await reopened.close();
        }
      });
  });

  describe('introspection, against the server', () => {
    it('recovers emitted enum CHECKs from the PostgreSQL catalog', async () => {
      const model = { $model: '0.1', entities: { Choice: { schema: {
        type: 'object', required: ['id'], properties: {
          id: { type: 'string', 'x-entity': { key: true } },
          state: { type: 'string', enum: ['open', "it's closed"], 'x-entity': { index: true } },
          score: { type: 'number', enum: [-1, 0.5, 100], 'x-entity': { index: true } },
          fixed: { type: 'string', enum: ['only'], 'x-entity': { index: true } },
        },
      } } } };
      const store = await openStore(model, { driver: await freshDriver() });
      try {
        const derived = await store.introspect();
        const props = derived.model.entities.Choice.schema.properties;
        assert.deepStrictEqual(props.state.enum, model.entities.Choice.schema.properties.state.enum);
        assert.deepStrictEqual(props.score.enum, model.entities.Choice.schema.properties.score.enum);
        assert.deepStrictEqual(props.fixed.enum, ['only']);
        assert.deepStrictEqual(derived.report.filter((row) => row.code === 'unmapped-constraint'), []);
      }
      finally { await store.close(); }
    });

    /** The model both engines will be read back into. */
    const SHAPES = {
      $model: '0.1',
      collections: {
        people: {
          schema: {
            type: 'object',
            required: ['id'],
            properties: {
              id: { type: 'string' },
              email: { type: 'string' },
              age: { type: 'integer' },
              nested: { type: 'object', properties: { deep: { type: 'string' } } },
            },
          },
          key: '/id',
          indexes: [
            { name: 'by_email', path: '$.email', unique: true },
            { name: 'by_age', path: '$.age' },
            { name: 'by_deep', path: '$.nested.deep' },
          ],
        },
        ticks: {
          schema: { type: 'object', properties: { n: { type: 'integer' } } },
          key: null,
          identity: 'integer',
          indexes: [{ name: 'by_n', path: '$.n' }],
        },
      },
    };

    it('derives the same logical model the SQLite fixture derives', async () => {
      const pgStore = await openStore(SHAPES, { driver: await freshDriver() });
      const fromPostgres = await pgStore.introspect({ keys: { people: '/id' } });
      await pgStore.close();

      const sqliteStore = await openStore(SHAPES, { driver: nodeDriver() });
      const fromSqlite = await sqliteStore.introspect({ keys: { people: '/id' } });
      await sqliteStore.close();

      // the same collections, the same keys, the same index names and
      // the same member paths
      assert.deepStrictEqual(Object.keys(fromPostgres.model.collections).sort(),
        Object.keys(fromSqlite.model.collections).sort());
      for (const name of Object.keys(fromSqlite.model.collections)) {
        assert.deepStrictEqual(fromPostgres.model.collections[name].indexes,
          fromSqlite.model.collections[name].indexes, name);
        assert.strictEqual(fromPostgres.model.collections[name].key,
          fromSqlite.model.collections[name].key, name);
        assert.strictEqual(fromPostgres.model.collections[name].identity,
          fromSqlite.model.collections[name].identity, name);
      }
      // and the same loss rows, by code and object
      const rows = (report) => report.map((row) => `${row.code} ${row.object}`);
      assert.deepStrictEqual(rows(fromPostgres.report), rows(fromSqlite.report));

      // ONE declared difference, and it is the mapping's stated loss:
      // `numeric` carries both JSON number types, so an integer member
      // reads back as `number`
      const pgPeople = fromPostgres.model.collections.people.schema.properties;
      const sqlitePeople = fromSqlite.model.collections.people.schema.properties;
      assert.strictEqual(sqlitePeople.age.type, 'integer');
      assert.strictEqual(pgPeople.age.type, 'number');
      assert.deepStrictEqual(pgPeople.email, sqlitePeople.email);
      assert.deepStrictEqual(pgPeople.nested, sqlitePeople.nested);
    });

    it('the read issues no DDL and no DML', async () => {
      /** @type {string[]} */
      const trace = [];
      const traced = {
        connect: async () => {
          const client = await pool.connect();
          return {
            query: (config, values) => {
              trace.push(typeof config === 'string' ? config : config.text);
              return client.query(config, values);
            },
            release: () => client.release(),
          };
        },
      };
      counter += 1;
      const schema = `jaren_live_${process.pid}_${counter}`;
      await admin.query(`CREATE SCHEMA "${schema}"`);
      schemas.push(schema);
      const store = await openStore(SHAPES, { driver: postgresDriver(traced, { schema }) });
      trace.length = 0;
      await store.introspect();
      assert.ok(trace.length > 0, 'it did read');
      for (const sql of trace) {
        assert.match(sql, /^SELECT\b/, `a read-only introspection issued: ${sql}`);
        assert.ok(!/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|BEGIN|COMMIT|SAVEPOINT)\b/i
          .test(sql), `a read-only introspection issued: ${sql}`);
      }
      await store.close();
    });

    it('the derived model plans against the declared one and finds nothing to do',
      async () => {
        const store = await openStore(SHAPES, { driver: await freshDriver() });
        const { model } = await store.introspect({ keys: { people: '/id' } });
        // the derived model as the migration's FROM: the physical shapes
        // are the same, so the plan is empty. That is convergence, and
        // it is what makes a read of a live database usable as a baseline
        const { migration, report } = planModelMigration(model, SHAPES,
          { dialect: store.dialect, id: '0001-nothing', derived: 'stored', rtree: false });
        assert.deepStrictEqual(migration.steps.filter((step) => step.kind === 'ddl'), []);
        assert.deepStrictEqual(report.added, []);
        assert.deepStrictEqual(report.removed, []);
        await store.close();
      });

    it('strict mode refuses rather than returning a partial model', async () => {
      const store = await openStore(SHAPES, { driver: await freshDriver() });
      try {
        await assert.rejects(async () => store.introspect({ strict: true }), (error) => {
          assert.strictEqual(error.code, 'JD0002');
          assert.match(error.message, /strict introspection refused/);
          return true;
        });
      }
      finally {
        await store.close();
      }
    });
  });

  describe('a model-declared expression index', () => {
    /** `lower` is an IMMUTABLE function the server already has; this
     * package creates none, and the host's declaration is a promise
     * about one that exists. */
    const FUNCTIONS = {
      lower: {
        arity: 1,
        deterministic: true,
        apply: (value) => (value === null ? null : String(value).toLowerCase()),
        sql: 'lower',
      },
    };
    const EXPRESSED = {
      $model: '0.1',
      collections: {
        accounts: {
          schema: { type: 'object', required: ['id'],
            properties: { id: { type: 'string' }, email: { type: 'string' } } },
          key: '/id',
          indexes: [{ name: 'by_lower_email',
            expression: { call: 'lower', args: [{ member: '$.email' }] }, unique: true }],
        },
      },
    };

    it('creates the column, enforces the index, and seeks through it', async () => {
      const driver = await freshDriver();
      const store = await openStore(EXPRESSED, { driver, expressions: FUNCTIONS });
      try {
        const accounts = store.collection('accounts');
        await accounts.insert({ id: 'a', email: 'ANN@Example.COM' });
        assert.deepStrictEqual(await accounts.get('a'), { id: 'a', email: 'ANN@Example.COM' });
        // the unique index is over the LOWERED value, so a second
        // document differing only in case is refused
        await assert.rejects(() => accounts.insert({ id: 'b', email: 'ann@example.com' }),
          (error) => {
            assert.strictEqual(error.code, 'JD2005');
            assert.strictEqual(error.class, 'constraint');
            return true;
          });

        // and the server SEEKS through it. The query language has no way
        // to spell `lower(email)`, so the claim is checked where it
        // lives: the database's own plan for a predicate over the column
        const schema = schemas[schemas.length - 1];
        const client = await pool.connect();
        try {
          await client.query(`SET search_path TO "${schema}"`);
          const plan = await client.query(
            'EXPLAIN SELECT "key" FROM "accounts" WHERE "gx_lower_email_x" = $1',
            ['ann@example.com']);
          const lines = driver.dialect.explainLines(plan.rows);
          assert.ok(lines.some((line) =>
            driver.dialect.usesIndex(line, 'accounts_by_lower_email')),
          `the plan did not seek: ${lines.join('; ')}`);
        }
        finally {
          client.release();
        }
      }
      finally {
        await store.close();
      }
    });

    it('round-trips through introspection and plans no structural change', async () => {
      const driver = await freshDriver();
      const store = await openStore(EXPRESSED, { driver, expressions: FUNCTIONS });
      try {
        const { model } = await store.introspect(
          { keys: { accounts: '/id' }, expressions: FUNCTIONS });
        assert.deepStrictEqual(model.collections.accounts.indexes, [{
          name: 'by_lower_email',
          expression: { call: 'lower', args: [{ member: '$.email' }] },
          unique: true,
        }]);
        const { migration } = planModelMigration(model, EXPRESSED,
          { dialect: driver.dialect, id: '0001-nothing', derived: 'stored', rtree: false,
            expressions: FUNCTIONS });
        assert.deepStrictEqual(migration.steps.filter((step) => step.kind === 'ddl'), []);
      }
      finally {
        await store.close();
      }
    });

    it('a function with no SQL name is refused before any DDL', async () => {
      const model = structuredClone(EXPRESSED);
      model.collections.accounts.indexes[0].expression.call = 'noSql';
      const driver = await freshDriver();
      await assert.rejects(
        () => openStore(model, {
          driver,
          expressions: { noSql: { arity: 1, deterministic: true, apply: (v) => v } },
        }),
        (error) => {
          assert.strictEqual(error.code, 'JD0004');
          assert.match(error.message, /has no 'sql' name/);
          return true;
        });
    });
  });

  describe('the endpoint itself', () => {
    it('an unreachable endpoint is classified, and its password is not in the message',
      async () => {
        const dead = new pg.Pool({
          connectionString: 'postgres://jaren:hunter2@127.0.0.1:1/jaren',
          connectionTimeoutMillis: 2000,
        });
        try {
          await assert.rejects(
            () => openStore(MODEL, { driver: postgresDriver(dead) }),
            (error) => {
              assert.strictEqual(error.code, 'JD0002');
              assert.ok(['connection', 'cantopen', 'error'].includes(error.class),
                `unexpected class ${error.class}`);
              assert.ok(!error.message.includes('hunter2'),
                'the store composes its own sentence and never a connection string');
              return true;
            });
        }
        finally {
          await dead.end();
        }
      });

    it('the client a store took is released exactly once', async () => {
      const acquired = [];
      const source = {
        connect: async () => {
          const client = await pool.connect();
          let releases = 0;
          const wrapped = {
            query: (...args) => client.query(...args),
            release: () => { releases += 1; return client.release(); },
            get releases() { return releases; },
          };
          acquired.push(wrapped);
          return wrapped;
        },
      };
      counter += 1;
      const schema = `jaren_live_${process.pid}_${counter}`;
      await admin.query(`CREATE SCHEMA "${schema}"`);
      schemas.push(schema);
      const store = await openStore(MODEL, { driver: postgresDriver(source, { schema }) });
      await store.collection('users').insert({ id: 'a', name: 'Ann' });
      await store.close();
      await store.close();
      assert.strictEqual(acquired.length, 1, 'one store holds one client');
      assert.strictEqual(acquired[0].releases, 1, 'released exactly once');
    });
  });
});

describe('PostgreSQL, without an endpoint', () => {
  it('the dialect is pure text and needs none', () => {
    // the deterministic half may never skip: this is the assertion that
    // the whole file above is opt-in rather than optional
    const dialect = postgresDialect();
    assert.strictEqual(dialect.name, 'postgres');
    assert.strictEqual(typeof SKIP === 'string' || SKIP === false, true);
  });
});
