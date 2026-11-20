//@ts-check
/**
 * @file A field's kind chooses its control and never an answer.
 *
 * A schema without a `type` is given a kind by its keywords, and the
 * field check used to judge by that kind: `{ minimum: 5 }` built a number
 * field that refused `'abc'` for being no number, where the schema
 * declares no `type` and the validator takes it; and a keyword outside
 * the twelve that inferred a kind (`exclusiveMinimum`, `minItems`,
 * `maxProperties`, ...) built an `unknown` field that checked nothing.
 *
 * A kind now decides the control alone: a schema that describes members
 * or items is an object or an array field, any other schema a number or
 * a string field where every keyword that constrains values of one type
 * belongs to that type, and the `json` control otherwise. The field
 * check reads the schema's keywords, the declared `type` among them and
 * no other.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { numberFormats } from '@jarenjs/formats';
import { buildFormModel, buildFormViewModel, createInitialData, createItemValue, getFieldKind, parseFieldInput, validateAllFields, validateField } from '@jarenjs/forms';

/** The field a schema builds as member `n`. @param {object} schema @param {boolean} [required] */
const fieldOf = (schema, required = false) => buildFormModel({ type: 'object', properties: { n: schema }, required: required ? ['n'] : [] }).children[0];

/** The keywords a field reports for a value. @param {object} schema @param {unknown} value @param {boolean} [required] */
const keywordsOf = (schema, value, required = false) => validateField(fieldOf(schema, required), value).map((error) => error.keyword);

/** @param {object} schema */
const kindAndControl = (schema) => {
  const field = fieldOf(schema);
  return [field.kind, field.control];
};

