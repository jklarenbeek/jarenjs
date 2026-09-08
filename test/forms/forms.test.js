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

    it('should carry the format\'s preview hint on the field, and null where there is none', function () {
      // a host that understands `preview.kind` renders it beside the
      // control; one that does not sees the same textarea as before
      const geojson = fieldFor({ type: 'string', format: 'geojson' });
      assert.deepEqual(geojson.preview, { kind: 'map' });
      assert.isTrue(geojson.control === 'textarea');
      assert.isTrue(geojson.kind === 'string');
      const email = fieldFor({ type: 'string', format: 'email' });
      assert.isTrue(email.preview === null);
      const plain = fieldFor({ type: 'string' });
      assert.isTrue(plain.preview === null);
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
    it('preserves prototype-named defaults as own JSON members', function () {
      const schema = JSON.parse('{"type":"object","properties":{"__proto__":{"default":{"role":"admin"}},"constructor":{"const":3},"toString":{"default":"label"}}}');
      const data = createInitialData(buildFormModel(schema));
      assert.deepStrictEqual(data, JSON.parse('{"__proto__":{"role":"admin"},"constructor":3,"toString":"label"}'));
      assert.strictEqual(Object.getPrototypeOf(data), Object.prototype);
      assert.strictEqual(data.role, undefined);
      assert.strictEqual(JSON.stringify(data), '{"__proto__":{"role":"admin"},"constructor":3,"toString":"label"}');
    });

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
    assert.isTrue(getFormatInfo('geohash').test('u173z'));
    assert.isTrue(getFormatInfo('wkt').test('POINT (4.9041 52.3676)'));
  });

  it('should carry a preview hint for geojson, and none for a format a text control shows in full', function () {
    // the hint is DATA: a host with a map renderer draws the parsed
    // value beside the textarea, one without ignores the member
    assert.deepEqual(getFormatInfo('geojson').preview, { kind: 'map' });
    assert.isTrue(getFormatInfo('email').preview === undefined);
    assert.isTrue(getFormatInfo('wkt').preview === undefined);
    assert.isTrue(getFormatInfo('geohash').preview === undefined);
    // and the control, placeholder and test are exactly what they were
    const geojson = getFormatInfo('geojson');
    assert.isTrue(geojson.control === 'textarea');
    assert.isTrue(typeof geojson.placeholder === 'string');
    assert.isTrue(geojson.test('{"type":"Point","coordinates":[4.9,52.4]}'));
    assert.isTrue(!geojson.test('{"type":"Circle","coordinates":[4.9,52.4]}'));
  });

  it("should parse a field's text before judging it as GeoJSON", function () {
    // the canonical geojson tester takes the OBJECT; the form hint
    // overrides it with a parse-first test because a field holds text
    const geojson = getFormatInfo('geojson');
    assert.isTrue(geojson.control === 'textarea');
    assert.isTrue(geojson.test('{"type":"Point","coordinates":[4.9,52.4]}'));
    assert.isTrue(!geojson.test('{"type":"Point","coordinates":[4.9,52.4]'), 'unparseable text');
    assert.isTrue(!geojson.test('{"type":"Polygon","coordinates":[[[0,0],[4,0],[4,4],[1,1]]]}'), 'open ring');
  });

  it('should test regular expressions for validity', function () {
    assert.isTrue(getFormatInfo('regex').test('^[a-z]+$'));
    assert.isTrue(!getFormatInfo('regex').test('(unclosed'));
  });

  it('should accept anything for control-hint-only formats', function () {
    assert.isTrue(getFormatInfo('password').test('anything at all'));
    assert.isTrue(getFormatInfo('textarea').test('multi\nline'));
    assert.isTrue(getFormatInfo('multiline').test(''));
    assert.isTrue(getFormatInfo('password').control === 'password');
    assert.isTrue(getFormatInfo('textarea').control === 'textarea');
  });
});

describe('date fields carry their controls and bounds', () => {
  const model = buildFormModel({
    type: 'object',
    properties: {
      born: {
        type: 'string', format: 'date',
        formatMinimum: '1900-01-01', formatMaximum: '2026-12-31',
      },
      seen: { type: 'string', format: 'iso-date-time' },
      at: { type: 'string', format: 'iso-time' },
      stamp: { type: 'string', format: 'date-time' },
      clock: { type: 'string', format: 'time' },
      span: { type: 'string', format: 'duration' },
    },
  });
  const field = (key) => model.children.find((f) => f.key === key);

  it('should give a native control only where the offset allows one', () => {
    // HTML's datetime-local/time inputs cannot produce an offset, and
    // RFC 3339 requires one — binding them would make the control emit
    // values its own schema rejects. The ISO formats leave the offset
    // optional, so they map losslessly.
    assert.strictEqual(field('born').control, 'date');
    assert.strictEqual(field('seen').control, 'datetime-local');
    assert.strictEqual(field('at').control, 'time');
    assert.strictEqual(field('stamp').control, 'text', 'date-time needs an offset');
    assert.strictEqual(field('clock').control, 'text', 'time needs an offset');
    assert.strictEqual(field('span').control, 'text');
  });

  it('should expose the format bounds as constraints', () => {
    assert.strictEqual(field('born').constraints.formatMinimum, '1900-01-01');
    assert.strictEqual(field('born').constraints.formatMaximum, '2026-12-31');
    // a field without bounds carries none, so the control omits min/max
    assert.strictEqual(field('seen').constraints.formatMinimum, undefined);
  });

  it('should carry the exclusive bounds too', () => {
    const m = buildFormModel({
      type: 'object',
      properties: {
        d: {
          type: 'string', format: 'date',
          formatExclusiveMinimum: '2026-01-01', formatExclusiveMaximum: '2026-12-31',
        },
      },
    });
    const c = m.children[0].constraints;
    assert.strictEqual(c.formatExclusiveMinimum, '2026-01-01');
    assert.strictEqual(c.formatExclusiveMaximum, '2026-12-31');
  });
});
