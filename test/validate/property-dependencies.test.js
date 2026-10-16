import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';

import {
  JarenValidator,
  ValidationOptions,
  ValidationRoot,
  ValidatorOptions,
  detectSchemaDraft,
} from '@jarenjs/validate';
import { collectSameDocumentAnchors } from '@jarenjs/validate/normalize';
import { hasRefSiblings } from '../../packages/validate/src/tools.js';

// The propertyDependencies proposal keyword: an object whose member holds a
// given string value validates, as a whole, against the subschema stored under
// that member name and value. It is not part of 2020-12, so it asserts only
// when the `propertyDependencies` option is on.

const MODES = [
  ['first-failure', { propertyDependencies: true }],
  ['collecting', { propertyDependencies: true, collectErrors: true, skipErrors: false }],
];

function verdict(options, schema, data) {
  const result = new JarenValidator(options).compile(schema)(data);
  return typeof result === 'object' ? result.valid : result;
}

function errors(schema, data, options = {}) {
  return new JarenValidator({ propertyDependencies: true, collectErrors: true, skipErrors: false, ...options })
    .compile(schema)(data).errors.map((e) => `${e.keyword}@${e.instancePath}`);
}

const DRAFT_2020 = 'https://json-schema.org/draft/2020-12/schema';

describe('propertyDependencies is off unless enabled', function () {
  const schema = { propertyDependencies: { foo: { aaa: { required: ['q'] } } } };

  it('is an unknown keyword by default', function () {
    assert.strictEqual(new JarenValidator().compile(schema)({ foo: 'aaa' }), true);
    assert.strictEqual(new JarenValidator({ collectErrors: true }).compile(schema)({ foo: 'aaa' }).valid, true);
  });

  it('asserts with the option, spelled on the validator', function () {
    const validate = new JarenValidator({ propertyDependencies: true }).compile(schema);
    assert.strictEqual(validate({ foo: 'aaa' }), false);
    assert.strictEqual(validate({ foo: 'aaa', q: 1 }), true);
    assert.strictEqual(validate({ foo: 'bbb' }), true);
  });

  it('asserts with the option, spelled on ValidationOptions and ValidatorOptions', function () {
    const positional = new ValidationOptions(true, true, false, null, 7, true, null, true, 'ignore', true);
    assert.strictEqual(positional.propertyDependencies, true);
    assert.strictEqual(new ValidationOptions().propertyDependencies, false);
    assert.strictEqual(new JarenValidator(new ValidatorOptions({ propertyDependencies: true })).compile(schema)({ foo: 'aaa' }), false);
    assert.strictEqual(new JarenValidator(new ValidatorOptions({ propertyDependencies: false })).compile(schema)({ foo: 'aaa' }), true);
    assert.strictEqual(new JarenValidator({ validation: positional }).compile(schema)({ foo: 'aaa' }), false);
  });

  it('asserts in a 2020-12 document and in a document with no declared draft, not in older drafts', function () {
    const on = { propertyDependencies: true };
    const bad = { foo: 'aaa' };
    assert.strictEqual(verdict(on, { ...schema, $schema: DRAFT_2020 }, bad), false);
    assert.strictEqual(verdict(on, schema, bad), false);
    assert.strictEqual(verdict(on, { ...schema, $schema: 'https://json-schema.org/draft/2019-09/schema' }, bad), true);
    assert.strictEqual(verdict(on, { ...schema, $schema: 'http://json-schema.org/draft-07/schema#' }, bad), true);
    assert.strictEqual(verdict(on, { ...schema, $schema: 'http://json-schema.org/draft-06/schema#' }, bad), true);
  });

  it('a reference into a document of an older draft does not assert it either', function () {
    const jaren = new JarenValidator({ propertyDependencies: true });
    jaren.addSchema({ $schema: 'http://json-schema.org/draft-07/schema#', $id: 'https://example.test/old', ...schema });
    const validate = jaren.compile({ $schema: DRAFT_2020, $ref: 'https://example.test/old' });
    assert.strictEqual(validate({ foo: 'aaa' }), true);
  });
});

