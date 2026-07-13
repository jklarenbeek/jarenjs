import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import {
  buildFormModel,
  validateField,
  validateAllFields,
  createInitialData,
  createItemValue,
  parseFieldInput,
  getValueAtPointer,
  setValueAtPointer,
  appendItem,
  removeItemAt,
  humanizeKey,
  getFormatInfo,
} from '@jarenjs/forms';

describe('Form Model', function () {
  describe('#buildFormModel()', function () {
    it('should build fields for a simple object schema', function () {
      const model = buildFormModel({
        type: 'object',
        properties: {
          firstName: { type: 'string', minLength: 1 },
          age: { type: 'integer', minimum: 0 },
          email: { type: 'string', format: 'email' },
          active: { type: 'boolean' },
        },
        required: ['firstName', 'email'],
      });

      assert.isTrue(model.kind === 'object');
      assert.isTrue(model.children.length === 4);

      const [firstName, age, email, active] = model.children;
      assert.isTrue(firstName.label === 'First Name', 'humanizes camelCase keys');
      assert.isTrue(firstName.required === true);
      assert.isTrue(firstName.pointer === '/firstName');
      assert.isTrue(age.control === 'number');
      assert.isTrue(age.required === false);
      assert.isTrue(email.control === 'email', 'email format maps to email control');
      assert.isTrue(active.control === 'checkbox');
    });

    it('should use schema title and description', function () {
      const model = buildFormModel({
        type: 'object',
        properties: {
          n: { type: 'string', title: 'Full Name', description: 'Your legal name' },
        },
      });
      assert.isTrue(model.children[0].label === 'Full Name');
      assert.isTrue(model.children[0].description === 'Your legal name');
    });

    it('should resolve local $refs', function () {
      const model = buildFormModel({
        type: 'object',
        properties: {
          home: { $ref: '#/$defs/address' },
        },
        $defs: {
          address: {
            type: 'object',
            properties: {
              street: { type: 'string' },
              zip: { type: 'string', pattern: '^\\d{5}$' },
            },
            required: ['street'],
          },
        },
      });

      const home = model.children[0];
      assert.isTrue(home.kind === 'object');
      assert.isTrue(home.children.length === 2);
      assert.isTrue(home.children[0].required === true);
      assert.isTrue(home.children[1].constraints.pattern === '^\\d{5}$');
    });

    it('should merge allOf branches', function () {
      const model = buildFormModel({
        type: 'object',
        allOf: [
          { properties: { a: { type: 'string' } }, required: ['a'] },
          { properties: { b: { type: 'number' } } },
        ],
        properties: { c: { type: 'boolean' } },
      });

      const keys = model.children.map((f) => f.key).sort();
      assert.isTrue(keys.join(',') === 'a,b,c');
      assert.isTrue(model.children.find((f) => f.key === 'a').required === true);
    });

    it('should build enum and const fields', function () {
      const model = buildFormModel({
        type: 'object',
        properties: {
          role: { enum: ['user', 'admin'] },
          version: { const: 2 },
        },
      });
      assert.isTrue(model.children[0].control === 'select');
      assert.isTrue(model.children[0].enumValues.length === 2);
      assert.isTrue(model.children[1].kind === 'const');
      assert.isTrue(model.children[1].constValue === 2);
    });

    it('should build array item templates', function () {
      const model = buildFormModel({
        type: 'array',
        items: { type: 'string', format: 'uuid' },
        minItems: 1,
      });
      assert.isTrue(model.kind === 'array');
      assert.isTrue(model.item.control === 'text');
      assert.isTrue(model.item.constraints.format === 'uuid');
      assert.isTrue(model.constraints.minItems === 1);
    });

    it('should build tuple fields for prefixItems', function () {
      const model = buildFormModel({
        type: 'array',
        prefixItems: [{ type: 'string' }, { type: 'number' }],
        items: { type: 'boolean' },
      });
      assert.isTrue(model.tuple.length === 2);
      assert.isTrue(model.tuple[1].kind === 'number');
      assert.isTrue(model.item.kind === 'boolean');
    });

    it('should infer kinds without explicit type', function () {
      const model = buildFormModel({
        type: 'object',
        properties: {
          name: { minLength: 2 },
          count: { minimum: 0 },
          nested: { properties: { x: { type: 'string' } } },
        },
      });
      assert.isTrue(model.children[0].kind === 'string');
      assert.isTrue(model.children[1].kind === 'number');
      assert.isTrue(model.children[2].kind === 'object');
    });

    it('should not loop on recursive schemas', function () {
      const model = buildFormModel({
        type: 'object',
        properties: {
          name: { type: 'string' },
          child: { $ref: '#' },
        },
      });
      assert.isTrue(model.children.length === 2);
    });
  });

  describe('#humanizeKey()', function () {
    it('should humanize common key styles', function () {
      assert.isTrue(humanizeKey('firstName') === 'First Name');
      assert.isTrue(humanizeKey('first_name') === 'First Name');
      assert.isTrue(humanizeKey('first-name') === 'First Name');
      assert.isTrue(humanizeKey('url2') === 'Url2');
    });
  });
});

