//@ts-check
/**
 * @file A CHECK of a shape the model format declares — an enum over an
 * entity column, an interval over a collection — that the store's own model
 * does not declare is an `unmapped-constraint` row of `store.introspect()`
 * (and of a transaction's), not a declaration folded into the derived model:
 * the store's model is the authority on which of its own tables' CHECKs are
 * declarations. Without a model (`introspectModel` over a connection), and on
 * a table the store's model does not own, a CHECK reads as the database holds
 * it. PostgreSQL opens such a table, where the CHECK is kept apart from it;
 * SQLite's open compares the CREATE text whole and refuses it (`JD0002`), so
 * there the store never reads it. PostgreSQL where JAREN_PG_URL names a
 * server; SQLite always.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore, introspectModel } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { skipFor, withPostgres } from './store-core-engines.js';

const window = { type: 'object', properties: { start: { type: 'integer' }, end: { type: 'integer' } } };
const MODEL = { $model: '0.1',
  collections: {
    wins: { schema: { type: 'object', properties: { w: window } }, identity: 'integer',
      indexes: [{ name: 'w_start', path: '$.w.start' }, { name: 'w_end', path: '$.w.end' }] },
  },
  entities: {
    E: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, kind: { type: 'string' },
      status: { type: 'string', enum: ['a', 'b'] } } } },
  } };
/** The same collection declaring its `w` interval: the CHECK it plans is the one added behind a store's back below. */
const DONOR = { $model: '0.1', collections: { wins: { ...MODEL.collections.wins,
  schema: { type: 'object', properties: { w: { ...window, required: ['start', 'end'] } } }, intervals: [{ name: 'w', path: '$.w' }] } } };
const NOT_DECLARED = 'a CHECK the store\'s own model does not declare: it is not read back as a declaration';
/** The unmapped-constraint rows of a report. @param {any} report */
const unmapped = (report) => report.filter((/** @type {any} */ row) => row.code === 'unmapped-constraint')
  .map((/** @type {any} */ row) => ({ object: row.object, detail: row.detail }));
/** What the alterations below read back as: the entity's properties and the collection's interval and member. @param {any} read */
const shapeOf = (read) => ({ E: read.model.entities.E.schema.properties, intervals: read.model.collections.wins.intervals,
  w: read.model.collections.wins.schema.properties.w });
const FRESH = { E: { id: { type: 'number', 'x-entity': { key: true } }, kind: { type: 'string' }, status: { type: 'string', enum: ['a', 'b'] } },
  intervals: undefined, w: { type: 'object', properties: { start: { type: 'number' }, end: { type: 'number' } } } };

