//@ts-check
/**
 * @file Single-path projection pushdown: a FLWOR whose `$return` is ONE
 * member path over the binding projects that path into the statement —
 * its value beside its JSON type — and `$count` over it emits a
 * `COUNT(*)` with the member's presence in the WHERE. The answers equal
 * the engine's for every value kind (present, null, absent, boolean,
 * number, string, object, array, nested), and — the assertion that
 * matters most — a query whose residual still needs another member is
 * NOT projected and answers correctly. The oracle corpus and its
 * forced-residual mode are the regression net (`oracle.test.js`).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { compileJsonQuery } from '@jarenjs/json/query';

const MODEL = {
  $model: '0.1',
  collections: {
    rows: {
      schema: { type: 'object', properties: {
        id: { type: 'string' }, n: { type: ['number', 'null'] }, s: { type: 'string' },
        b: { type: 'boolean' }, o: { type: 'object', properties: { k: { type: 'integer' } } },
        tags: { type: 'array', items: { type: 'string' } } } },
      key: '/id',
      indexes: [{ name: 'by_n', path: '$.n' }],
    },
  },
};
const DATA = [
  { id: 'a', n: 1, s: 'one', b: true, o: { k: 1 }, tags: ['x', 'y'] },
  { id: 'b', n: null, s: 'two', b: false, o: { k: 2 }, tags: [] },
  { id: 'c', s: 'three', o: {} },
  { id: 'd', n: 4, s: 'four', b: true, o: { k: 4 }, tags: ['z'] },
  { id: 'e', n: 5.5, s: 'five' },
];

async function fresh() {
  const store = await openStore(MODEL, { driver: nodeDriver() });
  const rows = store.collection('rows');
  for (const row of DATA) await rows.insert(row);
  return { store, rows };
}

const engine = (document, externals = {}) => compileJsonQuery(document)(structuredClone(DATA), externals);
const ordered = (ret, extra = {}) => ({ $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: ret, ...extra });

describe('a single member path projects into the statement', () => {
  it('the statement selects the path and its type, never the whole document, and answers what the engine answers', async () => {
    const { store, rows } = await fresh();
    for (const path of ['$it.n', '$it.s', '$it.b', '$it.o', '$it.tags', '$it.o.k', '$it.missing']) {
      const document = ordered(path);
      const explained = await rows.explain(document);
      assert.strictEqual(explained.mode, 'native', path);
      assert.deepStrictEqual(explained.projection, { path: path.slice(4).split('.') }, path);
      assert.match(explained.sql, /END AS "v", json_type\("doc", '\$\..*'\) AS "t"/);
      assert.doesNotMatch(explained.sql, /AS "doc"/, `${path}: the whole document is not read`);
      const answer = await Promise.resolve(rows.execute(document));
      assert.deepStrictEqual(answer, engine(document), path);
      const streamed = [];
      for await (const item of rows.query(document)) streamed.push(item);
      const expected = engine(document);
      assert.deepStrictEqual(streamed, expected === undefined ? [] : Array.isArray(expected) ? expected : [expected], `${path} via the cursor`);
    }
    // a present null, an absent member and the booleans are told apart
    assert.deepStrictEqual(await Promise.resolve(rows.execute(ordered('$it.n'))), [1, null, 4, 5.5]);
    assert.deepStrictEqual(await Promise.resolve(rows.execute(ordered('$it.b'))), [true, false, true]);
    // a window over the projection, and the chain's element window
    const windowed = { $subsequence: [ordered('$it.s'), 1, 2] };
    assert.deepStrictEqual(await Promise.resolve(rows.execute(windowed)), engine(windowed));
    assert.strictEqual((await rows.explain(windowed)).mode, 'native');
    assert.deepStrictEqual(await Promise.resolve(rows.execute([ordered('$it.n')])), [1, null, 4, 5.5],
      'the element window answers its items as one array');
    // strict mode no longer meets a residual here
    assert.deepStrictEqual(await Promise.resolve(rows.execute(ordered('$it.s'), { strict: true })), engine(ordered('$it.s')));
    await store.close();
  });

  it('$count over a projected path is a COUNT(*) over the rows where the member is present', async () => {
    const { store, rows } = await fresh();
    const counted = { $count: { $for: { it: '$[*]' }, $return: '$it.n' } };
    const explained = await rows.explain(counted);
    assert.strictEqual(explained.mode, 'native');
    assert.match(explained.sql, /SELECT COUNT\(\*\) AS "value" FROM "rows" WHERE json_type\("doc", '\$\."n"'\) IS NOT NULL/);
    assert.strictEqual(await Promise.resolve(rows.execute(counted)), 4, 'a present null counts, an absent member does not');
    assert.strictEqual(await Promise.resolve(rows.execute(counted)), engine(counted));
    const filtered = { $count: { $for: { it: '$[*]' }, $where: { $gt: ['$it.n', 1] }, $return: '$it.s' } };
    assert.strictEqual(await Promise.resolve(rows.execute(filtered)), engine(filtered));
    assert.match((await rows.explain(filtered)).sql, /COUNT\(\*\)/);
    await store.close();
  });
});

describe('a projection never drops a member a residual needs', () => {
  it('a query whose residual conjunct needs another member is not projected, and answers correctly', async () => {
    const { store, rows } = await fresh();
    // a `$let` the planner does not translate makes the whole selection
    // residual: the engine needs `n` to decide, so the whole document
    // is read and `s` is projected by the engine, never by the statement
    const needsN = { $for: { it: '$[*]' }, $let: { k: 1 }, $where: { $gt: ['$it.n', '$k'] }, $orderby: ['$it.id'], $return: '$it.s' };
    const explained = await rows.explain(needsN);
    assert.strictEqual(explained.mode, 'set');
    assert.strictEqual(explained.projection, null);
    assert.match(explained.sql, /AS "doc"/, 'the whole document is read');
    assert.deepStrictEqual(await Promise.resolve(rows.execute(needsN)), engine(needsN));
    assert.deepStrictEqual(await Promise.resolve(rows.execute(needsN)), ['four', 'five']);
    // a conjunct the UDF hatch could have pushed stays with the whole
    // document under a profile (no registration under a profile), and
    // still answers what the engine answers
    const computed = { $for: { it: '$[*]' }, $where: { $eq: [{ $upper: '$it.s' }, 'FOUR'] }, $orderby: ['$it.id'], $return: '$it.s' };
    const profiled = await rows.explain(computed, { profile: { maxRows: 100 } });
    assert.notStrictEqual(profiled.mode, 'native');
    assert.strictEqual(profiled.projection, null);
    assert.deepStrictEqual(await Promise.resolve(rows.execute(computed, { profile: { maxRows: 100 } })), engine(computed));
    assert.deepStrictEqual(await Promise.resolve(rows.execute(computed, { profile: { maxRows: 100 } })), 'four');
    // an object of safe member paths IS pushed — the statement fetches
    // the two leaves and the decoder builds the shape; a projection that
    // needs the engine (a host function over a member) is not, and runs
    // per row over the whole document
    const object = ordered({ who: '$it.id', num: '$it.n' });
    assert.strictEqual((await rows.explain(object)).mode, 'native');
    assert.deepStrictEqual((await rows.explain(object)).projection, { paths: [['id'], ['n']] });
    assert.deepStrictEqual(await Promise.resolve(rows.execute(object)), engine(object));
    const computedShape = ordered({ who: '$it.id', up: { $upper: '$it.s' } });
    assert.strictEqual((await rows.explain(computedShape)).mode, 'row');
    assert.strictEqual((await rows.explain(computedShape)).projection, null);
    assert.deepStrictEqual((await rows.explain(computedShape)).residualProjection,
      { who: '$it.id', up: { $upper: '$it.s' } },
      'the projection that stayed behind is named, whole');
    assert.deepStrictEqual(await Promise.resolve(rows.execute(computedShape)), engine(computedShape));
    await store.close();
  });

  it('the forced-residual mode agrees with the pushed mode on every projected case', async () => {
    const { store, rows } = await fresh();
    for (const document of [
      ordered('$it.n'), ordered('$it.o.k'), ordered('$it.tags'), ordered('$it.b'),
      { $count: { $for: { it: '$[*]' }, $return: '$it.n' } },
      { $subsequence: [ordered('$it.s'), 1, 2] },
      ordered('$it.n', { $where: { $exists: '$it.b' } }),
    ]) {
      const pushed = await Promise.resolve(rows.execute(document));
      const forced = await Promise.resolve(rows.execute(document, { pushdown: false }));
      assert.deepStrictEqual(pushed, forced, JSON.stringify(document));
      assert.deepStrictEqual(pushed, engine(document), JSON.stringify(document));
    }
    await store.close();
  });
});

// ————— The projection TREE: nested shapes of safe member paths —————

describe('a nested shape of member paths and literals projects into the statement', () => {
  const SHAPES = [
    ['object of two paths', { who: '$it.id', num: '$it.n' }],
    ['nested object', { who: '$it.id', inner: { k: '$it.o.k', s: '$it.s' } }],
    ['array of paths', ['$it.id', '$it.n']],
    ['array with literals', ['$it.id', 7, null, true, '$it.s']],
    ['array inside an object', { id: '$it.id', pair: ['$it.n', '$it.b'] }],
    ['object inside an array', ['$it.id', { k: '$it.o.k' }]],
    ['a compound member whole', { o: '$it.o', tags: '$it.tags' }],
    ['an absent member', { id: '$it.id', miss: '$it.nope' }],
    ['a null-valued member', { id: '$it.id', n: '$it.n' }],
    ['empty constructors beside a leaf', { id: '$it.id', e: {}, a: [] }],
    ['a repeated leaf', { a: '$it.n', b: '$it.n', c: '$it.n' }],
    ['deeply nested', { a: { b: { c: ['$it.id', { d: '$it.o.k' }] } } }],
  ];

  it('every shape is native, and equals the engine at many, one and zero rows', async () => {
    const { store, rows } = await fresh();
    for (const [name, shape] of SHAPES) {
      for (const [label, extra] of /** @type {const} */ ([
        ['many', {}],
        ['one', { $where: { $eq: ['$it.id', 'a'] } }],
        ['zero', { $where: { $eq: ['$it.id', 'nobody'] } }],
      ])) {
        const document = ordered(shape, extra);
        const explained = await rows.explain(document);
        assert.strictEqual(explained.mode, 'native', `${name} / ${label}`);
        assert.deepStrictEqual(await Promise.resolve(rows.execute(document)),
          engine(document), `${name} / ${label}`);
      }
    }
    await store.close();
  });

  it('the statement fetches the leaves and nothing else — no document blob, a repeated leaf once', async () => {
    const { store, rows } = await fresh();
    const document = ordered({ a: '$it.n', b: '$it.n', inner: { s: '$it.s', again: '$it.n' } });
    const explained = await rows.explain(document);
    assert.doesNotMatch(explained.sql, /AS "doc"/, 'the whole document is not read');
    assert.deepStrictEqual(explained.projection, { paths: [['n'], ['s']] },
      'two distinct leaves, in fetch order');
    // one value/type pair per DISTINCT leaf — three references, two pairs
    assert.deepStrictEqual(explained.sql.match(/AS "v\d"/g), ['AS "v0"', 'AS "v1"']);
    assert.deepStrictEqual(explained.sql.match(/AS "t\d"/g), ['AS "t0"', 'AS "t1"']);
    assert.deepStrictEqual(await Promise.resolve(rows.execute(document)), engine(document));
    await store.close();
  });

  it('an absent leaf is omitted from its object and skipped in its array; a literal null is neither', async () => {
    const { store, rows } = await fresh();
    // `c` has no `n` and no `tags`; `b` has `n: null` — three different
    // outcomes the JSON type tells apart and a fetched blob would not
    const shaped = ordered({ id: '$it.id', n: '$it.n', z: null, packed: ['$it.n', '$it.tags'] });
    const answer = await Promise.resolve(rows.execute(shaped));
    assert.deepStrictEqual(answer, engine(shaped));
    assert.deepStrictEqual(answer[1], { id: 'b', n: null, z: null, packed: [null, []] },
      'a present null is a member; the empty array is a value');
    assert.deepStrictEqual(answer[2], { id: 'c', z: null, packed: [] },
      'an absent member is omitted from the object and skipped in the array');
    await store.close();
  });

  it('a shape the tree cannot rebuild refuses WHOLE, names its residual, and JD0010 under strict', async () => {
    const { store, rows } = await fresh();
    // one safe leaf beside one the tree cannot rebuild: promoting the
    // half that composes would answer a shape nobody asked for
    const mixed = ordered({ id: '$it.id', how: { $count: '$it.tags' } });
    const explained = await rows.explain(mixed);
    assert.strictEqual(explained.mode, 'row');
    assert.strictEqual(explained.projection, null, 'nothing is projected — not even the safe half');
    assert.deepStrictEqual(explained.residualProjection, { id: '$it.id', how: { $count: '$it.tags' } });
    assert.match(explained.sql, /AS "doc"/, 'the row residual needs the document');
    assert.deepStrictEqual(await Promise.resolve(rows.execute(mixed)), engine(mixed));
    await assert.rejects(async () => rows.execute(mixed, { strict: true }), (error) => {
      assert.strictEqual(/** @type {any} */ (error).code, 'JD0010');
      assert.match(/** @type {any} */ (error).message, /'\$return'/);
      return true;
    });
    // a projection of pure literals has no leaf for a statement to
    // fetch, so it stays where it is rather than inventing a column
    const literalsOnly = ordered({ k: 7, t: true });
    assert.strictEqual((await rows.explain(literalsOnly)).mode, 'row');
    assert.deepStrictEqual(await Promise.resolve(rows.execute(literalsOnly)), engine(literalsOnly));
    // and the binding itself is a whole-document read, never a leaf
    const wholeItem = ordered({ id: '$it.id', all: '$it' });
    assert.strictEqual((await rows.explain(wholeItem)).mode, 'row');
    assert.deepStrictEqual(await Promise.resolve(rows.execute(wholeItem)), engine(wholeItem));
    await store.close();
  });

  it('a count over a projected shape is a COUNT(*) — a constructor answers one item per row', async () => {
    const { store, rows } = await fresh();
    for (const shape of [{ i: '$it.id', n: '$it.n' }, ['$it.n'], { i: '$it.nope' }]) {
      const document = { $count: { $for: { it: '$[*]' }, $return: shape } };
      const explained = await rows.explain(document);
      assert.strictEqual(explained.mode, 'native', JSON.stringify(shape));
      assert.match(explained.sql, /COUNT\(\*\)/);
      assert.deepStrictEqual(await Promise.resolve(rows.execute(document)), engine(document),
        JSON.stringify(shape));
    }
    await store.close();
  });

  it('the member allow-list reaches a projected leaf, before any statement', async () => {
    const { store, rows } = await fresh();
    const profile = { members: { rows: ['$.id', '$.o'] } };
    // an allowed leaf, and one under an allowed member
    const allowed = ordered({ i: '$it.id', k: '$it.o.k' });
    assert.deepStrictEqual(await Promise.resolve(rows.execute(allowed, { profile })),
      engine(allowed));
    await assert.rejects(
      async () => rows.execute(ordered({ i: '$it.id', s: '$it.s' }), { profile }),
      (error) => {
        assert.strictEqual(/** @type {any} */ (error).code, 'JD0011');
        assert.match(/** @type {any} */ (error).message, /does not allow the member 's' of 'rows'/);
        return true;
      });
    await store.close();
  });

  it('a projected shape streams one row at a time', async () => {
    const { store, rows } = await fresh();
    const document = ordered({ i: '$it.id', n: '$it.n' });
    const cursor = rows.query(document);
    assert.strictEqual(cursor.streaming, 'row');
    assert.strictEqual(cursor.barrier, null);
    const seen = [];
    for await (const item of cursor) seen.push(item);
    assert.deepStrictEqual(seen, engine(document));
    await store.close();
  });
});

