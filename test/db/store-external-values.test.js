//@ts-check
/**
 * @file A store member that takes externals refuses one a comparison reads
 * as `{}` (`JD0041`): a value whose prototype is neither `Object.prototype`
 * nor `null` and which has no own enumerable member (a `Date`, a `Map`), at
 * the external's root or inside it, named by a direct operand of `$eq $ne
 * $lt $le $gt $ge` — `$since`, `$xs[*]`, `$o.d` — or by the store profile's
 * predicate, or handed to one by the operand an expression picks where the
 * call's externals alone decide which (`$if` on an external flag, the first
 * `$coalesce` operand that is not empty, a computed `$get` key, a nested
 * phrase's return), before any statement runs. `$gt ['$e.at', '$since']`
 * with `since` a `Date` matched no row, with and without pushdown, where its
 * ISO string answers. Every other use answers as before: a `Date` returned
 * or handed to a host function is the caller's own value, one the document
 * never compares or the externals pick past is not read, one only a row
 * could pick is left to the row, and plain and null-prototype objects,
 * class instances read by their fields, arrays and primitives compare as
 * JSON. A store run is SQLite always, PostgreSQL where JAREN_PG_URL names a
 * server.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { openStore, sql } from '@jarenjs/db';
import { createLiveSubscription } from '@jarenjs/db/app';
import { ENGINES, skipFor, withStore } from './store-core-engines.js';
import { statementCountingDriver } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    ev: {
      key: '/id',
      schema: { type: 'object', properties: { id: { type: 'string' }, at: { type: 'string', format: 'date-time', 'x-index': true }, tenant: { type: 'string' } } },
    },
  },
  entities: {
    Event: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: { id: { type: 'integer', 'x-entity': { key: true } }, at: { type: 'string' }, tenant: { type: 'string' } },
      },
    },
  },
};

const ROWS = [['a', '2026-01-01T00:00:00Z', 't1'], ['b', '2026-06-01T00:00:00Z', 't2']];
const SINCE = new Date('2026-03-01T00:00:00Z');
const ISO = SINCE.toISOString();

/** A collection document comparing each row with what `value` names, after the clauses `extra` adds.
 * @param {any} where @param {any} [extra] */
const evs = (where, extra = {}) => ({ $for: { e: '$[*]' }, ...extra, $where: where, $return: '$e.id' });
/** The same over the entity root. @param {any} where */
const rowsOf = (where) => ({ $for: { e: '$.Event[*]' }, $where: where, $return: '$e.id' });
const AFTER = { $gt: ['$e.at', '$since'] };

/** How a comparison reads a Date (by its instant) and a Map or a Set (as `{}`), and what to pass instead. */
const READS = /** @type {Record<string, string>} */ ({
  Date: 'its instant: it equals and orders against a Date alone, never JSON text such as a stored date-time — '
    + 'pass the JSON value it stands for, a Date as its toISOString()',
  Map: '{} — pass the JSON value it stands for, a Date as its toISOString()',
  Set: '{} — pass the JSON value it stands for, a Date as its toISOString()',
});
/** The refusal `JD0041` gives an external a comparison reads otherwise than it stands for.
 * @param {string} member @param {string} name @param {string} where @param {string} [at] @param {string} [docPath]
 * @param {string} [kind] */
const opaque = (member, name, where, at = '', docPath = '', kind = 'Date') => `JD0041: ${member} external '$${name}' holds a ${kind} instance`
  + `${at === '' ? '' : ` at ${at}`}, which ${where} reads as ${READS[kind]}`
  + `${docPath === '' ? '' : ` at ${docPath}`}`;
/** The refusal of an external the document's comparison at `docPath` reads.
 * @param {string} member @param {string} name @param {string} docPath @param {string} [at] @param {string} [kind] */
const compared = (member, name, docPath, at = '', kind = 'Date') => opaque(member, name, 'a comparison', at, docPath, kind);

/** What a call refuses with, and how: thrown at the call or a rejected promise.
 * @param {() => any} call @returns {Promise<{ form: string, error: any }>} */
async function refusal(call) {
  let pending;
  try { pending = call(); }
  catch (error) { return { form: 'thrown', error }; }
  try { await pending; }
  catch (error) { return { form: 'rejected', error }; }
  return assert.fail('expected a refusal');
}

/** The rows a cursor yields. @param {any} cursor */
async function drain(cursor) {
  const out = [];
  for await (const row of cursor) out.push(row);
  return out;
}

/** @param {string} engine @param {(store: any) => Promise<void>} body @param {any} [options] */
async function seeded(engine, body, options = {}) {
  await withStore(engine, MODEL, async (store) => {
    for (const [id, at, tenant] of ROWS) await store.collection('ev').insert({ id, at, tenant });
    for (const [i, [, at, tenant]] of ROWS.entries()) await store.entity('Event').create({ id: i + 1, at, tenant });
    await store.saveChanges();
    await body(store);
  }, { capture: true, ...options });
}