describe('the kind a schema without a type is given by its keywords', () => {
  it('infers a number or a string field from the keywords that inferred none, and keeps the json control of the others', () => {
    /** The thirteen keywords that alone built an `unknown` field. @type {[object, string, string][]} */
    const table = [
      [{ exclusiveMinimum: 5 }, 'number', 'number'],
      [{ exclusiveMaximum: 5 }, 'number', 'number'],
      [{ formatMinimum: '2020-01-01' }, 'string', 'text'],
      [{ contentEncoding: 'base64' }, 'string', 'textarea'],
      [{ contentMediaType: 'application/json' }, 'string', 'textarea'],
      // an array control shows the items `items` describes and starts as []: these describe none
      [{ minItems: 2 }, 'unknown', 'json'],
      [{ maxItems: 2 }, 'unknown', 'json'],
      [{ uniqueItems: true }, 'unknown', 'json'],
      [{ contains: {} }, 'unknown', 'json'],
      // an object control shows the members `properties` declares: these name none
      [{ minProperties: 1 }, 'unknown', 'json'],
      [{ maxProperties: 1 }, 'unknown', 'json'],
      [{ required: ['a'] }, 'unknown', 'json'],
      [{ propertyNames: {} }, 'unknown', 'json'],
    ];
    for (const [schema, kind, control] of table) assert.deepEqual(kindAndControl(schema), [kind, control], JSON.stringify(schema));
  });

  it('keeps the kinds the twelve inferring keywords gave, and the declared type before any keyword', () => {
    /** @type {[object, string][]} */
    const table = [
      [{ properties: { a: {} } }, 'object'], [{ patternProperties: { a: {} } }, 'object'], [{ additionalProperties: false }, 'object'],
      [{ items: {} }, 'array'], [{ prefixItems: [{}] }, 'array'],
      [{ minLength: 1 }, 'string'], [{ maxLength: 1 }, 'string'], [{ pattern: 'a' }, 'string'], [{ format: 'email' }, 'string'],
      [{ minimum: 1 }, 'number'], [{ maximum: 1 }, 'number'], [{ multipleOf: 1 }, 'number'],
      [{ properties: { a: {} }, required: ['a'], minProperties: 1, propertyNames: {} }, 'object'],
      [{ items: {}, minItems: 1, uniqueItems: true, contains: {} }, 'array'],
      [{ minItems: 1, uniqueItems: true }, 'unknown'], [{ minProperties: 1, required: ['a'] }, 'unknown'],
      [{ minimum: 0, exclusiveMaximum: 9, multipleOf: 3 }, 'number'],
      [{ format: 'date', formatMinimum: '2020-01-01', maxLength: 10 }, 'string'],
      [{ type: 'string', minimum: 5, minItems: 1 }, 'string'],
      [{ type: 'object', minLength: 1 }, 'object'],
      // a schema that describes members or items keeps the control that shows them, whatever stands beside them
      [{ properties: { a: {} }, minimum: 0 }, 'object'], [{ additionalProperties: false, pattern: 'a' }, 'object'],
      [{ properties: { a: {} }, items: {} }, 'object'], [{ items: {}, pattern: 'a' }, 'array'], [{ prefixItems: [{}], maximum: 3 }, 'array'],
    ];
    for (const [schema, kind] of table) assert.equal(getFieldKind(schema), kind, JSON.stringify(schema));
  });

  it('gives keywords of two types, and a schema with none, the json control', () => {
    for (const schema of [
      { minLength: 1, minimum: 0 }, { minimum: 0, minItems: 1 }, { uniqueItems: true, pattern: 'a' }, { minProperties: 1, minimum: 0 },
      { format: 'date', minimum: 0 }, { required: ['a'], maxLength: 3 },
      {}, { title: 'Name' }, { default: 1, description: 'x' },
    ]) assert.deepEqual(kindAndControl(schema), ['unknown', 'json'], JSON.stringify(schema));
  });

  it('reads a number format as a number keyword, and required as an object keyword only as a list', () => {
    assert.deepEqual(kindAndControl({ format: 'int32' }), ['number', 'number']);
    assert.deepEqual(kindAndControl({ format: 'float', minimum: 0 }), ['number', 'number']);
    assert.deepEqual(kindAndControl({ type: 'string', format: 'int32' }), ['string', 'number']);
    assert.deepEqual(kindAndControl({ required: true, minimum: 0 }), ['number', 'number']);
    assert.deepEqual(kindAndControl({ required: ['a'], minimum: 0 }), ['unknown', 'json']);
  });

  it('reads a type held as a Set as the list of its names', () => {
    assert.deepEqual(kindAndControl({ type: new Set(['number']) }), ['number', 'number']);
    const field = fieldOf({ type: new Set(['null', 'string']), maxLength: 2 });
    assert.deepEqual([field.kind, field.nullable], ['string', true]);
    assert.deepEqual(keywordsOf({ type: new Set(['null', 'string']) }, null), []);
    assert.deepEqual(keywordsOf({ type: new Set(['null', 'string']) }, 5), ['type']);
  });
});

