//@ts-check
/**
 * @file A `$exists-row` keyed by an index of the target that is not unique —
 * a physical layout's declared index, or the indexed member, foreign-key
 * column or entity index of a layout the store owns. At planning on both
 * dialects: where it plans, which index keys it, and what stays refused. On
 * SQLite and on a live PostgreSQL server (`JAREN_PG_URL`; skipped without it,
 * three connections at most): the store's and the database's enforcement
 * answering as a probe by the key does, a raw write refused by the rule's
 * name, the open verifying the index, the read going through it, and a
 * concurrent delete of the one row the probe finds.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { normalizeEntities, openStore, planInvariants, sqliteDialect } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDialect } from '@jarenjs/db/postgres';
import { column, createVerdicts, openRefusal, postgresEngine, sqliteEngine } from './invariant-oracle.js';
import { PG_URL, withPostgres } from './store-core-engines.js';

const skip = !PG_URL && 'JAREN_PG_URL is not set';
/** @param {string} name */
const col = (name) => ({ $sql: 'column', name });
const DIALECTS = /** @type {const} */ ([['sqlite', sqliteDialect], ['postgres', postgresDialect({ searchPath: 'tenant' })]]);
const ENGINES = /** @type {const} */ ([['sqlite', sqliteEngine, false], ['postgres', postgresEngine, skip]]);

/**
 * Documents with an owner, declared over an existing table, and lines that
 * name an owner: the probe matches `match` against the documents, whose
 * declared `indexes` decide what keys it.
 * @param {any[]} indexes @param {any} [match] @param {'database' | 'store'} [enforcement]
 */
const ownedModel = (indexes, match = { owner: '$.new.owner' }, enforcement = 'database') => ({ $model: '0.1', entities: {
  Doc: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, owner: { type: 'string' },
    status: { type: ['string', 'null'] }, title: { type: 'string' } } },
  physical: { table: 'docs', columns: { id: column('id'), owner: column('owner', 'text'), status: column('status', 'text', 'null'),
    title: column('title', 'text') }, indexes } },
  Line: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, owner: { type: 'string' } } },
    physical: { table: 'lines', columns: { id: column('id'), owner: column('owner', 'text') } },
    invariants: [{ name: 'owned', on: ['insert'], enforcement, assert: { '$exists-row': { entity: 'Doc', match } } }] },
} });
const BY_OWNER = { name: 'docs_owner', terms: [{ by: col('owner') }] };
const LOWER_TITLE = { $sql: 'call', name: 'lower', args: [col('title')] };
const OWNED_TABLES = {
  sqlite: 'CREATE TABLE docs(id INTEGER PRIMARY KEY, owner TEXT NOT NULL, status TEXT, title TEXT NOT NULL); CREATE INDEX docs_owner ON docs(owner); '
    + 'CREATE TABLE lines(id INTEGER PRIMARY KEY, owner TEXT NOT NULL)',
  postgres: 'CREATE TABLE docs(id integer PRIMARY KEY, owner text NOT NULL, status text, title text NOT NULL); CREATE INDEX docs_owner ON docs(owner); '
    + 'CREATE TABLE lines(id integer PRIMARY KEY, owner text NOT NULL)',
};

/**
 * Customers in a segment and their documents, and invoices, on layouts the
 * store owns. A document's segment must be one a customer is in — a probe of
 * `Customer` by its indexed member `segment`; an invoice's customer must
 * exist — by the key — and must have a document — by `Doc.customer`, the
 * column of the foreign key `Customer.docs` declares, whose index the store
 * plans.
 * @param {'database' | 'store'} enforcement
 */
const shopModel = (enforcement) => ({ $model: '0.1', entities: {
  Customer: { schema: { type: 'object', required: ['id', 'segment'], properties: { id: { type: 'integer', 'x-entity': { key: true } },
    segment: { type: 'string', 'x-entity': { index: true } },
    docs: { 'x-entity': { relation: { to: 'Doc', many: true, via: 'customer', onDelete: 'restrict' } } } } } },
  Doc: { schema: { type: 'object', required: ['id', 'customer', 'segment'], properties: { id: { type: 'integer', 'x-entity': { key: true } },
    customer: { type: 'integer' }, segment: { type: 'string' } } },
  invariants: [{ name: 'segment_served', on: ['insert'], enforcement, assert: { '$exists-row': { entity: 'Customer', match: { segment: '$.new.segment' } } } }] },
  Invoice: { schema: { type: 'object', required: ['id', 'customer'], properties: { id: { type: 'integer', 'x-entity': { key: true } },
    customer: { type: 'integer' } } },
  invariants: [
    { name: 'customer_exists', on: ['insert'], enforcement, assert: { '$exists-row': { entity: 'Customer', match: { id: '$.new.customer' } } } },
    { name: 'has_doc', on: ['insert'], enforcement, assert: { '$exists-row': { entity: 'Doc', match: { customer: '$.new.customer' } } } }] },
} });