for (const engine of ENGINES) {
  describe(`an external a comparison reads otherwise than it stands for is refused, ${engine}`, { skip: skipFor(engine) }, () => {
    it('on a collection\'s execute, query, explain and live, with and without pushdown', async () => {
      await seeded(engine, async (store) => {
        const ev = store.collection('ev');
        // the ISO string it stands for answers
        assert.strictEqual(await ev.execute(evs(AFTER), { externals: { since: ISO } }), 'b');
        for (const pushdown of [true, false]) {
          // each answered no row: the Date compared as {}
          const { form, error } = await refusal(() => ev.execute(evs(AFTER), { externals: { since: SINCE }, pushdown }));
          assert.strictEqual(error.message, compared("collection('ev').execute", 'since', '/$where/$gt/1'));
          assert.strictEqual(error.code, 'JD0041');
          assert.strictEqual(error.docPath, '/$where/$gt/1');
          assert.strictEqual(form, 'thrown');
          const query = await refusal(() => drain(ev.query(evs(AFTER), { externals: { since: SINCE }, pushdown })));
          assert.strictEqual(query.error.message, compared("collection('ev').query", 'since', '/$where/$gt/1'));
          const explain = await refusal(() => ev.explain(evs(AFTER), { externals: { since: SINCE }, pushdown }));
          assert.strictEqual(explain.error.message, compared("collection('ev').explain", 'since', '/$where/$gt/1'));
          assert.strictEqual(explain.form, 'rejected');
        }
        // the same document's compiled entry, cached by the answer above, is checked per call
        assert.strictEqual((await refusal(() => ev.execute(evs(AFTER), { externals: { since: SINCE } }))).error.code, 'JD0041');
        // an explanation with no externals is the abstract plan, as before
        assert.deepStrictEqual((await ev.explain(evs(AFTER))).externals, ['since']);
        if (engine === 'sqlite') {
          const live = await refusal(() => ev.live(evs(AFTER), { externals: { since: SINCE } }));
          assert.strictEqual(live.error.message, compared("collection('ev').live", 'since', '/$where/$gt/1'));
          assert.strictEqual(live.form, 'rejected');
          assert.strictEqual(store.stats().liveQueries, 0);
          // an app subscription registers through live, and dispatches the refusal
          /** @type {any[]} */
          const dispatched = [];
          const settled = new Promise((resolve) => {
            createLiveSubscription(store)({ action: 'evs', statePath: '/evs', collection: 'ev', query: evs(AFTER), externals: { since: SINCE } },
              (/** @type {string} */ name, /** @type {any} */ payload) => { dispatched.push([name, payload]); resolve(undefined); });
          });
          await settled;
          assert.deepStrictEqual(dispatched, [['evs/error', { code: 'JD0041', message: compared("collection('ev').live", 'since', '/$where/$gt/1') }]]);
          assert.strictEqual(store.stats().liveQueries, 0);
          assert.strictEqual((await refusal(() => store.sync.collection('ev').execute(evs(AFTER), { externals: { since: SINCE } }))).error.code, 'JD0041');
        }
      });
    });

    it('a list member, a member path and an object holding one, wherever the comparison stands', async () => {
      await seeded(engine, async (store) => {
        const ev = store.collection('ev');
        const member = evs({ $eq: ['$e.at', '$xs[*]'] });
        // a membership over Dates matched no row; over their ISO strings it answers
        assert.strictEqual(await ev.execute(member, { externals: { xs: [ROWS[0][1]] } }), 'a');
        assert.strictEqual((await refusal(() => ev.execute(member, { externals: { xs: ['x', new Date(ROWS[0][1])] } }))).error.message,
          compared("collection('ev').execute", 'xs', '/$where/$eq/1'));
        assert.strictEqual((await refusal(() => ev.execute(evs({ $lt: ['$o.d', '$e.at'] }), { externals: { o: { d: SINCE } }, pushdown: false }))).error.message,
          compared("collection('ev').execute", 'o', '/$where/$lt/0'));
        assert.strictEqual((await refusal(() => ev.execute(evs({ $eq: ['$e.meta', '$o'] }), { externals: { o: { d: [SINCE] } } }))).error.message,
          compared("collection('ev').execute", 'o', '/$where/$eq/1', '/d/0'));
        assert.strictEqual((await refusal(() => ev.execute(evs({ $ne: ['$m', '$e.at'] }), { externals: { m: new Map() } }))).error.message,
          compared("collection('ev').execute", 'm', '/$where/$ne/0', '', 'Map'));
        // a Set where a list belongs, a Map where an object does: the path reached nothing through them
        assert.strictEqual((await refusal(() => ev.execute(member, { externals: { xs: new Set([ROWS[0][1]]) } }))).error.message,
          compared("collection('ev').execute", 'xs', '/$where/$eq/1', '', 'Set'));
        assert.strictEqual((await refusal(() => ev.execute(evs({ $gt: ['$e.at', '$o.d'] }), { externals: { o: new Map([['d', ISO]]) } }))).error.message,
          compared("collection('ev').execute", 'o', '/$where/$gt/1', '', 'Map'));
        // inside $let and $return: the comparison is found wherever it stands
        const nested = { $for: { e: '$[*]' }, $return: { id: '$e.id', late: { $ge: ['$e.at', '$since'] } } };
        assert.strictEqual((await refusal(() => ev.execute(nested, { externals: { since: SINCE } }))).error.message,
          compared("collection('ev').execute", 'since', '/$return/late/$ge/1'));
      });
    });

    it('on an entity set\'s execute, cursor and explain, and the store\'s execute and live', async () => {
      await seeded(engine, async (store) => {
        const rows = store.entity('Event');
        assert.deepStrictEqual(await rows.execute(rowsOf(AFTER), { externals: { since: ISO } }), 2);
        for (const pushdown of [true, false]) {
          const execute = await refusal(() => rows.execute(rowsOf(AFTER), { externals: { since: SINCE }, pushdown }));
          assert.strictEqual(execute.error.message, compared('entity execute()', 'since', '/$where/$gt/1'));
          assert.strictEqual(execute.error.docPath, '/$where/$gt/1');
          assert.strictEqual((await refusal(() => drain(rows.cursor(rowsOf(AFTER), { externals: { since: SINCE }, pushdown })))).error.message,
            compared('entity cursor()', 'since', '/$where/$gt/1'));
          assert.strictEqual((await refusal(() => rows.explain(rowsOf(AFTER), { externals: { since: SINCE }, pushdown }))).error.message,
            compared('entity explain()', 'since', '/$where/$gt/1'));
        }
        assert.strictEqual((await refusal(() => store.execute(rowsOf(AFTER), { externals: { since: SINCE } }))).error.code, 'JD0041');
        assert.strictEqual((await refusal(() => store.explain(rowsOf(AFTER), { externals: { since: SINCE } }))).error.code, 'JD0041');
        await store.transaction(async (/** @type {any} */ tx) => {
          assert.strictEqual((await refusal(() => tx.collection('ev').execute(evs(AFTER), { externals: { since: SINCE } }))).error.code, 'JD0041');
          assert.strictEqual((await refusal(() => tx.entity('Event').execute(rowsOf(AFTER), { externals: { since: SINCE } }))).error.code, 'JD0041');
        });
        if (engine === 'sqlite') {
          assert.strictEqual((await refusal(() => store.live(rowsOf(AFTER), { externals: { since: SINCE } }))).error.message,
            compared('store.live', 'since', '/$where/$gt/1'));
          assert.strictEqual(store.stats().liveQueries, 0);
        }
      });
    });

    it('an external the store profile\'s predicate compares', async () => {
      const profile = { externals: ['tenant', 'since'], predicates: { ev: { $eq: ['$it.tenant', '$tenant'] }, Event: { $eq: ['$it.tenant', '$tenant'] } } };
      await seeded(engine, async (store) => {
        const ev = store.collection('ev');
        assert.strictEqual(await ev.execute(evs({ $exists: '$e.id' }), { externals: { tenant: 't2' } }), 'b');
        const tenant = new Map();
        const { error } = await refusal(() => ev.execute(evs({ $exists: '$e.id' }), { externals: { tenant } }));
        assert.strictEqual(error.message, opaque("collection('ev').execute", 'tenant', "the store profile's predicate for 'ev'", '', '', 'Map'));
        assert.strictEqual(error.docPath, undefined);
        assert.strictEqual((await refusal(() => store.entity('Event').execute(rowsOf({ $exists: '$e.id' }), { externals: { tenant } }))).error.message,
          opaque('entity execute()', 'tenant', "the store profile's predicate for 'Event'", '', '', 'Map'));
      }, { profile });
    });

    it('every use that answered right answers as before', async () => {
      await seeded(engine, async (store) => {
        const ev = store.collection('ev');
        for (const pushdown of [true, false]) {
          const run = (/** @type {any} */ document, /** @type {any} */ externals) => ev.execute(document, { externals, pushdown });
          // returned: the caller's own value, by reference
          const returned = await run({ $for: { e: '$[*]' }, $where: { $eq: ['$e.id', 'a'] }, $return: { id: '$e.id', s: '$since' } }, { since: SINCE });
          assert.strictEqual(returned.s, SINCE);
          // never compared: a Date beside the externals a document reads
          assert.strictEqual(await run(evs(AFTER), { since: ISO, unused: SINCE }), 'b');
          // existence and count read no member
          assert.deepStrictEqual(await run(evs({ $exists: '$since' }), { since: SINCE }), ['a', 'b']);
          assert.deepStrictEqual(await run(evs({ $eq: [{ $count: '$since' }, 1] }), { since: SINCE }), ['a', 'b']);
          // a Date compared with itself answers alike as {}
          assert.deepStrictEqual(await run(evs({ $eq: ['$since', '$since'] }), { since: SINCE }), ['a', 'b']);
          // plain, null-prototype and class-instance objects compare by their members
          assert.strictEqual(await run(evs({ $gt: ['$e.at', '$w.from'] }), { w: { from: ISO } }), 'b');
          assert.strictEqual(await run(evs({ $gt: ['$e.at', '$w.from'] }), { w: Object.assign(Object.create(null), { from: ISO }) }), 'b');
          assert.strictEqual(await run(evs({ $gt: ['$e.at', '$w.from'] }), { w: new Window(ISO) }), 'b');
          // compared whole: an empty null-prototype object is {}, a class instance its fields
          assert.deepStrictEqual(await run(evs({ $ne: ['$e.id', '$w'] }), { w: Object.create(null) }), ['a', 'b']);
          assert.deepStrictEqual(await run(evs({ $eq: ['$e.id', '$w[*]'] }), { w: Object.create(null) }), undefined);
          assert.deepStrictEqual(await run(evs({ $ne: ['$e.id', '$w'] }), { w: new Window(ISO) }), ['a', 'b']);
          assert.deepStrictEqual(await run({ $for: { e: '$[*]' }, $where: { $eq: [{ from: ISO }, '$w'] }, $return: '$e.id' }, { w: new Window(ISO) }), ['a', 'b']);
          // an array, a primitive, null
          assert.strictEqual(await run(evs({ $eq: ['$e.at', '$xs[*]'] }), { xs: [ROWS[1][1]] }), 'b');
          assert.strictEqual(await run(evs({ $eq: ['$e.at', '$xs[*]'] }), { xs: [] }), undefined);
          assert.strictEqual(await run(evs({ $eq: ['$e.id', '$id'] }), { id: 'a' }), 'a');
          assert.strictEqual(await run(evs({ $eq: ['$e.at', '$none'] }), { none: null }), undefined);
          // a bigint is handed through as it was
          assert.strictEqual((await run({ $for: { e: '$[*]' }, $where: { $eq: ['$e.id', 'a'] }, $return: { n: '$n' } }, { n: 2n })).n, 2n);
        }
        // the entity engine alike
        const returned = await store.entity('Event').execute({ $for: { e: '$.Event[*]' }, $where: { $eq: ['$e.id', 1] }, $return: { s: '$since' } }, { externals: { since: SINCE } });
        assert.strictEqual(returned.s, SINCE);
        assert.strictEqual(await store.entity('Event').execute(rowsOf(AFTER), { externals: { since: ISO, unused: SINCE } }), 2);
      });
    });

    it('one a filter selects or reads, an operator hands through or a fold starts from', async () => {
      await seeded(engine, async (store) => {
        const ev = store.collection('ev');
        const member = "collection('ev').execute";
        /** @type {[any, any, any, string][]} each document, externals of which one reads a Date, their JSON form, and where */
        const cases = [
          [evs({ $gt: ['$e.at', '$xs[?@.k == 1].at'] }), { xs: [{ k: 1, at: SINCE }] }, { xs: [{ k: 1, at: ISO }] }, '/$where/$gt/1'],
          [evs({ $gt: ['$e.at', '$xs[?@.at > "2026"].v'] }), { xs: [{ v: ISO, at: SINCE }] }, { xs: [{ v: ISO, at: ISO }] }, '/$where/$gt/1'],
          [evs({ $gt: ['$e.at', '$xs[?length(@.at) > 3].v'] }), { xs: [{ v: ISO, at: SINCE }] }, { xs: [{ v: ISO, at: ISO }] }, '/$where/$gt/1'],
          [evs({ $gt: ['$e.at', '$xs..[?@.k == 1].at'] }), { xs: { o: [{ k: 1, at: SINCE }] } }, { xs: { o: [{ k: 1, at: ISO }] } }, '/$where/$gt/1'],
          [evs({ $gt: ['$e.at', '$xs[0:1][?(@.k == 1 || @.k == 2) && !@.z && match(@.s, "a.*")]["at"]'] }),
            { xs: [[{}, { k: 2, s: 'ab', at: SINCE }]] }, { xs: [[{}, { k: 2, s: 'ab', at: ISO }]] }, '/$where/$gt/1'],
          [evs({ $gt: ['$e.at', { $head: '$xs[*]' }] }), { xs: [SINCE, ISO] }, { xs: [ISO, ISO] }, '/$where/$gt/1'],
          [evs({ $gt: ['$e.at', { $tail: '$xs[*]' }] }), { xs: [ISO, SINCE] }, { xs: [ISO, ISO] }, '/$where/$gt/1'],
          [evs({ $gt: ['$e.at', { $reverse: '$xs[*]' }] }), { xs: [SINCE] }, { xs: [ISO] }, '/$where/$gt/1'],
          [evs({ $gt: ['$e.at', { $subsequence: ['$xs[*]', 1, 1] }] }), { xs: [ISO, SINCE, ISO] }, { xs: [ISO, ISO, ISO] }, '/$where/$gt/1'],
          [evs({ $gt: ['$e.at', { $get: ['$o', 'at'] }] }), { o: { at: SINCE } }, { o: { at: ISO } }, '/$where/$gt/1'],
          [evs({ $gt: ['$e.at', { $get: ['$xs', -1] }] }), { xs: [ISO, SINCE] }, { xs: [ISO, ISO] }, '/$where/$gt/1'],
          [evs({ $gt: ['$e.at', { $seq: ['$a', '$b'] }] }), { a: ISO, b: SINCE }, { a: ISO, b: ISO }, '/$where/$gt/1'],
          [evs({ $ne: [['$e.at'], ['$a']] }), { a: SINCE }, { a: ISO }, '/$where/$ne/1'],
          [evs({ $ne: [{ at: '$e.at' }, { at: '$a' }] }), { a: SINCE }, { a: ISO }, '/$where/$ne/1'],
          [{ $fold: { acc: '$s' }, $for: { e: '$[*]' }, $where: { $gt: ['$e.at', '$acc'] }, $orderby: ['$e.id'], $return: '$e.id' },
            { s: SINCE }, { s: ISO }, '/$where/$gt/1'],
          [{ $for: { e: '$[*]', w: { $in: '$xs[*]', $window: 'tumbling', $size: 1 } }, $where: { $gt: ['$e.at', '$w'] }, $return: '$e.id' },
            { xs: [SINCE] }, { xs: [ISO] }, '/$where/$gt/1'],
        ];
        for (const [document, dated, iso, docPath] of cases) {
          // the one external holding a Date
          const name = Object.keys(dated).find((key) => dated[key] !== iso[key]);
          const label = JSON.stringify(document);
          for (const pushdown of [true, false]) {
            const expected = await ev.execute(document, { externals: iso, pushdown: false });
            assert.notStrictEqual(expected, undefined, label);
            assert.deepStrictEqual(await ev.execute(document, { externals: iso, pushdown }), expected, label);
            const { error } = await refusal(() => ev.execute(document, { externals: dated, pushdown }));
            assert.strictEqual(error.message, compared(member, name, docPath), label);
          }
        }
        // what the filter or operator leaves behind is never read: the call answers
        const ok = (/** @type {any} */ document, /** @type {any} */ externals) => ev.execute(document, { externals });
        assert.strictEqual(await ok(evs({ $gt: ['$e.at', '$xs[?@.k == 1].at'] }), { xs: [{ k: 1, at: ISO }, { k: 2, at: SINCE }] }), 'b');
        assert.strictEqual(await ok(evs({ $gt: ['$e.at', '$xs[?@.at].v'] }), { xs: [{ v: ISO, at: SINCE }] }), 'b');
        assert.strictEqual(await ok(evs({ $gt: ['$e.at', '$xs[?count(@.*) == 2].v'] }), { xs: [{ v: ISO, at: SINCE }] }), 'b');
        assert.strictEqual(await ok(evs({ $gt: ['$e.at', { $head: '$xs[*]' }] }), { xs: [ISO, SINCE] }), 'b');
        assert.strictEqual(await ok(evs({ $gt: ['$e.at', { $tail: '$xs[*]' }] }), { xs: [SINCE, ISO] }), 'b');
        assert.strictEqual(await ok(evs({ $gt: ['$e.at', { $subsequence: ['$xs[*]', 0, 1] }] }), { xs: [ISO, SINCE] }), 'b');
        assert.strictEqual(await ok(evs({ $gt: ['$e.at', { $get: ['$o', 'at'] }] }), { o: { at: ISO, other: SINCE } }), 'b');
        assert.strictEqual(await ok(evs({ $gt: ['$e.at', { $get: ['$xs[*]', 'at'] }] }), { xs: [{ at: SINCE }, { at: SINCE }] }), undefined);
        // the entity engine reads the same way
        const rows = store.entity('Event');
        const after = rowsOf({ $gt: ['$e.at', '$xs[?@.k == 1].at'] });
        assert.strictEqual(await rows.execute(after, { externals: { xs: [{ k: 1, at: ISO }]} }), 2);
        assert.strictEqual((await refusal(() => rows.execute(after, { externals: { xs: [{ k: 1, at: SINCE }]} }))).error.message,
          compared('entity execute()', 'xs', '/$where/$gt/1'));
      });
    });

    it('one an operand picks where the call\'s externals alone decide which', async () => {
      await seeded(engine, async (store) => {
        const ev = store.collection('ev');
        const member = "collection('ev').execute";
        const W = '/$where/$gt/1';
        /** @type {[any, any, any, string, string, string?, string?][]} each document, externals of which `name` holds a
         * non-JSON value the externals pick, their JSON form, the external, where it is compared, and where it holds it */
        const cases = [
          // a condition the externals decide: a flag, a $let bound to one, a computed one, a literal beside a row
          [evs({ $gt: ['$e.at', { $if: ['$f', '$a', '$b'] }] }), { f: true, a: SINCE, b: ISO }, { f: true, a: ISO, b: ISO }, 'a', W],
          [evs({ $gt: ['$e.at', { $if: ['$f', '$b', '$a'] }] }), { f: false, a: SINCE, b: ISO }, { f: false, a: ISO, b: ISO }, 'a', W],
          [evs({ $gt: ['$e.at', { $if: ['$g', '$a', '$b'] }] }, { $let: { g: '$f' } }), { f: true, a: SINCE, b: ISO }, { f: true, a: ISO, b: ISO }, 'a', W],
          [evs({ $gt: ['$e.at', { $if: [{ $eq: ['$mode', 'from'] }, '$a', '$b'] }] }), { mode: 'from', a: SINCE, b: ISO }, { mode: 'from', a: ISO, b: ISO }, 'a', W],
          [evs({ $gt: ['$e.at', { $if: [true, '$a', '$e.tenant'] }] }), { a: SINCE }, { a: ISO }, 'a', W],
          // the first operand that is not empty
          [evs({ $gt: ['$e.at', { $coalesce: ['$o.x', '$a'] }] }), { o: {}, a: SINCE }, { o: {}, a: ISO }, 'a', W],
          [evs({ $gt: ['$e.at', { $coalesce: ['$a', '$e.tenant'] }] }), { a: SINCE }, { a: ISO }, 'a', W],
          [evs({ $gt: ['$e.at', { $coalesce: ['$xs[*]', '$a'] }] }), { xs: [], a: SINCE }, { xs: [], a: ISO }, 'a', W],
          [evs({ $gt: ['$e.at', { $default: ['$o.x', '$a'] }] }), { o: {}, a: SINCE }, { o: {}, a: ISO }, 'a', W],
          // a computed key or bounds
          [evs({ $gt: ['$e.at', { $get: ['$o', '$k'] }] }), { o: { at: SINCE }, k: 'at' }, { o: { at: ISO }, k: 'at' }, 'o', W],
          [evs({ $gt: ['$e.at', { $get: ['$xs', '$i'] }] }), { xs: [ISO, SINCE], i: 1 }, { xs: [ISO, ISO], i: 1 }, 'xs', W],
          [evs({ $gt: ['$e.at', { $subsequence: ['$xs[*]', '$i', '$n'] }] }), { xs: [ISO, SINCE], i: 1, n: 1 }, { xs: [ISO, ISO], i: 1, n: 1 }, 'xs', W],
          // member pairs, read by member or compared whole
          [evs({ $gt: ['$e.at', '$p.value'] }, { $let: { p: { $entries: '$o' } } }), { o: { at: SINCE } }, { o: { at: ISO } }, 'o', W],
          [evs({ $eq: [{ key: 'at', value: ISO }, { $entries: '$o' }] }), { o: { at: SINCE } }, { o: { at: ISO } }, 'o', '/$where/$eq/1', '/at'],
          // a nested phrase's return: a $let, a $for that drops nothing, one the engine filters
          [evs({ $gt: ['$e.at', { $let: { s: '$a' }, $return: '$s' }] }), { a: SINCE }, { a: ISO }, 'a', W],
          [evs({ $gt: ['$e.at', { $let: { s: '$a' }, $return: { $seq: ['$s', '$e.tenant'] } }] }), { a: SINCE }, { a: ISO }, 'a', W],
          [evs({ $gt: ['$e.at', { $for: { x: '$xs[*]' }, $return: '$x' }] }), { xs: [SINCE] }, { xs: [ISO] }, 'xs', W],
          [evs({ $gt: ['$e.at', { $for: { x: '$xs[*]' }, $where: { $not: { '$is-number': '$x' } }, $return: '$x' }] }),
            { xs: [SINCE, 3] }, { xs: [ISO, 3] }, 'xs', W],
          // a path into a constructor: a named member beside a row's, an element of one-item elements, every element
          [evs({ $gt: ['$e.at', '$c.at'] }, { $let: { c: { at: '$a', id: '$e.id' } } }), { a: SINCE }, { a: ISO }, 'a', W],
          [evs({ $gt: ['$e.at', '$c[1]'] }, { $let: { c: ['$b', '$a'] } }), { a: SINCE, b: ISO }, { a: ISO, b: ISO }, 'a', W],
          [evs({ $gt: ['$e.at', '$c[*]'] }, { $let: { c: ['$e.id', '$a'] } }), { a: SINCE }, { a: ISO }, 'a', W],
          // a { $let, $return } phrase around the comparison
          [{ $let: { s: '$a' }, $return: evs({ $gt: ['$e.at', '$s'] }) }, { a: SINCE }, { a: ISO }, 'a', '/$return/$where/$gt/1'],
          [evs({ $eq: [{ x: 1 }, { $coalesce: ['$o.q', '$m'] }] }), { o: {}, m: new Map([['x', 1]]) }, { o: {}, m: { x: 1 } }, 'm', '/$where/$eq/1', '', 'Map'],
        ];
        for (const [document, dated, json, name, docPath, at = '', kind = 'Date'] of cases) {
          const label = JSON.stringify(document);
          for (const pushdown of [true, false]) {
            const expected = await ev.execute(document, { externals: json, pushdown: false });
            assert.notStrictEqual(expected, undefined, label);
            assert.deepStrictEqual(await ev.execute(document, { externals: json, pushdown }), expected, label);
            const { error } = await refusal(() => ev.execute(document, { externals: dated, pushdown }));
            assert.strictEqual(error.message, compared(member, name, docPath, at, kind), label);
            assert.strictEqual(error.docPath, docPath, label);
          }
        }
        // a call refused before keeps its reason: what a reference reaches is checked first
        const both = { $let: { s: '$a' }, $return: evs({ $and: [{ $gt: ['$e.at', '$s'] }, { $gt: ['$e.at', '$b'] }] }) };
        assert.strictEqual((await refusal(() => ev.execute(both, { externals: { a: SINCE, b: SINCE } }))).error.message,
          compared(member, 'b', '/$return/$where/$and/1/$gt/1'));
        // a bigint the externals pick reads as no number, as one compared directly does
        assert.strictEqual((await refusal(() => ev.execute(evs({ $gt: ['$e.at', { $if: ['$f', '$m', ISO] }] }), { externals: { f: true, m: 2n } }))).error.message,
          `JD0041: ${member} external '$m' holds a bigint, which a comparison reads as no number — pass the number it stands for, Number(value) at ${W}`);
        // the entity engine and a live registration read the same way
        const pick = rowsOf({ $gt: ['$e.at', { $if: ['$f', '$a', '$b'] }] });
        assert.strictEqual(await store.entity('Event').execute(pick, { externals: { f: true, a: ISO, b: ISO } }), 2);
        assert.strictEqual((await refusal(() => store.entity('Event').execute(pick, { externals: { f: true, a: SINCE, b: ISO } }))).error.message,
          compared('entity execute()', 'a', W));
        if (engine === 'sqlite') {
          const live = await refusal(() => ev.live(evs({ $gt: ['$e.at', { $coalesce: ['$o.x', '$a'] }] }), { externals: { o: {}, a: SINCE } }));
          assert.strictEqual(live.error.message, compared("collection('ev').live", 'a', W));
          assert.strictEqual(store.stats().liveQueries, 0);
        }
      });
    });

    it('what the externals pick instead, and what only a row could pick, answers as the JSON value it stands for', async () => {
      await seeded(engine, async (store) => {
        const ev = store.collection('ev');
        /** @type {[any, any, any][]} each document, externals holding a Date the call never compares, and the answer */
        const cases = [
          // the externals pick another operand
          [evs({ $gt: ['$e.at', { $if: ['$f', '$a', '$b'] }] }), { f: false, a: SINCE, b: ISO }, 'b'],
          [evs({ $gt: ['$e.at', { $coalesce: ['$o.x', '$a'] }] }), { o: { x: ISO }, a: SINCE }, 'b'],
          [evs({ $gt: ['$e.at', { $coalesce: ['$xs[*]', '$a'] }] }), { xs: [ISO], a: SINCE }, 'b'],
          [evs({ $gt: ['$e.at', { $get: ['$o', '$k'] }] }), { o: { at: ISO, other: SINCE }, k: 'at' }, 'b'],
          [evs({ $gt: ['$e.at', { $get: ['$xs', '$i'] }] }), { xs: [ISO, SINCE], i: 0 }, 'b'],
          [evs({ $gt: ['$e.at', { $subsequence: ['$xs[*]', '$i', '$n'] }] }), { xs: [ISO, SINCE], i: 0, n: 1 }, 'b'],
          [evs({ $gt: ['$e.at', { $for: { x: '$xs[*]' }, $where: { '$is-string': '$x' }, $return: '$x' }] }), { xs: [ISO, SINCE] }, 'b'],
          [evs({ $gt: ['$e.at', '$c[0]'] }, { $let: { c: ['$b', '$a'] } }), { a: SINCE, b: ISO }, 'b'],
          // a key of no item reads nothing, whatever the target holds
          [evs({ $gt: ['$e.at', { $get: ['$m', '$o.k'] }] }), { m: new Map([['at', ISO]]), o: {} }, undefined],
          // only a row could pick it, and none does: a refusal by what it holds would refuse each right answer
          [evs({ $gt: ['$e.at', { $if: [{ $eq: ['$e.id', 'zz'] }, '$a', '$b'] }] }), { a: SINCE, b: ISO }, 'b'],
          [evs({ $gt: ['$e.tenant', { $coalesce: ['$e.at', '$a'] }] }), { a: SINCE }, ['a', 'b']],
          [evs({ $gt: ['$e.at', { $get: ['$o', '$e.tenant'] }] }), { o: { t1: ISO, t2: ISO, t3: SINCE } }, 'b'],
          [evs({ $gt: ['$e.at', { $for: { x: '$xs[*]' }, $where: { $eq: ['$x.k', '$e.tenant'] }, $return: '$x.at' }] }),
            { xs: [{ k: 't2', at: ISO }, { k: 't3', at: SINCE }] }, 'b'],
          [evs({ $gt: ['$e.at', '$c[1]'] }, { $let: { c: ['$e.missing', '$a'] } }), { a: SINCE }, undefined],
          // the collection decides: its count, a filter that reads it
          [evs({ $gt: ['$e.at', { $if: [{ $eq: [{ $count: '$[*]' }, 2] }, '$b', '$a'] }] }), { a: SINCE, b: ISO }, 'b'],
          [evs({ $gt: ['$e.at', { $if: [{ $exists: '$xs[?@.k == $[0].tenant]' }, '$b', '$a'] }] }), { xs: [{ k: 't1' }], a: SINCE, b: ISO }, 'b'],
          // an iteration variable decides, item by item
          [{ $for: { e: '$[*]', w: '$ws[*]' }, $where: { $gt: ['$e.at', { $if: [{ $eq: [{ $count: '$w.items[*]' }, 2] }, '$a', '$b'] }] }, $return: '$e.id' },
            { ws: [{ items: [1] }, { items: [2] }], a: SINCE, b: ISO }, ['b', 'b']],
        ];
        /** The JSON value a Date stands for, wherever it stands. @param {any} value @returns {any} */
        const json = (value) => (value === SINCE ? ISO : Array.isArray(value) ? value.map(json)
          : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, json(item)])) : value);
        for (const [document, externals, answer] of cases) {
          const label = JSON.stringify(document);
          for (const pushdown of [true, false]) {
            assert.deepStrictEqual(await ev.execute(document, { externals, pushdown }), answer, label);
            assert.deepStrictEqual(await ev.execute(document, { externals: json(externals), pushdown }), answer, label);
          }
        }
        // a condition the engine refuses for these externals is not followed: the call is refused as the engine refuses it
        const many = evs({ $gt: ['$e.at', { $if: ['$xs[*]', '$a', '$b'] }] });
        for (const externals of [{ xs: [1, 2], a: SINCE, b: ISO }, { xs: [1, 2], a: ISO, b: ISO }]) {
          assert.strictEqual((await refusal(() => ev.execute(many, { externals }))).error.code, 'JQ2003');
        }
      });
    });

    it('a reference compared with itself under the condition that picks it answers alike', async () => {
      await seeded(engine, async (store) => {
        const ev = store.collection('ev');
        const document = evs({ $eq: ['$a', { $if: ['$f', '$a', '$b'] }] });
        assert.deepStrictEqual(await ev.execute(document, { externals: { f: true, a: SINCE, b: ISO } }), ['a', 'b']);
        assert.strictEqual((await refusal(() => ev.execute(document, { externals: { f: false, a: SINCE, b: ISO } }))).error.message,
          compared("collection('ev').execute", 'a', '/$where/$eq/0'));
      });
    });

    it('a filter that reads the input document is not followed, and answers as the engine', async () => {
      await seeded(engine, async (store) => {
        const document = evs({ $gt: ['$e.at', '$xs[?@.k == $[0].k].at'] });
        for (const pushdown of [true, false]) {
          assert.strictEqual(await store.collection('ev').execute(document, { externals: { xs: [{ k: 1, at: SINCE }] }, pushdown }), undefined);
        }
      });
    });

    it('a host function is handed the Date itself', async () => {
      /** @type {any[]} */
      const seen = [];
      const functions = { after: (/** @type {any} */ at, /** @type {any} */ since) => { seen.push(since); return Date.parse(at) > since.getTime(); } };
      await seeded(engine, async (store) => {
        assert.strictEqual(await store.collection('ev').execute(evs({ $call: ['after', '$e.at', '$since'] }), { externals: { since: SINCE } }), 'b');
        assert.ok(seen.length > 0 && seen.every((value) => value === SINCE));
      }, { functions });
    });
  });
}

