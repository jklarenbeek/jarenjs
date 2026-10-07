//@ts-check
/**
 * @file A migration receipt stamps `applied_at` with the run's clock in
 * integer epoch milliseconds, on SQLite (a 64-bit INTEGER) and PostgreSQL
 * (numeric) alike. A runtime record whose `now()` answers anything else —
 * a fraction, a non-finite value, one beyond the 64-bit range, a value that
 * is no number — is refused `JD0013`, naming what it answered: read before
 * the run's first link, before any step runs; read again for each receipt,
 * before that receipt's insert, so its link rolls back whole (the whole
 * chain, in an atomic run) instead of failing as the database's own error or
 * storing the fraction. The shadow's replay reads the clock first, so a
 * clock refused there leaves the database without a step run. Integer
 * clocks, negative and beyond 2^53 included, are recorded:
 * below 2^53 exactly on both dialects; beyond it SQLite keeps the number's own
 * integer and PostgreSQL the shortest decimal that reads back as that number.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { migrate, migrationHistory } from '@jarenjs/db';
import { postgresDriver } from '@jarenjs/db/postgres';
import { tempDbPath } from './helpers.js';
import { EMPTY, document, all } from './migration-identity-helpers.js';

const nativeDriver = process.versions.bun ? (await import('@jarenjs/db/bun')).bunDriver
  : (await import('@jarenjs/db/node')).nodeDriver;
let schemaNumber = 0;

/** @param {string} host @param {(context: { connection: any }) => Promise<void>} run */
async function withDatabase(host, run) {
  const temp = tempDbPath();
  let pool, schema, connection;
  try {
    let driver = nativeDriver();
    if (host === 'postgres') {
      const { default: pg } = await import('pg');
      pool = new pg.Pool({ connectionString: process.env.JAREN_PG_URL, max: 3 });
      schema = `jaren_receipt_clock_${process.pid}_${schemaNumber++}`;
      await pool.query(`CREATE SCHEMA "${schema}"`);
      driver = postgresDriver(pool, { schema });
    }
    connection = await driver.open(host === 'postgres' ? ':memory:' : temp.dbPath);
    await run({ connection });
  }
  finally {
    await connection?.close();
    if (pool !== undefined) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
    temp.cleanup();
  }
}

const LINK = document('stamped', [{ kind: 'sql', sql: 'CREATE TABLE stamped_table(n INTEGER)' }]);
const tableNames = async (/** @type {any} */ connection) =>
  (await all(connection, connection.dialect.introspect.tables())).map((/** @type {any} */ row) => String(row.name)).sort();

