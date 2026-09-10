//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, explainMapping } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';

export const physicalModel = { $model: '0.1', entities: {
  Setting: { schema: { type: 'object', properties: {
    id: { type: 'string', 'x-entity': { key: true } }, value: {}, updated: { type: 'string' },
  } }, physical: { table: 'app_settings', columns: {
    id: { name: 'key', codec: 'text', null: 'reject' },
    value: { name: 'value', codec: 'json', null: 'absent' },
    updated: { name: 'updated_at', codec: 'datetime', null: 'reject', default: 'database' },
  } } },
  Receipt: { schema: { type: 'object', properties: {
    id: { type: 'integer', 'x-entity': { key: true, default: 'auto' } }, body: { type: ['string', 'null'] },
  } }, physical: { table: 'receipt', columns: {
    id: { name: 'id', codec: 'integer', null: 'reject' }, body: { name: 'body', codec: 'blob-hex', null: 'null' },
  } } },
  Pair: { schema: { type: 'object', properties: {
    name: { type: 'string', 'x-entity': { key: true } }, sequence: { type: 'string', 'x-entity': { key: true } },
    amount: { type: 'string' }, date: { type: 'string' },
  } }, physical: { table: 'pair', keys: ['sequence', 'name'], columns: {
    name: { name: 'a', codec: 'text', null: 'reject' }, sequence: { name: 'b', codec: 'bigint', null: 'reject' },
    amount: { name: 'amount', codec: 'decimal', null: 'reject' }, date: { name: 'at', codec: 'epoch-ms', null: 'reject' },
  } } },
} };

async function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'jaren-physical-'));
  const path = join(dir, 'fixture.sqlite');
  let db = await nodeDriver().open(path);
  db.exec(`CREATE TABLE app_settings(key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL DEFAULT '2026-09-10T00:00:00.000Z');
    CREATE TABLE receipt(id INTEGER PRIMARY KEY, body BLOB);
    CREATE TABLE history(receipt_id INTEGER, body BLOB);
    CREATE TRIGGER receipt_history AFTER INSERT ON receipt BEGIN INSERT INTO history VALUES(NEW.id, NEW.body); END;
    CREATE TABLE pair(a TEXT, b INTEGER, amount TEXT, at INTEGER, PRIMARY KEY(b,a)) WITHOUT ROWID;`);
  db.close();
  const trace = [];
  const driver = { ...nodeDriver(), open: async (...args) => {
    db = await nodeDriver().open(...args);
    return { ...db, exec: (sql) => { trace.push(sql); return db.exec(sql); },
      prepare: (sql, opts) => { trace.push(sql); return db.prepare(sql, opts); } };
  } };
  let store;
  try { store = await openStore(physicalModel, { driver, path, adopt: true }); await fn(store, db, trace); }
  finally { if (store) await store.close(); rmSync(dir, { recursive: true, force: true }); }
}

it('adopts column-only settings, allocated keys, exact bytes and ordered identities without DDL', async () => {
  await fixture(async (store, db, trace) => {
    const setting = await store.entity('Setting').create({ id: 'locale', value: null });
    assert.deepEqual(setting, { id: 'locale', value: null, updated: '2026-09-10T00:00:00.000Z' });
    const receipt = await store.entity('Receipt').create({ body: '0001ff' });
    assert.deepEqual(receipt, { id: 1, body: '0001ff' });
    assert.equal(db.prepare('SELECT hex(body) AS v FROM history').get([]).v, '0001FF');
    const pair = { name: 'x\u001fy', sequence: '9007199254740993', amount: '123456789.00100', date: '2026-09-10T00:00:00.000Z' };
    assert.deepEqual(await store.entity('Pair').create(pair), pair);
    assert.deepEqual(await store.entity('Pair').get(pair), pair);
    assert.deepEqual(explainMapping(physicalModel).entities.Pair.keys, ['sequence', 'name']);
    assert.equal(await store.entity('Receipt').delete(1), true);
    assert.ok(!trace.some((sql) => /^(CREATE|ALTER|DROP)\b/i.test(sql)), trace.join('\n'));
  });
});

