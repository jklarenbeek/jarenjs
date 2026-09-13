//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { migrate, shapeHash, createModelShape, openConnection, sqliteDialect } from '@jarenjs/db';

const driver = process.versions.bun
  ? (await import('@jarenjs/db/bun')).bunDriver()
  : (await import('@jarenjs/db/node')).nodeDriver();
const key = (type) => ({ type, 'x-entity': { key: true } });
const column = (name, codec, nullPolicy = 'reject', extra = {}) => ({ name, codec, null: nullPolicy, ...extra });
const modelFor = (properties, columns, extra = {}) => ({ $model: '0.1', entities: { Row: {
  schema: { type: 'object', properties }, physical: { table: 'rows', columns, ...extra },
} } });
const transform = (model, body) => ({ kind: 'jslt', collection: 'Row', model,
  stylesheet: [{ match: '$', body }] });
const document = (id, model, steps) => ({ $migration: '0.1', id, from: shapeHash(model), to: shapeHash(model), steps });
async function fixture(run) {
  const directory = mkdtempSync(join(tmpdir(), 'jaren-physical-transform-'));
  const path = join(directory, 'fixture.sqlite');
  const db = await driver.open(path);
  const apply = (model, migrations, options = {}) => migrate({ driver, path }, migrations,
    { baseline: model, batchSize: 1, shadow: false, ...options });
  try { await run(db, apply, path); }
  finally { await db.close(); rmSync(directory, { recursive: true, force: true }); }
}