/** @param {any} model @param {any} expected */
const refusedEverywhere = (model, expected) => {
  assert.throws(() => normalizeEntities(model), expected);
  for (const [, dialect] of DIALECTS) assert.throws(() => planInvariants(model, { dialect }), expected);
};
/** Each dialect's planned programs as one text, once the model check accepted the model. @param {any} model */
const plannedEverywhere = (model) => {
  normalizeEntities(model);
  return DIALECTS.map(([, dialect]) => planInvariants(model, { dialect }).map((item) => item.sql).join('\n'));
};
/**
 * A layout the store owns whose members each key a probe: `a` is unique, `b`
 * indexed, `c` the column of a one-to-one foreign key and `d` none; a rule on
 * lines probes it with `match`.
 * @param {any} match
 */
const memberModel = (match) => ({ $model: '0.1', entities: {
  Customer: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } } } } },
  Doc: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, a: { type: 'string', 'x-entity': { unique: true } },
    b: { type: 'string', 'x-entity': { index: true } }, c: { type: 'integer' }, d: { type: 'string' },
    customer: { 'x-entity': { relation: { to: 'Customer', via: 'c', onDelete: 'restrict' } } } } } },
  Line: { schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } }, a: { type: 'string' }, b: { type: 'string' },
    c: { type: 'integer' } } },
  invariants: [{ name: 'r', on: ['insert'], enforcement: 'database', assert: { '$exists-row': { entity: 'Doc', match } } }] },
} });
/**
 * The members a probe of `Line`'s one rule is keyed by — compared with `=` —
 * as each dialect's trigger and the store's own probe read them: the three agree.
 * @param {any} model
 */
const keyedBy = (model) => {
  const [sqlite, postgres] = plannedEverywhere(model).map((sql) => [...existsOf(sql, /EXISTS/).matchAll(/"_jaren_row"\."(\w+)" = /g)].map((m) => m[1]));
  const store = structuredClone(model);
  store.entities.Line.invariants[0].enforcement = 'store';
  const keys = /** @type {any} */ (normalizeEntities(store)).get('Line').invariants[0].probes[0].keys;
  assert.deepEqual(postgres, sqlite);
  assert.deepEqual([...keys].sort(), [...sqlite].sort());
  return sqlite;
};
/** The `EXISTS (…)` around the first match of `shape` in a program's text, its parentheses balanced.
 * @param {string} sql @param {RegExp} shape */
const existsOf = (sql, shape) => {
  const start = sql.lastIndexOf('EXISTS (', sql.search(shape));
  let depth = 0;
  for (let i = start + 'EXISTS '.length; i < sql.length; i++) {
    depth += sql[i] === '(' ? 1 : sql[i] === ')' ? -1 : 0;
    if (depth === 0) return sql.slice(start, i + 1);
  }
  throw new Error(`no EXISTS in ${sql}`);
};

