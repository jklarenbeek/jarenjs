//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JarenValidator, ValidatorOptions, ValidationOptions, SchemaCompileError, VALIDATE_CODES } from '@jarenjs/validate';
import { stringFormats } from '@jarenjs/formats';
import { getSchemaDraftByName } from '@jarenjs/refs';
import { flagOutput, basicOutput, detailedOutput, verboseOutput, listOutput, hierarchicalOutput } from '@jarenjs/validate/output';

/** The formats by their specification names. @type {Record<string, any>} */
const FORMATS = { flag: flagOutput, basic: basicOutput, detailed: detailedOutput, verbose: verboseOutput, list: listOutput, hierarchical: hierarchicalOutput };

const fixtures = new URL('./fixtures/output-formats/', import.meta.url);
/** @param {string} name @returns {any} */
const fixture = (name) => JSON.parse(fs.readFileSync(new URL(name, fixtures), 'utf8'));
const S = 'https://json-schema.org/draft/2020-12/schema';

/**
 * Compile `schema` for one output format and validate `data`.
 * @param {string} outputFormat
 * @param {any} schema
 * @param {unknown} data
 * @param {object} [options]
 * @returns {any}
 */
const output = (outputFormat, schema, data, options = {}) =>
  new JarenValidator(/** @type {any} */ ({ outputFormat: FORMATS[outputFormat], ...options })).compile(schema)(data);

/**
 * The message wording is the implementation's (both specifications say so):
 * replace every message with a placeholder.
 * @param {any} value
 * @returns {any}
 */
function withoutMessages(value) {
  if (Array.isArray(value)) return value.map(withoutMessages);
  if (value === null || typeof value !== 'object') return value;
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key === 'error' && typeof inner === 'string') out[key] = '<message>';
    else if (key === 'errors' && !Array.isArray(inner)) out[key] = Object.fromEntries(Object.keys(inner).map((k) => [k, '<message>']));
    else out[key] = withoutMessages(inner);
  }
  return out;
}

/**
 * Units are equivalent in any order (both specifications say so): sort
 * every list of units by its locations.
 * @param {any} value
 * @returns {any}
 */
function sortedUnits(value) {
  if (Array.isArray(value)) {
    const key = (/** @type {any} */ u) => `${u.evaluationPath ?? u.keywordLocation} ${u.instanceLocation}`;
    return value.map(sortedUnits).sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  }
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sortedUnits(v)]));
}

/** @param {any} value @param {string} key @returns {any} */
function without(value, key) {
  if (Array.isArray(value)) return value.map((v) => without(v, key));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== key).map(([k, v]) => [k, without(v, key)]));
}

