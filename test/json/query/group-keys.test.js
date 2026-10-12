//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compileJsonQuery } from '@jarenjs/json/query';

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
