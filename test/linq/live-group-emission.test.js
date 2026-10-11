//@ts-check
/**
 * @file Live collection queries over a group emission — one `groupBy`
 * followed by `select`/`where` steps, as `@jarenjs/linq` emits it
 * (LIVE-FORMAT §7, §8): maintained by per-group recomputation (`group`,
 * incremental), every source row filed under its group by the row
 * phrase's own filter and depending on every member of the row, and equal
 * to a fresh run after every committed change of a seeded trial — single
 * writes, three-write transactions and rolled-back ones, with a patch
 * mirror; an aggregate over such an emission folds its group outputs, and
 * every source row and output item is charged to `live.maxMaintained`. A
 * group of groups and a chain that orders, windows or deduplicates after
 * `groupBy` keep their named re-runs, and so do an emission the live
 * evaluator cannot compile without the store's registered operators, and
 * a group, emission, nested group or window that names the collection
 * root inside a path filter. A result that is one array is one row in
 * every mode — maintained, re-run, resnapshot, on PostgreSQL too — as the
 * packed document's fresh run answers.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { createJsltRegistry, statsPack } from '@jarenjs/json/jslt';
import { openStore, PLANNER_REASONS } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { asyncLive } from '@jarenjs/db/async-live';
import { fromAsync } from '@jarenjs/linq';
import { mulberry32 } from '@jarenjs/core/random';
import { liveOracle } from '../db/oracle/replication.js';
import { skipFor, withPostgres } from '../db/store-core-engines.js';

/** The collection model, its `region` typed or not. @param {any} region */
const modelWith = (region) => ({
  $model: '0.1',
  collections: {
    rows: {
      schema: { type: 'object', properties: {
        id: { type: 'string' }, region, team: { type: 'string' }, score: { type: 'integer' } } },
      key: '/id',
    },
  },
});
const ROWS = [
  { id: 'r1', region: 'west', team: 'x', score: 1 },
  { id: 'r2', region: 'east', team: 'x', score: 2 },
  { id: 'r3', region: 'west', team: 'x', score: 3 },
];
const MAINTAINED = { strategy: 'group', mode: 'incremental' };
/** The planner's reason for a document that is no emission (its source is not the collection). */
const FOR = "'$for' — only a single plain binding over the whole collection is translated";

/** A capturing store over the three rows, opened with `options` besides.
 * @param {Record<string, unknown>} [options] */
async function seeded(options = {}) {
  const store = await openStore(modelWith({ type: 'string' }), { driver: nodeDriver(), capture: true, ...options });
  for (const row of ROWS) await store.collection('rows').insert(row);
  return store;
}

/** A collection as an `@jarenjs/linq` sequence. @param {any} rows @returns {any} */
const linq = (rows) => fromAsync(rows);
/** The rows grouped by region. @param {any} rows @returns {any} */
const byRegion = (rows) => linq(rows).groupBy((/** @type {any} */ r) => r.region);
/** @param {string} code */
const codeIs = (code) => (/** @type {any} */ error) => error.code === code;

