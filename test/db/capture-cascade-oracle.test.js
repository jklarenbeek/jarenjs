//@ts-check
/**
 * @file Seeded trials of journal capture over the database's foreign-key
 * actions on `node:sqlite`. Every record a random workload commits — over
 * creates, direct and synchronous deletes, tracked saves, re-parenting
 * transactions, rolled-back savepoints and refused deletes — folded over the
 * complete logical state before its transaction gives the state after it,
 * and journal records equal session records; live queries over the rows
 * those actions change stay equal to a fresh evaluation. A self-test proves
 * the state check is not vacuous.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { cascadeModel, seedCascade, cascadeWorkload, trialModel, storeState, checkRecords, randomWorkload }
  from './oracle/cascade.js';
import { liveOracle } from './oracle/replication.js';

const SEEDS = 40;
const OPERATIONS = 30;

/** The records a fresh store commits for one seed. @param {string} mode @param {number} seed */
const trial = async (mode, seed) => {
  const store = await openStore(trialModel(), { driver: nodeDriver(), capture: { mode } });
  try { return await randomWorkload(store, seed, OPERATIONS, { sync: true }); }
  finally { await store.close(); }
};

/**
 * What a seed's foreign-key actions changed: rows of entities the workload
 * never deletes itself, nulled members, membership rows.
 * @param {string[][]} records - canonical records
 */
const reach = (records) => {
  const lines = records.flat();
  return {
    removed: lines.filter((line) => /^remove \/(Grand|Passport|Mixed|Pair)\//.test(line)).length,
    nulled: lines.filter((line) => /^remove \/\w+\/[^/ ]+\/\w+$/.test(line)).length,
    memberships: lines.filter((line) => /^remove \/(Parent_Tag|Child_Label)\//.test(line)).length,
  };
};

// every Child row; an explicit order over an entity root is re-evaluated, not maintained
const CHILDREN = [{ $for: { c: '$.Child[*]' }, $return: '$c' }];
// each parent with its children
const GRAPH = [{ $for: { p: '$.Parent[*]' }, $return: { id: '$p.id', children: [{
  $for: { c: '$.Child[*]' }, $where: { $eq: ['$c.parentId', '$p.id'] }, $return: '$c' }] } }];

/**
 * Both live queries, maintained incrementally and each mirrored from its
 * patches alone; `check` compares both with a fresh evaluation.
 * @param {any} store
 */
const watch = async (store) => {
  /** @type {any[]} */
  const oracles = [];
  for (const [document, strategy] of /** @type {[any[], string][]} */ ([[CHILDREN, 'join'], [GRAPH, 'graph']])) {
    const live = await store.live(document, { mode: 'incremental' });
    assert.equal(live.mode.strategy, strategy);
    oracles.push(liveOracle(live, () => store.execute(document)));
  }
  return {
    async check() { for (const oracle of oracles) await oracle.check(); },
    close() { for (const oracle of oracles) oracle.close(); },
  };
};

describe('seeded journal capture of foreign-key actions', () => {
  it('the oracle rejects a record with one cascaded removal dropped', async () => {
    const model = cascadeModel();
    const store = await openStore(model, { driver: nodeDriver(), capture: { mode: 'session' } });
    try {
      await seedCascade(store);
      const before = await storeState(store, model);
      /** @type {any[]} */
      const records = [];
      store.observe((/** @type {any} */ record) => { records.push(record); });
      await store.entity('Parent').delete('q');
      const after = await storeState(store, model);
      assert.equal(records.length, 1);
      checkRecords(before, records, after);
      const [{ patch }] = records;
      assert.deepEqual(patch.map((/** @type {any} */ op) => `${op.op} ${op.path}`).sort(), ['remove /Child/c3',
        'remove /Grand/g3', 'remove /Mixed/m2', 'remove /Note/n2/parentId', 'remove /Parent/q']);
      for (const dropped of patch) {
        assert.throws(() => checkRecords(before, [{ patch: patch.filter((/** @type {any} */ op) => op !== dropped) }], after),
          { name: 'AssertionError' }, `${dropped.op} ${dropped.path} dropped`);
      }
    }
    finally { await store.close(); }
  });

  for (let seed = 1; seed <= SEEDS; seed += 1) {
    it(`seed ${seed}: every record yields the next state and journal records equal session records`, async () => {
      const session = await trial('session', seed);
      const journal = await trial('journal', seed);
      assert.deepEqual(journal.records, session.records);
      const reached = reach(journal.records);
      assert.ok(reached.removed > 0 && reached.nulled > 0 && reached.memberships > 0, JSON.stringify(reached));
    });
  }

  it('journal live queries stay equal to a fresh evaluation through the corpus workload', async () => {
    const store = await openStore(cascadeModel(), { driver: nodeDriver(), capture: { mode: 'journal' } });
    try {
      await seedCascade(store);
      const live = await watch(store);
      await live.check();
      await cascadeWorkload(store, live.check);
      await store.entity('Parent').delete('r');
      await live.check();
      live.close();
    }
    finally { await store.close(); }
  });

  it('journal live queries stay equal to a fresh evaluation through seeded workloads', async () => {
    for (let seed = 1; seed <= 5; seed += 1) {
      const store = await openStore(trialModel(), { driver: nodeDriver(), capture: { mode: 'journal' } });
      try {
        const live = await watch(store);
        await randomWorkload(store, seed, OPERATIONS, { sync: true, after: live.check });
        live.close();
      }
      finally { await store.close(); }
    }
  });
});