describe('an external the externals pick is refused before any statement runs', () => {
  it('reads no row on the refused call, and the JSON value it stands for does', async () => {
    const counters = { iterate: 0, next: 0, return: 0, all: 0 };
    const store = await openStore(MODEL, { driver: statementCountingDriver(counters) });
    try {
      for (const [id, at, tenant] of ROWS) await store.collection('ev').insert({ id, at, tenant });
      const document = evs({ $gt: ['$e.at', { $coalesce: ['$o.x', '$a'] }] });
      for (const pushdown of [true, false]) {
        Object.assign(counters, { iterate: 0, next: 0, return: 0, all: 0 });
        assert.strictEqual((await refusal(() => store.collection('ev').execute(document, { externals: { o: {}, a: SINCE }, pushdown }))).error.code, 'JD0041');
        assert.deepStrictEqual(counters, { iterate: 0, next: 0, return: 0, all: 0 });
        assert.strictEqual(await store.collection('ev').execute(document, { externals: { o: {}, a: ISO }, pushdown }), 'b');
        assert.ok(counters.all + counters.iterate > 0);
      }
    }
    finally { await store.close(); }
  });
});

describe('a relational statement binds an external as a SQL value or refuses it', () => {
  it('a Date parameter is refused, its ISO string bound', async () => {
    await withStore('sqlite', MODEL, async (store) => {
      await store.entity('Event').create({ id: 1, at: ROWS[0][1] });
      await store.saveChanges();
      const statement = { from: 'Event', columns: { id: sql.column('id') }, where: sql.binary('=', sql.column('at'), sql.param('at')) };
      assert.deepStrictEqual((await store.relational.all(statement, { externals: { at: ROWS[0][1] } })).map((/** @type {any} */ row) => row.id), [1]);
      const { error } = await refusal(() => store.relational.all(statement, { externals: { at: new Date(ROWS[0][1]) } }));
      assert.strictEqual(error.code, 'JD0038');
      assert.match(error.message, /SQL values are null, strings, finite numbers, integers or bytes/);
    });
  });
});

/** A class instance read by its fields. */
class Window {
  /** @param {string} from */
  constructor(from) { this.from = from; }
  get span() { return 1; }
}
