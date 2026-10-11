//@ts-check
/**
 * @file Values a caller can hand to the chain and the pens that used to
 * answer wrongly, quietly: a Symbol or a null-prototype object that raised
 * the engine's own `TypeError` while a refusal was being worded, a window
 * count whose message read a string as a number, a name looked up on a
 * constant table's prototype, an input member called `__proto__` dropped
 * from an HTTP binding, structurally equal parameter bindings refused as
 * different, and index expressions holding `NaN` or `-0`.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { from, fromAsync, federate } from '@jarenjs/linq';
import * as s from '@jarenjs/linq/schema';
import * as m from '@jarenjs/linq/model';
import * as c from '@jarenjs/linq/charts';
import * as msg from '@jarenjs/linq/messages';
import { http } from '@jarenjs/linq/contract';

/** The refusal a call raises, or a failed assertion. @param {() => any} fn */
function refusal(fn) {
  try { fn(); }
  catch (err) { return /** @type {any} */ (err); }
  return assert.fail('expected a refusal');
}

const hostile = { symbol: Symbol('s'), 'a null-prototype object': Object.create(null) };

describe('a window count or index is refused by name, whatever it is', () => {
  it('a string is quoted, so it is not read as the number it spells', () => {
    assert.strictEqual(refusal(() => from([1]).take(/** @type {any} */ ('2'))).message,
      'JL0005: take takes a non-negative integer, got "2"');
    assert.strictEqual(refusal(() => from([1]).elementAt(/** @type {any} */ ('0'))).message,
      'JL0005: elementAt takes a non-negative integer, got "0"');
  });

  for (const [name, value] of Object.entries(hostile)) {
    it(`${name} is JL0005, not the engine's TypeError`, () => {
      for (const call of [
        () => from([1]).take(value), () => from([1]).skip(value), () => from([1]).elementAt(value),
        () => fromAsync([1]).take(value), () => fromAsync([1]).skip(value),
      ]) {
        const err = refusal(call);
        assert.strictEqual(err.code, 'JL0005');
      }
    });
  }

  it('a bigint keeps its suffix, so 2n is not read as 2', () => {
    assert.strictEqual(refusal(() => from([1]).take(/** @type {any} */ (2n))).message,
      'JL0005: take takes a non-negative integer, got 2n');
  });

  it('the figures the documentation lists read as they always did', () => {
    assert.strictEqual(refusal(() => from([1]).skip(-1)).message, 'JL0005: skip takes a non-negative integer, got -1');
    assert.strictEqual(refusal(() => from([1]).take(1.5)).message, 'JL0005: take takes a non-negative integer, got 1.5');
    assert.strictEqual(refusal(() => from([1]).take(-0 - 1)).message, 'JL0005: take takes a non-negative integer, got -1');
    assert.strictEqual(refusal(() => from([1]).take(Number.NaN)).message, 'JL0005: take takes a non-negative integer, got NaN');
    assert.strictEqual(refusal(() => from([1]).take(null)).message, 'JL0005: take takes a non-negative integer, got null');
    assert.strictEqual(refusal(() => from([1]).take(undefined)).message, 'JL0005: take takes a non-negative integer, got undefined');
  });
});

describe('a mode, a strategy, a draft and a message name are refused by name', () => {
  for (const [name, value] of Object.entries(hostile)) {
    it(`${name}: mapAsync mode, federate strategy, document draft, catalog and message id`, () => {
      assert.strictEqual(refusal(() => fromAsync([1]).mapAsync(async (x) => x, { concurrency: 1, mode: value })).code, 'JL0005');
      const provider = { execute: () => [] };
      assert.strictEqual(refusal(() => federate({ sources: { a: provider, b: provider }, maxRows: 1, maxBytes: 1, strategy: value })).code, 'JL0005');
      assert.strictEqual(refusal(() => s.document(s.string(), { draft: value })).code, 'JL0102');
      assert.strictEqual(refusal(() => msg.catalog(value)).code, 'JL0101');
      assert.strictEqual(refusal(() => msg.message(value)).code, 'JL0101');
    });
  }

  it('a string name keeps the quoted spelling the documentation shows', () => {
    assert.strictEqual(refusal(() => fromAsync([1]).mapAsync(async (x) => x, { concurrency: 1, mode: 'x' })).message,
      "JL0005: mapAsync mode must be one of parallel|concat|switch|exhaust, got 'x'");
    assert.strictEqual(refusal(() => s.document(s.string(), { draft: /** @type {any} */ ('draft-07') })).message,
      "JL0102: document() writes the 2020-12 vocabulary only; 'draft-07' is not a draft it can declare");
  });
});

