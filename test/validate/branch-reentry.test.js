import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { JarenValidator } from '@jarenjs/validate';

// A collecting validator runs every branch of a `oneOf`, and the branches of
// an `anyOf` up to a match, in full, faults included. Branches that enter one
// definition through references on the same member enter it again per
// branch, at every level below: a grammar of operator phrases whose operands
// are expressions entered the operand 3^depth times. An entry on the same
// member, at the same location, with the same references open answers as it
// did, so the collecting walk gives that answer again, faults included: the
// work grows with the instance, and every answer is the one the full walk
// gives (a dynamic-scope keyword anywhere turns the reuse off, which is the
// full walk these tests compare with).

const op = (name) => ({
  type: 'object',
  propertyNames: { const: name },
  additionalProperties: { type: 'array', items: { $ref: '#/$defs/expr' } },
});

const grammar = (extra = {}) => ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $defs: {
    expr: { oneOf: [{ type: 'string', format: 'leaf' }, { $ref: '#/$defs/phrase' }] },
    phrase: { oneOf: [op('$a'), op('$b'), op('$c')] },
    ...extra,
  },
  $ref: '#/$defs/expr',
});

// the same grammar with a dynamic anchor nothing reads: answers kept never
const FULL_WALK = { scope: { $dynamicAnchor: 'unused' } };

function compile(schema, counter = { calls: 0 }, options = {}) {
  return new JarenValidator({ skipErrors: false, collectErrors: true, formatAssertion: true, ...options })
    .addFormats({ leaf: () => (data) => { counter.calls++; return typeof data === 'string' && data !== 'bad'; } })
    .compile(schema);
}

// depth d: { $a: [ <depth d-1>, 'x' ] }; depth 0: the leaf
const nested = (depth, leaf = 'x') => depth === 0 ? leaf : { $a: [nested(depth - 1, leaf), 'x'] };

describe('a collecting walk entering one definition again per branch', function () {
  it('checks each operand once per location, not once per branch tried', function () {
    const counter = { calls: 0 };
    const validate = compile(grammar(), counter);
    const calls = [1, 2, 4, 8].map((depth) => {
      counter.calls = 0;
      assert.strictEqual(validate(nested(depth)).valid, true);
      return counter.calls;
    });
    assert.deepStrictEqual(calls, [7, 13, 25, 49]);
  });

  it('a dynamic-scope keyword keeps the full walk', function () {
    const counter = { calls: 0 };
    const validate = compile(grammar(FULL_WALK), counter);
    const calls = [1, 2, 4].map((depth) => {
      counter.calls = 0;
      validate(nested(depth));
      return counter.calls;
    });
    assert.deepStrictEqual(calls, [7, 25, 241]);
  });

  it('answers every instance as the full walk does, faults included', function () {
    const kept = compile(grammar());
    const full = compile(grammar(FULL_WALK));
    const instances = [
      nested(5),
      nested(4, 'bad'),
      nested(3, 7),
      { $a: [nested(2), { $b: ['x', 'bad'] }] },
      { $a: [nested(2)], plain: 1 },
      { $z: [nested(2)] },
      { $a: [{ $a: ['x'], $b: ['bad'] }, nested(3, null)] },
      [nested(1)],
    ];
    for (const instance of instances)
      assert.deepStrictEqual(kept(instance), full(instance));
    const { valid, errors } = kept(nested(1, 'bad'));
    assert.strictEqual(valid, false);
    assert.deepStrictEqual(errors.map((e) => `${e.instancePath} ${e.keyword}`), [
      ' type', '/$a/0 type', '/$a/0 type', '/$a/0 type', '/$a/0 oneOf', '/$a/0 oneOf', '/$a items',
      ' const', '/$a/0 type', '/$a/0 type', '/$a/0 type', '/$a/0 oneOf', '/$a/0 oneOf', '/$a items',
      ' const', '/$a/0 type', '/$a/0 type', '/$a/0 type', '/$a/0 oneOf', '/$a/0 oneOf', '/$a items',
      ' oneOf', ' oneOf',
    ]);
  });

  it('refuses at the reference depth bound as the full walk does', function () {
    const kept = compile(grammar(), undefined, { maxReferenceDepth: 12 });
    const full = compile(grammar(FULL_WALK), undefined, { maxReferenceDepth: 12 });
    const refusal = (validate) => {
      try { validate(nested(12)); return null; }
      catch (e) { return { code: e.code, message: e.message }; }
    };
    const expected = refusal(full);
    assert.strictEqual(expected?.code, 'JK2001');
    assert.deepStrictEqual(refusal(kept), expected);
  });

  it('enters a member again through a longer chain of references as the full walk does', function () {
    // the second branch reaches the same member through two references more,
    // past the bound the first branch stays within
    const twoChains = (extra) => ({
      ...grammar({ wrap: { $ref: '#/$defs/wrapped' }, wrapped: { $ref: '#/$defs/expr' }, ...extra }),
      $ref: undefined,
      oneOf: [{ $ref: '#/$defs/expr' }, { $ref: '#/$defs/wrap' }],
    });
    const answer = (schema, depth) => {
      const validate = compile(JSON.parse(JSON.stringify(schema)), undefined, { maxReferenceDepth: 12 });
      try { return validate({ $a: [nested(depth)] }).valid; }
      catch (e) { return e.code; }
    };
    for (const [depth, expected] of [[8, false], [9, 'JK2001']]) {
      assert.strictEqual(answer(twoChains(FULL_WALK), depth), expected);
      assert.strictEqual(answer(twoChains(), depth), expected);
    }
  });

  it('records no clock reading per fault', function () {
    const validate = compile(grammar());
    const hrtime = process.hrtime;
    let reads = 0;
    process.hrtime = function countedHrtime(...args) { reads++; return hrtime.apply(process, args); };
    try {
      assert.strictEqual(validate(nested(3, 'bad')).valid, false);
    }
    finally {
      process.hrtime = hrtime;
    }
    assert.strictEqual(reads, 0);
  });
});
