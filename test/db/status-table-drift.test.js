//@ts-check
/**
 * @file `migrationStatus(…, { model })` over a store altered behind its back
 * reads every table the model's store owns as the next open verifies it. On
 * PostgreSQL, which keeps no CREATE text, a collection's or an entity's
 * index, column, interval CHECK, foreign key or undeclared trigger the open
 * refuses is drift, named in the open's words, and so is a table the
 * database does not hold; a shape the open opens (a join table without the
 * index over its second key column, which an earlier release created) is
 * no drift. The status reads the catalog once per pass, not once per table.
 * On SQLite every stored CREATE text is compared, and the same alterations
 * read as drift there. PostgreSQL runs on a live server (`JAREN_PG_URL`;
 * skipped without it).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrationStatus, openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { storeTemporals } from '@jarenjs/db/temporals';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import { tempDbPath } from './helpers.js';
import { PG_URL, withPostgres } from './store-core-engines.js';

const skip = !PG_URL && 'JAREN_PG_URL is not set';
const SPAN = { type: 'object', required: ['start', 'end'], properties: { start: { type: 'integer' }, end: { type: 'integer' } } };
/** A collection with an interval, entities with an index, a foreign key and a join table. */
const MODEL = { $model: '0.1',
  collections: { items: { key: '/id', schema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, span: SPAN } },
    indexes: [{ name: 'by_name', path: '$.name' }, { name: 'by_start', path: '$.span.start' }, { name: 'by_end', path: '$.span.end' }],
    intervals: [{ name: 'slot', path: '$.span' }] } },
  entities: {
    User: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', 'x-entity': { key: true } }, age: { type: 'integer' },
      labels: { 'x-entity': { relation: { to: 'Label', many: true } } },
      posts: { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'restrict' } } } } },
    indexes: [{ name: 'by_age', path: '$.age' }] },
    Post: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', 'x-entity': { key: true } }, authorId: { type: 'string' } } } },
    Label: { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', 'x-entity': { key: true } } } } },
  } };
const UNDECLARED_FUNCTION = 'CREATE FUNCTION f_x() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$';

/** Each alteration on PostgreSQL, the drift status names and whether the open refuses it. */
const POSTGRES_CASES = [
  ['a collection index dropped', 'DROP INDEX "items_by_end"',
    "collection 'items': 2 declared indexes exist, the model declares 3 — the model declares items_by_end, which the database does not have"],
  ['an interval CHECK dropped', 'ALTER TABLE items DROP CONSTRAINT "slot_interval"',
    "collection 'items': the model declares the interval 'slot' as CHECK 'slot_interval', which the database does not have"],
  ['a collection table dropped', 'DROP TABLE items', "collection 'items': the table does not exist"],
  ['an entity column retyped', 'ALTER TABLE "User" DROP CONSTRAINT "User_age_check"; ALTER TABLE "User" ALTER COLUMN "age" TYPE text',
    "entity 'User': column 'age' is TEXT, the model declares 'age' NUMERIC"],
  ['an entity column added', 'ALTER TABLE "User" ADD COLUMN extra integer',
    "entity 'User': 5 columns exist, the model declares 4; undeclared: 'extra'"],
  ['an entity index dropped', 'DROP INDEX "User_by_age"',
    "entity 'User': 0 declared indexes exist, the model declares 1 — the model declares User_by_age, which the database does not have"],
  ['an undeclared trigger', `${UNDECLARED_FUNCTION}; CREATE TRIGGER t_x BEFORE INSERT ON "User" FOR EACH ROW EXECUTE FUNCTION f_x()`,
    "entity 'User': the database has the trigger 't_x', which the model does not declare — an undeclared trigger changes what a write does"],
  ['a foreign key action changed', 'ALTER TABLE "Post" DROP CONSTRAINT "Post_authorId_fkey"; '
    + 'ALTER TABLE "Post" ADD CONSTRAINT "Post_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"(id) ON DELETE CASCADE',
  "entity 'Post': the foreign keys are [authorId -> User(id) ON DELETE CASCADE ON UPDATE NO ACTION], "
    + 'the model declares [authorId -> User(id) ON DELETE NO ACTION ON UPDATE NO ACTION]'],
  ['a join table dropped', 'DROP TABLE "Label_User"', "entity 'Label_User': the table does not exist"],
];

/** @param {any} driver @returns {Promise<string>} what a read-only open answers */
const opened = (driver) => openStore(MODEL, { driver, readOnly: true })
  .then(async (store) => { await store.close(); return 'opens'; }, (/** @type {any} */ error) => String(error.code));

