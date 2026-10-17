//@ts-check
/**
 * @file A unique index refuses a second document whose member the query
 * engine's `$eq` compares equal to the first one's, for every kind the
 * member's schema admits, on SQLite and PostgreSQL alike: an object or an
 * array is one key whatever order its members were written in, a number is
 * one key whatever its spelling, and `1`/`'1'`, `true`/`1`, `{}`/`[]` stay
 * two. PostgreSQL keys a container of a member whose column holds a scalar
 * by an index beside the declared one over the member read as `jsonb` at
 * that kind (`<index>$object`, `<index>$array`). SQLite's untyped column
 * holds a container as the bytes it was written in, so two triggers write
 * the container's key (its members in one order) into a plain column, which
 * a unique index beside the declared one keys (`<index>$container`). A
 * table an earlier release created opens and answers as it did, and
 * `planColumnUpgrade` adds what it lacks, refusing `JD0023` first where it
 * holds such duplicates. The index beside a unique index over a guarded
 * path follows a model that declares the container the other way.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  openStore, introspectModel, planCollection, planColumnUpgrade, planMigration, migrate, normalizeModel, sqliteDialect, compareShapeToModel,
} from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDialect } from '@jarenjs/db/postgres';

import { ENGINES, PG_URL, skipFor, withPostgres, withStore } from './store-core-engines.js';
import { tempDbPath } from './helpers.js';

/** @param {Record<string, any>} properties @param {any[]} indexes */
const modelOf = (properties, indexes) => ({ $model: '0.1', collections: { c: { key: '/id',
  schema: { type: 'object', properties: { id: { type: 'string' }, ...properties } }, indexes } } });
const UNIQUE_Q = [{ name: 'by_q', path: '$.q', unique: true }];
/** @param {any} model @param {any} dialect */
const planOf = (model, dialect) => planCollection('c', normalizeModel(model).get('c'), dialect);
/** Whether the member at `path` of the document holds a container. @param {string} doc @param {string} path */
const HOLDS = (doc, path) => `json_type(${doc}, '${path}') IN ('object', 'array')`;
/** The text SQLite keys the container at `path` by. @param {string} doc @param {string} path */
const KEY_TEXT = (doc, path) => `(SELECT group_concat(quote("t"."fullkey") || ' ' || (CASE WHEN "t"."type" IN ('integer', 'real') `
  + `THEN printf('%!.17g', CAST("t"."atom" AS REAL) + 0.0) WHEN "t"."type" = 'text' THEN quote("t"."atom") ELSE "t"."type" END), ',' ORDER BY "t"."fullkey") `
  + `FROM json_tree(${doc}, '${path}') AS "t")`;
/** The two triggers that write the key column `kx_<member>`. @param {string} member */
const TRIGGERS = (member) => {
  const path = `$."${member}"`;
  return [`CREATE TRIGGER "c$kx_${member}$insert" AFTER INSERT ON "c" WHEN ${HOLDS('NEW."doc"', path)} BEGIN `
    + `UPDATE "c" SET "kx_${member}" = ${KEY_TEXT('NEW."doc"', path)} WHERE "key" = NEW."key"; END`,
  `CREATE TRIGGER "c$kx_${member}$update" AFTER UPDATE OF "doc" ON "c" WHEN NEW."kx_${member}" IS NOT NULL OR ${HOLDS('NEW."doc"', path)} BEGIN `
    + `UPDATE "c" SET "kx_${member}" = (CASE WHEN ${HOLDS('NEW."doc"', path)} THEN ${KEY_TEXT('NEW."doc"', path)} END) WHERE "key" = NEW."key"; END`];
};
/** The statement that writes `kx_q` for every stored document. */
const FILL_Q = `UPDATE "c" SET "kx_q" = (CASE WHEN ${HOLDS('"doc"', '$."q"')} THEN ${KEY_TEXT('"doc"', '$."q"')} END) WHERE ${HOLDS('"doc"', '$."q"')}`;
/** @param {any} model @param {any} dialect */
const besides = (model, dialect) => planOf(model, dialect).createSql.filter((/** @type {string} */ sql) => /^CREATE (UNIQUE )?INDEX "[^"]*\$/.test(sql));

