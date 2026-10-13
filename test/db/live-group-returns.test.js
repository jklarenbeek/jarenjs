//@ts-check
/**
 * @file Live collection groups whose return reads more of the group than
 * a key or one aggregate (LIVE-FORMAT §7, §8): a return that copies the
 * group's rows, arithmetic over aggregates, a return that is not an
 * object, and count/sum/avg/min/max over such groups are maintained by
 * per-group recomputation (`group`, incremental) and equal a fresh run
 * after every committed change of a seeded trial — single writes,
 * three-write transactions and rolled-back ones, with a patch mirror. A
 * group that reads a row bare — copied whole, under `$get`, in a nested
 * query or as its key — depends on every member of it, whatever its
 * return's shape; one that reads member paths only, or counts its rows,
 * depends on those members. A key deleted and inserted again in one
 * transaction moves to the end of the source order, as a fresh run reads
 * it. Every source row and output item is charged to `live.maxMaintained`.
 * A document the live evaluators cannot compile without the store's
 * registered operators or zone provider re-runs with the planner's reason
 * instead of failing registration, and ordering, windows and
 * collection-root reads keep their named re-runs.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { createJsltRegistry, statsPack } from '@jarenjs/json/jslt';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { mulberry32 } from '@jarenjs/core/random';
import { liveOracle } from './oracle/replication.js';

const MODEL = {
  $model: '0.1',
  collections: {
    users: {
      schema: { type: 'object', properties: {
        id: { type: 'string' }, name: { type: 'string' }, age: { type: 'integer' },
        dept: { type: 'string' }, pay: { type: 'number' } } },
      key: '/id',
    },
  },
};
const USERS = [
  { id: 'a', dept: 'x', pay: 10, name: 'ada' },
  { id: 'b', dept: 'y', pay: 20, name: 'bob' },
  { id: 'c', dept: 'x', pay: 5, name: 'cy' },
];

/** A capturing store over the three users, opened with `options` besides.
 * @param {Record<string, unknown>} [options] */
async function seeded(options = {}) {
  const store = await openStore(MODEL, { driver: nodeDriver(), capture: true, ...options });
  for (const row of USERS) await store.collection('users').insert(row);
  return store;
}

/** The users grouped by department, returning `ret`. @param {any} ret */
const byDept = (ret) => ({ $for: { it: '$[*]' }, $groupby: { g: '$it.dept' }, $return: ret });
const ITEMS = byDept({ key: { $default: ['$g', null] }, items: ['$it'] });
const MAINTAINED = { strategy: 'group', mode: 'incremental' };

