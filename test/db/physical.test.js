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

it('codec-equivalent physical updates perform no effective writes', async () => {
  await fixture(async (store, db) => {
    await store.entity('Receipt').create({ body: 'AB' });
    const before = db.prepare('SELECT total_changes() AS n').get([]).n;
    for (let i = 0; i < 2; i++) assert.deepEqual(await store.entity('Receipt').update(1, { body: 'AB' }), { id: 1, body: 'ab' });
    assert.equal(db.prepare('SELECT total_changes() AS n').get([]).n, before);
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

it('physical keyset continuations page decoded text and bigint identities, and refuse a codec that cannot round-trip', async () => {
  await fixture(async (store) => {
    // a composite key of a bigint and a text column, renamed (`b`, `a`),
    // with two sequences one apart above 2^53: every row once, in key order
    const date = '2026-09-10T00:00:00.000Z';
    for (const [name, sequence] of [['b', '9007199254740994'], ['a', '9007199254740993'], ['c', '1'], ['a', '9007199254740994']])
      await store.entity('Pair').create({ name, sequence, amount: '1.00', date });
    /** @type {string[]} */
    const seen = [];
    /** @type {any} */
    let after;
    for (let pages = 0; pages < 10; pages++) {
      const page = await store.entity('Pair').page({}, { limit: 2, ...(after === undefined ? {} : { after }) });
      assert.equal(page.snapshot, true, 'ordered by the primary key alone');
      seen.push(...page.items.map((/** @type {any} */ item) => `${item.sequence}/${item.name}`));
      if (!page.hasMore) break;
      after = page.continuation;
    }
    assert.deepEqual(seen, ['1/c', '9007199254740993/a', '9007199254740994/a', '9007199254740994/b']);
  });
  // a uuid key reads back lowercase, whatever the table stores: refused, by codec
  const dir = mkdtempSync(join(tmpdir(), 'jaren-physical-uuid-'));
  const path = join(dir, 'uuid.sqlite');
  const db = await nodeDriver().open(path);
  db.exec('CREATE TABLE tokens(id TEXT PRIMARY KEY)');
  db.close();
  const model = { $model: '0.1', entities: { Token: { schema: { type: 'object', properties: {
    id: { type: 'string', 'x-entity': { key: true } } } },
  physical: { table: 'tokens', columns: { id: { name: 'id', codec: 'uuid', null: 'reject' } } } } } };
  const store = await openStore(model, { driver: nodeDriver(), path, adopt: true });
  try {
    await assert.rejects(store.entity('Token').page({}, { limit: 2 }),
      (/** @type {any} */ error) => error.code === 'JD0032' && /'id' is a uuid column/.test(error.message));
    await assert.rejects(store.entity('Token').load({ after: { order: [], keys: [], key: 'x' } }),
      (/** @type {any} */ error) => error.code === 'JD0032' && /uuid/.test(error.message));
  }
  finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
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

it('generated readbacks enforce store invariants, and tracked inputs cannot assign generated values', async () => {
  const db = await nodeDriver().open(':memory:');
  db.exec('CREATE TABLE generated(id INTEGER PRIMARY KEY,n INTEGER,doubled INTEGER GENERATED ALWAYS AS(n*2) STORED)');
  const model = { $model: '0.1', entities: { Row: { schema: { type: 'object', properties: {
    id: { type: 'integer', 'x-entity': { key: true } }, n: { type: 'integer' }, doubled: { type: 'integer' },
  } }, physical: { table: 'generated', columns: {
    id: { name: 'id', codec: 'integer', null: 'reject' }, n: { name: 'n', codec: 'integer', null: 'reject' },
    doubled: { name: 'doubled', codec: 'integer', null: 'reject', generated: true },
  } }, invariants: [{ name: 'bounded', on: ['insert', 'update'], enforcement: 'store', assert: { $le: ['$.new.doubled', 5] } }] } } };
  const store = await openStore(model, { driver: { ...nodeDriver(), open: async () => db }, adopt: true });
  try {
    await store.entity('Row').create({ id: 1, n: 2 });
    await assert.rejects(store.entity('Row').update(1, { n: 4 }), { code: 'JD2096' });
    assert.deepEqual(await store.entity('Row').get(1), { id: 1, n: 2, doubled: 4 });
    assert.throws(() => store.entity('Row').add({ id: 2, n: 2, doubled: 4 }), { code: 'JD2003' });
    await assert.rejects(store.entity('Row').mutate({ op: 'update', key: 1, set: { n: 1 } }), { code: 'JD0038' });
  }
  finally { await store.close(); }
});

it('same-arity physical updates bind their own column names and database defaults apply only on insert', async () => {
  const db = await nodeDriver().open(':memory:');
  db.exec("CREATE TABLE defaults(id TEXT PRIMARY KEY,a TEXT DEFAULT 'A',b TEXT DEFAULT 'B')");
  const model = { $model: '0.1', entities: { Row: { schema: { type: 'object', properties: {
    id: { type: 'string', 'x-entity': { key: true } }, a: { type: 'string' }, b: { type: 'string' },
  } }, physical: { table: 'defaults', columns: {
    id: { name: 'id', codec: 'text', null: 'reject' },
    a: { name: 'a', codec: 'text', null: 'absent', default: 'database' },
    b: { name: 'b', codec: 'text', null: 'absent', default: 'database' },
  } } } } };
  const store = await openStore(model, { driver: { ...nodeDriver(), open: async () => db }, adopt: true });
  try {
    await store.entity('Row').create({ id: 'x' });
    await store.entity('Row').update('x', { a: undefined });
    assert.deepEqual(await store.entity('Row').update('x', { a: 'new', b: undefined }), { id: 'x', a: 'new' });
    assert.deepEqual(await store.entity('Row').get('x'), { id: 'x', a: 'new' });
  }
  finally { await store.close(); }
});

it('a physical update assigns only the members it changes, in every shape it writes', async () => {
  const names = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6'];
  const model = { $model: '0.1', entities: { Row: { schema: { type: 'object', properties: {
    id: { type: 'integer', 'x-entity': { key: true } }, ...Object.fromEntries(names.map((name) => [name, { type: 'integer' }])),
  } }, physical: { table: 'rows', columns: { id: { name: 'id', codec: 'integer', null: 'reject' },
    ...Object.fromEntries(names.map((name) => [name, { name, codec: 'integer', null: 'reject' }])) } } } } };
  const db = await nodeDriver().open(':memory:');
  // an application's UPDATE OF trigger counts the statements that assign c0
  db.exec(`CREATE TABLE rows(id INTEGER PRIMARY KEY, ${names.map((name) => `${name} INTEGER`).join(', ')});
    INSERT INTO rows VALUES (1, ${names.map(() => 0).join(', ')}); CREATE TABLE hits(n INTEGER); INSERT INTO hits VALUES (0);
    CREATE TRIGGER counted AFTER UPDATE OF c0 ON rows BEGIN UPDATE hits SET n = n + 1; END;`);
  const store = await openStore(model, { driver: { ...nodeDriver(), open: async () => db }, adopt: true });
  try {
    // 127 assignment shapes: more than an entity keeps prepared
    for (let mask = 1; mask < 128; mask++)
      await store.entity('Row').update(1, Object.fromEntries(names.filter((_, i) => mask & (1 << i)).map((name) => [name, mask])));
    // a no-op writes nothing; a change to c1 alone does not assign c0
    await store.entity('Row').update(1, { c0: 127 });
    await store.entity('Row').update(1, { c1: 0 });
    assert.deepEqual(await store.entity('Row').get(1), { id: 1, ...Object.fromEntries(names.map((name) => [name, name === 'c1' ? 0 : 127])) });
    assert.equal(db.prepare('SELECT n FROM hits').get([]).n, 64);
  }
  finally { await store.close(); }
});
