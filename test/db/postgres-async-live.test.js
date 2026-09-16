//@ts-check
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { asyncLive } from '@jarenjs/db/async-live';
import { createDbSearch, createDbSearchStorage } from '@jarenjs/db/search';
import { postgresDriver } from '@jarenjs/db/postgres';
import { compileLexical } from '@jarenjs/core/search';

const url = process.env.JAREN_PG_URL;
const model = { $model: '0.1', collections: {
  notes: { key: '/id', schema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } } },
  snapshots: { key: '/id', schema: { type: 'object' } },
}, entities: { Item: { schema: { type: 'object', properties: {
  id: { type: 'string', 'x-entity': { key: true } }, title: { type: 'string' },
} } } } };
const all = [{ $for: { it: '$[*]' }, $orderby: ['$it.id'], $return: '$it' }];
const items = [{ $for: { it: '$.Item[*]' }, $orderby: ['$it.id'], $return: '$it' }];

describe('PostgreSQL asynchronous live and lexical freshness', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  let pg, sequence = 0;
  before(async () => { pg = (await import('pg')).default; });
  async function fixture(fn) {
    const schema = `jaren_async_live_${process.pid}_${sequence++}`;
    const pool = new pg.Pool({ connectionString: url, max: 6 }), stores = [];
    const open = async (options = {}, source = pool) => {
      const store = await openStore(model, { driver: postgresDriver(source, { schema }),
        capture: { mode: 'journal', log: { retention: 2 } }, live: asyncLive({ pollMs: 60000 }), ...options });
      stores.push(store); return store;
    };
    try { await pool.query(`CREATE SCHEMA "${schema}"`); await fn({ pool, schema, open }); }
    finally {
      try { for (const store of stores) await store.close(); }
      finally { try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } }
    }
  }

  it('resumes other Store commits, resets retention gaps and keeps collection/entity snapshots exact', async () => {
    await fixture(async ({ open }) => {
      const reader = await open(), writer = await open();
      await writer.collection('notes').insert({ id: 'a', title: 'tea' });
      const live = await reader.collection('notes').live(all), entity = await reader.live(items);
      const events = []; live.subscribe((event) => events.push(event));
      await live.refresh(); await entity.refresh();
      await writer.collection('notes').put({ id: 'a', title: 'coffee' });
      await writer.collection('notes').put({ id: 'a', title: 'cocoa' });
      await writer.entity('Item').create({ id: 'a', title: 'tea' });
      await live.refresh(); await entity.refresh();
      assert.deepEqual(live.result.rows, await reader.collection('notes').execute(all));
      assert.deepEqual(entity.result.rows, await reader.execute(items));
      assert.equal(events.at(-1).resetRequired, true);
      assert.equal(live.stats().checkpoint, 4);
      assert.equal(live.stats().resets, 1);
      const before = events.length;
      await assert.rejects(writer.transaction(async (tx) => {
        await tx.collection('notes').put({ id: 'a', title: 'rollback' }); throw new Error('rollback');
      }), /rollback/);
      await live.refresh(); assert.equal(events.length, before);
      await reader.close();
      assert.equal(live.state, 'closed'); assert.equal(entity.state, 'closed');
      const reopened = await open();
      const fresh = await reopened.collection('notes').live(all);
      assert.deepEqual(fresh.result.rows, [{ id: 'a', title: 'cocoa' }]);
    });
  });

  it('catches a real commit between the query snapshot and its final feed watermark', async () => {
    await fixture(async ({ pool, open }) => {
      const writer = await open();
      await writer.collection('notes').insert({ id: 'a', title: 'before' });
      let armed = false, intercepted = 0;
      const source = { connect: async () => {
        const client = await pool.connect(); let cursor;
        return { release: (error) => client.release(error), query: async (query, values) => {
          const text = typeof query === 'string' ? query : query.text;
          const result = await client.query(query, values);
          if (armed && text.startsWith('DECLARE ') && text.includes('FROM "notes"'))
            cursor = text.match(/^DECLARE "([^"]+)"/)[1];
          if (armed && cursor && text.startsWith('FETCH ') && text.endsWith(`"${cursor}"`)) {
            armed = false; intercepted++;
            await writer.collection('notes').put({ id: 'a', title: 'after' });
          }
          return result;
        } };
      } };
      const reader = await open({}, source); armed = true;
      const live = await reader.collection('notes').live(all);
      assert.equal(intercepted, 1);
      assert.deepEqual(live.result.rows, [{ id: 'a', title: 'after' }]);
      assert.equal(live.stats().checkpoint, 2);
      assert.equal(live.stats().reruns, 2, 'the mixed revision is never published');
      assert.equal(reader.stats().liveQueries, 1);
    });
  });

  it('keeps the shared ranker fresh across clients and makes external SQL coverage explicit', async () => {
    await fixture(async ({ pool, schema, open }) => {
      const reader = await open(), writer = await open();
      const definition = { version: 1, fields: ['title'] };
      const docs = [{ id: 'a', title: 'tea tea' }, { id: 'b', title: 'tea' }];
      for (const doc of docs) await writer.entity('Item').create(doc);
      const storage = createDbSearchStorage(reader, 'snapshots');
      let source = await createDbSearch(reader, 'Item', definition, { source: 'native', storage });
      let authoritative;
      const oracle = compileLexical(definition).create(); oracle.rebuild(docs);
      try {
        assert.deepEqual((await source.search('tea')).hits, oracle.search('tea').hits);
        assert.equal(source.explain().revision, 'capture');
        assert.equal(source.explain().nativeFTS, false);
        await writer.entity('Item').update('b', { title: 'coffee' });
        assert.deepEqual((await source.search('tea')).hits.map((hit) => hit.id), ['a']);
        // Persisting that derived cache also advances the global enrolled log.
        // Consume its revision before isolating an otherwise unenrolled edit.
        await source.refresh();
        await pool.query(`UPDATE "${schema}"."Item" SET title='coffee' WHERE id='a'`);
        assert.deepEqual((await source.search('tea')).hits.map((hit) => hit.id), ['a'], 'unenrolled SQL is outside capture freshness');
        authoritative = await createDbSearch(reader, 'Item', definition,
          { source: 'external', revision: 'authoritative' });
        assert.equal((await authoritative.search('tea')).total, 0);
        await source.dispose();
        source = await createDbSearch(reader, 'Item', definition, { source: 'native', storage });
        assert.equal((await source.search('tea')).total, 0, 'reopen hashes authoritative source content');
        const writes = source.stats().writes;
        assert.equal((await source.refresh()).changes, 0); assert.equal(source.stats().writes, writes);
      }
      finally { oracle.dispose(); await source.dispose(); await authoritative?.dispose(); }
    });
  });

  it('bounds repeated revision races, reports lag and catches up without publishing mixed reads', async () => {
    await fixture(async ({ pool, open }) => {
      const writer = await open();
      await writer.collection('notes').insert({ id: 'a', title: 'stable' });
      let churn = false, writes = 0;
      const source = { connect: async () => {
        const client = await pool.connect(); let cursor;
        return { release: (error) => client.release(error), query: async (query, values) => {
          const text = typeof query === 'string' ? query : query.text;
          const result = await client.query(query, values);
          if (text.startsWith('DECLARE ') && text.includes('FROM "notes"'))
            cursor = text.match(/^DECLARE "([^"]+)"/)[1];
          if (churn && cursor && text.startsWith('FETCH ') && text.endsWith(`"${cursor}"`)) {
            cursor = null;
            await writer.collection('notes').put({ id: 'a', title: `churn ${++writes}` });
          }
          return result;
        } };
      } };
      const reader = await open({ live: asyncLive({ pollMs: 60000, maxAttempts: 2 }) }, source);
      const live = await reader.collection('notes').live(all); await live.refresh();
      const events = []; live.subscribe((event) => events.push(event));
      await writer.collection('notes').put({ id: 'a', title: 'trigger' }); churn = true;
      await live.refresh();
      assert.equal(writes, 2);
      assert.deepEqual(live.result.rows, [{ id: 'a', title: 'stable' }]);
      assert.equal(live.stats().checkpoint, 1); assert.equal(live.stats().lag, true);
      assert.equal(events.length, 1); assert.equal(events[0].lag, true);
      churn = false;
      await writer.collection('notes').put({ id: 'a', title: 'stable' });
      await live.refresh();
      assert.deepEqual(live.result.rows, [{ id: 'a', title: 'stable' }]);
      assert.equal(live.stats().lag, false); assert.equal(live.stats().checkpoint, 5);
      assert.equal(events.at(-1).lag, false, 'lag recovery is observable even when rows return to the same value');
      await live.close(); churn = true;
      const before = writes;
      await assert.rejects(reader.collection('notes').live(all), { code: 'JD2060' });
      assert.equal(writes - before, 2); assert.equal(reader.stats().liveQueries, 0);
    });
  });

  it('drains an initial registration when the Store closes and never lends an active cursor', async () => {
    await fixture(async ({ pool, open }) => {
      const entered = Promise.withResolvers(), release = Promise.withResolvers();
      let held = false, armed = false;
      const source = { connect: async () => {
        const client = await pool.connect();
        return { release: (error) => client.release(error), query: async (query, values) => {
          const text = typeof query === 'string' ? query : query.text;
          const result = await client.query(query, values);
          if (armed && !held && text.startsWith('FETCH ')) {
            held = true; entered.resolve(); await release.promise;
          }
          return result;
        } };
      } };
      const reader = await open({}, source); armed = true;
      const registration = reader.collection('notes').live(all);
      const rejected = assert.rejects(registration);
      try {
        await entered.promise;
        assert.equal(reader.stats().liveQueries, 1);
        const closing = reader.close();
        release.resolve(); await rejected; await closing;
        assert.equal(reader.stats().liveQueries, 0);
        const clients = (await pool.query('SELECT 1 AS ready')).rows;
        assert.deepEqual(clients, [{ ready: 1 }]);
        const fresh = await open();
        const live = await fresh.collection('notes').live(all);
        assert.deepEqual(live.result.rows, []);
      }
      finally { release.resolve(); }
    });
  });

  it('polls other clients without a notification and preserves the native scan policy', async () => {
    await fixture(async ({ open, pool, schema }) => {
      const writer = await open();
      const reader = await open({ live: asyncLive({ pollMs: 10 }) });
      const live = await reader.collection('notes').live(all); await live.refresh();
      const changed = Promise.withResolvers();
      const stop = live.subscribe((event) => { if (event.seq === 1) changed.resolve(); });
      await writer.collection('notes').put({ id: 'a', title: 'polled' });
      await changed.promise;
      assert.deepEqual(live.result.rows, [{ id: 'a', title: 'polled' }]);
      stop(); await live.close();
      const restricted = await open({ profile: { refuseFullScan: true } });
      await assert.rejects(restricted.collection('notes').live(all), { code: 'JD0011' });
      assert.equal(restricted.stats().liveQueries, 0);
      const buffered = await open({ driver: postgresDriver(pool, { schema, cursorMode: 'buffered' }) });
      assert.equal(buffered.capabilities.live, false); assert.deepEqual(buffered.capabilities.liveModes, []);
      await assert.rejects(buffered.collection('notes').live(all), { code: 'JD0051' });
    });
  });
});
