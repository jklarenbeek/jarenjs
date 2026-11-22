//@ts-check
/**
 * @file A CHECK the model does not declare — one an operator or another
 * writer added — is reported, not refused at open on PostgreSQL, where the
 * catalog holds each CHECK apart from the table: the open verifies the ones
 * the model declares, every other still governs writes (refused `JD2005`,
 * class `constraint`), and `introspect()` names each as `unmapped-constraint`
 * — a collection's, an entity's and a join table's alike — while the CHECKs
 * a store gives its own tables (a number's, a key's, an enum's, an
 * interval's) are none of them. SQLite keeps a table's CHECKs in its CREATE
 * text, which the open compares whole: there the same table is `JD0002` at
 * open, and introspection over the database names the CHECK as PostgreSQL's
 * does. PostgreSQL where JAREN_PG_URL names a server; SQLite always.
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

const MODEL = { $model: '0.1',
  collections: {
    docs: { schema: {}, identity: 'integer', indexes: [] },
    spans: { schema: { type: 'object', properties: { span: { type: 'object', required: ['start', 'end'], properties: { start: { type: 'integer' }, end: { type: 'integer' } } } } }, identity: 'integer',
      indexes: [{ name: 'by_start', path: '$.span.start' }, { name: 'by_end', path: '$.span.end' }],
      intervals: [{ name: 'span', path: '$.span' }] },
  },
  entities: {
    E: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, n: { type: 'number' },
      status: { type: 'string', enum: ['a', 'b'] }, tags: { 'x-entity': { relation: { to: 'T', many: true } } } } } },
    T: { schema: { type: 'object', properties: { tid: { type: 'integer', 'x-entity': { key: true } } } } },
  } };
/** The unmapped-constraint rows of a report, by object. @param {any} report */
const unmapped = (report) => report.filter((/** @type {any} */ row) => row.code === 'unmapped-constraint').map((/** @type {any} */ row) => row.object).sort();

describe('a CHECK the model does not declare, PostgreSQL', { skip: skipFor('postgres') }, () => {
  it('opens, still refuses the writes it governs, and is a line of introspect() on a collection, an entity and a join table', async () => {
    await withPostgres(async ({ pool, schema, driver }) => {
      const created = await openStore(MODEL, { driver: driver() });
      try { assert.deepEqual(unmapped((await created.introspect()).report), [], 'the store\'s own CHECKs are none of them'); }
      finally { await created.close(); }
      const s = `"${schema}"`;
      await pool.query(`ALTER TABLE ${s}.docs ADD CONSTRAINT x CHECK (length(doc::text) < 20); `
        + `ALTER TABLE ${s}."E" ADD CONSTRAINT y CHECK (n < 100); `
        + `ALTER TABLE ${s}."E_T" ADD CONSTRAINT z CHECK ("T_key" <> 13)`);
      const store = await openStore(MODEL, { driver: driver() });
      try {
        assert.deepEqual(unmapped((await store.introspect()).report), ['E.y', 'E_T.z', 'docs.x']);
        await store.collection('docs').insert({ n: 1 });
        await assert.rejects(store.collection('docs').insert({ text: 'x'.repeat(40) }),
          (/** @type {any} */ error) => error.code === 'JD2005' && error.class === 'constraint');
        await assert.rejects((async () => { await store.entity('E').create({ id: 1, n: 500 }); await store.saveChanges(); })(),
          (/** @type {any} */ error) => error.code === 'JD2005' && error.class === 'constraint');
      }
      finally { await store.close(); }
    });
  });
});

describe('a CHECK the model does not declare, SQLite', () => {
  it('is JD0002 at open, and introspection over the database names it as PostgreSQL\'s does', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jaren-foreign-check-'));
    const file = path.join(dir, 'store.db');
    try {
      const created = await openStore(MODEL, { driver: nodeDriver(), path: file });
      try { assert.deepEqual(unmapped((await created.introspect()).report), []); }
      finally { await created.close(); }
      const db = new DatabaseSync(file);
      try {
        const { sql } = /** @type {any} */ (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'docs'").get());
        db.exec(`ALTER TABLE docs RENAME TO docs_old; ${String(sql).replace(/\)\s*STRICT\s*$/, ', CONSTRAINT x CHECK (length(doc) < 20)) STRICT')}; `
          + 'INSERT INTO docs SELECT * FROM docs_old; DROP TABLE docs_old');
      }
      finally { db.close(); }
      await assert.rejects(openStore(MODEL, { driver: nodeDriver(), path: file }), { code: 'JD0002' });
      const connection = await nodeDriver().open(file, {});
      try { assert.deepEqual(unmapped((await introspectModel(connection)).report), ['docs.x']); }
      finally { await connection.close(); }
    }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