describe('a probe keyed by an index that is not unique', () => {
  it('plans on both dialects, its indexed members compared with = and the others null-safely, under either enforcement', () => {
    for (const sql of plannedEverywhere(ownedModel([BY_OWNER]))) assert.match(sql, /WHERE "_jaren_row"\."owner" = NEW\."owner"\)/);
    for (const sql of plannedEverywhere(ownedModel([BY_OWNER], { owner: '$.new.owner', status: 'open' }))) {
      assert.match(sql, /"_jaren_row"\."owner" = NEW\."owner" AND NOT \(/);
      assert.doesNotMatch(sql, /"_jaren_row"\."status" = /);
    }
    assert.doesNotThrow(() => normalizeEntities(ownedModel([BY_OWNER], undefined, 'store')));
    // a layout the store owns: an indexed member and a foreign key's column
    const [sqlite, postgres] = plannedEverywhere(shopModel('database'));
    for (const sql of [sqlite, postgres]) {
      assert.match(sql, /FROM ("tenant"\.)?"Customer" AS "_jaren_row" WHERE "_jaren_row"\."segment" = NEW\."segment"\)/);
      assert.match(sql, /FROM ("tenant"\.)?"Doc" AS "_jaren_row" WHERE "_jaren_row"\."customer" = NEW\."customer"\)/);
      assert.match(sql, /FROM ("tenant"\.)?"Customer" AS "_jaren_row" WHERE "_jaren_row"\."id" = NEW\."customer"\)/);
    }
    assert.doesNotThrow(() => normalizeEntities(shopModel('store')));
  });

  it('is keyed by the key, then by a unique index, then by the first other index the match covers, alike for the trigger and the store', () => {
    const UNIQUE_OWNER = { name: 'docs_owner_unique', unique: true, terms: [{ by: col('owner') }] };
    const OWNER_STATUS = { name: 'docs_owner_status', terms: [{ by: col('owner') }, { by: col('status') }] };
    const both = (/** @type {any[]} */ indexes) => ownedModel(indexes, { owner: '$.new.owner', status: 'open' });
    // whichever is declared first, the unique index over the owner keys the probe: the status compares null-safely
    assert.deepEqual(keyedBy(both([OWNER_STATUS, UNIQUE_OWNER])), ['owner']);
    assert.deepEqual(keyedBy(both([UNIQUE_OWNER, OWNER_STATUS])), ['owner']);
    assert.deepEqual(keyedBy(both([BY_OWNER, OWNER_STATUS])), ['owner']);
    assert.deepEqual(keyedBy(both([OWNER_STATUS, BY_OWNER])), ['owner', 'status']);
    assert.deepEqual(keyedBy(ownedModel([BY_OWNER], { id: 1, owner: '$.new.owner' })), ['id']);
    // a layout the store owns: a unique member, then the column of a one-to-one foreign key, then an indexed member
    assert.deepEqual(keyedBy(memberModel({ a: '$.new.a', c: 7 })), ['a']);
    assert.deepEqual(keyedBy(memberModel({ b: 'x', c: '$.new.c' })), ['c']);
    assert.deepEqual(keyedBy(memberModel({ b: '$.new.b', d: 'x' })), ['b']);
  });

  it('is refused by a partial index and by one with an expression term, naming it, and a match no index covers is told what one must cover', () => {
    const where = { $sql: 'in', value: col('status'), values: [{ $sql: 'value', value: 'open' }], negate: false };
    const at = { code: 'JD0005', docPath: '/entities/Line/invariants/0/assert' };
    refusedEverywhere(ownedModel([{ ...BY_OWNER, where }]), { ...at, message: /keyed by the index 'docs_owner', which declares a condition: a partial index never keys a probe/ });
    refusedEverywhere(ownedModel([{ ...BY_OWNER, where }, { name: 'docs_owner_unique', unique: true, terms: [{ by: col('owner') }], where }]),
      { ...at, message: /keyed by the unique index 'docs_owner_unique', which declares a condition: a partial unique index never keys a probe/ });
    refusedEverywhere(ownedModel([{ ...BY_OWNER, terms: [{ by: col('owner') }, { by: LOWER_TITLE }] }]),
      { ...at, message: /keyed by the index 'docs_owner', which has an expression term/ });
    // no index; one over expressions alone, which names no member; one over a member the match leaves out
    for (const indexes of [[], [{ ...BY_OWNER, terms: [{ by: LOWER_TITLE }] }], [{ ...BY_OWNER, terms: [{ by: col('owner') }, { by: col('status') }] }]])
      refusedEverywhere(ownedModel(indexes), { ...at, message: new RegExp("^JD0005: \\$exists-row on 'Doc' must match its key member 'id', or every column "
        + "of an index its open verifies \\(one over plain column terms, without a condition\\): declare one over 'owner' at ") });
    refusedEverywhere(ownedModel([], { owner: '$.new.owner', status: 'open' }), { ...at, message: /declare one over 'owner', 'status', or over some of them at / });
    // a member the probe is keyed by matches a value, as a key does
    for (const match of [{ owner: null }, { owner: { $const: null } }])
      refusedEverywhere(ownedModel([BY_OWNER], match), { ...at, message: /'owner' is one the probe is keyed by, which matches a value, never null: a key holds no null and an index admits any number of them/ });
  });

  it('keeps every other boundary: a probe of the rule\'s own table, an aggregate, an effect on a layout the store owns', () => {
    const own = /** @type {any} */ (ownedModel([BY_OWNER], { owner: '$.new.owner' }));
    own.entities.Line.physical.indexes = [{ name: 'lines_owner', terms: [{ by: col('owner') }] }];
    own.entities.Line.invariants[0].assert = { '$exists-row': { entity: 'Line', match: { owner: '$.new.owner' } } };
    refusedEverywhere(own, { code: 'JD0005', message: /\$exists-row reads another table/ });
    const counted = /** @type {any} */ (ownedModel([BY_OWNER]));
    counted.entities.Line.invariants[0].assert = { $and: [counted.entities.Line.invariants[0].assert, { $lt: [{ $count: '$.Doc[*]' }, 5] }] };
    for (const [, dialect] of DIALECTS) assert.throws(() => planInvariants(counted, { dialect }), { code: 'JD0005', message: /only scalar literals and old\/new property paths/ });
    const bumped = /** @type {any} */ (shopModel('database'));
    bumped.entities.Doc.invariants[0] = { ...bumped.entities.Doc.invariants[0], on: ['update'], effects: [{ increment: 'customer' }] };
    refusedEverywhere(bumped, { code: 'JD0005', docPath: '/entities/Doc/invariants/0/effects', message: /increments no member/ });
  });

  for (const [name, engine, skipped] of ENGINES) {
    describe(`on ${name}`, { skip: skipped }, () => {
      for (const enforcement of /** @type {const} */ (['database', 'store'])) {
        it(`answers under ${enforcement} enforcement as the probe by the key does, and the open verifies the indexes`, async () => {
          const model = shopModel(enforcement);
          const fixture = await engine().fixture({ sqlite: '', postgres: '' });
          try {
            const options = { driver: fixture.target.driver };
            const store = await openStore(model, options);
            try {
              await store.entity('Customer').create({ id: 1, segment: 'retail' });
              await store.entity('Customer').create({ id: 2, segment: 'retail' });
              assert.deepEqual(await createVerdicts(store.entity('Doc'), [{ id: 1, customer: 1, segment: 'retail' }, { id: 2, customer: 1, segment: 'b2b' }]),
                ['ok', 'JD2096/constraint']);
              assert.deepEqual(await createVerdicts(store.entity('Invoice'), [{ id: 1, customer: 1 }, { id: 2, customer: 2 }, { id: 3, customer: 9 }]),
                ['ok', 'JD2096/constraint', 'JD2096/constraint']);
              // each refusal names its rule: the probe by an index as the probe by the key
              const named = enforcement === 'database' ? (/** @type {string} */ rule) => new RegExp(`jaren invariant:${rule}`)
                : (/** @type {string} */ rule) => new RegExp(`persistence invariant '${rule}' rejected the mutation`);
              await assert.rejects(store.entity('Doc').create({ id: 3, customer: 2, segment: 'b2b' }), { code: 'JD2096', message: named('segment_served') });
              await assert.rejects(store.entity('Invoice').create({ id: 4, customer: 2 }), { code: 'JD2096', message: named('has_doc') });
              await assert.rejects(store.entity('Invoice').create({ id: 5, customer: 9 }), { code: 'JD2096', message: named('customer_exists') });
            }
            finally { await store.close(); }
            const document = name === 'sqlite' ? "jsonb('{}')" : "'{}'";
            const raw = [[`INSERT INTO "Doc"(id, customer, segment, doc) VALUES (4, 2, 'b2b', ${document})`, 'segment_served'],
              [`INSERT INTO "Invoice"(id, customer, doc) VALUES (6, 2, ${document})`, 'has_doc'],
              [`INSERT INTO "Invoice"(id, customer, doc) VALUES (7, 9, ${document})`, 'customer_exists']];
            for (const [sql, rule] of raw) {
              if (enforcement === 'database') await assert.rejects(fixture.exec(sql), name === 'sqlite' ? new RegExp(`jaren invariant:${rule}`)
                : { code: '23J01', message: `jaren invariant:${rule}` });
              else await fixture.exec(sql);
            }
            for (const index of ['Customer_segment', 'Doc_customer']) {
              await fixture.exec(`DROP INDEX "${index}"`);
              assert.equal((await openRefusal(model, options))?.code, 'JD0002', index);
              await fixture.exec(`CREATE INDEX "${index}" ON "${index.split('_')[0]}" ("${index.split('_')[1]}")`);
            }
            assert.equal(await openRefusal(model, options), null);
          }
          finally { await fixture.dispose(); }
        });
      }

      it('reads a physical layout by its declared index, raw writes refused, and the open verifies the index', async () => {
        const fixture = await engine().fixture(OWNED_TABLES);
        try {
          const model = ownedModel([BY_OWNER]);
          for (const statement of planInvariants(model, { dialect: fixture.dialect })) await fixture.exec(statement.sql);
          const options = { driver: fixture.target.driver };
          const store = await openStore(model, options);
          try {
            await store.entity('Doc').create({ id: 1, owner: 'ann', status: null, title: 'a' });
            await store.entity('Doc').create({ id: 2, owner: 'ann', status: 'open', title: 'b' });
            assert.deepEqual(await createVerdicts(store.entity('Line'), [{ id: 1, owner: 'ann' }, { id: 2, owner: 'bob' }]), ['ok', 'JD2096/constraint']);
          }
          finally { await store.close(); }
          await assert.rejects(fixture.exec("INSERT INTO lines(id, owner) VALUES (3, 'bob')"), /jaren invariant:owned/);
          await fixture.exec("INSERT INTO lines(id, owner) VALUES (4, 'ann')");
          await fixture.exec('DROP INDEX docs_owner');
          assert.match((await openRefusal(model, options)).message, /index 'docs_owner' is missing/);
          await fixture.exec('CREATE UNIQUE INDEX docs_owner ON docs(id, owner)');
          assert.match((await openRefusal(model, options)).message, /index 'docs_owner' is unique/);
        }
        finally { await fixture.dispose(); }
      });

      it('reads the target through the index that keys the probe', async () => {
        const fixture = await engine().fixture({ sqlite: '', postgres: '' });
        try {
          const model = shopModel('database');
          const store = await openStore(model, { driver: fixture.target.driver });
          await store.close();
          const programs = planInvariants(model, { dialect: fixture.dialect }).map((item) => item.sql);
          const probes = [[/"segment" = NEW\."segment"/, 'Customer_segment', "'retail'"], [/"Doc" AS "_jaren_row" WHERE/, 'Doc_customer', '1']];
          for (const [shape, index, value] of probes) {
            const program = /** @type {string} */ (programs.find((sql) => /** @type {RegExp} */ (shape).test(sql)));
            const exists = existsOf(program, /** @type {RegExp} */ (shape)).replace(/NEW\."\w+"/, /** @type {string} */ (value));
            if (name === 'sqlite') {
              const plan = (await fixture.all(`EXPLAIN QUERY PLAN SELECT ${exists}`)).map((row) => row.detail).join('\n');
              assert.match(plan, new RegExp(`SEARCH _jaren_row USING (COVERING )?INDEX ${index} `), plan);
            }
            else {
              await fixture.exec('SET enable_seqscan = off');
              const plan = (await fixture.all(`EXPLAIN SELECT ${exists}`)).map((row) => row['QUERY PLAN']).join('\n');
              assert.match(plan, new RegExp(`Index (Only )?Scan using "?${index}"?`), plan);
            }
          }
        }
        finally { await fixture.dispose(); }
      });
    });
  }
});

