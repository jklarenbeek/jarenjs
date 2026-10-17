//@ts-check
/**
 * @file Entity indexes: a composite, partial and unique index declared on an
 * entity with the collection's vocabulary and a bounded `where`, created by
 * the planner, enforced by SQLite for the store and for a raw SQL writer
 * alike, and verified on every open by its declared text; a collection index
 * honoring its `where`; the stored boolean spelling the index condition and
 * the enum CHECK share; the refusals, each at the member it names; and one
 * namespace for every object a model plans, compared with ASCII case folded.
 * The PostgreSQL half runs against a live server in
 * `postgres-entity-indexes.test.js`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { explainMapping, openStore, planCollection, planEntity, planInvariants, normalizeModel, sqliteDialect } from '@jarenjs/db';
import { postgresDialect } from '@jarenjs/db/postgres';
import { nodeDriver } from '@jarenjs/db/node';
import { kindKey } from './helpers.js';
import { ONE_ACTIVE, SHIFT_ROWS, SHIFT_SCHEMA, SHIFT_VERDICTS, createVerdicts, openRefusal, shiftModel, uniquenessAgreement,
  uniquenessModel } from './invariant-oracle.js';

const SHIFT = SHIFT_SCHEMA;
const SHIFT_INDEX_SQL = 'CREATE UNIQUE INDEX "Shift_one_active" ON "Shift" ("employeeId", "day") WHERE "status" IN (\'active\', \'pending\')';

/** A database file in a fresh directory, removed after `fn`. @template T @param {(path: string) => Promise<T>} fn */
async function withFile(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'jaren-entity-indexes-'));
  try { return await fn(join(dir, 'store.sqlite')); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Every schema object one SQLite file holds, by name. @param {string} path */
function schemaOf(path) {
  const db = new DatabaseSync(path);
  try { return db.prepare("SELECT type, name, tbl_name AS owner, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(); }
  finally { db.close(); }
}

/** Run raw SQL on a second connection to a file. @param {string} path @param {string} sql */
function rawExec(path, sql) {
  const db = new DatabaseSync(path);
  try { db.exec(sql); }
  finally { db.close(); }
}

describe('an entity index: composite, partial and unique (SQLite)', () => {
  it('refuses the second active row of an employee-day for the store and for a raw SQL writer, and accepts the cancelled and the status-less row', async () => {
    await withFile(async (path) => {
      const store = await openStore(shiftModel(), { driver: nodeDriver(), path });
      try {
        assert.deepEqual(await createVerdicts(store.entity('Shift'), SHIFT_ROWS), SHIFT_VERDICTS);
        // a writer beside the store meets the same index
        assert.throws(() => rawExec(path, 'INSERT INTO "Shift" ("id", "employeeId", "day", "status", "doc") VALUES (\'r1\', \'e1\', \'d1\', \'pending\', jsonb(\'{}\'))'),
          /UNIQUE constraint failed: Shift\.employeeId, Shift\.day/);
        rawExec(path, 'INSERT INTO "Shift" ("id", "employeeId", "day", "status", "doc") VALUES (\'r2\', \'e1\', \'d1\', \'cancelled\', jsonb(\'{}\'))');
      }
      finally { await store.close(); }
    });
  });

  it('is created as the declared partial unique index, which an equality-and-membership query seeks through', async () => {
    await withFile(async (path) => {
      await (await openStore(shiftModel(), { driver: nodeDriver(), path })).close();
      assert.equal(schemaOf(path).find((object) => object.name === 'Shift_one_active')?.sql, SHIFT_INDEX_SQL);
      const db = new DatabaseSync(path);
      try {
        const plan = db.prepare('EXPLAIN QUERY PLAN SELECT id FROM "Shift" WHERE "employeeId" = \'e1\' AND "day" = \'d1\' AND "status" IN (\'active\', \'pending\')')
          .all().map((row) => row.detail);
        assert.deepEqual(plan, ['SEARCH Shift USING INDEX Shift_one_active (employeeId=? AND day=?)']);
      }
      finally { db.close(); }
    });
  });

  it('is verified on every open: a changed predicate and a dropped index are drift', async () => {
    for (const [label, sql] of [
      ['a changed predicate', 'DROP INDEX "Shift_one_active"; CREATE UNIQUE INDEX "Shift_one_active" ON "Shift" ("employeeId", "day") WHERE "status" IN (\'active\')'],
      ['a dropped index', 'DROP INDEX "Shift_one_active"'],
    ]) {
      await withFile(async (path) => {
        await (await openStore(shiftModel(), { driver: nodeDriver(), path })).close();
        rawExec(path, sql);
        const error = await openRefusal(shiftModel(), { driver: nodeDriver(), path });
        assert.equal(error?.code, 'JD0002', `${label}: ${error?.message}`);
        assert.match(error.message, /Shift_one_active/, label);
      });
    }
  });

  it('reopens unchanged: a second open creates, alters and reports nothing', async () => {
    await withFile(async (path) => {
      await (await openStore(shiftModel(), { driver: nodeDriver(), path })).close();
      const first = schemaOf(path);
      await (await openStore(shiftModel(), { driver: nodeDriver(), path })).close();
      assert.deepEqual(schemaOf(path), first);
    });
  });
});

describe('the uniqueness oracle (SQLite)', () => {
  it('refuses exactly the rows the query engine places in the index beside an earlier one, for every condition', async () => {
    const store = await openStore(uniquenessModel, { driver: nodeDriver() });
    try {
      for (const { where, expected, actual, judged, stored } of await uniquenessAgreement(store)) {
        assert.deepEqual(actual, expected, JSON.stringify(where));
        assert.deepEqual(stored, judged, `the engine judged the records as stored: ${JSON.stringify(where)}`);
      }
    }
    finally { await store.close(); }
  });
});

describe('the mapping of an entity index', () => {
  it('leaves the per-property index entries alone and lists the index in entityIndexes', () => {
    const withIndex = explainMapping(shiftModel()).entities.Shift;
    assert.deepEqual(withIndex.indexes, explainMapping(shiftModel([])).entities.Shift.indexes);
    assert.deepEqual(withIndex.indexes, explainMapping({ $model: '0.1', entities: { Shift: { schema: SHIFT } } }).entities.Shift.indexes);
    assert.deepEqual(withIndex.entityIndexes, [{ name: 'one_active', columns: ['employeeId', 'day'], unique: true, where: ONE_ACTIVE.where }]);
    assert.equal(explainMapping({ $model: '0.1', entities: { Shift: { schema: SHIFT } } }).entities.Shift.entityIndexes, undefined);
  });

  it('never makes a member of a partial unique index a keyset column', async () => {
    const model = shiftModel([{ name: 'one_e', path: '$.employeeId', unique: true, where: { $eq: ['$.status', 'active'] } }]);
    const store = await openStore(model, { driver: nodeDriver() });
    try {
      await assert.rejects(() => store.entity('Shift').load({ orderBy: '$it.employeeId', take: 2, after: 'e1' }),
        (/** @type {any} */ error) => error.code === 'JD0032' && /keyset/.test(error.message));
    }
    finally { await store.close(); }
  });
});

/** `lower` over one member. @param {string} member */
const lowerOf = (member) => ({ call: 'lower', args: [{ member }] });
const LOWER_DAY = lowerOf('$.day');
/** The declaration a store is handed for `lower`. */
const LOWER = { lower: { arity: 1, deterministic: true, apply: (/** @type {any} */ value) => String(value).toLowerCase(), sql: 'lower' } };

/** An entity model whose `Shift` declares one more member and the given index. @param {any} index @param {any} [extra] */
const shiftWith = (index, extra = {}) => shiftModel([index], { ...SHIFT, properties: { ...SHIFT.properties, ...extra } });

describe('entity index refusals, each at its member', () => {
  const CASES = /** @type {[string, any, string, string, RegExp][]} */ ([
    ['a document member', shiftWith({ name: 'by_city', path: '$.profile.city' }, { profile: { type: 'object', properties: { city: { type: 'string' } } } }),
      'JD0004', '/entities/Shift/indexes/0/path', /'\$\.profile\.city'[\s\S]*map it as a column/],
    ['a top-level document member', shiftWith({ name: 'by_profile', path: '$.profile' }, { profile: { type: 'object' } }),
      'JD0004', '/entities/Shift/indexes/0/path', /'profile'[\s\S]*map it as a column/],
    ['derive, before an unknown member', shiftModel([{ name: 'cell', path: '$.day', derive: 'geohash', bogus: 1 }]),
      'JD0004', '/entities/Shift/indexes/0/derive', /'derive'[\s\S]*map it as a column/],
    ['physical', shiftModel([{ name: 'box', path: '$.day', physical: 'rtree' }]), 'JD0004', '/entities/Shift/indexes/0/physical', /'physical'/],
    ['a name a unique property takes', shiftWith({ name: 'employeeId', path: ['$.employeeId', '$.day'], unique: true },
      { employeeId: { type: 'string', 'x-entity': { unique: true } } }), 'JD0004', '/entities/Shift/indexes/0/name', /'Shift_employeeId'/],
    ['a name that differs from another only in case', shiftModel([{ name: 'byDay', path: '$.day' }, { name: 'byday', path: '$.employeeId' }]),
      'JD0004', '/entities/Shift/indexes/1/name', /'Shift_byday'[\s\S]*'Shift_byDay'[\s\S]*case/],
    ['a where with arithmetic', shiftModel([{ ...ONE_ACTIVE, where: { $le: [{ $add: ['$.day', 1] }, 5] } }]),
      'JD0004', '/entities/Shift/indexes/0/where', /an index condition reads plain columns, not arithmetic/],
    ['a where with a null literal', shiftModel([{ ...ONE_ACTIVE, where: { $eq: ['$.status', null] } }]),
      'JD0004', '/entities/Shift/indexes/0/where', /'status' reads SQL NULL as an absent member/],
    ['a where over an epoch member', shiftWith({ ...ONE_ACTIVE, where: { $gt: ['$.at', '2026-01-01T00:00:00Z'] } },
      { at: { type: 'string', format: 'date-time', 'x-entity': { column: 'integer' } } }), 'JD0004', '/entities/Shift/indexes/0/where', /'at'[\s\S]*epoch/],
    ['a where over a document member', shiftWith({ ...ONE_ACTIVE, where: { $eq: ['$.profile', 'x'] } }, { profile: { type: 'object' } }),
      'JD0004', '/entities/Shift/indexes/0/where', /'profile'[\s\S]*map it as a column/],
    ['a where that is always false', shiftModel([{ ...ONE_ACTIVE, where: { $eq: ['$.status', 3] } }]),
      'JD0004', '/entities/Shift/indexes/0/where', /always false/],
    ['a where that is always true', shiftModel([{ ...ONE_ACTIVE, where: { $or: [{ $and: [true] }] } }]),
      'JD0004', '/entities/Shift/indexes/0/where', /always true/],
    ['a where over a relation member', { $model: '0.1', entities: {
      User: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } } } } },
      Shift: { schema: { ...SHIFT, properties: { ...SHIFT.properties, user: { 'x-entity': { relation: { to: 'User', via: 'userId', onDelete: 'setNull' } } } } },
        indexes: [{ ...ONE_ACTIVE, where: { $eq: ['$.user', 'x'] } }] } } }, 'JD0004', '/entities/Shift/indexes/0/where', /'user' has no column on entity 'Shift'/],
    ['a where nested deeper than an open reads back', shiftModel([{ ...ONE_ACTIVE,
      where: Array.from({ length: 70 }).reduce((/** @type {any} */ inner) => ({ $not: inner }), { $eq: ['$.status', 'a'] }) }]),
    'JD0004', '/entities/Shift/indexes/0/where', /nests deeper than 64 levels/],
    ['a misspelt member', shiftModel([{ name: 'one_active', path: '$.day', uniqe: true }]),
      'JD0005', '/entities/Shift/indexes/0/uniqe', /unknown index member 'uniqe' — did you mean 'unique'\?/],
    ['a unique that is not a boolean', shiftModel([{ name: 'one_active', path: '$.day', unique: 'true' }]),
      'JD0005', '/entities/Shift/indexes/0/unique', /true or false/],
    ['an expression, on SQLite', shiftModel([{ name: 'lower_day', expression: LOWER_DAY }]),
      'JD0004', '/entities/Shift/indexes/0/expression', /index 'lower_day' over an expression reading '\$\.day' cannot be kept on sqlite: [\s\S]*only on a connection that registered it[\s\S]*raw SQL client[\s\S]*PostgreSQL/],
    ['an expression and a path', shiftModel([{ name: 'lower_day', path: '$.day', expression: LOWER_DAY }]),
      'JD0004', '/entities/Shift/indexes/0/expression', /a path OR an expression/],
    ['an expression that calls no function', shiftModel([{ name: 'lower_day', expression: { member: '$.day' } }]),
      'JD0004', '/entities/Shift/indexes/0/expression', /calls no function: a lone member is a path index/],
    ['an expression node of two kinds', shiftModel([{ name: 'lower_day', expression: { call: 'lower', args: [{ member: '$.day', value: 1 }] } }]),
      'JD0004', '/entities/Shift/indexes/0/expression/args/0', /exactly one of 'member', 'value', 'call', and this one names 2/],
    ['an expression over a nested member', shiftWith({ name: 'lower_city', expression: lowerOf('$.profile.city') },
      { profile: { type: 'object', properties: { city: { type: 'string' } } } }),
    'JD0004', '/entities/Shift/indexes/0/expression', /reads '\$\.profile\.city', which is not one member[\s\S]*map it as a column/],
    ['an expression over a document member', shiftWith({ name: 'lower_profile', expression: lowerOf('$.profile') }, { profile: { type: 'object' } }),
      'JD0004', '/entities/Shift/indexes/0/expression', /reads '\$\.profile', which the entity's document holds[\s\S]*map it as a column/],
    ['an expression over an integer member', shiftWith({ name: 'lower_n', expression: lowerOf('$.n') }, { n: { type: 'integer' } }),
      'JD0004', '/entities/Shift/indexes/0/expression', /reads '\$\.n', whose column holds an integer: an index expression on an entity reads string members/],
    ['an expression over a boolean member', shiftWith({ name: 'lower_flag', expression: lowerOf('$.flag') }, { flag: { type: 'boolean' } }),
      'JD0004', '/entities/Shift/indexes/0/expression', /reads '\$\.flag', whose column holds a boolean/],
    ['an expression over an epoch member', shiftWith({ name: 'lower_at', expression: lowerOf('$.at') },
      { at: { type: 'string', format: 'date-time', 'x-entity': { column: 'integer' } } }),
    'JD0004', '/entities/Shift/indexes/0/expression', /reads '\$\.at', whose column holds an epoch \(milliseconds\)/],
    ['an expression over a member no property names', shiftModel([{ name: 'lower_x', expression: lowerOf('$.x') }]),
      'JD0004', '/entities/Shift/indexes/0/expression', /reads '\$\.x', which names no property of entity 'Shift'/],
    ['an expression over a relation', { $model: '0.1', entities: {
      User: { schema: { type: 'object', properties: { id: { type: 'string', 'x-entity': { key: true } } } } },
      Shift: { schema: { ...SHIFT, properties: { ...SHIFT.properties, user: { 'x-entity': { relation: { to: 'User', via: 'userId', onDelete: 'setNull' } } } } },
        indexes: [{ name: 'lower_user', expression: lowerOf('$.user') }] } } },
    'JD0004', '/entities/Shift/indexes/0/expression', /reads '\$\.user', which names a relation/],
    ['indexes on a physical layout', { $model: '0.1', entities: { Shift: { schema: SHIFT, indexes: [ONE_ACTIVE], physical: { table: 'shift', columns: {
      id: { name: 'id', codec: 'text', null: 'reject' }, employeeId: { name: 'employee_id', codec: 'text', null: 'reject' },
      day: { name: 'day', codec: 'text', null: 'reject' }, status: { name: 'status', codec: 'text', null: 'absent' } } } } } },
    'JD0004', '/entities/Shift/indexes', /physical\.indexes/],
  ]);
  for (const [label, model, code, docPath, message] of CASES) {
    it(`${label}: ${code} at ${docPath}`, async () => {
      const error = await openRefusal(model, { driver: nodeDriver(), expressions: LOWER });
      assert.equal(error?.code, code, `${label}: ${error?.message}`);
      assert.equal(error.docPath, docPath, error.message);
      assert.match(error.message, message);
    });
  }

  it('an expression index keys no probe of a rule: its key is no member\'s value, on the one engine that plans it', () => {
    const model = { $model: '0.1', entities: {
      User: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'string', 'x-entity': { key: true } }, email: { type: 'string' } } },
        indexes: [{ name: 'by_lower_email', expression: lowerOf('$.email'), unique: true }] },
      Line: { schema: { type: 'object', required: ['id'], properties: { id: { type: 'integer', 'x-entity': { key: true } }, owner: { type: 'string' } } },
        physical: { table: 'lines', columns: { id: { name: 'id', codec: 'integer', null: 'reject' }, owner: { name: 'owner', codec: 'text', null: 'absent' } } },
        invariants: [{ name: 'owned', on: ['insert'], enforcement: 'database', assert: { '$exists-row': { entity: 'User', match: { email: '$.new.owner' } } } }] } } };
    assert.throws(() => planInvariants(model, { dialect: postgresDialect(), expressions: LOWER }), (/** @type {any} */ error) => error.code === 'JD0005'
      && /\$exists-row on 'User' is keyed by the unique index 'by_lower_email', which has an expression term/.test(error.message));
    // the plan takes the declarations as a store does
    const users = { $model: '0.1', entities: { User: model.entities.User } };
    assert.deepEqual(planInvariants(users, { dialect: postgresDialect(), expressions: LOWER }), []);
    assert.throws(() => planInvariants(users, { dialect: postgresDialect() }), (/** @type {any} */ error) => error.code === 'JD0004'
      && error.docPath === '/entities/User/indexes/0/expression/call');
    assert.throws(() => planInvariants(users, { dialect: sqliteDialect, expressions: LOWER }), (/** @type {any} */ error) => error.code === 'JD0004'
      && /cannot be kept on sqlite/.test(error.message));
  });

  it('a name PostgreSQL cannot hold whole is JD0004 at the member, for an entity and a collection index', () => {
    const dialect = postgresDialect();
    const long = shiftModel([{ name: 'n'.repeat(58), path: '$.day' }]);
    const mapping = explainMapping(long);
    assert.throws(() => planEntity('Shift', mapping.entities.Shift, mapping, dialect), (/** @type {any} */ error) =>
      error.code === 'JD0004' && error.docPath === '/entities/Shift/indexes/0/name' && error.message.includes(`'Shift_${'n'.repeat(58)}', 64 bytes`));
    // one byte shorter is a name the engine keeps
    const fits = explainMapping(shiftModel([{ name: 'n'.repeat(57), path: '$.day' }]));
    assert.ok(planEntity('Shift', fits.entities.Shift, fits, dialect).createSql.some((sql) => sql.includes(`"Shift_${'n'.repeat(57)}"`)));
    const collection = normalizeModel({ $model: '0.1', collections: { c: { schema: { type: 'object' }, key: '/id',
      indexes: [{ name: 'i'.repeat(62), path: '$.a' }] } } }).get('c');
    assert.throws(() => planCollection('c', collection, dialect), (/** @type {any} */ error) =>
      error.code === 'JD0004' && error.docPath === '/collections/c/indexes/0/name' && error.message.includes('64 bytes'));
  });
});

