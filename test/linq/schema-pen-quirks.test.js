//@ts-check
/**
 * @file The schema pen's normalizer refusals (JL0102), each defect
 * reproduced before it was fixed:
 *
 * 1. `.nullable()` on a builder the pen wraps in an `anyOf` (a named, lazy
 *    or intersection builder) put a `default()`, `trim()` or `coerce()`
 *    below it into a branch the normalizer never enters: the document
 *    promised a normalization that never ran, while the same document
 *    written with `union()` or `keyword('anyOf', …)` was refused.
 * 2. `keyword('contains', …)` and `keyword('propertyNames', …)` accepted a
 *    normalization the `.contains()` and `.propertyNames()` methods refuse.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import * as s from '@jarenjs/linq/schema';
import { compileNormalizer } from '@jarenjs/validate/normalize';

/** @param {() => unknown} build */
const refusal = (build) => {
  try {
    build();
  }
  catch (err) {
    return /** @type {any} */ (err).code;
  }
  return null;
};

describe('schema pen — a normalization the normalizer never reaches is refused', () => {
  it('1. nullable() over a named, lazy or intersection builder carrying a default below is JL0102; a top-level default still runs', () => {
    const Addr = s.named('Addr', s.object({ city: s.string().default('Utrecht') }));
    assert.strictEqual(refusal(() => s.object({ addr: Addr.nullable() }).toJSON()), 'JL0102');
    const Trimmed = s.named('Trimmed', s.object({ city: s.string().trim() }));
    const lazy = s.lazy(() => Trimmed);
    assert.strictEqual(refusal(() => s.object({ addr: lazy.nullable() }).toJSON()), 'JL0102');
    const both = s.intersection([s.object({ city: s.string().default('Utrecht') }).open()]);
    assert.strictEqual(refusal(() => s.object({ addr: both.nullable() }).toJSON()), 'JL0102');
    // without the nullable wrap the default runs, as the document promises
    const doc = s.object({ addr: Addr }).toJSON();
    assert.deepStrictEqual(compileNormalizer(doc, { useDefaults: true })({ addr: {} }), { addr: { city: 'Utrecht' } });
    // a nullable wrap over nothing that normalizes is fine, and so is a default on the wrapper itself
    const Plain = s.named('Plain', s.object({ city: s.string() }));
    assert.deepStrictEqual(s.object({ addr: Plain.nullable() }).toJSON().properties.addr, { anyOf: [{ $ref: '#/$defs/Plain' }, { type: 'null' }] });
    assert.strictEqual(refusal(() => s.object({ addr: Plain.nullable().default(null) }).toJSON()), null);
  });

  it('2. keyword(\'contains\') and keyword(\'propertyNames\') refuse a normalization, as their methods do', () => {
    assert.strictEqual(refusal(() => s.array(s.string()).keyword('contains', s.string().default('x')).toJSON()), 'JL0102');
    assert.strictEqual(refusal(() => s.object({}).open().keyword('propertyNames', s.string().trim()).toJSON()), 'JL0102');
    assert.strictEqual(refusal(() => s.array(s.string()).keyword('contains', s.string().min(1)).toJSON()), null);
  });
});