describe('group returns beyond a key or one aggregate', () => {
  it('a return that copies the group rows is maintained, and a change to any member of a row reaches it', async () => {
    const store = await seeded();
    try {
      const users = store.collection('users');
      const live = await users.live([ITEMS]);
      assert.deepEqual(live.mode, MAINTAINED);
      const oracle = liveOracle(live, () => users.execute([ITEMS]));
      await oracle.check();
      await users.patch('a', [{ op: 'replace', path: '/name', value: 'ada2' }]);
      assert.equal(oracle.emissions, 1, 'a member only the copied rows read still reaches the group');
      assert.equal(live.result.rows[0].items[0].name, 'ada2');
      await oracle.check();
      oracle.close();
    }
    finally { await store.close(); }
  });

  it('arithmetic over an aggregate is maintained, and a change to a member it does not read is skipped', async () => {
    const store = await seeded();
    try {
      const users = store.collection('users');
      const document = [byDept({ key: '$g', x: { $add: [{ $sum: '$it.pay' }, 1] } })];
      const live = await users.live(document);
      assert.deepEqual(live.mode, MAINTAINED);
      assert.deepEqual(live.result.rows, [{ key: 'x', x: 16 }, { key: 'y', x: 21 }]);
      const oracle = liveOracle(live, () => users.execute(document));
      const { matched, dependencyReads } = live.stats();
      await users.patch('a', [{ op: 'replace', path: '/name', value: 'ada2' }]);
      assert.equal(oracle.emissions, 0, 'the return reads dept and pay only');
      assert.equal(live.stats().matched, matched);
      assert.equal(live.stats().dependencyReads, dependencyReads, 'the record is skipped, not re-read');
      await users.patch('c', [{ op: 'replace', path: '/pay', value: 6 }]);
      assert.deepEqual(live.result.rows, [{ key: 'x', x: 17 }, { key: 'y', x: 21 }]);
      await oracle.check();
      oracle.close();
    }
    finally { await store.close(); }
  });

  it('a bare external is not a row read: a change to a member the return does not read is still skipped', async () => {
    const store = await seeded();
    try {
      const users = store.collection('users');
      const document = [byDept({ key: '$g', cap: '$cap', x: { $add: [{ $sum: '$it.pay' }, 1] } })];
      const live = await users.live(document, { externals: { cap: 5 } });
      assert.deepEqual(live.mode, MAINTAINED);
      assert.deepEqual(live.result.rows, [{ key: 'x', cap: 5, x: 16 }, { key: 'y', cap: 5, x: 21 }]);
      const { dependencyReads } = live.stats();
      await users.patch('a', [{ op: 'replace', path: '/name', value: 'ada2' }]);
      assert.equal(live.stats().dependencyReads, dependencyReads, 'the record is skipped, not re-read');
      await users.patch('a', [{ op: 'replace', path: '/pay', value: 11 }]);
      assert.equal(live.stats().dependencyReads, dependencyReads + 1);
      assert.deepEqual(live.result.rows, await users.execute(document, { externals: { cap: 5 } }));
    }
    finally { await store.close(); }
  });

  it('an aggregate over groups whose return is arithmetic is maintained', async () => {
    const store = await seeded();
    try {
      const users = store.collection('users');
      const document = [{ $max: byDept({ $add: [{ $sum: '$it.pay' }, 1] }) }];
      const live = await users.live(document);
      assert.deepEqual(live.mode, MAINTAINED);
      assert.deepEqual(live.result.rows, [21]);
      const oracle = liveOracle(live, () => users.execute(document));
      await users.insert({ id: 'd', dept: 'x', pay: 30, name: 'dee' });
      assert.deepEqual(live.result.rows, [46]);
      await oracle.check();
      oracle.close();
    }
    finally { await store.close(); }
  });

  it('an output turning from one non-finite number into another changes, maintained or re-run, as a fresh run says', async () => {
    const store = await seeded();
    try {
      const users = store.collection('users');
      // no row has an age, so every ratio divides by a sum of 0
      const document = [byDept({ key: '$g', ratio: { $div: [{ $sum: '$it.pay' }, { $sum: '$it.age' }] } })];
      await users.insert({ id: 'z', dept: 'z', pay: 0, name: 'zed' });
      const lives = [await users.live(document), await users.live(document, { mode: 'rerun' })];
      assert.deepEqual(lives[0].mode, MAINTAINED);
      const oracles = lives.map((live) => liveOracle(live, () => users.execute(document)));
      const ratioOfZ = () => (/** @type {any[]} */ (lives[0].result.rows)).find((row) => row.key === 'z').ratio;
      for (const [pay, ratio] of [[0, NaN], [3, Infinity], [-3, -Infinity], [0, NaN]]) {
        await users.put({ id: 'z', dept: 'z', pay, name: 'zed' });
        assert.deepStrictEqual(ratioOfZ(), ratio);
        for (const oracle of oracles) await oracle.check();
      }
      for (const oracle of oracles) oracle.close();
    }
    finally { await store.close(); }
  });

  it('a return that raises for some data raises in registration and in maintenance, as execute does', async () => {
    const document = [byDept({ key: { $default: ['$g', null] }, deep: { $count: '$it' }, odd: '$it' })];
    const store = await seeded();
    try {
      const users = store.collection('users');
      // department x holds two rows, so `odd` evaluates to two items
      await assert.rejects(async () => users.execute(document), { code: 'JQ2001' });
      await assert.rejects(async () => users.live(document), { code: 'JQ2001' });
      await users.delete('c');
      const live = await users.live(document);
      assert.deepEqual(live.mode, MAINTAINED);
      /** @type {any[]} */
      const errors = [];
      live.subscribe(({ error }) => { if (error !== undefined) errors.push(error); });
      await users.insert({ id: 'c', dept: 'x', pay: 5, name: 'cy' });
      await assert.rejects(async () => users.execute(document), { code: 'JQ2001' });
      assert.deepEqual(errors.map((error) => error.code), ['JQ2001']);
      assert.equal(live.state, 'errored');
    }
    finally { await store.close(); }
  });
});

