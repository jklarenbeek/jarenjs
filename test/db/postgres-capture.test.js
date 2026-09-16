//@ts-check
/** Actual-server journal ordering, restart, rollback and pooled namespace oracles. */
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { openStore, CHANGES_TABLE, CHANGES_STATE_TABLE } from '@jarenjs/db';
import { postgresDriver, postgresNotifications } from '@jarenjs/db/postgres';
import { nodeDriver } from '@jarenjs/db/node';
import { applyJSONPatch } from '@jarenjs/json/patch';

const url = process.env.JAREN_PG_URL;
const model = { $model: '0.1', collections: { notes: { key: '/id',
  schema: { type: 'object', properties: { id: { type: 'string' }, body: { type: 'string' }, extra: {} } } } } };
const logged = { capture: { mode: 'journal', log: { retention: 100 } } };
const deferred = () => Promise.withResolvers();

describe('PostgreSQL committed journal', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  let pg, serial = 0;
  before(async () => { pg = (await import('pg')).default; });
  async function fixture(fn, max = 6) {
    const schema = `jaren_capture_${process.pid}_${serial++}`;
    const pool = new pg.Pool({ connectionString: url, max });
    const stores = [];
    const open = async (options = {}, source = pool) => {
      const store = await openStore(model, { driver: postgresDriver(source, { schema }), ...logged, ...options });
      stores.push(store);
      return store;
    };
    try {
      await pool.query(`CREATE SCHEMA "${schema}"`);
      await fn({ pool, schema, open });
    }
    finally {
      try { for (const store of stores) await store.close(); }
      finally {
        try { await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
        finally { await pool.end(); }
      }
    }
  }

  it('shares the SQLite journal patch contract, excludes rollback and nets savepoints/no-ops', async () => {
    await fixture(async ({ open }) => {
      const native = await open();
      const sqlite = await openStore(model, { driver: nodeDriver(), ...logged });
      try {
        for (const store of [native, sqlite]) {
          const seen = [];
          const unsubscribe = store.observe((r) => seen.push(r));
          await store.collection('notes').insert({ id: 'a', body: 'one', extra: { v: [1, 2] } });
          await assert.rejects(store.transaction(async (tx) => {
            await tx.collection('notes').insert({ id: 'rollback', body: 'absent' });
            throw new Error('rollback');
          }), /rollback/);
          await store.transaction(async (tx) => {
            await tx.collection('notes').patch('a', [{ op: 'replace', path: '/extra/v/1', value: 9 }]);
            await assert.rejects(tx.transaction(async (inner) => {
              await inner.collection('notes').put({ id: 'a', body: 'undone' });
              throw new Error('inner');
            }), /inner/);
            await tx.collection('notes').insert({ id: 'b', body: 'two' });
          });
          await store.collection('notes').put(await store.collection('notes').get('b'));
          await store.transaction(async (tx) => {
            await tx.collection('notes').insert({ id: 'net', body: 'gone' });
            await tx.collection('notes').delete('net');
          });
          assert.equal(await store.collection('notes').get('rollback'), undefined);
          assert.equal(seen.length, 2);
          assert.deepEqual(seen.map((r) => r.seq), [1, 2]);
          unsubscribe();
        }
        assert.deepEqual((await native.changesSince(0)).map((r) => r.patch),
          (await sqlite.changesSince(0)).map((r) => r.patch));
        assert.equal(native.capabilities.capture, 'journal');
        assert.equal(native.capabilities.sessions, false);
        assert.equal(native.capabilities.live, false);
      }
      finally { await sqlite.close(); }
    });
  });

  it('bounds pages and resumes retention across close/reopen, including finite fractional cursors', async () => {
    await fixture(async ({ open }) => {
      let store = await open({ capture: { mode: 'auto', log: { retention: 3 } } });
      for (let i = 1; i <= 5; i++)
        await store.collection('notes').insert({ id: String(i), body: 'x'.repeat(i * 100) });
      assert.deepEqual(await store.changes.page({ after: 0, limit: 1 }), {
        items: [], earliestAvailable: 3, highWatermark: 5, hasMore: false, resetRequired: true,
      });
      const first = await store.changes.page({ after: 2.5, limit: 1, maxBytes: 1000 });
      assert.deepEqual([first.items.map((r) => r.seq), first.next, first.hasMore], [[3], 3, true]);
      await assert.rejects(store.changes.page({ after: 3, maxBytes: 10 }), (e) => e.code === 'JD2074');
      const abort = new AbortController(); abort.abort();
      await assert.rejects(store.changes.page({ after: 3, signal: abort.signal }), (e) => e.code === 'JD2072');
      await store.close();
      store = await open();
      const page = await store.changes.page({ after: first.next, limit: 2, maxBytes: 2000 });
      assert.deepEqual(page.items.map((r) => r.seq), [4, 5]);
      assert.equal(page.hasMore, false);
      assert.deepEqual((await store.changesSince(-1e100)).map((r) => r.seq), [3, 4, 5]);
      assert.deepEqual((await store.changes.page({ after: 1e100 })).items, []);
      await assert.rejects(open({ capture: { mode: 'session', log: true } }), TypeError);
    });
  });

  it('creates the initial log state concurrently and gives every committed writer one distinct sequence', async () => {
    await fixture(async ({ open, pool, schema }) => {
      const stores = await Promise.all(Array.from({ length: 4 }, () => open()));
      await Promise.all(stores.map((store, i) => store.collection('notes').insert({ id: String(i), body: String(i) })));
      const page = await stores[0].changes.page({ after: 0, limit: 10 });
      assert.deepEqual(page.items.map((r) => r.seq), [1, 2, 3, 4]);
      assert.deepEqual(page.items.map((r) => r.patch[0].value.id).sort(), ['0', '1', '2', '3']);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM "${schema}"."${CHANGES_STATE_TABLE}"`)).rows[0].n, 1);
    });
  });

  it('keeps allocated but uncommitted records invisible, and waiting before-images reflect the first commit', async () => {
    await fixture(async ({ open, pool, schema }) => {
      const reached = deferred(), release = deferred();
      let armed = false;
      const source = { connect: async () => {
        const client = await pool.connect();
        return { release: (e) => client.release(e), query: async (query, values) => {
          const text = typeof query === 'string' ? query : query.text;
          if (armed && text === 'COMMIT') { armed = false; reached.resolve(); await release.promise; }
          return client.query(query, values);
        } };
      } };
      const first = await open({}, source), second = await open(), reader = await open();
      await first.collection('notes').insert({ id: 'same', body: 'initial' });
      armed = true;
      const writing = first.collection('notes').put({ id: 'same', body: 'first', extra: 1 });
      let waiting;
      try {
        await reached.promise;
        let settled = false;
        waiting = second.collection('notes').put({ id: 'same', body: 'second' }).then(() => { settled = true; });
        assert.deepEqual((await reader.changes.page({ after: 1 })).items, []);
        assert.equal((await reader.changes.bounds()).highWatermark, 1);
        assert.equal(settled, false);
        assert.equal((await pool.query(`SELECT doc->>'body' AS body FROM "${schema}".notes WHERE doc->>'id'='same'`)).rows[0].body, 'initial');
      }
      finally { release.resolve(); await writing; await waiting; }
      const records = (await reader.changes.page({ after: 0 })).items;
      assert.deepEqual(records.map((r) => r.seq), [1, 2, 3]);
      let doc = { notes: {} };
      for (const record of records) doc = applyJSONPatch(doc, record.patch);
      assert.deepEqual(doc.notes.same, await reader.collection('notes').get('same'));
      assert.equal('extra' in doc.notes.same, false, 'second patch removes the preceding committed extra property');
    });
  });

  it('resumes both commits when the first begun transaction reaches its journal after the later one', async () => {
    await fixture(async ({ open, pool }) => {
      const begun = deferred(), resume = deferred();
      let armed = false;
      const source = { connect: async () => {
        const client = await pool.connect();
        return { release: (e) => client.release(e), query: async (query, values) => {
          const sql = typeof query === 'string' ? query : query.text;
          if (armed && sql.includes('pg_advisory_xact_lock(1246907983')) {
            armed = false; begun.resolve(); await resume.promise;
          }
          return client.query(query, values);
        } };
      } };
      const first = await open({}, source), later = await open();
      armed = true;
      const pending = first.collection('notes').insert({ id: 'first-begun', body: 'later commit' });
      try {
        await begun.promise;
        await later.collection('notes').insert({ id: 'later-begun', body: 'first commit' });
        assert.equal((await later.changes.page({ after: 0 })).items[0].patch[0].value.id, 'later-begun');
      }
      finally { resume.resolve(); await pending; }
      assert.equal((await later.changes.page({ after: 1 })).items[0].patch[0].value.id, 'first-begun');
    });
  });

  it('continues durable history in a fresh process and refuses replication without an initial ledger', async () => {
    await fixture(async ({ open, schema }) => {
      const store = await open();
      await store.collection('notes').insert({ id: 'parent', body: 'one' });
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import pg from 'pg';
        import {openStore} from '@jarenjs/db';
        import {postgresDriver} from '@jarenjs/db/postgres';
        const pool = new pg.Pool({connectionString:process.env.JAREN_PG_URL,max:1});
        let store;
        try {
          store=await openStore(${JSON.stringify(model)},{driver:postgresDriver(pool,{schema:process.env.CAPTURE_SCHEMA}),${JSON.stringify(logged).slice(1, -1)}});
          if ((await store.changes.page({after:0})).items[0].seq!==1) throw new Error('missing history');
          await store.collection('notes').insert({id:'child',body:'two'});
          console.log(JSON.stringify((await store.changes.page({after:1})).items.map(x=>x.seq)));
        } finally { await store?.close(); await pool.end(); }
      `], { encoding: 'utf8', env: { ...process.env, CAPTURE_SCHEMA: schema } });
      assert.equal(child.status, 0, child.stderr);
      assert.deepEqual(JSON.parse(child.stdout), [2]);
      assert.equal((await store.changes.page({ after: 1 })).items[0].patch[0].value.id, 'child');
      await assert.rejects(open({ replication: { replica: 'unqualified' } }), (e) => e.code === 'JD2105');
    });
  });

  it('rolls back business rows when log persistence fails or its safe integer range is exhausted', async () => {
    await fixture(async ({ pool, schema, open }) => {
      const store = await open();
      await pool.query(`ALTER TABLE "${schema}"."${CHANGES_TABLE}" ADD CONSTRAINT reject_patch CHECK (source <> 'journal')`);
      await assert.rejects(store.collection('notes').insert({ id: 'rejected', body: 'no' }));
      assert.equal(await store.collection('notes').get('rejected'), undefined);
      assert.deepEqual(await store.changes.bounds(), { earliestAvailable: null, highWatermark: 0 });
      await pool.query(`ALTER TABLE "${schema}"."${CHANGES_TABLE}" DROP CONSTRAINT reject_patch`);
      await pool.query(`UPDATE "${schema}"."${CHANGES_STATE_TABLE}" SET high=$1`, [String(Number.MAX_SAFE_INTEGER)]);
      await assert.rejects(store.collection('notes').insert({ id: 'overflow', body: 'no' }), (e) => e.code === 'JD2005');
      assert.equal(await store.collection('notes').get('overflow'), undefined);
      assert.equal((await store.changes.bounds()).highWatermark, Number.MAX_SAFE_INTEGER);
    });
  });

  it('reconciles a lost commit reply from durable rows and log without replaying the write', async () => {
    await fixture(async ({ open, pool, schema }) => {
      let armed = false;
      const source = { connect: async () => {
        const client = await pool.connect();
        return { release: (e) => client.release(e), query: async (query, values) => {
          const result = await client.query(query, values);
          if (armed && (typeof query === 'string' ? query : query.text) === 'COMMIT') {
            armed = false;
            throw Object.assign(new Error('commit reply lost'), { code: '08006' });
          }
          return result;
        } };
      } };
      const writer = await open({}, source);
      const observed = [];
      writer.observe((record) => observed.push(record));
      armed = true;
      await assert.rejects(writer.collection('notes').insert({ id: 'receipt-row', body: 'committed' }), (e) => e.code === 'JD2087');
      assert.deepEqual(observed, [], 'an unknown reply does not claim a locally acknowledged commit');
      await writer.close();
      const reader = await open();
      assert.equal((await reader.collection('notes').get('receipt-row')).body, 'committed');
      assert.deepEqual((await reader.changes.page({ after: 0 })).items.map((r) => r.seq), [1]);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM "${schema}".notes`)).rows[0].n, 1);
    });
  });

  it('keeps reads, writes and log rows in their tenant despite pooled temporary names', async () => {
    await fixture(async ({ pool, schema, open }) => {
      let store = await open();
      await store.collection('notes').insert({ id: 'same', body: 'tenant-one' });
      await store.close();
      const before = (await pool.query('SHOW search_path')).rows[0].search_path;
      for (const table of ['notes', CHANGES_TABLE, CHANGES_STATE_TABLE]) {
        await pool.query(`CREATE TEMP TABLE "${table}" (LIKE "${schema}"."${table}" INCLUDING ALL)`);
        await pool.query(`INSERT INTO pg_temp."${table}" SELECT * FROM "${schema}"."${table}"`);
      }
      await pool.query(`UPDATE pg_temp.notes SET doc=jsonb_set(doc,'{body}','"temporary"')`);
      const other = `${schema}_other`;
      try {
        store = await open();
        assert.equal((await store.collection('notes').get('same')).body, 'tenant-one');
        await store.collection('notes').put({ id: 'same', body: 'changed-one' });
        assert.deepEqual((await store.changesSince(0)).map((r) => r.seq), [1, 2]);
        await store.close();
        await pool.query(`CREATE SCHEMA "${other}"`);
        const second = await openStore(model, { driver: postgresDriver(pool, { schema: other }), ...logged });
        try {
          assert.equal(await second.collection('notes').get('same'), undefined);
          await second.collection('notes').insert({ id: 'same', body: 'tenant-two' });
          assert.equal((await second.changes.page({ after: 0 })).items[0].patch[0].value.body, 'tenant-two');
        }
        finally { await second.close(); }
        assert.equal((await pool.query('SELECT doc->>\'body\' AS body FROM pg_temp.notes')).rows[0].body, 'temporary');
        assert.equal((await pool.query(`SELECT high::int FROM pg_temp."${CHANGES_STATE_TABLE}"`)).rows[0].high, 1);
        assert.equal((await pool.query('SHOW search_path')).rows[0].search_path, before);
      }
      finally {
        await store?.close();
        await pool.query(`DROP SCHEMA IF EXISTS "${other}" CASCADE`);
        for (const table of ['notes', CHANGES_TABLE, CHANGES_STATE_TABLE]) await pool.query(`DROP TABLE pg_temp."${table}"`);
      }
    }, 1);
  });

  it('uses empty transactional notifications and resumes durable rows after listener loss', async () => {
    await fixture(async ({ pool, schema, open }) => {
      const channel = `${schema}_wake`;
      const listenerPool = new pg.Pool({ connectionString: url, max: 1 });
      const pids = [];
      listenerPool.on('connect', (client) => pids.push(client.processID));
      const listener = postgresNotifications(listenerPool, {
        channel, maxReconnects: 1, retryBaseMs: 100, retryMaxMs: 100,
      });
      let writer;
      try {
        await listener.ready;
        assert.deepEqual(await listener.next(), { done: false, value: null });
        writer = await openStore(model, { driver: postgresDriver(pool, { schema, notifyChannel: channel }), ...logged });
        const reader = await open();
        const pull = listener.next();
        await assert.rejects(listener.next(), (e) => e.code === 'JD2091');
        await assert.rejects(writer.transaction(async (tx) => {
          await tx.collection('notes').insert({ id: 'rolled', body: 'absent' });
          throw new Error('rolled');
        }), /rolled/);
        await writer.collection('notes').insert({ id: 'one', body: 'one' });
        assert.deepEqual(await pull, { done: false, value: null });
        assert.deepEqual((await reader.changes.page({ after: 0 })).items.map((r) => r.seq), [1]);
        await pool.query('SELECT pg_terminate_backend($1)', [pids[0]]);
        await writer.collection('notes').insert({ id: 'offline', body: 'retained' });
        assert.deepEqual(await listener.next(), { done: false, value: null });
        assert.equal(listener.metrics().attempts, 2);
        assert.deepEqual((await reader.changes.page({ after: 1 })).items.map((r) => r.patch[0].value.id), ['offline']);
        // Distinct payloads cannot turn the one pending token into a queue.
        await pool.query('SELECT pg_notify($1, n::text) FROM generate_series(1,100) n', [channel]);
        assert.deepEqual(await listener.next(), { done: false, value: null });
        assert.ok(listener.metrics().coalesced <= 1);
      }
      finally {
        await listener.close(); await listener.close();
        await writer?.close(); await listenerPool.end();
      }
    });
  });

  it('drains a pending pull and UNLISTENs before returning its pooled listener session', async () => {
    await fixture(async ({ schema }) => {
      const pool = new pg.Pool({ connectionString: url, max: 1 });
      const channel = `${schema}_close`;
      const listener = postgresNotifications(pool, { channel });
      try {
        await listener.ready; await listener.next();
        const waiting = listener.next();
        const close = listener.close();
        assert.equal(listener.close(), close);
        await close;
        assert.deepEqual(await waiting, { done: true, value: undefined });
        assert.deepEqual(await listener.next(), { done: true, value: undefined });
        assert.deepEqual((await pool.query('SELECT pg_listening_channels() AS channel')).rows, []);
        assert.equal(listener.metrics().active, 0);
        await pool.query(`LISTEN "${channel}"`);
        const duplicate = postgresNotifications(pool, { channel });
        try {
          await assert.rejects(duplicate.ready, (e) => e.code === 'JD0003');
          assert.equal((await pool.query('SELECT pg_listening_channels() AS channel')).rows[0].channel, channel);
        }
        finally { await duplicate.close(); await pool.query(`UNLISTEN "${channel}"`); }
      }
      finally { await listener.close(); await pool.end(); }
    });
  });

  it('surfaces terminal listener disconnect after exhausting a zero reconnect budget', async () => {
    await fixture(async ({ pool, schema }) => {
      const source = new pg.Pool({ connectionString: url, max: 1 });
      let pid;
      source.on('connect', (client) => { pid = client.processID; });
      const listener = postgresNotifications(source, { channel: `${schema}_terminal`, maxReconnects: 0 });
      try {
        await listener.ready; await listener.next();
        const terminal = assert.rejects(listener.next(), (e) => typeof e.code === 'string');
        await pool.query('SELECT pg_terminate_backend($1)', [pid]);
        await terminal;
        assert.equal(listener.metrics().attempts, 1);
      }
      finally { await listener.close(); await source.end(); }
    });
  });
});
