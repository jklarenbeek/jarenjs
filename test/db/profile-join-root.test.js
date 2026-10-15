//@ts-check
/**
 * @file A store profile bounds a join table's rows through the entities it
 * relates (MODEL-FORMAT §8, §10.7): a join row names one row of each side,
 * so under a profile that holds a predicate for either side it is readable
 * only where the row it names is. Every surface that reads the root —
 * `execute` on the store and on any entity set, a count, a correlated count
 * or existence test from another root, a join, `explain`, `cursor`, a
 * per-call profile, a live query (which re-runs on a write to the bounding
 * side) — answers the memberships of the admitted
 * rows alone, natively, and the engine (`pushdown: false`) answers the same.
 * SQLite always, PostgreSQL where JAREN_PG_URL names a server.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { ENGINES, skipFor, withStore } from './store-core-engines.js';

const key = { type: 'string', 'x-entity': { key: true } };
const MODEL = { $model: '0.1', entities: {
  User: { schema: { type: 'object', required: ['id'], properties: { id: key, tenant: { type: 'string' },
    labels: { 'x-entity': { relation: { to: 'Label', many: true } } } } } },
  Label: { schema: { type: 'object', required: ['name'], properties: { name: key, owner: { type: 'string' },
    users: { 'x-entity': { relation: { to: 'User', many: true } } } } } } } };
const TENANT = { externals: ['tenant'], predicates: { User: { $eq: ['$it.tenant', '$tenant'] } } };
const T1 = { externals: { tenant: 't1' } };
const T2 = { externals: { tenant: 't2' } };
const JOIN = { $for: { j: '$.Label_User[*]' }, $return: '$j' };
const PAIRS = { $for: { j: '$.Label_User[*]' }, $return: { u: '$j.User_key', l: '$j.Label_key' } };
const PER_LABEL = { $for: { l: '$.Label[*]' }, $return: { label: '$l.name',
  users: { $count: { $for: { j: '$.Label_User[*]' }, $where: { $eq: ['$j.Label_key', '$l.name'] }, $return: '$j' } } } };
const HELD = { $for: { l: '$.Label[*]' }, $where: { $exists: { $for: { j: '$.Label_User[*]' },
  $where: { $eq: ['$j.Label_key', '$l.name'] }, $return: '$j' } }, $return: '$l.name' };
const JOINED = { $for: { j: '$.Label_User[*]', l: '$.Label[*]' }, $where: { $eq: ['$j.Label_key', '$l.name'] },
  $return: { u: '$j.User_key', l: '$l.name' } };

/** u1 (t1) holds admin; u2 (t2) holds secret and admin. @param {any} store */
async function seed(store) {
  for (const [id, tenant] of [['u1', 't1'], ['u2', 't2']]) await store.entity('User').create({ id, tenant });
  for (const [name, owner] of [['admin', 't1'], ['secret', 't2']]) await store.entity('Label').create({ name, owner });
  store.entity('User').link('u1', 'labels', 'admin');
  store.entity('User').link('u2', 'labels', 'secret');
  store.entity('User').link('u2', 'labels', 'admin');
  await store.saveChanges();
}

/** An engine answer as rows. @param {any} answer @returns {any[]} */
const rowsOf = (answer) => (answer === undefined ? [] : Array.isArray(answer) ? answer : [answer]);
/** A pair answer (`{ u, l }` items) as `user:label` strings.
 * @param {any} answer @returns {any[]} */
const pairsOf = (answer) => rowsOf(answer).map((row) => (typeof row === 'object' && 'u' in row ? `${row.u}:${row.l}` : row));

/** The document answers `expected` natively and in the engine, sorted.
 * @param {any} store @param {any} document @param {any} options @param {any[]} expected */
async function answers(store, document, options, expected) {
  const sorted = (/** @type {any} */ answer) => pairsOf(answer).map((row) => JSON.stringify(row)).sort();
  assert.deepStrictEqual(sorted(await store.execute(document, options)), expected.map((row) => JSON.stringify(row)).sort());
  assert.deepStrictEqual(sorted(await store.execute(document, { ...options, pushdown: false })),
    expected.map((row) => JSON.stringify(row)).sort());
  assert.strictEqual((await store.entity('User').explain(document, options)).mode, 'native');
}