for (const host of ['sqlite', 'postgres']) describe(`${host}: the receipt clock`,
  { skip: host === 'postgres' && !process.env.JAREN_PG_URL && 'JAREN_PG_URL is not set' }, () => {
    it('a clock answering anything but an integer the history can store is refused before any step runs', async () => {
      await withDatabase(host, async ({ connection }) => {
        // what the clock answers, and how the refusal names it
        /** @type {[any, string][]} */
        const clocks = [[1234.5, '1234.5'], [NaN, 'NaN'], [Infinity, 'Infinity'], [2 ** 63, String(2 ** 63)],
          [-(2 ** 63), String(-(2 ** 63))], [null, 'null'], [undefined, 'undefined'], ['1234', 'a string'],
          [5n, 'a bigint'], [{}, 'an object']];
        const answers = [];
        for (const [stamp, named] of clocks) {
          try {
            await migrate({ connection }, [LINK], { baseline: EMPTY, shadow: false, runtime: { now: () => stamp } });
            answers.push([named, 'applied']);
          }
          catch (error) { answers.push([named, /** @type {any} */ (error).code, /** @type {any} */ (error).message]); }
        }
        assert.deepEqual(answers, clocks.map(([, named]) => [named, 'JD0013',
          `JD0013: migrate() option 'runtime': runtime.now() answered ${named}, and a migration receipt stamps `
          + 'applied_at in integer epoch milliseconds; no step ran']));
        // a run that stamps no receipt reads no receipt clock: nothing pending, or a dry run without the shadow
        const fraction = { now: () => 0.5 };
        assert.deepEqual(await migrate({ connection }, [], { baseline: EMPTY, runtime: fraction }),
          { applied: [], skipped: [], upToDate: true });
        const dry = await migrate({ connection }, [LINK], { baseline: EMPTY, shadow: false, dryRun: true, runtime: fraction });
        assert.deepEqual(/** @type {any} */ (dry).pending, ['stamped']);
        assert.deepEqual(await tableNames(connection), [], 'no step, history or identity table');
      });
    });

    for (const atomic of [false, true]) {
      it(`a clock that turns fractional mid-run refuses the receipt it cannot stamp: ${atomic
        ? 'an atomic run rolls the whole chain back' : 'that link rolls back, the earlier link stands'}`, async () => {
        await withDatabase(host, async ({ connection }) => {
          // read once before the first link, then once per receipt
          const reads = [1_000_000, 1_000_001, 1_000_001.5];
          let at = 0;
          const runtime = { now: () => reads[Math.min(at++, reads.length - 1)] };
          const links = [document('a', [{ kind: 'sql', sql: 'CREATE TABLE ta(n INTEGER)' }]),
            document('b', [{ kind: 'sql', sql: 'CREATE TABLE tb(n INTEGER)' }])];
          await assert.rejects(async () => migrate({ connection }, links, { baseline: EMPTY, shadow: false, atomic, runtime }), {
            code: 'JD0013',
            message: "JD0013: migrate() option 'runtime': runtime.now() answered 1000001.5, and a migration receipt "
              + `stamps applied_at in integer epoch milliseconds; ${atomic
                ? "the atomic run rolled back whole, migration 'b' and every link before it"
                : "migration 'b' rolled back whole, and the links before it stand"}`,
          });
          assert.equal(at, 3, 'one read before the first link, one per receipt');
          const observed = await migrationHistory({ connection });
          assert.deepEqual(observed.history.rows.map((/** @type {any} */ row) => [row.id, row.applied_at]),
            atomic ? [] : [['a', '1000001']]);
          assert.deepEqual((await tableNames(connection)).filter((name) => !name.startsWith('_jaren')), atomic ? [] : ['ta']);
        });
      });
    }

    // the shadow (the default) replays the chain on its own database first,
    // reading the clock the same way, so a clock it cannot stamp is refused
    // there; one dialect shows it
    if (host === 'sqlite') {
      it('a clock that turns fractional in the shadow\'s replay is refused there, and the database runs no step', async () => {
        await withDatabase(host, async ({ connection }) => {
          const reads = [1_000_000, 1_000_001, 1_000_001.5];
          let at = 0;
          const runtime = { now: () => reads[Math.min(at++, reads.length - 1)] };
          // the shadow starts from the baseline's shape, so the baseline declares one
          const model = { $model: '0.1', collections: { items: { schema: { type: 'object' }, key: '/id' } } };
          const links = [document('a', [{ kind: 'sql', sql: 'CREATE TABLE ta(n INTEGER)' }], model),
            document('b', [{ kind: 'sql', sql: 'CREATE TABLE tb(n INTEGER)' }], model)];
          await assert.rejects(async () => migrate({ connection }, links, { baseline: model, shadowDriver: nativeDriver(), runtime }), {
            code: 'JD0013',
            message: "JD0013: migrate() option 'runtime': runtime.now() answered 1000001.5, and a migration receipt "
              + "stamps applied_at in integer epoch milliseconds; the shadow's replay refused migration 'b', "
              + 'and no step ran on the database',
          });
          assert.equal(at, 3, 'every read was the shadow\'s');
          assert.deepEqual((await migrationHistory({ connection })).history.rows, []);
          assert.deepEqual((await tableNames(connection)).filter((name) => !name.startsWith('_jaren')), []);
        });
      });
    }

    // below 2^53 a stamp's decimal is the integer itself on both dialects;
    // beyond it SQLite keeps the number's own integer and PostgreSQL the
    // shortest decimal that reads back as the same number
    for (const [stamp, sqlite, postgres] of /** @type {[number, string, string][]} */ ([
      [-5, '-5', '-5'], [2 ** 53 + 2, '9007199254740994', '9007199254740994'],
      [2 ** 60, '1152921504606846976', '1152921504606847000']])) {
      const text = host === 'postgres' ? postgres : sqlite;
      it(`an integer clock (${sqlite}) is recorded as ${text}`, async () => {
        await withDatabase(host, async ({ connection }) => {
          const out = await migrate({ connection }, [LINK], { baseline: EMPTY, shadow: false, runtime: { now: () => stamp } });
          assert.deepEqual(out.applied, ['stamped']);
          const observed = await migrationHistory({ connection });
          assert.deepEqual(observed.history.rows.map((/** @type {any} */ row) => [row.id, row.applied_at]), [['stamped', text]]);
        });
      });
    }
  });
