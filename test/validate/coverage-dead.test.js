import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import {
  JarenValidator,
  ValidatorOptions,
} from '@jarenjs/validate';

import {
  numberFormats,
} from '@jarenjs/formats';

// Exercises validator code paths that the JSON-Schema-Test-Suite and the
// keyword-focused unit tests leave untouched. Each `describe` block targets a
// specific reachable-but-untested function in @jarenjs/validate/src, named in a
// comment next to the construct that reaches it. Every case pairs a valid and
// an invalid instance so the path is genuinely driven, not merely compiled.

describe('Conditional schema whose branch carries a dynamic anchor', function () {
  // condition.js -> validateConditionWithDynamicAnchors
  // A `then` bearing $dynamicAnchor forces the anchor-registering branch of
  // compileConditionSchema (the simple and unevaluated-tracked paths are only
  // taken when NEITHER then nor else has a dynamic/recursive anchor).
  it('should register the then-branch $dynamicAnchor and recurse through $dynamicRef', function () {
    const validate = new JarenValidator().compile({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://example.com/cond-dynamic-anchor',
      if: { type: 'object' },
      then: {
        $dynamicAnchor: 'node',
        type: 'object',
        properties: {
          value: { type: 'number' },
          child: { $dynamicRef: '#node' },
        },
      },
      else: { type: 'number' },
    });

    // objects take the then-branch; child recurses to the registered anchor
    assert.isTrue(validate({ value: 1, child: { value: 2 } }));
    assert.isTrue(validate({ value: 1, child: { value: 2, child: { value: 3 } } }));
    assert.isFalse(validate({ value: 1, child: { value: 'nan' } }), 'nested child value must be a number');
    // non-objects take the else-branch
    assert.isTrue(validate(5), 'a number satisfies the else branch');
    assert.isFalse(validate('str'), 'a string satisfies neither branch');
  });
});

describe('Content assertion keywords (draft-07 default)', function () {
  it('accepts single digits and leading whitespace in plain and base64 JSON content', () => {
    const compiler = new JarenValidator({ contentValidation: true });
    const plain = compiler.compile({ contentMediaType: 'application/json' });
    const encoded = compiler.compile({ contentMediaType: 'application/json', contentEncoding: 'base64' });
    for (const value of ['0', '9', ' {}', '\t\r\n[1]']) {
      assert.isTrue(plain(value), JSON.stringify(value));
      assert.isTrue(encoded(Buffer.from(value).toString('base64')), JSON.stringify(value));
    }
    assert.isFalse(plain(' 01 '));
    assert.isFalse(encoded(Buffer.from(' 01 ').toString('base64')));
  });

  // For draft-07 schemas contentValidation defaults ON, so the content
  // keywords assert rather than annotate.
  const compiler = new JarenValidator();

  it('should assert a base64 contentEncoding', function () {
    // content.js -> validateBase64
    const validate = compiler.compile({ contentEncoding: 'base64' });
    assert.isTrue(validate('aGk='), 'valid base64 for "hi"');
    assert.isFalse(validate('not base64 !!'), 'spaces and ! are outside the base64 alphabet');
    assert.isTrue(validate(42), 'contentEncoding only constrains strings');
  });

  it('should assert an application/json contentMediaType', function () {
    // content.js -> validateJsonContent
    const validate = compiler.compile({ contentMediaType: 'application/json' });
    assert.isTrue(validate('{"a":1}'), 'well-formed JSON');
    assert.isFalse(validate('{bad json'), 'malformed JSON');
    assert.isTrue(validate(42), 'contentMediaType only constrains strings');
  });

  it('should assert base64-encoded application/json content', function () {
    // content.js -> validateBase64JsonContent
    const validate = compiler.compile({
      contentEncoding: 'base64',
      contentMediaType: 'application/json',
    });
    assert.isTrue(validate('eyJhIjoxfQ=='), 'base64 of {"a":1}');
    assert.isFalse(validate('bm90IGpzb24gYXQgYWxs'), 'base64 that decodes to non-JSON text');
    assert.isFalse(validate('not base64 !!'), 'not even valid base64');
    assert.isTrue(validate(42), 'only strings are constrained');
  });
});

