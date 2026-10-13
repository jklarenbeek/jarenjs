//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator, ValidationOptions, ValidationRoot } from '@jarenjs/validate';

// A `$data` reference or a `$query` reads the location of the instance it sits
// on, so a compilation that holds one has to build member and item locations.
// Only the schemas that hold a reader (or can reach one through a reference)
// need them: a sibling branch without one must not pay for the others.

const ORIGIN = 'http://paths.test/root';

/**
 * Run the compiled root validator with a location whose every use as a string
 * is counted: a branch that extends its children's locations touches it, a
 * branch that does not leaves the count alone.
 * @param {any} schema
 * @param {any} data
 * @returns {{ valid: boolean, touched: number }}
 */
function locationTouches(schema, data) {
  const schemas = new Map([[ORIGIN, schema]]);
  const root = new ValidationRoot(ORIGIN, schemas, {},
    new ValidationOptions(true, true, false, null, 2020));
  let touched = 0;
  const location = { valueOf() { touched++; return ''; }, toString() { touched++; return ''; } };
  const valid = root.unresolvedObject(ORIGIN).validate(data, location, data);
  return { valid, touched };
}

/** A branch that holds no reader: nested objects and arrays, nothing else. */
const PLAIN = {
  properties: { a: { type: 'array', items: { type: 'object', properties: { x: { type: 'string' } } } } },
};

/** @type {any} */
const READER = { minimum: { $data: '1/lo' } };

/** @type {any} */
const READER_ITEMS = { minimum: { $data: '1/0' } };

describe('which schemas build their children\'s locations', () => {
  it('a properties branch beside a reader builds none for itself', () => {
    const { valid, touched } = locationTouches({
      allOf: [
        { properties: { hi: READER } },
        { properties: { plain: PLAIN } },
      ],
    }, { lo: 1, hi: 2, plain: { a: [{ x: 'u' }] } });
    assert.equal(valid, true);
    assert.equal(touched, 1); // 'hi' only
  });

  it('a patternProperties / additionalProperties branch beside a reader builds none', () => {
    const { valid, touched } = locationTouches({
      allOf: [
        { properties: { hi: READER } },
        { patternProperties: { '^p': PLAIN }, additionalProperties: { type: 'number' } },
      ],
    }, { lo: 1, hi: 2, plain: { a: [] } });
    assert.equal(valid, true);
    assert.equal(touched, 1);
  });

  it('an items branch beside a reader builds none', () => {
    const { valid, touched } = locationTouches({
      allOf: [
        { items: { minimum: { $data: '1/0' } } },
        { items: { type: 'number' } },
      ],
    }, [1, 2, 3]);
    assert.equal(valid, true);
    assert.equal(touched, 3); // the three items of the first branch
  });

  it('a prefixItems / contains branch beside a reader builds none', () => {
    const { valid, touched } = locationTouches({
      allOf: [
        { items: { minimum: { $data: '1/0' } } },
        { prefixItems: [{ type: 'number' }], contains: { type: 'number' } },
      ],
    }, [1, 2, 3]);
    assert.equal(valid, true);
    assert.equal(touched, 3);
  });

  it('the schema forms of unevaluatedProperties and unevaluatedItems beside a reader build none', () => {
    const properties = locationTouches({
      allOf: [
        { properties: { hi: READER } },
        { properties: { lo: { type: 'number' } }, unevaluatedProperties: { type: 'number' } },
      ],
    }, { lo: 1, hi: 2 });
    assert.equal(properties.valid, true);
    assert.equal(properties.touched, 1);

    const items = locationTouches({
      allOf: [
        { items: { minimum: { $data: '1/0' } } },
        { prefixItems: [{ type: 'number' }], unevaluatedItems: { type: 'number' } },
      ],
    }, [1, 2, 3]);
    assert.equal(items.valid, true);
    assert.equal(items.touched, 3);
  });

  it('a property named like a keyword is a name, not a reader', () => {
    const { valid, touched } = locationTouches({
      allOf: [
        { properties: { hi: READER } },
        { properties: { plain: { properties: { $ref: { type: 'number' }, $data: { type: 'number' }, data: { type: 'number' } } } } },
      ],
    }, { lo: 1, hi: 2, plain: { $ref: 1, $data: 2, data: 3 } });
    assert.equal(valid, true);
    assert.equal(touched, 1);
  });

  it('a schema with no reader anywhere builds none', () => {
    const objects = locationTouches({ properties: { plain: PLAIN } }, { plain: { a: [{ x: 'u' }] } });
    assert.equal(objects.valid, true);
    assert.equal(objects.touched, 0);
    const arrays = locationTouches({ items: PLAIN, contains: { type: 'object' } }, [{ a: [] }, { a: [] }]);
    assert.equal(arrays.valid, true);
    assert.equal(arrays.touched, 0);
  });

  it('one object read as a map of names and as a schema is judged each way', () => {
    // As the `properties` map, `$ref` is a member name; as the `items` schema
    // it is a reference, which may lead to a reader.
    const shared = { $ref: {} };
    const { valid, touched } = locationTouches({
      allOf: [
        { items: READER_ITEMS },
        { properties: shared },
        { items: shared },
      ],
    }, [1, 2, 3]);
    assert.equal(valid, true);
    assert.equal(touched, 6); // the reader's three items and the shared schema's three
  });

  it('a reader in the holder\'s own keywords asks nothing of its children', () => {
    const { valid, touched } = locationTouches({
      properties: { plain: PLAIN },
      minProperties: { $data: '0/need' },
      need: 1,
    }, { plain: { a: [] }, need: 1 });
    assert.equal(touched, 0);
    assert.equal(valid, true);
  });
});

