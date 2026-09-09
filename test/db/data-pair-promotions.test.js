//@ts-check
/** Plan assertions complement the shared indexed/unindexed/residual oracle. */
import { it } from 'node:test';
import * as assert from 'node:assert/strict';
import { loadGroups, loadRelationGroups, storeForGroup, storeForEntityGroup, runCase, runEntityCase } from './oracle/harness.js';

it('scalar distinct, nullable groups, constants and path comparisons lower without a UDF', async () => {
  const group = loadGroups().find((entry) => entry.group === 'data pair scalar grouping and cardinality');
  for (const side of ['indexed', 'unindexed']) {
    const { store, collection } = await storeForGroup(group, undefined, side);
    try {
      for (const kase of group.cases) {
        const explained = await collection.explain(kase.query, { profile: { maxRows: 100 } });
        if (kase.name === 'window counts row residual items') {
          assert.equal(explained.mode, 'set');
        }
        else {
          assert.equal(explained.mode, 'native', `${side}: ${kase.name}`);
          assert.equal(explained.udfs.length, 0);
        }
        assert.equal(await runCase(collection, group.documents, kase, 'native'), null, kase.name);
      }
    }
    finally { await store.close(); }
  }
});

it('group windows and group counts execute and stream the same bounded result', async () => {
  const group = loadGroups().find((entry) => entry.group === 'projections');
  const { store, collection } = await storeForGroup(group);
  try {
    for (const name of ['a window over the groups', 'a count of the groups', 'nested windows over first-seen groups']) {
      const kase = group.cases.find((entry) => entry.name === name);
      const explained = await collection.explain(kase.query);
      assert.equal(explained.mode, 'native', name);
      assert.match(explained.sql, /GROUP BY/);
      if (name.includes('count')) assert.match(explained.sql, /FROM \(SELECT/);
      else assert.match(explained.sql, /LIMIT/);
      assert.equal(await runCase(collection, group.documents, kase, 'native'), null, name);
      const expected = await collection.execute([kase.query], { pushdown: false });
      const items = [];
      for await (const item of collection.query(kase.query, { strict: true })) items.push(item);
      assert.deepEqual(items, expected, name);
    }
  }
  finally { await store.close(); }
});

it('entity projection counts and boolean filters across equijoins lower whole', async () => {
  const groups = loadRelationGroups();
  for (const group of groups.filter((entry) => ['11 entity selects', '12 joins'].includes(entry.group))) {
    const { store } = await storeForEntityGroup(group);
    try {
      const cases = group.cases.filter((kase) => /projected entity member|window counts entity|constant or tree|across joined bindings/.test(kase.name));
      assert.ok(cases.length > 0);
      for (const kase of cases) {
        const explained = await store.explain(kase.query);
        assert.equal(explained.mode, 'native', kase.name);
        assert.equal(await runEntityCase(store, group.documents, kase, 'native'), null, kase.name);
        assert.equal(await runEntityCase(store, group.documents, kase, 'residual'), null, kase.name);
      }
    }
    finally { await store.close(); }
  }
});
