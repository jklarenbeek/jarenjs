//@ts-check
/** Spatial columns preserve JSON scalars and query error parity. */
import { it } from 'node:test';
import * as assert from 'node:assert/strict';
import { openStore, normalizeModel, planCollection, planMigration, migrate,
  sqliteDialect, registerDeriveFunctions } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { queryJson } from '@jarenjs/json/query';
import { tempDbPath } from './helpers.js';

const modelFor = (physical = 'columns') => ({ $model: '0.1', collections: { places: {
  schema: { type: 'object', properties: { id: { type: 'string' }, at: {} } }, key: '/id',
  indexes: [{ name: 'cell', path: '$.at', derive: 'geohash', precision: 6 },
    { name: 'box', path: '$.at', derive: 'bbox', physical }],
} } });

for (const physical of ['columns', 'rtree']) it(`${physical}: spatial members retain every JSON kind on write and reopen`, async () => {
  const temp = tempDbPath();
  const model = modelFor(physical);
  let store;
  try {
    store = await openStore(model, { driver: nodeDriver(), path: temp.dbPath });
    const values = ['POINT (1 2)', 'null', '[1,2]', '', 3, false, true, null, [1, 2],
      { type: 'Point', coordinates: [1, 2] }];
    for (let i = 0; i < values.length; i++) await store.collection('places').put({ id: String(i), at: values[i] });
    await store.close();
    store = await openStore(model, { driver: nodeDriver(), path: temp.dbPath });
    for (let i = 0; i < values.length; i++) assert.deepEqual(await store.collection('places').get(String(i)),
      { id: String(i), at: values[i] });
    const plan = planCollection('places', normalizeModel(model).get('places'), sqliteDialect);
    const raw = await nodeDriver().open(temp.dbPath, {});
    try {
      await registerDeriveFunctions(raw);
      const rows = raw.prepare('SELECT key, gx_at_gh6 AS cell FROM places ORDER BY key').all([]);
      assert.equal(rows.find((row) => row.key === '2').cell, null, 'a JSON-looking string is not a position');
      assert.equal(rows.find((row) => row.key === '4').cell, null);
      assert.equal(rows.find((row) => row.key === '8').cell, rows.find((row) => row.key === '9').cell);
      assert.ok(plan.createSql[0].includes(' -> '));
    }
    finally { await raw.close(); }
  }
  finally { await store?.close(); temp.cleanup(); }
});

for (const physical of ['columns', 'rtree']) it(`${physical}: legacy spatial expressions have an explicit atomic, replay-safe migration`, async () => {
  const temp = tempDbPath();
  const model = modelFor(physical);
  const plain = structuredClone(model); plain.collections.places.indexes = [];
  const driver = nodeDriver();
  try {
    const raw = await driver.open(temp.dbPath, {});
    try {
      await registerDeriveFunctions(raw);
      const plan = planCollection('places', normalizeModel(model).get('places'), sqliteDialect);
      for (const sql of plan.createSql) raw.exec(sql.replaceAll('json(("doc" -> ', 'json(jsonb_extract("doc", '));
      raw.prepare('INSERT INTO places (key, doc) VALUES (?, jsonb(?))').run(['original', JSON.stringify({ id: 'original', at: [1, 2] })]);
    }
    finally { await raw.close(); }
    await assert.rejects(openStore(model, { driver, path: temp.dbPath }), { code: 'JD0002' });
    const remove = planMigration(model, plain, { dialect: sqliteDialect }).migration;
    const restore = planMigration(plain, model, { dialect: sqliteDialect }).migration;
    const migration = { ...remove, id: 'spatial-member-json', to: restore.to,
      steps: [...remove.steps, ...restore.steps] };
    const target = { driver, path: temp.dbPath };
    const options = { baseline: model, model };
    assert.deepEqual((await migrate(target, [migration], options)).applied, [migration.id]);
    assert.deepEqual((await migrate(target, [migration], options)).applied, []);
    const store = await openStore(model, target);
    try {
      assert.deepEqual(await store.collection('places').get('original'), { id: 'original', at: [1, 2] });
      await store.collection('places').put({ id: 'text', at: 'POINT (1 2)' });
      assert.deepEqual(await store.collection('places').get('text'), { id: 'text', at: 'POINT (1 2)' });
    }
    finally { await store.close(); }
  }
  finally { temp.cleanup(); }
});

it('neighbourhood candidate fetches preserve empty-membership errors and guarded answers', async () => {
  const model = modelFor();
  model.collections.places.schema.properties.at = { type: ['array', 'object'] };
  model.collections.places.indexes.push({ name: 'id', path: '$.id' });
  const rows = [{ id: 'here', at: [-.00007, 51.4779] }, { id: 'missing' },
    { id: 'empty', at: { type: 'FeatureCollection', features: [] } }];
  const member = { $geohash: ['$it.at', 6] };
  const membership = { $exists: { '$index-of': [{ '$geohash-neighbours': 'gcpuzg' }, member] } };
  const store = await openStore(model, { driver: nodeDriver() });
  try {
    const collection = store.collection('places');
    for (const row of rows) await collection.put(row);
    const matchHere = { $eq: ['$it.id', 'here'] };
    for (const [where, raises] of [[membership, true], [{ $and: [{ $exists: member }, membership] }, false],
      [{ $not: membership }, true], [{ $and: [membership, matchHere] }, true],
      [{ $and: [matchHere, membership] }, false],
      [{ $and: [{ $not: membership }, matchHere] }, true],
      [{ $and: [{ $or: [membership, matchHere] }, matchHere] }, true]]) {
      const query = { $for: { it: '$[*]' }, $where: where, $return: '$it.id' };
      if (!raises) {
        assert.equal(queryJson(query, rows), 'here');
        assert.equal(await collection.execute(query), 'here');
        assert.equal(await collection.execute(query, { pushdown: false }), 'here');
      }
      else {
        assert.throws(() => queryJson(query, rows), { code: 'JQ2001' });
        assert.throws(() => collection.execute(query), { code: 'JQ2001' });
        assert.throws(() => collection.execute(query, { pushdown: false }), { code: 'JQ2001' });
      }
    }
    const explained = await collection.explain({ $for: { it: '$[*]' }, $where: membership, $return: '$it.id' });
    assert.equal(explained.prefilters[0].exact, false);
    assert.match(explained.sql, /IS NULL OR/);
  }
  finally { await store.close(); }
});