describe('the key a unique index holds for a container', () => {
  it('is, on SQLite, a plain column two triggers write and a unique index beside the declared one keys', () => {
    const plan = planOf(modelOf({ q: { type: ['string', 'object'] } }, UNIQUE_Q), sqliteDialect);
    assert.deepEqual(plan.createSql, [
      'CREATE TABLE "c" ("key" TEXT PRIMARY KEY, "doc" BLOB NOT NULL, "gx_q" ANY GENERATED ALWAYS AS (jsonb_extract("doc", \'$."q"\')) VIRTUAL, "kx_q" TEXT) STRICT',
      'CREATE UNIQUE INDEX "c_by_q" ON "c" ("gx_q", (json_type("doc", \'$."q"\') IN (\'true\', \'false\')))',
      'CREATE UNIQUE INDEX "c_by_q$container" ON "c" ("kx_q") WHERE "kx_q" IS NOT NULL',
      ...TRIGGERS('q'),
    ]);
    assert.deepEqual(plan.expected.columns.map((/** @type {any} */ column) => [column.name, column.type, column.generated]),
      [['key', 'TEXT', false], ['doc', 'BLOB', false], ['gx_q', 'ANY', true], ['kx_q', 'TEXT', false]]);
    // a composite over two untyped members: each combination keying one or both by its container key, the
    // others by their column and boolean key, under the declared condition
    const two = modelOf({ q: {}, r: { type: ['number', 'array'] }, k: { type: 'string' } },
      [{ name: 'by_k', path: '$.k' }, { name: 'by_qr', path: ['$.q', '$.r'], unique: true, where: { $eq: ['$.k', 'x'] } }]);
    const flag = (/** @type {string} */ member) => `(json_type("doc", '$."${member}"') IN ('true', 'false'))`;
    assert.deepEqual(besides(two, sqliteDialect), [
      `CREATE UNIQUE INDEX "c_by_qr$value$container" ON "c" ("gx_q", "kx_r", ${flag('q')}) WHERE ("gx_k" = 'x') AND "kx_r" IS NOT NULL`,
      `CREATE UNIQUE INDEX "c_by_qr$container$value" ON "c" ("kx_q", "gx_r", ${flag('r')}) WHERE ("gx_k" = 'x') AND "kx_q" IS NOT NULL`,
      'CREATE UNIQUE INDEX "c_by_qr$container$container" ON "c" ("kx_q", "kx_r") WHERE ("gx_k" = \'x\') AND "kx_q" IS NOT NULL AND "kx_r" IS NOT NULL',
    ]);
    assert.deepEqual(planOf(two, sqliteDialect).createSql.filter((/** @type {string} */ sql) => sql.startsWith('CREATE TRIGGER')), [...TRIGGERS('q'), ...TRIGGERS('r')]);
    // none beside a non-unique index, or over a typed column
    for (const model of [modelOf({ q: { type: ['string', 'object'] } }, [{ name: 'by_q', path: '$.q' }]), modelOf({ q: { type: 'string' } }, UNIQUE_Q)]) {
      const none = planOf(model, sqliteDialect);
      assert.deepEqual([none.containerKeys, besides(model, sqliteDialect), none.createSql.filter((/** @type {string} */ sql) => sql.startsWith('CREATE TRIGGER'))], [[], [], []]);
    }
  });

  it('is, on PostgreSQL, the member read as jsonb at each container kind its column does not hold', () => {
    const dialect = postgresDialect();
    const read = (/** @type {string} */ kind) => `(CASE WHEN jsonb_typeof(("doc" #> '{"q"}')) = '${kind}' THEN ("doc" #> '{"q"}') END)`;
    const text = `((CASE WHEN jsonb_typeof(("doc" #> '{"q"}')) = 'string' THEN "doc" #>> '{"q"}' END) COLLATE "C")`;
    assert.deepEqual(besides(modelOf({ q: { type: ['number', 'string', 'object', 'array'] } }, UNIQUE_Q), dialect), [
      `CREATE UNIQUE INDEX "c_by_q$text" ON "c" (${text})`,
      `CREATE UNIQUE INDEX "c_by_q$object" ON "c" (${read('object')})`,
      `CREATE UNIQUE INDEX "c_by_q$array" ON "c" (${read('array')})`,
    ]);
    assert.deepEqual(besides(modelOf({ q: { type: ['number', 'object'] }, k: { type: 'string' } }, [{ name: 'by_qk', path: ['$.q', '$.k'], unique: true }]), dialect),
      [`CREATE UNIQUE INDEX "c_by_qk$object" ON "c" (${read('object')}, "gx_k")`]);
    // a column that holds a container keeps every kind, and a non-unique index refuses nothing
    assert.deepEqual(besides(modelOf({ q: { type: ['object', 'string'] } }, UNIQUE_Q), dialect), [`CREATE UNIQUE INDEX "c_by_q$text" ON "c" (${text})`]);
    assert.deepEqual(besides(modelOf({ q: { type: ['number', 'object'] } }, [{ name: 'by_q', path: '$.q' }]), dialect), []);
    assert.deepEqual(planOf(modelOf({ q: { type: ['number', 'object'] } }, UNIQUE_Q), dialect).containerKeys, []);
  });
});