describe('the outputFormat option', () => {
  it('is refused JK0003 when a schema compiles, naming the formats and the value', () => {
    const validator = new JarenValidator(/** @type {any} */ ({ outputFormat: 'hierarchichal' }));
    assert.throws(() => validator.compile({ type: 'string' }), (/** @type {any} */ err) => {
      assert.ok(err instanceof SchemaCompileError);
      assert.equal(err.code, 'JK0003');
      assert.equal(err.message, "JK0003: outputFormat takes a format of '@jarenjs/validate/output', got 'hierarchichal'");
      return true;
    });
    // A format's name is not a format: the formats live behind the subpath.
    assert.throws(() => new JarenValidator(/** @type {any} */ ({ outputFormat: 'list' })).compile({}),
      /JK0003: outputFormat takes a format of '@jarenjs\/validate\/output', got 'list'$/);
    assert.throws(() => new JarenValidator(/** @type {any} */ ({ outputFormat: 3 })).compile({}),
      /JK0003: outputFormat takes a format of '@jarenjs\/validate\/output', got number$/);
    assert.throws(() => new JarenValidator(/** @type {any} */ ({ outputFormat: null })).compile({}), /JK0003: .*, got object$/);
    assert.equal(VALIDATE_CODES.JK0003, 'outputFormat is not a format of @jarenjs/validate/output');
  });

  it('is read from a ValidationOptions passed positionally', () => {
    const validation = new ValidationOptions(true, true, false, null, 7, true, null, true, 'ignore', false, 'handrews-01', 256, flagOutput);
    const validator = new JarenValidator(new ValidatorOptions({ validation }));
    assert.deepEqual(validator.compile({ type: 'string' })(1), { valid: false });
  });

  it('takes precedence over collectErrors', () => {
    assert.deepEqual(output('list', { $id: 'https://ex.test/app', type: 'string' }, 1, { collectErrors: true }), {
      valid: false,
      details: [{ valid: false, evaluationPath: '', schemaLocation: 'https://ex.test/app#', instanceLocation: '', errors: { type: 'must be a string' } }],
    });
  });

  it('answers flag with the boolean validator, which stops at the first failure', () => {
    let calls = 0;
    const formats = { counted: () => () => { calls++; return true; } };
    const schema = { allOf: [{ type: 'number' }, { format: 'counted' }] };
    assert.deepEqual(output('flag', schema, 'a', { collectErrors: true, formatAssertion: true, formats }), { valid: false });
    assert.equal(calls, 0);
    // the collecting validator goes on to the second branch
    assert.equal(new JarenValidator({ collectErrors: true, formatAssertion: true, formats }).compile(schema)('a').valid, false);
    assert.equal(calls, 1);
  });

  it('leaves the default and the collecting outputs as they were', () => {
    const schema = fixture('spec-2020-12.json').schema;
    const data = fixture('spec-2020-12.json').instance;
    assert.equal(new JarenValidator().compile(schema)(data), false);
    assert.deepEqual(JSON.parse(JSON.stringify(new JarenValidator({ collectErrors: true }).compile(schema)(data))), {
      valid: false,
      errors: [
        { keyword: 'minItems', instancePath: '', schemaPath: 'https://example.com/polygon#', params: { limit: 3 }, msgid: 'minItems', message: 'must NOT have fewer than 3 items' },
        { keyword: 'required', instancePath: '/1', schemaPath: 'https://example.com/polygon#/$defs/point', params: { missingProperty: 'y' }, msgid: 'required', message: "must have required property 'y'" },
        { keyword: 'additionalProperties', instancePath: '/1/z', schemaPath: 'https://example.com/polygon#/$defs/point', params: { additionalProperty: 'z' }, msgid: 'additionalProperties', message: "must NOT have additional property 'z'" },
        { keyword: 'items', instancePath: '', schemaPath: 'https://example.com/polygon#', params: {}, msgid: 'items', message: 'array items are invalid' },
      ],
    });
  });

  it('keeps validateSchema a boolean', () => {
    const meta = getSchemaDraftByName('draft2020-12');
    const validator = new JarenValidator({ outputFormat: hierarchicalOutput }).addMetaSchema(meta.schema, meta.draft);
    assert.equal(validator.validateSchema({ $schema: S, type: 'string' }), true);
    assert.equal(validator.validateSchema({ $schema: S, type: 12 }), false);
  });

  it('answers every format as the boolean validator does', () => {
    // Every case of the vendored reference suites, in every format.
    const dir = new URL('./fixtures/recursive-refs/', import.meta.url);
    const remotes = ['detached-dynamicref.json', 'extendible-dynamic-ref.json', 'tree.json'].map((name) => [
      `http://localhost:1234/draft2020-12/${name}`,
      JSON.parse(fs.readFileSync(new URL(`remotes/draft2020-12/${name}`, dir), 'utf8'))]);
    const build = (/** @type {object} */ options) => {
      const validator = new JarenValidator(options);
      for (const name of ['draft7', 'draft2019-09', 'draft2020-12']) {
        const meta = getSchemaDraftByName(name);
        validator.addMetaSchema(meta.schema, meta.draft);
      }
      for (const [id, schema] of remotes) validator.addSchema(schema, id + '#');
      return validator;
    };
    const formats = Object.keys(FORMATS);
    const booleanValidator = build({});
    const outputValidators = formats.map((name) => build({ outputFormat: FORMATS[name] }));
    let cases = 0;
    for (const file of ['draft2020-12-ref.json', 'draft2020-12-dynamicRef.json', 'draft2019-09-recursiveRef.json', 'draft7-ref.json']) {
      for (const group of JSON.parse(fs.readFileSync(new URL(file, dir), 'utf8'))) {
        const boolean = booleanValidator.compile(group.schema);
        const outputs = outputValidators.map((validator) => validator.compile(group.schema));
        for (const test of group.tests) {
          const expected = boolean(test.data);
          assert.equal(expected, test.valid, `${file}: ${group.description}: ${test.description}`);
          for (let i = 0; i < formats.length; i++)
            assert.equal(outputs[i](test.data).valid, expected, `${formats[i]} ${file}: ${group.description}: ${test.description}`);
          cases++;
        }
      }
    }
    assert.equal(cases, 231);
  });
});

