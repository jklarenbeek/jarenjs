//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { statementCountingDriver } from './helpers.js';

const model = { $model: '0.1', entities: { Item: { schema: {
  type: 'object', required: ['id'], properties: {
    id: { type: 'integer', 'x-entity': { key: true } },
    rank: { type: 'integer', 'x-entity': { index: true } },
    text: { type: 'string' },
  },
} } } };
const document = { $for: { i: '$.Item[*]' }, $orderby: '$i.id', $return: '$i' };
async function fixture(options = {}) {
  const counters = { iterate: 0, next: 0, return: 0, all: 0 };
  const store = await openStore(model, { driver: statementCountingDriver(counters), ...options });
  for (let id = 1; id <= 7; id++) store.sync.entity('Item').create({ id, rank: id % 3, text: 'é😀' });
  Object.assign(counters, { iterate: 0, next: 0, return: 0, all: 0 });
  return { store, counters, items: store.sync.entity('Item') };
}

describe('synchronous entity cursors and pages', () => {
  for (const method of ['cursor', 'loadCursor']) {
    it(`${method} is lazy and releases once on break or a consumer throw`, async () => {
      const { store, counters, items } = await fixture();
      try {
        for (const fail of [false, true]) {
          const cursor = items[method](method === 'cursor' ? document : { orderBy: '$it.id' });
          const before = { ...counters };
          assert.equal(cursor[Symbol.iterator](), cursor);
          const consume = () => {
            for (const row of cursor) {
              assert.equal(row.id, 1);
              if (fail) throw new Error('consumer');
              break;
            }
          };
          if (fail) assert.throws(consume, /consumer/); else consume();
          cursor.return();
          cursor[Symbol.dispose]();
          assert.equal(counters.iterate - before.iterate, 1);
          assert.equal(counters.next - before.next, 1);
          assert.equal(counters.return - before.return, 1);
          assert.equal(counters.all, 0);
        }
      }
      finally { await store.close(); }
    });
  }
  it('matches async composite keyset pages, byte bounds and continuations exactly', async () => {
    const { store, items } = await fixture();
    try {
      let after;
      const seen = [];
      do {
        const spec = { orderBy: '$it.rank' };
        const options = { limit: 2, after, maxBytes: 120 };
        const sync = items.page(spec, options);
        assert.equal(sync.then, undefined);
        assert.deepEqual(sync, await store.entity('Item').page(spec, options));
        seen.push(...sync.items.map((item) => item.id));
        after = sync.hasMore ? sync.continuation : undefined;
      } while (after !== undefined);
      assert.deepEqual(seen, [3, 6, 1, 4, 7, 2, 5]);
      const first = items.page({ orderBy: '$it.id' }, { limit: 1 });
      assert.throws(() => items.page({ orderBy: '$it.rank' }, { after: first.continuation }), { code: 'JD0035' });
      assert.throws(() => items.page({ orderBy: '$it.id' }, { maxBytes: 1 }), { code: 'JD2074' });
    }
    finally { await store.close(); }
  });
  it('checks row, byte, abort and deadline limits before delivery', async () => {
    let now = 10;
    const { store, items } = await fixture({ runtime: { now: () => now } });
    try {
      const rows = items.loadCursor({}, { profile: { maxRows: 1 } });
      assert.equal(rows.next().done, false);
      assert.throws(() => rows.next(), { code: 'JD2007' });
      const byteSize = Buffer.byteLength(JSON.stringify(items.get(1)));
      assert.equal(items.loadCursor({}, { profile: { maxBytes: byteSize } }).next().done, false);
      assert.throws(() => items.loadCursor({}, { profile: { maxBytes: byteSize - 1 } }).next(), { code: 'JD2076' });
      const deadline = items.loadCursor({}, { deadline: 10 });
      deadline.next();
      now = 11;
      assert.throws(() => deadline.next(), { code: 'JD2075' });
      const controller = new AbortController();
      const aborted = items.loadCursor({}, { signal: controller.signal });
      aborted.next();
      controller.abort();
      assert.throws(() => aborted.next(), { code: 'JD2072' });
    }
    finally { await store.close(); }
  });
  it('store close releases active sources and rejects later entry with JD2063', async () => {
    const { store, items, counters } = await fixture();
    const cursor = items.loadCursor();
    cursor.next();
    await store.close();
    assert.equal(counters.return, 1);
    assert.throws(() => items.loadCursor(), { code: 'JD2063' });
    assert.throws(() => items.page(), { code: 'JD2063' });
    assert.throws(() => cursor.next(), { code: 'JD2063' });
  });
});

describe('synchronous cursor transaction scopes', () => {
  it('retains scope identity through nested transactions and permits cleanup after scope settlement', async () => {
    const { store } = await fixture();
    let escaped;
    try {
      await store.transaction(async (tx) => {
        const items = tx.sync.entity('Item');
        escaped = items.loadCursor();
        assert.equal(escaped.next().value.id, 1);
        const cursor = items.cursor(document);
        assert.equal(cursor.next().value.id, 1);
        await tx.transaction(async (inner) => {
          assert.throws(() => escaped.next(), { code: 'JD2070' });
          assert.equal(inner.sync.entity('Item').page({}, { limit: 1 }).items.length, 1);
        });
        cursor[Symbol.dispose]();
        assert.equal(escaped.next().value.id, 2);
      });
      assert.throws(() => escaped.next(), { code: 'JD2070' });
      escaped[Symbol.dispose]();
      assert.equal(store.sync.entity('Item').get(1).id, 1);
    }
    finally { await store.close(); }
  });
});
