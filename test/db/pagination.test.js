//@ts-check
/**
 * @file Pagination through `load`: keyset over a unique ordering
 * column (the `WHERE k > ?` form — never a growing OFFSET), offset
 * when asked for a skip, both reported by `explainLoad`; a keyset walk
 * visits every row exactly once and agrees with the offset pages; the
 * refusals when the ordering cannot carry a cursor.
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
        required: ['id', 'email'],
        properties: {
          id: { type: 'string', 'x-entity': { key: true } },
          email: { type: 'string', 'x-entity': { unique: true } },
          age: { type: 'integer', 'x-entity': { index: true } },
          profile: { type: 'object', properties: { city: { type: 'string' } } },
        },
      },
    },
  },
};

/** @type {any} */
let store = null;
/** @type {any} */
let users = null;

before(async () => {
  store = await openStore(MODEL, { driver: nodeDriver() });
  users = store.entity('User');
  for (let i = 1; i <= 9; i++) {
    await users.create({
      id: `u${i}`, email: `m${i}@x.test`, age: 20 + (i % 4),
      profile: { city: i % 2 === 0 ? 'ede' : 'breda' },
    });
  }
});
after(async () => {
  if (store !== null) await store.close();
});

describe('keyset pagination', () => {
  it('a cursor walk visits every row exactly once, in order', async () => {
    const seen = [];
    let after_ = undefined;
    for (;;) {
      const page = await users.load({ orderBy: '$it.id', take: 4, after: after_ });
      if (page.length === 0) break;
      seen.push(...page.map((u) => u.id));
      after_ = page[page.length - 1].id;
    }
    assert.deepStrictEqual(seen,
      ['u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9']);
    assert.strictEqual(
      users.explainLoad({ orderBy: '$it.id', take: 4, after: 'u4' }).pagination,
      'keyset');
    assert.match(
      users.explainLoad({ orderBy: '$it.id', take: 4, after: 'u4' }).sql,
      /"id" > /, 'the cursor is a WHERE bound, not an OFFSET');
  });

  it('the keyset page equals the offset page', async () => {
    const keyset = await users.load({ orderBy: '$it.id', take: 3, after: 'u3' });
    const offset = await users.load({ orderBy: '$it.id', take: 3, skip: 3 });
    assert.deepStrictEqual(keyset.map((u) => u.id), ['u4', 'u5', 'u6']);
    assert.deepStrictEqual(offset.map((u) => u.id), keyset.map((u) => u.id));
    assert.strictEqual(
      users.explainLoad({ orderBy: '$it.id', take: 3, skip: 3 }).pagination,
      'offset');
    assert.match(
      users.explainLoad({ orderBy: '$it.id', take: 3, skip: 3 }).sql,
      /LIMIT 3 OFFSET 3/);
  });

  it('descending cursors flip the bound', async () => {
    const page = await users.load({
      orderBy: { $key: '$it.id', $dir: 'desc' }, take: 2, after: 'u7',
    });
    assert.deepStrictEqual(page.map((u) => u.id), ['u6', 'u5']);
    assert.match(
      users.explainLoad({
        orderBy: { $key: '$it.id', $dir: 'desc' }, take: 2, after: 'u7',
      }).sql, /"id" < /);
  });

  it('any unique column carries a cursor, and a filter rides along', async () => {
    const page = await users.load({
      where: { $ge: ['$it.age', 21] },
      orderBy: '$it.email', take: 3, after: 'm2@x.test',
    });
    assert.ok(page.length > 0);
    assert.ok(page.every((u) => u.age >= 21 && u.email > 'm2@x.test'));
    assert.strictEqual(users.explainLoad({
      orderBy: '$it.email', take: 3, after: 'm2@x.test',
    }).pagination, 'keyset');
  });

  it('a plain load reports no pagination; skip: 0 is none', () => {
    assert.strictEqual(users.explainLoad({ orderBy: '$it.id' }).pagination, 'none');
    assert.strictEqual(
      users.explainLoad({ orderBy: '$it.id', take: 2, skip: 0 }).pagination,
      'none');
  });

  it('a cursor without a unique single-column ordering is refused', async () => {
    const code = (error) => {
      assert.strictEqual(/** @type {any} */ (error).code, 'JD0032');
      assert.match(/** @type {any} */ (error).message, /keyset/);
      return true;
    };
    // a non-unique column cannot anchor a cursor
    await assert.rejects(
      () => users.load({ orderBy: '$it.age', take: 2, after: 21 }), code);
    // a document path cannot either
    await assert.rejects(
      () => users.load({ orderBy: '$it.profile.city', take: 2, after: 'breda' }), code);
    // two ordering keys leave the cursor ambiguous
    await assert.rejects(
      () => users.load({ orderBy: ['$it.email', '$it.id'], take: 2, after: 'm2@x.test' }),
      code);
    // no ordering at all
    await assert.rejects(() => users.load({ take: 2, after: 'u3' }), code);
  });
});

