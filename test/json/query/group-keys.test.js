//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileJsonQuery, createQueryAccumulator, stableKeyString } from '@jarenjs/json/query';

const big = 2n ** 60n;

describe('the identity behind $distinct, $groupby and the hash join', () => {
  it('keeps bigints apart from each other and from an empty object', () => {
    const distinct = compileJsonQuery({ $distinct: '$.v[*]' });
    assert.deepEqual(distinct({ v: [big, big + 1n, {}, big] }), [big, big + 1n, {}]);
    const groups = compileJsonQuery({
      $for: { x: '$.v[*]' }, $groupby: { k: '$x' }, $return: { k: '$k', n: { $count: '$x' } },
    });
    assert.deepEqual(groups({ v: [big, {}, big, big + 1n] }), [{ k: big, n: 2 }, { k: {}, n: 1 }, { k: big + 1n, n: 1 }]);
  });

  it('joins a bigint key on its own value, as the scan does', () => {
    const join = compileJsonQuery({
      $for: { o: '$.outer[*]', i: '$.inner[*]' }, $where: { $eq: ['$o.k', '$i.k'] }, $return: ['$o.id', '$i.id'],
    });
    const scan = compileJsonQuery({
      $for: { o: '$.outer[*]', i: '$.inner[*]' }, $where: { $eq: [{ $seq: ['$o.k'] }, '$i.k'] }, $return: ['$o.id', '$i.id'],
    });
    const data = {
      outer: [{ id: 0, k: big }, { id: 1, k: {} }, { id: 2, k: 1 }],
      inner: [{ id: 0, k: big + 1n }, { id: 1, k: {} }, { id: 2, k: big }, { id: 3, k: 1n }],
    };
    assert.deepEqual(scan(data), [[0, 2], [1, 1]]);
    assert.deepEqual(join(data), [[0, 2], [1, 1]]);
  });

  it('reads a member held as undefined as a member, not an error and not an absent one', () => {
    const rows = [{ a: 1, b: undefined }, { a: 1 }, { a: 1, b: undefined }];
    const distinct = compileJsonQuery({ $distinct: '$.rows[*]' });
    const out = distinct({ rows });
    assert.equal(out.length, 2);
    assert.deepEqual(Object.keys(out[0]), ['a', 'b']);
    assert.deepEqual(Object.keys(out[1]), ['a']);
    const groups = compileJsonQuery({
      $for: { r: '$.rows[*]' }, $groupby: { k: '$r' }, $return: { n: { $count: '$r' } },
    });
    assert.deepEqual(groups({ rows }), [{ n: 2 }, { n: 1 }]);
    const join = compileJsonQuery({
      $for: { o: '$.rows[*]', i: '$.rows[*]' }, $where: { $eq: ['$o', '$i'] }, $return: '$o',
    });
    assert.equal(join({ rows }).length, 5);
  });
});

// A value nested `levels` containers deep around `leaf`, alternating an
// array and an object wrapper, built without recursion.
function nest(levels, leaf) {
  let v = leaf;
  for (let i = 0; i < levels; i++)
    v = i % 2 === 0 ? [v] : { m: v };
  return v;
}

// The key of `nest(levels, leaf)` written from the key of `leaf`.
function nestedKey(levels, leafKey) {
  let k = leafKey;
  for (let i = 0; i < levels; i++)
    k = i % 2 === 0 ? `[${k}]` : `{"m":${k}}`;
  return k;
}

function cyclic() {
  const c = { x: 1 };
  c.self = c;
  return c;
}

// A JsonCycleError / JsonDepthError, matched on everything a caller reads.
const keyCycle = (docPath) => ({
  name: 'JsonCycleError', code: 'JO2002', docPath,
  message: `JO2002: a circular reference cannot be keyed at ${docPath}`,
});
const keyDepth = {
  name: 'JsonDepthError', code: 'JO2001',
  message: 'JO2001: a value nested deeper than 10000 levels cannot be keyed',
};

