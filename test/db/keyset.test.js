//@ts-check
/**
 * @file The composite keyset (MODEL-FORMAT §10.5): `page()` over an
 * ordering whose first column ties — `(age, id)`, `(score desc, id)`,
 * an epoch column — visits every row exactly once, ascending and
 * descending, with the primary key appended as the tie-breaker and the
 * null placement of the expansion agreeing with the plan's `ORDER BY`;
 * a composite primary key is appended whole; a continuation replayed
 * against another ordering, or malformed, is `JD0035`; the
 * single-column keyset keeps its own suite (`pagination.test.js`)
 * unchanged.
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

const MODEL = {
  $model: '0.1',
  entities: {
    User: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', 'x-entity': { key: true } },
          age: { type: 'integer', 'x-entity': { index: true } },
          score: { type: ['integer', 'null'], 'x-entity': { index: true } },
          createdAt: { type: 'string', format: 'date-time', 'x-entity': { index: true } },
          profile: { type: 'object', properties: { city: { type: 'string' } } },
        },
      },
    },
    Line: {
      schema: {
        type: 'object',
        required: ['order', 'seq'],
        properties: {
          order: { type: 'integer', 'x-entity': { key: true } },
          seq: { type: 'integer', 'x-entity': { key: true } },
          qty: { type: 'integer', 'x-entity': { index: true } },
        },
      },
    },
  },
};

/** Twelve users: ages tie in runs, scores tie and are null for some,
 * creation instants tie in pairs. */
const USERS = [
  ['u01', 20, 5, '2026-01-01T00:00:00Z'], ['u02', 20, null, '2026-01-01T00:00:00Z'],
  ['u03', 21, 5, '2026-01-02T00:00:00Z'], ['u04', 21, 7, '2026-01-02T00:00:00Z'],
  ['u05', 21, null, '2026-01-03T00:00:00Z'], ['u06', 22, 1, '2026-01-03T00:00:00Z'],
  ['u07', 22, null, '2026-01-04T00:00:00Z'], ['u08', 22, 7, '2026-01-04T00:00:00Z'],
  ['u09', 23, 5, '2026-01-05T00:00:00Z'], ['u10', 23, 1, '2026-01-05T00:00:00Z'],
  ['u11', 24, null, '2026-01-06T00:00:00Z'], ['u12', 24, 7, '2026-01-06T00:00:00Z'],
].map(([id, age, score, createdAt]) => ({ id, age, score, createdAt, profile: { city: 'ede' } }));

/** @type {any} */
let store = null;
/** @type {any} */
let users = null;

before(async () => {
  store = await openStore(MODEL, { driver: nodeDriver() });
  users = store.entity('User');
  for (const user of USERS) await users.create(user);
  const lines = store.entity('Line');
  for (const order of [1, 2, 3]) {
    for (const seq of [1, 2]) await lines.create({ order, seq, qty: order === 2 ? 5 : 3 });
  }
});
after(async () => {
  if (store !== null) await store.close();
});

/** Drain every page and answer the ids in page order plus the pages. */
async function drain(set, spec, options = {}) {
  const ids = [];
  const pages = [];
  let after_ = undefined;
  for (;;) {
    const page = await set.page(spec, { ...options, after: after_ });
    pages.push(page);
    ids.push(...page.items.map((row) => row.id ?? `${row.order}/${row.seq}`));
    if (!page.hasMore) break;
    after_ = page.continuation;
    assert.ok(after_ !== null, 'hasMore comes with a continuation');
  }
  return { ids, pages };
}

const codeIs = (code, pattern = undefined) => (error) =>
  error.code === code && (pattern === undefined || pattern.test(error.message));

