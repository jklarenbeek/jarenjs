//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { nodeWorkerPoolDriver } from '@jarenjs/db/node-pool';
import { nodeProcessDriver } from '@jarenjs/db/node-process';
import { wasmDriver } from '@jarenjs/db/wasm';

const key = { type: 'string', 'x-entity': { key: true } };
const model = { $model: '0.1', entities: {
  Item: { schema: { type: 'object', required: ['id'], properties: {
    id: key, tags: { 'x-entity': { relation: { to: 'Tag', many: true } } },
  } } },
  Tag: { schema: { type: 'object', required: ['id'], properties: { id: key } } },
} };
const hosts = [
  ['worker', () => nodeWorkerDriver({ maxStatements: 32 })],
  ['pool', () => nodeWorkerPoolDriver({ readers: 0, worker: { maxStatements: 32 } })],
];
if (!process.versions.bun) hosts.push(['process', () => nodeProcessDriver({ maxStatements: 32 })]);

async function withStore(driver, capture, use) {
  const store = await openStore(model, { driver, ...(capture ? { capture: { mode: 'journal' } } : {}) });
  try {
    await store.entity('Tag').create({ id: 't' });
    await use(store);
  }
  finally { await store.close(); }
}

for (const [host, driver] of hosts) {
  it(`${host}: 80 membership creations release their temporary insert statements`, async () => {
    await withStore(driver(), false, async (store) => {
      for (let n = 0; n < 80; n++) {
        const doc = { id: String(n).padStart(2, '0'), tags: ['t', 't'] };
        assert.deepEqual(await store.entity('Item').create(doc), doc);
      }
      assert.deepEqual(await store.entity('Item').load({ orderBy: '$it.id', include: { tags: true } }),
        Array.from({ length: 80 }, (_, n) => ({ id: String(n).padStart(2, '0'), tags: [{ id: 't' }] })));
    });
  });

  for (const attached of [false, true])
    it(`${host}: 80 journal deletions release ${attached ? 'populated' : 'empty'} membership reads and preserve patches`, async () => {
      await withStore(driver(), true, async (store) => {
        const patches = [];
        store.observe((record) => patches.push(record.patch));
        for (let n = 0; n < 80; n++) {
          const id = String(n);
          await store.entity('Item').create({ id, ...(attached ? { tags: ['t'] } : {}) });
          await store.entity('Item').delete(id);
          const membershipPath = `/Item_Tag/${JSON.stringify([id, 't'])}`;
          assert.deepEqual(patches.splice(0), [
            [{ op: 'add', path: `/Item/${id}`, value: { id } },
              ...(attached ? [{ op: 'add', path: membershipPath, value: { Item_key: id, Tag_key: 't' } }] : [])],
            [...(attached ? [{ op: 'remove', path: membershipPath }] : []), { op: 'remove', path: `/Item/${id}` }],
          ]);
        }
        assert.deepEqual(await store.entity('Item').load({ include: { tags: true } }), []);
        assert.deepEqual(await store.entity('Tag').load({}), [{ id: 't' }]);
      });
    });

  it(`${host}: 80 refused membership batches release their handles and roll back both rows and capture`, async () => {
    await withStore(driver(), true, async (store) => {
      const patches = [];
      store.observe((record) => patches.push(record.patch));
      for (let n = 0; n < 80; n++) {
        await assert.rejects(store.entity('Item').create({ id: String(n), tags: ['t', 'missing'] }), { code: 'JD2005' });
      }
      assert.deepEqual(patches, []);
      assert.deepEqual(await store.entity('Item').load({ include: { tags: true } }), []);
      assert.deepEqual(await store.execute(['$.Item_Tag[*]']), []);
      assert.deepEqual(await store.entity('Tag').load({}), [{ id: 't' }]);
    });
  });
}