describe('The data keyword with an unresolvable reference or numeric format', function () {
  it('should assert nothing when the data reference cannot be compiled', function () {
    // data.js -> resolveNothing (compileDataRef throws on a non-pointer ref)
    const compiler = new JarenValidator();
    const broken = compiler.compile({
      type: 'object',
      properties: {
        threshold: { type: 'number' },
        value: { type: 'number', data: { minimum: 'abc-not-a-pointer' } },
      },
    });
    // A working reference for contrast: it DOES reject value < threshold.
    const working = compiler.compile({
      type: 'object',
      properties: {
        threshold: { type: 'number' },
        value: { type: 'number', data: { minimum: '/threshold' } },
      },
    });

    assert.isFalse(working({ threshold: 100, value: 5 }), 'working ref: 5 < 100 fails minimum');
    assert.isTrue(working({ threshold: 1, value: 5 }), 'working ref: 5 >= 1 passes');
    // The broken ref resolves to "nothing", so minimum asserts nothing and the
    // same instance the working ref rejects is accepted here.
    assert.isTrue(broken({ threshold: 100, value: 5 }), 'broken ref asserts nothing');
  });

  it('should apply a number format resolved through the data keyword', function () {
    // data.js -> the mock schemaObj createErrorHandler (number format compilers
    // call createErrorHandler even under skipErrors; string formats skip it)
    const compiler = new JarenValidator();
    compiler.addFormats(numberFormats);
    const validate = compiler.compile({
      type: 'object',
      properties: {
        fmt: { type: 'string' },
        v: { type: 'string', data: { format: '/fmt' } },
      },
    });

    assert.isTrue(validate({ fmt: 'int8', v: '100' }), '100 is within int8 range');
    assert.isFalse(validate({ fmt: 'int8', v: '200' }), '200 exceeds int8 range');
    assert.isTrue(validate({ v: 'anything' }), 'an absent format reference asserts nothing');
  });
});

describe('$data references with an unresolvable pointer or numeric format', function () {
  it('should reject an uncompilable $data pointer at compile time', function () {
    // A `$data` reference that cannot be compiled used to be swallowed and
    // replaced with "resolve to nothing", which silently DISABLED the
    // constraint: the schema looked like it bounded `value` and asserted
    // nothing at all. Failing the compile is the only honest answer — the
    // author asked for a constraint and cannot be given one.
    const compiler = new JarenValidator();
    assert.throws(() => compiler.compile({
      type: 'object',
      properties: {
        limit: { type: 'number' },
        value: { type: 'number', maximum: { $data: 'abc-invalid-pointer' } },
      },
    }), 'an uncompilable $data pointer is a schema error');
  });

  it('should resolve $data pointers in all three documented forms', function () {
    // Absolute pointers are documented and were the form that silently did
    // nothing: `compileRelativeJSONPointer` rejects a leading '/', the throw
    // was caught, and the constraint evaporated.
    const compiler = new JarenValidator();
    const cases = [
      ['1/limit', 'relative'],
      ['/limit', 'absolute'],
    ];
    for (const [ref, kind] of cases) {
      const validate = compiler.compile({
        type: 'object',
        properties: {
          limit: { type: 'number' },
          value: { type: 'number', maximum: { $data: ref } },
        },
      });
      assert.isFalse(validate({ limit: 1, value: 999 }), `${kind}: 999 > 1 fails maximum`);
      assert.isTrue(validate({ limit: 999, value: 1 }), `${kind}: 1 <= 999 passes`);
    }
  });

  it('should apply a number format resolved through a $data reference', function () {
    // dollar-data.js -> the mock schemaObj createErrorHandler
    const compiler = new JarenValidator();
    compiler.addFormats(numberFormats);
    const validate = compiler.compile({
      type: 'object',
      properties: {
        fmt: { type: 'string' },
        v: { type: 'string', format: { $data: '1/fmt' } },
      },
    });

    assert.isTrue(validate({ fmt: 'uint8', v: '200' }), '200 is within uint8 range');
    assert.isFalse(validate({ fmt: 'uint8', v: '300' }), '300 exceeds uint8 range');
  });
});

