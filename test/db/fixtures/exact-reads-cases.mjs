// The reads a native statement must hand back as the engine reads them, as cases over one opener:
// `open(model, fn)` runs `fn(store, host)` on a fresh store. The Node test and the Bun fixture share
// them, so the same documents are asked of every database.
import assert from 'node:assert/strict';
import { compileJsonQuery } from '@jarenjs/json/query';

const asItems = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);

/** @param {AsyncIterable<any>} cursor */
async function drained(cursor) {
  const items = [];
  for await (const item of cursor) items.push(item);
  return items;
}

/**
 * Ask `document` of `rows` by `execute` and by a cursor, and require the engine's answer from both.
 * @param {any} rows @param {any[]} docs @param {any} document @param {string} label @param {any} [externals]
 * @returns {Promise<any>} the engine's answer
 */
async function sameAsEngine(rows, docs, document, label, externals = undefined) {
  const expected = compileJsonQuery(document)(structuredClone(docs), externals);
  const options = externals === undefined ? undefined : { externals };
  assert.deepEqual(await rows.execute(document, options), expected, `execute: ${label}`);
  assert.deepEqual(await drained(rows.query(document, options)), asItems(expected), `cursor: ${label}`);
  return expected;
}

const whole = (fn, member) => ({ [fn]: { $for: { it: '$[*]' }, $return: `$it.${member}` } });
const grouped = (fn, member) => ({ $for: { it: '$[*]' }, $groupby: { g: '$it.g' }, $return: { g: '$g', v: { [fn]: `$it.${member}` } } });
const bucketed = (fn, member) => ({ $for: { it: '$[*]' },
  $where: { $and: [{ $eq: ['$it.g', 'x'] }, { $ge: ['$it.at', 0] }] },
  $groupby: { b: { '$time-bucket': ['$it.at', 1000, 0] } }, $orderby: ['$b'], $return: { at: '$b', v: { [fn]: `$it.${member}` } } });

const WIDE_MODEL = { $model: '0.1', collections: { rows: { key: '/id',
  schema: { type: 'object', properties: { id: { type: 'string' }, g: { type: 'string' }, at: { type: 'integer' },
    n: { type: 'number' }, i: { type: 'integer' } } },
  indexes: [{ name: 'by_g_at', path: ['$.g', '$.at'] }] } } };
const WIDE_DOCS = [
  { id: 'a', g: 'x', at: 0, n: 1e16, i: 2 ** 60 },
  { id: 'b', g: 'x', at: 1, n: 1, i: 2 ** 61 },
  { id: 'c', g: 'y', at: 2, n: 2 ** 62, i: 5 },
];

/** @type {{ name: string, model: any, docs: any[], hosts?: string[], run: (rows: any, docs: any[], host: string) => Promise<void> }[]} */
export const cases = [
  { name: 'a number past 2^53 is read back as the double the engine holds, whole, grouped and bucketed',
    model: WIDE_MODEL, docs: WIDE_DOCS,
    async run(rows, docs, host) {
      for (const member of ['n', 'i']) {
        for (const fn of ['$max', '$min']) {
          for (const document of [whole(fn, member), grouped(fn, member), bucketed(fn, member)]) {
            const label = `${host} ${JSON.stringify(document)}`;
            await sameAsEngine(rows, docs, document, label);
            assert.equal((await rows.explain(document)).mode, 'native', label);
          }
        }
      }
    } },
  { name: 'a number past 2^53 is read back as the double the engine holds, projected',
    model: WIDE_MODEL, docs: WIDE_DOCS,
    async run(rows, docs, host) {
      for (const document of [
        { $for: { it: '$[*]' }, $return: '$it.n' },
        { $for: { it: '$[*]' }, $return: '$it.i' },
        { $for: { it: '$[*]' }, $return: { n: '$it.n', i: '$it.i' } },
      ]) {
        const label = `${host} ${JSON.stringify(document)}`;
        await sameAsEngine(rows, docs, document, label);
        assert.equal((await rows.explain(document)).mode, 'native', label);
      }
    } },
];

/**
 * Run every case on every host the opener reaches.
 * @param {(model: any, fn: (store: any, host: string) => Promise<void>) => Promise<void>} open
 * @returns {Promise<string[]>} the cases that failed, with the reason
 */
export async function problems(open) {
  const failures = [];
  for (const kase of cases) {
    try {
      await open(kase.model, async (store, host) => {
        if (kase.hosts !== undefined && !kase.hosts.includes(host)) return;
        const rows = store.collection('rows');
        for (const document of kase.docs) await rows.insert(document);
        await kase.run(rows, kase.docs, host);
      });
    }
    catch (error) {
      failures.push(`${kase.name}: ${String(/** @type {any} */ (error)?.message ?? error).split('\n')[0]}`);
    }
  }
  return failures;
}
