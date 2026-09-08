//@ts-check
/**
 * @file The semantic guarantees a query layer has to keep, each pinned by
 * the case that used to break it.
 *
 * These are not edge cases in the "unlikely input" sense. They are
 * ordinary queries — filter by null, concatenate two sequences, reverse a
 * stream of arrays, sort in Dutch — that returned the wrong rows, or the
 * source unfiltered, with no error anywhere. A query layer that answers
 * plausibly and wrongly is worse than one that refuses.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  from, fromAsync, fromDocument, LinqBuildError, LinqRuntimeError,
} from '@jarenjs/linq';

describe('a literal null is a value, not an absent clause', () => {
  it('where(() => null) filters everything out', () => {
    // `null` is not true, so nothing satisfies the predicate. Emitting the
    // document WITHOUT the $where returned the whole unfiltered source.
    assert.deepStrictEqual(from([1, 2]).where(() => null).toArray(), []);
    const doc = from([1, 2]).where(() => null).toDocument();
    assert.ok('$where' in doc, 'the clause must be in the document');
    assert.strictEqual(doc.$where, null);
  });

  it('select(() => null) projects nulls', () => {
    assert.deepStrictEqual(from([1, 2]).select(() => null).toArray(), [null, null]);
  });

  it('groupBy(() => null) is one null-keyed group', () => {
    assert.deepStrictEqual(from([1, 2]).groupBy(() => null).toArray(),
      [{ key: null, items: [1, 2] }]);
  });

  it('a null-seeded aggregate still folds', () => {
    assert.deepStrictEqual(
      from([1, 2]).aggregate(null, (_acc, it) => it).toArray(), [2]);
    assert.ok('$fold' in from([1, 2]).aggregate(null, (_a, it) => it).toDocument());
  });

  it('and a null clause combines with a real one', () => {
    assert.deepStrictEqual(
      from([1, 2]).where((it) => it.gt(0)).where(() => null).toArray(), []);
  });
});

describe('composition reads the source it was given', () => {
  it('concat across two sources refuses instead of reading the wrong one', () => {
    // a query document reads ONE input, so the other sequence contributes
    // its EXPRESSION — evaluated against this source. `[1].concat([2])`
    // answered `[1,1]`.
    assert.throws(() => from([1]).concat(from([2])),
      (error) => error instanceof LinqBuildError && error.code === 'JL0005');
  });

  it('same-source concat still composes, and a constant array still joins', () => {
    const source = [1, 2];
    const q = from(source);
    assert.deepStrictEqual(q.where((it) => it.eq(1)).concat(q.where((it) => it.eq(2))).toArray(),
      [1, 2]);
    assert.deepStrictEqual(from([1]).concat([9]).toArray(), [1, 9]);
  });

  it('join keeps its own same-source rule', () => {
    assert.throws(() => from([1]).join(from([2]), (a) => a, (b) => b, (a) => a),
      (error) => /** @type {any} */ (error).code === 'JL0005');
  });
});

describe('toDocument() is a snapshot, not a window', () => {
  it('mutating the returned document cannot change later execution', () => {
    const q = from([{ x: 1 }, { x: 2 }]).where((x) => x.x.eq(1));
    assert.deepStrictEqual(q.toArray(), [{ x: 1 }]);
    const doc = q.toDocument();
    doc.$where.$eq[1] = 2;
    assert.deepStrictEqual(q.toArray(), [{ x: 1 }],
      'the sequence is documented as immutable, so it must be');
  });

  it('two calls hand out independent trees', () => {
    const q = from([{ x: 1 }]).where((x) => x.x.eq(1));
    const a = q.toDocument();
    const b = q.toDocument();
    assert.deepStrictEqual(a, b);
    a.$where.$eq[1] = 99;
    assert.notDeepStrictEqual(a, b);
  });
});

