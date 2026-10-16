//@ts-check
/**
 * @file A value that shares subtrees (`d = [d, d]`) costs its distinct
 * subtrees, not the subtrees it reaches: `equalsJson` compares each
 * distinct pair of containers once, and `stableStringify`, `semanticKey`
 * and `contentKey` write each distinct container once, so forty levels
 * answer at once instead of taking hours or exhausting the heap. The
 * answers are the plain walk's for every value — the same text
 * character for character, the same first difference, cycle, depth
 * refusal or refused member — which each case proves by putting a value
 * beside a large shared one (past the plain walk's budget) and comparing
 * with the value beside a small one (within it).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { contentKey, equalsJson, semanticKey, stableStringify } from '@jarenjs/core/object';
import { hashContent } from '@jarenjs/core/string';

/** `n` levels of `d = [d, d]` over `leaf`, built afresh. @param {number} n @param {unknown} [leaf] */
const dag = (n, leaf = 0) => {
  /** @type {any} */
  let d = leaf;
  for (let i = 0; i < n; i++) d = [d, d];
  return d;
};
/** `n` levels of `d = { r: d, l: d }` over `leaf`. @param {number} n @param {unknown} [leaf] */
const objectDag = (n, leaf = 0) => {
  /** @type {any} */
  let d = leaf;
  for (let i = 0; i < n; i++) d = { r: d, l: d };
  return d;
};
/** `n` nested arrays around `leaf`. @param {number} n @param {unknown} leaf */
const nest = (n, leaf) => {
  /** @type {any} */
  let v = leaf;
  for (let i = 0; i < n; i++) v = [v];
  return v;
};
/** The text of `dag(n)`, written out. @param {number} n */
const dagText = (n) => {
  let text = '0';
  for (let i = 0; i < n; i++) text = `[${text},${text}]`;
  return text;
};
/** @param {() => unknown} f */
const outcome = (f) => {
  try {
    return { value: f() };
  }
  catch (error) {
    return { name: error.name, code: error.code, message: error.message, docPath: error.docPath };
  }
};
/** A cycle: an array holding itself. */
const cycle = () => {
  /** @type {any[]} */
  const c = [];
  c.push(c);
  return c;
};

// past the plain compare's budget, and within it
const LARGE_PAIRS = 21;
const LARGE_WRITES = 19;
const SMALL = 2;

