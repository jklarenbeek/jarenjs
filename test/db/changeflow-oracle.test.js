//@ts-check
import { it } from 'node:test';
import * as assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { replicationModel, deliverySchedule, replicaState, liveOracle } from './oracle/replication.js';

it('transport controls reproduce schedules and expose unordered capture replay', () => {
  const messages = Array.from({ length: 12 }, (_, seq) => ({ seq: seq + 1 }));
  const options = { seed: 73, drop: [4] };
  const schedule = deliverySchedule(messages, options);
  assert.deepEqual(schedule, deliverySchedule(messages, options));
  assert.ok(schedule.length > 11);
  assert.ok(!schedule.some((m) => m.seq === 5));
  assert.notDeepEqual(schedule, messages);
  assert.deepEqual(deliverySchedule(messages, { duplicate: false }).map((m) => m.seq).sort((a, b) => a - b), messages.map((m) => m.seq));
});

for (const mode of ['session', 'journal']) it(`${mode}: state and live reconstruction oracle includes transactions and relations`, async () => {
  const store = await openStore(replicationModel, { driver: nodeDriver(), capture: { mode, log: { retention: 3 } } });
  try {
    const notes = store.collection('notes');
    const document = [{ $for: { n: '$[*]' }, $orderby: '$n.id', $return: '$n' }];
    const live = await notes.live(document);
    const oracle = liveOracle(live, () => notes.execute(document));
    for (let i = 0; i < 8; i++) {
      await store.transaction(async (tx) => {
        await tx.collection('notes').put({ id: 'hostile/~😀', n: i });
        if (i === 0) {
          await tx.entity('Tag').create({ id: 't' });
          await tx.entity('Parent').create({ id: 'p', tags: ['t'] });
        }
      });
      await oracle.check();
    }
    const state = await replicaState(store);
    assert.deepEqual(state.Parent_Tag, [['p', 't']]);
    assert.equal(state.notes['hostile/~😀'].n, 7);
    assert.equal(oracle.emissions, 8);
    assert.equal((await store.changes.page({ after: 0 })).resetRequired, true);
    assert.deepEqual(await store.changes.bounds(), { earliestAvailable: 6, highWatermark: 8 });
    oracle.close();
  }
  finally { await store.close(); }
});