describe('captured constants pass a real JSON boundary', () => {
  const refused = (build) => assert.throws(build,
    (error) => error instanceof LinqBuildError && error.code === 'JL0005');

  it('a host object is refused, not embedded as {}', () => {
    // `Object.keys` reports nothing for these, so "is it plain JSON?"
    // answered yes vacuously and the query compared against `{}`
    refused(() => from([1]).select(() => new Date(0)).toDocument());
    refused(() => from([1]).select(() => new Map([[1, 2]])).toDocument());
    refused(() => from([1]).select(() => /x/).toDocument());
    refused(() => from([1]).select(() => new Set([1])).toDocument());
    refused(() => from([1]).select(() => new (class Thing { constructor() { this.a = 1; } })())
      .toDocument());
  });

  it('a non-finite number is refused, not folded into null', () => {
    refused(() => from([1]).select(() => NaN).toDocument());
    refused(() => from([1]).select(() => Infinity).toDocument());
    refused(() => from([1]).select(() => -Infinity).toDocument());
  });

  it('-0 is refused, because it shares JSON text with 0 and divides apart', () => {
    refused(() => from([1]).select((it) => it.div(-0)).toDocument());
    // 0 itself is ordinary data
    assert.deepStrictEqual(from([1]).select((it) => it.div(0)).toArray(), [Infinity]);
  });

  it('and ordinary plain data still embeds verbatim', () => {
    assert.deepStrictEqual(
      from([{ a: 1 }]).where((it) => it.a.eq(1)).toArray(), [{ a: 1 }]);
    assert.deepStrictEqual(
      from([1]).select(() => ({ nested: [1, { deep: true }], n: null })).toArray(),
      [{ nested: [1, { deep: true }], n: null }]);
  });

  it('an own __proto__ member stays a member of the emitted document', () => {
    // an object-literal `__proto__:` key is a prototype SETTER, so the
    // member has to be defined to exist as data at all
    const source = Object.defineProperty({ keep: 1 }, '__proto__',
      { value: 'data', enumerable: true, writable: true, configurable: true });
    const doc = from([1]).select(() => source).toDocument();
    const projected = doc.$return.$const ?? doc.$return;
    assert.ok(Object.hasOwn(projected, '__proto__'),
      'plain assignment would have set the builder\'s prototype and dropped it');
    assert.strictEqual(
      Object.getOwnPropertyDescriptor(projected, '__proto__')?.value, 'data');
    assert.strictEqual(projected.keep, 1);
  });
});

describe('an asynchronous provider cannot masquerade as a value', () => {
  it('every synchronous terminal refuses a promise-answering provider', () => {
    const provider = { execute: async () => [[1, 2, 3]] };
    for (const run of [
      () => from(provider).toArray(),
      () => from(provider).count(),
      () => from(provider).first(),
      () => from(provider).firstOrDefault(),
      () => from(provider).any(),
    ]) {
      assert.throws(run,
        (error) => error instanceof LinqRuntimeError && error.code === 'JL2004',
        'a promise under a value type is a wrong answer, not a slow one');
    }
  });

  it('a synchronous provider still works', () => {
    const provider = { execute: () => [1, 2, 3] };
    assert.deepStrictEqual(from(provider).toArray(), [1, 2, 3]);
  });

  it('the document is still emittable, which is the async escape hatch', async () => {
    const provider = { execute: async (doc) => [[doc.length]] };
    const q = from(provider).where((it) => it.eq(1));
    const doc = q.toDocument();
    assert.ok(doc.$where !== undefined);
    assert.deepStrictEqual(await provider.execute([doc]), [[1]]);
  });
});

