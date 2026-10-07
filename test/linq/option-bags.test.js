//@ts-check
/**
 * @file The chain's option bags are closed sets (QUERY-PEN.md §8.1, §11,
 * §12, §12.1): `from`/`fromAsync`/`fromDocument`'s compile options, an
 * ordering's options, a push queue's, `mapAsync`'s and `federate`'s. A
 * misspelt member used to be dropped — a typo'd `limit` left the query
 * unbounded, a typo'd `maxTotalRow` fell back to the default budget — and
 * a value of the wrong type was read as a default or escaped as a raw
 * `TypeError`. Each is now `JL0005`, naming the nearest member where one
 * is close, while every documented option keeps its behavior.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  from, fromAsync, fromDocument, createPushQueue, federate, LinqBuildError,
} from '@jarenjs/linq';

/** @param {RegExp} pattern */
const refused = (pattern) => (/** @type {any} */ error) =>
  error instanceof LinqBuildError && error.code === 'JL0005' && pattern.test(error.message);

const ROWS = Array.from({ length: 50 }, (_, i) => ({ a: i }));
const overTwo = (/** @type {any} */ q) => q.where((/** @type {any} */ x) => x.a.gt(1));

describe('from(), fromAsync() and fromDocument() options', () => {
  it('a misspelt member is refused, naming the nearest — it used to leave the query unbounded', async () => {
    const limit = refused(/^JL0005: from\(\) does not take 'limit' — did you mean 'limits'\?$/);
    assert.throws(() => from(ROWS, { limit: { steps: 3 } }), limit);
    assert.throws(() => from(ROWS, { limts: { sequenceItems: 3 } }), refused(/'limts' — did you mean 'limits'\?/));
    assert.throws(() => from(ROWS, { compileTypetest: () => () => true }), refused(/did you mean 'compileTypeTest'\?/));
    assert.throws(() => fromAsync(ROWS, { limit: {} }), refused(/^JL0005: fromAsync\(\) does not take 'limit'/));
    assert.throws(() => fromDocument(ROWS, '$[*]', { limit: {} }), refused(/^JL0005: fromDocument\(\) does not take 'limit'/));
    assert.throws(() => from(ROWS, { bogus: 1 }),
      refused(/'bogus'; the options are compileTypeTest, functions, collations, pathFunctions, limits, registry$/));
  });

  it('an options argument that is not a plain object is refused', () => {
    for (const options of ['x', null, [], 5, true, new Map()]) {
      assert.throws(() => from(ROWS, options), refused(/^JL0005: from\(\) takes a plain options object$/), String(options));
      assert.throws(() => fromAsync(ROWS, options), refused(/fromAsync\(\) takes a plain options object/));
      assert.throws(() => fromDocument(ROWS, '$[*]', options), refused(/fromDocument\(\) takes a plain options object/));
    }
  });

  it('the documented options keep their behavior', async () => {
    assert.throws(() => overTwo(from(ROWS, { limits: { steps: 3 } })).count(), (/** @type {any} */ e) => e.code === 'JQ2009');
    assert.throws(() => overTwo(from(ROWS, { limits: { sequenceItems: 3 } })).toArray(), (/** @type {any} */ e) => e.code === 'JQ2009');
    assert.equal(overTwo(from(ROWS)).count(), 48);
    assert.equal(overTwo(from(ROWS, undefined)).count(), 48);
    assert.equal(overTwo(from(ROWS, {})).count(), 48);
    assert.equal(overTwo(from(ROWS, Object.create(null))).count(), 48);
    assert.equal(overTwo(from(ROWS, { registry: {} })).count(), 48);
    assert.equal(await overTwo(fromAsync(ROWS, {})).count(), 48);
    assert.deepEqual(fromDocument([1, 2], '$[*]', { limits: { sequenceItems: 10 } }).toArray(), [1, 2]);
  });
});