// ————— The general GROUP BY, over a store —————

describe('a grouping answers its groups whole, through execute and through a cursor', () => {
  const grouped = {
    $for: { it: '$[*]' },
    $groupby: { g: '$it.s' },
    $orderby: ['$g'],
    $return: { g: '$g', n: { $count: '$it' } },
  };

  it('the statement groups, and the answer equals the engine\'s', async () => {
    const { store, rows } = await fresh();
    const explained = await rows.explain(grouped);
    assert.strictEqual(explained.mode, 'native');
    assert.match(explained.sql, /GROUP BY jsonb_extract\("doc", '\$\."s"'\) ORDER BY "vk0" ASC/);
    assert.deepStrictEqual(explained.group, {
      keys: [{ as: 'g', path: ['s'] }],
      aggregates: [{ fn: 'rows', path: null }],
      order: [{ key: 'g', desc: false }],
    });
    assert.deepStrictEqual(await Promise.resolve(rows.execute(grouped)), engine(grouped));
    await store.close();
  });

  it('a cursor over a grouping buffers by name — the groups ARE the result', async () => {
    const { store, rows } = await fresh();
    const cursor = rows.query(grouped);
    assert.strictEqual(cursor.streaming, 'buffered');
    assert.strictEqual(cursor.barrier?.construct, '$groupby');
    const seen = [];
    for await (const item of cursor) seen.push(item);
    assert.deepStrictEqual(seen, engine(grouped));
    // and the same plan declines under strictStreaming, before any statement
    assert.throws(() => rows.query(grouped, { strictStreaming: true }),
      (error) => /** @type {any} */ (error).code === 'JD0037');
    await store.close();
  });

  it('the order of FIRST APPEARANCE is the default, and it is the engine\'s', async () => {
    const { store, rows } = await fresh();
    const unordered = { $for: { it: '$[*]' }, $groupby: { g: '$it.s' },
      $return: { g: '$g', n: { $count: '$it' } } };
    const explained = await rows.explain(unordered);
    assert.strictEqual(explained.group.order, 'first-seen');
    assert.match(explained.sql, /ORDER BY MIN\("rowid"\)/);
    assert.deepStrictEqual(await Promise.resolve(rows.execute(unordered)), engine(unordered));
    await store.close();
  });
});