describe('document() reads its draft from its own table, and its options as a closed set', () => {
  for (const draft of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
    it(`draft '${draft}' is JL0102, never a $schema holding a function`, () => {
      const err = refusal(() => s.document(s.string(), { draft: /** @type {any} */ (draft) }));
      assert.strictEqual(err.code, 'JL0102');
    });
  }

  it('a misspelt option is JL0101, and null options read as none', () => {
    assert.strictEqual(refusal(() => s.document(s.string(), /** @type {any} */ ({ drafts: '2020-12' }))).code, 'JL0101');
    assert.deepStrictEqual(s.document(s.string(), /** @type {any} */ (null)), { type: 'string' });
  });

  it('the declared draft still comes first', () => {
    assert.deepStrictEqual(Object.keys(s.document(s.string(), { draft: '2020-12' })), ['$schema', 'type']);
  });
});

describe('keyword() and annotate() take a name that is a string', () => {
  for (const [name, key] of [['a Symbol', Symbol('k')], ['a number', 5], ['undefined', undefined], ['a null-prototype object', Object.create(null)]]) {
    it(`${name} is JL0101, not a dropped or renamed member`, () => {
      for (const make of [() => s.string(), () => s.never().nullable(), () => s.never()]) {
        assert.strictEqual(refusal(() => make().keyword(key, 1)).code, 'JL0101');
        assert.strictEqual(refusal(() => make().annotate(key, 1)).code, 'JL0101');
      }
    });
  }

  it('a string name still writes its member', () => {
    assert.deepStrictEqual(s.string().keyword('x-a', 1).schema, { type: 'string', 'x-a': 1 });
    assert.deepStrictEqual(s.string().annotate('x-b', 2).schema, { type: 'string', 'x-b': 2 });
  });
});

describe('a chart whose kind is a name on Object.prototype is an unknown kind', () => {
  for (const type of ['toString', 'constructor', '__proto__']) {
    it(`from({ type: '${type}' }).title() is JL0101`, () => {
      const err = refusal(() => c.from({ type }).title('x'));
      assert.strictEqual(err.code, 'JL0101');
      assert.match(err.message, /unknown chart kind/);
    });
  }
});

describe('an input member named __proto__ stays in an HTTP binding', () => {
  it('http({ in }) keeps __proto__ as an own member, in order', () => {
    const placed = JSON.parse('{"__proto__":"query","a":"body"}');
    const binding = http({ method: 'POST', path: '/x', in: placed });
    assert.deepStrictEqual(Object.keys(binding.in), ['__proto__', 'a']);
    assert.strictEqual(Object.getPrototypeOf(binding.in), Object.prototype);
    assert.strictEqual(JSON.stringify(binding.in), '{"__proto__":"query","a":"body"}');
  });
});

