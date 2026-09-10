//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { storeForSqlCensus } from './oracle/harness.js';

const model = { $model: '0.1', entities: { Item: {
  schema: { type: 'object', properties: {
    id: { type: 'integer', 'x-entity': { key: true } }, value: { type: 'string' },
    n: { type: 'integer' }, flag: { type: 'boolean' }, day: { type: 'string' },
  } }, physical: { table: 'items', columns: Object.fromEntries([
    ['id', 'integer'], ['value', 'text'], ['n', 'integer'], ['flag', 'boolean'], ['day', 'date'],
  ].map(([name, codec]) => [name, { name, codec, null: 'reject' }])) },
} } };

async function fixture(run, values = [[1, 'a', 1], [2, 'B', 2]], declaration = model) {
  const db = await nodeDriver().open(':memory:');
  db.exec(`CREATE TABLE items(id INTEGER PRIMARY KEY,value TEXT COLLATE NOCASE,n ${declaration.entities.Item.physical.columns.n.codec === 'number' ? 'REAL' : 'INTEGER'},flag INTEGER,day TEXT)`);
  for (const [id, value, n] of values)
    db.prepare('INSERT INTO items VALUES(?,?,?,1,?)').run([id, value, n, '2026-09-10']);
  const store = await openStore(declaration, { driver: { ...nodeDriver(), open: async () => db }, adopt: true });
  try { await run(store, db); }
  finally { await store.close(); }
}

const grouping = (aggregate = { $sum: '$i.n' }) => [{
  $for: { i: '$.Item[*]' }, $groupby: { v: '$i.value' },
  $return: { v: '$v', result: aggregate },
}];

it('physical predicates, order, joins, correlations and groups use codepoint equality', async () => {
  await fixture(async (store) => {
    const queries = [
      [{ $for: { i: '$.Item[*]' }, $where: { $eq: ['$i.value', 'A'] }, $return: '$i.id' }],
      [{ $for: { i: '$.Item[*]' }, $orderby: '$i.value', $return: '$i.value' }],
      [{ $for: { i: '$.Item[*]', j: '$.Item[*]' }, $where: { $eq: ['$i.value', '$j.value'] },
        $return: { a: '$i.id', b: '$j.id' } }],
      [{ $for: { i: '$.Item[*]' }, $return: { id: '$i.id', n: { $count: {
        $for: { j: '$.Item[*]' }, $where: { $eq: ['$j.value', '$i.value'] }, $return: '$j',
      } } } }], grouping({ $count: '$i' }),
    ];
    for (const query of queries) {
      assert.equal((await store.explain(query)).mode, 'native');
      assert.deepEqual(await store.execute(query), await store.execute(query, { pushdown: false }));
    }
    assert.deepEqual(await store.execute(queries[0]), [3]);
    assert.deepEqual(await store.execute(queries[1]), ['A', 'B', 'a']);
  }, [[1, 'a', 1], [2, 'B', 2], [3, 'A', 3]]);
});

it('physical scalar projections and cursors retain codec validation', async () => {
  for (const [member, sql] of [['n', "n='bad'"], ['flag', 'flag=2'], ['day', "day='invalid'"], ['value', 'value=NULL']]) {
    await fixture(async (store, db) => {
      db.exec(`UPDATE items SET ${sql} WHERE id=1`);
      const query = { $for: { i: '$.Item[*]' }, $return: { value: `$i.${member}` } };
      await assert.rejects(async () => store.execute(query), { code: 'JD2003' });
      await assert.rejects(async () => store.execute(query, { pushdown: false }), { code: 'JD2003' });
      await assert.rejects(async () => { for await (const item of store.entity('Item').cursor(query)) void item; }, { code: 'JD2003' });
    });
  }
});

it('integer grouped sums retain engine addition order when exactness cannot be proved', async () => {
  for (const values of [[Number.MAX_SAFE_INTEGER, 2, -Number.MAX_SAFE_INTEGER], [Number.MAX_SAFE_INTEGER, 1]]) {
    await fixture(async (store) => {
      const query = grouping();
      assert.equal((await store.explain(query)).mode, 'native');
      const expected = await store.execute(query, { pushdown: false });
      assert.deepEqual(await store.execute(query), expected);
      const explanation = await store.explain(query);
      assert.equal(explanation.mode, 'set');
      assert.match(explanation.reasons[0].reason, /runtime exactness/);
      assert.equal(explanation.admitted.statements, 2);
      await assert.rejects(async () => store.execute(query, { strict: true }), { code: 'JD0010' });
    }, values.map((value, i) => [i + 1, 'same', value]));
  }
});

