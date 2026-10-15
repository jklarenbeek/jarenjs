// A `$ref` target is compiled under the draft its own place declares: the
// nearest `$schema` on the way to it in the document that holds it. Compiled
// with no draft, a 2019-09 document read `prefixItems` through a reference
// that it ignores inline.
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import { compileAsync } from '@jarenjs/validate/load';

const D7 = 'http://json-schema.org/draft-07/schema#';
const D19 = 'https://json-schema.org/draft/2019-09/schema';
const D20 = 'https://json-schema.org/draft/2020-12/schema';
const tuple = () => ({ prefixItems: [{ type: 'integer' }] });

describe('a $ref target keeps its document\'s declared draft', () => {
  it('a 2019-09 document ignores prefixItems through a reference, as inline', () => {
    const viaRef = new JarenValidator().compile({ $schema: D19, $defs: { t: tuple() }, $ref: '#/$defs/t' });
    const inline = new JarenValidator().compile({ $schema: D19, ...tuple() });
    assert.deepEqual([viaRef([5]), viaRef(['5'])], [true, true]);
    assert.deepEqual([inline([5]), inline(['5'])], [true, true]);
  });

  it('collected errors no longer report the keyword the draft does not have', () => {
    const validate = new JarenValidator({ collectErrors: true })
      .compile({ $schema: D19, $defs: { t: tuple() }, properties: { a: { $ref: '#/$defs/t' } } });
    assert.deepEqual(validate({ a: ['5'] }), { valid: true, errors: [] });
  });

  it('a 2020-12 document still reads prefixItems through a reference', () => {
    const validate = new JarenValidator().compile({ $schema: D20, $defs: { t: tuple() }, $ref: '#/$defs/t' });
    assert.deepEqual([validate([5]), validate(['5'])], [true, false]);
  });

  it('a document that declares no draft still reads every keyword through a reference', () => {
    const validate = new JarenValidator().compile({ $defs: { t: tuple() }, $ref: '#/$defs/t' });
    assert.deepEqual([validate([5]), validate(['5'])], [true, false]);
  });

  it('a target compiled inline after a reference built it keeps the draft', () => {
    const validate = new JarenValidator().compile({ $schema: D19,
      properties: { a: { $ref: '#/properties/b' }, b: tuple() } });
    assert.deepEqual([validate({ b: ['5'] }), validate({ a: ['5'] })], [true, true]);
  });

  it('an embedded resource without $schema reads the draft of the document around it', () => {
    const validate = new JarenValidator().compile({ $schema: D19, $id: 'https://draft.test/root.json',
      $defs: { t: { $id: 't.json', ...tuple() } }, $ref: 't.json' });
    assert.deepEqual([validate([5]), validate(['5'])], [true, true]);
  });

  it('every declared-draft gate holds through a reference', () => {
    const cases = [
      [D7, { dependentRequired: { a: ['b'] } }, { a: 1 }],
      [D7, { dependentSchemas: { a: { required: ['b'] } } }, { a: 1 }],
      [D7, { contains: { type: 'integer' }, minContains: 2 }, [1]],
      [D7, { properties: { a: true }, unevaluatedProperties: false }, { a: 1, b: 2 }],
      [D7, { items: [true], unevaluatedItems: false }, [1, 2]],
    ];
    for (const [$schema, target, instance] of cases) {
      const viaRef = new JarenValidator().compile({ $schema, definitions: { t: target }, $ref: '#/definitions/t' });
      const inline = new JarenValidator().compile({ $schema, ...target });
      assert.equal(inline(instance), true, JSON.stringify(target));
      assert.equal(viaRef(instance), true, JSON.stringify(target));
    }
  });

  it('propertyDependencies is not a keyword through a reference in a 2019-09 document', () => {
    const target = { propertyDependencies: { kind: { a: { required: ['b'] } } } };
    const options = { propertyDependencies: true };
    const viaRef = new JarenValidator(options).compile({ $schema: D19, $defs: { t: target }, $ref: '#/$defs/t' });
    const inline = new JarenValidator(options).compile({ $schema: D19, ...target });
    assert.deepEqual([inline({ kind: 'a' }), viaRef({ kind: 'a' })], [true, true]);
  });
});

describe('a target in another document keeps that document\'s declared draft', () => {
  const held = { $schema: D19, $id: 'https://draft.test/t19.json', $defs: { t: tuple() } };
  const held20 = { $schema: D20, $id: 'https://draft.test/t20.json', $defs: { t: tuple() } };

  it('through addSchema and compile', () => {
    const validator = new JarenValidator().addSchema(held).addSchema(held20);
    const into20 = validator.compile({ $schema: D20, $ref: 'https://draft.test/t19.json#/$defs/t' });
    const into19 = validator.compile({ $schema: D19, $ref: 'https://draft.test/t20.json#/$defs/t' });
    assert.deepEqual([into20(['5']), into19(['5']), into19([5])], [true, false, true]);
  });

  it('through compileAsync', async () => {
    const validate = await compileAsync(new JarenValidator(),
      { $schema: D20, $ref: 'https://draft.test/t19.json#/$defs/t' },
      { loadSchema: async () => structuredClone(held) });
    assert.deepEqual([validate([5]), validate(['5'])], [true, true]);
  });
});

describe('contains annotates the items it matches by the draft of its own document', () => {
  const held = () => ({ $schema: D20, $id: 'https://draft.test/contains.json',
    contains: { type: 'string' }, unevaluatedItems: false });

  it('a 2020-12 document referenced from a draft-07 or undeclared schema', () => {
    for (const $schema of [D7, undefined, D20]) {
      const validate = new JarenValidator().addSchema(held())
        .compile({ ...($schema === undefined ? {} : { $schema }), $ref: 'https://draft.test/contains.json' });
      assert.deepEqual([validate(['a']), validate(['a', 1])], [true, false], String($schema));
      const every = new JarenValidator().addSchema({ ...held(), $id: 'https://draft.test/every.json', contains: true })
        .compile({ ...($schema === undefined ? {} : { $schema }), $ref: 'https://draft.test/every.json' });
      assert.deepEqual([every([1, 'a']), every([])], [true, false], String($schema));
    }
  });
});

describe('the keywords beside a target\'s own $ref assert by its document\'s draft', () => {
  const held = ($schema, $id, key) => ({ $schema, $id,
    [key]: { x: { $ref: `#/${key}/y`, minimum: 5 }, y: { type: 'integer' } } });

  it('a draft-07 target referenced from a 2020-12 schema ignores them', () => {
    const validate = new JarenValidator().addSchema(held(D7, 'https://draft.test/d7.json', 'definitions'))
      .compile({ $schema: D20, $ref: 'https://draft.test/d7.json#/definitions/x' });
    assert.deepEqual([validate(1), validate(7), validate('a')], [true, true, false]);
  });

  it('a 2020-12 target referenced from a draft-07 schema asserts them', () => {
    const validate = new JarenValidator().addSchema(held(D20, 'https://draft.test/d20.json', '$defs'))
      .compile({ $schema: D7, $ref: 'https://draft.test/d20.json#/$defs/x' });
    assert.deepEqual([validate(1), validate(7), validate('a')], [false, true, false]);
  });
});
