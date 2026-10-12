//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';

/** @param {any} schema @param {boolean} collect */
const compileIn = (schema, collect) => new JarenValidator({ collectErrors: collect, draftVersion: 2020 }).compile(schema);

describe('an items reference back to an enclosing schema', () => {
  const tree = { type: 'array', items: { $ref: '#' } };

  for (const collect of [false, true]) {
    it(`compiles to the same validator in ${collect ? 'collecting' : 'first-failure'} mode, however often it is compiled`, () => {
      for (let i = 0; i < 20; i++) {
        const validate = compileIn(tree, collect);
        const verdict = (/** @type {any} */ data) => collect ? validate(data).valid : validate(data);
        assert.equal(verdict([]), true);
        assert.equal(verdict([[], [[], [[]]]]), true);
        assert.equal(verdict([[], 1]), false);
        assert.equal(verdict([[[[2]]]]), false);
      }
    });
  }

  it('locates the failing item where it sits', () => {
    const result = compileIn(tree, true)([[], [[], 'x']]);
    assert.equal(result.valid, false);
    assert.deepEqual(result.errors.map((/** @type {any} */ e) => [e.keyword, e.instancePath]), [['type', '/1/1'], ['items', '/1'], ['items', '']]);
  });

  it('resolves a cycle through two definitions', () => {
    const schema = {
      $defs: {
        a: { type: 'array', items: { $ref: '#/$defs/b' } },
        b: { type: ['array', 'string'], items: { $ref: '#/$defs/a' } },
      },
      $ref: '#/$defs/a',
    };
    for (const collect of [false, true]) {
      const validate = compileIn(schema, collect);
      const verdict = (/** @type {any} */ data) => collect ? validate(data).valid : validate(data);
      assert.equal(verdict([[], [[]], 'x']), true);
      assert.equal(verdict([1]), false);
    }
  });

  it('still joins a reference to a finished definition directly', () => {
    const schema = { $defs: { s: { type: 'string' } }, type: 'array', items: { $ref: '#/$defs/s' } };
    for (const collect of [false, true]) {
      const validate = compileIn(schema, collect);
      const verdict = (/** @type {any} */ data) => collect ? validate(data).valid : validate(data);
      assert.equal(verdict(['a', 'b']), true);
      assert.equal(verdict(['a', 1]), false);
    }
  });
});

describe('an items reference to a sibling schema compiled later', () => {
  it('compiles, and answers, in both modes', () => {
    const schema = { prefixItems: [{ $ref: '#/$defs/a' }], items: {}, $defs: { a: { items: { $ref: '#/items' } } } };
    for (const collect of [false, true]) {
      const validate = compileIn(schema, collect);
      const verdict = (/** @type {any} */ data) => collect ? validate(data).valid : validate(data);
      assert.equal(verdict([[1, 'x'], 5]), true);
      assert.equal(verdict([5]), true);
    }
    const strict = { prefixItems: [{ $ref: '#/$defs/a' }], items: false, $defs: { a: { items: { $ref: '#/items' } } } };
    assert.equal(compileIn(strict, false)([[]]), true);
    assert.equal(compileIn(strict, false)([[], 1]), false);
    assert.equal(compileIn(strict, true)([[1]]).valid, false);
  });
});