describe('a kind chooses the control and never an answer', () => {
  it('asserts no type for a field whose kind was inferred, and judges it by its keywords', () => {
    for (const [schema, value] of /** @type {[object, unknown][]} */ ([
      [{ minimum: 5 }, 'abc'], [{ minimum: 5 }, [1]], [{ minimum: 5 }, true], [{ minimum: 5 }, {}], [{ minimum: 5 }, '7'],
      [{ minLength: 2 }, 5], [{ pattern: '^a' }, 5], [{ format: 'email' }, 5],
      [{ items: { type: 'string' } }, 'abc'], [{ properties: { a: {} } }, 'abc'], [{ additionalProperties: false }, [1]],
    ])) {
      assert.equal(new JarenValidator().compile(schema)(value), true);
      assert.deepEqual(keywordsOf(schema, value), [], `${JSON.stringify(schema)} on ${JSON.stringify(value)}`);
    }
    assert.deepEqual(keywordsOf({ minimum: 5 }, 4), ['minimum']);
    assert.deepEqual(keywordsOf({ minLength: 2 }, 'a'), ['minLength']);
  });

  it('judges a declared type as before, the first name that is not null named in the message', () => {
    /** @type {[object, unknown, string][]} */
    const table = [
      [{ type: 'string' }, 5, 'string'], [{ type: 'number' }, 'abc', 'number'], [{ type: 'boolean' }, 1, 'boolean'],
      [{ type: 'array' }, {}, 'array'], [{ type: 'object' }, [], 'object'],
      [{ type: 'integer' }, 'abc', 'number'], [{ type: 'integer' }, 1.5, 'integer'], [{ type: ['null', 'integer'] }, 21n, 'number'],
      [{ type: ['string', 'number'] }, true, 'string'], [{ type: 'null' }, 5, 'null'], [{ type: 'bigint' }, 5, 'bigint'],
      [{ type: new Set(['number']), minimum: 0 }, 21n, 'number'],
    ];
    for (const [schema, value, type] of table) {
      assert.deepEqual(validateField(fieldOf(schema), value).map((error) => [error.keyword, error.params]), [['type', { type }]], JSON.stringify(schema));
      assert.equal(new JarenValidator().compile(schema)(value), false);
    }
    assert.equal(validateField(fieldOf({ type: 'bigint' }), 5)[0].message, 'Must be a bigint');
    assert.deepEqual(keywordsOf({ type: ['string', 'number'] }, 5), []);
  });

  it('applies each keyword to a value of its own type whatever the kind, beside a type that refuses the value', () => {
    assert.deepEqual(keywordsOf({ type: 'string', minimum: 5 }, 3), ['type', 'minimum']);
    assert.deepEqual(keywordsOf({ type: 'number', minLength: 2 }, 'a'), ['type', 'minLength']);
    assert.deepEqual(keywordsOf({ type: 'string', enum: [1, 2] }, 1), ['type']);
    assert.deepEqual(keywordsOf({ type: 'string', enum: [1, 2] }, null), ['type', 'enum']);
    assert.deepEqual(keywordsOf({ const: 1, enum: [2] }, 1), ['enum']);
    assert.deepEqual(keywordsOf({ required: ['a'], maxProperties: 1 }, { a: 1, b: 2 }), ['maxProperties']);
    assert.deepEqual(keywordsOf({ minLength: 2, minimum: 5 }, 'a'), ['minLength']);
    assert.deepEqual(keywordsOf({ minLength: 2, minimum: 5 }, 4), ['minimum']);
  });

  it('judges a number format on every value as the number it converts to, as its validator does', () => {
    const validate = new JarenValidator({ formatAssertion: true }).addFormats(numberFormats).compile({ format: 'int32' });
    const field = fieldOf({ format: 'int32' });
    /** @type {[unknown, boolean][]} */
    const table = [[12, true], ['12', true], [2 ** 31, false], ['abc', false], [{}, false], [[5], true], [null, true], [5n, true], [1.5, false]];
    for (const [value, takes] of table) {
      const label = JSON.stringify(value, (key, x) => (typeof x === 'bigint' ? `${x}n` : x));
      assert.equal(validate(value), takes, `the validator on ${label}`);
      assert.equal(validateField(field, value).length === 0, takes, `the field on ${label}`);
    }
    assert.deepEqual(validateField(field, 'abc').map((error) => error.message), ['Must be a valid int32']);
  });

  it('holds a value the control cannot show as it is: no error of the field, and the type error where a type is declared', () => {
    const untyped = buildFormModel({ type: 'object', properties: { n: { minimum: 5 } } });
    const node = buildFormViewModel(untyped, { n: 'abc' }, { validateFields: true }).children[0];
    assert.deepEqual([node.kind, node.control, node.value, node.errors], ['number', 'number', 'abc', []]);
    assert.deepEqual(validateAllFields(untyped, { n: 'abc' }), {});
    // what a number control hands over that reads as no number stays the text it is
    assert.equal(parseFieldInput(untyped.children[0], 'abc'), 'abc');
    assert.equal(parseFieldInput(untyped.children[0], '7'), 7);

    const typed = buildFormModel({ type: 'object', properties: { n: { type: 'number', minimum: 5 } } });
    const refused = buildFormViewModel(typed, { n: parseFieldInput(typed.children[0], 'abc') }, { validateFields: true }).children[0];
    assert.deepEqual([refused.control, refused.value, refused.errors], ['number', 'abc', ['Must be a number']]);
  });

  it('keeps the members of a schema with keywords of another type fields of their own', () => {
    const model = buildFormModel({ properties: { a: { type: 'string' } }, minimum: 0 });
    assert.deepEqual([model.kind, model.children.length], ['object', 1]);
    assert.deepEqual(Object.keys(validateAllFields(model, { a: 1 })), ['/a']);
    assert.deepEqual(validateAllFields(model, -1)[''].map((error) => error.keyword), ['minimum']);
    assert.deepEqual(validateAllFields(model, 3), {});
  });

  it('judges the members of an object and the items of an array only, as properties and items do', () => {
    const members = buildFormModel({ properties: { a: { type: 'string' } }, required: ['a'] });
    assert.deepEqual(Object.keys(validateAllFields(members, {})), ['/a']);
    assert.deepEqual(validateAllFields(members, [1]), {});
    assert.deepEqual(validateAllFields(members, 'abc'), {});
    assert.equal(new JarenValidator().compile({ properties: { a: { type: 'string' } }, required: ['a'] })([1]), true);
  });
});