it('native synchronous membership operations keep value returns and exact journal patches', async () => {
  const driver = process.versions.bun ? (await import('@jarenjs/db/bun')).bunDriver()
    : (await import('@jarenjs/db/node')).nodeDriver();
  await withStore(driver, true, async (store) => {
    const patches = [];
    store.observe((record) => patches.push(record.patch));
    const doc = { id: 'a', tags: ['t'] };
    assert.deepEqual(store.sync.entity('Item').create(doc), doc);
    assert.equal(store.sync.entity('Item').delete('a'), true);
    assert.deepEqual(patches, [
      [{ op: 'add', path: '/Item/a', value: { id: 'a' } },
        { op: 'add', path: '/Item_Tag/["a","t"]', value: { Item_key: 'a', Tag_key: 't' } }],
      [{ op: 'remove', path: '/Item_Tag/["a","t"]' }, { op: 'remove', path: '/Item/a' }],
    ]);
  });
});

/** Observe only the bounded membership cursor, excluding replication's other SQL. */
async function boundedStore(asynchronous) {
  const Native = process.versions.bun ? (await import('bun:sqlite')).Database
    : (await import('node:sqlite')).DatabaseSync;
  const database = new Native(':memory:');
  const records = [];
  const answer = (value) => asynchronous ? Promise.resolve(value) : value;
  const raw = {
    exec: (sql) => database.exec(sql), close: () => database.close(),
    prepare(sql) {
      const statement = database.prepare(sql);
      const record = /^SELECT "Item_key", "Tag_key" FROM "Item_Tag" WHERE .* LIMIT /.test(sql)
        ? { drained: false, finalized: 0 } : null;
      if (record !== null) records.push(record);
      return answer({
        run: (params = []) => answer(statement.run(...params)),
        get: (params = []) => answer(statement.get(...params) ?? undefined),
        all: (params = []) => answer(statement.all(...params)),
        iterate(params = []) {
          const source = statement.iterate(...params);
          return answer({
            next() {
              const step = source.next();
              if (record !== null && step.done) record.drained = true;
              return answer(step);
            },
            return() {
              if (record !== null) record.drained = true;
              return answer(source.return());
            },
          });
        },
        finalize() {
          if (record !== null) {
            assert.equal(record.drained, true, 'a membership statement stays live through the complete drain');
            assert.equal(record.finalized++, 0);
          }
          statement.finalize?.();
        },
      });
    },
  };
  const store = await openStore(model, { driver: wasmDriver({ synchronous: !asynchronous, open: () => raw }),
    capture: { mode: 'journal' }, replication: { replica: 'membership-owner', maxOperations: 2 } });
  return { store, records };
}

for (const asynchronous of [false, true]) for (const count of [0, 1, 3])
  it(`a bounded membership read releases after ${count > 2 ? 'refusing' : 'draining'} ${count} rows (${asynchronous ? 'Promise' : 'sync'} binding)`, async () => {
    const { store, records } = await boundedStore(asynchronous);
    try {
      await store.entity('Item').create({ id: 'a' });
      for (let n = 0; n < count; n++) {
        const id = String(n);
        await store.entity('Tag').create({ id });
        store.entity('Item').link('a', 'tags', id);
        await store.saveChanges();
      }
      const patches = [];
      store.observe((record) => patches.push(record.patch));
      if (count > 2) {
        await assert.rejects(store.entity('Item').delete('a'), { code: 'JD2106' });
        assert.deepEqual(patches, []);
        assert.deepEqual(await store.entity('Item').load({ include: { tags: true } }),
          [{ id: 'a', tags: Array.from({ length: count }, (_, n) => ({ id: String(n) })) }]);
      }
      else {
        assert.equal(await store.entity('Item').delete('a'), true);
        assert.deepEqual(patches, [[
          ...Array.from({ length: count }, (_, n) => ({ op: 'remove', path: `/Item_Tag/${JSON.stringify(['a', String(n)])}` })),
          { op: 'remove', path: '/Item/a' },
        ]]);
        assert.equal(await store.entity('Item').get('a'), undefined);
      }
      assert.deepEqual(records, [{ drained: true, finalized: 1 }]);
    }
    finally { await store.close(); }
  });