describe('a scalar cursor over a unique column that may hold NULL', () => {
  const MEMBERS = {
    $model: '0.1',
    entities: {
      Member: {
        schema: {
          type: 'object',
          required: ['id', 'email'],
          properties: {
            id: { type: 'string', 'x-entity': { key: true } },
            email: { type: 'string', 'x-entity': { unique: true } },
            nick: { type: ['string', 'null'], 'x-entity': { unique: true } },
            // optional, and typed as a plain string: a member a document may simply lack is NULL in its column
            handle: { type: 'string', 'x-entity': { unique: true } },
          },
        },
      },
      // a key the schema does not list as required: the column is its primary key, and no row lacks it
      Tag: {
        schema: {
          type: 'object',
          properties: { code: { type: 'string', 'x-entity': { key: true } } },
        },
      },
    },
  };
  /** The rows: three nicknames, three members without one (a unique column holds many NULLs). */
  const ROWS = [['a', 'n1'], ['b', null], ['c', 'n3'], ['d', null], ['e', 'n5'], ['f', null]];

  /** @type {any} */
  let store = null;
  /** @type {any} */
  let members = null;
  before(async () => {
    store = await openStore(MEMBERS, { driver: nodeDriver() });
    members = store.entity('Member');
    for (const [id, nick] of ROWS) {
      await members.create({ id, email: `${id}@x.test`, ...(nick === null ? {} : { nick, handle: `h${nick.slice(1)}` }) });
    }
  });
  after(async () => {
    if (store !== null) await store.close();
  });

  const refusedForNulls = (/** @type {any} */ error) => {
    assert.strictEqual(error.code, 'JD0032');
    assert.match(error.message, /past 'nick': the column may hold NULL/);
    assert.match(error.message, /page\(\)/);
    return true;
  };
  const ids = async (/** @type {any} */ spec) => (await members.load(spec)).map((/** @type {any} */ m) => m.id);

  it('an ordering that sorts the NULLs after the values is refused, where a value cannot reach them', async () => {
    // descending, nulls last by default: `nick < 'n5'` would never see b, d and f
    await assert.rejects(() => members.load({ orderBy: { $key: '$it.nick', $dir: 'desc' }, take: 2, after: 'n5' }), refusedForNulls);
    // ascending with the empties greatest: the same rows, last again
    await assert.rejects(() => members.load({ orderBy: { $key: '$it.nick', $empty: 'greatest' }, take: 2, after: 'n3' }), refusedForNulls);
    assert.throws(() => members.explainLoad({ orderBy: { $key: '$it.nick', $dir: 'desc' }, take: 2, after: 'n5' }), refusedForNulls);
  });

  it('a member the model does not require is as nullable as one typed so: its documents may lack it', async () => {
    const refusedForHandle = (/** @type {any} */ error) => {
      assert.strictEqual(error.code, 'JD0032');
      assert.match(error.message, /past 'handle': the column may hold NULL/);
      return true;
    };
    await assert.rejects(() => members.load({ orderBy: { $key: '$it.handle', $dir: 'desc' }, take: 2, after: 'h5' }), refusedForHandle);
    await assert.rejects(() => members.load({ orderBy: { $key: '$it.handle', $empty: 'greatest' }, take: 2, after: 'h3' }), refusedForHandle);
    assert.deepStrictEqual(await ids({ orderBy: '$it.handle', take: 2, after: 'h3' }), ['e']);
    // the key is NOT NULL whatever the schema requires, and a required member never lacks a value
    assert.deepStrictEqual(await ids({ orderBy: { $key: '$it.id', $dir: 'desc' }, take: 2, after: 'd' }), ['c', 'b']);
    const tags = store.entity('Tag');
    for (const code of ['a', 'b', 'c', 'd']) await tags.create({ code });
    assert.deepStrictEqual((await tags.load({ orderBy: { $key: '$it.code', $dir: 'desc' }, take: 2, after: 'd' })).map((/** @type {any} */ t) => t.code), ['c', 'b']);
  });

  it('an ordering that sorts the NULLs before the values keeps its cursor, and page() visits every row either way', async () => {
    assert.deepStrictEqual(await ids({ orderBy: '$it.nick', take: 2, after: 'n3' }), ['e']);
    assert.deepStrictEqual(await ids({ orderBy: { $key: '$it.nick', $dir: 'desc', $empty: 'greatest' }, take: 2, after: 'n3' }), ['a']);
    for (const orderBy of [{ $key: '$it.nick', $dir: 'desc' }, { $key: '$it.nick', $empty: 'greatest' }, '$it.nick']) {
      const seen = [];
      let after_ = undefined;
      for (;;) {
        const page = await members.page({ orderBy }, { limit: 2, ...(after_ === undefined ? {} : { after: after_ }) });
        seen.push(...page.items.map((/** @type {any} */ m) => m.id));
        if (!page.hasMore) break;
        after_ = page.continuation;
      }
      assert.deepStrictEqual([...seen].sort(), ['a', 'b', 'c', 'd', 'e', 'f'], JSON.stringify(orderBy));
    }
  });

  it('a required member typed without null keeps its descending cursor', async () => {
    assert.deepStrictEqual(await ids({ orderBy: { $key: '$it.email', $dir: 'desc' }, take: 2, after: 'd@x.test' }), ['c', 'b']);
  });
});