describe('a CHECK of a declarable shape the store\'s model does not declare, PostgreSQL', { skip: skipFor('postgres') }, () => {
  it('is an unmapped-constraint row of store.introspect() and tx.introspect(), and introspectModel without the model still reads it', async () => {
    await withPostgres(async ({ pool, schema, driver }) => {
      const created = await openStore(MODEL, { driver: driver() });
      try {
        const own = await created.introspect();
        assert.deepEqual(unmapped(own.report), []);
        assert.deepEqual(shapeOf(own), FRESH);
      }
      finally { await created.close(); }
      const s = `"${schema}"`;
      // the interval CHECK a store gives a declared `w` interval, as this server stores it
      const donor = `${schema}_donor`;
      let interval;
      try {
        await pool.query(`CREATE SCHEMA "${donor}"`);
        await (await openStore(DONOR, { driver: driver({ schema: donor }) })).close();
        ({ rows: [{ interval }] } = await pool.query('SELECT pg_get_constraintdef(oid) AS interval FROM pg_constraint '
          + 'WHERE conname = \'w_interval\' AND connamespace = $1::regnamespace', [donor]));
      }
      finally { await pool.query(`DROP SCHEMA IF EXISTS "${donor}" CASCADE`); }
      await pool.query(`ALTER TABLE ${s}."E" ADD CONSTRAINT kind_enum CHECK (kind IN ('x', 'y')); `
        + `ALTER TABLE ${s}."E" ADD CONSTRAINT status_narrow CHECK (status IN ('a')); `
        + `ALTER TABLE ${s}."E" ADD CONSTRAINT status_other CHECK (status IN ('a', 'c')); `
        + `ALTER TABLE ${s}."E" ADD CONSTRAINT status_same CHECK (status IN ('b', 'a')); `
        + `ALTER TABLE ${s}.wins ADD CONSTRAINT w_interval ${interval}`);
      const store = await openStore(MODEL, { driver: driver() });
      try {
        const read = await store.introspect();
        assert.deepEqual(shapeOf(read), FRESH, 'the derived model is the fresh store\'s');
        const rows = [{ object: 'E.kind_enum', detail: NOT_DECLARED }, { object: 'E.status_narrow', detail: NOT_DECLARED },
          { object: 'E.status_other', detail: NOT_DECLARED }, { object: 'E.status_same', detail: NOT_DECLARED }, { object: 'wins.w_interval', detail: NOT_DECLARED }];
        assert.deepEqual(unmapped(read.report), rows);
        const inTransaction = await store.transaction((/** @type {any} */ tx) => tx.introspect());
        assert.deepEqual([shapeOf(inTransaction), unmapped(inTransaction.report)], [FRESH, rows]);
        // strict introspection refuses the rows
        await assert.rejects(store.introspect({ strict: true }), (/** @type {any} */ error) => error.code === 'JD0002'
          && error.message.includes('unmapped-constraint (E.kind_enum)') && error.message.includes('unmapped-constraint (wins.w_interval)'));
      }
      finally { await store.close(); }
      // without the model, the database's CHECKs are what it declares
      const connection = await driver().open();
      try {
        const bare = await introspectModel(connection);
        assert.deepEqual(shapeOf(bare), {
          E: { ...FRESH.E, kind: { type: 'string', enum: ['x', 'y'] }, status: { type: 'string', enum: ['a'] } },
          intervals: [{ name: 'w', path: '$.w' }],
          w: { type: 'object', properties: { start: { type: 'integer' }, end: { type: 'integer' } }, required: ['start', 'end'] } });
        assert.deepEqual(unmapped(bare.report), []);
      }
      finally { await connection.close(); }
    });
  });

  it('reads every CHECK the model declares as before: enums of each scalar type, an interval with its bound', async () => {
    const declared = { $model: '0.1',
      collections: {
        spans: { schema: { type: 'object', properties: { span: { type: 'object', required: ['start', 'end'], properties: { start: { type: 'integer' }, end: { type: 'integer' } } } } },
          identity: 'integer', indexes: [{ name: 'by_start', path: '$.span.start' }, { name: 'by_end', path: '$.span.end' }],
          intervals: [{ name: 'span', path: '$.span', maxDuration: 100 }] },
      },
      entities: {
        F: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } },
          s: { type: 'string', enum: ['p', 'q', null] }, i: { type: 'integer', enum: [1, 2, 3] }, n: { type: 'number', enum: [1.5, 2] },
          b: { type: 'boolean', enum: [true] } } } },
      } };
    await withPostgres(async ({ driver }) => {
      const store = await openStore(declared, { driver: driver() });
      try {
        const read = await store.introspect();
        const connection = await driver().open();
        try { assert.deepEqual(read, await introspectModel(connection), 'the store reads its own CHECKs as a bare read does'); }
        finally { await connection.close(); }
        assert.deepEqual(unmapped(read.report), []);
        assert.deepEqual(read.model.collections.spans.intervals, [{ name: 'span', path: '$.span', maxDuration: 100 }]);
        const { s, i, n } = read.model.entities.F.schema.properties;
        assert.deepEqual([s.enum, i.enum, n.enum], [['p', 'q'], [1, 2, 3], [1.5, 2]]);
      }
      finally { await store.close(); }
    });
  });

  it('names an enum CHECK of other values in place of the declared one, and the column keeps no enum', async () => {
    await withPostgres(async ({ pool, schema, driver }) => {
      await (await openStore(MODEL, { driver: driver() })).close();
      await pool.query(`ALTER TABLE "${schema}"."E" DROP CONSTRAINT "E_status_check"; `
        + `ALTER TABLE "${schema}"."E" ADD CONSTRAINT status_swap CHECK (status IN ('a', 'c'))`);
      const store = await openStore(MODEL, { driver: driver() });
      try {
        const read = await store.introspect();
        assert.deepEqual(read.model.entities.E.schema.properties.status, { type: 'string' });
        assert.deepEqual(unmapped(read.report), [{ object: 'E.status_swap', detail: NOT_DECLARED }]);
      }
      finally { await store.close(); }
    });
  });

  it('reads a CHECK of a table the store\'s model does not own as the database holds it', async () => {
    await withPostgres(async ({ pool, schema, driver }) => {
      await pool.query(`CREATE TABLE "${schema}".app (id bigint PRIMARY KEY, kind text CHECK (kind IN ('p', 'q')))`);
      const store = await openStore(MODEL, { driver: driver() });
      try {
        const read = await store.introspect();
        assert.deepEqual(read.model.entities.app.schema.properties.kind, { type: 'string', enum: ['p', 'q'] });
        assert.deepEqual(unmapped(read.report), []);
      }
      finally { await store.close(); }
    });
  });
});

