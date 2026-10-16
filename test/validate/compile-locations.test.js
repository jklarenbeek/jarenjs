//@ts-check
/**
 * @file Where a schema compile refusal says the refused place is: a place in
 * the document the compile was handed by its pointer into it (`#/…`), with
 * or without a root `$id`, whichever step refuses it; a place in another
 * document the validator holds, and one a call reaches inside an embedded
 * resource, by that resource's absolute URI.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { JarenValidator } from '@jarenjs/validate';

const D07 = 'http://json-schema.org/draft-07/schema#';
const D19 = 'https://json-schema.org/draft/2019-09/schema';

/**
 * The code and location of the refusal a compile, or its first call, throws.
 * @param {object} schema @param {unknown} [instance]
 * @param {JarenValidator} [validator]
 */
function refusal(schema, instance = undefined, validator = new JarenValidator()) {
  try {
    const validate = validator.compile(schema);
    if (instance !== undefined) validate(instance);
  }
  catch (e) {
    return { code: e.code, docPath: e.docPath, located: e.docPath === undefined || e.message.endsWith(` at ${e.docPath}`) };
  }
  return null;
}

describe('a compile refusal locates a place of the compiled document by its pointer', () => {
  /** Each refused member, at `/properties/a`, and the code refusing it. */
  const REFUSED = [
    [{ $query: { $bogus: 1 } }, 'JQ0002', '/%24query'],
    [{ $query: { $eq: [1] } }, 'JQ0003', '/%24query/%24eq'],
    [{ $id: 'http://[bad' }, 'JK0010', '/%24id'],
    [{ $ref: '#/nope' }, 'JK0009', '/%24ref'],
    [{ $ref: 'https://x.test/elsewhere.json' }, 'JK0009', '/%24ref'],
  ];

  for (const [root, label] of [[{}, 'without a root $id'], [{ $id: 'https://x.test/order' }, 'under an absolute root $id'], [{ $id: 'sub/order.json' }, 'under a relative root $id']]) {
    it(`spells every refusal the same way ${label}`, () => {
      assert.deepEqual(REFUSED.map(([member]) => refusal({ ...root, properties: { a: member } })),
        REFUSED.map(([, code, place]) => ({ code, docPath: `#/properties/a${place}`, located: true })));
    });
  }

  it('refuses only a place the compile or a call reads: an unreferenced malformed $dynamicRef answers', () => {
    const validate = new JarenValidator().compile({ $schema: 'https://json-schema.org/draft/2020-12/schema', $defs: { x: { $dynamicRef: 'http://[x' } }, type: 'string' });
    assert.deepEqual([validate('a'), validate(1)], [true, false]);
  });

  it('locates a draft-07 $ref whose $id beside it does not set its base (JK0008)', () => {
    assert.deepEqual(refusal({ $schema: D07, properties: { a: { $id: 'https://x.test/a.json', $ref: 'b.json' } } }),
      { code: 'JK0008', docPath: '#/properties/a/%24ref', located: true });
  });

  it('locates a refusal raised by the first call that reaches the place', () => {
    assert.deepEqual(refusal({ $schema: D19, $id: 'https://x.test/order', properties: { p: { $recursiveRef: '' } } }, { p: 1 }),
      { code: 'JK0011', docPath: '#/properties/p/%24recursiveRef', located: true });
    assert.deepEqual(refusal({ $id: 'https://x.test/order', $defs: { n: { properties: { a: { $query: { $bogus: 1 } } } } }, properties: { z: { $ref: '#/$defs/n' } } }, { z: { a: 1 } }),
      { code: 'JQ0002', docPath: '#/$defs/n/properties/a/%24query', located: true });
  });

  it('locates a place in an embedded resource or another held document by its URI', () => {
    assert.deepEqual(refusal({ $defs: { n: { $id: 'https://x.test/n', properties: { a: { $query: { $bogus: 1 } } } } }, properties: { z: { $ref: 'https://x.test/n' } } }, { z: { a: 1 } }),
      { code: 'JQ0002', docPath: 'https://x.test/n#/properties/a/%24query', located: true });
    const holding = new JarenValidator().addSchema({ $id: 'https://x.test/other', properties: { a: { $query: { $bogus: 1 } } } });
    assert.deepEqual(refusal({ $ref: 'https://x.test/other' }, { a: 1 }, holding),
      { code: 'JQ0002', docPath: 'https://x.test/other#/properties/a/%24query', located: true });
  });
});