describe('Preemptive Field Validation', function () {
  function fieldFor(propSchema, required = false) {
    const model = buildFormModel({
      type: 'object',
      properties: { it: propSchema },
      required: required ? ['it'] : [],
    });
    return model.children[0];
  }

  describe('#validateField()', function () {
    it('should validate required on absent values only', function () {
      const req = fieldFor({ type: 'string' }, true);
      assert.isTrue(validateField(req, undefined).length === 1);
      assert.isTrue(validateField(req, undefined)[0].keyword === 'required');
      assert.isTrue(validateField(req, 'x').length === 0);

      const opt = fieldFor({ type: 'string' });
      assert.isTrue(validateField(opt, undefined).length === 0);
    });

    it('should validate string length with grapheme counting', function () {
      const field = fieldFor({ type: 'string', minLength: 2, maxLength: 3 });
      assert.isTrue(validateField(field, 'a')[0].keyword === 'minLength');
      assert.isTrue(validateField(field, 'abcd')[0].keyword === 'maxLength');
      assert.isTrue(validateField(field, 'ab').length === 0);
      // emoji family = 1 grapheme, many code units
      assert.isTrue(validateField(field, '👨‍👩‍👧‍👦')[0].keyword === 'minLength');
    });

    it('should validate patterns with unicode regexes', function () {
      const field = fieldFor({ type: 'string', pattern: '^[a-z]+$' });
      assert.isTrue(validateField(field, 'abc').length === 0);
      assert.isTrue(validateField(field, 'ABC')[0].keyword === 'pattern');
    });

    it('should preemptively validate formats using @jarenjs/core', function () {
      const email = fieldFor({ type: 'string', format: 'email' });
      assert.isTrue(validateField(email, 'joe@example.com').length === 0);
      assert.isTrue(validateField(email, '"joe bloggs"@example.com').length === 0, 'RFC 5321 quoted local part');
      assert.isTrue(validateField(email, 'not-an-email')[0].keyword === 'format');

      const ip = fieldFor({ type: 'string', format: 'ipv4' });
      assert.isTrue(validateField(ip, '192.168.0.1').length === 0);
      assert.isTrue(validateField(ip, '999.0.0.1')[0].keyword === 'format');

      const uuid = fieldFor({ type: 'string', format: 'uuid' });
      assert.isTrue(validateField(uuid, '123e4567-e89b-12d3-a456-426614174000').length === 0);
      assert.isTrue(validateField(uuid, 'nope')[0].keyword === 'format');

      const date = fieldFor({ type: 'string', format: 'date' });
      assert.isTrue(validateField(date, '2024-01-15').length === 0);
      assert.isTrue(validateField(date, '2024-13-45')[0].keyword === 'format');
    });

    it('should ignore unknown formats', function () {
      const field = fieldFor({ type: 'string', format: 'flux-capacitance' });
      assert.isTrue(validateField(field, 'anything').length === 0);
    });

    it('should validate numbers and integers', function () {
      const field = fieldFor({ type: 'integer', minimum: 0, maximum: 10, multipleOf: 2 });
      assert.isTrue(validateField(field, 4).length === 0);
      assert.isTrue(validateField(field, 4.5)[0].keyword === 'type');
      assert.isTrue(validateField(field, -2)[0].keyword === 'minimum');
      assert.isTrue(validateField(field, 12)[0].keyword === 'maximum');
      assert.isTrue(validateField(field, 6).length === 0);
      assert.isTrue(validateField(field, 8).length === 0);
      assert.isTrue(validateField(field, 'abc')[0].keyword === 'type');
      const odd = validateField(field, 3);
      assert.isTrue(odd.some((e) => e.keyword === 'multipleOf'));
    });

    it('should validate exclusive bounds', function () {
      const field = fieldFor({ type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1 });
      assert.isTrue(validateField(field, 0)[0].keyword === 'exclusiveMinimum');
      assert.isTrue(validateField(field, 1)[0].keyword === 'exclusiveMaximum');
      assert.isTrue(validateField(field, 0.5).length === 0);
    });

    it('should validate enum and const with deep equality', function () {
      const role = fieldFor({ enum: ['user', 'admin', { custom: true }] });
      assert.isTrue(validateField(role, 'admin').length === 0);
      assert.isTrue(validateField(role, { custom: true }).length === 0);
      assert.isTrue(validateField(role, 'root')[0].keyword === 'enum');

      const version = fieldFor({ const: 2 });
      assert.isTrue(validateField(version, 2).length === 0);
      assert.isTrue(validateField(version, 3)[0].keyword === 'const');
    });

    it('should validate array constraints', function () {
      const field = fieldFor({ type: 'array', minItems: 1, maxItems: 2, uniqueItems: true });
      assert.isTrue(validateField(field, [])[0].keyword === 'minItems');
      assert.isTrue(validateField(field, [1, 2, 3])[0].keyword === 'maxItems');
      assert.isTrue(validateField(field, [1, 1])[0].keyword === 'uniqueItems');
      assert.isTrue(validateField(field, [1, 2]).length === 0);
    });
  });

  describe('#validateAllFields()', function () {
    it('should report errors per data pointer', function () {
      const model = buildFormModel({
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1 },
          contact: {
            type: 'object',
            properties: { email: { type: 'string', format: 'email' } },
          },
          tags: { type: 'array', items: { type: 'string', minLength: 2 } },
        },
        required: ['name'],
      });

      const errors = validateAllFields(model, {
        contact: { email: 'bad' },
        tags: ['ok', 'x'],
      });

      assert.isTrue(errors['/name'][0].keyword === 'required');
      assert.isTrue(errors['/contact/email'][0].keyword === 'format');
      assert.isTrue(errors['/tags/1'][0].keyword === 'minLength');
      assert.isTrue(errors['/tags/0'] === undefined);
    });
  });
});

