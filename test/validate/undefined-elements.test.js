import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import { JarenValidator } from '@jarenjs/validate';

// An array element is never absent: an array holds a value at each index
// below its length, and JSON.stringify([undefined]) sends [null]. So an
// element holding `undefined` (or a hole) is read as the non-JSON value it
// is, in both modes and whatever sits beside `type`; an absent member and
// an absent root keep passing `type`.

const BOOL = { type: 'boolean' };

const MODES = [
  ['when validation stops at the first failure', new JarenValidator(), (r) => r],
  ['when errors are collected', new JarenValidator({ collectErrors: true }), (r) => r.valid],
];

function hole() {
  const array = [];
  array.length = 1;
  return array;
}

for (const [mode, jaren, answer] of MODES) {
  const valid = (schema, data) => answer(jaren.compile(schema)(data));

  describe(`an array element holding undefined, ${mode}`, () => {
    it('fails a type-only item schema, as the null JSON sends there would', () => {
      for (const schema of [{ items: BOOL }, { prefixItems: [BOOL] }, { type: 'array', items: BOOL }]) {
        assert.isFalse(valid(schema, [undefined]), JSON.stringify(schema));
        assert.isFalse(valid(schema, hole()), JSON.stringify(schema));
        assert.isTrue(valid(schema, [true]), JSON.stringify(schema));
      }
    });

    it('fails every type name, null included', () => {
      for (const type of ['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'])
        assert.isFalse(valid({ items: { type } }, [undefined]), type);
      assert.isFalse(valid({ items: { type: ['boolean', 'null'] } }, [undefined]));
      assert.isFalse(valid({ items: { type: 'string', nullable: true } }, [undefined]));
    });

    it('fails type whatever sits beside it or leads to it', () => {
      const schemas = [
        { items: { type: 'boolean', not: { const: 'x' } } },
        { items: { type: 'object', properties: { a: BOOL } } },
        { items: { type: 'array', items: BOOL } },
        { $defs: { flag: BOOL }, items: { $ref: '#/$defs/flag' } },
        { items: { allOf: [BOOL] } },
        { items: { anyOf: [BOOL, { type: 'null' }] } },
        { items: { oneOf: [BOOL, { type: 'null' }] } },
        { items: { if: true, then: BOOL } },
        { prefixItems: [true], unevaluatedItems: BOOL },
        { items: { items: BOOL } },
      ];
      for (const schema of schemas) {
        const data = schema.items?.items ? [[undefined]] : schema.prefixItems ? [1, undefined] : [undefined];
        assert.isFalse(valid(schema, data), JSON.stringify(schema));
      }
    });

    it('is held by no enum or const, and contains no match', () => {
      assert.isFalse(valid({ items: { enum: [true, false] } }, [undefined]));
      assert.isFalse(valid({ items: { enum: [{ a: 1 }, true] } }, [undefined]));
      assert.isFalse(valid({ items: { const: true } }, [undefined]));
      assert.isFalse(valid({ contains: BOOL }, [undefined]));
      assert.isTrue(valid({ contains: BOOL }, [undefined, true]));
      assert.isFalse(valid({ items: true, contains: BOOL }, [undefined]));
      // items fails the element while contains matches it
      assert.isFalse(valid({ items: BOOL, contains: { not: { const: 5 } } }, [true, undefined]));
      assert.isTrue(valid({ items: BOOL, contains: { not: { const: 5 } } }, [true, false]));
    });

    it('is tested by not, and passes the keywords that do not apply to it', () => {
      assert.isTrue(valid({ items: { not: BOOL } }, [undefined]));
      assert.isFalse(valid({ items: { not: {} } }, [undefined]));
      assert.isFalse(valid({ items: { not: true } }, [undefined]));
      assert.isTrue(valid({ items: {} }, [undefined]));
      assert.isTrue(valid({ items: { minimum: 1, minLength: 1, required: ['a'] } }, [undefined]));
    });

    it('fails a $query, which has no document to read there', () => {
      assert.isFalse(valid({ items: { $query: { $ne: ['$', 1] } } }, [undefined]));
      assert.isTrue(valid({ items: { $query: { $ne: ['$', 1] } } }, [true]));
    });

    it('leaves an absent member and an absent root passing type', () => {
      assert.isTrue(valid(BOOL, undefined));
      assert.isTrue(valid({ properties: { a: BOOL } }, { a: undefined }));
      assert.isTrue(valid({ properties: { a: BOOL } }, {}));
      assert.isTrue(valid({ additionalProperties: BOOL }, { a: undefined }));
      // the element after one holding undefined is read as before
      assert.isTrue(valid({ prefixItems: [{}, { properties: { a: BOOL } }] }, [undefined, {}]));
      assert.isTrue(valid({ items: { properties: { a: BOOL } } }, [{}]));
    });
  });
}

describe('the fault an undefined element reports when errors are collected', () => {
  const jaren = new JarenValidator({ collectErrors: true });
  const faults = (schema, data) => jaren.compile(schema)(data).errors
    .map((error) => [error.instancePath, error.keyword]);

  it('is the type at the element, then the items keyword at the array', () => {
    assert.deepStrictEqual(faults({ items: BOOL }, [true, undefined]), [['/1', 'type'], ['', 'items']]);
    assert.deepStrictEqual(faults({ prefixItems: [BOOL] }, hole()), [['/0', 'type'], ['', 'items']]);
  });

  it('is the $query assertion with the query code that refused the element', () => {
    const { errors } = jaren.compile({ items: { $query: { $ne: ['$', 1] } } })([undefined]);
    assert.strictEqual(errors[0].instancePath, '/0');
    assert.strictEqual(errors[0].keyword, '$query');
    assert.strictEqual(errors[0].params.code, 'JQ2011');
  });
});