describe('propertyDependencies is an unknown keyword wherever it is not enabled', function () {
  const NEXT = 'https://json-schema.org/draft/next/schema';
  const dangling = { propertyDependencies: { foo: { aaa: { $ref: 'https://example.test/nowhere' } } } };
  const duplicate = { propertyDependencies: { foo: { aaa: { $anchor: 'x' }, bbb: { $anchor: 'x' } } } };
  const dynamic = { $dynamicAnchor: 'x', propertyDependencies: { foo: { aaa: { $dynamicAnchor: 'x' } } } };

  it('registers nothing and compiles what an unknown keyword compiles, option off', function () {
    for (const schema of [dangling, duplicate, dynamic, { $schema: DRAFT_2020, ...dangling }, { $schema: NEXT, ...duplicate }]) {
      const validate = new JarenValidator().compile(schema);
      assert.strictEqual(validate({ foo: 'aaa' }), true);
    }
    const registered = new JarenValidator();
    registered.addSchema({ $id: 'https://example.test/off', ...duplicate });
    assert.strictEqual(registered.compile({ $ref: 'https://example.test/off' })({ foo: 'aaa' }), true);
  });

  it('registers nothing in a document of a draft that does not admit it, option on', function () {
    for (const draft of ['http://json-schema.org/draft-07/schema#', 'http://json-schema.org/draft-06/schema#',
      'https://json-schema.org/draft/2019-09/schema']) {
      for (const schema of [dangling, duplicate, dynamic]) {
        const validate = new JarenValidator({ propertyDependencies: true }).compile({ $schema: draft, ...schema });
        assert.strictEqual(validate({ foo: 'aaa' }), true, draft);
        // the declared draft is inherited by the subschemas below the document root
        const nested = new JarenValidator({ propertyDependencies: true })
          .compile({ $schema: draft, properties: { x: schema } });
        assert.strictEqual(nested({ x: { foo: 'aaa' } }), true, draft);
      }
    }
  });

  it('a $dynamicAnchor inside it is outside the dynamic scope of a document of an older draft', function () {
    const inner = { $schema: DRAFT_2020, $id: 'inner', $defs: { T: { $dynamicAnchor: 'T', type: 'number' } }, properties: { v: { $dynamicRef: '#T' } } };
    const schema = {
      $schema: 'https://json-schema.org/draft/2019-09/schema',
      $id: 'https://example.test/older',
      $ref: 'inner',
      propertyDependencies: { k: { a: { $dynamicAnchor: 'T', type: 'string' } } },
      $defs: { inner },
    };
    assert.strictEqual(new JarenValidator({ propertyDependencies: true }).compile(schema)({ v: 1 }), true);
  });

  it('a schema registered with addSchema has its propertyDependencies subschemas registered when enabled', function () {
    const registered = { $schema: DRAFT_2020, $id: 'https://example.test/reg', propertyDependencies: { k: { a: { $id: 'https://example.test/regInner', type: 'integer' } } } };
    const on = new JarenValidator({ propertyDependencies: true }).addSchema(registered);
    const validate = on.compile({ $schema: DRAFT_2020, $ref: 'https://example.test/regInner' });
    assert.strictEqual(validate(5), true);
    assert.strictEqual(validate('x'), false);
    const off = new JarenValidator().addSchema(registered);
    assert.throws(() => off.compile({ $schema: DRAFT_2020, $ref: 'https://example.test/regInner' }), /Can not resolve schema/);
  });

  it('the annotation scan reads its subschemas for location readers only when enabled', function () {
    const reader = { errorMessage: { a: { properties: { y: { minimum: { $data: '1/min' } } } } } };
    const rootOf = (propertyDependencies) => new ValidationRoot('http://paths.test/pd',
      new Map([['http://paths.test/pd', { propertyDependencies: reader }]]), {},
      new ValidationOptions(true, true, false, null, 2020, true, null, true, 'ignore', propertyDependencies));
    assert.strictEqual(rootOf(true).usesDollarData, true);
    assert.strictEqual(rootOf(false).usesDollarData, false);
  });

  it('a $ref beside it is a sibling only while enabled', function () {
    const schema = { $ref: '#/$defs/a', propertyDependencies: { k: { v: false } } };
    assert.strictEqual(hasRefSiblings(schema, true), true);
    assert.strictEqual(hasRefSiblings(schema, false), false);
    assert.strictEqual(hasRefSiblings(schema), false);
  });

  it('is walked, and its dangling and duplicate registrations refused, only when enabled', function () {
    const on = { propertyDependencies: true };
    assert.throws(() => new JarenValidator(on).compile(dangling), /Can not resolve schema/);
    assert.throws(() => new JarenValidator(on).compile(duplicate), { code: 'JK0012' });
    assert.throws(() => new JarenValidator(on).compile({ $schema: NEXT, ...duplicate }), { code: 'JK0012' });
  });

  it('collectSameDocumentAnchors walks it only when asked to', function () {
    const doc = { propertyDependencies: { kind: { a: { $anchor: 'one' } } } };
    assert.deepStrictEqual([...collectSameDocumentAnchors(doc).keys()], []);
    assert.deepStrictEqual([...collectSameDocumentAnchors(doc, { propertyDependencies: true }).keys()], ['one']);
    assert.deepStrictEqual([...collectSameDocumentAnchors({ $schema: 'http://json-schema.org/draft-07/schema#', ...doc },
      { propertyDependencies: true }).keys()], []);
    assert.deepStrictEqual([...collectSameDocumentAnchors({ $schema: NEXT, ...doc },
      { propertyDependencies: true }).keys()], ['one']);
  });

  it('a $dynamicAnchor inside it is outside the dynamic scope while off', function () {
    const inner = { $id: 'inner', $defs: { T: { $dynamicAnchor: 'T', type: 'number' } }, properties: { v: { $dynamicRef: '#T' } } };
    const schema = {
      $schema: DRAFT_2020,
      $id: 'https://example.test/outer',
      $ref: 'inner',
      propertyDependencies: { k: { a: { $dynamicAnchor: 'T', type: 'string' } } },
      $defs: { inner },
    };
    assert.strictEqual(new JarenValidator().compile(schema)({ v: 1 }), true);
    assert.strictEqual(new JarenValidator({ propertyDependencies: true }).compile(schema)({ v: 1 }), false);
  });
});

