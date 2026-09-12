//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { compileEntityModel } from '@jarenjs/db/model';
import { entityCore } from '@jarenjs/db/entity';
import { sql } from '@jarenjs/db/relational';
import { model } from './fixtures/mutation-model.mjs';

async function fixture(run) {
  const driver = process.versions.bun ? (await import('@jarenjs/db/bun')).bunDriver() : (await import('@jarenjs/db/node')).nodeDriver();
  const db = await driver.open(':memory:');
  const { entities, mapping } = compileEntityModel(model);
  const prepared = [];
  const connection = Object.create(db);
  Object.defineProperty(connection, 'prepare', { value: (text, options) => { prepared.push(text); return db.prepare(text, options); } });
  const core = entityCore(connection, entities.get('Entry'), mapping.entities.Entry, null);
  try {
    db.exec("CREATE TABLE entries(id INTEGER PRIMARY KEY,payload TEXT NOT NULL);INSERT INTO entries VALUES(1,'initial'),(2,'second')");
    await run(db, core, prepared);
  }
  finally { db.close(); }
}

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
