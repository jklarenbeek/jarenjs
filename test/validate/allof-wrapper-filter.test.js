//@ts-check
/**
 * @file The consumer filter the validate README gives for the `allOf`
 * wrapper error: it must hide a wrapper only when one of its own inline
 * branches reported an error, and never hide the only trace of a failure.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { JarenValidator } from '@jarenjs/validate';

/**
 * The README's filter, verbatim in behaviour.
 * @param {{keyword: string, instancePath: string, schemaPath: string}[]} errors
 */
const withoutWrappers = (errors) => errors.filter((e, i) => {
  if (e.keyword !== 'allOf') return true;
  let from = i;
  while (from > 0 && !(errors[from - 1].keyword === 'allOf'
    && errors[from - 1].schemaPath === e.schemaPath
    && errors[from - 1].instancePath === e.instancePath)) from--;
  return !errors.slice(from, i).some((x) => x.schemaPath.startsWith(`${e.schemaPath}/allOf/`));
});

/**
 * @param {any} schema
 * @param {any} data
 * @returns {string[]} `keyword@instancePath` of what the filter keeps
 */
function kept(schema, data) {
  const r = /** @type {any} */ (new JarenValidator({ collectErrors: true }).compile(schema)(data));
  assert.strictEqual(r.valid, false);
  return withoutWrappers(r.errors).map((e) => `${e.keyword}@${e.instancePath}`);
}

describe('the allOf wrapper filter documented for consumers', () => {
  it('keeps the only error of a false branch', () => {
    assert.deepStrictEqual(kept({ allOf: [false] }, 1), ['allOf@']);
  });

  it('keeps a false branch beside a branch that reports its own error', () => {
    assert.deepStrictEqual(kept({ allOf: [false, { type: 'string' }] }, 1), ['allOf@', 'type@']);
  });

  it('keeps a wrapper whose own schema reported errors outside allOf', () => {
    assert.deepStrictEqual(kept({ type: 'string', allOf: [false] }, 1), ['type@', 'allOf@']);
  });

  it('drops the wrappers of failing nested branches, one issue per fault', () => {
    const schema = { allOf: [{ properties: { a: { allOf: [{ type: 'string' }, { minLength: 3 }] } } }, { required: ['b'] }] };
    assert.deepStrictEqual(kept(schema, { a: 1 }), ['type@/a', 'required@']);
  });

  it('collapses nested allOf to the innermost fault', () => {
    assert.deepStrictEqual(kept({ allOf: [{ allOf: [{ type: 'string' }] }] }, 1), ['type@']);
    assert.deepStrictEqual(kept({ allOf: [{ allOf: [false] }] }, 1), ['allOf@']);
  });

  it('hides nothing when a branch is reached through $ref, and may keep a wrapper', () => {
    assert.deepStrictEqual(kept({ $defs: { s: { type: 'string' } }, allOf: [{ $ref: '#/$defs/s' }] }, 1), ['type@', 'allOf@']);
    assert.deepStrictEqual(kept({ $defs: { f: false }, allOf: [{ $ref: '#/$defs/f' }] }, 1), ['false schema@', 'allOf@']);
  });

  it('treats each array item as its own wrapper (the items error is not an allOf wrapper)', () => {
    assert.deepStrictEqual(
      kept({ items: { allOf: [{ type: 'string' }] } }, [1, 'x', 2]),
      ['type@/0', 'type@/2', 'items@']);
  });
});
