//@ts-check
/**
 * @file The physical mapping a plan takes where the caller names none is the
 * one the open takes on that engine, as far as a dialect can say: on
 * PostgreSQL a derived column is stored (the dialect spells no generated
 * expression for it — the store writes its value) and there is no R*Tree, so
 * a plan over a geohash- or bbox-derived collection renders the stored
 * columns and their backfill instead of meeting the dialect's own refusal;
 * on SQLite the defaults stay the generated expression and the R*Tree. A
 * caller still names a driver's difference (`derived: 'stored'` for a host
 * without deterministic functions) explicitly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { planModelMigration, planCollection, normalizeModel, sqliteDialect } from '@jarenjs/db';
import { postgresDialect } from '@jarenjs/db/postgres';

const SCHEMA = { type: 'object', properties: { id: { type: 'string' }, at: { type: 'array', items: { type: 'number' } } } };
/** The places collection with the given indexes. @param {any[]} indexes */
const places = (indexes) => ({ $model: '0.1', collections: { places: { schema: SCHEMA, key: '/id', indexes } } });
const CELL = { name: 'by_cell', path: '$.at', derive: 'geohash', precision: 6 };
const BOX = { name: 'by_box', path: '$.at', derive: 'bbox', physical: 'rtree' };
/** The step texts of the plan from one model to another. @param {any} from @param {any} to @param {any} dialect @param {any} [options] */
const planned = (from, to, dialect, options = {}) => planModelMigration(from, to, { dialect, id: 'm', ...options }).migration.steps
  .map((step) => step.sql ?? step.kind);

describe('the plan follows the engine where the caller names no mapping', () => {
  const pg = postgresDialect();

  it('postgres: a derived column is stored — identical models plan nothing, and an added one is a column, its backfill and its index', () => {
    assert.deepEqual(planned(places([CELL]), places([CELL]), pg), []);
    assert.deepEqual(planned(places([CELL]), places([CELL]), pg, { derived: 'stored' }), []);
    const [{ name: column, type }] = planCollection('places', normalizeModel(places([CELL])).get('places'), pg, { derived: 'stored' })
      .generated.filter((g) => g.stored === true);
    const steps = planned(places([]), places([CELL]), pg);
    assert.deepEqual(steps, [
      `ALTER TABLE "places" ADD COLUMN "${column}" ${type}`,
      'derive',
      `CREATE INDEX "places_by_cell" ON "places" ("${column}")`,
    ]);
    assert.ok(steps.every((sql) => !sql.includes('GENERATED')), 'nothing is generated on this engine');
  });

  it('postgres: an R*Tree index is the column set alone — identical models plan nothing', () => {
    assert.deepEqual(planned(places([BOX]), places([BOX]), pg), []);
    assert.ok(planned(places([]), places([BOX]), pg).every((sql) => !/VIRTUAL TABLE|TRIGGER/.test(sql)));
  });

  it('sqlite: the defaults stay the generated expression and the R*Tree', () => {
    assert.deepEqual(planned(places([CELL]), places([CELL]), sqliteDialect), []);
    assert.ok(planned(places([]), places([CELL]), sqliteDialect).some((sql) => /GENERATED ALWAYS AS \(jaren_geohash/.test(sql)));
    assert.ok(planned(places([]), places([BOX]), sqliteDialect).some((sql) => /CREATE VIRTUAL TABLE/.test(sql)));
  });
});