describe('the stored boolean: one spelling for an index condition and an enum CHECK', () => {
  const FLAGGED = { type: 'object', required: ['id', 'employeeId'], properties: {
    id: { type: 'string', 'x-entity': { key: true } }, employeeId: { type: 'string' }, flag: { type: 'boolean' } } };
  const flagged = { $model: '0.1', entities: { Flagged: { schema: FLAGGED,
    indexes: [{ name: 'one_flagged', path: '$.employeeId', unique: true, where: { $eq: ['$.flag', true] } }] } } };

  it('renders a boolean operand as the stored 1 on both dialects', () => {
    const mapping = explainMapping(flagged);
    for (const dialect of [sqliteDialect, postgresDialect()])
      assert.ok(planEntity('Flagged', mapping.entities.Flagged, mapping, dialect).createSql
        .includes('CREATE UNIQUE INDEX "Flagged_one_flagged" ON "Flagged" ("employeeId") WHERE "flag" = 1'), dialect.name);
  });

  it('enforces it on SQLite: one flagged row per employee, any number unflagged or without the flag', async () => {
    const store = await openStore(flagged, { driver: nodeDriver() });
    try {
      assert.deepEqual(await createVerdicts(store.entity('Flagged'), [{ id: 'a', employeeId: 'e', flag: true }, { id: 'b', employeeId: 'e', flag: true },
        { id: 'c', employeeId: 'e', flag: false }, { id: 'd', employeeId: 'e', flag: false }, { id: 'f', employeeId: 'e' }]),
      ['ok', 'JD2005/constraint', 'ok', 'ok', 'ok']);
    }
    finally { await store.close(); }
  });

  it('spells a boolean enum CHECK with the stored value on both dialects, and SQLite refuses a raw 0', async () => {
    const model = { $model: '0.1', entities: { E: { schema: { type: 'object', properties: {
      id: { type: 'string', 'x-entity': { key: true } }, flag: { type: 'boolean', enum: [true] } } } } } };
    const mapping = explainMapping(model);
    for (const dialect of [sqliteDialect, postgresDialect()])
      assert.match(planEntity('E', mapping.entities.E, mapping, dialect).createSql[0], /"flag" (?:INTEGER|smallint) CHECK \("flag" IN \(1\)\)/, dialect.name);
    await withFile(async (path) => {
      await (await openStore(model, { driver: nodeDriver(), path })).close();
      rawExec(path, 'INSERT INTO "E" ("id", "flag", "doc") VALUES (\'a\', 1, jsonb(\'{}\'))');
      assert.throws(() => rawExec(path, 'INSERT INTO "E" ("id", "flag", "doc") VALUES (\'b\', 0, jsonb(\'{}\'))'), /CHECK constraint failed/);
    });
  });
});