describe('equalsJson over shared values', () => {
  it('compares two separately built 40-level values at once', () => {
    assert.equal(equalsJson(dag(40), dag(40)), true);
    assert.equal(equalsJson(dag(40), dag(40, 1)), false);
    assert.equal(equalsJson(objectDag(40), objectDag(40)), true);
    assert.equal(equalsJson(objectDag(40), objectDag(40, 1)), false);
    // past the host stack, where the walk keeps its own stack
    assert.equal(equalsJson(nest(300, dag(40)), nest(300, dag(40))), true);
    assert.equal(equalsJson(nest(300, dag(40)), nest(300, dag(40, 1))), false);
    assert.equal(equalsJson(nest(300, objectDag(40)), nest(300, objectDag(40))), true);
    assert.equal(equalsJson(nest(300, objectDag(40)), nest(300, objectDag(40, 1))), false);
  });

  /**
   * The outcome of comparing `x` with `y` beside a shared value of
   * `levels` levels, built separately on each side.
   * @param {number} levels @param {() => any} x @param {() => any} y
   */
  const beside = (levels, x, y) => outcome(() => equalsJson([dag(levels), x()], [dag(levels), y()]));
  /** @param {() => any} x @param {() => any} y */
  const same = (x, y) => assert.deepStrictEqual(beside(LARGE_PAIRS, x, y), beside(SMALL, x, y));

  it('answers each pair as the plain compare does', () => {
    same(() => ({ a: 1, b: [1, { c: 2 }] }), () => ({ b: [1, { c: 2 }], a: 1 }));
    same(() => ({ a: 1 }), () => ({ a: 1, b: 2 }));
    same(() => [1, 2], () => [1, 2, 3]);
    same(() => [{}], () => [[]]);
    same(() => [NaN], () => [NaN]);
    same(() => dag(6), () => dag(6, 1));
    same(() => nest(300, dag(5)), () => nest(300, dag(5)));
    same(() => nest(300, [1, dag(4)]), () => nest(300, [1, dag(4, 2)]));
    // one subtree compared with two separately built equals of it
    same(() => {
      const s = objectDag(6);
      return [s, s, { k: s }];
    }, () => [objectDag(6), objectDag(6), { k: objectDag(6) }]);
    same(() => ({ a: 1, b: [2] }), () => ({ a: 1, c: [2] }));
  });

  it('refuses the cycle and the depth the plain compare refuses, where it refuses them', () => {
    const cycled = beside(LARGE_PAIRS, cycle, cycle);
    assert.equal(cycled.code, 'JO2002');
    assert.deepStrictEqual(cycled, beside(SMALL, cycle, cycle));
    // the deepest container beside the shared value at the bound and one past it
    same(() => nest(9999, 0), () => nest(9999, 0));
    same(() => nest(10000, 0), () => nest(10000, 0));
    same(() => nest(10001, 0), () => nest(10001, 0));
    // past the host stack the plain walk compares a container's members
    // last first: the difference in the second member answers before the
    // cycle in the first is followed, which the recursion follows first
    same(() => nest(300, [cycle(), [1]]), () => nest(300, [cycle(), [2]]));
    same(() => [cycle(), [1]], () => [cycle(), [2]]);
  });

  it('refuses a pair found equal and met again deeper where its own depth passes the bound', () => {
    /**
     * a shared subtree `height` levels high, met at the top and `below` levels down
     * @param {number} below @param {number} [height]
     */
    const value = (below, height = 5000) => () => {
      const s = nest(height, 0);
      return [s, nest(below, s)];
    };
    const refused = beside(LARGE_PAIRS, value(6000), value(6000));
    assert.equal(refused.code, 'JO2001');
    assert.deepStrictEqual(refused, beside(SMALL, value(6000), value(6000)));
    assert.deepStrictEqual(beside(LARGE_PAIRS, value(4000), value(4000)), { value: true });
    // met again within the host stack, its height past the bound from there
    same(value(198, 9900), value(198, 9900));
    assert.equal(beside(LARGE_PAIRS, value(198, 9900), value(198, 9900)).code, 'JO2001');
    assert.deepStrictEqual(beside(LARGE_PAIRS, value(50, 9900), value(50, 9900)), { value: true });
    // and past the host stack, where the walk keeps its own frames
    same(() => nest(300, value(6000)()), () => nest(300, value(6000)()));
    same(() => nest(300, value(4000)()), () => nest(300, value(4000)()));
  });
});