describe('a group emission is maintained', () => {
  it('one groupBy and a select: a change to a member only the rows carry reaches the group', async () => {
    const store = await seeded();
    try {
      const rows = store.collection('rows');
      const chain = byRegion(rows).select((/** @type {any} */ g) => ({ key: g.key, total: g.items.all().score.sum() }));
      const document = chain.toDocument();
      const live = await rows.live(document);
      assert.deepEqual(live.mode, MAINTAINED);
      assert.deepEqual(live.result.rows, [{ key: 'west', total: 4 }, { key: 'east', total: 2 }]);
      assert.deepEqual(live.result.rows, await chain.toArray(), 'the chain answers the same rows');
      const oracle = liveOracle(live, () => rows.execute([document]));
      await rows.patch('r1', [{ op: 'replace', path: '/score', value: 10 }]);
      assert.deepEqual(live.result.rows, [{ key: 'west', total: 13 }, { key: 'east', total: 2 }]);
      assert.equal(oracle.emissions, 1, 'the sum reads score through the group rows');
      await oracle.check();
      oracle.close();
    }
    finally { await store.close(); }
  });

  it('a filter after groupBy keeps the groups it accepts, while the rows are filed by the row filter', async () => {
    const store = await seeded();
    try {
      const rows = store.collection('rows');
      const kept = byRegion(rows).where((/** @type {any} */ g) => g.items.count().gt(1));
      const keys = kept.select((/** @type {any} */ g) => g.key).toDocument();
      const groups = kept.toDocument();
      const liveKeys = await rows.live(keys);
      const liveGroups = await rows.live(groups);
      assert.deepEqual(liveKeys.mode, MAINTAINED);
      assert.deepEqual(liveGroups.mode, MAINTAINED);
      assert.deepEqual(liveKeys.result.rows, ['west']);
      assert.deepEqual(liveGroups.result.rows, [{ key: 'west', items: [ROWS[0], ROWS[2]] }]);
      const oracles = [liveOracle(liveKeys, () => rows.execute([keys])),
        liveOracle(liveGroups, () => rows.execute([groups]))];
      await rows.patch('r3', [{ op: 'replace', path: '/team', value: 'z' }]);
      assert.equal(oracles[1].emissions, 1, 'the group objects carry team');
      assert.deepEqual(liveGroups.result.rows, [{ key: 'west', items: [ROWS[0], { ...ROWS[2], team: 'z' }] }]);
      await rows.insert({ id: 'r4', region: 'east', team: 'y', score: 4 });
      assert.deepEqual(liveKeys.result.rows, ['west', 'east']);
      await rows.delete('r1');
      assert.deepEqual(liveKeys.result.rows, ['east']);
      for (const oracle of oracles) {
        await oracle.check();
        oracle.close();
      }
    }
    finally { await store.close(); }
  });

  it('a row filter before groupBy files only the rows it accepts, so a group is ordered by its first accepted row', async () => {
    const store = await seeded();
    try {
      const rows = store.collection('rows');
      const document = linq(rows).where((/** @type {any} */ r) => r.score.gt(1)).groupBy((/** @type {any} */ r) => r.region)
        .select((/** @type {any} */ g) => ({ key: g.key, n: g.items.count() })).toDocument();
      const live = await rows.live(document);
      assert.deepEqual(live.mode, MAINTAINED);
      assert.deepEqual(live.result.rows, [{ key: 'east', n: 1 }, { key: 'west', n: 1 }]);
      const oracle = liveOracle(live, () => rows.execute([document]));
      // r1 is read again and still refused: it holds no place in its group
      await rows.patch('r1', [{ op: 'replace', path: '/team', value: 'y' }]);
      assert.deepEqual(live.result.rows, [{ key: 'east', n: 1 }, { key: 'west', n: 1 }]);
      await oracle.check();
      await rows.patch('r1', [{ op: 'replace', path: '/score', value: 5 }]);
      assert.deepEqual(live.result.rows, [{ key: 'west', n: 2 }, { key: 'east', n: 1 }]);
      await oracle.check();
      oracle.close();
    }
    finally { await store.close(); }
  });

  it('a demanded incremental mode registers a count per group', async () => {
    const store = await seeded();
    try {
      const rows = store.collection('rows');
      const document = byRegion(rows).select((/** @type {any} */ g) => ({ key: g.key, n: g.items.count() })).toDocument();
      const live = await rows.live(document, { mode: 'incremental' });
      assert.deepEqual(live.mode, MAINTAINED);
      assert.deepEqual(live.result.rows, [{ key: 'west', n: 2 }, { key: 'east', n: 1 }]);
      live.close();
    }
    finally { await store.close(); }
  });

  it('an aggregate over an emission folds its group outputs', async () => {
    const store = await seeded();
    try {
      const rows = store.collection('rows');
      const counts = byRegion(rows).select((/** @type {any} */ g) => g.items.count());
      const document = { $sum: counts.toDocument() };
      const live = await rows.live(document, { mode: 'incremental' });
      assert.deepEqual(live.mode, MAINTAINED);
      assert.deepEqual(live.result.rows, [3]);
      assert.deepEqual(live.result.rows, [await counts.sum()], 'the chain\'s own sum() answers the same');
      const oracle = liveOracle(live, () => rows.execute([document]));
      await rows.insert({ id: 'r4', region: 'north', team: 'x', score: 4 });
      assert.deepEqual(live.result.rows, [4]);
      await oracle.check();
      oracle.close();
    }
    finally { await store.close(); }
  });

  it('a row deleted and inserted again with an equal value takes its new place once a later change to it reaches capture', async () => {
    const store = await seeded();
    try {
      const rows = store.collection('rows');
      const document = byRegion(rows).select((/** @type {any} */ g) => ({ key: g.key, n: g.items.count() })).toDocument();
      const live = await rows.live(document);
      const oracle = liveOracle(live, () => rows.execute([document]));
      // capture records no change for a row that comes back with an equal value
      await store.transaction(async (tx) => {
        await tx.collection('rows').delete('r1');
        await tx.collection('rows').insert(ROWS[0]);
      });
      await rows.patch('r1', [{ op: 'replace', path: '/team', value: 'y' }]);
      assert.deepEqual(live.result.rows, [{ key: 'east', n: 1 }, { key: 'west', n: 2 }]);
      await oracle.check();
      oracle.close();
    }
    finally { await store.close(); }
  });
});

