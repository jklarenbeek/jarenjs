//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { compileJsonQuery } from '@jarenjs/json/query';
import { JarenValidator } from '@jarenjs/validate';

describe('query execution limits', function () {
  it('limits.sequenceItems bounds phrase materialization with a stable JQ2009', function () {
    const query = compileJsonQuery(
      { $for: { i: '$[*]' }, $return: '$i' },
      { limits: { sequenceItems: 3 } });
    assert.deepStrictEqual(query([1, 2, 3]), [1, 2, 3]);
    assert.throws(() => query([1, 2, 3, 4]),
      (err) => /** @type {any} */ (err).code === 'JQ2009'
        && /sequenceItems/.test(/** @type {Error} */ (err).message));
  });

  it('limits.sequenceItems tightens the $range resource guard (JQ2007 stays the code)', function () {
    const query = compileJsonQuery(
      { $range: [1, '$.n'] },
      { limits: { sequenceItems: 100 } });
    assert.strictEqual(/** @type {any[]} */ (query({ n: 100 })).length, 100);
    assert.throws(() => query({ n: 101 }),
      (err) => /** @type {any} */ (err).code === 'JQ2007'
        && /100-item/.test(/** @type {Error} */ (err).message));
  });

  it('limits.resultItems bounds the query boundary result', function () {
    const query = compileJsonQuery('$[*]', { limits: { resultItems: 2 } });
    assert.deepStrictEqual(query([1, 2]), [1, 2]);
    assert.throws(() => query([1, 2, 3]),
      (err) => /** @type {any} */ (err).code === 'JQ2009'
        && /resultItems/.test(/** @type {Error} */ (err).message));
    assert.strictEqual(query.first([1, 2, 3]), 1,
      'first() takes one item and needs no cap');
  });

  it('refuses limits it cannot enforce — no silent false guarantees', function () {
    assert.throws(() => compileJsonQuery('$', { limits: { steps: 1000 } }),
      (err) => err instanceof TypeError && /not enforced/.test(/** @type {Error} */ (err).message));
    assert.throws(() => compileJsonQuery('$', { limits: { depth: 10 } }), TypeError);
    assert.throws(() => compileJsonQuery('$', { limits: { bogus: 1 } }), TypeError);
    assert.throws(() => compileJsonQuery('$', { limits: { resultItems: 0 } }), TypeError);
  });
});

describe('named collations', function () {
  const dutch = new Intl.Collator('nl').compare;

  it('$collation orders string keys through the registered compare function', function () {
    const doc = {
      $for: { w: '$[*]' },
      $orderby: [{ $key: '$w', $collation: 'nl' }],
      $return: '$w',
    };
    const query = compileJsonQuery(doc, { collations: { nl: dutch } });
    // code-point order puts 'Z' before 'a'; the Dutch collator does not
    assert.deepStrictEqual(query(['zee', 'Aap', 'boot']), ['Aap', 'boot', 'zee']);
    const codepoint = compileJsonQuery({
      $for: { w: '$[*]' }, $orderby: ['$w'], $return: '$w',
    });
    assert.deepStrictEqual(codepoint(['zee', 'Aap', 'boot']), ['Aap', 'boot', 'zee'].sort(),
      'the default stays code-point order');
  });

  it('$collation composes with $dir', function () {
    const query = compileJsonQuery({
      $for: { w: '$[*]' },
      $orderby: [{ $key: '$w', $collation: 'nl', $dir: 'desc' }],
      $return: '$w',
    }, { collations: { nl: dutch } });
    assert.deepStrictEqual(query(['boot', 'zee', 'Aap']), ['zee', 'boot', 'Aap']);
  });

  it('an unregistered collation is compile error JQ0010', function () {
    assert.throws(() => compileJsonQuery({
      $for: { w: '$[*]' }, $orderby: [{ $key: '$w', $collation: 'xx' }], $return: '$w',
    }), (err) => /** @type {any} */ (err).code === 'JQ0010');
  });
});