/** Each shape: its label, its members, the index path and where the member is written in a document. */
const SHAPES = /** @type {const} */ ([
  ['[string, object]', { q: { type: ['string', 'object'] } }, '$.q', 'q'],
  ['[string, array]', { q: { type: ['string', 'array'] } }, '$.q', 'q'],
  ['[number, string, boolean, object, array]', { q: { type: ['number', 'string', 'boolean', 'object', 'array'] } }, '$.q', 'q'],
  ['[object, string, null]', { q: { type: ['object', 'string', 'null'] } }, '$.q', 'q'],
  ['object', { q: { type: 'object' } }, '$.q', 'q'],
  ['array', { q: { type: 'array' } }, '$.q', 'q'],
  ['untyped', { q: {} }, '$.q', 'q'],
  ['composite [number, object] and k', { q: { type: ['number', 'object'] }, k: { type: 'string' } }, ['$.q', '$.k'], 'q'],
  ['conditional [string, object]', { q: { type: ['string', 'object'] }, k: { type: 'string' } }, '$.q', 'q'],
  ['guarded [number, object] at u[0]', { u: { items: { type: ['number', 'object'] } } }, '$.u[0]', 'u'],
]);
/** Pairs of values, the second written after the first. */
const PAIRS = [
  [{ a: 1, b: 2 }, { b: 2, a: 1 }], [{ a: 1 }, { a: 1 }], [{ a: 1 }, { a: true }], [{ a: '1' }, { a: 1 }], [{ a: 1 }, { a: 2 }],
  [[1, 2], [2, 1]], [[1, 2], [1, 2]], [{}, []], [{ x: { a: 1, b: [{ c: 1, d: 2 }] } }, { x: { b: [{ d: 2, c: 1 }], a: 1 } }],
  [[{ a: 1, b: 2 }], [{ b: 2, a: 1 }]], ['b', 'b'], [1, 1], [1, '1'], [true, true], [true, 1], [null, null],
];
/** @param {any} value @returns {string} */
const kindOf = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'object' ? 'object' : typeof value);

describe('a unique index refuses exactly what the query engine compares equal', () => {
  for (const engine of ENGINES) {
    it(`on ${engine}, for every kind each shape admits`, { skip: skipFor(engine) }, async () => {
      let pairs = 0;
      for (const [label, properties, path, at] of SHAPES) {
        const member = at === 'u' ? properties.u.items : properties.q;
        const types = member.type === undefined ? undefined : [member.type].flat();
        const conditional = label.startsWith('conditional');
        const model = modelOf(properties, [...conditional ? [{ name: 'by_k', path: '$.k' }] : [],
          { name: 'by_x', path, unique: true, ...conditional ? { where: { $eq: ['$.k', 'x'] } } : {} }]);
        /** @param {any} value @param {string} id */
        const doc = (value, id) => (at === 'u' ? { id, u: [value] } : { id, q: value, k: 'x' });
        for (const [first, second] of PAIRS) {
          if (types !== undefined && ![first, second].every((value) => types.includes(kindOf(value)) || (kindOf(value) === 'number' && types.includes('integer')))) continue;
          await withStore(engine, model, async (store) => {
            const docs = store.collection('c');
            await docs.insert(doc(first, '1'));
            const ids = [await docs.execute({ $for: { it: '$[*]' }, $where: { $eq: [at === 'u' ? '$it.u[0]' : '$it.q', second] }, $return: '$it.id' },
              { pushdown: false })].flat();
            // two nulls never meet, as a NULL key never meets another; PostgreSQL's jsonb column (a
            // container listed first, or no type) keys a JSON null as a value
            const jsonbNull = engine === 'postgres' && first === null && (types === undefined || types[0] === 'object');
            const refused = first === null ? jsonbNull : ids.includes('1');
            const answer = await docs.insert(doc(second, '2')).then(() => 'stored', (/** @type {any} */ error) => error.code);
            assert.equal(answer, refused ? 'JD2005' : 'stored', `${label}: ${JSON.stringify(first)} then ${JSON.stringify(second)}`);
            // and outside the condition nothing is refused
            if (conditional) assert.equal(await docs.insert({ ...doc(second, '3'), k: 'y' }).then(() => 'stored'), 'stored');
            pairs++;
          });
        }
      }
      assert.equal(pairs, 80);
    });
  }
});

