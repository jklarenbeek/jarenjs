import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { JarenValidator } from '@jarenjs/validate';
import { compileNormalizer } from '@jarenjs/validate/normalize';
import { getSchemaDraftByVersion } from '@jarenjs/refs';

describe('validator and normalizer consistency', () => {
  it('preserves and normalizes members accepted by slash-delimited patterns', () => {
    const schema = {
      patternProperties: { '/^x/i': { type: 'number' } }, additionalProperties: false,
    };
    const normalize = compileNormalizer(schema, { removeAdditional: true, coerceTypes: true });
    const input = { X: '2', extra: true };
    assert.deepEqual(normalize(input), { X: 2 });
    assert.equal(new JarenValidator().compile(schema)(normalize(input)), true);
    assert.deepEqual(input, { X: '2', extra: true });
    assert.deepEqual(normalize(normalize(input)), { X: 2 });
  });

  it('keeps global and sticky patterns stateless across members and calls', () => {
    for (const flags of ['g', 'y', 'gy']) {
      const scalar = new JarenValidator().compile({ type: 'string', pattern: `/x/${flags}` });
      const schema = { patternProperties: { [`/^x/${flags}`]: { type: 'number' } }, additionalProperties: false };
      const validate = new JarenValidator().compile(schema);
      const normalize = compileNormalizer(schema, { removeAdditional: true, coerceTypes: true });
      for (let i = 0; i < 3; i++) {
        assert.equal(scalar('x'), true);
        assert.equal(validate({ x: 1, xx: 2 }), true);
        assert.deepEqual(normalize({ x: '1', xx: '2' }), { x: 1, xx: 2 });
      }
      assert.equal(scalar('ax'), flags.includes('y') ? false : true);
    }
  });

  it('does not round an unsafe integer transport value into another integer', () => {
    const normalize = compileNormalizer({ type: 'integer' }, { coerceTypes: true });
    assert.equal(normalize('9007199254740993'), '9007199254740993');
    assert.equal(normalize('-9007199254740993'), '-9007199254740993');
    assert.equal(normalize('9007199254740991'), 9007199254740991);
    assert.equal(normalize('1e3'), 1000);
  });

  it('applies data constraints alongside a modern draft reference', () => {
    const validate = new JarenValidator().compile({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $defs: { number: { type: 'number' } },
      properties: { limit: { type: 'number' }, value: { $ref: '#/$defs/number', data: { maximum: '/limit' } } },
    });
    assert.equal(validate({ limit: 1, value: 2 }), false);
    assert.equal(validate({ limit: 2, value: 1 }), true);
  });
});