describe('stableStringify, semanticKey and contentKey over shared values', () => {
  it('write the same text as the plain writer, past its budget', () => {
    const text = dagText(LARGE_WRITES);
    for (const x of [{ b: [1, { c: undefined }], a: 'x' }, [1, null, undefined, -0, 'é'], dag(5), {}, []]) {
      const plain = stableStringify(x);
      assert.equal(stableStringify([dag(LARGE_WRITES), x]), `[${text},${plain}]`);
      assert.equal(contentKey([dag(LARGE_WRITES), x]), hashContent(`[${text},${plain}]`));
    }
    for (const x of [{ b: [1, { c: undefined }], a: NaN }, [1, null, undefined, -0, Infinity, 2n], dag(5), { z: 1, a: 2 }]) {
      assert.equal(semanticKey([dag(LARGE_WRITES), x]), `[${text},${semanticKey(x)}]`);
      assert.equal(semanticKey([dag(LARGE_WRITES), x], { ordered: true }), `[${text},${semanticKey(x, { ordered: true })}]`);
    }
  });

  it('a long key is unchanged', () => {
    const key = semanticKey(dag(22));
    assert.equal(key.length, 16777213);
    assert.equal(hashContent(key), 'v8d15x');
    assert.equal(contentKey(dag(22)), 'v8d15x');
    assert.equal(stableStringify(dag(22)), key);
  });

  /** @param {(v: any) => unknown} key @param {() => any} x */
  const sameRefusal = (key, x) => {
    const shared = outcome(() => key([dag(LARGE_WRITES), x()]));
    assert.ok('name' in shared, 'a refusal');
    assert.deepStrictEqual(shared, outcome(() => key([dag(SMALL), x()])));
  };

  it('refuse the member, cycle and depth the plain writer refuses, where it refuses them', () => {
    for (const x of [() => ({ a: [1, () => 1] }), () => ({ a: new Date(0) }), () => [Symbol('s')], () => ({ b: cycle() }), () => nest(10001, 0)]) {
      sameRefusal(semanticKey, x);
      sameRefusal((v) => semanticKey(v, { ordered: true }), x);
    }
    for (const x of [() => ({ b: cycle() }), () => nest(10001, 0), () => [1n]]) {
      sameRefusal(stableStringify, x);
      sameRefusal(contentKey, x);
    }
  });

  it('answer at the bound and refuse one level past it, as the plain writer', () => {
    for (const key of [stableStringify, semanticKey, contentKey]) {
      const atBound = key([dag(LARGE_WRITES), nest(9999, 0)]);
      assert.equal(atBound, key === contentKey
        ? hashContent(`[${dagText(LARGE_WRITES)},${stableStringify(nest(9999, 0))}]`)
        : `[${dagText(LARGE_WRITES)},${key(nest(9999, 0))}]`);
      sameRefusal(key, () => nest(10000, 0));
    }
  });

  it('refuse a container written and met again deeper where its own depth passes the bound', () => {
    const value = (/** @type {number} */ below) => {
      const s = nest(5000, 0);
      return [dag(LARGE_WRITES), s, nest(below, s)];
    };
    for (const key of [stableStringify, semanticKey]) {
      assert.equal(outcome(() => key(value(6000))).code, 'JO2001');
      const answered = value(4000);
      assert.equal(key(answered), `[${dagText(LARGE_WRITES)},${key(answered[1])},${key(answered[2])}]`);
    }
  });

  /** @param {string} verb */
  const tooLong = (verb) => ({ name: 'JsonLengthError', code: 'JO2009', docPath: undefined,
    message: `JO2009: a value whose text is longer than the host's longest string cannot be ${verb}` });

  it('a text longer than the host\'s longest string is refused JO2009, not the host\'s RangeError', () => {
    // 40 levels write 4 * 2^40 - 3 characters, past the longest string of every host
    assert.equal(dagText(4).length, 4 * 2 ** 4 - 3);
    for (const [key, verb] of /** @type {const} */ ([[stableStringify, 'serialized'], [semanticKey, 'a cache identity'],
      [contentKey, 'serialized']])) {
      for (const value of [dag(40), nest(300, dag(40)), { a: dag(40) }, [1, dag(40)]])
        assert.deepStrictEqual(outcome(() => key(value)), tooLong(verb), key.name);
    }
  });

  it('a key of 26 levels, 268435453 characters, is written whole', () => {
    assert.equal(stableStringify(dag(26))?.length, 4 * 2 ** 26 - 3);
    assert.equal(semanticKey(dag(26)).length, 4 * 2 ** 26 - 3);
    assert.equal(semanticKey(dag(26), { ordered: true }).length, 4 * 2 ** 26 - 3);
  });

  it('a call stack exhausted inside the writer is not read as a text too long', () => {
    // a RangeError that is not the host's refusal of a long string passes as it was
    /** @param {number} n @returns {unknown} */
    const exhaust = (n) => (n === 0 ? null : exhaust(n - 1));
    const overflow = outcome(() => exhaust(1e7));
    assert.equal(overflow.name, 'RangeError');
    const value = { get a() { return exhaust(1e7); } };
    for (const key of [stableStringify, semanticKey, contentKey])
      assert.deepStrictEqual(outcome(() => key(value)), overflow, key.name);
  });
});