describe('registered functions — $call', function () {
  const options = {
    functions: {
      upper: (s) => (typeof s === 'string' ? s.toUpperCase() : undefined),
      join: (items, sep) => (Array.isArray(items) ? items.join(sep) : undefined),
      boom: () => { throw new Error('kapot'); },
    },
  };

  it('calls a registered pure function with evaluated arguments', function () {
    const query = compileJsonQuery({ $call: ['upper', '$.name'] }, options);
    assert.strictEqual(query({ name: 'jo' }), 'JO');
  });

  it('sequences cross as arrays; a returned undefined is the empty sequence', function () {
    const query = compileJsonQuery({ $call: ['join', '$.words[*]', '-'] }, options);
    assert.strictEqual(query({ words: ['a', 'b'] }), 'a-b');
    const empty = compileJsonQuery({ $call: ['upper', '$.missing'] }, options);
    assert.strictEqual(empty({}), undefined);
  });

  it('an unknown function name is compile error JQ0010', function () {
    assert.throws(() => compileJsonQuery({ $call: ['nope'] }, options),
      (err) => /** @type {any} */ (err).code === 'JQ0010');
    assert.throws(() => compileJsonQuery({ $call: ['upper'] }),
      (err) => /** @type {any} */ (err).code === 'JQ0010',
      'without a registry every name is unknown');
  });

  it('a throwing function is runtime error JQ2010 naming the function', function () {
    const query = compileJsonQuery({ $call: ['boom'] }, options);
    assert.throws(() => query(null),
      (err) => /** @type {any} */ (err).code === 'JQ2010'
        && /'boom'/.test(/** @type {Error} */ (err).message));
  });

  it('malformed registries are host TypeErrors', function () {
    assert.throws(() => compileJsonQuery('$', { functions: { bad: 42 } }), TypeError);
    assert.throws(() => compileJsonQuery('$', { collations: 'nl' }), TypeError);
  });
});

describe('query.dependencies and query.explain()', function () {
  it('reports externals, operators, functions and collations', function () {
    const query = compileJsonQuery({
      $for: { b: '$.books[*]' },
      $where: { $lt: ['$b.price', '$max'] },
      $orderby: [{ $key: '$b.title', $collation: 'nl' }],
      $return: { title: { $call: ['upper', '$b.title'] } },
    }, {
      collations: { nl: new Intl.Collator('nl').compare },
      functions: { upper: (s) => String(s).toUpperCase() },
      limits: { resultItems: 500 },
    });
    assert.deepStrictEqual([...query.dependencies.externals], ['max']);
    assert.ok(query.dependencies.operators.includes('$lt'));
    assert.ok(query.dependencies.operators.includes('$call'));
    assert.deepStrictEqual([...query.dependencies.functions], ['upper']);
    assert.deepStrictEqual([...query.dependencies.collations], ['nl']);

    const plan = query.explain();
    assert.deepStrictEqual(plan.limits, { sequenceItems: null, resultItems: 500 });
    assert.deepStrictEqual(plan.functions, ['upper']);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(plan)), plan, 'explain is plain JSON');
    assert.notStrictEqual(query.explain(), plan, 'a fresh value each call');
  });

  it('a plain query reports empty registries and null limits', function () {
    const query = compileJsonQuery('$.a');
    assert.deepStrictEqual([...query.dependencies.functions], []);
    assert.strictEqual(query.explain().limits, null);
  });
});

describe('the schema twins accept $call and $collation', function () {
  const load = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
  const doc = {
    $for: { b: '$.books[*]' },
    $orderby: [{ $key: '$b.title', $collation: 'nl' }],
    $return: { title: { $call: ['upper', '$b.title'] } },
  };

  for (const twin of ['jaren-query.schema.json', 'jaren-query.draft-07.schema.json']) {
    it(`${twin} validates the new constructs`, function () {
      const validate = new JarenValidator()
        .compile(load(`../../packages/json/schemas/${twin}`));
      assert.strictEqual(validate(doc), true);
      assert.strictEqual(validate({ $call: 'upper' }), false,
        'the $call value must be an array');
      assert.strictEqual(validate({
        $for: { b: '$[*]' }, $orderby: [{ $key: '$b', $collation: 7 }], $return: '$b',
      }), false, 'a $collation must be a string');
    });
  }
});