describe('propertyDependencies draft detection', function () {
  const bad = { foo: 'aaa' };
  const keyword = { propertyDependencies: { foo: { aaa: false } } };

  it('reads the draft-next dialect as 2020-12, so the keyword asserts there', function () {
    assert.strictEqual(detectSchemaDraft({ $schema: 'https://json-schema.org/draft/next/schema' }), 2020);
    assert.strictEqual(verdict({ propertyDependencies: true }, { $schema: 'https://json-schema.org/draft/next/schema', ...keyword }, bad), false);
  });

  it('keeps reading any other unknown dialect as draft 07, where the keyword is ignored', function () {
    for (const url of ['https://example.com/my-meta', 'https://json-schema.org/draft/2099-01/schema', '']) {
      assert.strictEqual(detectSchemaDraft({ $schema: url }), 7, url);
      assert.strictEqual(verdict({ propertyDependencies: true }, { $schema: url, ...keyword }, bad), true, url);
    }
  });
});

describe('propertyDependencies selects a subschema by a member string value', function () {
  const schema = {
    propertyDependencies: {
      foo: { bar: { minProperties: 2, maxProperties: 2 }, baz: { maxProperties: 1 }, qux: true, quux: false },
    },
  };

  for (const [label, options] of MODES) {
    it(`applies the whole instance to the matching subschema (${label})`, function () {
      assert.strictEqual(verdict(options, schema, { foo: 'bar', x: 1 }), true);
      assert.strictEqual(verdict(options, schema, { foo: 'bar' }), false);
      assert.strictEqual(verdict(options, schema, { foo: 'bar', x: 1, y: 2 }), false);
      assert.strictEqual(verdict(options, schema, { foo: 'baz' }), true);
      assert.strictEqual(verdict(options, schema, { foo: 'baz', x: 1 }), false);
      assert.strictEqual(verdict(options, schema, { foo: 'qux', x: 1, y: 2, z: 3 }), true);
      assert.strictEqual(verdict(options, schema, { foo: 'quux' }), false);
    });

    it(`ignores an unlisted value, an absent member and a non-string member (${label})`, function () {
      for (const data of [{ foo: 'other' }, { bar: 'quux' }, { foo: false }, { foo: 2 }, { foo: null },
        { foo: [] }, { foo: ['quux'] }, { foo: { quux: 1 } }, { foo: {} }, {}])
        assert.strictEqual(verdict(options, schema, data), true, JSON.stringify(data));
    });

    it(`ignores an instance that is not an object (${label})`, function () {
      for (const data of [true, 123, 1.5, 'quux', [], ['quux'], null])
        assert.strictEqual(verdict(options, schema, data), true, JSON.stringify(data));
      const indexed = { propertyDependencies: { 0: { aaa: false }, length: { 1: false } } };
      assert.strictEqual(verdict(options, indexed, ['aaa']), true);
      assert.strictEqual(verdict(options, indexed, 'abc'), true);
      assert.strictEqual(verdict(options, indexed, { 0: 'aaa' }), false);
    });

    it(`matches the empty string and names with a slash exactly (${label})`, function () {
      const odd = { propertyDependencies: { '': { '': false, 'a/b': { required: ['q'] } }, 'x/y': { '~': false } } };
      assert.strictEqual(verdict(options, odd, { '': '' }), false);
      assert.strictEqual(verdict(options, odd, { '': 'a/b' }), false);
      assert.strictEqual(verdict(options, odd, { '': 'a/b', q: 1 }), true);
      assert.strictEqual(verdict(options, odd, { '': 'a' }), true);
      assert.strictEqual(verdict(options, odd, { 'x/y': '~' }), false);
      assert.strictEqual(verdict(options, odd, { 'x/y': 'x/y' }), true);
    });

    it(`never reads a name off the prototype (${label})`, function () {
      const proto = { propertyDependencies: { foo: { toString: false } } };
      assert.strictEqual(verdict(options, proto, { foo: 'toString' }), false);
      for (const value of ['valueOf', 'constructor', 'hasOwnProperty', '__proto__', 'x'])
        assert.strictEqual(verdict(options, proto, { foo: value }), true, value);
      const viaJson = JSON.parse('{"propertyDependencies":{"__proto__":{"a":false},"constructor":{"b":false}}}');
      assert.strictEqual(verdict(options, viaJson, JSON.parse('{"__proto__":"a"}')), false);
      assert.strictEqual(verdict(options, viaJson, JSON.parse('{"__proto__":"b"}')), true);
      assert.strictEqual(verdict(options, viaJson, { constructor: 'b' }), false);
      assert.strictEqual(verdict(options, viaJson, {}), true);
      assert.strictEqual(verdict(options, viaJson, { a: 'a' }), true);
    });

    it(`reads the selecting member by own name only (${label})`, function () {
      const inherited = Object.create({ foo: 'quux' });
      assert.strictEqual(verdict(options, schema, inherited), true);
      assert.strictEqual(verdict(options, schema, Object.assign(Object.create({ foo: 'bar' }), { foo: 'quux' })), false);
    });

    it(`an empty keyword, empty entries and a boolean-only schema assert what they say (${label})`, function () {
      assert.strictEqual(verdict(options, { propertyDependencies: {} }, { foo: 'bar' }), true);
      assert.strictEqual(verdict(options, { propertyDependencies: { foo: {} } }, { foo: 'bar' }), true);
      assert.strictEqual(verdict(options, { propertyDependencies: { foo: { bar: true } } }, { foo: 'bar' }), true);
      assert.strictEqual(verdict(options, { propertyDependencies: { foo: { bar: false } } }, { foo: 'bar' }), false);
    });

    it(`composes with the schema it sits beside (${label})`, function () {
      const beside = {
        type: 'object',
        properties: { foo: { type: 'string' } },
        required: ['foo'],
        propertyDependencies: { foo: { a: { required: ['x'] }, b: { required: ['y'] } } },
      };
      assert.strictEqual(verdict(options, beside, { foo: 'a', x: 1 }), true);
      assert.strictEqual(verdict(options, beside, { foo: 'a', y: 1 }), false);
      assert.strictEqual(verdict(options, beside, { foo: 'b', y: 1 }), true);
      assert.strictEqual(verdict(options, beside, { x: 1 }), false);
      assert.strictEqual(verdict(options, { ...beside, properties: {} }, { foo: 'a', x: 1 }), true);
    });

    it(`works under a nested schema and inside combinators (${label})`, function () {
      const nested = {
        properties: { o: { propertyDependencies: { kind: { box: { required: ['w'] } } } } },
        anyOf: [{ propertyDependencies: { t: { n: { required: ['num'] } } } }, { required: ['alt'] }],
      };
      assert.strictEqual(verdict(options, nested, { o: { kind: 'box' }, alt: 1 }), false);
      assert.strictEqual(verdict(options, nested, { o: { kind: 'box', w: 1 }, t: 'n', num: 1 }), true);
      assert.strictEqual(verdict(options, nested, { o: { kind: 'box', w: 1 }, t: 'n' }), false);
      assert.strictEqual(verdict(options, nested, { o: { kind: 'box', w: 1 }, t: 'n', alt: 1 }), true);
    });

    it(`a reference beside the keyword keeps asserting it (${label})`, function () {
      const beside = {
        $schema: DRAFT_2020,
        $defs: { base: { type: 'object' } },
        $ref: '#/$defs/base',
        propertyDependencies: { foo: { a: { required: ['x'] } } },
      };
      assert.strictEqual(verdict(options, beside, { foo: 'a' }), false);
      assert.strictEqual(verdict(options, beside, { foo: 'a', x: 1 }), true);
      assert.strictEqual(verdict(options, beside, 'a'), false);
    });
  }

  it('stops at the first failing subschema without errors and reports every one when collecting', function () {
    const two = { propertyDependencies: { a: { x: { required: ['p'] } }, b: { y: { required: ['q'] } } } };
    assert.deepStrictEqual(errors(two, { a: 'x', b: 'y' }), ['required@', 'required@']);
    assert.deepStrictEqual(errors(two, { a: 'x', b: 'y', p: 1 }), ['required@']);
    assert.deepStrictEqual(errors(two, { a: 'x', b: 'y', p: 1, q: 1 }), []);
    assert.deepStrictEqual(errors(two, { a: 'x', b: 'z' }), ['required@']);
  });
});

