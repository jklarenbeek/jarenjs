//@ts-check
import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openStore, encodeReplication } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';
import { replicationModel, replicaState, deliverySchedule } from './oracle/replication.js';

const url = process.env.JAREN_PG_URL;

describe('PostgreSQL managed replication', { skip: !url && 'JAREN_PG_URL is not set' }, () => {
  let pg, sequence = 0;
  before(async () => { pg = (await import('pg')).default; });
  async function fixture(fn) {
    const prefix = `jaren_replication_${process.pid}_${sequence++}`;
    const pool = new pg.Pool({ connectionString: url, max: 8 });
    const stores = [], schemas = new Set();
    const open = async (backend, replica, config = {}, options = {}, source = pool) => {
      const schema = `${prefix}_${replica}`;
      if (backend === 'postgres' && !schemas.has(schema)) {
        await pool.query(`CREATE SCHEMA "${schema}"`); schemas.add(schema);
      }
      const { model = replicationModel, ...storeOptions } = options;
      const store = await openStore(model, {
        driver: backend === 'postgres' ? postgresDriver(source, { schema }) : nodeDriver(),
        capture: { mode: 'journal', log: true }, replication: { replica, ...config }, ...storeOptions,
      });
      stores.push(store); return store;
    };
    try { await fn({ open, pool, prefix }); }
    finally {
      try { for (const store of stores) await store.close(); }
      finally {
        try { for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
        finally { await pool.end(); }
      }
    }
  }

  for (const [from, to] of [['postgres', 'sqlite'], ['sqlite', 'postgres'], ['postgres', 'postgres']])
    it(`${from} to ${to} preserves canonical transactions, membership, values and duplicate revisions`, async () => {
      await fixture(async ({ open }) => {
        const source = await open(from, 'source'), target = await open(to, 'target');
        const oracle = await open('sqlite', 'source');
        const write = async (store) => {
          await store.transaction(async (tx) => {
            await tx.collection('notes').put({ id: 'x/~😀', n: 1 });
            await tx.collection('notes').put({ id: 'x/~😀', n: Number.MAX_SAFE_INTEGER,
              extra: { exact: '9007199254740993', flag: true, nullable: null, unicode: 'é😀', values: [0.125, -2, false] } });
            await tx.entity('Tag').create({ id: 't' });
            await tx.entity('Parent').create({ id: 'p', tags: ['t'] });
          });
          await store.entity('Parent').update('p', { name: 'updated' });
          await assert.rejects(store.transaction(async (tx) => {
            await tx.collection('notes').delete('x/~😀'); throw new Error('abort');
          }), /abort/);
          await store.entity('Parent').delete('p');
        };
        await write(source); await write(oracle);
        const envelopes = (await source.replication.page()).items;
        assert.deepEqual(envelopes.map(encodeReplication), (await oracle.replication.page()).items.map(encodeReplication));
        for (const envelope of envelopes) {
          assert.equal((await target.replication.apply(envelope)).status, 'applied');
          const before = await target.changes.page({ after: 0 });
          assert.equal((await target.replication.apply(envelope)).status, 'duplicate');
          assert.deepEqual(await target.changes.page({ after: 0 }), before);
        }
        assert.deepEqual(await replicaState(target), await replicaState(oracle));
        assert.equal((await target.replication.page()).items.length, 0);
        await target.collection('notes').put({ id: 'local', n: 4 });
        const own = (await target.replication.page()).items[0];
        assert.equal(own.seq, 1); assert.deepEqual(own.frontier, { source: 3 });
        await source.replication.apply(own);
        assert.deepEqual(await replicaState(source), await replicaState(target));
      });
    });

  it('serializes native writers and concurrent duplicate delivery through the shared capture owner', async () => {
    await fixture(async ({ open }) => {
      const a = await open('postgres', 'same');
      const [b, c] = await Promise.all([open('postgres', 'same'), open('postgres', 'same')]);
      await Promise.all(Array.from({ length: 18 }, (_, n) => [a, b, c][n % 3].collection('notes').put({ id: String(n), n })));
      const envelopes = (await a.replication.page()).items;
      assert.deepEqual(envelopes.map((entry) => entry.seq), Array.from({ length: 18 }, (_, i) => i + 1));
      assert.deepEqual(await b.replication.frontier(), { same: 18 });
      const x = await open('postgres', 'target'), y = await open('postgres', 'target');
      for (const envelope of envelopes) {
        const results = await Promise.all([x.replication.apply(envelope), y.replication.apply(envelope)]);
        assert.deepEqual(results.map((result) => result.status).sort(), ['applied', 'duplicate']);
      }
      assert.deepEqual(await replicaState(a), await replicaState(y));
      assert.equal((await y.changes.page({ after: 0, limit: 100 })).items.length, 18);
      assert.equal((await y.replication.page()).items.length, 0);
    });
  });

  it('retains causal gaps, conflict claims and deterministic resolution provenance across reopen', async () => {
    await fixture(async ({ open }) => {
      const a = await open('sqlite', 'a'), b = await open('postgres', 'b');
      for (let n = 0; n < 8; n++) await a.collection('notes').put({ id: 'shared', n });
      const envelopes = (await a.replication.page()).items;
      for (const envelope of deliverySchedule(envelopes, { seed: 31, drop: [3] })) {
        const before = await b.replication.frontier();
        try { await b.replication.apply(envelope); }
        catch (error) { assert.equal(error.code, 'JD2100'); assert.deepEqual(await b.replication.frontier(), before); }
      }
      for (const envelope of envelopes) await b.replication.apply(envelope);
      assert.deepEqual(await replicaState(b), await replicaState(a));
      await a.collection('notes').put({ id: 'shared', n: 9 });
      await b.collection('notes').put({ id: 'shared', n: 10 });
      const contender = (await a.replication.page({ after: 8 })).items[0];
      const result = await b.replication.apply(contender);
      assert.equal(result.status, 'conflict');
      assert.deepEqual(result.frontier, { a: 8, b: 1 });
      const evidence = (await b.replication.conflicts())[0];
      assert.equal(evidence.base.n, 7); assert.equal(evidence.local.value.n, 10); assert.equal(evidence.remote.value.n, 9);
      const changed = structuredClone(contender); changed.operations[0].after.n = 99;
      await assert.rejects(b.replication.apply(changed), { code: 'JD2101' });
      await b.close();
      const resolver = { id: 'max-n-v1', resolve: (conflict) => ({ action: 'merged', value: {
        ...conflict.local.value, n: Math.max(conflict.local.value.n, conflict.remote.value.n),
      } }) };
      const reopened = await open('postgres', 'b', { resolver });
      assert.equal((await reopened.replication.apply(contender)).status, 'applied');
      const revision = await reopened.changes.page({ after: 0 });
      assert.equal((await reopened.replication.apply(contender)).status, 'duplicate');
      assert.deepEqual(await reopened.changes.page({ after: 0 }), revision);
      assert.equal((await reopened.replication.conflicts())[0].resolver, resolver.id);
      assert.deepEqual((await reopened.replication.conflicts())[0].resolution, { action: 'merged', value: { id: 'shared', n: 10 } });
      await reopened.close();
      const twice = await open('postgres', 'b', { resolver });
      assert.equal((await twice.replication.apply(contender)).status, 'duplicate');
      assert.deepEqual(await twice.replication.frontier(), { a: 9, b: 1 });
    });
  });

  it('bounds retained outboxes and complete bootstrap documents without clearing receipt proofs', async () => {
    await fixture(async ({ open, pool, prefix }) => {
      const source = await open('postgres', 'source', { retention: 2 });
      const target = await open('sqlite', 'target');
      for (let n = 0; n < 5; n++) await source.collection('notes').put({ id: 'same', n });
      const page = await source.replication.page({ after: 0 });
      assert.equal(page.resetRequired, true); assert.deepEqual(page.items, []);
      const retained = (await pool.query(`SELECT count(*) AS count, sum(octet_length(payload)) AS bytes FROM "${prefix}_source"._jaren_replica_outbox`)).rows[0];
      assert.equal(Number(retained.count), 2); assert.ok(Number(retained.bytes) > 0 && Number(retained.bytes) < 2000);
      await assert.rejects(source.replication.page({ after: 3, maxBytes: 1 }), { code: 'JD2074' });
      await assert.rejects(source.replication.page({ after: 3, signal: AbortSignal.abort() }), { code: 'JD2064' });
      const snapshot = await source.replication.snapshot();
      assert.equal(snapshot.rows.length, 1); assert.equal(snapshot.receipts.length, 5);
      assert.equal((await target.replication.reset(snapshot)).status, 'reset');
      const mark = await target.changes.page({ after: 0 });
      await target.replication.reset(snapshot);
      assert.deepEqual(await target.changes.page({ after: 0 }), mark);
      for (const receipt of snapshot.receipts) assert.equal((await target.replication.apply(receipt)).status, 'duplicate');
      const native = await open('postgres', 'target');
      await native.replication.reset(snapshot);
      assert.deepEqual(await replicaState(native), await replicaState(source));
      await native.replication.reset(snapshot);
      assert.equal((await native.changes.page({ after: 0 })).items.length, 1);
      await assert.rejects(source.replication.snapshot({ maxBytes: 1 }), { code: 'JD2074' });
      await assert.rejects(source.replication.snapshot({ maxBytes: NaN }), TypeError);
      await assert.rejects(source.replication.snapshot({ maxBytes: new TextEncoder().encode(JSON.stringify(snapshot)).length - 1 }), { code: 'JD2074' });
      const small = await open('postgres', 'source', { maxOperations: 2 });
      await assert.rejects(small.replication.snapshot(), { code: 'JD2106' });
      await assert.rejects(small.transaction(async (tx) => {
        for (let n = 0; n < 3; n++) await tx.collection('notes').put({ id: `too-many-${n}`, n });
      }), { code: 'JD2106' });
      assert.deepEqual(await small.replication.frontier(), { source: 5 });
      await native.collection('notes').put({ id: 'local', n: 1 });
      await assert.rejects(native.replication.reset(snapshot), { code: 'JD2105' });
    });
  });

  it('reconciles a lost commit reply from its receipt without replaying a managed effect', async () => {
    await fixture(async ({ open, pool }) => {
      const origin = await open('sqlite', 'origin');
      await origin.collection('notes').put({ id: 'receipt', n: 1 });
      const envelope = (await origin.replication.page()).items[0];
      let lose = false, lost = 0;
      const source = { connect: async () => {
        const client = await pool.connect();
        return { release: (error) => client.release(error), query: async (query, values) => {
          const result = await client.query(query, values);
          if (lose && (typeof query === 'string' ? query : query.text) === 'COMMIT') {
            lose = false; lost++;
            throw Object.assign(new Error('replication commit reply lost'), { code: '08006' });
          }
          return result;
        } };
      } };
      const target = await open('postgres', 'target', {}, {}, source);
      lose = true;
      await assert.rejects(target.replication.apply(envelope), { code: 'JD2087' });
      await target.close();
      const reader = await open('postgres', 'target');
      assert.equal((await reader.replication.apply(envelope)).status, 'duplicate');
      assert.equal((await reader.collection('notes').get('receipt')).n, 1);
      assert.equal((await reader.changes.page({ after: 0 })).items.length, 1);
      assert.equal(lost, 1);
    });
  });

  it('keeps restrict relations exact while ordinary writes still enforce each statement', async () => {
    await fixture(async ({ open }) => {
      const model = structuredClone(replicationModel);
      model.entities.Parent.schema.properties.children = { 'x-entity': {
        relation: { to: 'Tag', many: true, via: 'parentId', onDelete: 'restrict' },
      } };
      model.entities.Tag.schema.properties.parentId = { type: 'string' };
      const origin = await open('sqlite', 'origin', {}, { model });
      const target = await open('postgres', 'target', {}, { model });
      await origin.transaction(async (tx) => {
        await tx.entity('Parent').create({ id: 'p' });
        await tx.entity('Tag').create({ id: 't', parentId: 'p' });
      });
      await target.replication.apply((await origin.replication.page()).items[0]);
      await assert.rejects(target.entity('Parent').delete('p'), (error) => error.code === 'JD2005' && error.cause?.code === '23503');
      await origin.transaction(async (tx) => {
        await tx.entity('Tag').delete('t'); await tx.entity('Parent').delete('p');
      });
      const deletion = (await origin.replication.page({ after: 1 })).items[0];
      assert.equal(deletion.operations[0].table, 'Parent', 'canonical order differs from the original deletion order');
      await target.replication.apply(deletion);
      assert.deepEqual(await replicaState(target), await replicaState(origin));
      await target.close();
      const reopened = await open('postgres', 'target', {}, { model });
      assert.equal((await reopened.replication.apply(deletion)).status, 'duplicate');
    });
  });

  it('refuses undeclared membership effects and external row histories atomically', async () => {
    await fixture(async ({ open, pool, prefix }) => {
      const source = await open('sqlite', 'source'), target = await open('postgres', 'target');
      await source.transaction(async (tx) => {
        await tx.entity('Tag').create({ id: 't' }); await tx.entity('Parent').create({ id: 'p', tags: ['t'] });
      });
      await target.replication.apply((await source.replication.page()).items[0]);
      const before = await replicaState(target), revision = await target.changes.page({ after: 0 });
      await source.entity('Parent').delete('p');
      const deletion = (await source.replication.page({ after: 1 })).items[0];
      await assert.rejects(target.replication.apply({ ...deletion, operations: deletion.operations.filter((op) => op.table === 'Parent') }), { code: 'JD2104' });
      assert.deepEqual(await replicaState(target), before);
      assert.deepEqual(await target.changes.page({ after: 0 }), revision);
      await target.replication.apply(deletion);
      await source.collection('notes').put({ id: 'external', n: 1 });
      const insert = (await source.replication.page({ after: 2 })).items[0];
      await target.replication.apply(insert);
      await pool.query(`UPDATE "${prefix}_target".notes SET doc=$1::jsonb WHERE doc->>'id'=$2`, [JSON.stringify({ id: 'external', n: 99 }), 'external']);
      await source.collection('notes').put({ id: 'external', n: 2 });
      await assert.rejects(target.replication.apply((await source.replication.page({ after: 3 })).items[0]), { code: 'JD2104' });
      assert.deepEqual(await target.replication.frontier(), { source: 3 });
      assert.equal((await target.collection('notes').get('external')).n, 99);
    });
  });

  it('applies a self-referencing graph in canonical order and bootstraps its cycle', async () => {
    await fixture(async ({ open }) => {
      const model = { $model: '0.1', entities: { Node: { schema: { type: 'object', properties: {
        id: { type: 'string', 'x-entity': { key: true } }, parentId: { type: 'string' },
        children: { 'x-entity': { relation: { to: 'Node', many: true, via: 'parentId', onDelete: 'restrict' } } },
      } } } } };
      const origin = await open('sqlite', 'origin', {}, { model });
      const target = await open('postgres', 'target', {}, { model });
      await origin.transaction(async (tx) => {
        await tx.entity('Node').create({ id: 'a' });
        await tx.entity('Node').create({ id: 'b', parentId: 'a' });
        await tx.entity('Node').update('a', { parentId: 'b' });
      });
      const envelope = (await origin.replication.page()).items[0];
      await target.replication.apply(envelope);
      assert.deepEqual(await target.entity('Node').get('a'), { id: 'a', parentId: 'b' });
      assert.deepEqual(await target.entity('Node').get('b'), { id: 'b', parentId: 'a' });
      const bootstrap = await open('postgres', 'bootstrap', {}, { model });
      await bootstrap.replication.reset(await target.replication.snapshot());
      assert.equal((await bootstrap.replication.apply(envelope)).status, 'duplicate');
      assert.deepEqual(await bootstrap.entity('Node').get('a'), await target.entity('Node').get('a'));
    });
  });

  it('verifies metadata types, existing foreign keys and external effects before enrollment', async () => {
    await fixture(async ({ open, pool, prefix }) => {
      const store = await open('postgres', 'target'); await store.close();
      const schema = `${prefix}_target`;
      const foreignKeys = (await pool.query(`SELECT k.conname FROM pg_catalog.pg_constraint k
        JOIN pg_catalog.pg_class c ON c.oid=k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname=$1 AND c.relname='Parent_Tag' AND k.contype='f' ORDER BY k.conname`, [schema])).rows;
      assert.equal(foreignKeys.length, 2);
      const fk = `"${foreignKeys[0].conname.replaceAll('"', '""')}"`;
      await pool.query(`CREATE FUNCTION "${schema}".ignore_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`INSERT INTO "${schema}"._jaren_replica_outbox(seq,payload) VALUES ($1,'{}')`, [Number.MAX_SAFE_INTEGER]);
        assert.equal((await client.query(`SELECT seq::text FROM "${schema}"._jaren_replica_outbox`)).rows[0].seq, String(Number.MAX_SAFE_INTEGER));
        await client.query('ROLLBACK');
      }
      finally { client.release(); }
      for (const [sql, restore, code] of [
        [`ALTER TABLE "${schema}"._jaren_replica_outbox ALTER COLUMN seq TYPE INTEGER`, `ALTER TABLE "${schema}"._jaren_replica_outbox ALTER COLUMN seq TYPE BIGINT`, 'JD0002'],
        [`ALTER TABLE "${schema}"._jaren_replica_receipts ENABLE ROW LEVEL SECURITY`, `ALTER TABLE "${schema}"._jaren_replica_receipts DISABLE ROW LEVEL SECURITY`, 'JD0051'],
        [`CREATE RULE ignore_insert AS ON INSERT TO "${schema}".notes DO INSTEAD NOTHING`, `DROP RULE ignore_insert ON "${schema}".notes`, 'JD0051'],
        [`CREATE TRIGGER extra_effect BEFORE UPDATE ON "${schema}".notes FOR EACH ROW EXECUTE FUNCTION "${schema}".ignore_update()`, `DROP TRIGGER extra_effect ON "${schema}".notes`, 'JD0051'],
        [`CREATE TABLE "${schema}".external_child(id text PRIMARY KEY, parent text REFERENCES "${schema}"."Parent"(id) ON DELETE CASCADE)`, `DROP TABLE "${schema}".external_child`, 'JD0051'],
        [`ALTER TABLE "${schema}"."Parent_Tag" ALTER CONSTRAINT ${fk} NOT DEFERRABLE`, `ALTER TABLE "${schema}"."Parent_Tag" ALTER CONSTRAINT ${fk} DEFERRABLE`, 'JD0051'],
      ]) {
        await pool.query(sql);
        await assert.rejects(open('postgres', 'target'), { code });
        await pool.query(restore);
      }
      const reopened = await open('postgres', 'target');
      assert.deepEqual(await reopened.replication.frontier(), {});
      await reopened.close();
      await pool.query(`DELETE FROM "${schema}"._jaren_replica; INSERT INTO "${schema}"._jaren_replica_claims(id,payload) VALUES ('unowned','{}')`);
      await assert.rejects(open('postgres', 'target'), { code: 'JD2104' });
      assert.equal((await pool.query(`SELECT count(*) AS n FROM "${schema}"._jaren_replica_claims`)).rows[0].n, '1');
      const cascade = structuredClone(replicationModel);
      cascade.entities.Parent.schema.properties.children = { 'x-entity': {
        relation: { to: 'Tag', many: true, via: 'parentId', onDelete: 'cascade' },
      } };
      cascade.entities.Tag.schema.properties.parentId = { type: 'string' };
      await assert.rejects(open('postgres', 'cascade', {}, { model: cascade }), { code: 'JD0051' });
      await assert.rejects(open('postgres', 'physical', {}, { model: { $model: '0.1', entities: { Item: {
        schema: { type: 'object', properties: { id: { type: 'integer', 'x-entity': { key: true } } } },
        physical: { table: 'items', columns: { id: { name: 'id', codec: 'integer', null: 'reject' } } },
      } } } }), { code: 'JD0051' });
    });
  });

  for (const phase of ['receipt', 'checkpoint', 'commit', 'acknowledged'])
    it(`recovers after a process dies at ${phase} and remains settled on a second restart`, async () => {
      await fixture(async ({ open, prefix }) => {
        const source = await open('sqlite', 'source'), target = await open('postgres', 'target');
        await source.collection('notes').put({ id: 'durable', n: 7 });
        const envelope = (await source.replication.page()).items[0];
        await target.close();
        const child = spawnSync(process.execPath, ['--no-warnings=ExperimentalWarning',
          fileURLToPath(new URL('./postgres-replication-crash-child.js', import.meta.url)),
          `${prefix}_target`, phase, JSON.stringify(envelope)],
        { env: { JAREN_PG_URL: url }, encoding: 'utf8', timeout: 20000 });
        assert.equal(child.error, undefined); assert.equal(child.stderr, '');
        assert.equal(child.stdout, `crash:${phase}\n`);
        assert.equal(child.signal, process.platform === 'win32' ? null : 'SIGKILL');
        assert.equal(child.status, process.platform === 'win32' ? 1 : null);
        const committed = phase === 'commit' || phase === 'acknowledged';
        const first = await open('postgres', 'target');
        assert.deepEqual(await first.replication.frontier(), committed ? { source: 1 } : {});
        assert.equal((await first.collection('notes').get('durable'))?.n, committed ? 7 : undefined);
        assert.equal((await first.replication.apply(envelope)).status, committed ? 'duplicate' : 'applied');
        await first.close();
        const second = await open('postgres', 'target');
        assert.equal((await second.replication.apply(envelope)).status, 'duplicate');
        assert.equal((await second.collection('notes').get('durable')).n, 7);
        assert.equal((await second.changes.page({ after: 0 })).items.length, 1);
        assert.equal((await second.replication.page()).items.length, 0);
      });
    });
});