for (const engine of ENGINES) {
  describe(`a profile bounds a join table's rows through the entities it relates, ${engine}`, { skip: skipFor(engine) }, () => {
    it('the root answers the memberships of the admitted rows alone, on every reading', () => withStore(engine, MODEL, async (store) => {
      await seed(store);
      await answers(store, PAIRS, T1, ['u1:admin']);
      await answers(store, PAIRS, T2, ['u2:secret', 'u2:admin']);
      await answers(store, JOIN, T1, [{ Label_key: 'admin', User_key: 'u1' }]);
      // the other tenant's membership, named by its key, is not there
      await answers(store, { ...PAIRS, $for: { j: '$.Label_User[*]' }, $where: { $eq: ['$j.User_key', 'u2'] } }, T1, []);
      await answers(store, { $count: JOIN }, T1, [1]);
      await answers(store, { $count: JOIN }, T2, [2]);
      await answers(store, PER_LABEL, T1, [{ label: 'admin', users: 1 }, { label: 'secret', users: 0 }]);
      await answers(store, HELD, T1, ['admin']);
      await answers(store, JOINED, T1, ['u1:admin']);
      // any entity set reads the store's roots, under the same bound
      assert.deepStrictEqual(pairsOf(await store.entity('Label').execute(PAIRS, T1)), ['u1:admin']);
      const items = [];
      for await (const row of store.entity('User').cursor(PAIRS, T1)) items.push(row);
      assert.deepStrictEqual(pairsOf(items), ['u1:admin']);
      // the bound is an existence test over the side's own rows, in the one statement
      const explained = await store.entity('User').explain(JOIN, T1);
      assert.match(explained.sql, /FROM "Label_User" AS "t0" WHERE EXISTS \(SELECT 1 FROM "(?:[^"]+"\.")?User" AS "h0" WHERE "h0"\."id" = "t0"\."User_key"/);
    }, { profile: TENANT }));

    it('a read that cannot bind the side\'s externals is refused as the side\'s own read is', () => withStore(engine, MODEL, async (store) => {
      await seed(store);
      for (const document of [JOIN, PER_LABEL, { $count: JOIN }]) {
        await assert.rejects(async () => store.execute(document), (/** @type {any} */ error) => error.code === 'JD0011'
          && /the profile's predicate for 'User' cannot bind '\$tenant'/.test(error.message));
      }
    }, { profile: TENANT }));

    it('a per-call profile bounds the root as the store\'s does, and narrows a store bound', () => withStore(engine, MODEL, async (store) => {
      await seed(store);
      await answers(store, PAIRS, { ...T1, profile: TENANT }, ['u1:admin']);
      await answers(store, PER_LABEL, { ...T2, profile: TENANT }, [{ label: 'admin', users: 1 }, { label: 'secret', users: 1 }]);
      // a bound on the other side, and one the profile keys by the join table itself, conjoin
      const labels = { predicates: { Label: { $eq: ['$it.owner', 't2'] } } };
      await answers(store, PAIRS, { profile: labels }, ['u2:secret']);
      await answers(store, PAIRS, { ...T2, profile: { ...TENANT, predicates: { ...TENANT.predicates, ...labels.predicates } } },
        ['u2:secret']);
      await answers(store, PAIRS, { ...T2, profile: { ...TENANT,
        predicates: { ...TENANT.predicates, Label_User: { $eq: ['$it.Label_key', 'admin'] } } } }, ['u2:admin']);
    }));

    it('the include tree reads memberships of admitted rows alone', () => withStore(engine, MODEL, async (store) => {
      await seed(store);
      const profile = { predicates: { User: { $eq: ['$it.tenant', 't1'] } } };
      const labels = await store.entity('Label').load({ orderBy: '$it.name', include: { users: { count: true } } }, { profile });
      assert.deepStrictEqual(labels.map((/** @type {any} */ l) => [l.name, l.users]), [['admin', 1], ['secret', 0]]);
      const users = await store.entity('User').load({ orderBy: '$it.id', include: { labels: true } }, { profile });
      assert.deepStrictEqual(users.map((/** @type {any} */ u) => [u.id, u.labels.map((/** @type {any} */ l) => l.name)]),
        [['u1', ['admin']]]);
    }));
  });
}

describe('a profile bounds a join table\'s rows: the refusals keep their precedence', () => {
  // a side predicate the planner cannot translate is the host error it is on
  // a read of the side itself; a root the allow-list refuses is refused by name
  const UNTRANSLATABLE = { externals: ['tenant'], predicates: { ...TENANT.predicates, Label: { $eq: [1, 1] } } };
  it('an untranslatable side predicate is a TypeError at first use, as a read of the side is', () => withStore('sqlite', MODEL, async (store) => {
    await seed(store);
    const refused = (/** @type {any} */ error) => error instanceof TypeError
      && /a profile predicate must translate natively \(it binds the database-side fetch of 'Label'\)/.test(error.message);
    await assert.rejects(async () => store.execute(JOIN, T1), refused);
    await assert.rejects(async () => store.execute({ $for: { l: '$.Label[*]' }, $return: '$l.name' }, T1), refused);
    // the User root alone still answers
    assert.strictEqual(await store.execute({ $for: { u: '$.User[*]' }, $return: '$u.id' }, T1), 'u1');
  }, { profile: UNTRANSLATABLE }));
  it('an allow-list that leaves the join table out refuses it by name', () => withStore('sqlite', MODEL, async (store) => {
    await assert.rejects(async () => store.execute(JOIN, T1), (/** @type {any} */ error) => error.code === 'JD0011'
      && /the profile does not allow querying entity 'Label_User'/.test(error.message));
  }, { profile: { ...UNTRANSLATABLE, collections: ['User', 'Label'] } }));
});

describe('a live query over a bounded join root re-runs on a write to the side that bounds it', () => {
  it('a membership leaves and enters the answer as its user changes tenant', () => withStore('sqlite', MODEL, async (store) => {
    await seed(store);
    const live = await store.live(PAIRS, T1);
    try {
      assert.deepStrictEqual(pairsOf(live.result.rows), ['u1:admin']);
      await store.entity('User').update('u1', { tenant: 't2' });
      assert.deepStrictEqual(pairsOf(live.result.rows), []);
      assert.deepStrictEqual(pairsOf(await store.execute(PAIRS, T1)), []);
      await store.entity('User').update('u2', { tenant: 't1' });
      assert.deepStrictEqual(pairsOf(live.result.rows).sort(), ['u2:admin', 'u2:secret']);
      assert.deepStrictEqual(pairsOf(live.result.rows), pairsOf(await store.execute(PAIRS, T1)));
    }
    finally { await live.close(); }
  }, { profile: TENANT, capture: true }));

  it('the same on PostgreSQL, through the polling host', { skip: skipFor('postgres') }, async () => {
    const { asyncLive } = await import('@jarenjs/db/async-live');
    await withStore('postgres', MODEL, async (store) => {
      await seed(store);
      const live = await store.live(PAIRS, T1);
      try {
        assert.deepStrictEqual(pairsOf(live.result.rows), ['u1:admin']);
        await store.entity('User').update('u1', { tenant: 't2' });
        await live.refresh();
        assert.deepStrictEqual(pairsOf(live.result.rows), []);
        await store.entity('User').update('u2', { tenant: 't1' });
        await live.refresh();
        assert.deepStrictEqual(pairsOf(live.result.rows).sort(), ['u2:admin', 'u2:secret']);
      }
      finally { await live.close(); }
    }, { profile: TENANT, capture: { mode: 'journal', log: { retention: 2 } }, live: asyncLive({ pollMs: 60000 }) });
  });
});
