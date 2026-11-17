//@ts-check
/**
 * @file A model prepared once (`prepareModel`) opens many stores: each
 * answers as a store opened from the document itself, plain and prepared
 * stores live side by side, a store closes and reopens from the same
 * value, and no open changes the value. What a plain open refuses is
 * refused at preparation with the same error; a value this copy of the
 * package did not prepare is `JD0005`, and `expressions` that disagree
 * with the prepared ones are `JD0009`. On PostgreSQL too when
 * `JAREN_PG_URL` names an endpoint.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { inspect } from 'node:util';

import { openStore, prepareModel, normalizeModel, shapeHash } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import * as m from '@jarenjs/linq/model';

import { tempDbPath } from './helpers.js';
import { shiftModel } from './invariant-oracle.js';
import { ENGINES, skipFor, withStore } from './store-core-engines.js';

const LOWER = { lower: { arity: 1, deterministic: true,
  apply: (/** @type {any} */ value) => (value === null || value === undefined ? null : String(value).toLowerCase()),
  sql: 'lower' } };

/** Collections, entities with an integer key (the open marks key columns
 * per database) and an expression index. */
const modelOf = () => ({
  $model: '0.1',
  entities: m.defineModel({ entities: {
    Owner: m.object({ id: m.integer().key(), name: m.string() }),
  } }).entities,
  collections: {
    notes: { key: '/id', schema: { type: 'object', required: ['id'],
      properties: { id: { type: 'string' }, email: { type: 'string' }, rank: { type: 'integer' } } },
    indexes: [{ name: 'by_rank', path: ['$.rank'] },
      { name: 'by_lower_email', expression: { call: 'lower', args: [{ member: '$.email' }] } }] },
    tags: { identity: 'integer', schema: { type: 'object', properties: { label: { type: 'string' } } } },
  },
});

/** Write and read the same things on a store, and answer what it read. @param {any} store */
async function exercise(store) {
  const notes = store.collection('notes');
  await notes.put({ id: 'a', email: 'Ada@X', rank: 2 });
  await notes.put({ id: 'b', email: 'bob@x', rank: 1 });
  const tag = await store.collection('tags').insert({ label: 'one' });
  const owners = store.entity('Owner');
  owners.create({ id: 7, name: 'Ada' });
  await store.saveChanges();
  return {
    all: await notes.all(),
    ranked: await notes.execute({ $for: { n: '$[*]' }, $where: { $gt: ['$n.rank', 0] }, $orderby: '$n.rank', $return: '$n.id' }),
    tag,
    owner: await owners.asNoTracking().get(7),
    plan: (await notes.explain({ $for: { n: '$[*]' }, $where: { $eq: ['$n.rank', 2] }, $return: '$n.id' })).plan,
  };
}

/** Every plain object and array under `value` is frozen. @param {any} value @returns {boolean} */
function deepFrozen(value) {
  if (value === null || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value).every(deepFrozen);
}

