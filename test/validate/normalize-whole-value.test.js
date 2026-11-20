//@ts-check
/**
 * @file A default the normalizer fills is kept only where the schemas
 * applied at a place above it that read its whole value answer as they
 * answer without it. Such a place holds an `enum`, a `const` or a
 * `uniqueItems`, or an instance reference below it climbs back to it (a
 * `$data` or `data` pointer); one that may read anywhere (from the root, a
 * `$query`) makes the root such a place. A call that filled a default below
 * one runs the value through the same steps without those defaults too and
 * keeps the defaults where every schema applied there answers the two
 * alike, else that value: all the defaults below the place together, after
 * every such place below it decided. A value refused both ways keeps them.
 * Before, only the object holding the member was read, so a valid input
 * could normalize into a value the validator refuses.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { compileNormalizer, unfilledDefaults } from '@jarenjs/validate/normalize';

const D20 = 'https://json-schema.org/draft/2020-12/schema';
/** The normalized value, and the validator's answer for the input and for it. @param {any} schema @param {unknown} input */
const run = (schema, input) => {
  const out = compileNormalizer(schema, { useDefaults: true })(input);
  const validate = new JarenValidator().compile(schema);
  return [out, validate(input), validate(out)];
};
/** @param {any} schema @returns {string[]} The members unfilledDefaults names, by object, joined */
const unfilled = (schema) => [...unfilledDefaults(schema, { useDefaults: true }).values()].flatMap((keys) => [...keys]).sort();

describe('a valid input stays valid (each filled into a refusal before)', () => {
  for (const draft of [undefined, D20]) {
    const at = (/** @type {object} */ s) => (draft === undefined ? s : { $schema: draft, ...s });
    it(`an enum, a uniqueItems, a $data sibling and a const above the default${draft ? ', 2020-12' : ''}`, () => {
      assert.deepEqual(run(at({ enum: [{ o: {} }], properties: { o: { properties: { a: { default: 1 } } } } }), { o: {} }), [{ o: {} }, true, true]);
      assert.deepEqual(run(at({ type: 'array', uniqueItems: true, items: { properties: { a: { default: 1 } } } }), [{}, { a: 1 }]), [[{}, { a: 1 }], true, true]);
      assert.deepEqual(run(at({ properties: { a: { default: 5 }, b: { maximum: { $data: '1/a' } } } }), { b: 9 }), [{ b: 9 }, true, true]);
      assert.deepEqual(run(at({ const: { o: {} }, properties: { o: { properties: { a: { default: 1 } } } } }), { o: {} }), [{ o: {} }, true, true]);
    });
  }

  it('a pointer that climbs two levels, one under a branch, one in the data keyword, and one from the root', () => {
    assert.deepEqual(run({ properties: { a: { default: 5 }, b: { properties: { c: { maximum: { $data: '2/a' } } } } } }, { b: { c: 9 } })[0], { b: { c: 9 } });
    assert.deepEqual(run({ properties: { a: { default: 5 }, b: { anyOf: [{ maximum: { $data: '1/a' } }] } } }, { b: 9 })[0], { b: 9 });
    assert.deepEqual(run({ properties: { a: { default: 5 }, l: { items: { maximum: { $data: '2/a' } } } } }, { l: [9] }), [{ l: [9] }, true, true]);
    assert.deepEqual(run({ properties: { a: { default: 5 }, b: { maximum: { $data: '/a' } } } }, { b: 9 }), [{ b: 9 }, true, true]);
    assert.deepEqual(run({ properties: { o: { properties: { a: { default: 5 } } }, b: { maximum: { $data: '/o/a' } } } }, { o: {}, b: 9 }), [{ o: {}, b: 9 }, true, true]);
  });
});