describe('the container key on SQLite', () => {
  const MODEL = modelOf({ q: { type: ['string', 'number', 'object', 'array'] } }, UNIQUE_Q);

  it('is written by every writer and follows an update, and a duplicate is refused JD2005 as by the declared index', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath });
      try {
        const docs = store.collection('c');
        await docs.insert({ id: 'a', q: { x: 1, y: 2 } });
        await docs.insert({ id: 'b', q: 'z' });
        const refused = await docs.put({ id: 'b', q: { y: 2, x: 1 } }).then(() => null, (/** @type {any} */ error) => error);
        assert.deepEqual([refused.code, refused.class, refused.retryable, refused.collection, refused.key], ['JD2005', 'constraint', false, 'c', 'b']);
        assert.equal(await docs.insert({ id: 'a', q: { y: 2, x: 1 } }).then(() => 'stored', (/** @type {any} */ error) => error.code), 'JD2001');
        // a document that no longer holds the container frees its key
        await docs.put({ id: 'a', q: 7 });
        await docs.put({ id: 'b', q: { y: 2, x: 1 } });
        assert.deepEqual(await docs.get('b'), { id: 'b', q: { y: 2, x: 1 } });
      }
      finally { await store.close(); }
      // a writer of its own, which spells a number otherwise
      const raw = new DatabaseSync(dbPath);
      try {
        assert.throws(() => raw.prepare('INSERT INTO "c" ("key", "doc") VALUES (?, jsonb(?))').run('r', '{"id":"r","q":{"x":1.0,"y":2}}'),
          /UNIQUE constraint failed: c\.kx_q/);
        raw.prepare('INSERT INTO "c" ("key", "doc") VALUES (?, jsonb(?))').run('s', '{"id":"s","q":[1.0,{"b":2,"a":"1"}]}');
        assert.deepEqual(raw.prepare('SELECT "key", "kx_q" FROM "c" ORDER BY "key"').all().map((row) => [row.key, row.kx_q]), [
          ['a', null], ['b', `'$."q"' object,'$."q".x' 1.0,'$."q".y' 2.0`],
          ['s', `'$."q"' array,'$."q"[0]' 1.0,'$."q"[1]' object,'$."q"[1].a' '1','$."q"[1].b' 2.0`]]);
      }
      finally { raw.close(); }
    }
    finally { cleanup(); }
  });

  /** The table an earlier release created for MODEL: no key column, no trigger, no index beside. */
  const EARLIER = ['CREATE TABLE "c" ("key" TEXT PRIMARY KEY, "doc" BLOB NOT NULL, "gx_q" ANY GENERATED ALWAYS AS (jsonb_extract("doc", \'$."q"\')) VIRTUAL) STRICT',
    'CREATE UNIQUE INDEX "c_by_q" ON "c" ("gx_q", (json_type("doc", \'$."q"\') IN (\'true\', \'false\')))'];
  /** @param {string} file @param {any[]} docs */
  const seed = (file, docs) => {
    const raw = new DatabaseSync(file);
    try {
      for (const sql of EARLIER) raw.exec(sql);
      for (const doc of docs) raw.prepare('INSERT INTO "c" ("key", "doc") VALUES (?, jsonb(?))').run(doc.id, JSON.stringify(doc));
    }
    finally { raw.close(); }
  };
  /** @param {string} file @param {(connection: any) => any} fn */
  const connected = async (file, fn) => {
    const connection = await nodeDriver().open(file, {});
    try { return await fn(connection); }
    finally { await connection.close(); }
  };
  /** @param {string} file @param {any} model @param {any} doc */
  const insertInto = async (file, model, doc) => {
    const store = await openStore(model, { driver: nodeDriver(), path: file });
    try { return await store.collection('c').insert(doc).then(() => 'stored', (/** @type {any} */ error) => error.code); }
    finally { await store.close(); }
  };

  it('is absent from a table an earlier release created, which opens as it answered; the upgrade adds it, refusing JD0023 first over duplicates', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      seed(dbPath, [{ id: 'a', q: { x: 1, y: 2 } }, { id: 'b', q: { y: 2, x: 1 } }, { id: 'c', q: [{ p: 1, q: 2 }] }, { id: 'd', q: [{ q: 2, p: 1 }] }, { id: 'e', q: 'b' }]);
      assert.equal(await insertInto(dbPath, MODEL, { id: 'f', q: [{ q: 2, p: 1 }, 3] }), 'stored');
      assert.equal(await insertInto(dbPath, MODEL, { id: 'g', q: [{ p: 1, q: 2 }, 3] }), 'stored');
      assert.equal(await connected(dbPath, (connection) => compareShapeToModel(nodeDriver(), connection, MODEL, undefined, undefined)), null);
      const refused = await connected(dbPath, (connection) => { try { return planColumnUpgrade(connection, MODEL); } catch (error) { return error; } });
      assert.deepEqual([refused.code, refused.class, refused.retryable, refused.collection, refused.index, refused.duplicates],
        ['JD0023', 'constraint', false, 'c', 'by_q', [['c', 'd'], ['f', 'g'], ['a', 'b']]]);
      assert.equal(refused.message, 'JD0023: the unique index \'by_q\' of collection \'c\' refuses a duplicate of any kind its members hold, but the table holds '
        + 'documents that duplicate one another with a container whose members were written in another order, which an earlier release stored: '
        + '"c" and "d"; "f" and "g"; "a" and "b" — change or remove all but one of each, then plan the upgrade again');
      const store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath });
      try { for (const id of ['b', 'd', 'g']) await store.collection('c').delete(id); }
      finally { await store.close(); }
      const { migration, report } = await connected(dbPath, (connection) => planColumnUpgrade(connection, MODEL));
      assert.deepEqual(report.upgraded, ['c.kx_q', 'c.c_by_q$container']);
      assert.deepEqual(migration.steps.map((/** @type {any} */ step) => step.sql), ['ALTER TABLE "c" ADD COLUMN "kx_q" TEXT', ...TRIGGERS('q'), FILL_Q,
        'CREATE UNIQUE INDEX "c_by_q$container" ON "c" ("kx_q") WHERE "kx_q" IS NOT NULL']);
      assert.deepEqual((await migrate({ driver: nodeDriver(), path: dbPath }, [migration], { baseline: MODEL, model: MODEL })).applied, [migration.id]);
      assert.deepEqual((await connected(dbPath, (connection) => planColumnUpgrade(connection, MODEL))).migration.steps, []);
      assert.equal(await connected(dbPath, (connection) => compareShapeToModel(nodeDriver(), connection, MODEL, undefined, undefined)), null);
      assert.equal(await insertInto(dbPath, MODEL, { id: 'h', q: { y: 2, x: 1 } }), 'JD2005');
      assert.equal(await insertInto(dbPath, MODEL, { id: 'h', q: [3, { q: 2, p: 1 }] }), 'stored');
    }
    finally { cleanup(); }
  });

  it('leaves with its index by a rebuild, and comes with a new index over it by one, whether or not the table holds it', async () => {
    const LINKS = /** @type {const} */ ([
      ['no longer unique', modelOf({ q: { type: ['string', 'number', 'object', 'array'] } }, [{ name: 'by_q', path: '$.q' }]), 'stored'],
      ['another unique index over the member', modelOf({ q: { type: ['string', 'number', 'object', 'array'] }, k: { type: 'string' } },
        [...UNIQUE_Q, { name: 'by_qk', path: ['$.q', '$.k'], unique: true }]), 'JD2005'],
    ]);
    for (const [label, target, answer] of LINKS) {
      const migration = planMigration(MODEL, target, { dialect: sqliteDialect }).migration;
      assert.deepEqual(migration.steps.map((/** @type {any} */ step) => step.kind).filter((kind) => kind === 'ddl' || kind === 'rebuild'), ['rebuild'], label);
      for (const earlier of [false, true]) {
        const { dbPath, cleanup } = tempDbPath();
        try {
          if (earlier) seed(dbPath, [{ id: 'a', q: { x: 1, y: 2 } }, { id: 'b', q: 2 }]);
          else {
            const store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath });
            try { await store.collection('c').insert({ id: 'a', q: { x: 1, y: 2 } }); await store.collection('c').insert({ id: 'b', q: 2 }); }
            finally { await store.close(); }
          }
          const ddl = migration.steps.filter((/** @type {any} */ step) => step.kind === 'ddl' || step.kind === 'rebuild');
          assert.deepEqual((await migrate({ driver: nodeDriver(), path: dbPath }, [{ ...migration, steps: ddl }], { baseline: MODEL, model: target })).applied, [migration.id]);
          // the rebuilt table holds the key of every row it copied
          assert.equal(await insertInto(dbPath, target, { id: 'c', q: { y: 2, x: 1 } }), answer, `${label} (earlier: ${earlier})`);
          assert.equal(await connected(dbPath, (connection) => compareShapeToModel(nodeDriver(), connection, target, undefined, undefined)), null);
        }
        finally { cleanup(); }
      }
    }
  });

  it('follows a link that reads the member otherwise, keeping the index over the key or rebuilding where the key reads another member', async () => {
    /** @param {Record<string, any>} properties @param {any[]} indexes @param {any} from @param {any[]} pair */
    const after = async (properties, indexes, from, pair) => {
      const to = modelOf(properties, indexes);
      const migration = planMigration(from, to, { dialect: sqliteDialect }).migration;
      const { dbPath, cleanup } = tempDbPath();
      try {
        await (await openStore(from, { driver: nodeDriver(), path: dbPath })).close();
        await migrate({ driver: nodeDriver(), path: dbPath }, [{ ...migration, steps: migration.steps.filter((/** @type {any} */ step) => step.kind === 'ddl' || step.kind === 'rebuild') }],
          { baseline: from, model: to });
        const store = await openStore(to, { driver: nodeDriver(), path: dbPath });
        try {
          await store.collection('c').insert({ id: 'a', ...pair[0] });
          return [migration.steps.filter((/** @type {any} */ step) => step.kind === 'ddl' || step.kind === 'rebuild').map((/** @type {any} */ step) => step.sql ?? step.kind),
            await store.collection('c').insert({ id: 'b', ...pair[1] }).then(() => 'stored', (/** @type {any} */ error) => error.code)];
        }
        finally { await store.close(); }
      }
      finally { cleanup(); }
    };
    // the member's column is read anew (a union that lists a number first), the index over its key stays
    const [steps, answer] = await after({ q: { type: ['number', 'string', 'object'] } }, UNIQUE_Q, modelOf({ q: { type: ['string', 'object'] } }, UNIQUE_Q),
      [{ q: { x: 1, y: 2 } }, { q: { y: 2, x: 1 } }]);
    assert.deepEqual(steps.filter((/** @type {string} */ sql) => /kx_q|rebuild/.test(sql)), []);
    assert.equal(answer, 'JD2005');
    // the key column's name now stands for another member: its triggers read that one
    const swapped = await after({ a_b: {}, 'a.b': {} }, [{ name: 'by_p', path: '$.a_b' }, { name: 'by_u', path: "$['a.b']", unique: true }],
      modelOf({ a_b: {}, 'a.b': {} }, [{ name: 'by_p', path: "$['a.b']" }, { name: 'by_u', path: '$.a_b', unique: true }]),
      [{ 'a.b': { x: 1, y: 2 } }, { 'a.b': { y: 2, x: 1 } }]);
    assert.deepEqual(swapped, [['rebuild'], 'JD2005']);
  });

  it('counts a duplicate under the declared condition alone before the upgrade', async () => {
    const model = modelOf({ q: { type: ['string', 'object'] }, k: { type: 'string' } },
      [{ name: 'by_k', path: '$.k' }, { name: 'by_q', path: '$.q', unique: true, where: { $eq: ['$.k', 'x'] } }]);
    const { dbPath, cleanup } = tempDbPath();
    try {
      const raw = new DatabaseSync(dbPath);
      try {
        raw.exec('CREATE TABLE "c" ("key" TEXT PRIMARY KEY, "doc" BLOB NOT NULL, "gx_k" TEXT GENERATED ALWAYS AS (jsonb_extract("doc", \'$."k"\')) VIRTUAL, '
          + '"gx_q" ANY GENERATED ALWAYS AS (jsonb_extract("doc", \'$."q"\')) VIRTUAL) STRICT');
        raw.exec('CREATE INDEX "c_by_k" ON "c" ("gx_k")');
        raw.exec('CREATE UNIQUE INDEX "c_by_q" ON "c" ("gx_q", (json_type("doc", \'$."q"\') IN (\'true\', \'false\'))) WHERE "gx_k" = \'x\'');
        for (const doc of [{ id: 'a', q: { x: 1, y: 2 }, k: 'x' }, { id: 'b', q: { y: 2, x: 1 }, k: 'y' }, { id: 'c', q: { y: 2, x: 1 }, k: 'z' }])
          raw.prepare('INSERT INTO "c" ("key", "doc") VALUES (?, jsonb(?))').run(doc.id, JSON.stringify(doc));
      }
      finally { raw.close(); }
      // the documents outside the condition are not counted: the upgrade applies
      const { migration } = await connected(dbPath, (connection) => planColumnUpgrade(connection, model));
      await migrate({ driver: nodeDriver(), path: dbPath }, [migration], { baseline: model, model });
      assert.equal(await insertInto(dbPath, model, { id: 'd', q: { y: 2, x: 1 }, k: 'x' }), 'JD2005');
      assert.equal(await insertInto(dbPath, model, { id: 'd', q: { y: 2, x: 1 }, k: 'w' }), 'stored');
    }
    finally { cleanup(); }
  });

  it('follows a renamed collection', async () => {
    const renamed = { $model: '0.1', collections: { d: { ...MODEL.collections.c, 'x-rename': 'c' } } };
    const { dbPath, cleanup } = tempDbPath();
    try {
      seed(dbPath, [{ id: 'a', q: { x: 1, y: 2 } }]);
      const migration = planMigration(MODEL, renamed, { dialect: sqliteDialect }).migration;
      assert.deepEqual(migration.steps.map((/** @type {any} */ step) => step.kind).filter((kind) => kind === 'ddl' || kind === 'rebuild'), ['ddl', 'rebuild']);
      await migrate({ driver: nodeDriver(), path: dbPath }, [migration], { baseline: MODEL, model: renamed });
      const store = await openStore(renamed, { driver: nodeDriver(), path: dbPath });
      try {
        assert.equal(await store.collection('d').insert({ id: 'b', q: { y: 2, x: 1 } }).then(() => 'stored', (/** @type {any} */ error) => error.code), 'JD2005');
      }
      finally { await store.close(); }
    }
    finally { cleanup(); }
  });

  it('is read back as the unique index it serves, so the model read back plans the same table', async () => {
    const model = modelOf({ q: {}, r: { type: ['number', 'array'] }, k: { type: 'string' } },
      [{ name: 'by_q', path: '$.q', unique: true }, { name: 'by_rk', path: ['$.r', '$.k'], unique: true }]);
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(model, { driver: nodeDriver(), path: dbPath });
      await store.close();
      const { model: derived, report } = await connected(dbPath, (connection) => introspectModel(connection, { keys: { c: '/id' } }));
      assert.deepEqual(report.filter((/** @type {any} */ row) => /kx_|\$container|unmapped-object/.test(`${row.object} ${row.code}`)), []);
      assert.deepEqual(derived.collections.c.indexes, model.collections.c.indexes);
      for (const [from, to] of [[model, derived], [derived, model]]) {
        assert.deepEqual(planMigration(from, to, { dialect: sqliteDialect }).migration.steps
          .filter((/** @type {any} */ step) => step.kind === 'ddl' || step.kind === 'rebuild'), []);
      }
      const reopened = await openStore(derived, { driver: nodeDriver(), path: dbPath });
      try { await reopened.collection('c').insert({ id: 'a', q: { a: 1, b: 2 } }); }
      finally { await reopened.close(); }
      assert.equal(await insertInto(dbPath, model, { id: 'b', q: { b: 2, a: 1 } }), 'JD2005');
      // a trigger that writes it otherwise is not the store's
      const raw = new DatabaseSync(dbPath);
      try { raw.exec('DROP TRIGGER "c$kx_q$update"; CREATE TRIGGER "c$kx_q$update" AFTER UPDATE OF "doc" ON "c" BEGIN SELECT 1; END'); }
      finally { raw.close(); }
      const refused = await openStore(model, { driver: nodeDriver(), path: dbPath }).then(async (/** @type {any} */ opened) => { await opened.close(); return null; },
        (/** @type {any} */ error) => error);
      assert.equal(refused?.code, 'JD0002');
      assert.match(refused.message, /c\$kx_q\$update/);
      const again = await connected(dbPath, (connection) => introspectModel(connection, { keys: { c: '/id' } }));
      assert.deepEqual(again.report.filter((/** @type {any} */ row) => row.object.includes('kx_q')).map((/** @type {any} */ row) => [row.code, row.object]),
        [['unmapped-column', 'c.kx_q'], ['unmapped-object', 'c$kx_q$insert'], ['unmapped-object', 'c$kx_q$update']]);
    }
    finally { cleanup(); }
  });
});