describe('Self-recursive $recursiveRef entered through the dynamic scope', function () {
  // index.js -> getOutermostDynamicAnchorValidator
  // When the ROOT itself carries $recursiveAnchor: true, the initial target of
  // `$recursiveRef: '#'` has the anchor, so validateRecursiveRef consults the
  // dynamic scope (the root validator pushed on each validation) instead of the
  // plain forward-resolution fallback the $defs-based tests take.
  it('should recurse into the outermost recursive anchor (the root)', function () {
    const validate = new JarenValidator().compile({
      $schema: 'https://json-schema.org/draft/2019-09/schema',
      $id: 'https://example.com/rec-self-root',
      $recursiveAnchor: true,
      type: 'object',
      properties: {
        value: { type: 'string' },
        next: { $recursiveRef: '#' },
      },
    });

    assert.isTrue(validate({ value: 'a' }));
    assert.isTrue(validate({ value: 'a', next: { value: 'b', next: { value: 'c' } } }));
    assert.isFalse(validate({ value: 'a', next: { value: 42 } }), 'nested value must be a string');
    assert.isFalse(validate({ value: 1 }), 'top-level value must be a string');
  });
});

describe('Pre-resolved $ref evaluators reached by a backward reference', function () {
  // A $ref to an EARLIER property targets a subschema already compiled when the
  // ref compiles, so ValidationObject.compileValidator takes the pre-resolved
  // branch (root.unresolvedObject(ref) != null) rather than the deferred
  // resolveSchemaCompiler fallback used by forward references into $defs.

  it('should evaluate a backward $ref to a dynamic-anchor subschema (no siblings)', function () {
    // index.js -> validateRefWithDynamicAnchor
    const validate = new JarenValidator().compile({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://example.com/backward-dynamic',
      type: 'object',
      properties: {
        anchored: {
          $dynamicAnchor: 'thing',
          type: 'object',
          properties: { v: { type: 'number' } },
        },
        plainRef: { $ref: '#/properties/anchored' },
      },
    });

    assert.isTrue(validate({ plainRef: { v: 1 } }));
    assert.isFalse(validate({ plainRef: { v: 'x' } }), 'the referenced subschema requires v to be a number');
  });

  it('should evaluate a backward $ref to a dynamic-anchor subschema with a sibling keyword', function () {
    // index.js -> validateRefWithDynamicAnchorAndSiblings (draft 2019-09+ siblings)
    const validate = new JarenValidator().compile({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://example.com/backward-dynamic-siblings',
      type: 'object',
      properties: {
        anchored: {
          $dynamicAnchor: 'thing',
          type: 'object',
          properties: { v: { type: 'number' } },
        },
        siblingRef: { $ref: '#/properties/anchored', minProperties: 1 },
      },
    });

    assert.isTrue(validate({ siblingRef: { v: 1 } }));
    assert.isFalse(validate({ siblingRef: { v: 'x' } }), 'the $ref target still constrains v');
    assert.isFalse(validate({ siblingRef: {} }), 'the sibling minProperties keyword must also hold');
  });

  it('should evaluate a backward $ref to a plain subschema with a sibling keyword', function () {
    // index.js -> validateRefWithSiblings (no dynamic anchor on target)
    const validate = new JarenValidator().compile({
      $schema: 'https://json-schema.org/draft/2019-09/schema',
      $id: 'https://example.com/backward-plain-siblings',
      type: 'object',
      properties: {
        plain: {
          type: 'object',
          properties: { v: { type: 'number' } },
        },
        refWithSibling: { $ref: '#/properties/plain', minProperties: 1 },
      },
    });

    assert.isTrue(validate({ refWithSibling: { v: 1 } }));
    assert.isFalse(validate({ refWithSibling: { v: 'x' } }), 'the $ref target constrains v');
    assert.isFalse(validate({ refWithSibling: {} }), 'the sibling minProperties keyword must also hold');
  });
});

describe('$dynamicRef resolution variants', function () {
  it('should treat a $dynamicRef with a JSON-pointer fragment like a plain $ref', function () {
    // schema.js -> validateDynamicRefPointer (fragment is "#/..." not "#name")
    const validate = new JarenValidator().compile({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://example.com/dynref-pointer',
      type: 'object',
      properties: {
        x: { $dynamicRef: '#/$defs/num' },
      },
      $defs: { num: { type: 'number' } },
    });

    assert.isTrue(validate({ x: 1 }));
    assert.isFalse(validate({ x: 'a' }), 'the pointer target requires a number');
  });

  it('should resolve a $dynamicRef given as a full URI to a registered schema', function () {
    // schema.js -> validateDynamicRefAsRef (ref does not start with "#")
    const compiler = new JarenValidator();
    compiler.addSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://example.com/dynref-target',
      type: 'number',
    });
    const validate = compiler.compile({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://example.com/dynref-main',
      type: 'object',
      properties: {
        x: { $dynamicRef: 'https://example.com/dynref-target' },
      },
    });

    assert.isTrue(validate({ x: 1 }));
    assert.isFalse(validate({ x: 'a' }), 'the referenced schema requires a number');
  });
});