describe('what was filled and accepted is still filled', () => {
  it('where the place above answers alike with the defaults', () => {
    assert.deepEqual(run({ properties: { a: { default: 5 }, b: { maximum: { $data: '1/a' } } } }, { b: 3 }), [{ b: 3, a: 5 }, true, true]);
    assert.deepEqual(run({ enum: [{ o: {} }, { o: { a: 1, b: 2 } }], properties: { o: { properties: { a: { default: 1 }, b: { default: 2 } } } } }, { o: {} })[0], { o: { a: 1, b: 2 } });
    assert.deepEqual(run({ type: 'array', uniqueItems: true, items: { properties: { a: { default: 1 } } } }, [{}, { a: 2 }])[0], [{ a: 1 }, { a: 2 }]);
    assert.deepEqual(run({ maxProperties: 5, properties: { a: { default: 1 } } }, {})[0], { a: 1 });
    assert.deepEqual(run({ properties: { a: { default: 1 }, b: {} }, dependentRequired: { a: ['b'] } }, { b: 2 })[0], { b: 2, a: 1 });
    assert.deepEqual(run({ properties: { e: { enum: ['x', 'y'] }, a: { default: 1 } } }, {})[0], { a: 1 });
  });

  it('where the value is refused both ways, or comes to be accepted', () => {
    const schema = { const: { o: { a: 1 } }, properties: { o: { properties: { a: { default: 1 } } } } };
    assert.deepEqual(run(schema, { o: {} }), [{ o: { a: 1 } }, false, true]);
    assert.deepEqual(run(schema, { o: { b: 1 } }), [{ o: { b: 1, a: 1 } }, false, false]);
  });
});

describe('how the defaults below such a place are decided', () => {
  it('all together: one that changes the answer leaves out the others', () => {
    const schema = { enum: [{ o: {} }, { o: { a: 1 } }], properties: { o: { properties: { a: { default: 1 }, b: { default: 2 } } } } };
    assert.deepEqual(run(schema, { o: {} }), [{ o: {} }, true, true]);
  });

  it('a place above decides after the place below it: an outer const leaves out what an inner enum kept', () => {
    const inner = { enum: [{}, { a: 1 }], properties: { a: { default: 1 } } };
    assert.deepEqual(run({ properties: { o: { properties: { p: inner } } } }, { o: { p: {} } })[0], { o: { p: { a: 1 } } });
    assert.deepEqual(run({ const: { o: { p: {} } }, properties: { o: { properties: { p: inner } } } }, { o: { p: {} } }), [{ o: { p: {} } }, true, true]);
  });

  it('coercion, trimming and stripping still apply where the defaults are left out', () => {
    const schema = { enum: [{ o: { n: 1 } }], properties: { o: { properties: { n: { type: 'integer' }, a: { default: 1 } }, additionalProperties: false } } };
    const out = compileNormalizer(schema, { useDefaults: true, coerceTypes: true, removeAdditional: true })({ o: { n: '1', x: 0 } });
    assert.deepEqual(out, { o: { n: 1 } });
  });

  it('a place with no default below it adds no check: one that cannot compile leaves the others answering', () => {
    // `e` reads its whole value, and the checking validator refuses to compile it; `b` is checked in the same group
    const schema = { properties: { e: { enum: ['x'], type: 'string', format: 'nope' }, b: { type: 'integer', default: 'y' } } };
    const createValidator = () => new JarenValidator({ unknownFormats: 'error', formatAssertion: true });
    assert.deepEqual(compileNormalizer(schema, { useDefaults: true, coerceTypes: true, createValidator })({ e: 'x' }), { e: 'x' });
  });

  it('a call that fills no default below such a place checks nothing', () => {
    let validations = 0;
    /** @param {any} bounds */
    const createValidator = (bounds) => {
      const validator = new JarenValidator(bounds);
      const compile = validator.compile.bind(validator);
      validator.compile = /** @type {any} */ ((/** @type {any} */ schema) => {
        const validate = compile(schema);
        return (/** @type {unknown} */ data) => { validations++; return validate(data); };
      });
      return validator;
    };
    const normalize = compileNormalizer({ enum: [{ o: { a: 2 } }, { o: {} }], properties: { o: { properties: { a: { default: 1 } } } } },
      { useDefaults: true, createValidator });
    assert.deepEqual(normalize({ o: { a: 2 } }), { o: { a: 2 } });
    assert.equal(validations, 0);
    assert.deepEqual(normalize({ o: {} }), { o: {} });
    assert.ok(validations > 0);
  });
});

