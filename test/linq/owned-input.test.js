//@ts-check
/**
 * @file A document owns its JSON. A value a caller hands to a builder or a
 * captured callback is copied where it enters, so writing into it later
 * rewrites nothing the pen or the chain already holds, and reading a
 * document never freezes the caller's own object in place. A hand-written
 * query document under `sub()` crosses the same JSON boundary as every
 * other verbatim member.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { from, fromAsync, fromDocument } from '@jarenjs/linq';
import * as s from '@jarenjs/linq/schema';
import * as m from '@jarenjs/linq/model';
import { sub } from '@jarenjs/linq/app';
import { open } from '@jarenjs/linq/db';
import { nodeDriver } from '@jarenjs/db/node';

/** A fresh caller-owned value: nested, so a shallow copy would not do. */
const owned = () => ({ a: [1], b: { c: [2] } });

/**
 * Build with `make(d)` and write into `d` before anything reads the
 * document: the document is what an untouched twin built from a fresh
 * value reads, and `d` is still writable afterwards.
 * @param {(d: any) => any} make - the builder, given the caller's value
 * @param {(built: any) => any} documentOf
 * @returns {{ before: string, after: string, writable: boolean }}
 */
function probe(make, documentOf) {
  const before = JSON.stringify(documentOf(make(owned())));
  const d = owned();
  const built = make(d);
  d.a.push(99);
  d.b.c.push(98);
  const after = JSON.stringify(documentOf(built));
  let writable = true;
  try { d.a.push(97); }
  catch { writable = false; }
  return { before, after, writable };
}

const schemaOfBuilder = (b) => b.schema;

describe('the schema pen copies the JSON it is given', () => {
  const cases = {
    'default()': (d) => s.any().default(d),
    'example()': (d) => s.any().example(d),
    'meta()': (d) => s.any().meta({ 'x-note': d }),
    'message()': (d) => s.string().message(d),
    'literal()': (d) => s.literal(d),
    'enumOf()': (d) => s.enumOf([d]),
    'from()': (d) => s.from({ type: 'object', default: d }),
    'check() with a query document': (d) => s.object({ x: s.string() }).check({ $eq: [d, d] }),
  };
  for (const [name, make] of Object.entries(cases)) {
    it(`${name}: a later write to the argument changes nothing, and the argument stays writable`, () => {
      const { before, after, writable } = probe(make, schemaOfBuilder);
      assert.strictEqual(after, before);
      assert.strictEqual(writable, true);
    });
  }

  it('dependentRequired(): the map and its arrays are copied', () => {
    const map = { a: ['b'] };
    const built = s.object({ a: s.string(), b: s.string().optional() }).dependentRequired(map);
    map.a.push('zzz');
    assert.deepStrictEqual(built.schema.dependentRequired, { a: ['b'] });
  });

  it('reading .schema leaves the caller object unfrozen', () => {
    const d = owned();
    const built = s.any().default(d);
    void built.schema;
    assert.strictEqual(Object.isFrozen(d), false);
    assert.strictEqual(Object.isFrozen(d.a), false);
  });
});

describe('the model pen copies the JSON it is given', () => {
  it('fill(), compute() as a document, physical(), invariants(): later writes change nothing', () => {
    const fill = probe((d) => m.defineModel({ entities: { A: m.object({ id: m.string().key(), v: m.any().fill(d).optional() }) } }), (x) => x);
    assert.strictEqual(fill.after, fill.before);
    assert.strictEqual(fill.writable, true);

    const query = probe((d) => m.defineModel({ entities: { A: m.object({ id: m.string().key(), v: m.any().compute({ $const: d }).optional() }) } }), (x) => x);
    assert.strictEqual(query.after, query.before);
    assert.strictEqual(query.writable, true);

    const physical = probe((d) => m.defineModel({ entities: { A: m.object({ id: m.string().key() }).physical({ table: 'a', columns: d }) } }), (x) => x);
    assert.strictEqual(physical.after, physical.before);
    assert.strictEqual(physical.writable, true);

    const invariants = probe((d) => m.defineModel({ entities: { A: m.object({ id: m.string().key() }).invariants([{ id: 'inv', d }]) } }), (x) => x);
    assert.strictEqual(invariants.after, invariants.before);
    assert.strictEqual(invariants.writable, true);
  });

  it('index(): the where document is copied when the index is declared', () => {
    const where = { $const: [1] };
    const entry = m.index('$.id', { where });
    where.$const.push(2);
    assert.deepStrictEqual(entry.where, { $const: [1] });
    assert.strictEqual(Object.isFrozen(where), false);
  });

  it('index(): a where query document is copied', () => {
    const where = probe((d) => m.defineModel({ collections: { c: m.collection(s.object({ id: s.string() }), {
      key: '/id', indexes: [m.index('$.id', { where: { $const: d } })] }) } }), (x) => x);
    assert.strictEqual(where.after, where.before);
    assert.strictEqual(where.writable, true);
  });

  it('indexes() on an entity: a raw entry is copied when it is declared and again when it is lifted', () => {
    const probeIndexes = probe((d) => {
      const entry = { name: 'by_a', path: '$.a', where: { $const: d } };
      return m.defineModel({ entities: { A: m.object({ id: m.string().key(), a: m.string().optional() }).indexes([entry]) } });
    }, (x) => x);
    assert.strictEqual(probeIndexes.after, probeIndexes.before);
    assert.strictEqual(probeIndexes.writable, true);
    // the entry itself is written to between indexes() and defineModel()
    const entry = { name: 'by_a', path: '$.a', where: { $const: [1] } };
    const builder = m.object({ id: m.string().key(), a: m.string().optional() }).indexes([entry]);
    entry.where.$const.push(2);
    const doc = m.defineModel({ entities: { A: builder } });
    assert.deepStrictEqual(doc.entities.A.indexes[0].where, { $const: [1] });
  });

  it('collection(): a raw interval entry is copied, so it stays writable and cannot rewrite the model', () => {
    const interval = { name: 'span', path: '$.span', maxDuration: 5 };
    const collection = m.collection(s.object({ id: s.string() }), { key: '/id', intervals: [interval] });
    interval.maxDuration = 9;
    const doc = m.defineModel({ collections: { c: collection } });
    assert.strictEqual(doc.collections.c.intervals[0].maxDuration, 5);
    assert.strictEqual(Object.isFrozen(interval), false);
  });

  it('collection(): identity, raw index entries and intervals are copied', () => {
    const identity = probe((d) => m.defineModel({ collections: { c: m.collection(s.object({ id: s.string() }), { key: '/id', identity: d }) } }), (x) => x);
    assert.strictEqual(identity.after, identity.before);
    assert.strictEqual(identity.writable, true);

    const where = probe((d) => m.defineModel({ collections: { c: m.collection(s.object({ id: s.string() }), {
      key: '/id', indexes: [{ name: 'by_id', path: '$.id', where: { $const: d } }] }) } }), (x) => x);
    assert.strictEqual(where.after, where.before);
    assert.strictEqual(where.writable, true);
  });
});

