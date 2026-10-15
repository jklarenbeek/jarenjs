//@ts-check
/**
 * @file One admission rule for the externals a store call binds, on every
 * surface that binds one — a collection's `execute`, `query`, `explain`
 * and `all`, an entity's `execute`, the point reads `get` of both, and the
 * full scan a call diverts to — with the engine's answer (the
 * `pushdown: false` run, and `queryJson` over the same documents) as the
 * oracle. A value the database compares as the engine does is bound; one
 * it cannot bind sends a document's comparison to the engine; a store
 * profile predicate's value that its member cannot hold matches nothing on
 * either side; one the member can hold and the database compares otherwise
 * is refused `JD0011`; and a non-JSON value a comparison reads otherwise
 * than it stands for — a `Date` through a variable, a `bigint` — is
 * refused `JD0041`. `all()` binds externals, and `page()` refuses the
 * options a graph page cannot honour. A store run is SQLite always,
 * PostgreSQL where JAREN_PG_URL names a server.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { queryJson } from '@jarenjs/json/query';
import { ENGINES, skipFor, withStore } from './store-core-engines.js';

const MODEL = {
  $model: '0.1',
  collections: {
    ev: {
      key: '/id',
      schema: { type: 'object', properties: { id: { type: 'string' }, at: { type: 'string', format: 'date-time' },
        tenant: { type: 'string' }, n: { type: 'integer' }, kind: { type: ['string', 'null'] } } },
    },
    big: {
      key: '/id',
      schema: { type: 'object', properties: { id: { type: 'string' }, u: { type: 'integer' },
        v: { type: 'integer', 'x-index': true }, w: { type: ['string', 'integer'], 'x-index': true } } },
    },
  },
  entities: {
    Event: {
      schema: { type: 'object', required: ['id'], properties: { id: { type: 'integer', 'x-entity': { key: true } },
        tenant: { type: ['string', 'null'] }, n: { type: 'integer' } } },
    },
  },
};

const DOCS = [
  { id: 'a1', at: '2026-01-01T00:00:00Z', tenant: 'a', n: 1, kind: 'x' },
  { id: 'b1', at: '2026-06-01T00:00:00Z', tenant: 'b', n: 3, kind: null },
];
const EVENTS = [{ id: 1, tenant: 'a', n: 1 }, { id: 2, tenant: null, n: 3 }];
const BIG = [{ id: 'p', u: 2 ** 60, v: 2 ** 60, w: 2 ** 60 }, { id: 'q', u: -(2 ** 62), v: -(2 ** 62), w: -(2 ** 62) },
  { id: 'r', u: 5, v: 5, w: 'x' }];
const SINCE = new Date('2026-03-01T00:00:00Z');
const ISO = SINCE.toISOString();

/** A collection document over `$[*]` with this `$where`. @param {any} where */
const evs = (where) => ({ $for: { e: '$[*]' }, $where: where, $return: '$e.id' });
/** The same over the entity root. @param {any} where */
const rowsOf = (where) => ({ $for: { e: '$.Event[*]' }, $where: where, $return: '$e.id' });
/** Every id a profile predicate keeps, as a `$where` over `$it`. @param {any} predicate */
const kept = (predicate) => ({ $for: { it: '$[*]' }, $where: predicate, $orderby: ['$it.id'], $return: '$it.id' });
const keptRows = (/** @type {any} */ predicate) => ({ $for: { it: '$.Event[*]' }, $where: predicate, $orderby: ['$it.id'], $return: '$it.id' });
const ALL = { $for: { e: '$[*]' }, $orderby: ['$e.id'], $return: '$e.id' };
const ALL_ROWS = { $for: { e: '$.Event[*]' }, $orderby: ['$e.id'], $return: '$e.id' };

/** A store seeded with the documents, under `options` (a profile). @param {string} engine
 * @param {(store: any) => Promise<void>} body @param {any} [options] */
async function seeded(engine, body, options = {}) {
  await withStore(engine, MODEL, async (store) => {
    for (const doc of DOCS) await store.collection('ev').insert(doc);
    for (const doc of BIG) await store.collection('big').insert(doc);
    for (const row of EVENTS) await store.entity('Event').create(row);
    await store.saveChanges();
    await body(store);
  }, options);
}