/**
 * Parents in a group, and two kinds of children: one probes its parent by the
 * key, the other a parent of its group by the group's index.
 */
const raceModel = { $model: '0.1', entities: {
  Parent: { schema: { type: 'object', required: ['id', 'grp'], properties: { id: { type: 'integer', 'x-entity': { key: true } },
    grp: { type: 'integer', 'x-entity': { index: true } } } } },
  ByKey: { schema: { type: 'object', required: ['id', 'ref'], properties: { id: { type: 'integer', 'x-entity': { key: true } }, ref: { type: 'integer' } } },
    invariants: [{ name: 'by_key', on: ['insert'], enforcement: 'database', assert: { '$exists-row': { entity: 'Parent', match: { id: '$.new.ref' } } } }] },
  ByGroup: { schema: { type: 'object', required: ['id', 'ref'], properties: { id: { type: 'integer', 'x-entity': { key: true } }, ref: { type: 'integer' } } },
    invariants: [{ name: 'by_group', on: ['insert'], enforcement: 'database', assert: { '$exists-row': { entity: 'Parent', match: { grp: '$.new.ref' } } } }] },
} };

describe('a concurrent delete of the one row a probe finds', () => {
  it('on SQLite meets the writer lock, so the probing write commits only while the row exists, by the key and by an index alike', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaren-index-probes-'));
    const path = join(dir, 'race.sqlite');
    try {
      await (await openStore(raceModel, { driver: nodeDriver(), path })).close();
      const a = new DatabaseSync(path), b = new DatabaseSync(path);
      try {
        for (const db of [a, b]) db.exec('PRAGMA busy_timeout = 0');
        /** @param {() => unknown} run */
        const outcome = (run) => { try { run(); return 'ok'; } catch (error) { return /jaren invariant:\w+|database is locked/.exec(String(error))?.[0] ?? String(error); } };
        const runs = {};
        for (const table of ['ByKey', 'ByGroup']) {
          const reset = () => b.exec(`DELETE FROM "${table}"; DELETE FROM "Parent"; INSERT INTO "Parent"(id, grp, doc) VALUES (1, 1, jsonb('{}'))`);
          const insert = () => a.exec(`INSERT INTO "${table}"(id, ref, doc) VALUES (1, 1, jsonb('{}'))`);
          const remove = () => b.exec('DELETE FROM "Parent" WHERE id = 1');
          reset();
          a.exec('BEGIN IMMEDIATE');
          const insertFirst = [outcome(insert), outcome(remove), outcome(() => a.exec('COMMIT'))];
          reset();
          b.exec('BEGIN IMMEDIATE');
          const deleteFirst = [outcome(remove), outcome(insert), outcome(() => b.exec('COMMIT')), outcome(insert)];
          runs[table] = { insertFirst, deleteFirst };
        }
        assert.deepEqual(runs.ByKey, { insertFirst: ['ok', 'database is locked', 'ok'], deleteFirst: ['ok', 'database is locked', 'ok', 'jaren invariant:by_key'] });
        assert.deepEqual(runs.ByGroup, { insertFirst: ['ok', 'database is locked', 'ok'], deleteFirst: ['ok', 'database is locked', 'ok', 'jaren invariant:by_group'] });
      }
      finally { a.close(); b.close(); }
    }
    finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('on PostgreSQL is answered by a probe by an index as by a probe by the key, in either order of the two writes', { skip }, async () => {
    await withPostgres(async ({ pool, schema, driver }) => {
      await (await openStore(raceModel, { driver: driver() })).close();
      // two sessions of their own, the store's released: a statement waits for a lock two seconds at most
      const a = await pool.connect(), b = await pool.connect();
      try {
        for (const session of [a, b]) await session.query(`SET search_path TO "${schema}"; SET lock_timeout = '2s'`);
        /** @param {Promise<unknown>} run */
        const outcome = (run) => run.then(() => 'ok', (error) => (error.code === '23J01' ? 'refused' : error.code));
        const counts = async (/** @type {string} */ table) => (await a.query(
          `SELECT (SELECT count(*) FROM "${table}")::int AS children, (SELECT count(*) FROM "Parent")::int AS parents`)).rows[0];
        const runs = {};
        for (const table of ['ByKey', 'ByGroup']) {
          const reset = () => a.query(`TRUNCATE "${table}", "Parent"; INSERT INTO "Parent"(id, grp, doc) VALUES (1, 1, '{}')`);
          const insert = () => outcome(a.query(`INSERT INTO "${table}"(id, ref, doc) VALUES (1, 1, '{}')`));
          const remove = () => outcome(b.query('DELETE FROM "Parent" WHERE id = 1'));
          await reset();
          await a.query('BEGIN'); await b.query('BEGIN');
          const insertFirst = [await insert(), await remove(), await outcome(b.query('COMMIT')), await outcome(a.query('COMMIT')), await counts(table)];
          await reset();
          await b.query('BEGIN'); await a.query('BEGIN');
          const deleteFirst = [await remove(), await insert(), await outcome(b.query('COMMIT')), await outcome(a.query('COMMIT')), await counts(table)];
          runs[table] = { insertFirst, deleteFirst };
        }
        assert.equal(runs.ByKey.insertFirst[0], 'ok');
        assert.deepEqual(runs.ByGroup, runs.ByKey);
      }
      finally { a.release(); b.release(); }
    });
  });
});