describe('propertyDependencies errors and locations', function () {
  it('reports a failure at the object, like the other in-place applicators', function () {
    const schema = { propertyDependencies: { x: { on: { required: ['q'] } } } };
    assert.deepStrictEqual(errors(schema, { x: 'on' }), ['required@']);
    assert.deepStrictEqual(
      errors({ properties: { o: schema } }, { o: { x: 'on' } }),
      ['required@/o']);
    assert.deepStrictEqual(
      errors({ propertyDependencies: { x: { on: { properties: { y: { type: 'string' } } } } } }, { x: 'on', y: 1 }),
      ['type@/y']);
  });

  it('adds no error of its own and reports the message of the keyword that failed', function () {
    const result = new JarenValidator({ propertyDependencies: true, collectErrors: true, skipErrors: false })
      .compile({ propertyDependencies: { x: { on: { minProperties: 3 } } } })({ x: 'on' });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.errors.length, 1);
    assert.strictEqual(result.errors[0].keyword, 'minProperties');
    assert.strictEqual(result.errors[0].instancePath, '');
  });

  for (const [label, options] of MODES) {
    it(`resolves a relative $data reference against the object (${label})`, function () {
      const schema = { propertyDependencies: { x: { on: { properties: { y: { minimum: { $data: '1/min' } } } } } } };
      assert.strictEqual(verdict(options, schema, { x: 'on', y: 5, min: 10 }), false);
      assert.strictEqual(verdict(options, schema, { x: 'on', y: 15, min: 10 }), true);
      assert.strictEqual(verdict(options, schema, { x: 'off', y: 5, min: 10 }), true);
    });
  }
});