/** What a call answers, or the code it is refused with. @param {() => any} call */
async function outcome(call) {
  try { return await call(); }
  catch (error) { return /** @type {any} */ (error).code ?? String(error); }
}

/** The ids a cursor yields. @param {any} cursor */
async function drain(cursor) {
  const out = [];
  for await (const item of cursor) out.push(item);
  return out;
}

/** The engine's answer, with no store between: what every surface must equal.
 * @param {string} engine @param {any} predicate @param {any} externals @param {'ev' | 'Event'} root */
async function oracleOf(engine, predicate, externals, root) {
  let answer;
  await seeded(engine, async (store) => {
    answer = root === 'ev'
      ? await outcome(() => store.collection('ev').execute(kept(predicate), { externals, pushdown: false }))
      : await outcome(() => store.entity('Event').execute(keptRows(predicate), { externals, pushdown: false }));
  });
  if (root === 'ev') assert.deepStrictEqual(answer, queryJson(kept(predicate), DOCS, externals));
  return answer;
}

for (const engine of ENGINES) {
  describe(`one admission rule for a call's externals, ${engine}`, { skip: skipFor(engine) }, () => {
    it('a diverted collection call binds the store predicate\'s externals in its full scan', async () => {
      const profile = { externals: ['tenant', 'x'], predicates: { ev: { $eq: ['$it.tenant', '$tenant'] } } };
      const document = evs({ $not: { $eq: ['$e.id', '$x'] } });
      // the engine: tenant 'a' keeps a1, and no id equals true
      assert.strictEqual(queryJson(document, DOCS.filter((doc) => doc.tenant === 'a'), { x: true }), 'a1');
      await seeded(engine, async (store) => {
        const ev = store.collection('ev');
        for (const pushdown of [true, false]) {
          // it answered no row: the full scan bound the tenant as NULL
          assert.strictEqual(await ev.execute(document, { externals: { tenant: 'a', x: true }, pushdown }), 'a1');
          assert.deepStrictEqual(await drain(ev.query(document, { externals: { tenant: 'a', x: true }, pushdown })), ['a1']);
        }
        assert.strictEqual(await ev.execute(document, { externals: { tenant: 'b', x: 'b1' } }), undefined);
        assert.strictEqual(await ev.execute(document, { externals: { tenant: 'b', x: false } }), 'b1');
      }, { profile });
    });

    it('a profile predicate\'s value its member cannot hold matches nothing, as in the engine', async () => {
      for (const [predicate, externals] of /** @type {[any, any][]} */ ([
        [{ $eq: ['$it.tenant', '$tenant'] }, { tenant: true }],
        [{ $eq: ['$it.tenant', '$tenant'] }, { tenant: false }],
        [{ $eq: ['$it.tenant', '$tenant'] }, { tenant: { x: 1 } }],
        [{ $eq: ['$it.tenant', '$tenant'] }, { tenant: ['t1'] }],
        [{ $ne: ['$it.tenant', '$tenant'] }, { tenant: true }],
        [{ $lt: ['$it.tenant', '$tenant'] }, { tenant: true }],
        [{ $eq: ['$it.n', '$tenant'] }, { tenant: { n: 1 } }],
        [{ $ne: ['$it.kind', '$tenant'] }, { tenant: false }],
        [{ $eq: ['$it.tenant', '$tenant'] }, { tenant: 'a' }],
      ])) {
        const label = `${JSON.stringify(predicate)} ${JSON.stringify(externals)}`;
        const oracle = await oracleOf(engine, predicate, externals, 'ev');
        await seeded(engine, async (store) => {
          const ev = store.collection('ev');
          // SQLite threw the driver's ERR_INVALID_ARG_TYPE or ERR_INVALID_STATE
          assert.deepStrictEqual(await outcome(() => ev.execute(ALL, { externals })), oracle, label);
          assert.deepStrictEqual(await outcome(() => ev.execute(ALL, { externals, pushdown: false })), oracle, label);
          assert.deepStrictEqual(await outcome(() => drain(ev.query(ALL, { externals }))), oracle === undefined ? [] : [oracle].flat(), label);
          assert.strictEqual(await outcome(async () => (await ev.explain(ALL, { externals })).mode), 'native', label);
          // a point read keeps the rows the query keeps
          for (const doc of DOCS) {
            const read = await outcome(() => ev.get(doc.id, { externals }));
            assert.deepStrictEqual(read === undefined ? undefined : read.id, [oracle ?? []].flat().includes(doc.id) ? doc.id : undefined, `${label} get ${doc.id}`);
          }
        }, { profile: { externals: ['tenant'], predicates: { ev: predicate } } });
      }
    });

    it('an entity predicate\'s value its column cannot hold matches nothing, as in the engine', async () => {
      for (const [predicate, externals] of /** @type {[any, any][]} */ ([
        [{ $eq: ['$it.tenant', '$tenant'] }, { tenant: true }],
        [{ $ne: ['$it.tenant', '$tenant'] }, { tenant: true }],
        [{ $eq: ['$it.tenant', '$tenants[*]'] }, { tenants: ['a', true] }],
        [{ $eq: ['$it.tenant', '$tenants[*]'] }, { tenants: [null] }],
        [{ $eq: ['$it.tenant', '$tenants[*]'] }, { tenants: null }],
        [{ $eq: ['$it.tenant', '$tenants[*]'] }, { tenants: ['a'] }],
      ])) {
        const label = `${JSON.stringify(predicate)} ${JSON.stringify(externals)}`;
        const oracle = await oracleOf(engine, predicate, externals, 'Event');
        await seeded(engine, async (store) => {
          const rows = store.entity('Event');
          // the list was refused JD0011 though the column cannot hold its null or boolean
          assert.deepStrictEqual(await outcome(() => rows.execute(ALL_ROWS, { externals })), oracle, label);
          assert.deepStrictEqual(await outcome(() => rows.execute(ALL_ROWS, { externals, pushdown: false })), oracle, label);
          // admitted, it binds as it is: the statement stays native rather than fetching the root whole
          assert.strictEqual(await outcome(async () => (await rows.explain(ALL_ROWS, { externals })).mode), 'native', label);
          for (const row of EVENTS) {
            const read = await outcome(() => rows.get(row.id, { externals }));
            assert.deepStrictEqual(read === undefined ? undefined : read.id, [oracle ?? []].flat().includes(row.id) ? row.id : undefined, `${label} get ${row.id}`);
          }
        }, { profile: { externals: ['tenant', 'tenants'], predicates: { Event: predicate } } });
      }
    });

    it('a collection point read admits the list a collection call answers', async () => {
      const predicate = { $eq: ['$it.tenant', '$tenants[*]'] };
      for (const externals of [{ tenants: ['a', true] }, { tenants: [null] }, { tenants: null }, { tenants: ['b', { x: 1 }] }]) {
        const oracle = await oracleOf(engine, predicate, externals, 'ev');
        await seeded(engine, async (store) => {
          const ev = store.collection('ev');
          assert.deepStrictEqual(await ev.execute(ALL, { externals }), oracle);
          // get refused JD0011 a null and a list holding a null or a boolean
          for (const doc of DOCS) {
            const read = await ev.get(doc.id, { externals });
            assert.deepStrictEqual(read?.id, [oracle ?? []].flat().includes(doc.id) ? doc.id : undefined, `${JSON.stringify(externals)} ${doc.id}`);
          }
        }, { profile: { externals: ['tenants'], predicates: { ev: predicate } } });
      }
    });

    it('a value the member can hold and the database compares otherwise is refused JD0011 on every surface', async () => {
      const predicate = { $eq: ['$it.kind', '$kind'] };
      await seeded(engine, async (store) => {
        const ev = store.collection('ev');
        const externals = { kind: null };
        for (const call of [() => ev.execute(ALL, { externals }), () => drain(ev.query(ALL, { externals })),
          () => ev.explain(ALL, { externals }), () => ev.all({ externals }), () => ev.get('b1', { externals }),
          () => ev.get('b1'), () => ev.all()]) {
          assert.strictEqual(await outcome(call), 'JD0011');
        }
        await assert.rejects(async () => ev.get('b1', { externals }), { code: 'JD0011',
          message: "JD0011: the profile's predicate for 'ev' cannot bind '$kind' for this point read — it holds a null, which "
            + "the engine compares with the same value in 'kind' and the database does not, so the predicate would keep "
            + 'other rows than it does; bind strings and numbers at /collections/ev' });
        await assert.rejects(async () => ev.get('b1'), { code: 'JD0011',
          message: "JD0011: the profile's predicate for 'ev' cannot bind '$kind' for this point read — it is missing, and a "
            + 'mandatory predicate runs in the database or not at all — pass it as get(key, { externals }) at /collections/ev' });
      }, { profile: { externals: ['kind'], predicates: { ev: predicate } } });
    });

    it('all() binds the externals the store predicate names', async () => {
      const profile = { externals: ['tenant'], predicates: { ev: { $eq: ['$it.tenant', '$tenant'] } } };
      await seeded(engine, async (store) => {
        const ev = store.collection('ev');
        // it was JD0013: the option set had no externals
        assert.deepStrictEqual(await ev.all({ externals: { tenant: 'a' } }), [DOCS[0]].map((doc) => ({ ...doc })));
        assert.deepStrictEqual(await ev.all({ externals: { tenant: true } }), []);
        assert.deepStrictEqual(await ev.all({ externals: { tenant: 'nobody' } }), []);
        await assert.rejects(async () => ev.all(), { code: 'JD0011',
          message: "JD0011: the profile's predicate for 'ev' cannot bind '$tenant' for this call — it is missing, and a "
            + 'mandatory predicate runs in the database or not at all — pass it as all({ externals }) at /collections/ev' });
        await assert.rejects(async () => ev.all({ externals: { tenant: new Date(0) } }), { code: 'JD0041' });
        await assert.rejects(async () => ev.all({ externals: 'a' }), { code: 'JD0013' });
        if (engine === 'sqlite') assert.deepStrictEqual(store.sync.collection('ev').all({ externals: { tenant: 'b' } }).map((/** @type {any} */ doc) => doc.id), ['b1']);
      }, { profile });
      // no profile: externals bind nothing a fixed document reads, and answer as before
      await seeded(engine, async (store) => {
        assert.deepStrictEqual((await store.collection('ev').all({ externals: { tenant: 'a' } })).map((/** @type {any} */ doc) => doc.id), ['a1', 'b1']);
      });
    });

    it('page() refuses the options a graph page cannot honour, and reads the rest', async () => {
      await seeded(engine, async (store) => {
        const events = store.entity('Event');
        for (const option of ['externals', 'strict', 'pushdown', 'strictStreaming']) {
          // each was taken and changed nothing
          await assert.rejects(async () => events.page({ orderBy: '$it.id' }, { [option]: option === 'externals' ? { x: 1 } : true }), {
            code: 'JD0013',
            message: `JD0013: page() option '${option}' is not one it reads; the options are limit, after, maxBytes, consistency, `
              + 'signal, deadline, lookahead, profile' });
        }
        const page = await events.page({ orderBy: '$it.id' }, { limit: 1, lookahead: true, tracking: false });
        assert.deepStrictEqual(page.items.map((/** @type {any} */ row) => row.id), [1]);
        assert.strictEqual(page.hasMore, true);
      });
    });

    it('a bigint a comparison reads is refused JD0041, as the engine reads it as no number', async () => {
      // the engine: 2n is no number, so $gt keeps nothing and $ne keeps every row
      assert.strictEqual(queryJson(evs({ $gt: ['$e.n', '$min'] }), DOCS, { min: 2n }), undefined);
      assert.deepStrictEqual(queryJson(evs({ $ne: ['$e.n', '$min'] }), DOCS, { min: 1n }), ['a1', 'b1']);
      await seeded(engine, async (store) => {
        for (const pushdown of [true, false]) {
          await assert.rejects(async () => store.collection('ev').execute(evs({ $gt: ['$e.n', '$min'] }), { externals: { min: 2n }, pushdown }), {
            code: 'JD0041',
            message: "JD0041: collection('ev').execute external '$min' holds a bigint, which a comparison reads as no number — "
              + 'pass the number it stands for, Number(value) at /$where/$gt/1' });
          await assert.rejects(async () => store.entity('Event').execute(rowsOf({ $gt: ['$e.n', '$min'] }), { externals: { min: 2n }, pushdown }),
            { code: 'JD0041' });
          await assert.rejects(async () => store.collection('ev').execute(evs({ $eq: ['$e.n', '$ns[*]'] }), { externals: { ns: [1, 3n] }, pushdown }),
            { code: 'JD0041' });
          // the number answers; a bigint returned or never compared is the caller's own
          assert.strictEqual(await store.collection('ev').execute(evs({ $gt: ['$e.n', '$min'] }), { externals: { min: 2 }, pushdown }), 'b1');
          assert.strictEqual((await store.collection('ev').execute({ $for: { e: '$[*]' }, $where: { $eq: ['$e.id', 'a1'] }, $return: { n: '$min' } },
            { externals: { min: 2n }, pushdown })).n, 2n);
          assert.strictEqual(await store.collection('ev').execute(evs({ $gt: ['$e.n', '$min'] }), { externals: { min: 2, other: 2n }, pushdown }), 'b1');
        }
      });
      await seeded(engine, async (store) => {
        await assert.rejects(async () => store.collection('ev').execute(ALL, { externals: { min: 2n } }), { code: 'JD0041' });
        await assert.rejects(async () => store.collection('ev').get('a1', { externals: { min: 2n } }), { code: 'JD0041' });
        assert.strictEqual((await store.collection('ev').get('b1', { externals: { min: 2 } })).id, 'b1');
      }, { profile: { externals: ['min'], predicates: { ev: { $gt: ['$it.n', '$min'] } } } });
    });

    it('a Date compared through a variable, a descendant or a slice is refused JD0041', async () => {
      const externals = { since: SINCE, o: { d: SINCE }, xs: [SINCE] };
      const iso = { since: ISO, o: { d: ISO }, xs: [ISO] };
      for (const [document, docPath] of /** @type {[any, string][]} */ ([
        [{ $for: { e: '$[*]' }, $let: { s: '$since' }, $where: { $gt: ['$e.at', '$s'] }, $return: '$e.id' }, '/$where/$gt/1'],
        [{ $for: { e: '$[*]' }, $let: { s: '$o' }, $where: { $gt: ['$e.at', '$s.d'] }, $return: '$e.id' }, '/$where/$gt/1'],
        [{ $for: { e: '$[*]', s: '$xs[*]' }, $where: { $gt: ['$e.at', '$s'] }, $return: '$e.id' }, '/$where/$gt/1'],
        [{ $for: { e: '$[*]' }, $where: { $some: { s: '$xs[*]' }, $satisfies: { $gt: ['$e.at', '$s'] } }, $return: '$e.id' }, '/$where/$satisfies/$gt/1'],
        [evs({ $gt: ['$e.at', '$o..d'] }), '/$where/$gt/1'],
        [evs({ $gt: ['$e.at', '$xs[0:1]'] }), '/$where/$gt/1'],
      ])) {
        // the engine compares {} and keeps no row; the ISO string keeps b1
        assert.strictEqual(queryJson(document, DOCS, externals), undefined);
        assert.strictEqual(queryJson(document, DOCS, iso), 'b1');
        await seeded(engine, async (store) => {
          for (const pushdown of [true, false]) {
            assert.strictEqual(await store.collection('ev').execute(document, { externals: iso, pushdown }), 'b1');
            await assert.rejects(async () => store.collection('ev').execute(document, { externals, pushdown }),
              (/** @type {any} */ error) => error.code === 'JD0041' && error.docPath === docPath
                && / holds a Date instance, which a comparison reads as \{\}/.test(error.message), JSON.stringify(document));
          }
        });
      }
    });

    it('a Date a distinct, an index-of or a grouping key reads is refused JD0041', async () => {
      const dates = [new Date(0), new Date(1)];
      // the engine reads both as {}: one distinct item, two positions, one group
      assert.strictEqual(queryJson({ $count: { $distinct: '$xs[*]' } }, DOCS, { xs: dates }), 1);
      assert.deepStrictEqual(queryJson({ '$index-of': ['$xs[*]', '$y'] }, DOCS, { xs: dates, y: dates[1] }), [0, 1]);
      await seeded(engine, async (store) => {
        const ev = store.collection('ev');
        for (const [document, externals] of /** @type {[any, any][]} */ ([
          [{ $for: { e: '$[*]' }, $return: { $count: { $distinct: '$xs[*]' } } }, { xs: dates }],
          [{ $for: { e: '$[*]' }, $let: { s: '$xs' }, $return: { $count: { $distinct: '$s[*]' } } }, { xs: dates }],
          [{ $for: { e: '$[*]' }, $return: { '$index-of': ['$xs[*]', '$y'] } }, { xs: ['a', 'b'], y: dates[1] }],
          [{ $for: { e: '$[*]' }, $groupby: { g: '$d' }, $return: { $count: '$e' } }, { d: dates[0] }],
        ])) {
          assert.strictEqual(await outcome(() => ev.execute(document, { externals })), 'JD0041', JSON.stringify(document));
        }
        // their strings answer
        assert.deepStrictEqual(await ev.execute({ $for: { e: '$[*]' }, $where: { $eq: ['$e.id', 'a1'] }, $return: { $count: { $distinct: '$xs[*]' } } },
          { externals: { xs: dates.map((date) => date.toISOString()) } }), 2);
      });
    });

    it('every use of a variable-bound Date that answered right answers as before', async () => {
      await seeded(engine, async (store) => {
        const ev = store.collection('ev');
        for (const pushdown of [true, false]) {
          const run = (/** @type {any} */ document) => ev.execute(document, { externals: { since: SINCE }, pushdown });
          // returned through a variable: the caller's own value
          assert.strictEqual((await run({ $for: { e: '$[*]' }, $let: { s: '$since' }, $where: { $eq: ['$e.id', 'a1'] }, $return: { s: '$s' } })).s, SINCE);
          // counted or tested for existence: no member is read
          assert.deepStrictEqual(await run({ $for: { e: '$[*]' }, $let: { s: '$since' }, $where: { $eq: [{ $count: '$s' }, 1] }, $return: '$e.id' }), ['a1', 'b1']);
          assert.deepStrictEqual(await run({ $for: { e: '$[*]' }, $let: { s: '$since' }, $where: { $exists: '$s' }, $return: '$e.id' }), ['a1', 'b1']);
          // compared with itself through the variable
          assert.deepStrictEqual(await run({ $for: { e: '$[*]' }, $let: { s: '$since' }, $where: { $eq: ['$s', '$s'] }, $return: '$e.id' }), ['a1', 'b1']);
          // and beside it, which was refused (the external stood alone in the comparison) and now
          // reads as the one reference it is: every row, the engine's answer
          assert.deepStrictEqual(queryJson({ $for: { e: '$[*]' }, $let: { s: '$since' }, $where: { $eq: ['$s', '$since'] }, $return: '$e.id' }, DOCS, { since: SINCE }), ['a1', 'b1']);
          assert.deepStrictEqual(await run({ $for: { e: '$[*]' }, $let: { s: '$since' }, $where: { $eq: ['$s', '$since'] }, $return: '$e.id' }), ['a1', 'b1']);
          // a variable bound to a document member compares as before
          assert.strictEqual(await run({ $for: { e: '$[*]' }, $let: { t: '$e.tenant' }, $where: { $eq: ['$t', 'b'] }, $return: '$e.id' }), 'b1');
        }
      });
    });

    it('an external past 2^53 compares as the engine\'s double', async () => {
      await seeded(engine, async (store) => {
        const big = store.collection('big');
        for (const member of ['u', 'v', 'w']) for (const x of [2 ** 60, -(2 ** 62), 2 ** 53 + 2, 5]) for (const op of ['$eq', '$lt', '$ge']) {
          const document = { $for: { e: '$[*]' }, $where: { [op]: [`$e.${member}`, '$x'] }, $orderby: ['$e.id'], $return: '$e.id' };
          const oracle = queryJson(document, BIG, { x });
          // SQLite compared the stored digits exactly and missed the row the engine finds
          assert.deepStrictEqual(await big.execute(document, { externals: { x } }), oracle, `${member} ${op} ${x}`);
          assert.deepStrictEqual(await big.execute(document, { externals: { x }, pushdown: false }), oracle, `${member} ${op} ${x}`);
          const list = { $for: { e: '$[*]' }, $where: { $eq: [`$e.${member}`, '$xs[*]'] }, $orderby: ['$e.id'], $return: '$e.id' };
          assert.deepStrictEqual(await big.execute(list, { externals: { xs: [x, 7] } }), queryJson(list, BIG, { xs: [x, 7] }), `${member} in ${x}`);
        }
        // a safe external still seeks the index
        const explained = await big.explain({ $for: { e: '$[*]' }, $where: { $eq: ['$e.v', '$x'] }, $return: '$e.id' }, { externals: { x: 5 } });
        assert.strictEqual(explained.mode, 'native');
      });
    });

    it('a store predicate\'s external past 2^53 answers as the engine where its statement can', async () => {
      for (const [root, predicate, x] of /** @type {[string, any, number][]} */ ([
        ['big', { $eq: ['$it.u', '$x'] }, 2 ** 60],
        ['big', { $lt: ['$it.u', '$x'] }, 2 ** 60],
        ['ev', { $lt: ['$it.n', '$x'] }, 2 ** 60],
        ['ev', { $eq: ['$it.n', '$x'] }, -(2 ** 62)],
        ['ev', { $eq: ['$it.tenant', '$x'] }, 2 ** 60],
        ['ev', { $ne: ['$it.tenant', '$x'] }, 2 ** 60],
      ])) {
        const docs = root === 'big' ? BIG : DOCS;
        const oracle = queryJson(kept(predicate), docs, { x });
        const label = `${root} ${JSON.stringify(predicate)} ${x}`;
        await seeded(engine, async (store) => {
          // a member far from the value, or one that holds no number, answers on SQLite as well; a
          // stored integer past 2^53 near it is read by its digits there (the open remainder)
          if (engine === 'postgres' || root === 'ev')
            assert.deepStrictEqual(await store.collection(root).execute(kept(predicate), { externals: { x } }), oracle, label);
          // a point read is judged by the engine, which answers right on both
          for (const doc of docs) {
            assert.deepStrictEqual((await store.collection(root).get(doc.id, { externals: { x } }))?.id,
              [oracle ?? []].flat().includes(doc.id) ? doc.id : undefined, `${label} get ${doc.id}`);
          }
        }, { profile: { externals: ['x'], predicates: { [root]: predicate } } });
      }
    });

    it('a store predicate\'s function or symbol is refused JD0011 on every surface, as no database binds it', async () => {
      await seeded(engine, async (store) => {
        for (const value of [() => 'a', Symbol('a'), ['a', () => 'b']]) {
          for (const call of [() => store.collection('ev').execute(ALL, { externals: { tenant: value } }),
            () => store.collection('ev').get('a1', { externals: { tenant: value } }),
            () => store.entity('Event').execute(ALL_ROWS, { externals: { tenant: value } }),
            () => store.entity('Event').get(1, { externals: { tenant: value } })]) {
            await assert.rejects(async () => call(), (/** @type {any} */ error) => error.code === 'JD0011'
              && /cannot bind '\$tenant' for this (call|point read) — it holds a (function|symbol), which is no JSON value/.test(error.message));
          }
        }
      }, { profile: { externals: ['tenant'], predicates: { ev: { $eq: ['$it.tenant', '$tenant'] }, Event: { $eq: ['$it.tenant', '$tenant'] } } } });
    });
  });
}