describe('what a group reads decides what it depends on', () => {
  it('counting the group rows reads no member of them: a change to another member is skipped', async () => {
    const store = await seeded();
    try {
      const users = store.collection('users');
      const document = [byDept({ key: '$g', n: { $count: '$it' } })];
      const live = await users.live(document);
      assert.deepEqual(live.mode, MAINTAINED);
      const { dependencyReads } = live.stats();
      await users.patch('a', [{ op: 'replace', path: '/name', value: 'ada2' }]);
      assert.equal(live.stats().dependencyReads, dependencyReads, 'the record is skipped, not re-read');
      await users.patch('a', [{ op: 'replace', path: '/dept', value: 'y' }]);
      assert.deepEqual(live.result.rows, await users.execute(document));
    }
    finally { await store.close(); }
  });

  it('a row read bare inside an aggregate or a key depends on every member, whatever the return\'s shape', async () => {
    const store = await seeded();
    try {
      const users = store.collection('users');
      const externals = { col: 'pay', by: 'dept' };
      const chosen = { $sum: { $for: { x: '$it' }, $return: { $get: ['$x', '$col'] } } };
      /** @type {[string, any, any[]][]} */
      const cases = [
        ['a sum over a nested query reading a chosen member', [byDept({ key: '$g', total: chosen })],
          [{ op: 'replace', path: '/pay', value: 100 }]],
        ['the largest of those sums', [{ $max: byDept(chosen) }], [{ op: 'replace', path: '/pay', value: 200 }]],
        ['a key chosen at registration', [{ $for: { it: '$[*]' }, $groupby: { g: { $get: ['$it', '$by'] } },
          $return: { key: '$g', n: { $count: '$it' } } }], [{ op: 'replace', path: '/dept', value: 'z' }]],
        ['the row itself as the key', [{ $for: { it: '$[*]' }, $groupby: { g: '$it' }, $return: '$g' }],
          [{ op: 'replace', path: '/name', value: 'ada3' }]],
      ];
      for (const [name, document, patch] of cases) {
        const live = await users.live(document, { externals });
        assert.deepEqual(live.mode, MAINTAINED, name);
        const oracle = liveOracle(live, () => users.execute(document, { externals }));
        await oracle.check();
        await users.patch('a', patch);
        await oracle.check().catch((error) => { throw new Error(`${name}: ${error.message}`); });
        oracle.close();
        live.close();
      }
    }
    finally { await store.close(); }
  });

  it('a key deleted and inserted again in one transaction moves to the end of the source order, as a fresh run reads it', async () => {
    const store = await seeded();
    try {
      const users = store.collection('users');
      // neither group reads `name`, the one member the transaction's diff changes
      const documents = [[byDept({ key: '$g', ids: ['$it.id'] })], [byDept({ key: '$g', n: { $count: '$it' } })]];
      const oracles = [];
      for (const document of documents) {
        const live = await users.live(document);
        assert.deepEqual(live.mode, MAINTAINED);
        oracles.push(liveOracle(live, () => users.execute(document)));
      }
      await store.transaction(async (tx) => {
        await tx.collection('users').delete('a');
        await tx.collection('users').insert({ id: 'a', dept: 'x', pay: 10, name: 'ada2' });
      });
      // `a` now follows `c`, so department x's first row follows y's
      assert.deepEqual(await users.execute(documents[0]), [{ key: 'y', ids: ['b'] }, { key: 'x', ids: ['c', 'a'] }]);
      for (const oracle of oracles) {
        await oracle.check();
        oracle.close();
      }
    }
    finally { await store.close(); }
  });
});

describe('the maintained-state credit', () => {
  it('every source row and output item is an entry: 10,000 register at the default bound, 10,001 refuse JD2060, and mode \'rerun\' or a raised live.maxMaintained serves them', async () => {
    const document = [byDept({ key: '$g', x: { $add: [{ $sum: '$it.pay' }, 1] } })];
    /** A capturing store over `count` rows of one department.
     * @param {number} count @param {Record<string, unknown>} [options] */
    const filled = async (count, options = {}) => {
      const store = await openStore(MODEL, { driver: nodeDriver(), capture: true, ...options });
      await store.transaction(async (tx) => {
        for (let i = 0; i < count; i++) await tx.collection('users').insert({ id: `u${i}`, dept: 'x', pay: 1 });
      });
      return store;
    };
    // one group: 9,999 source rows and its one output item are 10,000 entries
    const store = await filled(9999);
    try {
      const users = store.collection('users');
      const live = await users.live(document);
      assert.deepEqual(live.mode, MAINTAINED);
      /** @type {any[]} */
      const errors = [];
      live.subscribe(({ error }) => { if (error !== undefined) errors.push(error); });
      await users.insert({ id: 'u9999', dept: 'x', pay: 1 });
      assert.deepEqual(errors.map((error) => error.code), ['JD2060'], 'the 10,001st entry closes the query');
      await assert.rejects(async () => users.live(document), { code: 'JD2060' });
      const rerun = await users.live(document, { mode: 'rerun' });
      assert.deepEqual(rerun.result.rows, [{ key: 'x', x: 10001 }]);
    }
    finally { await store.close(); }
    const raised = await filled(10000, { live: { maxMaintained: 10001 } });
    try {
      const live = await raised.collection('users').live(document);
      assert.deepEqual(live.mode, MAINTAINED);
      assert.deepEqual(live.result.rows, [{ key: 'x', x: 10001 }]);
    }
    finally { await raised.close(); }
  });
});

