//@ts-check
/**
 * @file The model pen, over its corpus: every model emits its
 * hand-written `$model` document byte-equal (the fixture model first —
 * the pen writes what the hand wrote), validates against the published
 * grammar, normalizes through the store's own model walk, opens under
 * the node driver and round-trips a write through the defaults the pen
 * declared, and hashes equal across two emissions. Beside the corpus:
 * the pen's refusals by code, and that nothing under `src/model/`
 * imports `@jarenjs/db` — the store is a TEST dependency here.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';

import * as m from '@jarenjs/linq/model';
import * as s from '@jarenjs/linq/schema';
import { LinqBuildError } from '@jarenjs/linq';
import {
  openStore, normalizeModel, normalizeEntities, explainMapping, shapeHash, DbCompileError,
} from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

import { compileArtifact } from '../json/schema-artifact-helpers.js';
import { CORPUS, User, Post, fixtureModel } from './model-corpus.js';

const grammar = compileArtifact(JSON.parse(
  fs.readFileSync('packages/db/schemas/jaren-model.schema.json', 'utf8')));

describe('the model pen — every corpus model, five ways', () => {
  for (const entry of CORPUS) {
    describe(entry.name, () => {
      it('emits the hand-written document byte-equal, deep-frozen', () => {
        assert.deepStrictEqual(entry.model, entry.document);
        assert.strictEqual(Object.isFrozen(entry.model), true);
        assert.deepStrictEqual(JSON.parse(JSON.stringify(entry.model)), entry.document);
      });

      it('validates against jaren-model.schema.json', () => {
        assert.strictEqual(grammar(entry.model), true);
      });

      it("normalizes through the store's own model walk", () => {
        assert.doesNotThrow(() => normalizeModel(entry.model));
        const entities = normalizeEntities(entry.model);
        if (entities.size > 0) assert.doesNotThrow(() => explainMapping(entry.model));
      });

      it('opens under the node driver and round-trips a write through its defaults', async () => {
        const store = await openStore(entry.model, { driver: nodeDriver() });
        try {
          const { created, stored, checks } = await entry.roundTrip(store);
          assert.deepStrictEqual(stored, created, 'the value the application sees IS the value stored');
          for (const [ok, what] of checks) assert.strictEqual(ok, true, what);
        }
        finally {
          await store.close();
        }
      });

      it('hashes equal across two emissions', () => {
        const again = JSON.parse(JSON.stringify(entry.model));
        assert.strictEqual(shapeHash(entry.model), shapeHash(again));
        assert.strictEqual(JSON.stringify(entry.model), JSON.stringify(again));
      });
    });
  }

  it('two builds of the fixture are one document, and one string', () => {
    const twice = m.defineModel({ entities: { User, Post, Label: m.object({ name: m.string().key() }).open(), Grade: m.object({ student: m.string().key(), course: m.string().key(), score: m.integer().optional() }).open() } });
    assert.deepStrictEqual(twice, fixtureModel);
    assert.strictEqual(JSON.stringify(twice), JSON.stringify(fixtureModel));
    assert.strictEqual(shapeHash(twice), shapeHash(fixtureModel));
  });
});

describe('the model pen — the vocabulary, member by member', () => {
  it('every x-entity method writes its member, in the order first set', () => {
    const b = m.string().unique().index().version().identity('uuid');
    assert.deepStrictEqual(b.schema, {
      type: 'string', 'x-entity': { unique: true, index: true, version: true, key: true, default: 'uuid' },
    });
    assert.deepStrictEqual(m.integer().identity('auto').schema['x-entity'], { key: true, default: 'auto' });
    // the schema pen's uuid() is the FORMAT shortcut, on the model pen too
    assert.deepStrictEqual(m.string().uuid().identity('uuid').schema,
      { type: 'string', format: 'uuid', 'x-entity': { key: true, default: 'uuid' } });
    assert.deepStrictEqual(m.datetime().now().schema['x-entity'], { default: 'now' });
    assert.deepStrictEqual(m.datetime().updated().column('integer').schema['x-entity'],
      { default: 'updated', column: 'integer' });
    assert.deepStrictEqual(m.integer().column('json').schema['x-entity'], { column: 'json' });
    assert.deepStrictEqual(m.number().fill(0.5).schema['x-entity'], { default: { value: 0.5 } });
    assert.deepStrictEqual(m.string().compute((d) => d.first.concat(d.last)).schema['x-entity'],
      { default: { query: { $concat: ['$.first', '$.last'] } } });
    assert.deepStrictEqual(m.string().compute({ $lower: '$.name' }).schema['x-entity'],
      { default: { query: { $lower: '$.name' } } });
  });

  it('the three relation spellings are MODEL-FORMAT §9.4\'s three kinds, optional by construction', () => {
    assert.deepStrictEqual(m.rel.hasMany('Post', { via: 'authorId', onDelete: 'cascade' }).schema,
      { 'x-entity': { relation: { to: 'Post', many: true, via: 'authorId', onDelete: 'cascade' } } });
    assert.deepStrictEqual(m.rel.hasOne('User', { via: 'authorId', onDelete: 'restrict' }).schema,
      { 'x-entity': { relation: { to: 'User', via: 'authorId', onDelete: 'restrict' } } });
    assert.deepStrictEqual(m.rel.belongsToMany('Label').schema,
      { 'x-entity': { relation: { to: 'Label', many: true } } });
    assert.deepStrictEqual(m.rel.belongsToMany('Label', { through: 'user_labels' }).schema,
      { 'x-entity': { relation: { to: 'Label', many: true, through: 'user_labels' } } });
    assert.strictEqual(m.rel.hasMany('Post', { via: 'x', onDelete: 'cascade' }).state.optional, true);
    assert.deepStrictEqual(m.object({ p: m.rel.hasMany('Post', { via: 'x', onDelete: 'cascade' }) }).schema.required, undefined);
  });

  it('index paths: a lambda, a composite, a string; the default name is by_<segments>', () => {
    assert.deepStrictEqual(m.index((p) => p.embedding, { derive: 'vector', dims: 768 }),
      { name: 'by_embedding', path: '$.embedding', derive: 'vector', dims: 768 });
    assert.deepStrictEqual(m.index([(s) => s.series, (s) => s.get('at')]),
      { name: 'by_series_at', path: ['$.series', "$['at']"] });
    // `at` is the surface's index method: the lambda answers a function, and the pen says so
    assert.throws(() => m.index((s) => s.at), (e) => e.code === 'JL0102' && /get\('at'\)/.test(e.message));
    assert.deepStrictEqual(m.index((p) => p.meta.cell), { name: 'by_meta_cell', path: '$.meta.cell' });
    assert.deepStrictEqual(m.index("$['x-y']", { unique: true }), { name: 'by_x_y', path: "$['x-y']", unique: true });
    assert.deepStrictEqual(m.index((p) => p.get('x-y')), { name: 'by_x_y', path: "$['x-y']" });
  });

  it('a collection key is a pointer, a captured member path, or null with an identity', () => {
    const doc = m.object({ id: m.string(), meta: m.object({ k: m.string() }) });
    assert.strictEqual(m.collection(doc, { key: '/id' }).key, '/id');
    assert.strictEqual(m.collection(doc, { key: (d) => d.meta.k }).key, '/meta/k');
    assert.deepStrictEqual(m.collection(doc, { key: null, identity: 'uuid' }).identity, 'uuid');
    assert.deepStrictEqual(m.collection(doc, { renamedFrom: 'old' })['x-rename'], 'old');
    assert.deepStrictEqual(m.collection(doc.renamedFrom('older'))['x-rename'], 'older');
  });

  it('the schema-pen builders are the base classes; the model pen\'s are subclasses with the vocabulary', () => {
    assert.strictEqual(m.string() instanceof s.StringBuilder, true);
    assert.strictEqual(m.string() instanceof m.EntityStringBuilder, true);
    assert.strictEqual(s.string() instanceof m.EntityStringBuilder, false);
    assert.strictEqual(typeof /** @type {any} */ (s.string()).key, 'undefined', 'no patched prototype');
    assert.strictEqual(typeof m.string().min(1).nullable().key, 'function', 'with() keeps the class');
    // a schema-pen builder is still a valid entity member (a plain property)
    const mixed = m.defineModel({ entities: { A: m.object({ id: m.string().key(), n: s.string().optional() }) } });
    assert.deepStrictEqual(mixed.entities.A.schema.properties.n, { type: 'string' });
  });
});

