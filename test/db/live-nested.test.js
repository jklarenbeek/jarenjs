//@ts-check
import { it } from 'node:test';
import * as assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { liveOracle } from './oracle/replication.js';

const model = { $model: '0.1', collections: { rows: { key: '/id', schema: { type: 'object', properties: {
  id: { type: 'string' }, region: { type: 'string' }, team: { type: 'string' }, score: { type: 'number' },
} } } } };
const document = [{ $for: { row: '$[*]' }, $groupby: { region: '$row.region' }, $return: {
  region: '$region', total: { $sum: '$row.score' }, teams: [{ $for: { leaf: '$row' },
    $groupby: { team: '$leaf.team' }, $return: { team: '$team', count: { $count: '$leaf' }, max: { $max: '$leaf.score' } } }],
} }];

for (const mode of ['session', 'journal']) it(`${mode}: nested groups reconstruct moves and deletes with bounded parent recomputation`, async () => {
  const store = await openStore(model, { driver: nodeDriver(), capture: { mode } });
  try {
    const rows = store.collection('rows');
    await rows.put({ id: 'a', region: 'west', team: 'x', score: 5 });
    await rows.put({ id: 'b', region: 'east', team: 'y', score: 3 });
    const live = await rows.live(document, { mode: 'incremental' });
    assert.equal(live.mode.strategy, 'nested-group');
    const oracle = liveOracle(live, () => rows.execute(document)); await oracle.check();
    const prior = live.result.rows[1]; const count = live.stats().refreshedGroups;
    await rows.put({ id: 'c', region: 'west', team: 'x', score: 9 }); await oracle.check();
    assert.equal(live.stats().refreshedGroups - count, 1); assert.equal(live.result.rows[1], prior);
    await rows.put({ id: 'a', region: 'east', team: 'z', score: 7 }); await oracle.check();
    await rows.delete('c'); await oracle.check();
    await rows.delete('a'); await oracle.check();
    oracle.close();
  }
  finally { await store.close(); }
});

it('nested groups keep offset windows and unsupported operations on named reruns', async () => {
  const store = await openStore(model, { driver: nodeDriver(), capture: true });
  try {
    const live = await store.collection('rows').live([{ $subsequence: [document[0], 1, 3] }]);
    assert.equal(live.mode.mode, 'rerun'); assert.ok(live.mode.reason);
    await assert.rejects(store.collection('rows').live([{ $subsequence: [document[0], 1, 3] }], { mode: 'incremental' }), { code: 'JD0051' });
  }
  finally { await store.close(); }
});

for (const liveBounds of [{ maxMaintained: 2 }, { maxBytes: 150 }]) it('nested group state growth closes once at its row or byte capacity', async () => {
  const store = await openStore(model, { driver: nodeDriver(), capture: true, live: liveBounds });
  try {
    const rows = store.collection('rows');
    const live = await rows.live(document);
    const events = []; live.subscribe((event) => events.push(event));
    await rows.put({ id: 'a', region: 'w', team: 'x', score: 5 });
    if (live.state === 'live') await rows.put({ id: 'b', region: 'w', team: 'x', score: 3 });
    assert.equal(live.error.code, 'JD2060');
    const count = events.length;
    await rows.put({ id: 'c', region: 'w', team: 'x', score: 1 });
    assert.equal(events.length, count);
    await assert.rejects(rows.live(document), { code: 'JD2060' });
  }
  finally { await store.close(); }
});

it('nested group order follows the first qualifying row when a filter changes', async () => {
  const store = await openStore(model, { driver: nodeDriver(), capture: true });
  const filtered = [{ ...document[0], $where: { $gt: ['$row.score', 0] } }];
  try {
    const rows = store.collection('rows');
    await rows.put({ id: 'a', region: 'west', team: 'x', score: -1 });
    await rows.put({ id: 'b', region: 'east', team: 'x', score: 1 });
    await rows.put({ id: 'c', region: 'west', team: 'y', score: 2 });
    const live = await rows.live(filtered, { mode: 'incremental' });
    const oracle = liveOracle(live, () => rows.execute(filtered));
    await oracle.check();
    await rows.put({ id: 'a', region: 'west', team: 'x', score: 3 }); await oracle.check();
    await rows.put({ id: 'b', region: 'east', team: 'x', score: -1 }); await oracle.check();
    await rows.delete('a'); await oracle.check();
    oracle.close();
  }
  finally { await store.close(); }
});