describe('a document the live evaluators cannot compile re-runs instead of failing registration', () => {
  const MEAN = "'$mean' — registered operator '$mean' runs in the residual (Ring 2 — correct, not pushed to SQL)";
  /** @type {[string, any][]} */
  const cases = [
    ['a group return using a registered operator', [byDept({ key: '$g', m: { $mean: ['$it.pay'] } })]],
    ['a canonical group aggregating a registered operator',
      [byDept({ key: '$g', m: { $max: { $mean: ['$it.pay'] } } })]],
    ['rows projecting a registered operator',
      [{ $for: { it: '$[*]' }, $return: { id: '$it.id', m: { $mean: ['$it.pay'] } } }]],
  ];
  for (const [name, document] of cases) {
    it(`${name}: re-runs with the planner's reason and answers what execute answers`, async () => {
      const store = await seeded({ operators: createJsltRegistry().use(statsPack) });
      try {
        const users = store.collection('users');
        const live = await users.live(document);
        assert.deepEqual(live.mode, { strategy: 'rerun', mode: 'rerun', reason: MEAN });
        const oracle = liveOracle(live, () => users.execute(document));
        await oracle.check();
        await users.insert({ id: 'd', dept: 'y', pay: 7, name: 'dee' });
        await oracle.check();
        oracle.close();
      }
      finally { await store.close(); }
    });
  }

  it('a named zone the store resolves re-runs — in a group key, and in a spatial rows return', async () => {
    const store = await openStore({
      $model: '0.1',
      collections: {
        places: {
          schema: { type: 'object', properties: { id: { type: 'string' },
            when: { type: 'string', format: 'date-time' }, at: { type: ['array', 'object'] } } },
          key: '/id',
          indexes: [{ name: 'by_box', path: '$.at', derive: 'bbox' }],
        },
      },
    }, { driver: nodeDriver(), capture: true, zoneProvider: createIntlZoneProvider() });
    try {
      const places = store.collection('places');
      await places.insert({ id: 'p', when: '2024-03-30T23:30:00Z', at: [4.5, 52.5] });
      await places.insert({ id: 'q', when: '2024-03-31T10:00:00Z', at: [3.5, 52.5] });
      const day = { '$time-bucket': ['$it.when', 'P1D', null, { zone: 'Europe/Amsterdam' }] };
      const region = { type: 'Polygon', coordinates: [[[4, 52], [5, 52], [5, 53], [4, 53], [4, 52]]] };
      /** @type {[any, string][]} */
      const cases = [
        [[{ $for: { it: '$[*]' }, $groupby: { day }, $return: { day: '$day', n: { $count: '$it' } } }],
          "'$groupby' — named-zone: a named zone resolves through the injected provider, which is host code the database does not have"],
        [[{ $for: { it: '$[*]' }, $where: { $within: ['$it.at', '$region'] }, $return: { id: '$it.id', day } }],
          "'$return' — projections other than the bare binding or one member path run per row (the row residual)"],
      ];
      for (const [document, reason] of cases) {
        const live = await places.live(document, { externals: { region } });
        assert.deepEqual(live.mode, { strategy: 'rerun', mode: 'rerun', reason });
        const oracle = liveOracle(live, () => places.execute(document, { externals: { region } }));
        await oracle.check();
        await places.insert({ id: `r${live.result.rows.length}`, when: '2024-03-31T23:30:00Z', at: [4.2, 52.2] });
        await oracle.check();
        oracle.close();
        live.close();
      }
    }
    finally { await store.close(); }
  });
});