describe('parameter bindings that spell one value are one binding', () => {
  const rows = [{ id: 1, k: 1 }, { id: 2, k: 2 }, { id: 3, k: 3 }];
  const sides = (value, other = value) => [
    from(rows).params({ ids: structuredClone(value) }).where((r, p) => r.id.in(p.ids)),
    from(rows).params({ ids: structuredClone(other) }).where((r, p) => r.id.in(p.ids)),
  ];

  it('two arrays of the same JSON join, concat and group-join', () => {
    const [a, b] = sides([1, 2]);
    assert.deepStrictEqual(a.join(b, (x) => x.k, (y) => y.k, (x) => x.id).toArray(), [1, 2]);
    assert.deepStrictEqual(a.concat(b).select((x) => x.id).toArray(), [1, 2, 1, 2]);
    assert.strictEqual(a.groupJoin(b, (x) => x.k, (y) => y.k, (x, g) => ({ id: x.id, n: g.count() })).toArray().length, 2);
  });

  it('on the async surface, a provider join over equal object bindings is not refused as different', async () => {
    const provider = { root: '$.t[*]', scope: Object.freeze({}), execute: () => [] };
    const a = fromAsync(provider).params({ o: { n: 1 } }).where((r, p) => r.id.gt(p.o.n));
    const b = fromAsync(provider).params({ o: { n: 1 } }).where((r, p) => r.id.gt(p.o.n));
    assert.doesNotThrow(() => a.join(b, (x) => x.k, (y) => y.k, (x) => x.id));
  });

  it('different values are still refused, member order included', () => {
    const [a, b] = sides([1, 2], [1, 3]);
    assert.strictEqual(refusal(() => a.join(b, (x) => x.k, (y) => y.k, (x) => x.id)).code, 'JL0004');
    const left = from(rows).params({ o: { a: 1, b: 2 } });
    const right = from(rows).params({ o: { b: 2, a: 1 } });
    assert.strictEqual(refusal(() => left.concat(right)).code, 'JL0004');
  });
});

describe('federate() words a bad estimate as what it is', () => {
  it('a negative integer is not called merely non-integer, and a fraction still is', () => {
    const provider = { execute: () => [] };
    for (const estimatedRows of [-1, 1.5]) {
      const err = refusal(() => federate({
        sources: { a: { provider, estimatedRows }, b: provider }, maxRows: 1, maxBytes: 1,
      }));
      assert.strictEqual(err.message,
        "JL0005: federate()'s source 'a' declares a negative or non-integer estimatedRows");
    }
  });
});

describe('federate() derives its default totals without refusing a budget the caller wrote', () => {
  const provider = { execute: () => [] };

  it('the largest safe budget is accepted, and the default total is held to a safe integer', () => {
    for (const side of [Number.MAX_SAFE_INTEGER, 2 ** 52, 2 ** 52 - 1]) {
      const federation = federate({ sources: { a: provider, b: provider }, maxRows: side, maxBytes: side });
      const { combinedBudget } = federation.source('a').explain({ $for: { a: '$.a[*]', b: '$.b[*]' },
        $where: { $eq: ['$a.k', '$b.k'] }, $return: '$a' });
      assert.deepStrictEqual(combinedBudget, {
        maxTotalRows: Math.min(side * 2, Number.MAX_SAFE_INTEGER),
        maxTotalBytes: Math.min(side * 2, Number.MAX_SAFE_INTEGER),
      });
    }
  });

  it('a total the caller writes and gets wrong is still named', () => {
    const err = refusal(() => federate({ sources: { a: provider, b: provider }, maxRows: 1, maxBytes: 1,
      maxTotalRows: Number.MAX_SAFE_INTEGER + 1 }));
    assert.match(err.message, /positive integer maxTotalRows/);
  });
});

describe('an index expression holds JSON numbers only', () => {
  for (const [name, value] of [['NaN', Number.NaN], ['-0', -0], ['Infinity', Number.POSITIVE_INFINITY]]) {
    it(`${name} as a scalar, as .value and as an argument is JL0101`, () => {
      assert.strictEqual(refusal(() => m.expressionIndex(value)).code, 'JL0101');
      assert.strictEqual(refusal(() => m.expressionIndex({ value })).code, 'JL0101');
      assert.strictEqual(refusal(() => m.expressionIndex({ call: 'f', args: [value] })).code, 'JL0101');
    });
  }

  it('a finite number is still a value', () => {
    assert.deepStrictEqual(m.expressionIndex(3).expression, { value: 3 });
  });
});