describe('unfilledDefaults names the defaults below such a place', () => {
  it('and no other', () => {
    assert.deepEqual(unfilled({ enum: [{ o: {} }], properties: { o: { properties: { a: { default: 1 } } } } }), ['a']);
    assert.deepEqual(unfilled({ properties: { a: { default: 5 }, b: { maximum: { $data: '1/a' } } } }), ['a']);
    assert.deepEqual(unfilled({ properties: { a: { default: 5 }, b: { maximum: { $data: '0' } } } }), []);
    assert.deepEqual(unfilled({ properties: { e: { enum: ['x'] }, a: { default: 1 } } }), []);
    // a member named like a keyword, and data, read nothing
    assert.deepEqual(unfilled({ properties: { data: { type: 'object' }, $query: {}, a: { default: 1 } } }), []);
    assert.deepEqual(unfilled({ properties: { a: { default: { x: { $data: '/a' } } } }, examples: [{ x: { $data: '' } }] }), []);
  });
});

describe('a property: a generated valid input normalizes into a valid value', () => {
  /** A seeded generator of numbers in [0, 1). @param {number} seed */
  const random = (seed) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

  /**
   * An instance, and a schema it is valid under, with defaults at every
   * level and keywords above them that read the whole value.
   * @param {() => number} r @param {number} depth
   * @returns {[any, any]}
   */
  const generate = (r, depth) => {
    const instance = /** @type {Record<string, any>} */ ({});
    const properties = /** @type {Record<string, any>} */ ({});
    for (const key of ['a', 'b', 'c']) {
      const value = Math.floor(r() * 4);
      if (r() < 0.5) instance[key] = value;
      properties[key] = r() < 0.7 ? { type: 'integer', default: Math.floor(r() * 4) } : { type: 'integer' };
    }
    if (r() < 0.4) properties.b = { ...properties.b, maximum: { $data: '1/a' } };
    if (instance.b !== undefined && instance.a !== undefined && instance.b > instance.a) instance.b = instance.a;
    if (depth > 0 && r() < 0.8) {
      const [inner, schema] = generate(r, depth - 1);
      properties.o = schema;
      if (r() < 0.7) instance.o = inner;
      if (r() < 0.3) properties.o = { ...schema, default: {} };
    }
    if (depth > 0 && r() < 0.4) {
      const [one, item] = generate(r, depth - 1);
      const [two] = generate(r, depth - 1);
      properties.l = { type: 'array', uniqueItems: true, items: item };
      const list = [one, two].filter((v, i, all) => JSON.stringify(v) !== JSON.stringify(all[1 - i]) || i === 0);
      if (r() < 0.7) instance.l = list;
    }
    const schema = /** @type {Record<string, any>} */ ({ type: 'object', properties });
    const roll = r();
    if (roll < 0.2) schema.const = structuredClone(instance);
    else if (roll < 0.4) schema.enum = [structuredClone(instance), { z: 1 }];
    else if (roll < 0.5) schema.maxProperties = Object.keys(instance).length + Math.floor(r() * 2);
    if (r() < 0.2) schema.properties.c = { ...schema.properties.c, minimum: { $data: '/a' } };
    return [instance, schema];
  };

  it('for 400 generated schemas and inputs, under the same validator', () => {
    const r = random(20261120);
    let checked = 0;
    let filled = 0;
    for (let i = 0; i < 400; i++) {
      const [input, schema] = generate(r, 3);
      const validate = new JarenValidator().compile(schema);
      if (validate(input) !== true) continue;
      checked++;
      const out = compileNormalizer(schema, { useDefaults: true })(input);
      if (JSON.stringify(out) !== JSON.stringify(input)) filled++;
      assert.equal(validate(out), true, `${JSON.stringify(schema)} on ${JSON.stringify(input)} gave ${JSON.stringify(out)}`);
    }
    // the property is not vacuous: most inputs are valid, and most fill something
    assert.ok(checked > 200, `${checked} valid inputs`);
    assert.ok(filled > 60, `${filled} filled`);
  });
});