describe('prepareModel', () => {
  it('opens N stores that answer as N plain opens', async () => {
    const prepared = prepareModel(modelOf(), { expressions: LOWER });
    for (let i = 0; i < 3; i++) {
      const plain = await openStore(modelOf(), { driver: nodeDriver(), expressions: LOWER });
      const fromPrepared = await openStore(prepared, { driver: nodeDriver() });
      try {
        assert.deepStrictEqual(await exercise(fromPrepared), await exercise(plain));
        assert.deepStrictEqual(fromPrepared.roots, plain.roots);
        assert.deepStrictEqual(await fromPrepared.introspect(), await plain.introspect());
      }
      finally { await plain.close(); await fromPrepared.close(); }
    }
  });

  it('keeps plain and prepared stores apart in one process, each with its own data', async () => {
    const prepared = prepareModel(modelOf(), { expressions: LOWER });
    const stores = [];
    for (let i = 0; i < 4; i++) {
      stores.push(await openStore(i % 2 === 0 ? prepared : modelOf(), { driver: nodeDriver(), expressions: LOWER }));
    }
    try {
      await Promise.all(stores.map((store, i) => store.collection('notes').put({ id: `n${i}`, rank: i })));
      for (const [i, store] of stores.entries()) {
        assert.deepStrictEqual(await store.collection('notes').all(), [{ id: `n${i}`, rank: i }]);
      }
    }
    finally { for (const store of stores) await store.close(); }
  });

  it('closes and reopens a file store from the same prepared value', async () => {
    const prepared = prepareModel(modelOf(), { expressions: LOWER });
    const { dbPath, cleanup } = tempDbPath();
    try {
      const first = await openStore(prepared, { driver: nodeDriver(), path: dbPath });
      await first.collection('notes').put({ id: 'kept', rank: 3 });
      first.entity('Owner').create({ id: 1, name: 'Ada' });
      await first.saveChanges();
      await first.close();
      const again = await openStore(prepared, { driver: nodeDriver(), path: dbPath });
      try {
        assert.deepStrictEqual(await again.collection('notes').get('kept'), { id: 'kept', rank: 3 });
        assert.deepStrictEqual(await again.entity('Owner').asNoTracking().get(1), { id: 1, name: 'Ada' });
      }
      finally { await again.close(); }
      // and a plain open of the same document reads the same database
      const plain = await openStore(modelOf(), { driver: nodeDriver(), path: dbPath, expressions: LOWER });
      try { assert.deepStrictEqual(await plain.collection('notes').get('kept'), { id: 'kept', rank: 3 }); }
      finally { await plain.close(); }
    }
    finally { cleanup(); }
  });

  it('is frozen, holds a copy of the document, and no open changes it', async () => {
    const document = modelOf();
    const prepared = prepareModel(document, { expressions: LOWER });
    assert.ok(Object.isFrozen(prepared));
    assert.deepStrictEqual(Object.keys(prepared), ['model']);
    assert.notStrictEqual(prepared.model, document);
    assert.deepStrictEqual(prepared.model, document);
    assert.ok(deepFrozen(prepared.model));
    // the shape a replicated store records is the document's
    assert.strictEqual(shapeHash(prepared.model), shapeHash(modelOf()));
    const before = inspect(prepared, { depth: Infinity, showHidden: true });
    // a change to the caller's document after preparation reaches no store
    document.collections.notes.indexes.length = 0;
    document.collections.extra = { key: '/id', schema: { type: 'object' } };
    for (let i = 0; i < 2; i++) {
      const store = await openStore(prepared, { driver: nodeDriver() });
      try {
        await exercise(store);
        assert.throws(() => store.collection('extra'), { code: 'JD2004' });
      }
      finally { await store.close(); }
    }
    assert.strictEqual(inspect(prepared, { depth: Infinity, showHidden: true }), before);
  });

  it('refuses at preparation what a plain open refuses, with the same error', async () => {
    const bad = [
      { $model: '0.2', collections: { a: { key: '/id', schema: { type: 'object' } } } },
      { $model: '0.1', collections: { 'a-b': { key: '/id', schema: { type: 'object' } } } },
      { $model: '0.1', collections: { a: { schema: { type: 'object' } } } },
      { $model: '0.1', collections: { a: { key: '/id', schema: { type: 'object' },
        indexes: [{ name: 'x', expression: { call: 'nope', args: [{ member: '$.id' }] } }] } } },
      { $model: '0.1', entities: {} },
      { $model: '0.1', entities: { A: { schema: { type: 'object', properties: { id: { type: 'string' } } } } } },
    ];
    for (const model of bad) {
      /** @type {any} */
      let opened;
      await assert.rejects(openStore(model, { driver: nodeDriver() }), (error) => { opened = error; return true; });
      assert.throws(() => prepareModel(model), (/** @type {any} */ error) => {
        assert.strictEqual(error.code, opened.code);
        assert.strictEqual(error.message, opened.message);
        assert.strictEqual(error.docPath, opened.docPath);
        return true;
      });
    }
  });

  it('refuses a value it did not prepare, and a prepared value prepared again (JD0005)', async () => {
    const prepared = prepareModel(modelOf(), { expressions: LOWER });
    // a hand-made copy of its one member is a model document with an unknown member
    await assert.rejects(openStore({ model: prepared.model }, { driver: nodeDriver() }), { code: 'JD0005' });
    // a value with the mark another copy of the package (or a hand) gave it
    const marked = Object.freeze({ model: prepared.model, [Symbol.for('@jarenjs/db prepared model')]: '0.1' });
    await assert.rejects(openStore(marked, { driver: nodeDriver() }),
      { code: 'JD0005', message: /not prepared by this copy of @jarenjs\/db/ });
    assert.throws(() => prepareModel(prepared), { code: 'JD0005', message: /prepared already/ });
    assert.throws(() => normalizeModel(prepared), { code: 'JD0005' });
  });

  it('holds its expressions: the ones the model calls the same or none at open, others refused (JD0009)', async () => {
    const prepared = prepareModel(modelOf(), { expressions: LOWER });
    const unused = { arity: 1, deterministic: true, apply: String, sql: 'upper' };
    for (const expressions of [undefined, LOWER, { ...LOWER }, { ...LOWER, upper: unused }]) {
      const store = await openStore(prepared, { driver: nodeDriver(), expressions });
      try {
        await store.collection('notes').put({ id: 'a', email: 'ADA@x' });
        assert.deepStrictEqual(await store.collection('notes').all(), [{ id: 'a', email: 'ADA@x' }]);
      }
      finally { await store.close(); }
    }
    // a declaration of `lower`, the function the model calls, other than the prepared one
    const other = { lower: { ...LOWER.lower, apply: (/** @type {any} */ value) => String(value) } };
    for (const expressions of [other, {}, { upper: unused }]) {
      await assert.rejects(openStore(prepared, { driver: nodeDriver(), expressions }),
        { code: 'JD0009', message: /declares a function the model calls \(lower\) otherwise than the expressions it was prepared with/ });
    }
    // a model that calls no function takes any expressions, as its plain open does
    const bare = prepareModel({ $model: '0.1', collections: { a: { key: '/id', schema: { type: 'object' } } } });
    for (const expressions of [{}, LOWER]) {
      const store = await openStore(bare, { driver: nodeDriver(), expressions });
      await store.close();
    }
    assert.throws(() => prepareModel(modelOf(), /** @type {any} */ ({ functions: {} })), { code: 'JD0009' });
    assert.throws(() => prepareModel(modelOf(), /** @type {any} */ ({ expressions: 'lower' })), { code: 'JD0009' });
  });

  for (const engine of ENGINES) {
    it(`${engine}: holds the expressions an entity index calls, which each open plans`, { skip: skipFor(engine) }, async () => {
      const model = shiftModel([{ name: 'lower_day', expression: { call: 'lower', args: [{ member: '$.day' }] } }]);
      // SQLite refuses an entity expression index (JD0004), PostgreSQL keeps it
      // the model it reads back, without the schema name each PostgreSQL store has of its own
      const answer = async (/** @type {any} */ store) =>
        JSON.parse(JSON.stringify(await store.introspect()).replaceAll(/jaren_store_core_\d+_\d+/g, 'schema'));
      const plain = await withStore(engine, model, answer, { expressions: LOWER }).catch((/** @type {any} */ error) => error.code);
      const prepared = prepareModel(model, { expressions: LOWER });
      assert.deepStrictEqual(await withStore(engine, prepared, answer).catch((/** @type {any} */ error) => error.code), plain);
      const other = { lower: { ...LOWER.lower, sql: 'upper' } };
      await assert.rejects(withStore(engine, prepared, answer, { expressions: other }), { code: 'JD0009' });
    });
  }

  for (const engine of ENGINES) {
    it(`${engine}: one prepared value opens on both engines and answers as the document does`, { skip: skipFor(engine) }, async () => {
      const prepared = prepareModel(modelOf(), { expressions: LOWER });
      const before = inspect(prepared, { depth: Infinity, showHidden: true });
      const plain = await withStore(engine, modelOf(), exercise, { expressions: LOWER });
      const fromPrepared = await withStore(engine, prepared, exercise);
      assert.deepStrictEqual(fromPrepared, plain);
      // and again on SQLite after the other engine marked its own copy
      if (engine === 'postgres') assert.deepStrictEqual(await withStore('sqlite', prepared, exercise),
        await withStore('sqlite', modelOf(), exercise, { expressions: LOWER }));
      assert.strictEqual(inspect(prepared, { depth: Infinity, showHidden: true }), before);
    });
  }
});
