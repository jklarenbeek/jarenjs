//@ts-check
/**
 * @file A PostgreSQL rebuild that folds columns into the document writes
 * each non-NULL column under its name, leaves the document alone for a NULL
 * one (also a member the document already holds), and plans a copy statement
 * that grows linearly with the columns it folds.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore, planModelMigration, migrate } from '@jarenjs/db';
import { postgresDriver, postgresDialect } from '@jarenjs/db/postgres';

/** @type {any} */
const FROM = {
  $model: '0.1', entities: { T: { schema: { type: 'object', required: ['id'], properties: {
    id: { type: 'string', 'x-entity': { key: true } },
    i: { type: 'integer' }, n: { type: 'number' }, s: { type: 'string' }, b: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' } }, r: { type: 'integer' },
  } } } },
};
const TO = structuredClone(FROM);
for (const name of ['i', 'n', 's', 'b']) TO.entities.T.schema.properties[name]['x-entity'] = { column: 'json' };
TO.entities.T.schema.properties.r = { type: 'string' };

/**
 * @param {number} count @param {boolean} json
 * @returns {any}
 */
function counted(count, json) {
  /** @type {Record<string, any>} */
  const properties = { id: { type: 'string', 'x-entity': { key: true } } };
  for (let i = 0; i < count; i++) {
    properties[`c${i}`] = json ? { type: 'integer', 'x-entity': { column: 'json' } } : { type: 'integer' };
  }
  properties.r = { type: json ? 'string' : 'integer' };
  return { $model: '0.1', entities: { T: { schema: { type: 'object', required: ['id'], properties } } } };
}

/** The plan of a change between two models as the engine plans it. @param {any} from @param {any} to @param {string} schema */
function plan(from, to, schema) {
  const { migration } = planModelMigration(from, to, { dialect: postgresDialect({ schema }), id: 'fold' });
  migration.steps = migration.steps.filter((/** @type {any} */ step) => !(step.kind === 'jslt' && step.draft));
  return migration;
}

let schemaNumber = 0;

describe('postgres: a rebuild that folds columns into the document',
  { skip: !process.env.JAREN_PG_URL && 'JAREN_PG_URL is not set' }, () => {
    it('writes each non-NULL column under its name and leaves a NULL one alone', async () => {
      const { default: pg } = await import('pg');
      const pool = new pg.Pool({ connectionString: process.env.JAREN_PG_URL, max: 3 });
      const schema = `jaren_fold_${process.pid}_${schemaNumber++}`;
      await pool.query(`CREATE SCHEMA "${schema}"`);
      try {
        const driver = () => postgresDriver(pool, { schema });
        const store = await openStore(FROM, { driver: driver() });
        try {
          const rows = [
            { id: '1', i: 1, n: 81.125, s: 'a"b', b: true, tags: ['x'], r: 5 },
            { id: '2', b: false, r: 6 }, { id: '3' }, { id: '4', s: '', tags: [], r: 7 },
            { id: '5', n: 0, i: -3, b: true, r: 8 },
          ];
          for (const row of rows) await store.entity('T').create(row);
        } finally { await store.close(); }
        await pool.query(`UPDATE "${schema}"."T" SET "doc" = jsonb_set("doc", '{n}', '99') WHERE "id" = '3'`);
        const migration = plan(FROM, TO, schema);
        assert.ok(migration.steps.some((/** @type {any} */ step) => step.kind === 'rebuild'));
        await migrate({ driver: driver() }, [migration], { baseline: FROM, model: TO, shadow: false });
        const { rows } = await pool.query(`SELECT "id", "doc" FROM "${schema}"."T" ORDER BY "id"`);
        assert.deepEqual(rows.map((/** @type {any} */ found) => [found.id, found.doc]), [
          ['1', { tags: ['x'], i: 1, n: 81.125, s: 'a"b', b: true }],
          ['2', { b: false }],
          ['3', { n: 99 }],
          ['4', { tags: [], s: '' }],
          ['5', { i: -3, n: 0, b: true }],
        ]);
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await pool.end();
      }
    });

    it('plans a copy statement that grows linearly with the columns it folds', () => {
      const copy = (/** @type {number} */ count) => plan(counted(count, false), counted(count, true), 's')
        .steps.find((/** @type {any} */ step) => step.kind === 'rebuild').copy;
      const small = copy(8), large = copy(16);
      assert.ok(large.length < 3 * small.length, `${small.length} -> ${large.length}`);
      assert.equal(small.split(' SELECT ')[1].split('"doc"').length - 1, 1);
    });
  });
