//@ts-check
/**
 * @file The Sequence contract (LINQ-FORMAT.md §§5–8): deferral,
 * immutability, re-enumeration, the C# terminal matrix, parameters as
 * externals, and the provider seam — a double proves the document
 * arrives WHOLE and nothing is enumerated locally (D2).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { from, fromDocument, LinqRuntimeError } from '@jarenjs/linq';

describe('deferred execution and re-enumeration (§5)', () => {
  it('nothing runs until a terminal; each enumeration re-reads the source', () => {
    let reads = 0;
    const source = {
      * [Symbol.iterator]() {
        reads++;
        yield* [1, 2, 3];
      },
    };
    const q = from(source).where((n) => n.gt(1));
    assert.strictEqual(reads, 0, 'building the chain read nothing');
    assert.deepStrictEqual(q.toArray(), [2, 3]);
    assert.deepStrictEqual(q.toArray(), [2, 3]);
    assert.strictEqual(reads, 2, 'one read per enumeration');
  });

  it('a mutation between enumerations is observed (the worked example)', () => {
    const rows = [1, 2, 3];
    const q = from(rows).where((n) => n.gt(1));
    assert.deepStrictEqual(q.toArray(), [2, 3]);
    rows.push(4);
    assert.deepStrictEqual(q.toArray(), [2, 3, 4]);
  });

  it('sequences are immutable: branches never see each other', () => {
    const base = from([1, 2, 3, 4]);
    const evens = base.where((n) => n.mod(2).eq(0));
    const odds = base.where((n) => n.mod(2).eq(1));
    assert.deepStrictEqual(evens.toArray(), [2, 4]);
    assert.deepStrictEqual(odds.toArray(), [1, 3]);
    assert.deepStrictEqual(base.toArray(), [1, 2, 3, 4]);
  });

  it('for…of iterates the sequence', () => {
    const seen = [];
    for (const n of from([1, 2]).select((n) => n.add(10))) seen.push(n);
    assert.deepStrictEqual(seen, [11, 12]);
  });
});

describe('the C# terminal matrix (§6)', () => {
  const empty = from([]);
  const one = from([7]);
  const two = from([7, 8]);

  it('first / firstOrDefault', () => {
    assert.strictEqual(two.first(), 7);
    assert.throws(() => empty.first(), (e) => e.code === 'JL2001');
    assert.strictEqual(empty.firstOrDefault('d'), 'd');
    assert.strictEqual(two.firstOrDefault('d'), 7);
  });

  it('single / singleOrDefault', () => {
    assert.strictEqual(one.single(), 7);
    assert.throws(() => empty.single(), (e) => e.code === 'JL2001');
    assert.throws(() => two.single(), (e) => e.code === 'JL2002');
    assert.strictEqual(empty.singleOrDefault('d'), 'd');
    assert.throws(() => two.singleOrDefault('d'), (e) => e.code === 'JL2002');
  });

  it('last / lastOrDefault', () => {
    assert.strictEqual(two.last(), 8);
    assert.throws(() => empty.last(), (e) => e instanceof LinqRuntimeError && e.code === 'JL2001');
    assert.strictEqual(empty.lastOrDefault('d'), 'd');
  });

  it('elementAt / elementAtOrDefault', () => {
    assert.strictEqual(two.elementAt(1), 8);
    assert.throws(() => two.elementAt(2), (e) => e.code === 'JL2003');
    assert.strictEqual(two.elementAtOrDefault(9, 'd'), 'd');
    assert.throws(() => two.elementAt(-1), (e) => e.code === 'JL0005');
  });

  it('an array-valued element extracts unambiguously', () => {
    const nested = from([[1, 2]]);
    assert.deepStrictEqual(nested.first(), [1, 2]);
    assert.deepStrictEqual(nested.toArray(), [[1, 2]]);
    assert.strictEqual(nested.count(), 1);
  });

  it('average/min/max throw JL2001 on empty; sum and count are 0', () => {
    assert.throws(() => empty.average(), (e) => e.code === 'JL2001');
    assert.throws(() => empty.min(), (e) => e.code === 'JL2001');
    assert.throws(() => empty.max(), (e) => e.code === 'JL2001');
    assert.strictEqual(empty.sum(), 0);
    assert.strictEqual(empty.count(), 0);
  });
});

describe('parameters (§7)', () => {
  it('params declare and bind externals; the document carries the name', () => {
    const rows = [{ tenant: 'a' }, { tenant: 'b' }];
    const q = from(rows).params({ tenantId: 'a' })
      .where((r, p) => r.tenant.eq(p.tenantId));
    assert.deepStrictEqual(q.toDocument().$where, { $eq: ['$it.tenant', '$tenantId'] });
    assert.deepStrictEqual(q.toArray(), [{ tenant: 'a' }]);
    // rebinding through a new sequence, same document
    assert.deepStrictEqual(q.params({ tenantId: 'b' }).toArray(), [{ tenant: 'b' }]);
  });
});

describe('the provider seam (§8, D2)', () => {
  it('a provider receives the document WHOLE and nothing is enumerated locally', () => {
    const calls = [];
    const provider = {
      execute(document, options) {
        calls.push({ document, options });
        return [{ id: 1 }, { id: 2 }]; // engine-shaped: several items
      },
      // a hostile iterator proves the in-memory path is never entered
      [Symbol.iterator]() {
        throw new Error('the provider must not be enumerated');
      },
    };
    const q = from(provider).params({ min: 1 }).where((r, p) => r.id.ge(p.min));
    const rows = q.toArray();
    assert.deepStrictEqual(rows, [{ id: 1 }, { id: 2 }]);
    assert.strictEqual(calls.length, 1);
    assert.deepStrictEqual(calls[0].document, [{
      $for: { it: '$[*]' },
      $where: { $ge: ['$it.id', '$min'] },
      $return: '$it',
    }]);
    assert.deepStrictEqual(calls[0].options, { externals: { min: 1 } });
  });

  it('terminal wrappers reach the provider too (count)', () => {
    const docs = [];
    const provider = { execute(document) { docs.push(document); return 2; } };
    assert.strictEqual(from(provider).count(), 2);
    assert.deepStrictEqual(docs[0], { $count: '$[*]' });
  });
});

describe('fromDocument', () => {
  const DATA = [{ n: 1 }, { n: 5 }];

  it('attaches a hand-written document; operators chain over its result', () => {
    const stored = { $for: { it: '$[*]' }, $where: { $gt: ['$it.n', 2] }, $return: '$it.n' };
    const q = fromDocument(DATA, stored);
    assert.deepStrictEqual(q.toArray(), [5]);
    const chained = q.select((n) => n.add(1));
    assert.deepStrictEqual(chained.toArray(), [6]);
    assert.deepStrictEqual(chained.toDocument(), {
      $for: { it: [stored] },
      $return: { $add: ['$it', 1] },
    });
  });

  it('unwraps a version envelope', () => {
    const q = fromDocument(DATA, { $query: '0.1', $expr: '$[*].n' });
    assert.deepStrictEqual(q.toArray(), [1, 5]);
    assert.strictEqual(q.toDocument(), '$[*].n');
  });
});