describe('schema registration', () => {
  it('replaces both empty-fragment aliases while preserving named anchors', () => {
    for (const firstSuffix of ['', '#']) {
      for (const nextSuffix of ['', '#']) {
        const validator = new JarenValidator()
          .addSchema({ type: 'string' }, 'https://example.test/schema' + firstSuffix)
          .addSchema({ type: 'boolean' }, 'https://example.test/schema#named')
          .addSchema({ type: 'number' }, 'https://example.test/schema' + nextSuffix);
        for (const suffix of ['', '#']) {
          assert.deepEqual(validator.getSchema('https://example.test/schema' + suffix), { type: 'number' });
          const validate = validator.compile({ $ref: 'https://example.test/schema' + suffix });
          assert.equal(validate(1), true);
          assert.equal(validate('text'), false);
        }
        assert.deepEqual(validator.getSchema('https://example.test/schema#named'), { type: 'boolean' });
        assert.equal(validator.getSchema('https://example.test/schema#named#'), null);
      }
    }
  });

  it('registers both boolean schemas under explicit keys', () => {
    for (const schema of [false, true]) {
      const validator = new JarenValidator().addSchema(schema, 'https://example.test/boolean');
      assert.equal(validator.getSchema('https://example.test/boolean'), schema);
      assert.equal(validator.getSchema('https://example.test/boolean#'), schema);
      assert.equal(validator.compile({ $ref: 'https://example.test/boolean' })(1), schema);
    }
  });

  it('compiles the same registered schema repeatedly without duplicate registration', () => {
    const schema = { $id: 'https://example.test/registered', type: 'string' };
    const validator = new JarenValidator().addSchema(schema);
    for (let i = 0; i < 2; i++) {
      const validate = validator.compile(schema);
      assert.equal(validate('yes'), true);
      assert.equal(validate(1), false);
    }
    assert.throws(() => validator.compile({ ...schema, type: 'number' }), /already exists/);
  });

  for (const version of [6, 7, 2019, 2020]) {
    it(`registers the draft ${version} bundle without mutation and returns schema booleans`, () => {
      const bundle = structuredClone(getSchemaDraftByVersion(version));
      const before = structuredClone(bundle.schema);
      for (const collectErrors of [false, true]) {
        const validator = new JarenValidator({ collectErrors }).addMetaSchema(bundle.schema);
        assert.deepEqual(bundle.schema, before);
        for (const suffix of ['', '#']) {
          assert.equal(validator.validateSchema({ $schema: bundle.draft + suffix, type: 'string' }), true);
          assert.equal(validator.validateSchema({ $schema: bundle.draft + suffix, type: 123 }), false);
        }
      }
    });
  }

  it('uses draft 07 for both schema compilation and implicit meta validation', () => {
    const validator = new JarenValidator().addMetaSchema([...getSchemaDraftByVersion(7).schema]);
    assert.equal(validator.validateSchema({ type: 'string' }), true);
    assert.equal(validator.validateSchema({ type: 123 }), false);
    assert.equal(validator.validateSchema(true), true);
    assert.equal(validator.validateSchema(false), true);
  });

  it('refuses recursive query schema compilation promptly and leaves later compiles usable', () => {
    // A subprocess timeout turns an unbounded compile into a deterministic test failure.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { JarenValidator } from '@jarenjs/validate';
      const validator = new JarenValidator().addSchema({
        $id: 'https://example.test/recursive', type: 'object',
        $query: { $valid: ['$.child', { $ref: 'https://example.test/recursive' }] },
      });
      try { validator.compile({ $ref: 'https://example.test/recursive' }); }
      catch (error) { console.log(error.message.includes('recursive schema compilation')); }
      console.log(new JarenValidator().compile({type:'string'})('ok'));
    `], { encoding: 'utf8', timeout: 3000 });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    assert.equal(result.stdout, 'true\ntrue\n');
  });
});

describe('dynamic anchor scope', () => {
  it('keeps distinct anchor schemas with the same long annotation prefix separate', () => {
    const validate = new JarenValidator().compile({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $defs: {
        a: { $comment: 'x'.repeat(80), $dynamicAnchor: 'a', type: 'number' },
        b: { $comment: 'x'.repeat(80), $dynamicAnchor: 'b', type: 'string' },
      },
      properties: { x: { $dynamicRef: '#a' }, y: { $dynamicRef: '#b' } },
    });
    for (let i = 0; i < 2; i++) {
      assert.equal(validate({ x: 1, y: 'yes' }), true);
      assert.equal(validate({ x: 1, y: 2 }), false);
    }
  });

  it('enters an embedded resource through an ordinary applicator', () => {
    const validate = new JarenValidator().compile({
      $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://example.test/main', if: true,
      then: { $id: 'second', allOf: [{ $ref: 'start' }], $defs: { item: { $dynamicAnchor: 'item', type: 'null' } } },
      $defs: { start: { $id: 'start', $dynamicRef: 'inner#item' }, item: { $id: 'inner', $dynamicAnchor: 'item', type: 'string' } },
    });
    for (let i = 0; i < 2; i++) {
      assert.equal(validate(null), true);
      assert.equal(validate('text'), false);
    }
  });

  it('resolves a relative dynamic reference to the outermost matching anchor', () => {
    const validate = new JarenValidator().compile({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://example.test/root', $dynamicAnchor: 'meta',
      type: 'object', properties: { foo: { const: 'pass' } }, $ref: 'extended',
      $defs: {
        extended: { $id: 'extended', $dynamicAnchor: 'meta', type: 'object', properties: { bar: { $ref: 'bar' } } },
        bar: { $id: 'bar', type: 'object', properties: { baz: { $dynamicRef: 'extended#meta' } } },
      },
    });
    assert.equal(validate({ foo: 'pass', bar: { baz: { foo: 'fail' } } }), false);
    assert.equal(validate({ foo: 'pass', bar: { baz: { foo: 'pass' } } }), true);
  });

  it('does not retain the conditional branch resource after leaving it', () => {
    const validate = new JarenValidator().compile({
      $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://example.test/main',
      if: { $id: 'first', $defs: { item: { $dynamicAnchor: 'item', type: 'number' } } },
      then: { $id: 'second', $ref: 'start', $defs: { item: { $dynamicAnchor: 'item', type: 'null' } } },
      $defs: { start: { $id: 'start', $dynamicRef: 'inner#item' }, item: { $id: 'inner', $dynamicAnchor: 'item', type: 'string' } },
    });
    for (let i = 0; i < 2; i++) {
      assert.equal(validate('text'), false);
      assert.equal(validate(null), true);
      assert.equal(validate(1), false);
    }
  });

  it('ignores dynamic anchors inside instance annotations', () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema', $id: 'https://example.test/root',
      $defs: { base: { $id: 'base', $dynamicAnchor: 'node', type: 'object', properties: { child: { $dynamicRef: '#node' } } } },
      $ref: 'base',
    };
    for (const annotation of [{ default: { $dynamicAnchor: 'node', const: 1 } }, { examples: [{ $dynamicAnchor: 'node', const: 1 }] }]) {
      const validate = new JarenValidator().compile({ ...schema, ...annotation });
      assert.equal(validate({ child: {} }), true);
      assert.equal(validate({ child: 1 }), false);
    }
  });
});