describe('propertyDependencies subschemas are addressable', function () {
  for (const [label, options] of MODES) {
    it(`resolves a pointer, an $anchor and an $id inside it (${label})`, function () {
      const schema = {
        $schema: DRAFT_2020,
        $id: 'https://example.test/pd',
        properties: {
          viaPointer: { $ref: '#/propertyDependencies/kind/a~1b' },
          viaAnchor: { $ref: '#picked' },
          viaId: { $ref: 'https://example.test/pd-inner' },
        },
        propertyDependencies: {
          kind: {
            'a/b': { type: 'object', required: ['marker'] },
            c: { $anchor: 'picked', type: 'string' },
            d: { $id: 'https://example.test/pd-inner', type: 'integer' },
          },
        },
      };
      assert.strictEqual(verdict(options, schema, { viaPointer: { marker: 1 } }), true);
      assert.strictEqual(verdict(options, schema, { viaPointer: {} }), false);
      assert.strictEqual(verdict(options, schema, { viaAnchor: 'text' }), true);
      assert.strictEqual(verdict(options, schema, { viaAnchor: 5 }), false);
      assert.strictEqual(verdict(options, schema, { viaId: 5 }), true);
      assert.strictEqual(verdict(options, schema, { viaId: 'text' }), false);
      assert.strictEqual(verdict(options, schema, { kind: 'c' }), false);
      assert.strictEqual(verdict(options, schema, { kind: 'd' }), false);
      assert.strictEqual(verdict(options, schema, { kind: 'a/b', marker: 1 }), true);
      assert.strictEqual(verdict(options, schema, { kind: 'a/b' }), false);
    });
  }

  it('names the location of a duplicate anchor by member name and member value', function () {
    assert.throws(() => new JarenValidator({ propertyDependencies: true }).compile({
      $schema: DRAFT_2020,
      $id: 'https://example.test/dup',
      propertyDependencies: { k: { a: { $anchor: 'x' }, 'b/c': { $anchor: 'x' } } },
    }), (error) => error.message === "JK0012: 'https://example.test/dup#x' is declared twice (first at '#/propertyDependencies/k/a/%24anchor'); give one of them another name at #/propertyDependencies/k/b~1c/%24anchor");
  });

  for (const [label, options] of MODES) {
    it(`a $dynamicAnchor inside it enters the dynamic scope of its resource (${label})`, function () {
      const inner = { $id: 'inner', $defs: { T: { $dynamicAnchor: 'T', type: 'number' } }, properties: { v: { $dynamicRef: '#T' } } };
      const inside = {
        $schema: DRAFT_2020,
        $id: 'https://example.test/outer',
        $ref: 'inner',
        propertyDependencies: { k: { a: { $dynamicAnchor: 'T', type: 'string' } } },
        $defs: { inner },
      };
      const beside = { ...inside, propertyDependencies: undefined, $defs: { inner, holder: { $dynamicAnchor: 'T', type: 'string' } } };
      for (const schema of [inside, beside]) {
        assert.strictEqual(verdict(options, schema, { v: 'x' }), true);
        assert.strictEqual(verdict(options, schema, { v: 1 }), false);
      }
    });
  }

  it('collectSameDocumentAnchors finds an $anchor inside it, at any depth of names', function () {
    const anchors = collectSameDocumentAnchors({
      propertyDependencies: { kind: { a: { $anchor: 'one' }, b: { allOf: [{ $anchor: 'two' }] } } },
    }, { propertyDependencies: true });
    assert.deepStrictEqual([...anchors.keys()], ['one', 'two']);
    assert.deepStrictEqual([...collectSameDocumentAnchors({ propertyDependencies: { $anchor: { $anchor: 'nope' } } },
      { propertyDependencies: true }).keys()], []);
  });

  it('names that look like keywords are names, not keywords', function () {
    const options = { propertyDependencies: true };
    const schema = { propertyDependencies: { $ref: { $id: { type: 'string' }, $anchor: false } } };
    assert.strictEqual(verdict(options, schema, { $ref: '$id' }), false);
    assert.strictEqual(verdict(options, schema, { $ref: '$anchor' }), false);
    assert.strictEqual(verdict(options, schema, { $ref: 'x' }), true);
    assert.strictEqual(verdict(options, schema, { $id: '$ref' }), true);
  });

  it('a member named like a keyword that is not walked still holds subschemas that are', function () {
    const options = { propertyDependencies: true };
    for (const name of ['$query', 'errorMessage']) {
      const schema = { propertyDependencies: { [name]: { a: { properties: { y: { minimum: { $data: '1/min' } } } } } } };
      assert.strictEqual(verdict(options, schema, { [name]: 'a', y: 5, min: 10 }), false, name);
      assert.strictEqual(verdict(options, schema, { [name]: 'a', y: 15, min: 10 }), true, name);
    }
  });
});