describe('the group-emission boundary', () => {
  it('a group of groups and a chain that orders, windows or deduplicates after groupBy keep their named re-runs', async () => {
    const store = await seeded();
    try {
      const rows = store.collection('rows');
      /** @type {[any, string][]} */
      const cases = [
        [byRegion(rows).groupBy((/** @type {any} */ g) => g.items.count()), FOR],
        [byRegion(rows).orderBy((/** @type {any} */ g) => g.key).select((/** @type {any} */ g) => g.key), FOR],
        [byRegion(rows).select((/** @type {any} */ g) => g.key).take(2), 'a windowed group re-runs'],
        [byRegion(rows).select((/** @type {any} */ g) => g.items.count()).distinct(),
          `'$distinct' — ${PLANNER_REASONS['plan.distinctProjection'].text}`],
      ];
      for (const [chain, reason] of cases) {
        const document = chain.toDocument();
        const live = await rows.live(document);
        assert.deepEqual(live.mode, { strategy: 'rerun', mode: 'rerun', reason });
        assert.deepEqual(live.result.rows, await rows.execute([document]));
        live.close();
        await assert.rejects(async () => rows.live(document, { mode: 'incremental' }), codeIs('JD0051'));
      }
    }
    finally { await store.close(); }
  });

  it('an emission the live evaluator cannot compile without the store\'s registered operators re-runs with the planner\'s reason', async () => {
    const store = await seeded({ operators: createJsltRegistry().use(statsPack) });
    try {
      const rows = store.collection('rows');
      const document = { $for: { it: [byRegion(rows).toDocument()] },
        $return: { key: '$it.key', m: { $mean: '$it.items[*].score' } } };
      const live = await rows.live(document);
      assert.deepEqual(live.mode, { strategy: 'rerun', mode: 'rerun',
        reason: "'$mean' — registered operator '$mean' runs in the residual (Ring 2 — correct, not pushed to SQL)" });
      const oracle = liveOracle(live, () => rows.execute([document]));
      await oracle.check();
      await rows.insert({ id: 'r4', region: 'east', team: 'x', score: 6 });
      assert.deepEqual(live.result.rows, [{ key: 'west', m: 2 }, { key: 'east', m: 4 }]);
      await oracle.check();
      oracle.close();
    }
    finally { await store.close(); }
  });

  it('an outer level that reads the collection root or binds a second source is no emission and re-runs', async () => {
    const store = await seeded();
    try {
      const rows = store.collection('rows');
      const group = byRegion(rows).toDocument();
      const documents = [
        { $for: { it: [group] }, $return: { key: '$it.key', share: { $count: '$[*]' } } },
        { $for: { it: [group] }, $where: { $gt: [{ $count: '$[*]' }, 2] }, $return: '$it.key' },
        { $for: { it: [group], other: [group] }, $return: { a: '$it.key', b: '$other.key' } },
      ];
      for (const document of documents) {
        const live = await rows.live(document);
        assert.deepEqual(live.mode, { strategy: 'rerun', mode: 'rerun', reason: FOR });
        const oracle = liveOracle(live, () => rows.execute([document]));
        await oracle.check();
        await rows.insert({ id: 'r4', region: 'north', team: 'x', score: 4 });
        await oracle.check();
        await rows.delete('r4');
        oracle.close();
        live.close();
      }
    }
    finally { await store.close(); }
  });

  it('a row filter the store cannot compile is refused at its place in the document, as execute refuses it', async () => {
    const store = await seeded();
    try {
      const rows = store.collection('rows');
      const document = { $for: { it: [{ $for: { it: '$[*]' }, $where: { $matches: ['$it.team', '^x'] },
        $groupby: { g: '$it.region' }, $return: { key: { $default: ['$g', null] }, items: ['$it'] } }] },
      $where: { $gt: [{ $count: '$it.items[*]' }, 0] }, $return: '$it.key' };
      const refusal = (/** @type {any} */ error) => error.code === 'JQ0002' && error.docPath === '/$for/it/0/$where';
      await assert.rejects(async () => rows.execute(document), refusal);
      await assert.rejects(async () => rows.live(document), refusal);
    }
    finally { await store.close(); }
  });
});