describe('String length counted as graphemes on the default validator', function () {
  // string.js -> validateStringMaxLengthGrapheme
  // A two-keyword `{ type, maxLength }` skips the single-keyword fast path, and
  // the default validator counts graphemes (useGrapheme defaults true).
  it('should count graphemes rather than UTF-16 code units for maxLength', function () {
    const validate = new JarenValidator().compile({ type: 'string', maxLength: 2 });

    assert.isTrue(validate('ab'), 'two characters');
    assert.isFalse(validate('abc'), 'three characters exceed maxLength');
    assert.isFalse(validate(42), 'the type keyword rejects non-strings');

    // A ZWJ family emoji is ONE grapheme but eight UTF-16 code units; grapheme
    // counting accepts it under maxLength 2, byte counting would not.
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    assert.isTrue(validate(family), 'a single grapheme fits under maxLength 2');

    const byteValidate = new JarenValidator(new ValidatorOptions({ useGrapheme: false }))
      .compile({ type: 'string', maxLength: 2 });
    assert.isFalse(byteValidate(family), 'counting code units the same emoji is too long');
  });
});

describe('Annotation-only unevaluated* producers under an outer check', function () {
  // With a consuming unevaluated* check elsewhere in the schema, annotation
  // tracking stays on and the pure-annotation producers must still run; a
  // producer whose sibling keywords already evaluate everything is elided
  // at compile time instead (tools.js coverage helpers).

  it('should let an inner unevaluatedProperties:true feed the outer false check', function () {
    // unevaluated.js -> validateUnevaluatedPropertiesTrue
    const validate = new JarenValidator().compile({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { foo: { type: 'string' } },
      allOf: [{ unevaluatedProperties: true }],
      unevaluatedProperties: false,
    });

    assert.isTrue(validate({ foo: 'a' }), 'declared property');
    assert.isTrue(validate({ foo: 'a', bar: 1 }), 'inner true evaluates the extra property');
    assert.isFalse(validate({ foo: 1 }), 'declared property must still be a string');
  });

  it('should let an inner items:true evaluate every item for the outer check', function () {
    // array.js -> validateArrayItemsTrue
    const validate = new JarenValidator().compile({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      allOf: [{ items: true }],
      unevaluatedItems: false,
    });

    assert.isTrue(validate([1, 'two', null]), 'inner items:true evaluates every item');
    assert.isTrue(validate([]), 'empty arrays have nothing unevaluated');

    const control = new JarenValidator().compile({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      allOf: [{ minItems: 0 }],
      unevaluatedItems: false,
    });
    assert.isFalse(control([1]), 'without the items:true producer the outer check fails');
  });
});

describe('Non-string required entries stay on the data-keys path', function () {
  // object.js -> validateRequiredOnly
  // A non-string entry (an invalid schema) can never match a data key, so
  // the Object.hasOwn fast path is skipped and the entry always fails.
  it('should never satisfy a numeric required entry', function () {
    const validate = new JarenValidator().compile({ required: ['a', 1] });

    assert.isFalse(validate({ a: 1 }), 'the numeric entry never matches');
    assert.isFalse(validate({ 'a': 1, '1': 2 }), 'a "1" data key does not match the number 1');
    assert.isTrue(validate('not an object'), 'required only constrains objects');
  });
});

describe('The errors property of a collectErrors validator', function () {
  // index.js -> the errors getter of the collectErrors compile branch
  it('should expose the internal errors of the last validation', function () {
    const validate = new JarenValidator(new ValidatorOptions({ collectErrors: true }))
      .compile({ type: 'number' });

    const bad = validate('nope');
    assert.isFalse(bad.valid);
    assert.isTrue(bad.errors.length > 0, 'the result carries converted errors');
    assert.isTrue(validate.errors.length > 0, 'the validator exposes the raw internal errors');

    const good = validate(42);
    assert.isTrue(good.valid);
    assert.isTrue(good.errors.length === 0, 'a valid result has no errors');
  });
});