describe('the model pen — refusals, each with the fix in the message', () => {
  it("JL0102 — a relation target the model does not declare, with the member's docPath", () => {
    assert.throws(() => m.defineModel({ entities: {
      User: m.object({ id: m.string().key(), posts: m.rel.hasMany('Psot', { via: 'authorId', onDelete: 'cascade' }) }),
      Post: m.object({ pid: m.integer().key() }),
    } }), (e) => e instanceof LinqBuildError && e.code === 'JL0102' && /'Psot'/.test(e.message)
      && e.docPath === '/entities/User/schema/properties/posts/x-entity/relation/to');
  });

  it('JL0102 — a store-allocated key off its kind, or beside a composite key', () => {
    assert.throws(() => m.integer().identity('uuid'), (e) => e.code === 'JL0102' && /string key/.test(e.message));
    assert.throws(() => m.string().identity('auto'), (e) => e.code === 'JL0102' && /integer key/.test(e.message));
    assert.throws(() => m.number().identity('auto'), (e) => e.code === 'JL0102' && /integer\(\)/.test(e.message));
    assert.throws(() => m.string().identity(/** @type {any} */ ('random')), (e) => e.code === 'JL0101');
    assert.throws(() => m.defineModel({ entities: { A: m.object({ a: m.integer().identity('auto'), b: m.string().key() }) } }),
      (e) => e.code === 'JL0102' && /composite/.test(e.message) && e.docPath === '/entities/A/schema/properties/a/x-entity/default');
    // the store's own walk agrees with the mirror: what the pen lets through, it accepts
    assert.doesNotThrow(() => normalizeEntities(m.defineModel({ entities: { A: m.object({ a: m.integer().identity('auto') }) } })));
  });

  it("JL0102 — column('integer') off a date, and an entity spelled as a collection", () => {
    assert.throws(() => m.string().column('integer'), (e) => e.code === 'JL0102' && /datetime\(\)/.test(e.message));
    assert.throws(() => m.integer().column('integer'), (e) => e.code === 'JL0102');
    assert.throws(() => m.string().column(/** @type {any} */ ('text')), (e) => e.code === 'JL0101');
    assert.throws(() => m.defineModel({ entities: { A: m.collection(m.object({ id: m.string() }), { key: '/id', indexes: [] }) } }),
      (e) => e.code === 'JL0102' && /indexes/.test(e.message) && e.docPath === '/entities/A');
  });

  it('JL0101 — malformed relation options, index options, keys and names', () => {
    assert.throws(() => m.rel.hasMany('Post', { via: 'authorId' }), (e) => e.code === 'JL0101' && /onDelete/.test(e.message));
    assert.throws(() => m.rel.hasOne('Post', { via: 'authorId', onDelete: 'nope' }), (e) => e.code === 'JL0101');
    assert.throws(() => m.rel.hasMany('Post', { via: 'authorId', onDelete: 'cascade', through: 'x' }), (e) => e.code === 'JL0101' && /through/.test(e.message));
    assert.throws(() => m.rel.belongsToMany('Post', { via: 'x' }), (e) => e.code === 'JL0101');
    assert.throws(() => m.index((p) => p.a, { derived: 'bbox' }), (e) => e.code === 'JL0101' && /'derived'/.test(e.message));
    assert.throws(() => m.index((p) => p.a.upper()), (e) => e.code === 'JL0102' && /operator/.test(e.message));
    assert.throws(() => m.collection(m.object({}), { key: (d) => d.a.all() }), (e) => e.code === 'JL0102');
    assert.throws(() => m.collection(m.object({}), { key: 'id' }), (e) => e.code === 'JL0101');
    assert.throws(() => m.collection(m.object({}), { indexes: [{ path: '$.a' }] }), (e) => e.code === 'JL0101');
    assert.throws(() => m.defineModel({ entities: { 'bad name': m.object({ id: m.string().key() }) } }), (e) => e.code === 'JL0101');
    assert.throws(() => m.defineModel({ entities: { A: { schema: {} } } }), (e) => e.code === 'JL0101');
    assert.throws(() => m.defineModel({ collections: { a: { schema: {} } } }), (e) => e.code === 'JL0101');
    assert.throws(() => m.defineModel({}), (e) => e.code === 'JL0101');
    assert.throws(() => m.string().enumOf([1]), (e) => e.code === 'JL0101');
    assert.throws(() => m.integer().enumOf([1.5]), (e) => e.code === 'JL0101');
  });

  it('JL0104 — x-entity is owned here; a compute() sees only the document', () => {
    assert.throws(() => m.string().meta({ 'x-entity': { key: true } }), (e) => e.code === 'JL0104');
    assert.throws(() => m.string().compute((d, x) => x.root.eq(1)), (e) => e.code === 'JL0104' && /no externals/.test(e.message));
    // the schema pen does not own it: an annotation there passes through
    assert.deepStrictEqual(s.string().meta({ 'x-entity': { key: true } }).schema['x-entity'], { key: true });
  });

  it("what the pen cannot see stays the engine's: inverse agreement is JD0031 from the store", () => {
    const model = m.defineModel({ entities: {
      User: m.object({ id: m.string().key(), posts: m.rel.hasMany('Post', { via: 'authorId', onDelete: 'cascade' }) }),
      Post: m.object({ pid: m.integer().key(), authorId: m.string(), author: m.rel.hasOne('User', { via: 'authorId', onDelete: 'restrict' }) }),
    } });
    assert.throws(() => normalizeEntities(model), (e) => e instanceof DbCompileError && e.code === 'JD0031');
  });
});

describe('the model pen — no store behind it', () => {
  it('imports nothing from @jarenjs/db; the store is a test dependency', async () => {
    const dir = new URL('../../packages/linq/src/model/', import.meta.url);
    for (const file of fs.readdirSync(dir)) {
      const source = await fs.promises.readFile(new URL(file, dir), 'utf8');
      assert.strictEqual(/from '@jarenjs\/(db|validate|emit)/.test(source), false, `${file} imports an engine`);
    }
  });
});