describe('the 2020-12 output formats against the specification\'s examples', () => {
  const spec = fixture('spec-2020-12.json');

  it('flag', () => {
    assert.deepEqual(output('flag', spec.schema, spec.instance), spec.flag);
  });

  it('basic: every unit of the example, its branch units included, each with its valid', () => {
    const actual = output('basic', spec.schema, spec.instance);
    const expected = { valid: false, errors: spec.basic.errors.map((/** @type {any} */ u) => ({ valid: false, ...u })) };
    assert.deepEqual(withoutMessages(sortedUnits(actual)), withoutMessages(sortedUnits(expected)));
    // The branch units carry the example's own words.
    const branches = (/** @type {any} */ out) => out.errors.filter((/** @type {any} */ u) => u.error === 'A subschema had errors.');
    assert.deepEqual(branches(actual), branches(expected));
    assert.deepEqual(actual, {
      valid: false,
      errors: [
        { valid: false, keywordLocation: '', instanceLocation: '', error: 'A subschema had errors.' },
        { valid: false, keywordLocation: '/items/$ref', absoluteKeywordLocation: 'https://example.com/polygon#/$defs/point', instanceLocation: '/1', error: 'A subschema had errors.' },
        { valid: false, keywordLocation: '/items/$ref/additionalProperties', absoluteKeywordLocation: 'https://example.com/polygon#/$defs/point/additionalProperties', instanceLocation: '/1/z', error: "must NOT have additional property 'z'" },
        { valid: false, keywordLocation: '/items/$ref/required', absoluteKeywordLocation: 'https://example.com/polygon#/$defs/point/required', instanceLocation: '/1', error: "must have required property 'y'" },
        { valid: false, keywordLocation: '/minItems', instanceLocation: '', error: 'must NOT have fewer than 3 items' },
      ],
    });
  });

  it('basic: a branch unit\'s message follows the messages option, as every unit\'s does', () => {
    assert.deepEqual(output('basic', spec.schema, spec.instance, { messages: false }).errors.map((/** @type {any} */ u) => [u.keywordLocation, u.error]), [
      ['', ''], ['/items/$ref', ''], ['/items/$ref/additionalProperties', ''], ['/items/$ref/required', ''], ['/minItems', ''],
    ]);
  });

  it('detailed', () => {
    const actual = output('detailed', spec.schema, spec.instance);
    assert.deepEqual(withoutMessages(sortedUnits(actual)), withoutMessages(sortedUnits(spec.detailed)));
  });

  it('verbose', () => {
    assert.deepEqual(withoutMessages(output('verbose', spec.verboseSchema, spec.verboseInstance)), withoutMessages(spec.verbose));
  });
});

describe('the list and hierarchical formats against the specification\'s examples', () => {
  const spec = fixture('spec-output.json');

  it('flag', () => {
    assert.deepEqual(output('flag', spec.schema, spec.failingInstance), spec.flag);
  });

  it('list, failing and passing', () => {
    const failing = output('list', spec.schema, spec.failingInstance);
    assert.deepEqual(without(withoutMessages(sortedUnits(failing)), 'droppedAnnotations'), withoutMessages(sortedUnits(spec.listFailing)));
    assert.deepEqual(sortedUnits(output('list', spec.schema, spec.passingInstance)), sortedUnits(spec.listPassing));
  });

  it('hierarchical, failing and passing', () => {
    const failing = output('hierarchical', spec.schema, spec.failingInstance);
    assert.deepEqual(without(withoutMessages(failing), 'droppedAnnotations'), without(withoutMessages(spec.hierarchicalFailing), 'droppedAnnotations'));
    assert.deepEqual(output('hierarchical', spec.schema, spec.passingInstance), spec.hierarchicalPassing);
  });

  it('drops the annotations of every failed unit into droppedAnnotations', () => {
    // The example shows some of them: none at the root, and no
    // `additionalProperties` at /properties/foo/allOf/1. Every failed unit
    // reports what its own keywords produced.
    const dropped = [];
    const visit = (/** @type {any} */ unit) => {
      if (unit.droppedAnnotations) dropped.push([unit.evaluationPath, unit.droppedAnnotations]);
      (unit.details ?? []).forEach(visit);
    };
    visit(output('hierarchical', spec.schema, spec.failingInstance));
    assert.deepEqual(dropped, [
      ['', { title: 'root', properties: ['foo', 'bar'] }],
      ['/properties/foo/allOf/1', { title: 'foo-title', properties: ['foo-prop'], additionalProperties: ['other-prop'] }],
      ['/properties/foo/allOf/1/properties/foo-prop', { title: 'foo-prop-title' }],
      ['/properties/bar/$ref', { title: 'bar-title', properties: ['bar-prop'] }],
      ['/properties/bar/$ref/properties/bar-prop', { title: 'bar-prop-title' }],
    ]);
  });
});