describe('an async barrier round-trips an array-valued item', () => {
  it('reverse keeps one array as one item', async () => {
    assert.deepStrictEqual(await fromAsync([[1, 2]]).reverse().toArray(), [[1, 2]]);
    assert.deepStrictEqual(await fromAsync([[1, 2], [3]]).reverse().toArray(), [[3], [1, 2]]);
  });

  it('and every barrier agrees with the SYNC surface, item for item', async () => {
    // Parity is the real criterion, not a hand-guessed shape: the async
    // surface emits the same documents, so it must answer the same rows.
    // A FLWOR `$return` legitimately flattens a returned array (that is
    // what makes selectMany work); `$reverse` legitimately does not. Both
    // must be true on BOTH sides, which is what a barrier reading
    // `[[1,2]]` back as `[1,2]` broke.
    const cases = [
      { name: 'orderBy over an array item', data: [[1, 2]], run: (q) => q.orderBy(() => 1) },
      { name: 'reverse over an array item', data: [[1, 2]], run: (q) => q.reverse() },
      { name: 'reverse over two array items', data: [[1, 2], [3]], run: (q) => q.reverse() },
      { name: 'reverse then array projection', data: [1], run: (q) => q.reverse().select((it) => [it, it]) },
      { name: 'reverse then member projection', data: [{ v: [1, 2] }], run: (q) => q.reverse().select((it) => it.v) },
      { name: 'distinct over array items', data: [[1, 2], [1, 2]], run: (q) => q.distinct() },
      { name: 'groupBy over array items', data: [[1, 2]], run: (q) => q.groupBy(() => 1) },
    ];
    for (const { name, data, run } of cases) {
      assert.deepStrictEqual(
        await run(fromAsync(data)).toArray(),
        run(from(data)).toArray(),
        name);
    }
  });

  it('an empty stream through a barrier is empty, not undefined', async () => {
    assert.deepStrictEqual(await fromAsync([]).reverse().toArray(), []);
  });
});

describe('async equality is the same relation as sync equality', () => {
  it('distinct keeps apart what the sync engine keeps apart', async () => {
    assert.strictEqual((await fromAsync([Infinity, null]).distinct().toArray()).length, 2);
    assert.strictEqual((await fromAsync([NaN, '\u0000NaN\u0000']).distinct().toArray()).length, 2);
    assert.strictEqual((await fromAsync([-0, 0]).distinct().toArray()).length, 2);
    assert.strictEqual((await fromAsync([1, '1']).distinct().toArray()).length, 2);
  });

  it('and still folds genuinely equal items', async () => {
    assert.deepStrictEqual(await fromAsync([1, 1, 2]).distinct().toArray(), [1, 2]);
    assert.deepStrictEqual(
      await fromAsync([{ a: 1, b: 2 }, { b: 2, a: 1 }]).distinct().toArray(),
      [{ a: 1, b: 2 }], 'property order is not identity');
  });

  it('a value it cannot key counts as distinct, never as a shared bucket', async () => {
    const items = [new Date(0), new Date(0)];
    assert.strictEqual((await fromAsync(items).distinct().toArray()).length, 2,
      'dropping a row distinct() was asked to keep is the unsafe direction');
  });
});

describe('a collation that is expressible is executable', () => {
  // Dutch ordering was emittable and then failed to compile, because the
  // in-memory path had no way to receive the registry the document names.
  const collations = {
    nl: (a, b) => a.localeCompare(b, 'nl'),
  };

  it('orderBy with a collation runs in memory when the registry is supplied', () => {
    const names = ['ijsbeer', 'appel', 'zebra'];
    const sorted = from(names, { collations }).orderBy((it) => it, { collation: 'nl' }).toArray();
    assert.deepStrictEqual(sorted, [...names].sort(collations.nl));
  });

  it('without the registry it is still an honest refusal, not a wrong order', () => {
    assert.throws(() => from(['b', 'a']).orderBy((it) => it, { collation: 'nl' }).toArray(),
      (error) => /** @type {any} */ (error).code === 'JQ0010');
  });

  it('a host function registry reaches the engine too', () => {
    const functions = { double: (n) => n * 2 };
    const doc = { $for: { it: '$[*]' }, $return: { $call: ['double', '$it'] } };
    assert.deepStrictEqual(fromDocument([1, 2], doc, { functions }).toArray(), [2, 4]);
  });

  it('limits bound a saved document', () => {
    const doc = { $for: { it: '$[*]' }, $return: '$it' };
    assert.deepStrictEqual(
      fromDocument([1, 2], doc, { limits: { sequenceItems: 10 } }).toArray(), [1, 2]);
    assert.throws(
      () => fromDocument([1, 2, 3], doc, { limits: { sequenceItems: 2 } }).toArray(),
      (error) => /** @type {any} */ (error).code === 'JQ2009');
  });

  it('the compiled-document cache is partitioned by the REGISTRIES', () => {
    // compiling once WITH a collation must not answer for a caller who
    // passed none: that would be a wrong order, not a missing error
    const withNl = from(['b', 'a'], { collations }).orderBy((it) => it, { collation: 'nl' });
    assert.deepStrictEqual(withNl.toArray(), ['a', 'b']);
    assert.throws(() => from(['b', 'a']).orderBy((it) => it, { collation: 'nl' }).toArray(),
      (error) => /** @type {any} */ (error).code === 'JQ0010');
    // and the same registry still shares its compiled programs
    assert.deepStrictEqual(
      from(['b', 'a'], { collations }).orderBy((it) => it, { collation: 'nl' }).toArray(),
      ['a', 'b']);
  });
});

