//@ts-check
import { it } from 'node:test';
import * as assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { replicationModel, replicaState, liveOracle } from './oracle/replication.js';

for (const mode of ['session', 'journal']) it(`${mode}: replicated mutations maintain joins, graphs and nested groups through one delivery path`, async () => {
  const model = structuredClone(replicationModel);
  model.entities.Tag.schema.properties.parent = { type: 'string', 'x-entity': { index: true } };
  const open = (replica) => openStore(model, { driver: nodeDriver(), capture: { mode }, replication: { replica } });
  const source = await open('source'); const target = await open('target');
  const join = [{ $for: { t: '$.Tag[*]', p: '$.Parent[*]' }, $where: { $eq: ['$t.parent', '$p.id'] },
    $return: { id: '$t.id', parent: '$p.name', label: '$t.label' } }];
  const graph = [{ $for: { p: '$.Parent[*]' }, $return: { id: '$p.id', children: [{ $for: { t: '$.Tag[*]' },
    $where: { $eq: ['$t.parent', '$p.id'] }, $return: '$t' }] } }];
  const groups = [{ $for: { row: '$[*]' }, $groupby: { group: '$row.group' }, $return: {
    group: '$group', values: [{ $for: { leaf: '$row' }, $groupby: { n: '$leaf.n' },
      $return: { n: '$n', count: { $count: '$leaf' } } }],
  } }];
  try {
    const liveJoin = await target.live(join, { mode: 'incremental' });
    const liveGraph = await target.live(graph, { mode: 'incremental' });
    const liveGroups = await target.collection('notes').live(groups, { mode: 'incremental' });
    assert.deepEqual([liveJoin.mode.strategy, liveGraph.mode.strategy, liveGroups.mode.strategy], ['join', 'graph', 'nested-group']);
    const oracles = [liveOracle(liveJoin, () => target.execute(join)), liveOracle(liveGraph, () => target.execute(graph)),
      liveOracle(liveGroups, () => target.collection('notes').execute(groups))];
    let after = 0;
    for (const mutate of [
      () => source.entity('Parent').create({ id: 'p', name: 'first' }),
      () => source.entity('Tag').create({ id: 't', parent: 'p', label: 'one' }),
      () => source.collection('notes').put({ id: 'n', n: 0, group: 'west' }),
      () => source.entity('Parent').create({ id: 'q', name: 'second' }),
      () => source.entity('Tag').update('t', { parent: 'q' }),
      () => source.collection('notes').put({ id: 'n', n: 1, group: 'east' }),
      () => source.entity('Tag').delete('t'),
      () => source.entity('Parent').delete('p'),
      () => source.collection('notes').delete('n'),
    ]) {
      await mutate();
      const page = await source.replication.page({ after });
      assert.equal(page.items.length, 1);
      assert.equal((await target.replication.apply(page.items[0])).status, 'applied');
      const emissions = oracles.map((oracle) => oracle.emissions);
      assert.equal((await target.replication.apply(page.items[0])).status, 'duplicate');
      assert.deepEqual(oracles.map((oracle) => oracle.emissions), emissions);
      for (const oracle of oracles) await oracle.check();
      assert.deepEqual(await replicaState(target), await replicaState(source));
      assert.deepEqual((await target.replication.page()).items, []);
      after = page.next;
    }
    for (const live of [liveJoin, liveGraph, liveGroups]) assert.equal(live.stats().reruns, 0);
    for (const oracle of oracles) oracle.close();
  }
  finally { await source.close(); await target.close(); }
});

for (const mode of ['session', 'journal']) it(`${mode}: a row deleted and stored again with the document it had replicates nothing and refuses nothing`, async () => {
  const open = (replica) => openStore(structuredClone(replicationModel), { driver: nodeDriver(), capture: { mode }, replication: { replica } });
  const source = await open('source');
  try {
    const notes = source.collection('notes');
    await notes.put({ id: 'a', n: 1, group: 'west' });
    await notes.put({ id: 'b', n: 1, group: 'west' });
    const { next } = await source.replication.page();
    const records = [];
    source.observe((record) => records.push(record.patch));
    await source.transaction(async (tx) => {
      await tx.collection('notes').delete('a');
      await tx.collection('notes').put({ id: 'a', n: 1, group: 'west' });
    });
    // the row moved in its table, which capture says; a replica holds rows without their order
    assert.deepEqual(records, [[{ op: 'replace', path: '/notes/a', value: { id: 'a', n: 1, group: 'west' } }]]);
    assert.deepEqual((await source.replication.page({ after: next })).items, []);
    await source.transaction(async (tx) => {
      await tx.collection('notes').delete('b');
      await tx.collection('notes').put({ id: 'b', n: 1, group: 'west' });
      await tx.collection('notes').put({ id: 'c', n: 2, group: 'east' });
    });
    const page = await source.replication.page({ after: next });
    assert.deepEqual(page.items.map((item) => item.operations.map((operation) => [operation.table, operation.key])), [[['notes', 'c']]]);
  }
  finally { await source.close(); }
});

for (const mode of ['session', 'journal']) it(`${mode}: an unlink and link of one pair across two saves of one transaction commits and replicates nothing`, async () => {
  const source = await openStore(structuredClone(replicationModel), { driver: nodeDriver(), capture: { mode }, replication: { replica: 'source' } });
  try {
    await source.entity('Tag').create({ id: 't1', label: 'one' });
    await source.entity('Parent').create({ id: 'P1', name: 'first' });
    source.entity('Parent').link('P1', 'tags', 't1');
    await source.saveChanges();
    const { next } = await source.replication.page();
    // the membership row is the one it was: no operation, and the commit stands
    await source.transaction(async (tx) => {
      tx.entity('Parent').unlink('P1', 'tags', 't1');
      await tx.saveChanges();
      tx.entity('Parent').link('P1', 'tags', 't1');
      await tx.saveChanges();
    });
    assert.deepEqual((await source.replication.page({ after: next })).items, []);
    const parent = await source.entity('Parent').asNoTracking().load({ include: { tags: true } });
    assert.deepEqual(parent[0].tags.map((tag) => tag.id), ['t1']);
  }
  finally { await source.close(); }
});