describe('the JSON-Schema-Test-Suite output tests', () => {
  for (const [draft, format] of [['draft2020-12', 'basic'], ['draft-next', 'list']]) {
    it(`${draft}: every case's ${format} output satisfies the suite's schema`, () => {
      const outputSchema = fixture(`suite-${draft}-output-schema.json`);
      let cases = 0;
      for (const name of ['escape', 'general', 'readOnly', 'type']) {
        const file = `suite-${draft}-${name}.json`;
        if (!fs.existsSync(new URL(file, fixtures))) continue;
        for (const group of fixture(file)) {
          for (const test of group.tests) {
            const actual = output(format, group.schema, test.data);
            assert.equal(typeof actual, 'object');
            assert.ok(format === 'list' ? Array.isArray(actual.details) : Array.isArray(actual.errors ?? actual.annotations));
            const check = new JarenValidator().addSchema(outputSchema).compile(test.output[format]);
            assert.equal(check(actual), true, `${file}: ${group.description}: ${JSON.stringify(actual)}`);
            cases++;
          }
        }
      }
      assert.equal(cases, draft === 'draft2020-12' ? 4 : 3);
    });
  }
});

describe('the README example', () => {
  it('returns the list and basic outputs the README prints', () => {
    const readme = fs.readFileSync(new URL('../../packages/validate/README.md', import.meta.url), 'utf8');
    const section = readme.slice(readme.indexOf('## Standard output formats'), readme.indexOf('## Normalization'));
    const fences = [...section.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
    assert.equal(fences.length, 4);
    const [schema, order, list, basic] = fences;
    assert.deepEqual(output('list', schema, order), list);
    assert.deepEqual(output('basic', schema, order), basic);
  });
});

describe('output units', () => {
  it('follow $ref and $dynamicRef in the evaluation path and name the subschema reached', () => {
    const validator = new JarenValidator({ outputFormat: listOutput });
    validator.addSchema({ $schema: S, $id: 'https://ex.test/list', type: 'array', items: { $dynamicRef: '#itemType' }, $defs: { itemType: { $dynamicAnchor: 'itemType' } } });
    const strings = validator.compile({ $schema: S, $id: 'https://ex.test/strings', $ref: 'list', $defs: { s: { $dynamicAnchor: 'itemType', type: 'string' } } });
    assert.deepEqual(strings(['a', 1]), {
      valid: false,
      details: [{ valid: false, evaluationPath: '/$ref/items/$dynamicRef', schemaLocation: 'https://ex.test/strings#/$defs/s', instanceLocation: '/1', errors: { type: 'must be a string' } }],
    });
  });

  it('follow a $ref between registered documents', () => {
    // Registered documents are compiled before the schema that refers to
    // them, so the reference from one to the other finds its target built.
    const validator = new JarenValidator({ outputFormat: listOutput });
    validator.addSchema({ $schema: S, $id: 'https://ex.test/b', type: 'number' });
    validator.addSchema({ $schema: S, $id: 'https://ex.test/a', properties: { x: { $ref: 'b' } } });
    assert.deepEqual(validator.compile({ $schema: S, $ref: 'https://ex.test/a' })({ x: 'q' }), {
      valid: false,
      details: [{ valid: false, evaluationPath: '/$ref/properties/x/$ref', schemaLocation: 'https://ex.test/b#', instanceLocation: '/x', errors: { type: 'must be a number' } }],
    });
  });

  it('keep the hop of a reference resolved on first use after it was first taken', () => {
    // `/properties/x` resolves its `$ref` on first use; the `$dynamicRef`
    // reaches the same subschema afterwards and must still pass the hop.
    const schema = { $schema: S, $id: 'https://ex.test/t', properties: { x: { $ref: '#' }, y: { $dynamicRef: '#/properties/x' }, n: { type: 'number' } } };
    assert.deepEqual(output('list', schema, { x: { n: 'a' }, y: { n: 'b' } }).details.map((/** @type {any} */ u) => [u.evaluationPath, u.instanceLocation]), [
      ['/properties/x/$ref/properties/n', '/x/n'],
      ['/properties/y/$dynamicRef/$ref/properties/n', '/y/n'],
    ]);
  });

  it('pass every hop of a chain of $ref-only schemas', () => {
    // The validator resolves such a chain to its final target when the
    // schemas are registered; the output still names each hop.
    const schema = { $schema: S, $id: 'https://ex.test/c', properties: { a: { $ref: '#/$defs/m' } }, $defs: { m: { $ref: '#/$defs/n' }, n: { type: 'number' } } };
    assert.deepEqual(output('list', schema, { a: 'q' }).details.map((/** @type {any} */ u) => [u.evaluationPath, u.schemaLocation]), [
      ['/properties/a/$ref/$ref', 'https://ex.test/c#/$defs/n'],
    ]);
    const hop = output('hierarchical', schema, { a: 'q' }).details[0].details[0];
    assert.deepEqual([hop.evaluationPath, hop.schemaLocation, hop.valid, hop.errors], ['/properties/a/$ref', 'https://ex.test/c#/$defs/m', false, undefined]);
    assert.deepEqual(output('basic', schema, { a: 'q' }).errors, [
      { valid: false, keywordLocation: '/properties/a/$ref/$ref/type', absoluteKeywordLocation: 'https://ex.test/c#/$defs/n/type', instanceLocation: '/a', error: 'must be a number' },
    ]);
  });

  it('follow $recursiveRef', () => {
    assert.deepEqual(output('list', { $schema: 'https://json-schema.org/draft/2019-09/schema', $id: 'https://ex.test/tree', $recursiveAnchor: true, type: 'object', properties: { kid: { $recursiveRef: '#' }, v: { type: 'number' } } }, { kid: { v: 'x' } }), {
      valid: false,
      details: [{ valid: false, evaluationPath: '/properties/kid/$recursiveRef/properties/v', schemaLocation: 'https://ex.test/tree#/properties/v', instanceLocation: '/kid/v', errors: { type: 'must be a number' } }],
    });
  });

  it('name a schema reached by an anchor, or inside an embedded resource, by its JSON Pointer location', () => {
    assert.deepEqual(output('list', { $schema: S, $id: 'https://ex.test/app', properties: { x: { $ref: '#num' }, y: { $id: 'https://ex.test/inner', type: 'number' } }, $defs: { n: { $anchor: 'num', type: 'number' } } }, { x: 'q', y: 'r' }), {
      valid: false,
      details: [
        { valid: false, evaluationPath: '/properties/x/$ref', schemaLocation: 'https://ex.test/app#/$defs/n', instanceLocation: '/x', errors: { type: 'must be a number' } },
        { valid: false, evaluationPath: '/properties/y', schemaLocation: 'https://ex.test/inner#', instanceLocation: '/y', errors: { type: 'must be a number' } },
      ],
    });
  });

  it('escape member names in every location', () => {
    assert.deepEqual(output('list', { $schema: S, $id: 'https://ex.test/app', properties: { '~a/b': { type: 'number' } } }, { '~a/b': 'x' }).details, [
      { valid: false, evaluationPath: '/properties/~0a~1b', schemaLocation: 'https://ex.test/app#/properties/~0a~1b', instanceLocation: '/~0a~1b', errors: { type: 'must be a number' } },
    ]);
  });

  it('report annotations of every passing anyOf branch, never of a failing one', () => {
    const schema = { $schema: S, $id: 'https://ex.test/app', anyOf: [{ type: 'string', title: 's' }, { minLength: 2, title: 'long' }, { type: 'number', title: 'n' }] };
    assert.deepEqual(output('list', schema, 'abc').details, [
      { valid: true, evaluationPath: '/anyOf/0', schemaLocation: 'https://ex.test/app#/anyOf/0', instanceLocation: '', annotations: { title: 's' } },
      { valid: true, evaluationPath: '/anyOf/1', schemaLocation: 'https://ex.test/app#/anyOf/1', instanceLocation: '', annotations: { title: 'long' } },
    ]);
    // hierarchical keeps the failed branch, with its errors and its dropped annotation
    assert.deepEqual(output('hierarchical', schema, 'abc').details[2], {
      valid: false, evaluationPath: '/anyOf/2', schemaLocation: 'https://ex.test/app#/anyOf/2', instanceLocation: '', errors: { type: 'must be a number' }, droppedAnnotations: { title: 'n' },
    });
  });

  it('drop the annotations of a passing subschema inside a failed one', () => {
    const schema = { $schema: S, $id: 'https://ex.test/app', properties: { a: { title: 'A' } }, required: ['b'] };
    assert.deepEqual(output('hierarchical', schema, { a: 1 }), {
      valid: false, evaluationPath: '', schemaLocation: 'https://ex.test/app#', instanceLocation: '',
      errors: { required: "must have required property 'b'" }, droppedAnnotations: { properties: ['a'] },
      details: [{ valid: true, evaluationPath: '/properties/a', schemaLocation: 'https://ex.test/app#/properties/a', instanceLocation: '/a' }],
    });
    assert.deepEqual(output('verbose', schema, { a: 1 }), {
      valid: false, keywordLocation: '', instanceLocation: '',
      errors: [
        { valid: true, keywordLocation: '/properties', instanceLocation: '', annotations: [{ valid: true, keywordLocation: '/properties/a', instanceLocation: '/a', annotations: [{ valid: true, keywordLocation: '/properties/a/title', instanceLocation: '/a' }] }] },
        { valid: false, keywordLocation: '/required', instanceLocation: '', error: "must have required property 'b'" },
      ],
    });
  });

  it('explain an applicator failure by the failed subschemas, or by the keyword where none failed', () => {
    const app = (/** @type {object} */ schema) => ({ $schema: S, $id: 'https://ex.test/app', ...schema });
    const root = (/** @type {object} */ errors) => ({ valid: false, evaluationPath: '', schemaLocation: 'https://ex.test/app#', instanceLocation: '', errors });
    assert.deepEqual(output('list', app({ oneOf: [{ type: 'string' }, { minLength: 1 }] }), 'a').details, [root({ oneOf: 'must match exactly one subschema in oneOf' })]);
    assert.deepEqual(output('list', app({ not: { type: 'string' } }), 'a').details, [root({ not: 'must NOT match the subschema' })]);
    assert.deepEqual(output('list', app({ allOf: [{ minimum: 2 }, { maximum: 0 }] }), 1).details, [
      { valid: false, evaluationPath: '/allOf/0', schemaLocation: 'https://ex.test/app#/allOf/0', instanceLocation: '', errors: { minimum: 'must be >= 2' } },
      { valid: false, evaluationPath: '/allOf/1', schemaLocation: 'https://ex.test/app#/allOf/1', instanceLocation: '', errors: { maximum: 'must be <= 0' } },
    ]);
    assert.deepEqual(output('list', app({ anyOf: [{ type: 'string' }, { type: 'number' }] }), null).details, [
      root({ anyOf: 'must match a subschema in anyOf' }),
      { valid: false, evaluationPath: '/anyOf/0', schemaLocation: 'https://ex.test/app#/anyOf/0', instanceLocation: '', errors: { type: 'must be a string' } },
      { valid: false, evaluationPath: '/anyOf/1', schemaLocation: 'https://ex.test/app#/anyOf/1', instanceLocation: '', errors: { type: 'must be a number' } },
    ]);
  });

  it('report the branch of if/then/else that decided, not the condition', () => {
    const schema = { $schema: S, $id: 'https://ex.test/app', if: { type: 'string', title: 'cond' }, then: { minLength: 3 }, else: { minimum: 0 } };
    assert.deepEqual(output('list', schema, 'ab').details, [
      { valid: false, evaluationPath: '/then', schemaLocation: 'https://ex.test/app#/then', instanceLocation: '', errors: { minLength: 'must NOT have fewer than 3 characters' } },
    ]);
    assert.deepEqual(output('list', schema, -1).details, [
      { valid: false, evaluationPath: '/else', schemaLocation: 'https://ex.test/app#/else', instanceLocation: '', errors: { minimum: 'must be >= 0' } },
    ]);
    assert.deepEqual(output('list', schema, 'abc').details, [
      { valid: true, evaluationPath: '/if', schemaLocation: 'https://ex.test/app#/if', instanceLocation: '', annotations: { title: 'cond' } },
    ]);
  });

  it('report the members unevaluatedProperties and unevaluatedItems applied to', () => {
    const app = (/** @type {object} */ schema) => ({ $schema: S, $id: 'https://ex.test/app', ...schema });
    assert.deepEqual(output('list', app({ allOf: [{ properties: { a: { type: 'number' } } }], unevaluatedProperties: { type: 'number' } }), { a: 1, b: 2 }).details, [
      { valid: true, evaluationPath: '', schemaLocation: 'https://ex.test/app#', instanceLocation: '', annotations: { unevaluatedProperties: ['b'] } },
      { valid: true, evaluationPath: '/allOf/0', schemaLocation: 'https://ex.test/app#/allOf/0', instanceLocation: '', annotations: { properties: ['a'] } },
    ]);
    assert.deepEqual(output('list', app({ prefixItems: [{ type: 'number' }], unevaluatedItems: { type: 'string' } }), [1, 'x', 2]).details, [
      { valid: false, evaluationPath: '/unevaluatedItems', schemaLocation: 'https://ex.test/app#/unevaluatedItems', instanceLocation: '/2', errors: { type: 'must be a string' } },
    ]);
    assert.deepEqual(output('list', app({ unevaluatedItems: true, contains: { type: 'string' } }), [1, 'a']).details, [
      { valid: true, evaluationPath: '', schemaLocation: 'https://ex.test/app#', instanceLocation: '', annotations: { unevaluatedItems: true, contains: [1] } },
    ]);
  });

  it('report the annotations of applicators whose subschema is true', () => {
    const app = (/** @type {object} */ schema) => ({ $schema: S, $id: 'https://ex.test/app', ...schema });
    const annotations = (/** @type {object} */ schema, /** @type {unknown} */ data) => output('list', app(schema), data).details.map((/** @type {any} */ u) => u.annotations);
    assert.deepEqual(annotations({ items: true }, [1, 2]), [{ items: true }]);
    assert.deepEqual(annotations({ prefixItems: [true], items: { type: 'number' } }, [1, 2]), [{ prefixItems: 0, items: true }]);
    assert.deepEqual(annotations({ prefixItems: [true, true] }, [1]), [{ prefixItems: true }]);
    assert.deepEqual(annotations({ contains: true }, [1, 2]), [{ contains: [0, 1] }]);
    assert.deepEqual(annotations({ unevaluatedProperties: true }, { a: 1 }), [{ unevaluatedProperties: ['a'] }]);
    assert.deepEqual(annotations({ properties: { a: true }, patternProperties: { '^x': true }, additionalProperties: true }, { a: 1, xb: 2, c: 3 }),
      [{ properties: ['a'], patternProperties: ['xb'], additionalProperties: ['c'] }]);
    assert.deepEqual(output('list', { $schema: 'http://json-schema.org/draft-07/schema#', $id: 'https://ex.test/app', items: [true, {}], additionalItems: true }, [1, 2, 3]).details[0].annotations,
      { items: 1, additionalItems: true });
  });

  it('annotate format, and report it when it asserts', () => {
    const schema = { $schema: S, $id: 'https://ex.test/app', type: 'string', format: 'email' };
    assert.deepEqual(output('list', schema, 'nope').details, [
      { valid: true, evaluationPath: '', schemaLocation: 'https://ex.test/app#', instanceLocation: '', annotations: { format: 'email' } },
    ]);
    assert.deepEqual(output('list', schema, 'nope', { formatAssertion: true, formats: stringFormats }).details, [
      { valid: false, evaluationPath: '', schemaLocation: 'https://ex.test/app#', instanceLocation: '', errors: { format: 'must match format "email"' }, droppedAnnotations: { format: 'email' } },
    ]);
  });

  it('key a false schema\'s failure by the empty string', () => {
    assert.deepEqual(output('hierarchical', false, 1), {
      valid: false, evaluationPath: '', schemaLocation: 'https://github.com/jklarenbeek/jarenjs#', instanceLocation: '', errors: { '': 'boolean schema false is always invalid' },
    });
  });

  it('join the messages of one keyword, render errorMessage, and honour messages: false', () => {
    const app = { $schema: S, $id: 'https://ex.test/app', required: ['a', 'b'] };
    assert.deepEqual(output('list', app, {}).details[0].errors, { required: "must have required property 'a'; must have required property 'b'" });
    assert.deepEqual(output('detailed', app, {}).errors, [
      { valid: false, keywordLocation: '/required', instanceLocation: '', error: "must have required property 'a'" },
      { valid: false, keywordLocation: '/required', instanceLocation: '', error: "must have required property 'b'" },
    ]);
    assert.deepEqual(output('list', { ...app, errorMessage: { required: 'name the account' } }, {}).details[0].errors, { required: 'name the account' });
    assert.deepEqual(output('list', app, {}, { messages: false }).details[0].errors, { required: '' });
  });

  it('give a passing validation its annotations in every 2020-12 format', () => {
    const schema = { $schema: S, $id: 'https://ex.test/app', title: 't', properties: { a: { title: 'A' } } };
    assert.deepEqual(output('basic', schema, { a: 1 }), {
      valid: true,
      annotations: [
        { valid: true, keywordLocation: '/title', instanceLocation: '', annotation: 't' },
        { valid: true, keywordLocation: '/properties', instanceLocation: '', annotation: ['a'] },
        { valid: true, keywordLocation: '/properties/a/title', instanceLocation: '/a', annotation: 'A' },
      ],
    });
    assert.deepEqual(output('detailed', schema, { a: 1 }), {
      valid: true, keywordLocation: '', instanceLocation: '',
      annotations: [
        { valid: true, keywordLocation: '/title', instanceLocation: '', annotation: 't' },
        { valid: true, keywordLocation: '/properties', instanceLocation: '', annotation: ['a'], annotations: [{ valid: true, keywordLocation: '/properties/a/title', instanceLocation: '/a', annotation: 'A' }] },
      ],
    });
    assert.deepEqual(output('basic', { $id: 'https://ex.test/app' }, 1), { valid: true });
    assert.deepEqual(output('detailed', { $id: 'https://ex.test/app' }, 1), { valid: true, keywordLocation: '', instanceLocation: '' });
  });

  it('report a keyword applied by a failed applicator under it in detailed and verbose', () => {
    const schema = { $schema: S, $id: 'https://ex.test/app', type: 'string', anyOf: [true] };
    assert.deepEqual(output('verbose', schema, 1), {
      valid: false, keywordLocation: '', instanceLocation: '',
      errors: [
        { valid: false, keywordLocation: '/type', instanceLocation: '', error: 'must be a string' },
        { valid: true, keywordLocation: '/anyOf', instanceLocation: '' },
      ],
    });
    assert.deepEqual(output('detailed', { $schema: S, $id: 'https://ex.test/app', not: { type: 'string' } }, 'a'),
      { valid: false, keywordLocation: '/not', instanceLocation: '', error: 'must NOT match the subschema' });
  });

  it('grow linearly with the members of the instance', () => {
    // A quadratic step would grow about 64 times over an 8 times larger instance.
    const schema = { $schema: S, type: 'object', additionalProperties: { type: 'number' } };
    for (const outputFormat of ['list', 'hierarchical', 'detailed']) {
      const validate = new JarenValidator(/** @type {any} */ ({ outputFormat: FORMATS[outputFormat] })).compile(schema);
      // The fastest of three runs of twenty validations (several
      // milliseconds at the small size), each run over a fresh instance.
      const time = (/** @type {number} */ n) => {
        let best = Infinity;
        for (let run = 0; run < 3; run++) {
          const data = Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
          assert.equal(validate(data).valid, true);
          const start = process.hrtime.bigint();
          for (let i = 0; i < 20; i++) validate(data);
          best = Math.min(best, Number(process.hrtime.bigint() - start));
        }
        return best;
      };
      time(1000);
      const growth = time(8000) / time(1000);
      assert.ok(growth < 32, `${outputFormat}: ${growth.toFixed(1)} times`);
    }
  });
});