const DRAFTS = {
  7: { version: 7, uri: 'http://json-schema.org/draft-07/schema#' },
  2019: { version: 2019, uri: 'https://json-schema.org/draft/2019-09/schema' },
  2020: { version: 2020, uri: 'https://json-schema.org/draft/2020-12/schema' },
};

describe('a reader still sees its own location through every route', () => {
  /**
   * @param {any} schema
   * @param {any} good
   * @param {any} bad
   * @param {{ version: number, uri: string }} [draft]
   */
  function reads(schema, good, bad, draft = DRAFTS[2020]) {
    const declared = { $schema: draft.uri, ...schema };
    for (const options of [{}, { collectErrors: true, skipErrors: false }]) {
      const validate = new JarenValidator({ draftVersion: draft.version, ...options }).compile(declared);
      const verdict = (/** @type {any} */ data) => {
        const result = validate(data);
        return typeof result === 'boolean' ? result : result.valid;
      };
      assert.equal(verdict(good), true, `valid ${JSON.stringify(good)} under ${JSON.stringify(options)}`);
      assert.equal(verdict(bad), false, `invalid ${JSON.stringify(bad)} under ${JSON.stringify(options)}`);
    }
  }

  it('properties', () => {
    reads({ properties: { hi: READER } }, { lo: 1, hi: 2 }, { lo: 3, hi: 2 });
  });

  it('properties two levels down', () => {
    reads({ properties: { o: { properties: { hi: { minimum: { $data: '1/lo' } } } } } },
      { o: { lo: 1, hi: 2 } }, { o: { lo: 3, hi: 2 } });
  });

  it('patternProperties', () => {
    reads({ patternProperties: { '^h': READER } }, { lo: 1, hi: 2 }, { lo: 3, hi: 2 });
  });

  it('additionalProperties', () => {
    reads({ properties: { lo: {} }, additionalProperties: READER }, { lo: 1, hi: 2 }, { lo: 3, hi: 2 });
  });

  it('dependentSchemas', () => {
    reads({ dependentSchemas: { on: { properties: { hi: READER } } } },
      { on: 1, lo: 1, hi: 2 }, { on: 1, lo: 3, hi: 2 });
  });

  it('items', () => {
    reads({ items: { minimum: { $data: '1/0' } } }, [1, 2, 3], [2, 1, 3]);
  });

  it('prefixItems', () => {
    reads({ prefixItems: [{}, { minimum: { $data: '1/0' } }] }, [1, 2], [3, 2]);
  });

  it('contains', () => {
    reads({ contains: { minimum: { $data: '1/0' }, maximum: 2 } }, [1, 2], [3, 2]);
  });

  it('unevaluatedProperties, schema form', () => {
    reads({ unevaluatedProperties: { minimum: { $data: '1/lo' } } },
      { lo: 1, hi: 2 }, { lo: 3, hi: 2 });
  });

  it('unevaluatedItems, schema form', () => {
    reads({ prefixItems: [{}], unevaluatedItems: { minimum: { $data: '1/0' } } },
      [1, 2, 3], [3, 2]);
  });

  it('through $ref', () => {
    reads({ $defs: { low: READER }, properties: { hi: { $ref: '#/$defs/low' } } },
      { lo: 1, hi: 2 }, { lo: 3, hi: 2 });
  });

  it('through an applicator beside a plain sibling', () => {
    reads({ allOf: [{ properties: { plain: PLAIN } }, { properties: { hi: READER } }] },
      { lo: 1, hi: 2, plain: { a: [] } }, { lo: 3, hi: 2, plain: { a: [] } });
  });

  it('the `data` keyword', () => {
    reads({ properties: { hi: { data: { minimum: '1/lo' } } } }, { lo: 1, hi: 2 }, { lo: 3, hi: 2 });
  });

  it('a $query reading its own path', () => {
    const where = { $query: { $eq: ['$path', '/a/hi'] } };
    reads({ properties: { a: { properties: { hi: where } }, b: { properties: { hi: where } } } },
      { a: { hi: 1 } }, { b: { hi: 1 } });
  });

  // The reader sits beside the recursion, not inside the member's own keywords:
  // only following the reference finds it, and a member that is not handed its
  // location would resolve `1/lo` against the wrong object.
  const BESIDE = { allOf: [{ properties: { hi: READER } }] };
  const NESTED = { good: { lo: 1, kid: { lo: 1, hi: 2 } }, bad: { lo: 1, kid: { lo: 3, hi: 2 } } };

  it('through a recursive $ref', () => {
    reads({ ...BESIDE, properties: { kid: { $ref: '#' } } }, NESTED.good, NESTED.bad);
  });

  it('through a $dynamicRef', () => {
    reads({ $dynamicAnchor: 'node', ...BESIDE, properties: { kid: { $dynamicRef: '#node' } } },
      NESTED.good, NESTED.bad);
  });

  it('through a $recursiveRef', () => {
    reads({ $recursiveAnchor: true, ...BESIDE, properties: { kid: { $recursiveRef: '#' } } },
      NESTED.good, NESTED.bad, DRAFTS[2019]);
  });

  it('additionalItems of a draft 7 tuple', () => {
    reads({ items: [{}, {}], additionalItems: { minimum: { $data: '1/0' } } }, [1, 2, 3], [3, 2, 1], DRAFTS[7]);
  });

  it('the schema form of dependencies in draft 7', () => {
    reads({ dependencies: { on: { properties: { hi: READER } } } },
      { on: 1, lo: 1, hi: 2 }, { on: 1, lo: 3, hi: 2 }, DRAFTS[7]);
  });

  it('through an absolute $ref to a schema registered beside the root', () => {
    for (const options of [{}, { collectErrors: true, skipErrors: false }]) {
      const validator = new JarenValidator({ draftVersion: 2020, ...options });
      validator.addSchema({ $id: 'http://paths.test/low', minimum: { $data: '1/lo' } });
      const validate = validator.compile({ properties: { hi: { $ref: 'http://paths.test/low' } } });
      const verdict = (/** @type {any} */ data) => {
        const result = validate(data);
        return typeof result === 'boolean' ? result : result.valid;
      };
      assert.equal(verdict({ lo: 1, hi: 2 }), true);
      assert.equal(verdict({ lo: 3, hi: 2 }), false);
    }
  });

  it('the collected failures are the same with and without a reader elsewhere', () => {
    const cases = [
      [{ properties: { o: { properties: { x: { type: 'string' } } } } }, { o: { x: 1 } },
        [['type', '/o/x', { type: 'string' }]]],
      [{ items: { type: 'string' } }, ['a', 1],
        [['type', '/1', { type: 'string' }], ['items', '', {}]]],
      [{ prefixItems: [{}], unevaluatedItems: { type: 'string' } }, [0, 1],
        [['type', '/1', { type: 'string' }], ['unevaluatedItems', '', { unevaluatedItem: 1 }]]],
      [{ unevaluatedProperties: { type: 'string' } }, { q: 1 },
        [['type', '/q', { type: 'string' }], ['unevaluatedProperties', '', { unevaluatedProperty: 'q' }]]],
    ];
    for (const [schema, data, expected] of cases) {
      const reader = { properties: { z: { minimum: { $data: '1/y' } } } };
      const beside = { allOf: [schema, reader] };
      for (const compiled of [schema, beside]) {
        const validate = new JarenValidator({ collectErrors: true, draftVersion: 2020 }).compile(compiled);
        const result = /** @type {any} */ (validate(data));
        assert.deepEqual(
          result.errors
            .filter((/** @type {any} */ e) => e.keyword !== 'allOf')
            .map((/** @type {any} */ e) => [e.keyword, e.instancePath, e.params]),
          expected);
      }
    }
  });
});