describe('a root read inside a path filter', () => {
  it('re-runs a group, an emission, a nested group and a window that name the collection root in a filter', async () => {
    const store = await seeded();
    try {
      const rows = store.collection('rows');
      const NONNATIVE = "'$groupby' — nonnative-grouping: the grouping key or the projection is not the closed bucket shape";
      /** @type {[any, string][]} */
      const cases = [
        [{ $for: { r: '$[*]' }, $groupby: { g: '$r.region' },
          $return: { key: '$g', n: { $count: '$r[?@ == $[0].score]' } } }, NONNATIVE],
        [{ $for: { it: [byRegion(rows).toDocument()] },
          $return: { key: '$it.key', n: { $count: '$it.items[?@.score >= $[0].score]' } } }, FOR],
        [{ $for: { row: '$[*]' }, $groupby: { region: '$row.region' }, $return: { region: '$region',
          teams: [{ $for: { leaf: '$row' }, $where: { $gt: [{ $count: '$leaf[?@ == $[0].score]' }, 0] },
            $groupby: { team: '$leaf.team' }, $return: { team: '$team', n: { $count: '$leaf' } } }] } }, NONNATIVE],
        [{ $subsequence: [{ $for: { it: '$[*]' }, $orderby: '$it.score',
          $return: { id: '$it.id', top: { $count: '$it[?@ == $[0].score]' } } }, 0, 2] },
        'a projection that reads the collection root re-runs (a row is evaluated alone)'],
      ];
      for (const [document, reason] of cases) {
        const live = await rows.live(document);
        assert.deepEqual(live.mode, { strategy: 'rerun', mode: 'rerun', reason });
        const oracle = liveOracle(live, () => rows.execute([document]));
        await oracle.check();
        await rows.patch('r1', [{ op: 'replace', path: '/score', value: 9 }]);
        await oracle.check();
        await rows.patch('r1', [{ op: 'replace', path: '/score', value: 1 }]);
        oracle.close();
        live.close();
      }
    }
    finally { await store.close(); }
  });
});