it('refuses lossy codecs and undeclared data, and identical updates write nothing', async () => {
  await fixture(async (store, db) => {
    await assert.rejects(() => store.entity('Receipt').create({ id: 9007199254740992, body: '01' }), { code: 'JD2003' });
    await assert.rejects(() => store.entity('Receipt').create({ body: 'not hex' }), { code: 'JD2003' });
    await assert.rejects(() => store.entity('Receipt').create({ body: '01', extra: 1 }), { code: 'JD2003' });
    await store.entity('Receipt').create({ id: 1, body: null });
    const before = db.prepare('SELECT total_changes() AS n').get([]).n;
    await store.entity('Receipt').update(1, { body: null });
    assert.equal(db.prepare('SELECT total_changes() AS n').get([]).n, before);
    assert.deepEqual(await store.entity('Receipt').update(1, { body: '0001ff' }), { id: 1, body: '0001ff' });
  });
});

it('queries decoded rows and saves tracked renamed columns with a no-op second save', async () => {
  await fixture(async (store) => {
    await store.entity('Receipt').create({ body: '0001ff' });
    assert.deepEqual(await store.execute({ $for: { r: '$.Receipt[*]' }, $return: '$r' }), { id: 1, body: '0001ff' });
    assert.deepEqual(await store.entity('Receipt').load({}), [{ id: 1, body: '0001ff' }]);
    await assert.rejects(store.entity('Setting').load({ where: { $eq: ['$it.value', 'a'] } }), /this codec or NULL policy requires decoded-row evaluation/);
    const row = await store.entity('Setting').create({ id: 'theme', value: { dark: false } });
    store.entity('Setting').put({ ...row, value: { dark: true } });
    assert.equal((await store.saveChanges()).updated, 1);
    assert.deepEqual((await store.entity('Setting').get('theme')).value, { dark: true });
    assert.equal((await store.saveChanges()).updated, 0);
  });
});

it('declared views refuse all direct and tracked writes before a statement', async () => {
  const db = await nodeDriver().open(':memory:');
  db.exec('CREATE TABLE source(id TEXT PRIMARY KEY, value TEXT); CREATE VIEW view_source AS SELECT * FROM source');
  const model = { $model: '0.1', entities: { View: { schema: { type: 'object', properties: {
    id: { type: 'string', 'x-entity': { key: true } }, value: { type: 'string' },
  } }, physical: { table: 'view_source', kind: 'view', columns: {
    id: { name: 'id', codec: 'text', null: 'reject' }, value: { name: 'value', codec: 'text', null: 'null' },
  } } } } };
  const store = await openStore(model, { driver: { ...nodeDriver(), open: async () => db }, adopt: true });
  try {
    await assert.rejects(store.entity('View').create({ id: 'x', value: 'v' }), { code: 'JD2003' });
    await assert.rejects(store.entity('View').update('x', { value: 'v' }), { code: 'JD2003' });
    await assert.rejects(store.entity('View').delete('x'), { code: 'JD2003' });
    assert.throws(() => store.entity('View').add({ id: 'x', value: 'v' }), { code: 'JD2003' });
  }
  finally { await store.close(); }
});

it('tracked database defaults read back and codec failures roll back inserted rows', async () => {
  await fixture(async (store, db) => {
    const pending = store.entity('Setting').add({ id: 'tracked', value: 7 });
    assert.equal((await store.saveChanges()).inserted, 1);
    assert.equal((await store.entity('Setting').get('tracked')).updated, '2026-09-10T00:00:00.000Z');
    void pending;
    await assert.rejects(store.entity('Setting').create({ id: 'bad', value: { n: NaN } }), { code: 'JD2003' });
    assert.equal(db.prepare("SELECT count(*) AS n FROM app_settings WHERE key='bad'").get([]).n, 0);
  });
});

it('physical keyset continuations refuse before using undecoded identities', async () => {
  await fixture(async (store) => {
    await assert.rejects(store.entity('Pair').page({}, { limit: 2 }), /column codecs require decoded identities/);
    await assert.rejects(store.entity('Pair').load({ after: { key: { sequence: '9', name: 'a' } } }), /column codecs require decoded identities/);
  });
});