const COLLECTION_DOC = { type: 'object', properties: { id: { type: 'string' }, e: { type: 'string' }, s: { type: 'string' }, n: { type: ['string', 'null'] } } };
/** A collection with a partial unique index over `e` while `s` is active or pending. @param {any} [where] @param {any[]} [more] */
const collectionModel = (where = { $eq: ['$.s', { $seq: ['active', 'pending'] }] }, more = [{ name: 'by_s', path: '$.s' }]) => ({ $model: '0.1',
  collections: { c: { schema: COLLECTION_DOC, key: '/id', indexes: [{ name: 'one_active', path: '$.e', unique: true, where }, ...more] } } });

describe('a collection index with a where (SQLite)', () => {
  it('is partial: only rows inside the condition meet the unique index', async () => {
    await withFile(async (path) => {
      const store = await openStore(collectionModel(), { driver: nodeDriver(), path });
      const out = [];
      try {
        for (const doc of [{ id: '1', e: 'x', s: 'active' }, { id: '2', e: 'x', s: 'cancelled' }, { id: '3', e: 'x' }, { id: '4', e: 'x', s: 'pending' }]) {
          try { await store.collection('c').insert(doc); out.push('ok'); }
          catch (error) { out.push(`${/** @type {any} */ (error).code}/${/** @type {any} */ (error).class}`); }
        }
      }
      finally { await store.close(); }
      assert.deepEqual(out, ['ok', 'ok', 'ok', 'JD2005/constraint']);
      assert.equal(schemaOf(path).find((object) => object.name === 'c_one_active')?.sql,
        `CREATE UNIQUE INDEX "c_one_active" ON "c" ("gx_e", ${kindKey('e', 'TEXT')}) WHERE "gx_s" IN ('active', 'pending')`);
    });
  });

  it('reads only a member already mapped to a generated column of a non-nullable scalar type', async () => {
    for (const [label, model, reason] of [
      ['an unindexed member', collectionModel(undefined, []), /'s'[\s\S]*generated column/],
      ['a nullable member', collectionModel({ $eq: ['$.n', 'x'] }, [{ name: 'by_n', path: '$.n' }]), /'n'[\s\S]*null/],
      ['a nested member', collectionModel({ $eq: ['$.s.t', 'x'] }), /unsupported path '\$\.s\.t'/],
    ]) {
      const error = await openRefusal(model, { driver: nodeDriver() });
      assert.equal(error?.code, 'JD0004', `${label}: ${error?.message}`);
      assert.equal(error.docPath, '/collections/c/indexes/0/where', label);
      assert.match(error.message, reason, label);
    }
  });
});