describe('the chain copies the constants it captures', () => {
  const rows = [{ a: [1], b: { c: [2] } }, { a: [1, 99], b: { c: [2] } }];

  it('x.eq(object): writing into the object afterwards does not change the query', () => {
    const d = owned();
    const query = from(rows).where((r) => r.eq(d));
    const before = JSON.stringify(query.toDocument());
    const answered = JSON.stringify(query.toArray());
    d.a.push(99);
    assert.strictEqual(JSON.stringify(query.toDocument()), before);
    assert.strictEqual(JSON.stringify(query.toArray()), answered);
    assert.deepStrictEqual(query.toArray(), [rows[0]]);
  });

  it('select({ k: object }): the projected constant is the one captured', () => {
    const d = owned();
    const query = from([1]).select((x) => ({ v: x, k: d }));
    d.a.push(99);
    assert.deepStrictEqual(query.toArray(), [{ v: 1, k: { a: [1], b: { c: [2] } } }]);
  });

  it('concat(array) and defaultIfEmpty(object) hold their own copies, on both surfaces', async () => {
    const extra = [owned()];
    const sync = from([]).concat(extra);
    const asy = fromAsync([]).concat(extra);
    const fallback = owned();
    const syncFallback = from([]).defaultIfEmpty(fallback);
    const asyncFallback = fromAsync([]).defaultIfEmpty(fallback);
    extra[0].a.push(99);
    fallback.a.push(99);
    assert.deepStrictEqual(sync.toArray(), [owned()]);
    assert.deepStrictEqual(await asy.toArray(), [owned()]);
    assert.deepStrictEqual(syncFallback.toArray(), [owned()]);
    assert.deepStrictEqual(await asyncFallback.toArray(), [owned()]);
  });

  it('fromDocument(): the document is copied when the sequence is made', () => {
    const doc = { $for: { it: '$[*]' }, $where: { $gt: ['$it', 1] }, $return: '$it' };
    const query = fromDocument([1, 2, 3], doc);
    doc.$where.$gt[1] = 2;
    assert.deepStrictEqual(query.toArray(), [2, 3]);
    assert.deepStrictEqual(query.toDocument().$where.$gt, ['$it', 1]);
  });

  it('ofType() and cast(): the schema is copied when the stage is made', () => {
    const compileTypeTest = (schema) => {
      const type = schema.type;
      return (value) => typeof value === type;
    };
    const schema = { type: 'string' };
    const typed = from([1, 'a'], { compileTypeTest }).ofType(schema);
    const checked = from(['a'], { compileTypeTest }).cast(schema);
    schema.type = 'number';
    assert.deepStrictEqual(typed.toArray(), ['a']);
    assert.deepStrictEqual(checked.toArray(), ['a']);
  });
});

