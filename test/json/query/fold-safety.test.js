//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { compileJsonQuery, queryJson } from '@jarenjs/json/query';

describe('fold scope, barriers and allocation bounds', () => {
  it('lets and filters see the running accumulator without a barrier', () => {
    const query = {
      $fold: { acc: 0 }, $for: { n: '$[*]' },
      $let: { next: { $add: ['$acc', '$n'] } },
      $where: { $le: ['$next', 5] }, $return: '$next',
    };
    assert.equal(queryJson(query, [2, 4, 3]), 5);
    // A barrier consumes the prefix before any return updates acc.
    assert.equal(queryJson({ ...query, $orderby: '$n' }, [2, 4, 3]), 4);
    assert.equal(queryJson({ ...query, $groupby: { key: '$n' } }, [2, 4, 3]), 3);
  });

  it('nested return phrases see the accumulator after ordering', () => {
    const query = {
      $fold: { acc: '' }, $for: { n: '$[*]' }, $orderby: '$n',
      $return: { $let: { next: { $concat: ['$acc', '$n'] } }, $return: '$next' },
    };
    assert.equal(queryJson(query, ['c', 'a', 'b']), 'abc');
  });

  it('bounds both the initial and every intermediate sequence accumulator', () => {
    const options = { limits: { sequenceItems: 2 } };
    for (const query of [
      { $fold: { acc: '$[*]' }, $for: { n: { $const: [] } }, $return: 0 },
      { $fold: { acc: 0 }, $for: { n: [1, 2] }, $return: { $if: [{ $eq: ['$n', 1] }, '$[*]', 0] } },
    ]) {
      assert.throws(() => compileJsonQuery(query, options)([1, 2, 3]), { code: 'JQ2009', docPath: '' });
    }
    assert.deepEqual(compileJsonQuery({ $fold: { acc: '$' }, $return: '$acc' }, options)([1, 2, 3]), [1, 2, 3],
      'an array item is one item, not a sequence');
  });

  it('refuses materialized range bombs before allocation under a small heap', () => {
    const child = spawnSync(process.execPath, ['--max-old-space-size=32', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { queryJson, compileJsonQuery } from '@jarenjs/json/query';
      for (const expression of [
        { $range: [0, 1000000] },
        { $let: { r: { $range: [0, 100000000] } }, $return: '$r' },
        { $sum: { $range: [0, 100000000] } },
        { $range: [1, 4294967296] }
      ]) assert.throws(() => queryJson(expression, null), { code: 'JQ2007' });
      assert.equal(queryJson({ $some: { n: { $range: [0, 100000000] } }, $satisfies: true }, null), true);
      assert.equal(queryJson({ $fold: { acc: 0 }, $for: { n: { $range: [0, 1000000] } }, $return: { $add: ['$acc', 1] } }, null), 1000001);
      assert.throws(() => compileJsonQuery({ $range: [0, 3] }, { limits: { sequenceItems: 3 } })(null), { code: 'JQ2007' });
    `], { encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 0, child.stderr);
  });

  it('rejects unsafe integer bounds in both materialized and counting-loop paths', () => {
    for (const range of [{ $range: [2 ** 53, 2 ** 53] }, { $range: [-(2 ** 53), 0] }]) {
      for (const query of [range, { $for: { n: range }, $return: '$n' }, { $some: { n: range }, $satisfies: true }])
        assert.throws(() => queryJson(query, null), { code: 'JQ2001' });
    }
  });
});