describe('Form Data Helpers', function () {
  describe('#createInitialData()', function () {
    it('should fill defaults and consts, leave the rest absent', function () {
      const model = buildFormModel({
        type: 'object',
        properties: {
          name: { type: 'string' },
          role: { type: 'string', default: 'user' },
          version: { const: 3 },
          nested: {
            type: 'object',
            properties: { active: { type: 'boolean', default: true } },
          },
          tags: { type: 'array', items: { type: 'string' } },
        },
      });

      const data = createInitialData(model);
      assert.isTrue(data.name === undefined);
      assert.isTrue(data.role === 'user');
      assert.isTrue(data.version === 3);
      assert.isTrue(data.nested.active === true);
      assert.isTrue(Array.isArray(data.tags) && data.tags.length === 0);
    });
  });

  describe('#pointer helpers', function () {
    it('should get and set values immutably', function () {
      const data = { user: { name: 'joe', tags: ['a', 'b'] } };
      assert.isTrue(getValueAtPointer(data, '/user/name') === 'joe');
      assert.isTrue(getValueAtPointer(data, '/user/tags/1') === 'b');
      assert.isTrue(getValueAtPointer(data, '/missing/deep') === undefined);

      const next = setValueAtPointer(data, '/user/name', 'jane');
      assert.isTrue(next.user.name === 'jane');
      assert.isTrue(data.user.name === 'joe', 'original untouched');
      assert.isTrue(next.user.tags === data.user.tags, 'untouched branches shared');
    });

    it('should remove properties when set to undefined', function () {
      const data = { a: 1, b: 2 };
      const next = setValueAtPointer(data, '/a', undefined);
      assert.isTrue(!('a' in next));
      assert.isTrue(next.b === 2);
    });

    it('should create intermediate containers', function () {
      const next = setValueAtPointer({}, '/list/0/name', 'x');
      assert.isTrue(Array.isArray(next.list));
      assert.isTrue(next.list[0].name === 'x');
    });

    it('should append and remove array items', function () {
      let data = { tags: ['a'] };
      data = appendItem(data, '/tags', 'b');
      assert.isTrue(data.tags.join(',') === 'a,b');
      data = removeItemAt(data, '/tags', 0);
      assert.isTrue(data.tags.join(',') === 'b');
      data = appendItem(data, '/new', 'x');
      assert.isTrue(data.new.length === 1, 'creates array when absent');
    });

    it('should handle escaped pointer keys', function () {
      const data = setValueAtPointer({}, '/a~1b', 1);
      assert.isTrue(data['a/b'] === 1);
      assert.isTrue(getValueAtPointer(data, '/a~1b') === 1);
    });
  });

  describe('#parseFieldInput()', function () {
    function fieldFor(propSchema) {
      return buildFormModel({ type: 'object', properties: { it: propSchema } }).children[0];
    }

    it('should treat empty strings as absent', function () {
      assert.isTrue(parseFieldInput(fieldFor({ type: 'string' }), '') === undefined);
      assert.isTrue(parseFieldInput(fieldFor({ type: 'number' }), '') === undefined);
    });

    it('should coerce numbers but keep junk for error display', function () {
      assert.isTrue(parseFieldInput(fieldFor({ type: 'number' }), '4.5') === 4.5);
      assert.isTrue(parseFieldInput(fieldFor({ type: 'integer' }), '42') === 42);
      assert.isTrue(parseFieldInput(fieldFor({ type: 'number' }), 'abc') === 'abc');
    });

    it('should coerce booleans and typed enum options', function () {
      assert.isTrue(parseFieldInput(fieldFor({ type: 'boolean' }), true) === true);
      const enumField = fieldFor({ enum: [1, 2, 'three'] });
      assert.isTrue(parseFieldInput(enumField, '2') === 2);
      assert.isTrue(parseFieldInput(enumField, 'three') === 'three');
    });
  });

  describe('#createItemValue()', function () {
    it('should create sensible starter values', function () {
      const strings = buildFormModel({ type: 'array', items: { type: 'string' } });
      assert.isTrue(createItemValue(strings.item) === '');
      const nums = buildFormModel({ type: 'array', items: { type: 'integer' } });
      assert.isTrue(createItemValue(nums.item) === 0);
      const objs = buildFormModel({
        type: 'array',
        items: { type: 'object', properties: { x: { type: 'string', default: 'y' } } },
      });
      assert.isTrue(createItemValue(objs.item).x === 'y');
    });
  });
});

describe('Format Registry', function () {
  it('should expose control hints', function () {
    assert.isTrue(getFormatInfo('email').control === 'email');
    assert.isTrue(getFormatInfo('date').control === 'date');
    assert.isTrue(getFormatInfo('color').control === 'color');
    assert.isTrue(getFormatInfo('unknown-format') === null);
  });

  it('should test values through @jarenjs/core', function () {
    assert.isTrue(getFormatInfo('ipv6').test('::1'));
    assert.isTrue(!getFormatInfo('ipv6').test('not-an-ip'));
    assert.isTrue(getFormatInfo('duration').test('P3DT4H'));
    assert.isTrue(getFormatInfo('json-pointer').test('/a/b'));
    assert.isTrue(!getFormatInfo('json-pointer').test('a/b'));
  });
});