describe('propertyDependencies annotations', function () {
  for (const [label, options] of MODES) {
    it(`a matching subschema evaluates members for unevaluatedProperties (${label})`, function () {
      const schema = {
        properties: { foo: { type: 'string' } },
        propertyDependencies: { foo: { foo1: { properties: { bar: true } } } },
        unevaluatedProperties: false,
      };
      assert.strictEqual(verdict(options, schema, { foo: 'foo1', bar: 42 }), true);
      assert.strictEqual(verdict(options, schema, { foo: 'foo2', bar: 42 }), false);
      assert.strictEqual(verdict(options, schema, { bar: 42 }), false);
      assert.strictEqual(verdict(options, schema, { foo: 'foo1', baz: 42 }), false);
    });

    it(`a subschema that fails contributes no annotations (${label})`, function () {
      const schema = {
        anyOf: [
          { propertyDependencies: { foo: { a: { properties: { extra: true }, required: ['nope'] } } } },
          { properties: { foo: true } },
        ],
        unevaluatedProperties: false,
      };
      assert.strictEqual(verdict(options, schema, { foo: 'a', extra: 1 }), false);
      assert.strictEqual(verdict(options, schema, { foo: 'a' }), true);
    });

    it(`it is invisible to additionalProperties (${label})`, function () {
      const schema = {
        properties: { foo2: {} },
        propertyDependencies: { foo2: { bar: { properties: { buz: {} } } } },
        additionalProperties: false,
      };
      assert.strictEqual(verdict(options, schema, { foo2: 'bar', buz: '' }), false);
      assert.strictEqual(verdict(options, schema, { foo2: 'bar' }), true);
    });

    it(`a nested unevaluatedProperties inside a subschema is tracked (${label})`, function () {
      const schema = {
        propertyDependencies: { kind: { box: { properties: { kind: true, w: true }, unevaluatedProperties: false } } },
      };
      assert.strictEqual(verdict(options, schema, { kind: 'box', w: 1 }), true);
      assert.strictEqual(verdict(options, schema, { kind: 'box', w: 1, h: 2 }), false);
      assert.strictEqual(verdict(options, schema, { kind: 'other', w: 1, h: 2 }), true);
    });
  }
});