describe('a key over a cyclic or very deep value', () => {
  // every encoding rule of the key, in one value: sorted members, -0,
  // a bigint, a member held as undefined, NaN and Infinity, an escaped
  // string, an array hole, a function member read as an object
  const leaf = { z: [-0, 2n ** 60n, undefined, NaN, -Infinity, 'q"\n', new Array(1), true, null], a: { f() {} }, m: 1.5 };
  const leafKey = '{"a":{"f":{}},"m":1.5,"z":[0,1152921504606846976n,undefined,NaN,-Infinity,"q\\"\\n",[undefined],true,null]}';

  it('keys a shallow value as before', () => {
    assert.equal(stableKeyString(leaf), leafKey);
  });

  it('keys a value past the host stack as it keys a shallow one, up to 10000 levels', () => {
    for (const levels of [255, 256, 257, 600, 8000, 9997])
      assert.equal(stableKeyString(nest(levels, leaf)), nestedKey(levels, leafKey), `${levels} levels`);
    // 10000 containers around a scalar: the deepest one still keys
    assert.equal(stableKeyString(nest(10000, 7)), nestedKey(10000, '7'));
    // the leaf's function member is its third level
    assert.throws(() => stableKeyString(nest(9998, leaf)), keyDepth);
  });

  it('refuses a value nested past 10000 levels with JO2001, whatever the host stack', () => {
    assert.throws(() => stableKeyString(nest(10001, 7)), keyDepth);
    assert.throws(() => stableKeyString(nest(100000, 7)), keyDepth);
  });

  it('refuses a cycle with JO2002 at the member that closes it', () => {
    assert.throws(() => stableKeyString(cyclic()), keyCycle('/self'));
    assert.throws(() => stableKeyString({ b: 1, a: [0, { list: [cyclic()] }] }), keyCycle('/a/1/list/0/self'));
    // a cycle back to the root, closed past the recursive depth
    const root = nest(300, null);
    let tail = root;
    while (tail !== null && typeof tail === 'object') {
      const next = Array.isArray(tail) ? tail[0] : tail.m;
      if (next === null) {
        if (Array.isArray(tail)) tail[0] = root; else tail.m = root;
        break;
      }
      tail = next;
    }
    assert.throws(() => stableKeyString(root), keyCycle(nestedKey(300, '').replace(/\[|\{"m":/g, (t) => (t === '[' ? '/0' : '/m')).replace(/[\]}]/g, '')));
  });

  it('keys a shared subtree (a DAG) each time it is reached, not as a cycle', () => {
    const shared = { k: [1, 2] };
    assert.equal(stableKeyString({ a: shared, b: [shared, shared] }), '{"a":{"k":[1,2]},"b":[{"k":[1,2]},{"k":[1,2]}]}');
    const deepShared = nest(300, 1);
    assert.equal(stableKeyString([deepShared, deepShared]), `[${nestedKey(300, '1')},${nestedKey(300, '1')}]`);
  });

  it('refuses a cyclic or too deep item of $distinct, never a RangeError', () => {
    const c = cyclic();
    assert.throws(() => compileJsonQuery({ $distinct: '$.self' })(c), keyCycle('/self'));
    assert.throws(() => compileJsonQuery({ $distinct: '$.rows[*]' })({ rows: [1, { a: [c] }] }), keyCycle('/a/0/self'));
    assert.throws(() => compileJsonQuery({ $distinct: '$' })(nest(100000, 1)), keyDepth);
    const acc = createQueryAccumulator('$distinct');
    acc.add(1);
    assert.throws(() => acc.add(c), keyCycle('/self'));
  });

  it('answers $distinct over values between the old stack limit and the bound', () => {
    const a = nest(8000, 1);
    const b = nest(8000, 1);
    const out = compileJsonQuery({ $distinct: '$.v[*]' })({ v: [a, b, nest(8000, 2)] });
    assert.equal(out.length, 2);
    assert.equal(out[0], a);
    assert.equal(stableKeyString(out[1]), nestedKey(8000, '2'));
  });

  it('answers $distinct and $groupby over a DAG as before', () => {
    const s = { k: 1 };
    const rows = [{ a: s, b: s }, { a: s, b: s }, { a: s, b: { k: 2 } }];
    assert.deepEqual(compileJsonQuery({ $distinct: '$.rows[*]' })({ rows }), [rows[0], rows[2]]);
    const groups = compileJsonQuery({ $for: { r: '$.rows[*]' }, $groupby: { k: '$r' }, $return: { n: { $count: '$r' } } });
    assert.deepEqual(groups({ rows }), [{ n: 2 }, { n: 1 }]);
  });

  it('refuses a cyclic or too deep $groupby key, never a RangeError', () => {
    const groups = compileJsonQuery({ $for: { r: '$.rows[*]' }, $groupby: { k: '$r' }, $return: { n: { $count: '$r' } } });
    assert.throws(() => groups({ rows: [1, cyclic()] }), keyCycle('/self'));
    assert.throws(() => groups({ rows: [{ d: nest(10000, 1) }] }), keyDepth);
    assert.deepEqual(groups({ rows: [nest(8000, 1), nest(8000, 1)] }), { n: 2 });
  });
});