describe('orderBy() options', () => {
  // the first row's key is empty: it has no member `a`
  const PAIR = [{}, { a: 1 }];

  it('null, a string and a misspelt member are refused on both surfaces — null used to be a raw TypeError', () => {
    const notObject = refused(/^JL0005: orderBy\(\) takes a plain options object$/);
    assert.throws(() => from(PAIR).orderBy((x) => x.a, null), notObject);
    assert.throws(() => from(PAIR).orderBy((x) => x.a, 'desc'), notObject);
    assert.throws(() => fromAsync(PAIR).orderBy((x) => x.a, null), notObject);
    assert.throws(() => from(PAIR).orderByDescending((x) => x.a, 'x'), refused(/^JL0005: orderByDescending\(\) takes/));
    assert.throws(() => from(PAIR).orderBy((x) => x.a, { emtpy: 'greatest' }),
      refused(/^JL0005: orderBy\(\) does not take 'emtpy' — did you mean 'empty'\?$/));
    assert.throws(() => fromAsync(PAIR).orderBy((x) => x.a).thenBy((x) => x.a, { colation: 'nl' }),
      refused(/^JL0005: thenBy\(\) does not take 'colation' — did you mean 'collation'\?$/));
    assert.throws(() => from(PAIR).orderBy((x) => x.a).thenByDescending((x) => x.a, { order: 'x' }),
      refused(/thenByDescending\(\) does not take 'order'; the options are empty, collation$/));
  });

  it('the two documented members still write the clause, and their values stay the engine\'s to judge', async () => {
    const spec = (/** @type {any} */ q) => q.toDocument().$orderby;
    assert.deepEqual(spec(from(PAIR).orderBy((x) => x.a, { empty: 'greatest' })), { $key: '$it.a', $empty: 'greatest' });
    assert.deepEqual(spec(fromAsync(PAIR).orderByDescending((x) => x.a, { empty: 'least', collation: 'nl' })),
      { $key: '$it.a', $dir: 'desc', $empty: 'least', $collation: 'nl' });
    assert.deepEqual(from(PAIR).orderBy((x) => x.a, { empty: 'greatest' }).toArray(), [{ a: 1 }, {}]);
    assert.deepEqual(await fromAsync(PAIR).orderBy((x) => x.a, undefined).toArray(), [{}, { a: 1 }]);
    assert.throws(() => from(PAIR).orderBy((x) => x.a, { empty: 'bogus' }).toArray(),
      (/** @type {any} */ e) => e.code === 'JQ0003');
  });
});

describe('createPushQueue() options', () => {
  it('null, a non-object and a misspelt member are refused — null used to be a raw TypeError', () => {
    const notObject = refused(/^JL0005: createPushQueue\(\) takes a plain options object$/);
    assert.throws(() => createPushQueue(null), notObject);
    assert.throws(() => createPushQueue(/** @type {any} */ ('x')), notObject);
    assert.throws(() => createPushQueue(/** @type {any} */ ({ highWatermark: 5 })),
      refused(/^JL0005: createPushQueue\(\) does not take 'highWatermark' — did you mean 'highWaterMark'\?$/));
  });

  it('the mark itself is read and checked as before', () => {
    assert.throws(() => createPushQueue({ highWaterMark: 0 }),
      (/** @type {any} */ e) => e.message === 'JL0005: highWaterMark must be a positive integer');
    const queue = createPushQueue({ highWaterMark: 1 });
    assert.equal(queue.feed(1), true);
    assert.equal(queue.feed(2), false);
    assert.equal(createPushQueue().feed(1), true);
    assert.equal(createPushQueue(undefined).feed(1), true);
  });
});