describe('a parameter binding is copied when it is bound', () => {
  const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const provider = (seen) => ({ root: '$.t[*]', execute: (document, options) => { seen.push(options.externals); return []; } });

  it('writing into the bound value afterwards changes neither the answer nor the bindings', () => {
    const ids = [1, 2];
    const query = from(rows).params({ ids }).where((r, p) => r.id.in(p.ids));
    ids.push(3);
    ids.push(/** @type {any} */ (new Date(0)));
    assert.deepStrictEqual(query.toArray(), [{ id: 1 }, { id: 2 }]);
    assert.deepStrictEqual(query.explain().bindings, { ids: [1, 2] });
  });

  it('a provider receives the value as it was bound', async () => {
    const seen = [];
    const ids = [1, 2];
    const query = fromAsync(provider(seen)).params({ ids }).where((r, p) => r.id.in(p.ids));
    ids.push(3);
    await query.toArray();
    assert.deepStrictEqual(seen, [{ ids: [1, 2] }]);
  });

  it('explain() hands out a copy of the bindings: writing into it rewrites nothing', async () => {
    const query = from(rows).params({ ids: [1, 2] }).where((r, p) => r.id.in(p.ids));
    query.explain().bindings.ids.push(3);
    assert.deepStrictEqual(query.toArray(), [{ id: 1 }, { id: 2 }]);
    assert.deepStrictEqual(query.explain().bindings, { ids: [1, 2] });

    const asynchronous = fromAsync(rows).params({ ids: [1, 2] }).where((r, p) => r.id.in(p.ids));
    asynchronous.explain().bindings.ids.push(3);
    assert.deepStrictEqual(await asynchronous.toArray(), [{ id: 1 }, { id: 2 }]);
    assert.deepStrictEqual(asynchronous.explain().bindings, { ids: [1, 2] });
  });

  it('a provider that writes into the externals it is handed cannot rewrite the sequence', async () => {
    const run = (surface) => {
      const seen = [];
      const writer = { root: '$.t[*]', execute: (document, options) => {
        seen.push(JSON.stringify(options.externals));
        options.externals.ids.push(666);
        return [];
      } };
      const ids = [1, 2];
      const query = surface(writer).params({ ids }).where((r, p) => r.id.in(p.ids)).select((r) => r.id);
      return { seen, ids, query };
    };
    const sync = run(from);
    sync.query.toArray();
    sync.query.toArray();
    assert.deepStrictEqual(sync.seen, ['{"ids":[1,2]}', '{"ids":[1,2]}']);
    assert.deepStrictEqual(sync.ids, [1, 2]);

    const asynchronous = run(fromAsync);
    await asynchronous.query.toArray();
    await asynchronous.query.toArray();
    assert.deepStrictEqual(asynchronous.seen, ['{"ids":[1,2]}', '{"ids":[1,2]}']);
  });

  it('a scalar and a nested object are bound as they are', () => {
    const cfg = { limit: 2, tags: ['a'] };
    const query = from(rows).params({ cfg, n: 2 }).where((r, p) => r.id.le(p.cfg.limit));
    cfg.limit = 3;
    cfg.tags.push('b');
    assert.deepStrictEqual(query.toArray(), [{ id: 1 }, { id: 2 }]);
    assert.deepStrictEqual(query.explain().bindings, { cfg: { limit: 2, tags: ['a'] }, n: 2 });
  });
});

describe('sub() takes a hand-written query document across the JSON boundary', () => {
  const bad = {
    NaN: Number.NaN,
    Infinity: Number.POSITIVE_INFINITY,
    '-0': -0,
    'a Date': new Date(0),
    'a Map': new Map(),
    'an undefined member': { $eq: [1, undefined] },
  };
  for (const [name, value] of Object.entries(bad)) {
    for (const member of ['when', 'withQuery', 'key']) {
      it(`${member}: ${name} is JL0101, never null, 0 or {}`, () => {
        const options = member === 'when' ? { when: value } : { for: '$.items', [member]: value };
        assert.throws(() => sub('go', options), (e) => e.code === 'JL0101' && /not JSON/.test(e.message));
      });
    }
  }

  it('a bigint and a symbol are JL0101 too, not a raw TypeError or SyntaxError', () => {
    assert.throws(() => sub('go', { when: 1n }), (e) => e.code === 'JL0101');
    assert.throws(() => sub('go', { when: Symbol('s') }), (e) => e.code === 'JL0101');
  });

  it('a well-formed document is copied: writing into it later changes nothing', () => {
    const when = { $gt: ['$count', 0] };
    const entry = sub('go', { when });
    when.$gt[1] = 5;
    assert.deepStrictEqual(entry.when, { $gt: ['$count', 0] });
  });
});

describe('a graph copies the keyset cursor it resumes from', () => {
  it('after(): writing into the cursor afterwards does not move the page', async () => {
    const Post = m.object({ pid: m.integer().identity('auto'), stars: m.integer() });
    const client = await open(m.defineModel({ entities: { Post } }), { driver: nodeDriver(), validator: null });
    try {
      const cursor = { order: [{ column: 'pid', desc: false, nullsFirst: true }], keys: [1], key: 1 };
      const graph = client.entities.Post.graph().orderBy((p) => p.pid).after(cursor);
      cursor.key = 99;
      cursor.keys.push(98);
      assert.deepStrictEqual(graph.toSpec().after,
        { order: [{ column: 'pid', desc: false, nullsFirst: true }], keys: [1], key: 1 });
    }
    finally {
      await client.close();
    }
  });
});