describe('a result that is one array is one row in every mode', () => {
  /** The rows of each group of more than one row: one array per group.
   * @param {any} rows @returns {any} */
  const itemsOfLargeGroups = (rows) => byRegion(rows)
    .where((/** @type {any} */ g) => g.items.count().gt(1)).select((/** @type {any} */ g) => g.items);
  const EAST_ROW = { id: 'r4', region: 'east', team: 'y', score: 4 };
  for (const mode of ['auto', 'rerun', 'resnapshot']) {
    it(`${mode}: the rows equal the packed document's fresh run and the chain's toArray()`, async () => {
      const store = await seeded({ capture: { log: true }, live: asyncLive({ pollMs: 60000 }) });
      try {
        const rows = store.collection('rows');
        const chain = itemsOfLargeGroups(rows);
        const document = chain.toDocument();
        const live = await rows.live(document, { mode });
        assert.equal(live.mode.strategy, mode === 'auto' ? 'group' : mode);
        assert.deepEqual(live.result.rows, [[ROWS[0], ROWS[2]]], 'one group, one row');
        assert.deepEqual(live.result.rows, await rows.execute([document]));
        assert.deepEqual(live.result.rows, await chain.toArray());
        await rows.insert(EAST_ROW);
        if (mode === 'resnapshot') await live.refresh();
        assert.deepEqual(live.result.rows, [[ROWS[0], ROWS[2]], [ROWS[1], EAST_ROW]]);
        assert.deepEqual(live.result.rows, await rows.execute([document]));
        await live.close();
      }
      finally { await store.close(); }
    });
  }

  it('resnapshot on PostgreSQL: the rows equal the packed document\'s fresh run', { skip: skipFor('postgres') }, async () => {
    await withPostgres(async ({ driver }) => {
      const store = await openStore(modelWith({ type: 'string' }), { driver: driver(),
        capture: { mode: 'journal', log: true }, live: asyncLive({ pollMs: 60000 }) });
      try {
        const rows = store.collection('rows');
        for (const row of ROWS) await rows.insert(row);
        const document = itemsOfLargeGroups(rows).toDocument();
        const live = await rows.live(document);
        assert.equal(live.mode.strategy, 'resnapshot');
        assert.deepEqual(live.result.rows, [[ROWS[0], ROWS[2]]], 'one group, one row');
        assert.deepEqual(live.result.rows, await rows.execute([document]));
        await rows.insert(EAST_ROW);
        await live.refresh();
        assert.deepEqual(live.result.rows, await rows.execute([document]));
        await live.close();
      }
      finally { await store.close(); }
    });
  });

  it('a re-run or resnapshot refusal names its place in the document as registered', async () => {
    const store = await seeded({ capture: { log: true }, live: asyncLive({ pollMs: 60000 }) });
    try {
      const rows = store.collection('rows');
      // a member that evaluates to two items: JQ2001 for the west group
      const document = { $for: { r: '$[*]' }, $groupby: { g: '$r.region' }, $return: { key: '$g', odd: '$r' } };
      const at = (/** @type {string} */ docPath) => (/** @type {any} */ error) =>
        error.code === 'JQ2001' && error.docPath === docPath;
      await assert.rejects(async () => rows.execute(document), at('/$return/odd'));
      await assert.rejects(async () => rows.execute([document]), at('/0/$return/odd'));
      for (const mode of ['rerun', 'resnapshot']) {
        await assert.rejects(async () => rows.live(document, { mode }), at('/$return/odd'));
        await assert.rejects(async () => rows.live([document], { mode }), at('/0/$return/odd'));
      }
    }
    finally { await store.close(); }
  });
});

describe('the maintained-state credit', () => {
  it('every source row and output item is an entry: past live.maxMaintained an emission is JD2060, and mode \'rerun\' serves it', async () => {
    const store = await seeded({ live: { maxMaintained: 5 } });
    try {
      const rows = store.collection('rows');
      const document = byRegion(rows).select((/** @type {any} */ g) => ({ key: g.key, n: g.items.count() })).toDocument();
      // three source rows and two output items are five entries
      const live = await rows.live(document);
      assert.deepEqual(live.mode, MAINTAINED);
      /** @type {any[]} */
      const errors = [];
      live.subscribe((/** @type {any} */ { error }) => { if (error !== undefined) errors.push(error); });
      await rows.insert({ id: 'r4', region: 'east', team: 'x', score: 4 });
      assert.deepEqual(errors.map((error) => error.code), ['JD2060'], 'the sixth entry closes the query');
      await assert.rejects(async () => rows.live(document), codeIs('JD2060'));
      const rerun = await rows.live(document, { mode: 'rerun' });
      assert.deepEqual(rerun.result.rows, [{ key: 'west', n: 2 }, { key: 'east', n: 2 }]);
      rerun.close();
    }
    finally { await store.close(); }
  });
});