describe('the group maintenance boundary', () => {
  it('ordering, a window and a collection-root read keep their named re-runs', async () => {
    const store = await seeded();
    try {
      const users = store.collection('users');
      /** @type {[any, string][]} */
      const cases = [
        [[{ ...byDept({ key: '$g', n: { $count: '$it' } }), $orderby: { $key: '$g' } }],
          'this grouping or distinct projection needs set-level maintenance'],
        [[{ $subsequence: [ITEMS, 0, 1] }], 'a windowed group re-runs'],
        [[byDept({ key: '$g', all: { $count: '$[*]' } })],
          "'$groupby' — nonnative-grouping: the grouping key or the projection is not the closed bucket shape"],
      ];
      for (const [document, reason] of cases) {
        const live = await users.live(document);
        assert.deepEqual(live.mode, { strategy: 'rerun', mode: 'rerun', reason });
        assert.deepEqual(live.result.rows, await users.execute(document));
        live.close();
      }
    }
    finally { await store.close(); }
  });

  it('a string escaped with $$ is a literal, not a root read: a group and a window returning one stay maintained', async () => {
    const store = await seeded();
    try {
      const users = store.collection('users');
      /** @type {[any, string][]} */
      const cases = [
        [[byDept({ key: '$g', currency: '$$USD', total: { $sum: '$it.pay' } })], 'group'],
        [[{ $subsequence: [{ $for: { it: '$[*]' }, $orderby: '$it.pay', $return: { id: '$it.id', unit: '$$.pay' } }, 1, 2] }],
          'window'],
      ];
      for (const [document, strategy] of cases) {
        const live = await users.live(document);
        assert.deepEqual(live.mode, { strategy, mode: 'incremental' });
        const oracle = liveOracle(live, () => users.execute(document));
        await oracle.check();
        await users.insert({ id: `d${strategy}`, dept: 'x', pay: 7, name: 'dee' });
        await oracle.check();
        oracle.close();
      }
      assert.deepEqual((/** @type {any[]} */ (await users.execute(cases[0][0])))[0].currency, '$USD');
    }
    finally { await store.close(); }
  });
});