describe('the container kinds of a unique index on PostgreSQL', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, () => {
  const MODEL = modelOf({ q: { type: ['number', 'string', 'object', 'array'] } }, UNIQUE_Q);
  const dialect = postgresDialect();
  /** The indexes an earlier release created for MODEL: none beside for a container kind. */
  const earlier = () => planOf(MODEL, dialect).createSql.filter((/** @type {string} */ sql) => !/"c_by_q\$(object|array)"/.test(sql));

  it('arrive with a link that gives a kept unique index\'s member a container kind', () => {
    const from = modelOf({ q: { type: ['number', 'string'] } }, UNIQUE_Q);
    const read = (/** @type {string} */ kind) => `(CASE WHEN jsonb_typeof(("doc" #> '{"q"}')) = '${kind}' THEN ("doc" #> '{"q"}') END)`;
    assert.deepEqual(planMigration(from, MODEL, { dialect }).migration.steps.filter((/** @type {any} */ step) => step.kind === 'ddl')
      .map((/** @type {any} */ step) => step.sql), [`CREATE UNIQUE INDEX "c_by_q$object" ON "c" (${read('object')})`,
      `CREATE UNIQUE INDEX "c_by_q$array" ON "c" (${read('array')})`]);
  });

  it('are absent from a table an earlier release created, which opens as it answered; the upgrade adds them, refusing JD0023 first over duplicates', async () => {
    await withPostgres(async (context) => {
      await context.pool.query(`SET search_path TO "${context.schema}"; ${earlier().join('; ')}`);
      let store = await openStore(MODEL, { driver: context.driver() });
      try {
        for (const [id, q] of [['a', { x: 1, y: 2 }], ['b', { y: 2, x: 1 }], ['c', [1, { p: 1, q: 2 }]], ['d', [1, { q: 2, p: 1 }]], ['e', 5]])
          await store.collection('c').insert({ id, q });
        assert.equal(await store.collection('c').insert({ id: 'f', q: 5 }).then(() => 'stored', (/** @type {any} */ error) => error.code), 'JD2005');
      }
      finally { await store.close(); }
      const connection = await context.driver().open();
      try {
        const refused = await planColumnUpgrade(connection, MODEL).then(() => null, (/** @type {any} */ error) => error);
        assert.deepEqual([refused.code, refused.class, refused.index, refused.duplicates], ['JD0023', 'constraint', 'by_q', [['a', 'b']]]);
        assert.match(refused.message, /at a kind the index's column did not key, which an earlier release stored: "a" and "b" — /);
      }
      finally { await connection.close(); }
      await context.pool.query(`SET search_path TO "${context.schema}"; DELETE FROM "c" WHERE "key" = 'b'`);
      const refusedArray = await (async () => {
        const opened = await context.driver().open();
        try { return await planColumnUpgrade(opened, MODEL).then(() => null, (/** @type {any} */ error) => error); }
        finally { await opened.close(); }
      })();
      assert.deepEqual(refusedArray.duplicates, [['c', 'd']]);
      await context.pool.query(`SET search_path TO "${context.schema}"; DELETE FROM "c" WHERE "key" = 'd'`);
      const opened = await context.driver().open();
      let migration;
      try {
        const upgrade = await planColumnUpgrade(opened, MODEL);
        assert.deepEqual(upgrade.report.upgraded, ['c.c_by_q$object', 'c.c_by_q$array']);
        migration = upgrade.migration;
      }
      finally { await opened.close(); }
      assert.deepEqual(migration.steps.map((/** @type {any} */ step) => step.sql), besides(MODEL, dialect).slice(1));
      await migrate({ driver: context.driver() }, [migration], { baseline: MODEL, model: MODEL, shadow: false });
      store = await openStore(MODEL, { driver: context.driver() });
      try {
        assert.equal(await store.collection('c').insert({ id: 'b', q: { y: 2, x: 1 } }).then(() => 'stored', (/** @type {any} */ error) => error.code), 'JD2005');
        assert.equal(await store.collection('c').insert({ id: 'd', q: [{ q: 2, p: 1 }, 1] }).then(() => 'stored', (/** @type {any} */ error) => error.code), 'stored');
        const { model: derived, report } = await store.introspect({ keys: { c: '/id' } });
        assert.deepEqual(report.filter((/** @type {any} */ row) => row.code === 'unmapped-index'), []);
        assert.deepEqual(derived.collections.c.schema.properties.q.type, ['number', 'string', 'object', 'array']);
        assert.deepEqual(planMigration(MODEL, derived, { dialect }).migration.steps.filter((/** @type {any} */ step) => step.kind === 'ddl'), []);
      }
      finally { await store.close(); }
      const after = await context.driver().open();
      try { assert.deepEqual((await planColumnUpgrade(after, MODEL)).migration.steps, []); }
      finally { await after.close(); }
    });
  });
});

describe('the indexes beside a unique index over a guarded path, when the model declares the container the other way', () => {
  const ITEMS = { type: ['number', 'string'] };
  const OPEN = modelOf({ u: { items: ITEMS } }, [{ name: 'by_u0', path: '$.u[0]', unique: true }]);
  const DECLARED = modelOf({ u: { type: 'array', items: ITEMS } }, [{ name: 'by_u0', path: '$.u[0]', unique: true }]);
  const dialect = postgresDialect();

  it('are planned again in the other read', () => {
    for (const [from, to] of [[OPEN, DECLARED], [DECLARED, OPEN]]) {
      const ddl = planMigration(from, to, { dialect }).migration.steps.filter((/** @type {any} */ step) => step.kind === 'ddl').map((/** @type {any} */ step) => step.sql);
      assert.deepEqual(ddl, ['DROP INDEX IF EXISTS "c_by_u0$text"', besides(to, dialect)[0]]);
      assert.notEqual(besides(from, dialect)[0], besides(to, dialect)[0]);
      assert.deepEqual(planMigration(to, to, { dialect }).migration.steps, []);
    }
  });

  it('let the store open after the link, and before it', { skip: !PG_URL && 'JAREN_PG_URL is not set' }, async () => {
    for (const [from, to] of [[OPEN, DECLARED], [DECLARED, OPEN]]) {
      // the table the from-model created opens under the other model as it is, as its column does
      await withPostgres(async (context) => {
        await (await openStore(from, { driver: context.driver() })).close();
        const store = await openStore(to, { driver: context.driver() });
        try {
          await store.collection('c').insert({ id: 'a', u: ['x'] });
          assert.equal(await store.collection('c').insert({ id: 'b', u: ['x'] }).then(() => 'stored', (/** @type {any} */ error) => error.code), 'JD2005');
        }
        finally { await store.close(); }
      });
      // and after the link it plans
      await withPostgres(async (context) => {
        const first = await openStore(from, { driver: context.driver() });
        try { await first.collection('c').insert({ id: 'a', u: ['x'] }); }
        finally { await first.close(); }
        const migration = planMigration(from, to, { dialect: postgresDialect({ schema: context.schema }) }).migration;
        const ddl = { ...migration, steps: migration.steps.filter((/** @type {any} */ step) => step.kind === 'ddl') };
        assert.deepEqual((await migrate({ driver: context.driver() }, [ddl], { baseline: from, model: to, shadow: false })).applied, [migration.id]);
        const store = await openStore(to, { driver: context.driver() });
        try {
          assert.equal(await store.collection('c').insert({ id: 'b', u: ['x'] }).then(() => 'stored', (/** @type {any} */ error) => error.code), 'JD2005');
          assert.equal(await store.collection('c').insert({ id: 'b', u: [7] }).then(() => 'stored'), 'stored');
        }
        finally { await store.close(); }
        // the table holds the column in one spelling and the index beside in the other: read back as the kind it is
        const connection = await context.driver().open();
        let derived, report;
        try { ({ model: derived, report } = await introspectModel(connection, { keys: { c: '/id' } })); }
        finally { await connection.close(); }
        assert.deepEqual(report.filter((/** @type {any} */ row) => row.code === 'unmapped-index'), []);
        assert.deepEqual(derived.collections.c.schema.properties.u.prefixItems, [ITEMS]);
        await (await openStore(derived, { driver: context.driver() })).close();
      });
    }
  });
});