describe('propertyDependencies with malformed values', function () {
  it('is ignored while off, refused while on', function () {
    for (const schema of [
      { propertyDependencies: { foo: 1 } },
      { propertyDependencies: { foo: [] } },
      { propertyDependencies: { foo: { bar: 1 } } },
      { propertyDependencies: { foo: { bar: 'x' } } },
    ]) {
      assert.strictEqual(new JarenValidator().compile(schema)({ foo: 'bar' }), true);
      assert.throws(() => new JarenValidator({ propertyDependencies: true }).compile(schema), /Expected (Object|Schema)/);
    }
    assert.strictEqual(new JarenValidator({ propertyDependencies: true }).compile({ propertyDependencies: [] })({ foo: 'bar' }), true);
    assert.strictEqual(new JarenValidator({ propertyDependencies: true }).compile({ propertyDependencies: 'x' })({ foo: 'bar' }), true);
  });
});

// The draft-next suite files carry the keyword's conformance cases, vendored
// under fixtures/ (PROVENANCE.md there). The benchmark loader does not run that folder, so they run here with the option
// on, in both modes, exactly as written (the draft-next dialect is read as
// 2020-12).
const SUITE = new URL('./fixtures/property-dependencies/', import.meta.url);
const NEXT_SCHEMA = 'https://json-schema.org/draft/next/schema';

function suiteGroups(file) {
  const groups = JSON.parse(readFileSync(new URL(file, SUITE), 'utf8'));
  return file === 'propertyDependencies.json'
    ? groups
    : groups.filter((g) => JSON.stringify(g.schema).includes('"propertyDependencies"'));
}

// draft-next dropped 2020-12's bookending rule (a $dynamicRef needs an
// outermost $dynamicAnchor of the same name in the resource that holds it); this
// package implements the 2020-12 rule, so the one case written without the
// bookend gets it back. The same schema built with if/then fails identically
// without it: it is the dynamic-scope rule, not the keyword.
function bookended(schema) {
  const generic = schema.$defs?.genericList;
  if (schema.$schema !== NEXT_SCHEMA || generic === undefined || generic.$defs !== undefined) return schema;
  return { ...schema, $defs: { ...schema.$defs, genericList: { ...generic, $defs: { defaultItemType: { $dynamicAnchor: 'itemType' } } } } };
}

describe('propertyDependencies conformance (draft-next suite)', function () {
  for (const file of ['propertyDependencies.json', 'unevaluatedProperties.json', 'additionalProperties.json', 'dynamicRef.json']) {
    const groups = suiteGroups(file);
    it(`${file} carries cases`, function () {
      assert.ok(groups.length > 0);
    });
    for (const [label, options] of MODES) {
      for (const group of groups) {
        for (const test of group.tests) {
          it(`${file}: ${group.description}: ${test.description} (${label})`, function () {
            assert.strictEqual(verdict(options, bookended(group.schema), test.data), test.valid);
          });
        }
      }
    }
  }

  it('the same cases are the unknown-keyword behaviour while the option is off', function () {
    const group = suiteGroups('propertyDependencies.json').find((g) => g.description === 'multiple options selects the right one');
    const validate = new JarenValidator().compile(group.schema);
    for (const test of group.tests)
      assert.strictEqual(validate(test.data), true, test.description);
  });
});