describe('the data a form starts from', () => {
  it('leaves a member whose kind was inferred absent, and a json control\'s too, so an untouched form is what the validator takes', () => {
    for (const member of [{ minItems: 2 }, { contains: {} }, { uniqueItems: true }, { exclusiveMinimum: 5 }, { formatMinimum: '2020-01-01' },
      { contentMediaType: 'application/json' }, { format: 'int32' }, { minLength: 1, minimum: 0 }, { minProperties: 1 }]) {
      const schema = { type: 'object', properties: { m: member } };
      assert.deepEqual(createInitialData(buildFormModel(schema)), {}, JSON.stringify(member));
      assert.equal(new JarenValidator().compile(schema)({}), true);
    }
  });

  it('starts a new item of an inferred number or string field at the kind\'s starter value', () => {
    /** @param {object} items */
    const starter = (items) => createItemValue(buildFormModel({ items }).item);
    assert.equal(starter({ exclusiveMinimum: 5 }), 0);
    assert.equal(starter({ format: 'int32' }), 0);
    assert.equal(starter({ contentEncoding: 'base64' }), '');
    assert.equal(starter({ minItems: 1 }), undefined);
    assert.equal(starter({ minLength: 1, minimum: 0 }), undefined);
  });
});

describe('a null under a control that cannot show absent', () => {
  it('says required for a required json control holding a null no keyword of its own refuses', () => {
    const union = { anyOf: [{ type: 'string' }, { type: 'integer' }] };
    assert.deepEqual(keywordsOf(union, null, true), ['required']);
    assert.deepEqual(keywordsOf(union, null), []);
    // a keyword that refuses the null says so itself
    assert.deepEqual(keywordsOf({ type: 'bigint' }, null, true), ['type']);
    assert.equal(new JarenValidator().compile({ type: 'bigint' })(null), false);
  });

  it('reads nullable: false without a type as refusing null, as the validator does', () => {
    assert.equal(new JarenValidator().compile({ nullable: false })(null), false);
    assert.equal(fieldOf({ nullable: false }).nullable, false);
    assert.equal(fieldOf({ minimum: 5, nullable: false }).nullable, false);
    assert.equal(fieldOf({ enum: [null, 1], nullable: false }).nullable, false);
    assert.equal(fieldOf({ type: ['string', 'null'], nullable: false }).nullable, true);
    assert.equal(fieldOf({ nullable: true }).nullable, true);
    assert.deepEqual(keywordsOf({ nullable: false }, null, true), ['required']);
  });
});