describe('duplicate first-order values across composite pages produce no omissions or duplicates', () => {
  it('ascending and descending over a tying column, whatever the page size', async () => {
    const whole = (await users.asNoTracking().load({ orderBy: '$it.age' })).map((u) => u.id);
    assert.strictEqual(new Set(whole).size, USERS.length);
    for (const limit of [1, 2, 3, 5, 12, 50]) {
      const asc = await drain(users, { orderBy: '$it.age' }, { limit });
      assert.deepStrictEqual(asc.ids, whole, `limit ${limit}, ascending: the union is the whole set, in order`);
      const desc = await drain(users, { orderBy: { $key: '$it.age', $dir: 'desc' } }, { limit });
      assert.deepStrictEqual(new Set(desc.ids).size, USERS.length, `limit ${limit}, descending: no repeats`);
      assert.deepStrictEqual([...desc.ids].sort(), [...whole].sort(), `limit ${limit}, descending: no omissions`);
      const ages = desc.ids.map((id) => USERS.find((u) => u.id === id)?.age);
      assert.deepStrictEqual(ages, [...ages].sort((a, b) => b - a), 'descending by age');
    }
  });

  it('the expansion appends the primary key, and hasMore is exact', async () => {
    const { pages } = await drain(users, { orderBy: '$it.age' }, { limit: 5 });
    assert.deepStrictEqual(pages.map((page) => [page.items.length, page.hasMore]), [[5, true], [5, true], [2, false]]);
    const continuation = pages[0].continuation;
    assert.deepStrictEqual(continuation, {
      order: [{ column: 'age', desc: false, nullsFirst: true }, { column: 'id', desc: false, nullsFirst: true }],
      keys: [21],
      key: 'u05',
    });
    const explained = users.explainLoad({ orderBy: '$it.age', after: continuation });
    assert.strictEqual(explained.pagination, 'keyset');
    // nulls sort first ascending, so after 21 come the greater ages alone;
    // the tie-break branch appends the key
    assert.match(explained.sql, /WHERE \("r"\."age" > \? OR \("r"\."age" = \? AND "r"\."id" > \?\)\)/);
    assert.match(explained.sql, /ORDER BY "r"\."age" ASC NULLS FIRST, "r"\."id" ASC NULLS FIRST$/);
    // the continuation's identity is reported as `identity`; `order` is
    // the effective ORDER BY, which in keyset mode is the same terms
    // with the appended key marked as the tie-breaker it is
    assert.deepStrictEqual(explained.identity, continuation.order);
    assert.deepStrictEqual(explained.order, [
      { source: 'column', binding: null, column: 'age', path: null, desc: false, nullsFirst: true, tieBreaker: false },
      { source: 'column', binding: null, column: 'id', path: null, desc: false, nullsFirst: true, tieBreaker: true },
    ]);
    assert.strictEqual(explained.snapshot, false, 'age is not immutable: live pagination');
    // a page over the key alone is a snapshot, and appends nothing twice
    const byKey = users.explainLoad({ orderBy: '$it.id', after: { order: [{ column: 'id', desc: false, nullsFirst: true }], keys: ['u03'], key: 'u03' } });
    assert.strictEqual(byKey.snapshot, true);
    assert.deepStrictEqual(byKey.identity, [{ column: 'id', desc: false, nullsFirst: true }]);
    assert.deepStrictEqual(byKey.order, [
      { source: 'column', binding: null, column: 'id', path: null, desc: false, nullsFirst: true, tieBreaker: false },
    ]);
  });

  it('a composite primary key is appended whole, and the continuation carries it as a record', async () => {
    const lines = store.entity('Line');
    const { ids, pages } = await drain(lines, { orderBy: { $key: '$it.qty', $dir: 'desc' } }, { limit: 2 });
    assert.deepStrictEqual(ids, ['2/1', '2/2', '1/1', '1/2', '3/1', '3/2']);
    assert.deepStrictEqual(pages[0].continuation, {
      order: [
        { column: 'qty', desc: true, nullsFirst: false },
        { column: 'order', desc: false, nullsFirst: true },
        { column: 'seq', desc: false, nullsFirst: true },
      ],
      keys: [5],
      key: { order: 2, seq: 2 },
    });
  });

  it('an epoch column pages by the document instant: the continuation carries the string, the plan binds the epoch', async () => {
    const { ids, pages } = await drain(users, { orderBy: '$it.createdAt' }, { limit: 3 });
    assert.deepStrictEqual(ids, USERS.map((u) => u.id));
    assert.deepStrictEqual(pages[0].continuation.keys, ['2026-01-02T00:00:00Z']);
    const descending = await drain(users, { orderBy: { $key: '$it.createdAt', $dir: 'desc' } }, { limit: 5 });
    assert.deepStrictEqual(descending.ids, ['u11', 'u12', 'u09', 'u10', 'u07', 'u08', 'u05', 'u06', 'u03', 'u04', 'u01', 'u02']);
  });
});