it('physical transform previews count the historical aliased table without changing data or history', async () => fixture(async (db, apply) => {
  const before = modelFor({ id: key('integer'), value: { type: 'string' } }, {
    id: column('item_id', 'integer'), value: column('label', 'text'),
  });
  const after = { $model: '0.1', entities: { Renamed: { ...before.entities.Row,
    physical: { ...before.entities.Row.physical, table: 'renamed_rows' },
  } } };
  db.exec("CREATE TABLE rows(item_id INTEGER PRIMARY KEY,label TEXT); INSERT INTO rows VALUES(1,'old'),(2,'kept')");
  const migration = { ...document('preview', before, [transform(before, { value: 'changed' }),
    { kind: 'ddl', sql: 'ALTER TABLE rows RENAME TO renamed_rows' }]), to: shapeHash(after) };
  const report = await apply(before, [migration], { model: after, dryRun: true });
  assert.deepEqual(report, { dryRun: true, pending: ['preview'],
    statements: ["-- jslt transform over 'Row'", 'ALTER TABLE rows RENAME TO renamed_rows'],
    counts: { Row: 2 }, shadowValidated: false });
  assert.deepEqual(db.prepare('SELECT item_id,label FROM rows ORDER BY item_id').all([]).map((row) => ({ ...row })),
    [{ item_id: 1, label: 'old' }, { item_id: 2, label: 'kept' }]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name IN ('_jaren_migrations','renamed_rows')").get([]).n, 0);
}));

it('physical transforms use aliased keys and only changed columns, preserving raw bytes and database ownership', async () => fixture(async (db, apply) => {
  const model = modelFor({ id: key('integer'), payload: { type: 'object' }, bytes: { type: 'string' }, amount: { type: 'number' },
    doubled: { type: 'number' }, note: { type: 'string' }, revision: { type: 'integer', 'x-entity': { version: true } },
    updated: { type: 'string', 'x-entity': { default: 'updated' } } }, {
    id: column('rid', 'integer'), payload: column('doc', 'json'), bytes: column('raw_bytes', 'blob-hex'),
    amount: column('amount', 'number'), doubled: column('doubled', 'number', 'reject', { generated: true }),
    note: column('note', 'text', 'absent', { default: 'database' }), revision: column('revision', 'integer'), updated: column('updated', 'text'),
  });
  db.exec("CREATE TABLE rows(rid INTEGER PRIMARY KEY,doc TEXT,raw_bytes BLOB,amount REAL,doubled REAL GENERATED ALWAYS AS(amount*2),note TEXT DEFAULT 'fallback',revision INTEGER,updated TEXT);CREATE TABLE audit(kind TEXT);CREATE TRIGGER amount_changed AFTER UPDATE OF amount ON rows BEGIN INSERT INTO audit VALUES('amount');END;CREATE TRIGGER untouched AFTER UPDATE OF rid,doc,raw_bytes,note,revision,updated ON rows BEGIN INSERT INTO audit VALUES('untouched');END");
  for (const id of [-8, 17, 23]) db.prepare('INSERT INTO rows(rid,doc,raw_bytes,amount,note,revision,updated) VALUES(?,?,?,1,?,9,?)')
    .run([id, '{ "kept" : true }', new Uint8Array([0, 127, 255]), id === -8 ? 'stored' : null, 'old']);
  const steps = [transform(model, { payload: '$.payload', bytes: '$.bytes', amount: { $add: ['$.amount', 1] }, revision: '$.revision', updated: '$.updated' })];
  const first = document('change', model, steps), progress = [];
  assert.deepEqual((await apply(model, [first], { onProgress: (event) => progress.push(event) })).applied, ['change']);
  assert.equal(progress.at(-1).transformed, 3);
  const read = () => db.prepare('SELECT rid,doc,hex(raw_bytes) AS bytes,amount,doubled,note,revision,updated FROM rows ORDER BY rid').all([]).map((row) => ({ ...row }));
  assert.deepEqual(read(), [-8, 17, 23].map((rid) => ({ rid, doc: '{ "kept" : true }', bytes: '007FFF', amount: 2, doubled: 4, note: rid === -8 ? 'stored' : null, revision: 9, updated: 'old' })));
  assert.deepEqual(db.prepare('SELECT kind FROM audit').all([]).map((row) => row.kind), ['amount', 'amount', 'amount']);
  const noop = document('same', model, [transform(model, '$')]);
  progress.length = 0;
  await apply(model, [first, noop], { onProgress: (event) => progress.push(event) });
  assert.equal(progress.at(-1).transformed, 0);
  const saved = read();
  assert.deepEqual((await apply(model, [first, noop])).applied, []);
  assert.deepEqual(read(), saved);
  assert.equal(db.prepare('SELECT count(*) AS n FROM audit').get([]).n, 3);
  assert.equal(db.prepare('SELECT count(*) AS n FROM _jaren_migrations').get([]).n, 2);
}));

it('physical keyset transforms preserve exact bigint/composite keys across NOCASE and descending WITHOUT ROWID keys', async () => fixture(async (db, apply) => {
  const model = modelFor({ sequence: key('string'), tenant: key('string'), value: { type: 'integer' } }, {
    sequence: column('seq', 'bigint'), tenant: column('scope', 'text'), value: column('value', 'integer'),
  }, { keys: ['tenant', 'sequence'], withoutRowid: true });
  db.exec('CREATE TABLE rows(scope TEXT COLLATE NOCASE,seq INTEGER,value INTEGER,PRIMARY KEY(scope DESC,seq DESC)) WITHOUT ROWID');
  const keys = [['z', '9223372036854775807'], ['A', '-9223372036854775808'], ['a', '9007199254740993'], ['ä', '17'], ['z', '-9007199254740993']];
  for (const [scope, seq] of keys) db.prepare('INSERT INTO rows VALUES(?,?,0)').run([scope, seq]);
  const before = db.prepare('SELECT scope,CAST(seq AS TEXT) AS seq FROM rows ORDER BY scope COLLATE BINARY,seq').all([]).map((row) => ({ ...row }));
  const migration = document('composite', model, [transform(model, { value: { $add: ['$.value', 1] } })]);
  await apply(model, [migration]);
  assert.deepEqual(db.prepare('SELECT scope,CAST(seq AS TEXT) AS seq FROM rows ORDER BY scope COLLATE BINARY,seq').all([]).map((row) => ({ ...row })), before);
  assert.deepEqual(db.prepare('SELECT value FROM rows').all([]).map((row) => row.value), [1, 1, 1, 1, 1]);
  assert.deepEqual((await apply(model, [migration])).applied, []);
}));

for (const [label, body, code] of [
  ['key change', { id: 2, value: 3 }, 'JD0023'],
  ['unknown member', { value: 3, extra: true }, 'JD0023'],
  ['generated change', { value: 3, doubled: 12 }, 'JD0023'],
  ['lossy codec', { value: 'bad' }, 'JD2003'],
]) it(`physical ${label} refuses and rolls back its receipt and rows`, async () => fixture(async (db, apply) => {
  const model = modelFor({ id: key('integer'), value: { type: 'integer' }, doubled: { type: 'integer' } }, {
    id: column('id', 'integer'), value: column('value', 'integer'), doubled: column('doubled', 'integer', 'reject', { generated: true }),
  });
  db.exec('CREATE TABLE rows(id INTEGER PRIMARY KEY,value INTEGER,doubled INTEGER GENERATED ALWAYS AS(value*2));INSERT INTO rows(id,value) VALUES(1,2)');
  await assert.rejects(apply(model, [document(label, model, [transform(model, body)])]), { code });
  assert.deepEqual({ ...db.prepare('SELECT * FROM rows').get([]) }, { id: 1, value: 2, doubled: 4 });
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='_jaren_migrations'").get([]).n, 0);
}));

it('physical transforms evaluate existing store invariants after generated values settle', async () => fixture(async (db, apply) => {
  const model = modelFor({ id: key('integer'), value: { type: 'integer' }, doubled: { type: 'integer' } }, {
    id: column('id', 'integer'), value: column('value', 'integer'), doubled: column('doubled', 'integer', 'reject', { generated: true }),
  });
  model.entities.Row.invariants = [{ name: 'bounded', enforcement: 'store', on: ['update'], assert: { $le: ['$.new.doubled', 5] } }];
  db.exec('CREATE TABLE rows(id INTEGER PRIMARY KEY,value INTEGER,doubled INTEGER GENERATED ALWAYS AS(value*2));INSERT INTO rows(id,value) VALUES(1,2)');
  await assert.rejects(apply(model, [document('invariant', model, [transform(model, { value: 3 })])]), { code: 'JD2096' });
  assert.equal(db.prepare('SELECT value FROM rows').get([]).value, 2);
}));

it('physical transforms refuse views and stale mappings before preparing mapped data statements', async () => fixture(async (db, apply, path) => {
  const model = modelFor({ id: key('integer'), value: { type: 'integer' } }, { id: column('id', 'integer'), value: column('value', 'integer') });
  db.exec('CREATE TABLE source(id INTEGER PRIMARY KEY,value INTEGER);INSERT INTO source VALUES(1,2);CREATE VIEW rows AS SELECT * FROM source');
  const view = structuredClone(model); view.entities.Row.physical.kind = 'view';
  await assert.rejects(apply(view, [document('view', view, [transform(view, { value: 3 })])]), { code: 'JD2003' });
  const missing = structuredClone(model); missing.entities.Row.physical.table = 'source'; missing.entities.Row.physical.columns.value.name = 'missing';
  const prepared = [];
  const traced = { ...driver, open: async (...args) => {
    const connection = await driver.open(...args);
    return { ...connection, prepare: (sql, options) => { prepared.push(sql); return connection.prepare(sql, options); } };
  } };
  await assert.rejects(migrate({ driver: traced, path }, [document('missing', missing, [transform(missing, { value: 3 })])], { baseline: missing, shadow: false }), { code: 'JD0002' });
  assert.ok(!prepared.some((sql) => /^(?:SELECT|UPDATE)\b/.test(sql) && sql.includes('"missing"')));
  assert.equal(db.prepare('SELECT value FROM source').get([]).value, 2);
}));

for (const effect of ['insert', 'delete', 'rekey']) it(`physical transforms bound and roll back trigger ${effect} effects on source identities`, async () => fixture(async (db, apply) => {
  const model = modelFor({ id: key('integer'), value: { type: 'integer' } }, { id: column('id', 'integer'), value: column('value', 'integer') });
  db.exec('CREATE TABLE rows(id INTEGER PRIMARY KEY,value INTEGER);INSERT INTO rows VALUES(1,0),(2,0),(3,0)');
  const sql = effect === 'insert' ? 'INSERT INTO rows(value) VALUES(0)' : effect === 'delete' ? 'DELETE FROM rows WHERE id=NEW.id' : 'UPDATE rows SET id=NEW.id+100 WHERE id=NEW.id';
  db.exec(`CREATE TRIGGER changed AFTER UPDATE OF value ON rows BEGIN ${sql};END`);
  await assert.rejects(apply(model, [document(effect, model, [transform(model, { value: 1 })])]), { code: 'JD0023' });
  assert.deepEqual(db.prepare('SELECT id,value FROM rows ORDER BY id').all([]).map((row) => ({ ...row })), [{ id: 1, value: 0 }, { id: 2, value: 0 }, { id: 3, value: 0 }]);
}));

it('physical assertions and transforms select their historical model around structural steps', async () => fixture(async (db, apply) => {
  const from = modelFor({ id: key('integer'), value: { type: 'string' } }, { id: column('id', 'integer'), value: column('value', 'text') });
  const to = structuredClone(from); to.entities.Row.schema.properties.zextra = { type: 'string' }; to.entities.Row.physical.columns.zextra = column('zextra', 'text', 'absent');
  await createModelShape(db, from); db.prepare('INSERT INTO rows VALUES(?,?)').run([17, 'before']);
  const migration = { $migration: '0.1', id: 'historical', from: shapeHash(from), to: shapeHash(to), steps: [
    { kind: 'query', collection: 'Row', model: from, assert: { $eq: [{ $count: '$[*]' }, 1] }, expect: 'ebv' },
    { kind: 'ddl', sql: 'ALTER TABLE rows ADD COLUMN "zextra" TEXT' },
    transform(to, { value: '$.value', zextra: 'after' }),
    { kind: 'query', collection: 'Row', model: to, assert: { $for: { r: '$[*]' }, $where: { $ne: ['$r.zextra', 'after'] }, $return: '$r' } },
  ] };
  await apply(from, [migration], { model: to });
  assert.deepEqual({ ...db.prepare('SELECT * FROM rows').get([]) }, { id: 17, value: 'before', zextra: 'after' });
}));

it('physical query steps keep duplicate view identities through bounded historical reads', async () => fixture(async (db, apply) => {
  const model = modelFor({ id: key('integer'), value: { type: 'integer' } }, { id: column('rid', 'integer'), value: column('value', 'integer') }, { kind: 'view' });
  db.exec('CREATE TABLE source(rid INTEGER PRIMARY KEY,value INTEGER);INSERT INTO source VALUES(17,2),(23,3);CREATE VIEW rows AS SELECT * FROM source UNION ALL SELECT * FROM source');
  const query = { kind: 'query', collection: 'Row', model, assert: { $eq: [{ $count: '$[*]' }, 4] }, expect: 'ebv' };
  assert.deepEqual((await apply(model, [document('view-read', model, [query])])).applied, ['view-read']);
}));

it('physical step mappings require their declared database invariant triggers before a write', async () => fixture(async (db, apply) => {
  const model = modelFor({ id: key('integer'), value: { type: 'integer' } }, { id: column('id', 'integer'), value: column('value', 'integer') });
  model.entities.Row.invariants = [{ name: 'positive', enforcement: 'database', on: ['update'], assert: { $ge: ['$.new.value', 0] } }];
  db.exec('CREATE TABLE rows(id INTEGER PRIMARY KEY,value INTEGER);INSERT INTO rows VALUES(1,2)');
  await assert.rejects(apply(model, [document('missing-invariant', model, [transform(model, { value: 3 })])]), { code: 'JD0002' });
  assert.equal(db.prepare('SELECT value FROM rows').get([]).value, 2);
}));

it('physical codec transforms distinguish SQL NULL from JSON null and preserve canonical no-ops', async () => fixture(async (db, apply) => {
  const model = modelFor({ id: key('integer'), payload: { type: ['object', 'null'] }, note: { type: ['string', 'null'] },
    bytes: { type: 'string' }, flag: { type: 'boolean' }, decimal: { type: 'string' }, epoch: { type: 'string' } }, {
    id: column('rid', 'integer'), payload: column('payload', 'json', 'absent'),
    note: column('note', 'text', 'null', { default: 'database' }), bytes: column('bytes', 'blob-hex'),
    flag: column('flag', 'boolean'), decimal: column('decimal', 'decimal'), epoch: column('epoch', 'epoch-ms'),
  });
  db.exec("CREATE TABLE rows(rid INTEGER PRIMARY KEY,payload TEXT,note TEXT DEFAULT 'fallback',bytes BLOB,flag INTEGER,decimal TEXT,epoch INTEGER);CREATE TABLE audit(kind TEXT);CREATE TRIGGER untouched AFTER UPDATE OF bytes,decimal ON rows BEGIN INSERT INTO audit VALUES('unexpected');END");
  db.prepare('INSERT INTO rows VALUES(?,?,?,?,?,?,?)').run([1, '{ "a" : 1 }', 'kept', new Uint8Array([0, 255]), 0, '1.2500', 0]);
  const first = document('clear', model, [transform(model, { note: null, bytes: '00FF', flag: true, decimal: '$.decimal', epoch: '2000-01-01T00:00:00.000Z' })]);
  await apply(model, [first]);
  assert.deepEqual({ ...db.prepare('SELECT payload,note,hex(bytes) AS bytes,flag,decimal,epoch FROM rows').get([]) },
    { payload: null, note: null, bytes: '00FF', flag: 1, decimal: '1.2500', epoch: 946684800000 });
  const second = document('literal', model, [transform(model, { payload: null, note: '$.note', bytes: '$.bytes', flag: '$.flag', decimal: '$.decimal', epoch: '$.epoch' })]);
  await apply(model, [first, second]);
  assert.equal(db.prepare('SELECT payload FROM rows').get([]).payload, 'null');
  const third = document('same', model, [transform(model, '$')]), progress = [];
  await apply(model, [first, second, third], { onProgress: (event) => progress.push(event) });
  assert.equal(progress.at(-1).transformed, 0);
  assert.deepEqual((await apply(model, [first, second, third])).applied, []);
  assert.equal(db.prepare('SELECT count(*) AS n FROM audit').get([]).n, 0);
}));

it('physical transforms and query pages honor promise-returning SQLite drivers', async () => fixture(async (db, apply, path) => {
  const NativeDatabase = process.versions.bun
    ? (await import('bun:sqlite')).Database : (await import('node:sqlite')).DatabaseSync;
  const asynchronous = { dialect: sqliteDialect, name: 'async-fixture', open(databasePath) {
    const native = new NativeDatabase(databasePath);
    const statements = [];
    return openConnection({
      exec: async (sql) => native.exec(sql),
      prepare: async (sql) => {
        const statement = native.prepare(sql);
        statements.push(statement);
        return {
          run: async (params = []) => statement.run(...params),
          get: async (params = []) => statement.get(...params) ?? undefined,
          all: async (params = []) => statement.all(...params),
        };
      },
      close: async () => { for (const statement of statements) statement.finalize?.(); native.close(); },
    }, { dialect: sqliteDialect, synchronous: false });
  } };
  const model = modelFor({ id: key('integer'), value: { type: 'integer' } }, { id: column('rid', 'integer'), value: column('value', 'integer') });
  db.exec('CREATE TABLE rows(rid INTEGER PRIMARY KEY,value INTEGER);INSERT INTO rows VALUES(-8,0),(17,0),(23,0);CREATE VIEW duplicates AS SELECT * FROM rows UNION ALL SELECT * FROM rows');
  const view = structuredClone(model); view.entities.Row.physical.table = 'duplicates'; view.entities.Row.physical.kind = 'view';
  const migration = document('asynchronous', model, [transform(model, { value: 3 }),
    { kind: 'query', collection: 'Row', model: view, assert: { $eq: [{ $count: '$[*]' }, 6] }, expect: 'ebv' }]);
  const options = { baseline: model, batchSize: 1, shadow: false };
  assert.deepEqual((await migrate({ driver: asynchronous, path }, [migration], options)).applied, ['asynchronous']);
  assert.deepEqual(db.prepare('SELECT rid,value FROM rows ORDER BY rid').all([]).map((row) => ({ ...row })),
    [-8, 17, 23].map((rid) => ({ rid, value: 3 })));
  assert.deepEqual((await migrate({ driver: asynchronous, path }, [migration], options)).applied, []);
}));

for (const kind of ['jslt', 'query']) it(`a ${kind} step refuses a historical model that does not declare its target`, async () => fixture(async (db, apply) => {
  const model = modelFor({ id: key('integer'), value: { type: 'integer' } }, { id: column('id', 'integer'), value: column('value', 'integer') });
  db.exec('CREATE TABLE rows(id INTEGER PRIMARY KEY,value INTEGER);INSERT INTO rows VALUES(1,2)');
  const missing = structuredClone(model); missing.entities.Other = missing.entities.Row; delete missing.entities.Row;
  const step = kind === 'jslt' ? transform(missing, { value: 3 })
    : { kind: 'query', collection: 'Row', model: missing, assert: { $eq: [{ $count: '$[*]' }, 1] }, expect: 'ebv' };
  await assert.rejects(apply(model, [document('missing-target', model, [step])]), { code: 'JD0021' });
  assert.equal(db.prepare('SELECT value FROM rows').get([]).value, 2);
}));

for (const name of ['constructor', '__proto__']) it(`physical transforms preserve the scalar key '${name}' as an own member`, async () => fixture(async (db, apply) => {
  const model = modelFor({ [name]: key('integer'), value: { type: 'integer' } }, { [name]: column('id', 'integer'), value: column('value', 'integer') });
  db.exec('CREATE TABLE rows(id INTEGER PRIMARY KEY,value INTEGER);INSERT INTO rows VALUES(17,2),(23,4)');
  const migration = document('restore-own-key', model, [transform(model, { value: 3 })]);
  await apply(model, [migration]);
  assert.deepEqual(db.prepare('SELECT id,value FROM rows ORDER BY id').all([]).map((row) => ({ ...row })), [{ id: 17, value: 3 }, { id: 23, value: 3 }]);
  assert.deepEqual((await apply(model, [migration])).applied, []);
  const changed = document('change-own-key', model, [{ kind: 'jslt', collection: 'Row', model,
    stylesheet: [{ match: `$[${JSON.stringify(name)}]`, body: 18 }] }]);
  await assert.rejects(apply(model, [migration, changed]), { code: 'JD0023' });
  assert.equal(db.prepare('SELECT count(*) AS n FROM _jaren_migrations').get([]).n, 1);
}));

for (const encoding of ['UTF-8', 'UTF-16le', 'UTF-16be']) it(`physical ${encoding} key pages preserve NUL, Unicode, BOM and colliding projection names`, async () => fixture(async (db, apply) => {
  db.exec(`PRAGMA encoding='${encoding}'`);
  assert.equal(db.prepare('PRAGMA encoding').get([]).encoding, encoding);
  const model = modelFor({ id: key('string'), payload: { type: 'object' }, bytes: { type: 'string' }, value: { type: 'integer' } }, {
    id: column('rid', 'text'), payload: column('__JAREN_KEY_BYTES_0', 'json'),
    bytes: column('__jaren_key_bytes_0_', 'blob-hex'), value: column('value', 'integer'),
  });
  db.exec('CREATE TABLE rows(rid TEXT PRIMARY KEY,"__JAREN_KEY_BYTES_0" TEXT,"__jaren_key_bytes_0_" BLOB,value INTEGER) WITHOUT ROWID');
  const keys = ['', 'a', 'a\u0000', 'a\u0000x', 'a\u0000y', 'á', 'a\u0301', 'x\uFEFFy', '😀'];
  for (const key of keys) db.prepare('INSERT INTO rows VALUES(?,?,?,0)').run([key, '{ "b": 2, "a": 1 }', new Uint8Array([0, 255])]);
  const read = () => db.prepare('SELECT hex(CAST(rid AS BLOB)) AS id,"__JAREN_KEY_BYTES_0" AS payload,hex("__jaren_key_bytes_0_") AS bytes,value FROM rows ORDER BY rid COLLATE BINARY').all([]).map((row) => ({ ...row }));
  const before = read();
  const migration = document('text-bytes', model, [
    transform(model, { payload: { a: '$.payload.a', b: '$.payload.b' }, bytes: '00FF', value: 3 }),
    { kind: 'query', collection: 'Row', model, assert: { $eq: [{ $count: '$[*]' }, keys.length] }, expect: 'ebv' },
  ]);
  await apply(model, [migration]);
  assert.deepEqual(read(), before.map((row) => ({ ...row, value: 3 })));
  assert.deepEqual((await apply(model, [migration])).applied, []);
}));

for (const kind of ['query', 'jslt']) for (const hex of ['FF', '80', 'C080', 'EDA080', 'F4908080', 'E282'])
  it(`physical ${kind} refuses malformed UTF-8 key ${hex} before yielding its batch`, async () => fixture(async (db, apply) => {
    const model = modelFor({ id: key('string'), value: { type: 'integer' } }, { id: column('id', 'text'), value: column('value', 'integer') });
    db.exec('CREATE TABLE rows(id TEXT PRIMARY KEY,value INTEGER) WITHOUT ROWID');
    for (const key of ['a', '😀']) db.prepare('INSERT INTO rows VALUES(?,0)').run([key]);
    const bytes = Uint8Array.from(hex.match(/../g), (pair) => parseInt(pair, 16));
    db.prepare('INSERT INTO rows VALUES(CAST(? AS TEXT),0)').run([bytes]);
    const read = () => db.prepare('SELECT hex(CAST(id AS BLOB)) AS id,value FROM rows ORDER BY id COLLATE BINARY').all([]).map((row) => ({ ...row }));
    const before = read(), progress = [];
    const step = kind === 'jslt' ? transform(model, { value: 1 })
      : { kind: 'query', collection: 'Row', model, assert: { $count: '$[*]' }, expect: 'ebv' };
    await assert.rejects(apply(model, [document('invalid-key', model, [step])], { batchSize: 2,
      onProgress: (event) => { progress.push(event); assert.ok((event.asserted ?? event.transformed) <= 3, 'a key page repeated'); },
    }), { code: 'JD0021' });
    if (hex === '80') assert.equal(progress.length, 0);
    assert.deepEqual(read(), before);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='_jaren_migrations'").get([]).n, 0);
  }));

for (const [encoding, hex] of [['UTF-8', 'EFBBBF78'], ['UTF-16le', 'FFFE7800'], ['UTF-16be', 'FEFF0078']])
  for (const kind of ['query', 'jslt']) it(`physical ${kind} preserves ${encoding} leading-BOM keys or refuses a lossy native binding`, async () => fixture(async (db, apply) => {
    db.exec(`PRAGMA encoding='${encoding}';CREATE TABLE rows(id TEXT PRIMARY KEY,value INTEGER) WITHOUT ROWID;INSERT INTO rows VALUES(CAST(X'${hex}' AS TEXT),0)`);
    for (const key of ['a', '😀']) db.prepare('INSERT INTO rows VALUES(?,0)').run([key]);
    const bound = db.prepare('SELECT CAST(? AS BLOB) AS bytes').get(['\uFEFFx']);
    const lossless = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bound.bytes) === '\uFEFFx';
    const model = modelFor({ id: key('string'), value: { type: 'integer' } }, { id: column('id', 'text'), value: column('value', 'integer') });
    const read = () => db.prepare('SELECT hex(CAST(id AS BLOB)) AS id,value FROM rows ORDER BY id COLLATE BINARY').all([]).map((row) => ({ ...row }));
    const before = read();
    const step = kind === 'jslt' ? transform(model, { value: 1 })
      : { kind: 'query', collection: 'Row', model, assert: { $eq: [{ $count: '$[*]' }, 3] }, expect: 'ebv' };
    const applied = apply(model, [document('leading-bom', model, [step])], {
      onProgress: (event) => assert.ok((event.asserted ?? event.transformed) <= 3, 'a key page repeated'),
    });
    if (lossless) {
      assert.deepEqual((await applied).applied, ['leading-bom']);
      assert.deepEqual(read(), before.map((row) => ({ ...row, value: kind === 'jslt' ? 1 : 0 })));
    }
    else {
      await assert.rejects(applied, { code: 'JD0021' });
      assert.deepEqual(read(), before);
      assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='_jaren_migrations'").get([]).n, 0);
    }
  }));