describe('a concurrent task failure keeps its own identity', () => {
  /** Drain an async sequence, reporting the rejection VALUE as-is. */
  const settle = async (seq) => {
    try {
      return { value: await seq.toArray() };
    }
    catch (error) {
      return { error };
    }
  };

  it('an unordered mapAsync rejection is the value the handler threw', async () => {
    // task identity used to be stamped ONTO the rejection with
    // Object.assign, so the caller received a mutated value — or, for a
    // frozen error, a TypeError from the stamping instead
    const frozen = Object.freeze(new Error('frozen boom'));
    const outcome = await settle(fromAsync([1]).mapAsync(
      () => Promise.reject(frozen), { concurrency: 2, ordered: false }));
    assert.strictEqual(outcome.error, frozen, 'the same value, by identity');
    assert.strictEqual(outcome.error.message, 'frozen boom');
    assert.deepStrictEqual(Object.keys(frozen), [], 'and unmodified');
  });

  it('a thrown primitive is not boxed on the way out', async () => {
    const outcome = await settle(fromAsync([1]).mapAsync(
      () => Promise.reject('a string'), { concurrency: 2, ordered: false }));
    assert.strictEqual(outcome.error, 'a string');
    assert.strictEqual(typeof outcome.error, 'string', 'not a String object');
  });

  it('an extensible error gains no private property', async () => {
    const error = new Error('plain');
    const originalKeys = Reflect.ownKeys(error);
    const outcome = await settle(fromAsync([1, 2]).mapAsync(
      (n) => (n === 1 ? Promise.reject(error) : 2), { concurrency: 2, ordered: false }));
    assert.strictEqual(outcome.error, error);
    assert.deepStrictEqual(Reflect.ownKeys(error), originalKeys);
  });

  it('a failing source close does not replace the task failure', async () => {
    const taskError = new Error('task boom');
    const source = {
      [Symbol.asyncIterator]() {
        let n = 0;
        return {
          next: async () => (n++ === 0 ? { value: 1, done: false } : { done: true }),
          return: async () => { throw new Error('close boom'); },
        };
      },
    };
    const outcome = await settle(fromAsync(source).mapAsync(
      () => Promise.reject(taskError), { concurrency: 2, ordered: false }));
    assert.ok(outcome.error instanceof AggregateError,
      'both failures travel, neither is dropped');
    assert.strictEqual(outcome.error.errors[0], taskError, 'the task failure is first');
    assert.strictEqual(outcome.error.errors[1].message, 'close boom');
  });

  it('a synchronously throwing source close preserves both failures', async () => {
    const taskError = new Error('task boom');
    const closeError = new Error('close boom');
    const source = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({ value: 1, done: false }),
          return: () => { throw closeError; },
        };
      },
    };
    const outcome = await settle(fromAsync(source).mapAsync(
      () => { throw taskError; }, { concurrency: 1, mode: 'concat' }));
    assert.ok(outcome.error instanceof AggregateError);
    assert.deepStrictEqual(outcome.error.errors, [taskError, closeError]);
  });
});