describe('the group-return trial (seeded)', () => {
  const ROWS_MODEL = {
    $model: '0.1',
    collections: {
      rows: {
        schema: { type: 'object', properties: {
          id: { type: 'string' }, region: {}, team: { type: 'string' }, score: { type: 'integer' } } },
        key: '/id',
      },
    },
  };
  /** The rows grouped by region, returning `ret`, filtered by `filter`.
   * @param {any} ret @param {any} [filter] */
  const byRegion = (ret, filter = undefined) => ({ $for: { r: '$[*]' },
    ...(filter === undefined ? {} : { $where: filter }), $groupby: { g: '$r.region' }, $return: ret });
  /** @type {Record<string, any>} */
  const SHAPES = {
    'rows copied whole': [byRegion({ key: '$g', items: ['$r'] })],
    'the bare groupBy() emission': [{ $for: { r: ['$[*]'] }, $groupby: { g: '$r.region' },
      $return: { key: { $default: ['$g', null] }, items: ['$r'] } }],
    'arithmetic over a sum': [byRegion({ key: '$g', x: { $add: [{ $sum: '$r.score' }, 1] } })],
    'a member path return': [byRegion('$r.score')],
    'an ordered top two of each group': [byRegion({ key: '$g', top: [{ $subsequence: [
      { $for: { x: '$r' }, $orderby: ['$x.score', '$x.id'], $return: '$x.id' }, 0, 2] }] })],
    'a filtered group returning ids': [byRegion({ key: '$g', ids: ['$r.id'] }, { $gt: ['$r.score', 2] })],
    'two keys returning ids': [{ $for: { r: '$[*]' }, $groupby: { g: '$r.region', t: '$r.team' },
      $return: { g: '$g', t: '$t', ids: ['$r.id'] } }],
    'the largest arithmetic over groups': { $max: byRegion({ $add: [{ $sum: '$r.score' }, 1] }) },
    'a sum over counts': { $sum: byRegion({ $add: [{ $count: '$r' }, 1] }) },
    'an average over sums': { $avg: byRegion({ $add: [{ $sum: '$r.score' }, 1] }) },
  };
  const REGIONS = ['west', 'east', null, undefined, 1, '1'];
  const TEAMS = ['x', 'y', 'z'];
  const KEYS = Array.from({ length: 9 }, (_, i) => `r${i}`);

  it('ten group returns equal a fresh run after every committed change', async () => {
    const rand = mulberry32(3);
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
    for (let trial = 0; trial < 12; trial++) {
      const store = await openStore(ROWS_MODEL, { driver: nodeDriver(), capture: true });
      try {
        const rows = store.collection('rows');
        let present = new Set(KEYS.slice(0, 6));
        for (const id of present) await rows.insert(row(id));
        const watches = [];
        for (const [name, document] of Object.entries(SHAPES)) {
          const live = await rows.live(document, { mode: 'incremental' });
          assert.deepEqual(live.mode, MAINTAINED, name);
          watches.push({ name, oracle: liveOracle(live, async () => {
            const result = await rows.execute(document);
            return Array.isArray(document) ? result : result === undefined ? [] : [result];
          }) });
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
    assert.equal(checks, 3600);
  });
});

describe('group keys that are not finite numbers', () => {
  const NONFINITE = {
    $model: '0.1',
    collections: { rows: {
      schema: { type: 'object', properties: {
        id: { type: 'string' }, kind: { type: 'string' }, n: { type: 'number' } } },
      key: '/id',
    } },
  };
  // `+inf`, `-inf` and `nan` are the quotient of `n` by zero; `fin` and
  // `none` key the finite string and the null a stored JSON text can name
  const KEY = { $if: [{ $eq: ['$it.kind', 'fin'] }, 'finite',
    { $if: [{ $eq: ['$it.kind', 'none'] }, { $const: null }, { $div: ['$it.n', 0] }] }] };
  const BY_KEY = [{ $for: { it: '$[*]' }, $groupby: { g: KEY }, $return: { ids: ['$it.id'] } }];
  const ids = (...groups) => groups.map((group) => ({ ids: group }));
  const ROWS = [['a', 'x', 1], ['b', 'fin', 5], ['c', 'x', -1], ['d', 'x', 0], ['e', 'none', 7], ['f', 'x', 2]];

  it('a computed NaN, Infinity, -Infinity and null key each keep their own group, in first-appearance order', async () => {
    const store = await openStore(NONFINITE, { driver: nodeDriver(), capture: true });
    try {
      const rows = store.collection('rows');
      for (const [id, kind, n] of ROWS) await rows.insert({ id, kind, n });
      const live = await rows.live(BY_KEY);
      assert.deepEqual(live.mode, MAINTAINED);
      const oracle = liveOracle(live, () => rows.execute(BY_KEY));
      assert.deepEqual(live.result.rows, ids(['a', 'f'], ['b'], ['c'], ['d'], ['e']));
      await oracle.check();
      // a group's rows leave, a key returns at the end, another group joins
      await rows.delete('a');
      assert.deepEqual(live.result.rows, ids(['b'], ['c'], ['d'], ['e'], ['f']));
      await oracle.check();
      await rows.insert({ id: 'g', kind: 'x', n: -4 });
      assert.deepEqual(live.result.rows, ids(['b'], ['c', 'g'], ['d'], ['e'], ['f']));
      await oracle.check();
      await rows.insert({ id: 'a', kind: 'x', n: 9 });
      assert.deepEqual(live.result.rows, ids(['b'], ['c', 'g'], ['d'], ['e'], ['f', 'a']));
      await oracle.check();
      oracle.close();
      live.close();
    }
    finally { await store.close(); }
  });

  it('a group moved between a non-finite key and a finite one is re-filed, not merged', async () => {
    const store = await openStore(NONFINITE, { driver: nodeDriver(), capture: true });
    try {
      const rows = store.collection('rows');
      for (const [id, kind, n] of ROWS) await rows.insert({ id, kind, n });
      const live = await rows.live(BY_KEY);
      const oracle = liveOracle(live, () => rows.execute(BY_KEY));
      await oracle.check();
      await rows.put({ id: 'c', kind: 'fin', n: -1 });
      assert.deepEqual(live.result.rows, ids(['a', 'f'], ['b', 'c'], ['d'], ['e']));
      await oracle.check();
      await rows.put({ id: 'e', kind: 'x', n: -7 });
      assert.deepEqual(live.result.rows, ids(['a', 'f'], ['b', 'c'], ['d'], ['e']));
      await oracle.check();
      oracle.close();
      live.close();
    }
    finally { await store.close(); }
  });
});