describe('null ordering matches the explain plan', () => {
  const nullsOf = (ids) => ids.map((id) => USERS.find((u) => u.id === id)?.score === null);

  it('ascending and descending, with and without the $empty override — every row visited exactly once', async () => {
    const cases = [
      [{ $key: '$it.score' }, true],
      [{ $key: '$it.score', $empty: 'greatest' }, false],
      [{ $key: '$it.score', $dir: 'desc' }, false],
      [{ $key: '$it.score', $dir: 'desc', $empty: 'greatest' }, true],
    ];
    for (const [orderBy, nullsFirst] of cases) {
      const whole = (await users.asNoTracking().load({ orderBy })).map((u) => u.id);
      for (const limit of [1, 2, 4, 7]) {
        const { ids, pages } = await drain(users, { orderBy }, { limit });
        assert.deepStrictEqual(ids, whole, `${JSON.stringify(orderBy)} limit ${limit}: the pages are the whole load`);
        assert.strictEqual(pages[0].continuation.order[0].nullsFirst, nullsFirst);
        const flags = nullsOf(ids);
        const firstNonNull = flags.indexOf(false);
        const lastNull = flags.lastIndexOf(true);
        if (nullsFirst) assert.ok(lastNull < firstNonNull, 'the nulls come first');
        else assert.ok(flags.indexOf(true) > flags.lastIndexOf(false), 'the nulls come last');
      }
      const explained = users.explainLoad({ orderBy, after: { order: [
        { column: 'score', desc: orderBy.$dir === 'desc', nullsFirst },
        { column: 'id', desc: false, nullsFirst: true },
      ], keys: [null], key: 'u02' } });
      assert.match(explained.sql, new RegExp(`"r"\\."score" ${orderBy.$dir === 'desc' ? 'DESC' : 'ASC'} NULLS ${nullsFirst ? 'FIRST' : 'LAST'}`));
      // after a NULL key: the non-nulls follow when nulls sort first;
      // nothing but the tie-break branch when they sort last
      if (nullsFirst) assert.match(explained.sql, /"r"\."score" IS NOT NULL OR \("r"\."score" IS NULL AND "r"\."id" > /);
      else assert.match(explained.sql, /WHERE \(\("r"\."score" IS NULL AND "r"\."id" > \?\)\)/);
    }
  });
});

describe('a continuation belongs to exactly one ordering', () => {
  it('replayed against a different ordering, or malformed, it is JD0035 — never a wrong page', async () => {
    const first = await users.page({ orderBy: '$it.age' }, { limit: 3 });
    await assert.rejects(() => users.page({ orderBy: '$it.score' }, { limit: 3, after: first.continuation }),
      codeIs('JD0035', /emitted for the ordering \(age asc nulls first, id asc nulls first\); this graph orders by \(score asc nulls first, id asc nulls first\)/));
    await assert.rejects(() => users.page({ orderBy: { $key: '$it.age', $dir: 'desc' } }, { limit: 3, after: first.continuation }),
      codeIs('JD0035'));
    await assert.rejects(() => users.page({ orderBy: '$it.age' }, { limit: 3, after: { ...first.continuation, keys: [] } }),
      codeIs('JD0035', /carries 0 order-key value\(s\); the ordering declares 1/));
    await assert.rejects(() => users.page({ orderBy: '$it.age' }, { limit: 3, after: { ...first.continuation, key: { id: 'u03' } } }),
      codeIs('JD0035', /'key' must be the row's primary key, a scalar/));
    await assert.rejects(() => users.page({ orderBy: '$it.age' }, { limit: 3, after: /** @type {any} */ ('u03') }),
      codeIs('JD0035', /not a bare key/));
    await assert.rejects(() => store.entity('Line').page({ orderBy: '$it.qty' }, { limit: 3,
      after: { order: [{ column: 'qty', desc: false, nullsFirst: true }, { column: 'order', desc: false, nullsFirst: true },
        { column: 'seq', desc: false, nullsFirst: true }], keys: [3], key: 1 } }),
    codeIs('JD0035', /'key' must carry every key column \{ order, seq \}/));
    // a document path cannot carry a keyset, and neither can a take beside a page
    await assert.rejects(() => users.page({ orderBy: '$it.profile.city' }, { limit: 3 }),
      codeIs('JD0032', /a keyset orders by mapped columns/));
    await assert.rejects(() => users.page({ orderBy: '$it.age', take: 2 }, { limit: 3 }),
      codeIs('JD0032', /page\(\) windows by its limit/));
  });
});