describe('a hash join over a value it cannot key answers as the scan', () => {
  // The scan is the same phrase with a $let, which the planner never
  // probes: its answer, or its error, is the oracle.
  const scanOf = (doc) => ({ ...doc, $let: { _z: 1 } });
  const outcome = (doc, data) => {
    try {
      return { value: compileJsonQuery(doc)(data) };
    }
    catch (error) {
      return { code: error.code ?? `uncoded ${error.name}`, message: error.message, docPath: error.docPath };
    }
  };
  const bothWays = (doc, data) => {
    const fast = outcome(doc, data);
    assert.deepStrictEqual(fast, outcome(scanOf(doc), data), 'the hash join must agree with the scan');
    return fast;
  };
  const join = (where) => ({ $for: { o: '$.a[*]', i: '$.b[*]' }, $where: where, $return: ['$o.n', '$i.n'] });
  const eq = { $eq: ['$o.k', '$i.k'] };

  it('files no inner item it cannot key, and still matches the others (build side)', () => {
    assert.deepStrictEqual(bothWays(join(eq), { a: [{ n: 0, k: 'x' }], b: [{ n: 1, k: cyclic() }, { n: 2, k: 'x' }] }),
      { value: [0, 2] });
  });

  it('matches a cyclic key equal to itself', () => {
    const c = cyclic();
    assert.deepStrictEqual(bothWays(join(eq), { a: [{ n: 0, k: c }, { n: 1, k: 1 }], b: [{ n: 2, k: c }, { n: 3, k: 1 }] }),
      { value: [[0, 2], [1, 3]] });
  });

  it('matches a too deep key equal to itself, and keys every other one', () => {
    const d = nest(20000, 1);
    assert.deepStrictEqual(bothWays(join(eq), { a: [{ n: 0, k: d }, { n: 1, k: 'x' }], b: [{ n: 2, k: 'x' }, { n: 3, k: d }] }),
      { value: [[0, 3], [1, 2]] });
  });

  it('scans for an outer key it cannot key (probe side)', () => {
    const c = cyclic();
    assert.deepStrictEqual(bothWays(join(eq), { a: [{ n: 0, k: c }, { n: 1, k: 1 }], b: [{ n: 2, k: 1 }, { n: 3, k: { x: 1 } }] }),
      { value: [1, 2] });
  });

  it('raises what the scan raises for two different cycles', () => {
    const got = bothWays(join(eq), { a: [{ n: 0, k: cyclic() }], b: [{ n: 1, k: cyclic() }] });
    assert.equal(got.code, 'JO2002');
  });

  it('keeps the rest of an $and after the equality', () => {
    const c = cyclic();
    const where = { $and: [eq, { $eq: ['$o.n', 0] }] };
    assert.deepStrictEqual(bothWays(join(where), { a: [{ n: 0, k: c }, { n: 1, k: c }], b: [{ n: 2, k: c }] }),
      { value: [0, 2] });
  });

  it('joins a DAG key as before', () => {
    const s = { k: [1] };
    assert.deepStrictEqual(bothWays(join(eq), { a: [{ n: 0, k: { p: s, q: s } }], b: [{ n: 1, k: { p: s, q: { k: [1] } } }] }),
      { value: [0, 1] });
  });
});