describe('PostgreSQL status over a store altered behind its back', () => {
  for (const [name, sql, drift] of POSTGRES_CASES) {
    it(`names ${name} as the open refuses it`, { skip }, () => withPostgres(async ({ pool, schema, driver }) => {
      await (await openStore(MODEL, { driver: driver() })).close();
      assert.deepEqual(await migrationStatus({ driver: driver() }, [], { model: MODEL }),
        { applied: [], pending: [], drift: null, upToDate: true, baseline: null });
      await pool.query(`SET search_path TO "${schema}"; ${sql}`);
      const status = await migrationStatus({ driver: driver() }, [], { model: MODEL });
      assert.deepEqual([status.drift, status.upToDate], [drift, false]);
      // the open refuses the same table: a read-only one a table it does not hold too
      assert.equal(await opened(driver()), 'JD0002');
    }));
  }

  it('calls current what the open opens: a join table without its second index, an integer column without its CHECK', { skip }, () =>
    withPostgres(async ({ pool, schema, driver }) => {
      await (await openStore(MODEL, { driver: driver() })).close();
      await pool.query(`SET search_path TO "${schema}"; DROP INDEX "Label_User_User_key"; ALTER TABLE "User" DROP CONSTRAINT "User_age_check"`);
      assert.deepEqual([await opened(driver()), (await migrationStatus({ driver: driver() }, [], { model: MODEL })).drift], ['opens', null]);
    }));

  it('names a temporal member\'s CHECK dropped from an entity, then a collection, and calls a fresh store current', { skip }, () =>
    withPostgres(async ({ pool, schema, driver }) => {
      const KINDS = [['d', 'date'], ['u', 'utc'], ['z', 'zoned', 'rfc5545']];
      const model = { $model: '0.1',
        collections: { evc: { key: '/id', schema: { type: 'object', properties: { id: { type: 'string' } } },
          temporals: KINDS.map(([name, kind, policy]) => ({ name, path: `$.${name}`, kind, ...(policy === undefined ? {} : { policy }) })),
          indexes: KINDS.map(([name]) => ({ name: `by_${name}`, path: `$.${name}` })) } },
        entities: { Ev: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } },
          ...Object.fromEntries(KINDS.map(([name, kind, policy]) => [name, { type: 'object',
            'x-entity': { temporal: { kind, ...(policy === undefined ? {} : { policy }) }, index: true } }])) } } } } };
      await (await openStore(model, { driver: driver(), temporals: storeTemporals(), zoneProvider: createIntlZoneProvider({ revision: 'status' }) })).close();
      const drift = async () => (await migrationStatus({ driver: driver() }, [], { model })).drift;
      assert.equal(await drift(), null);
      await pool.query(`SET search_path TO "${schema}"; ALTER TABLE "Ev" DROP CONSTRAINT "u_temporal"`);
      assert.equal(await drift(), "entity 'Ev': the model declares the utc member 'u' with CHECK 'u_temporal', which the database does not have");
      await pool.query(`SET search_path TO "${schema}"; ALTER TABLE evc DROP CONSTRAINT "d_temporal"`);
      assert.equal(await drift(), "collection 'evc': the model declares the date member 'd' with CHECK 'd_temporal', which the database does not have");
    }));

  it('reads a table whose index calls the host\'s functions only with them, and every other table, a collection\'s or one that references it, without', { skip }, () =>
    withPostgres(async ({ pool, schema, driver }) => {
      const ID = { type: 'integer', 'x-entity': { key: true } };
      const LOWER = { call: 'lower', args: [{ member: '$.tag' }] };
      const model = { $model: '0.1',
        collections: {
          c: { key: '/id', schema: { type: 'object', properties: { id: { type: 'string' }, tag: { type: 'string' } } }, indexes: [{ name: 'by_tag', expression: LOWER }] },
          d: { key: '/id', schema: { type: 'object', properties: { id: { type: 'string' }, v: { type: 'string' } } }, indexes: [{ name: 'by_v', path: '$.v' }] } },
        entities: {
          Ex: { schema: { type: 'object', properties: { id: ID, tag: { type: 'string' },
            kids: { 'x-entity': { relation: { to: 'Kid', many: true, via: 'exId', onDelete: 'cascade' } } },
            labels: { 'x-entity': { relation: { to: 'Label', many: true } } } } }, indexes: [{ name: 'by_tag', expression: LOWER }] },
          Kid: { schema: { type: 'object', properties: { id: ID, exId: { type: 'integer' } } } },
          Label: { schema: { type: 'object', properties: { id: ID } } } } };
      const expressions = { lower: { arity: 1, deterministic: true, apply: (/** @type {any} */ v) => (v === null ? null : String(v).toLowerCase()), sql: 'lower' } };
      await (await openStore(model, { driver: driver(), expressions })).close();
      /** @param {any} [options] */
      const drift = async (options = {}) => (await migrationStatus({ driver: driver() }, [], { model, ...options })).drift;
      assert.deepEqual([await drift(), await drift({ expressions })], [null, null]);
      // the tables read only with the functions depart; the one that references a skipped table is read without them
      await pool.query(`SET search_path TO "${schema}"; DROP INDEX "c_by_tag"; DROP INDEX "Ex_by_tag"; ALTER TABLE "Kid" ADD COLUMN extra integer`);
      const kid = "entity 'Kid': 5 columns exist, the model declares 4; undeclared: 'extra'";
      assert.deepEqual([await drift(), await drift({ expressions })],
        [kid, "collection 'c': 0 declared indexes exist, the model declares 1 — the model declares c_by_tag, which the database does not have"]);
      await pool.query(`SET search_path TO "${schema}"; DROP TABLE c`);
      assert.deepEqual([await drift(), await drift({ expressions })], [kid, "collection 'c': the table does not exist"]);
      // a collection beside the skipped one is read without them
      await pool.query(`SET search_path TO "${schema}"; DROP INDEX d_by_v`);
      assert.equal(await drift(), "collection 'd': 0 declared indexes exist, the model declares 1 — the model declares d_by_v, which the database does not have");
    }));

  it('reads the catalog once per pass: 8 times the tables send no more statements', { skip }, async () => {
    const { default: pg } = await import('pg');
    const { postgresDriver } = await import('@jarenjs/db/postgres');
    /** @param {number} n */
    const modelOf = (n) => ({ $model: '0.1',
      collections: Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i}`, { key: '/id',
        schema: { type: 'object', properties: { id: { type: 'string' }, v: { type: 'string' } } }, indexes: [{ name: 'by_v', path: '$.v' }] }])),
      entities: Object.fromEntries(Array.from({ length: n }, (_, i) => [`E${i}`, {
        schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, v: { type: 'string' } } },
        indexes: [{ name: 'by_v', path: '$.v' }] }])) });
    const pool = new pg.Pool({ connectionString: PG_URL, max: 2 });
    let statements = 0;
    const counting = { on: () => {}, options: pool.options, query: (/** @type {any[]} */ ...args) => { statements++; return pool.query(...args); },
      connect: async () => {
        const client = await pool.connect();
        return new Proxy(client, { get: (target, key) => (key === 'query'
          ? (/** @type {any[]} */ ...args) => { statements++; return target.query(...args); }
          : typeof target[key] === 'function' ? target[key].bind(target) : target[key]) });
      } };
    /** @type {number[]} */
    const counts = [];
    try {
      for (const n of [2, 16]) {
        const schema = `jaren_status_cost_${process.pid}_${n}`;
        await pool.query(`CREATE SCHEMA "${schema}"`);
        try {
          const model = modelOf(n);
          await (await openStore(model, { driver: postgresDriver(pool, { schema }) })).close();
          statements = 0;
          assert.equal((await migrationStatus({ driver: postgresDriver(counting, { schema }) }, [], { model })).drift, null);
          counts.push(statements);
        }
        finally { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
      }
    }
    finally { await pool.end(); }
    assert.ok(counts[1] - counts[0] <= 4, `status sent ${counts[0]} statements over 4 tables and ${counts[1]} over 32`);
  });
});

/** Each alteration on SQLite and the drift its CREATE text comparison names. */
const SQLITE_CASES = [
  ['a collection index dropped', 'DROP INDEX "items_by_end"', 'missing index:items_by_end'],
  ['an entity column added', 'ALTER TABLE "User" ADD COLUMN extra integer', 'table:User differs: have [CREATE TABLE "User"("age" INTEGER,'
    + '"doc" BLOB NOT NULL,"id" TEXT PRIMARY KEY,extra integer)STRICT], want [CREATE TABLE "User"("age" INTEGER,"doc" BLOB NOT NULL,"id" TEXT PRIMARY KEY)STRICT]'],
  ['an entity index dropped', 'DROP INDEX "User_by_age"', 'missing index:User_by_age'],
  ['an undeclared trigger', 'CREATE TRIGGER t_x BEFORE INSERT ON "User" BEGIN SELECT 1; END', 'unexpected trigger:t_x'],
  ['a join table dropped', 'DROP TABLE "Label_User"', 'missing index:Label_User_User_key'],
];

describe('SQLite status over the same alterations', () => {
  for (const [name, sql, drift] of SQLITE_CASES) {
    it(`names ${name}`, async () => {
      const { dbPath, cleanup } = tempDbPath();
      try {
        await (await openStore(MODEL, { driver: nodeDriver(), path: dbPath })).close();
        assert.equal((await migrationStatus({ driver: nodeDriver(), path: dbPath }, [], { model: MODEL })).drift, null);
        const raw = new DatabaseSync(dbPath);
        try { raw.exec(sql); }
        finally { raw.close(); }
        const status = await migrationStatus({ driver: nodeDriver(), path: dbPath }, [], { model: MODEL });
        assert.deepEqual([status.drift, status.upToDate], [drift, false]);
      }
      finally { cleanup(); }
    });
  }
});
