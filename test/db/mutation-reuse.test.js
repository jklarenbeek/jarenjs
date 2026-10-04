//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { compileEntityModel } from '@jarenjs/db/model';
import { entityCore } from '@jarenjs/db/entity';
import { sql } from '@jarenjs/db/relational';
import { model } from './fixtures/mutation-model.mjs';

async function fixture(run, prepare = (db, text, options) => db.prepare(text, options)) {
  const driver = process.versions.bun ? (await import('@jarenjs/db/bun')).bunDriver() : (await import('@jarenjs/db/node')).nodeDriver();
  const db = await driver.open(':memory:');
  const { entities, mapping } = compileEntityModel(model);
  const prepared = [];
  const connection = Object.create(db);
  Object.defineProperty(connection, 'prepare', { value: (text, options) => { prepared.push(text); return prepare(db, text, options); } });
  const core = entityCore(connection, entities.get('Entry'), mapping.entities.Entry, null);
  try {
    db.exec("CREATE TABLE entries(id INTEGER PRIMARY KEY,payload TEXT NOT NULL);INSERT INTO entries VALUES(1,'initial'),(2,'second')");
    await run(db, core, prepared);
  }
  finally { db.close(); }
}

for (const asynchronous of [false, true]) it(`mutation preparation can recover after a classified failure (${asynchronous ? 'promise' : 'sync'})`, async () => {
  const failure = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY', errcode: 5 });
  let failing = true;
  await fixture(async (db, core, prepared) => {
    const document = { op: 'update', key: 1, set: { payload: 'changed' } };
    const classified = (error) => error.code === 'JD2005' && error.class === 'busy'
      && error.retryable === true && error.cause === failure;
    if (asynchronous) await assert.rejects(core.mutate(document), classified);
    else assert.throws(() => core.mutate(document), classified);
    assert.equal(prepared.length, 1);
    assert.equal(db.prepare('SELECT payload FROM entries WHERE id=1').get([]).payload, 'initial');

    const recovered = core.mutate(document);
    if (!asynchronous) assert.equal(recovered.affected, 1, 'the native synchronous result stays synchronous');
    assert.deepEqual((await recovered).rows, [{ id: 1, payload: 'changed' }]);
    assert.equal(prepared.length, 2, 'a refused preparation does not occupy the statement cache');
    assert.equal(db.prepare('SELECT payload FROM entries WHERE id=1').get([]).payload, 'changed');
    assert.equal((await core.mutate(document)).affected, 0, 'a repeated successful write remains a no-op');
    assert.deepEqual((await core.mutate({ ...document, set: { payload: 'again' } })).rows, [{ id: 1, payload: 'again' }]);
    assert.equal(prepared.length, 2, 'successful preparation is still reused');
  }, (db, text, options) => {
    if (failing) {
      failing = false;
      if (asynchronous) return Promise.reject(failure);
      throw failure;
    }
    const statement = db.prepare(text, options);
    return asynchronous ? Promise.resolve(statement) : statement;
  });
});

it('varying mutation values reuse one statement while each call owns bindings, projection and output budgets', async () => fixture((db, core, prepared) => {
  for (let i = 0; i < 128; i++) {
    const payload = `payload-${i}`;
    const result = core.mutate({ op: 'update', key: 1, set: { payload }, returning: ['id'] });
    assert.deepEqual(result.rows, [{ id: 1 }]);
    assert.equal(db.prepare('SELECT payload FROM entries WHERE id=1').get([]).payload, payload);
  }
  assert.equal(prepared.length, 1, 'payload values never multiply prepared statements');
  assert.deepEqual(core.mutate({ op: 'update', key: 2, set: { payload: 'other' }, returning: ['payload'] }).rows, [{ payload: 'other' }]);
  assert.equal(prepared.length, 1, 'output projection stays local even when SQL is shared');
  assert.throws(() => core.mutate({ op: 'update', key: 2, set: { payload: 'too large' }, maxBytes: 1 }), { code: 'JD2007' });
  assert.equal(db.prepare('SELECT payload FROM entries WHERE id=2').get([]).payload, 'other');
  assert.equal(prepared.length, 1, 'the output limit is not a cached binding');
  assert.throws(() => db.transaction(() => { core.mutate({ op: 'update', key: 1, set: { payload: 'rollback' } }); throw new Error('rollback'); }), /rollback/);
  assert.equal(db.prepare('SELECT payload FROM entries WHERE id=1').get([]).payload, 'payload-127');
  const doc = { op: 'update', key: 1, set: { payload: 'first' }, returning: ['id'] };
  assert.deepEqual(core.mutate(doc).rows, [{ id: 1 }]);
  doc.returning[0] = 'payload'; doc.set.payload = 'second';
  assert.deepEqual(core.mutate(doc).rows, [{ payload: 'second' }]);
  assert.equal(prepared.length, 1);
  const cyclic = { $sql: 'not', value: null }; cyclic.value = cyclic;
  assert.throws(() => core.mutate({ op: 'update', key: 1, expressions: { payload: cyclic } }), { code: 'JD0038' });
}));

it('distinct mutation SQL remains isolated and the existing statement capacity is bounded', async () => fixture((db, core, prepared) => {
  const document = (size) => ({ op: 'update', where: sql.in(sql.column('id'), Array.from({ length: size }, (_, i) => i + 1)),
    set: { payload: String(size) }, returning: ['id'] });
  for (let i = 1; i <= 65; i++) core.mutate(document(i));
  assert.equal(prepared.length, 65);
  core.mutate(document(65)); assert.equal(prepared.length, 65);
  core.mutate(document(1)); assert.equal(prepared.length, 66, 'the least recently used statement was evicted at 64');
  assert.equal(db.prepare('SELECT payload FROM entries WHERE id=1').get([]).payload, '1');
  assert.equal(db.prepare('SELECT payload FROM entries WHERE id=2').get([]).payload, '65');
}));
