//@ts-check
/**
 * @file Member paths outside ASCII identifiers on a live PostgreSQL server:
 * an entity index, its condition and a database rule over members named
 * `日本`, `a b` or holding a quote, a bracket, a backslash or SQL, written in
 * the bracket spelling, refuse the rows their ASCII-named twins refuse on
 * SQLite and agree with the query engine; every open reads the conditions
 * back out of the catalog and reopens clean, a session without standard
 * strings included; introspection reads the indexes back to the model.
 * Three connections at most; each test drops its schema.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, planMigration } from '@jarenjs/db';
import { postgresDialect } from '@jarenjs/db/postgres';
import { PG_URL, withPostgres } from './store-core-engines.js';
import { ODD_NAMES, ODD_NAME_VERDICTS, PATH_MEMBERS, SCENARIO_NAMES, SHIFT_NAMES, SHIFT_ROWS, SHIFT_VERDICTS, TRUTH_NAMES, TRUTH_POLICIES, UNIQUE_NAMES,
  createVerdicts, hybridTruthTable, memberPathScenario, oddNameVerdicts, oddNamesModel, postgresEngine, renameKeys, ruleTruthTable, shiftModelOf,
  sqliteEngine, uniquenessAgreement, uniquenessModelOf } from './invariant-oracle.js';

/** The catalog's stored predicate of one index, or null. @param {any} pool @param {string} schema @param {string} index */
async function storedPredicate(pool, schema, index) {
  const { rows } = await pool.query('SELECT pg_get_expr(i.indpred, i.indrelid) AS predicate FROM pg_index i '
    + 'JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2', [schema, index]);
  return rows[0]?.predicate ?? null;
}

describe('member paths outside ASCII identifiers on PostgreSQL', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => {
  it('an entity index and its condition refuse exactly the rows SQLite\'s ASCII-named twin refuses, as the query engine judges them', async () => {
    const { nodeDriver } = await import('@jarenjs/db/node');
    const ascii = await openStore(uniquenessModelOf(), { driver: nodeDriver(), path: ':memory:' });
    let twins;
    try { twins = await uniquenessAgreement(ascii); }
    finally { await ascii.close(); }
    await withPostgres(async ({ pool, schema, driver }) => {
      const model = uniquenessModelOf(UNIQUE_NAMES);
      const store = await openStore(model, { driver: driver() });
      try {
        const agreed = await uniquenessAgreement(store, UNIQUE_NAMES);
        assert.equal(agreed.length, 13);
        for (const [at, { where, expected, actual, judged, stored }] of agreed.entries()) {
          assert.deepEqual(actual, expected, JSON.stringify(where));
          assert.deepEqual(expected, twins[at].expected, JSON.stringify(where));
          assert.deepEqual(stored, judged, JSON.stringify(where));
        }
      }
      finally { await store.close(); }
      // the condition is the catalog's own, every name quoted; the open reads it back and reopens clean
      assert.equal(await storedPredicate(pool, schema, 'U0_one'), '("it\'s ""a]b"" \\ c" = ANY (ARRAY[\'active\'::text, \'pending\'::text]))');
      await (await openStore(model, { driver: driver() })).close();
      const { rows } = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename LIKE 'U%' ORDER BY tablename", [schema]);
      assert.equal(rows.length, 13);
    });
  });

  it('every name takes a unique index, its condition and a database rule, reopening clean in a session without standard strings', async () => {
    await withPostgres(async ({ schema, driver }) => {
      await (await openStore(oddNamesModel(), { driver: driver() })).close();
      const store = await openStore(oddNamesModel(), { driver: driver() });
      try { assert.deepEqual(await oddNameVerdicts(store), ODD_NAMES.map(() => ODD_NAME_VERDICTS)); }
      finally { await store.close(); }
      const { default: pg } = await import('pg');
      const escaped = new pg.Pool({ connectionString: PG_URL, max: 1, options: '-c standard_conforming_strings=off' });
      try {
        const { postgresDriver } = await import('@jarenjs/db/postgres');
        await (await openStore(oddNamesModel(), { driver: postgresDriver(escaped, { schema }) })).close();
      }
      finally { await escaped.end(); }
    });
  });

  it('a database rule accepts exactly what SQLite\'s ASCII-named twin accepts, on an explicit layout and on one the store owns', async () => {
    for (const policy of Object.values(TRUTH_POLICIES))
      assert.equal(await ruleTruthTable(postgresEngine(), policy, TRUTH_NAMES), await ruleTruthTable(sqliteEngine(), policy), JSON.stringify(policy));
    assert.equal(await hybridTruthTable(postgresEngine(), TRUTH_NAMES), await hybridTruthTable(sqliteEngine()));
  });

  it('a probe, a delete rule and a sum answer as on SQLite, whether the store or the database enforces them', async () => {
    for (const enforcement of /** @type {const} */ (['store', 'database']))
      assert.equal(await memberPathScenario(postgresEngine(), enforcement, SCENARIO_NAMES), await memberPathScenario(sqliteEngine(), enforcement, PATH_MEMBERS), enforcement);
  });

  it('introspection reads the index back in the model\'s spelling, and the derived model reopens the database', async () => {
    await withPostgres(async ({ schema, driver }) => {
      const flagged = shiftModelOf(SHIFT_NAMES);
      flagged.entities.Shift.schema.properties['従業員'] = { type: 'string', 'x-entity': { index: true } };
      flagged.entities.Shift.indexes.push({ name: 'by_day', path: "$['a b']" });
      const store = await openStore(flagged, { driver: driver() });
      const { model: derived, report } = await store.introspect();
      await store.close();
      assert.deepEqual(derived.entities.Shift.indexes, [{ name: 'by_day', path: '$["a b"]' },
        { name: 'one_active', path: ['$["従業員"]', '$["a b"]'], unique: true, where: { $eq: ['$["x\\"]\\\\\'"]', { $seq: ['active', 'pending'] }] } }]);
      assert.deepEqual(derived.entities.Shift.schema.properties['従業員'], { type: 'string', 'x-entity': { index: true } });
      assert.deepEqual(report.filter((row) => row.code === 'unmapped-index'), []);
      const back = planMigration(derived, flagged, { dialect: postgresDialect({ searchPath: schema }) });
      assert.deepEqual(back.migration.steps.map((step) => `${step.kind}${step.draft === true ? ' (draft)' : ''}`), ['jslt (draft)']);
      const reopened = await openStore(derived, { driver: driver() });
      try { assert.deepEqual(await createVerdicts(reopened.entity('Shift'), SHIFT_ROWS.map((row) => renameKeys(row, SHIFT_NAMES))), SHIFT_VERDICTS); }
      finally { await reopened.close(); }
    });
  });
});