describe('mapAsync() options', () => {
  const echo = async (/** @type {any} */ x) => x;

  it('ordered is a boolean — the string \'false\' used to read as ordered', () => {
    const notBoolean = refused(/^JL0005: mapAsync ordered must be a boolean, got "false"$/);
    assert.throws(() => fromAsync([3, 1, 2]).mapAsync(echo, { concurrency: 2, ordered: 'false' }), notBoolean);
    assert.throws(() => from([3, 1, 2]).mapAsync(echo, { concurrency: 2, ordered: 'false' }), notBoolean);
  });

  it('null is not a boolean either — it used to read as ordered — and the message names what came', async () => {
    const got = (/** @type {string} */ what) => refused(new RegExp(`^JL0005: mapAsync ordered must be a boolean, got ${what}$`));
    assert.throws(() => fromAsync([1]).mapAsync(echo, { concurrency: 2, ordered: /** @type {any} */ (null) }), got('null'));
    assert.throws(() => from([1]).mapAsync(echo, { concurrency: 2, ordered: /** @type {any} */ (null) }), got('null'));
    assert.throws(() => fromAsync([1]).mapAsync(echo, { concurrency: 2, ordered: /** @type {any} */ ({}) }), got('an object'));
    assert.throws(() => fromAsync([1]).mapAsync(echo, { concurrency: 2, ordered: /** @type {any} */ (1) }), got('a number'));
    // undefined is the documented default, ordered: source order whatever finishes first
    const late = async (/** @type {number} */ x) => new Promise((resolve) => setTimeout(() => resolve(x), x));
    assert.deepEqual(await fromAsync([6, 1, 3]).mapAsync(late, { concurrency: 3, ordered: undefined }).toArray(), [6, 1, 3]);
  });

  it('a misspelt member is refused, naming the nearest', () => {
    const misspelt = refused(/^JL0005: mapAsync\(\) does not take 'ordred' — did you mean 'ordered'\?$/);
    assert.throws(() => fromAsync([1]).mapAsync(echo, { concurrency: 2, ordred: false }), misspelt);
    assert.throws(() => from([1]).mapAsync(echo, { concurrency: 2, ordred: false }), misspelt);
  });

  it('the first refusal and the documented members are unchanged', async () => {
    assert.throws(() => fromAsync([1]).mapAsync(echo, /** @type {any} */ ({})),
      (/** @type {any} */ e) => e.message === 'JL0005: mapAsync requires { concurrency: <positive integer> } — '
        + 'an unbounded default is a denial of service waiting for a slow downstream');
    assert.throws(() => fromAsync([1]).mapAsync(echo, /** @type {any} */ (null)),
      (/** @type {any} */ e) => e.code === 'JL0005' && /mapAsync requires/.test(e.message));
    const unordered = await fromAsync([3, 1, 2]).mapAsync(echo, { concurrency: 3, ordered: false }).toArray();
    assert.deepEqual([...unordered].sort(), [1, 2, 3]);
    assert.deepEqual(await fromAsync([3, 1, 2]).mapAsync(echo, { concurrency: 3, ordered: true, mode: 'parallel' }).toArray(), [3, 1, 2]);
  });
});

describe('federate() options', () => {
  const provider = () => ({ execute: () => [] });
  const budget = { maxRows: 10, maxBytes: 1000 };

  it('a misspelt budget, strategy or source member is refused — it used to fall back to the default', () => {
    assert.throws(() => federate({ sources: { a: provider(), b: provider() }, ...budget, maxTotalRow: 1 }),
      refused(/^JL0005: federate\(\) does not take 'maxTotalRow' — did you mean 'maxTotalRows'\?$/));
    assert.throws(() => federate({ sources: { a: provider(), b: provider() }, ...budget, stratgy: 'hash' }),
      refused(/does not take 'stratgy' — did you mean 'strategy'\?/));
    assert.throws(() => federate({ sources: { a: { provider: provider(), estimateRows: 5 }, b: provider() }, ...budget }),
      refused(/^JL0005: federate\(\)'s source 'a' does not take 'estimateRows' — did you mean 'estimatedRows'\?$/));
    assert.throws(() => federate(/** @type {any} */ ([])), refused(/federate\(\) takes its sources as an object/));
  });

  it('the documented spec still builds', () => {
    const fed = federate({
      sources: { a: { provider: provider(), estimatedRows: 3 }, b: provider() },
      ...budget, maxTotalRows: 20, maxTotalBytes: 2000, strategy: 'hash',
    });
    assert.deepEqual(fed.names, ['a', 'b']);
  });
});