describe('the group-emission trial (seeded)', () => {
  /** Each shape's document over the collection `rows`. @type {Record<string, (rows: any) => any>} */
  const SHAPES = {
    'a sum per group': (rows) => byRegion(rows)
      .select((/** @type {any} */ g) => ({ key: g.key, total: g.items.all().score.sum() })).toDocument(),
    'a count per group': (rows) => byRegion(rows)
      .select((/** @type {any} */ g) => ({ key: g.key, n: g.items.count() })).toDocument(),
    'the keys of the groups a filter keeps': (rows) => byRegion(rows)
      .where((/** @type {any} */ g) => g.items.count().gt(1)).select((/** @type {any} */ g) => g.key).toDocument(),
    'the groups a filter keeps': (rows) => byRegion(rows)
      .where((/** @type {any} */ g) => g.items.count().gt(1)).toDocument(),
    'a row filter before groupBy': (rows) => linq(rows).where((/** @type {any} */ r) => r.score.gt(3))
      .groupBy((/** @type {any} */ r) => r.region)
      .select((/** @type {any} */ g) => ({ key: g.key, total: g.items.all().score.sum() })).toDocument(),
    'two keys': (rows) => linq(rows).groupBy((/** @type {any} */ r) => ({ g: r.region, t: r.team }))
      .select((/** @type {any} */ g) => ({ key: g.key, n: g.items.count() })).toDocument(),
    'a filter after the select': (rows) => byRegion(rows)
      .select((/** @type {any} */ g) => ({ key: g.key, n: g.items.count() }))
      .where((/** @type {any} */ x) => x.n.gt(1)).toDocument(),
    'a select after the select': (rows) => byRegion(rows)
      .select((/** @type {any} */ g) => ({ key: g.key, total: g.items.all().score.sum() }))
      .select((/** @type {any} */ x) => x.total).toDocument(),
    'the sum of the group counts': (rows) => ({
      $sum: byRegion(rows).select((/** @type {any} */ g) => g.items.count()).toDocument() }),
  };
  const REGIONS = ['west', 'east', null, undefined, 1, '1'];
  const TEAMS = ['x', 'y', 'z'];
  const KEYS = Array.from({ length: 9 }, (_, i) => `r${i}`);

  it('nine group emissions equal a fresh run after every committed change', async () => {
    const rand = mulberry32(5);
    /** @param {any[]} values */
    const pick = (values) => values[Math.floor(rand() * values.length)];
    /** @param {string} id */
    const row = (id) => {
      const region = pick(REGIONS);
      return { id, ...(region === undefined ? {} : { region }), team: pick(TEAMS), score: Math.floor(rand() * 10) };
    };
    /** One write: a put, or on a present row a delete or a patch of one member.
     * @param {any} collection @param {Set<string>} present */
    const write = async (collection, present) => {
      const id = pick(KEYS);
      const roll = rand();
      if (!present.has(id) || roll < 0.3) {
        await collection.put(row(id), id);
        present.add(id);
      }
      else if (roll < 0.5) {
        await collection.delete(id);
        present.delete(id);
      }
      else if (roll < 0.75) await collection.patch(id, [{ op: 'replace', path: '/team', value: pick(TEAMS) }]);
      else await collection.patch(id, [{ op: 'replace', path: '/score', value: Math.floor(rand() * 10) }]);
    };
    let checks = 0;
    for (let trial = 0; trial < 10; trial++) {
      const store = await openStore(modelWith({}), { driver: nodeDriver(), capture: true });
      try {
        const rows = store.collection('rows');
        let present = new Set(KEYS.slice(0, 6));
        for (const id of present) await rows.insert(row(id));
        const watches = [];
        for (const [name, shape] of Object.entries(SHAPES)) {
          const document = shape(rows);
          // registered as the client hands it over, or packed; the fresh run
          // is the packed document — the chain's toArray()
          const live = await rows.live(trial % 2 === 0 ? document : [document], { mode: 'incremental' });
          assert.deepEqual(live.mode, MAINTAINED, name);
          watches.push({ name, oracle: liveOracle(live, () => rows.execute([document])) });
        }
        for (let step = 0; step < 30; step++) {
          const label = `trial ${trial} step ${step}`;
          const before = watches.map(({ oracle }) => oracle.emissions);
          const roll = rand();
          if (roll < 0.15) {
            const staged = new Set(present);
            const undone = await store.transaction(async (tx) => {
              for (let i = 0; i < 3; i++) await write(tx.collection('rows'), staged);
              throw new Error('undo');
            }).catch((error) => {
              // only the deliberate rollback: a store error is a failure
              if (error.message !== 'undo') throw error;
              return 'rolled back';
            });
            assert.equal(undone, 'rolled back');
            assert.deepEqual(watches.map(({ oracle }) => oracle.emissions), before,
              `${label}: a rolled-back transaction emits nothing`);
          }
          else if (roll < 0.4) {
            const staged = new Set(present);
            await store.transaction(async (tx) => {
              for (let i = 0; i < 3; i++) await write(tx.collection('rows'), staged);
            });
            present = staged;
          }
          else await write(rows, present);
          for (const [index, { name, oracle }] of watches.entries()) {
            assert.ok(oracle.emissions - before[index] <= 1, `[${name}] ${label}: one change, at most one emission`);
            await oracle.check().catch((error) => {
              throw new Error(`[${name}] ${label}: ${error.message}`);
            });
            checks++;
          }
        }
        for (const { oracle } of watches) oracle.close();
      }
      finally { await store.close(); }
    }
    assert.equal(checks, 2700);
  });
});