it('renamed physical revisions detect a rival writer and preserve identical-save no-ops', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jaren-physical-version-'));
  const path = join(directory, 'version.sqlite');
  const model = { $model: '0.1', entities: { Doc: { schema: { type: 'object', properties: {
    id: { type: 'string', 'x-entity': { key: true } }, value: { type: 'string' },
    revision: { type: 'integer', 'x-entity': { version: true } },
  } }, physical: { table: 'documents', columns: {
    id: { name: 'key', codec: 'text', null: 'reject' }, value: { name: 'body', codec: 'text', null: 'reject' },
    revision: { name: 'rev', codec: 'integer', null: 'reject' },
  } } } } };
  let first, rival;
  try {
    const db = await nodeDriver().open(path);
    db.exec('CREATE TABLE documents(key TEXT PRIMARY KEY,body TEXT,rev INTEGER NOT NULL)'); db.close();
    first = await openStore(model, { driver: nodeDriver(), path, adopt: true });
    rival = await openStore(model, { driver: nodeDriver(), path, adopt: true });
    await first.entity('Doc').create({ id: 'x', value: 'old', revision: 0 });
    const mine = await first.entity('Doc').get('x');
    await rival.entity('Doc').update('x', { value: 'rival' });
    first.entity('Doc').put({ ...mine, value: 'mine' });
    await assert.rejects(first.saveChanges(), { code: 'JD2040' });
    first.entity('Doc').discard('x');
    const row = await first.entity('Doc').get('x');
    first.entity('Doc').put(row);
    assert.equal((await first.saveChanges()).updated, 0);
    assert.equal((await first.entity('Doc').asNoTracking().get('x')).revision, row.revision);
  }
  finally { await first?.close(); await rival?.close(); rmSync(directory, { recursive: true, force: true }); }
});

it('physical document-like names, generated values and scalar codecs survive every row reader', async () => {
  const db = await nodeDriver().open(':memory:');
  db.exec('CREATE TABLE scalar(id INTEGER PRIMARY KEY,"__doc" TEXT,doc TEXT,flag INTEGER,amount REAL,day TEXT,doubled REAL GENERATED ALWAYS AS(amount*2) STORED)');
  const columns = { id: ['id', 'integer'], marker: ['__doc', 'text'], payload: ['doc', 'json'],
    flag: ['flag', 'boolean'], amount: ['amount', 'number'], day: ['day', 'date'], doubled: ['doubled', 'number'] };
  const model = { $model: '0.1', entities: { Scalar: { schema: { type: 'object', properties: {
    id: { type: 'integer', 'x-entity': { key: true, default: 'auto' } }, marker: { type: 'string' },
    payload: {}, flag: { type: 'boolean' }, amount: { type: 'number' }, day: { type: 'string' }, doubled: { type: 'number' },
  } }, physical: { table: 'scalar', columns: Object.fromEntries(Object.entries(columns).map(([key, [name, codec]]) =>
    [key, { name, codec, null: 'reject', ...(key === 'doubled' ? { generated: true } : {}) }])) } } } };
  const store = await openStore(model, { driver: { ...nodeDriver(), open: async () => db }, adopt: true });
  try {
    const row = await store.entity('Scalar').create({ marker: 'kept', payload: { nested: null }, flag: true, amount: 1.25, day: '2026-09-10' });
    assert.deepEqual(row, { id: 1, marker: 'kept', payload: { nested: null }, flag: true, amount: 1.25, day: '2026-09-10', doubled: 2.5 });
    assert.deepEqual(await store.entity('Scalar').load({}), [row]);
    assert.deepEqual(await store.execute({ $for: { s: '$.Scalar[*]' }, $return: '$s' }), row);
    assert.equal((await store.entity('Scalar').update(1, { amount: 2.5 })).doubled, 5);
    await assert.rejects(store.entity('Scalar').update(1, { doubled: 10 }), { code: 'JD2003' });
    for (const bad of [{ amount: Infinity }, { flag: 1 }, { day: 'bad date' }])
      await assert.rejects(store.entity('Scalar').update(1, bad), { code: 'JD2003' });
  }
  finally { await store.close(); }
});

it('incomplete physical declarations refuse before opening a writable store', () => {
  for (const edit of [(m) => { delete m.entities.Receipt.physical.columns.body.codec; },
    (m) => { m.entities.Pair.physical.keys = ['name']; },
    (m) => { m.entities.Receipt.physical.columns.body.null = 'coerce'; }]) {
    const model = structuredClone(physicalModel); edit(model);
    assert.throws(() => explainMapping(model), { code: 'JD0005' });
  }
});
