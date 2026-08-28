//@ts-check
/**
 * @file Regressions for the quirks a reading of the package found — each
 * one a concrete input that answered wrongly, quietly, and now answers
 * exactly: models the store cannot keep are refused where the model is
 * checked; a write does what its return value says; a versioned entity
 * created through the store can be saved; join tables are found by
 * their endpoints, never by splitting a name; a packed collection root
 * (`["$[*]"]`, how a linq chain spells its source) plans natively.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  openStore, normalizeEntities, explainMapping, planModelMigration, migrate,
  sqliteDialect, entityEmitModel,
} from '@jarenjs/db';
import { compileEmitModel } from '@jarenjs/emit';
import { nodeDriver } from '@jarenjs/db/node';
import { JarenValidator } from '@jarenjs/validate';
import { tempDbPath } from './helpers.js';

const ent = (props, required = ['id']) => ({
  schema: {
    type: 'object', required,
    properties: { id: { type: 'string', 'x-entity': { key: true } }, ...props },
  },
});
const model = (entities) => ({ $model: '0.1', entities });
const compileSchema = (schema) => {
  const validate = new JarenValidator({ collectErrors: true }).compile(schema);
  return (doc) => validate(doc);
};

describe('what the model accepts is what the store can keep', () => {
  it('a key, unique or index on a property with no column is JD0005 at normalize', () => {
    const cases = [
      ['key + column json', { id: { type: 'string', 'x-entity': { key: true, column: 'json' } } }],
      ['unique on a document member', { id: { type: 'string', 'x-entity': { key: true } }, secret: { type: 'string', 'x-entity': { column: 'json', unique: true } } }],
      ['index on an array', { id: { type: 'string', 'x-entity': { key: true } }, tags: { type: 'array', 'x-entity': { index: true } } }],
      ['key on a union', { id: { type: ['string', 'integer'], 'x-entity': { key: true } } }],
    ];
    for (const [name, properties] of cases) {
      assert.throws(() => normalizeEntities(model({ E: { schema: { type: 'object', properties } } })),
        (e) => e.code === 'JD0005' && /column/.test(e.message) && /^\/entities\/E\/schema\/properties\//.test(e.docPath),
        name);
    }
  });

  it('a union of scalar types lives in the document and round-trips a number as itself', async () => {
    const m = model({ E: ent({ v: { type: ['string', 'integer'] } }) });
    assert.deepStrictEqual(explainMapping(m).entities.E.document, ['v']);
    const store = await openStore(m, { driver: nodeDriver(), compileSchema });
    await store.entity('E').create({ id: 'a', v: 5 });
    await store.entity('E').create({ id: 'b', v: 'five' });
    assert.deepStrictEqual(await store.entity('E').get('a'), { id: 'a', v: 5 });
    assert.deepStrictEqual(await store.entity('E').get('b'), { id: 'b', v: 'five' });
    await store.close();
  });

  it("default: 'auto' off the key, a default on a relation member, and an uncompilable { query } are JD0005", () => {
    assert.throws(() => normalizeEntities(model({ E: ent({ n: { type: 'integer', 'x-entity': { default: 'auto' } } }) })),
      (e) => e.code === 'JD0005' && /auto/.test(e.message));
    assert.throws(() => normalizeEntities(model({
      E: ent({ tags: { 'x-entity': { relation: { to: 'T', many: true }, default: { value: [] } } } }), T: ent({}),
    })), (e) => e.code === 'JD0005' && /relation member takes no default/.test(e.message));
    assert.throws(() => normalizeEntities(model({ E: ent({ s: { type: 'string', 'x-entity': { default: { query: { $nonsense: ['$.id'] } } } } }) })),
      (e) => e.code === 'JD0005' && /does not compile/.test(e.message) && /JQ0002/.test(e.message)
        && e.docPath === '/entities/E/schema/properties/s/x-entity/default');
  });

  it('a nested x-entity block is JD0030 with its docPath, never ignored', () => {
    const m = model({ E: ent({ profile: { type: 'object', properties: { bio: { type: 'string', 'x-entity': { index: true } } } } }) });
    assert.throws(() => normalizeEntities(m),
      (e) => e.code === 'JD0030' && e.docPath === '/entities/E/schema/properties/profile/properties/bio/x-entity');
    // an allOf branch of a top-level property IS read
    const ok = model({ E: ent({ n: { allOf: [{ type: 'integer', 'x-entity': { index: true } }] } }) });
    assert.deepStrictEqual(explainMapping(ok).entities.E.indexes, [{ property: 'n', unique: false }]);
  });

  it('a self many-to-many and a foreign key into a composite-key entity are JD0005, not raw SQLite errors', () => {
    assert.throws(() => normalizeEntities(model({ E: ent({ friends: { 'x-entity': { relation: { to: 'E', many: true } } } }) })),
      (e) => e.code === 'JD0005' && /itself/.test(e.message));
    assert.throws(() => normalizeEntities(model({
      Grade: { schema: { type: 'object', properties: { student: { type: 'string', 'x-entity': { key: true } }, course: { type: 'string', 'x-entity': { key: true } } } } },
      Note: ent({ grade: { 'x-entity': { relation: { to: 'Grade', via: 'gradeId', onDelete: 'cascade' } } } }),
    })), (e) => e.code === 'JD0005' && /composite key/.test(e.message));
  });

  it("a nullable enum's CHECK rejects a non-member and accepts null", async () => {
    const m = model({ E: ent({ role: { type: ['string', 'null'], enum: ['admin', 'user', null] } }) });
    assert.deepStrictEqual(explainMapping(m).entities.E.columns.find((c) => c.name === 'role').check, ['admin', 'user']);
    const store = await openStore(m, { driver: nodeDriver() });
    await assert.rejects(store.entity('E').create({ id: 'x', role: 'emperor' }), (e) => e.code === 'JD2005');
    // the CHECK admits null (the enum's null member is left to the
    // column's nullability) — and the write returns what a read answers:
    // a column-mapped scalar null stores as SQL NULL and reads ABSENT (§9.3)
    assert.deepStrictEqual(await store.entity('E').create({ id: 'y', role: null }), { id: 'y' });
    assert.deepStrictEqual(await store.entity('E').get('y'), { id: 'y' });
    assert.deepStrictEqual(await store.entity('E').create({ id: 'z', role: 'admin' }), { id: 'z', role: 'admin' });
    assert.deepStrictEqual(await store.entity('E').get('z'), { id: 'z', role: 'admin' });
    await store.close();
  });

  it('an entity named like a fixed declaration is refused by the artifact builder', () => {
    for (const name of ['Entities', 'EntityMetaMap', 'DateTime']) {
      assert.throws(() => entityEmitModel(model({ [name]: ent({}) }), { compile: compileEmitModel }),
        (e) => e.code === 'JD0005' && e.docPath === `/entities/${name}`);
    }
    assert.throws(() => entityEmitModel(model({ User: ent({}), UserInput: ent({}) }), { compile: compileEmitModel }),
      (e) => e.code === 'JD0005');
  });

  it('a compileSchema hook that returns no function is refused at the entity handle, as it is for collections', async () => {
    const store = await openStore(model({ E: ent({}) }), { driver: nodeDriver(), compileSchema: () => 42 });
    assert.throws(() => store.entity('E'), /must return a validation function/);
    await store.close();
  });
});

describe('a write does what its return value says', () => {
  const VERSIONED = model({ User: ent({ name: { type: 'string' }, ver: { type: 'integer', 'x-entity': { version: true } } }) });

  it('a versioned entity created without a version reads back ver: 0 and can be saved (both twins)', async () => {
    const store = await openStore(VERSIONED, { driver: nodeDriver() });
    const made = await store.entity('User').create({ id: 'u9', name: 'a' });
    assert.deepStrictEqual(made, { id: 'u9', name: 'a', ver: 0 });
    assert.deepStrictEqual(await store.entity('User').get('u9'), { id: 'u9', name: 'a', ver: 0 });
    store.entity('User').put({ ...made, name: 'b' });
    const report = await store.saveChanges();
    assert.strictEqual(report.updated, 1);
    assert.deepStrictEqual(await store.entity('User').get('u9'), { id: 'u9', name: 'b', ver: 1 });
    // the synchronous twin, and add() + saveChanges()
    const added = store.sync.entity('User').add({ id: 'u10', name: 'x' });
    assert.strictEqual(added.ver, 0);
    assert.strictEqual(store.sync.saveChanges().inserted, 1);
    store.sync.entity('User').put({ ...store.sync.entity('User').get('u10'), name: 'y' });
    assert.strictEqual(store.sync.saveChanges().updated, 1);
    await store.close();
  });

  it('a write returns the document a read answers: a column-mapped scalar null is dropped, column: json keeps it', async () => {
    // §9.3: for a column-mapped scalar, JSON `null` and absence both
    // store as SQL NULL and read back ABSENT. The value a write RETURNS
    // said otherwise — it echoed the caller's `null`, so the returned
    // object named a member no read would ever show.
    const m = model({
      E: {
        schema: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { type: 'string', 'x-entity': { key: true } },
            s: { type: ['string', 'null'] },
            n: { type: ['integer', 'null'] },
            j: { type: ['string', 'null'], 'x-entity': { column: 'json' } },
            o: { type: 'object' },
          },
        },
      },
    });
    const store = await openStore(m, { driver: nodeDriver() });
    const set = store.entity('E');

    const made = await set.create({ id: 'a', s: null, n: null, j: null, o: null });
    assert.deepStrictEqual(made, { id: 'a', j: null, o: null },
      'create() returns what a read answers — the present-null opt-out survives');
    assert.deepStrictEqual(await set.get('a'), made);

    await set.create({ id: 'b', s: 'x', n: 1 });
    const next = await set.update('b', { s: null, n: null });
    assert.deepStrictEqual(next, { id: 'b' }, 'update() returns what a read answers');
    assert.deepStrictEqual(await set.get('b'), next);

    // the tracker's completion is the same source of truth
    const added = store.sync.entity('E').add({ id: 'c', s: null, j: null });
    assert.deepStrictEqual(added, { id: 'c', j: null });
    store.sync.saveChanges();
    assert.deepStrictEqual(store.sync.entity('E').get('c'), added);

    // false and 0 are values, not absences
    const kept = await set.create({ id: 'd', s: '', n: 0 });
    assert.deepStrictEqual(kept, { id: 'd', s: '', n: 0 });
    assert.deepStrictEqual(await set.get('d'), kept);
    await store.close();
  });

  it('update() refuses a relation member with the message create() gives, and never rewrites the key', async () => {
    const m = model({
      User: ent({ name: { type: 'string' }, labels: { 'x-entity': { relation: { to: 'Label', many: true } } } }),
      Label: { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', 'x-entity': { key: true } } } } },
    });
    const store = await openStore(m, { driver: nodeDriver() });
    await store.entity('Label').create({ name: 'admin' });
    await store.entity('User').create({ id: 'u1', name: 'ada' });
    await assert.rejects(store.entity('User').update('u1', { labels: ['admin'] }),
      (e) => e.code === 'JD2003' && /relation member/.test(e.message) && /update\(\)/.test(e.message));
    assert.deepStrictEqual((await store.entity('User').load({ include: { labels: true } }))[0].labels, []);
    await assert.rejects(store.entity('User').update('u1', { id: 'moved' }),
      (e) => e.code === 'JD2003' && /primary key/.test(e.message));
    assert.deepStrictEqual((await store.entity('User').load()).map((u) => u.id), ['u1']);
    assert.deepStrictEqual(await store.entity('User').update('u1', { id: 'u1', name: 'b' }), { id: 'u1', name: 'b' });
    await store.close();
  });

  it('create() attaches the many-to-many memberships its input type advertises, in one transaction', async () => {
    const m = model({
      User: ent({ name: { type: 'string' }, labels: { 'x-entity': { relation: { to: 'Label', many: true } } } }),
      Label: { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string', 'x-entity': { key: true } } } } },
    });
    const store = await openStore(m, { driver: nodeDriver() });
    await store.entity('Label').create({ name: 'admin' });
    const made = await store.entity('User').create({ id: 'u2', name: 'b', labels: ['admin'] });
    assert.deepStrictEqual(made, { id: 'u2', name: 'b', labels: ['admin'] });
    assert.deepStrictEqual((await store.entity('User').load({ include: { labels: true } }))[0].labels, [{ name: 'admin' }]);
    // the same membership on a later put changes nothing (two-run)
    store.entity('User').put({ ...made, labels: ['admin'] });
    const again = await store.saveChanges();
    assert.strictEqual(again.joinInserted + again.joinDeleted + again.updated, 0);
    // a membership on an unknown label fails as a whole: the user is not created either
    await assert.rejects(store.entity('User').create({ id: 'u3', name: 'c', labels: ['nope'] }), (e) => e.code === 'JD2005');
    assert.strictEqual(await store.entity('User').get('u3'), undefined);
    await store.close();
  });

  it('put then remove in one unit of work deletes the row and reports one delete, no update, no conflict', async () => {
    const store = await openStore(VERSIONED, { driver: nodeDriver() });
    await store.entity('User').create({ id: 'u3', name: 'c' });
    const u = await store.entity('User').get('u3');
    store.entity('User').put({ ...u, name: 'zzz' });
    store.entity('User').remove('u3');
    const report = await store.saveChanges();
    assert.strictEqual(report.deleted, 1);
    assert.strictEqual(report.updated, 0);
    assert.strictEqual(await store.entity('User').get('u3'), undefined);
    await store.close();
  });

  it("now/updated on a date property stamp YYYY-MM-DD, and pass the epoch column's contract", async () => {
    const m = model({ E: ent({ d: { type: 'string', format: 'date', 'x-entity': { default: 'now', column: 'integer' } } }) });
    const store = await openStore(m, { driver: nodeDriver() });
    const made = await store.entity('E').create({ id: 'a' });
    assert.match(made.d, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepStrictEqual(await store.entity('E').get('a'), made);
    await store.close();
  });

  it('a duplicate primary key is JD2001 on create(), as the error table says', async () => {
    const store = await openStore(model({ E: ent({}) }), { driver: nodeDriver() });
    await store.entity('E').create({ id: 'a' });
    await assert.rejects(store.entity('E').create({ id: 'a' }), (e) => e.code === 'JD2001' && e.key === 'a');
    await store.close();
  });
});

describe('join tables are found by their endpoints', () => {
  const withUnderscore = (item) => model({
    [item]: {
      ...(item === 'Thing' ? { 'x-rename': 'Item' } : {}),
      schema: {
        type: 'object', required: ['id'],
        properties: {
          id: { type: 'string', 'x-entity': { key: true } },
          tags: { 'x-entity': { relation: { to: 'Tag_Group', many: true } } },
        },
      },
    },
    Tag_Group: ent({}),
  });

  it('an entity rename keeps the memberships of a partner whose name carries an underscore', async () => {
    const { dbPath: path, cleanup } = tempDbPath();
    const store = await openStore(withUnderscore('Item'), { driver: nodeDriver(), path });
    await store.entity('Tag_Group').create({ id: 'g1' });
    await store.entity('Item').create({ id: 'i1', tags: ['g1'] });
    await store.close();
    const { migration, report } = planModelMigration(withUnderscore('Item'), withUnderscore('Thing'),
      { dialect: sqliteDialect, id: 'r' });
    assert.strictEqual(report.destructive, false);
    // the endpoint order flips (Item < Tag_Group, Tag_Group < Thing), so the
    // join table is rebuilt in the fresh build's column order, rows copied
    assert.deepStrictEqual(migration.steps.map((s) => s.kind), ['ddl', 'ddl', 'sql', 'ddl']);
    assert.match(migration.steps[2].sql, /^INSERT INTO "Tag_Group_Thing" \("Tag_Group_key", "Thing_key"\) SELECT "Tag_Group_key", "Item_key" FROM "Item_Tag_Group"$/);
    await migrate({ driver: nodeDriver(), path }, [migration], { baseline: withUnderscore('Item'), model: withUnderscore('Thing') });
    const renamed = await openStore(withUnderscore('Thing'), { driver: nodeDriver(), path });
    assert.deepStrictEqual((await renamed.entity('Thing').load({ include: { tags: true } }))[0].tags, [{ id: 'g1' }]);
    await renamed.close();
    cleanup();
  });

  it('a through-named join table records its rows under its own columns in journal capture', async () => {
    const m = model({
      User: ent({ labels: { 'x-entity': { relation: { to: 'Label', many: true, through: 'memberships' } } } }),
      Label: ent({}),
    });
    const store = await openStore(m, { driver: nodeDriver(), capture: { mode: 'journal' } });
    const seen = [];
    store.observe((record) => seen.push(...record.patch));
    await store.entity('Label').create({ id: 'admin' });
    await store.entity('User').create({ id: 'u1', labels: ['admin'] });
    const membership = seen.find((op) => op.path.startsWith('/memberships/'));
    assert.deepStrictEqual(membership, { op: 'add', path: '/memberships/["admin","u1"]', value: { Label_key: 'admin', User_key: 'u1' } });
    await store.entity('User').delete('u1');
    assert.ok(seen.some((op) => op.op === 'remove' && op.path.startsWith('/memberships/')), 'the cascade is recorded before the delete');
    await store.close();
  });
});

describe('a packed collection root plans natively', () => {
  it('["$[*]"] is the whole collection for the planner and the live classifier', async () => {
    const m = {
      $model: '0.1',
      collections: { users: { schema: { type: 'object', properties: { id: { type: 'string' }, age: { type: 'integer' } } }, key: '/id', indexes: [{ name: 'by_age', path: '$.age' }] } },
      entities: { User: ent({ age: { type: 'integer' } }) },
    };
    const store = await openStore(m, { driver: nodeDriver(), capture: true });
    const packed = { $for: { it: ['$[*]'] }, $where: { $ge: ['$it.age', 20] }, $return: '$it.id' };
    const bare = { $for: { it: '$[*]' }, $where: { $ge: ['$it.age', 20] }, $return: '$it.id' };
    const [packedHow, bareHow] = await Promise.all([store.collection('users').explain(packed), store.collection('users').explain(bare)]);
    assert.strictEqual(packedHow.mode, bareHow.mode);
    assert.deepStrictEqual(packedHow.indexes, ['users_by_age']);
    const entityDoc = { $for: { u: ['$.User[*]'] }, $where: { $ge: ['$u.age', 20] }, $return: '$u' };
    assert.strictEqual((await store.explain(entityDoc)).mode, (await store.explain({ ...entityDoc, $for: { u: '$.User[*]' } })).mode);
    const live = await store.collection('users').live({ $for: { it: ['$[*]'] }, $where: { $ge: ['$it.age', 20] }, $return: '$it' });
    assert.strictEqual(live.mode.strategy, 'rows');
    live.close();
    await store.close();
  });
});