describe('a CHECK of a declarable shape the store\'s model does not declare, SQLite', () => {
  /** Rebuild a table of a closed store's file with one more table constraint. @param {string} file @param {string} table @param {string} constraint */
  const addConstraint = (file, table, constraint) => {
    const db = new DatabaseSync(file);
    try {
      const { sql } = /** @type {any} */ (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
      const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL").all(table)
        .map((/** @type {any} */ row) => row.sql);
      db.exec(`DROP TABLE "${table}"; ${String(sql).replace(/\)(\s*STRICT)?\s*$/, (_, strict) => `, ${constraint})${strict ?? ''}`)}; ${indexes.join('; ')}`);
    }
    finally { db.close(); }
  };
  it('is JD0002 at open, so the store never reads it, and introspectModel without the model reads it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaren-undeclared-check-'));
    try {
      await (await openStore(DONOR, { driver: nodeDriver(), path: path.join(dir, 'donor.db') })).close();
      const donor = new DatabaseSync(path.join(dir, 'donor.db'));
      const { sql: donorSql } = /** @type {any} */ (donor.prepare("SELECT sql FROM sqlite_master WHERE name = 'wins'").get());
      donor.close();
      const interval = /CONSTRAINT "w_interval" CHECK \(.*\)(?=\)( STRICT)?$)/.exec(String(donorSql))?.[0];
      assert.ok(interval !== undefined, String(donorSql));
      const file = path.join(dir, 'store.db');
      const created = await openStore(MODEL, { driver: nodeDriver(), path: file });
      try { assert.deepEqual(unmapped((await created.introspect()).report), []); }
      finally { await created.close(); }
      addConstraint(file, 'E', 'CONSTRAINT kind_enum CHECK ("kind" IN (\'x\', \'y\'))');
      await assert.rejects(openStore(MODEL, { driver: nodeDriver(), path: file }), (/** @type {any} */ error) => error.code === 'JD0002'
        && error.message.startsWith('JD0002: entity \'E\': the existing table does not match the declared model'));
      addConstraint(file, 'wins', interval);
      await assert.rejects(openStore({ $model: '0.1', collections: MODEL.collections }, { driver: nodeDriver(), path: file }), (/** @type {any} */ error) => error.code === 'JD0002'
        && error.message.startsWith('JD0002: collection \'wins\': the existing table does not match the declared model'));
      const connection = await nodeDriver().open(file, {});
      try {
        const bare = await introspectModel(connection);
        assert.deepEqual([bare.model.entities.E.schema.properties.kind, bare.model.collections.wins.intervals],
          [{ type: 'string', enum: ['x', 'y'] }, [{ name: 'w', path: '$.w' }]]);
      }
      finally { await connection.close(); }
    }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('added behind an open store\'s back, is an unmapped-constraint row of store.introspect()', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaren-undeclared-check-'));
    try {
      const file = path.join(dir, 'store.db');
      const store = await openStore(MODEL, { driver: nodeDriver(), path: file });
      try {
        const fresh = (await store.introspect()).model.entities.E.schema.properties;
        assert.deepEqual(fresh.status, { type: 'string', enum: ['a', 'b'] });
        addConstraint(file, 'E', 'CONSTRAINT kind_enum CHECK ("kind" IN (\'x\', \'y\'))');
        addConstraint(file, 'E', 'CONSTRAINT status_narrow CHECK ("status" IN (\'a\'))');
        const read = await store.introspect();
        assert.deepEqual(read.model.entities.E.schema.properties, fresh);
        assert.deepEqual(unmapped(read.report), [{ object: 'E.kind_enum', detail: NOT_DECLARED }, { object: 'E.status_narrow', detail: NOT_DECLARED }]);
      }
      finally { await store.close(); }
    }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