describe('one namespace for every object a model plans', () => {
  const KEYED = { id: { type: 'string', 'x-entity': { key: true } } };
  const CASES = /** @type {[string, any, string, RegExp][]} */ ([
    ['two entities whose indexes meet in one name', { $model: '0.1', entities: {
      A_b: { schema: { type: 'object', properties: { ...KEYED, c: { type: 'string', 'x-entity': { unique: true } } } } },
      A: { schema: { type: 'object', properties: { ...KEYED, b_c: { type: 'string', 'x-entity': { unique: true } } } } } } },
    '/entities/A/schema/properties/b_c', /'A_b_c'/],
    ['an entity and a collection whose tables differ only in case', { $model: '0.1', collections: { a: { schema: { type: 'object' }, key: '/id' } },
      entities: { A: { schema: { type: 'object', properties: { ...KEYED } } } } }, '/entities/A', /'A'[\s\S]*'a'[\s\S]*case/],
    ['two collections whose indexes meet in one name', { $model: '0.1', collections: {
      a: { schema: { type: 'object', properties: { b_c: { type: 'string' } } }, key: '/id', indexes: [{ name: 'b_c', path: '$.b_c', unique: true }] },
      a_b: { schema: { type: 'object', properties: { c: { type: 'string' } } }, key: '/id', indexes: [{ name: 'c', path: '$.c', unique: true }] } } },
    '/collections/a_b/indexes/0/name', /'a_b_c'/],
    ['two indexes of one collection whose names differ only in case', { $model: '0.1', collections: { c: { schema: { type: 'object',
      properties: { a: { type: 'string' } } }, key: '/id', indexes: [{ name: 'byA', path: '$.a' }, { name: 'bya', path: '$.a', unique: true }] } } },
    '/collections/c/indexes/1/name', /'c_bya'[\s\S]*'c_byA'[\s\S]*case/],
  ]);
  for (const [label, model, docPath, message] of CASES) {
    it(`${label}: JD0004 at ${docPath}, before anything is created`, async () => {
      await withFile(async (path) => {
        const error = await openRefusal(model, { driver: nodeDriver(), path });
        assert.equal(error?.code, 'JD0004', `${label}: ${error?.message}`);
        assert.equal(error.docPath, docPath, error.message);
        assert.match(error.message, message);
        assert.deepEqual(schemaOf(path).filter((object) => !object.name.startsWith('_jaren')), [], 'nothing was created');
      });
    });
  }
});