it('small integer sums and averages stay native and clear an earlier runtime diversion', async () => {
  await fixture(async (store, db) => {
    const query = grouping();
    await store.execute(query);
    assert.equal((await store.explain(query)).mode, 'set');
    db.exec('UPDATE items SET n=id');
    assert.deepEqual(await store.execute(query, { strict: true }), [{ v: 'same', result: 6 }]);
    assert.equal((await store.explain(query)).mode, 'native');
    assert.equal((await store.explain(query)).admitted.statements, 1);
    assert.deepEqual(await store.execute(grouping({ $avg: '$i.n' }), { strict: true }), [{ v: 'same', result: 2 }]);
  }, [[1, 'same', Number.MAX_SAFE_INTEGER], [2, 'same', 2], [3, 'same', -Number.MAX_SAFE_INTEGER]]);
});

it('malformed physical aggregation inputs cannot disappear inside sums or extrema', async () => {
  for (const aggregate of ['$sum', '$avg', '$min', '$max']) {
    await fixture(async (store, db) => {
      db.exec("UPDATE items SET n='bad' WHERE id=1");
      const query = grouping({ [aggregate]: '$i.n' });
      await assert.rejects(async () => store.execute(query), { code: 'JD2003' });
      await assert.rejects(async () => store.execute(query, { pushdown: false }), { code: 'JD2003' });
    }, [[1, 'same', 1], [2, 'same', 2]]);
  }
});

it('unsafe stored integers reach codec validation without a driver narrowing exception', async () => {
  await fixture(async (store, db) => {
    db.exec('UPDATE items SET n=9007199254740992 WHERE id=1');
    for (const query of [
      [{ $for: { i: '$.Item[*]' }, $return: { n: '$i.n' } }],
      grouping({ $min: '$i.n' }), grouping({ $max: '$i.n' }), grouping(),
    ]) await assert.rejects(async () => store.execute(query), { code: 'JD2003' });
  }, [[1, 'same', 1], [2, 'same', 2]]);
});

it('grouped output admits only the profile row bound plus its overflow witness', async () => {
  await fixture(async (store) => {
    const query = grouping({ $count: '$i' });
    const options = { profile: { maxRows: 1, refuseFullScan: false } };
    await assert.rejects(async () => store.execute(query, options), { code: 'JD2007' });
    const explanation = await store.explain(query, options);
    assert.equal(explanation.admitted.rows, 2);
    assert.match(explanation.sql, /LIMIT 2/);
  }, Array.from({ length: 100 }, (_, i) => [i, String(i), i]));
});

it('physical floating sums and averages stay residual until their accumulation is qualified', async () => {
  const declared = structuredClone(model);
  declared.entities.Item.schema.properties.n.type = 'number';
  declared.entities.Item.physical.columns.n.codec = 'number';
  await fixture(async (store) => {
    for (const aggregate of ['$sum', '$avg']) {
      const query = grouping({ [aggregate]: '$i.n' });
      assert.equal((await store.explain(query)).mode, 'set');
      await assert.rejects(async () => store.execute(query, { strict: true }), { code: 'JD0010' });
      assert.deepEqual(await store.execute(query), await store.execute(query, { pushdown: false }));
    }
  }, [[1, 'same', 0.1], [2, 'same', 0.2]], declared);
});

it('physical explanation names declared key ties and the grouping order actually emitted', async () => {
  await fixture(async (store) => {
    const select = [{ $for: { i: '$.Item[*]' }, $orderby: '$i.value', $return: '$i.id' }];
    assert.deepEqual((await store.explain(select)).order.map((term) => [term.source, term.column]),
      [['column', 'value'], ['column', 'id']]);
    const query = grouping({ $count: '$i' });
    query[0].$orderby = '$v';
    assert.deepEqual((await store.explain(query)).order.map((term) => [term.source, term.column]),
      [['group', 'v'], ['group', 'id']]);
  });
});

it('first-seen grouping over compound physical keys explicitly refuses native planning', async () => {
  const { store } = await storeForSqlCensus();
  try {
    const query = [{ $for: { i: '$.Inventory[*]' }, $groupby: { e: '$i.environment' },
      $return: { e: '$e', rows: { $count: '$i' } } }];
    const explanation = await store.explain(query);
    assert.equal(explanation.mode, 'set');
    assert.match(explanation.reasons[0].reason, /first-seen grouping over a compound physical key/);
    await assert.rejects(async () => store.execute(query, { strict: true }), { code: 'JD0010' });
    assert.deepEqual(await store.execute(query), await store.execute(query, { pushdown: false }));
  }
  finally { await store.close(); }
});

it('correlated counts retain an inner ordering that can reject invalid ordering keys', async () => {
  const { store } = await storeForSqlCensus();
  try {
    const query = [{ $for: { c: '$.Catalog[*]' }, $return: { sku: '$c.sku', count: { $count: {
      $for: { i: '$.Inventory[*]' }, $where: { $eq: ['$i.sku', '$c.sku'] },
      $orderby: '$i.quantity', $return: '$i',
    } } } }];
    assert.equal((await store.explain(query)).mode, 'set');
    await assert.rejects(async () => store.execute(query), { code: 'JQ2005' });
    await assert.rejects(async () => store.execute(query, { pushdown: false }), { code: 'JQ2005' });
  }
  finally { await store.close(); }
});
