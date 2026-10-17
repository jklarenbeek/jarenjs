//@ts-check
/**
 * @file A JSON Schema regular expression is an ECMA-262 pattern source
 * (JSON Schema 2020-12 Validation §6.3.3): `pattern`, `patternProperties`
 * and the normalizer read a string written `/a/` as the five characters
 * it holds, never as a `/source/flags` literal.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JarenValidator } from '@jarenjs/validate';
import { compileNormalizer } from '@jarenjs/validate/normalize';
import { stringFormats } from '@jarenjs/formats';

/** @param {any} schema @returns {(data: unknown) => boolean} */
const compile = (schema) => /** @type {any} */ (new JarenValidator().compile(schema));

describe('pattern reads a string as a pattern source', () => {
  it('"/a/" matches text containing /a/, not "a"', () => {
    const validate = compile({ type: 'string', pattern: '/a/' });
    assert.equal(validate('x/a/y'), true);
    assert.equal(validate('/a/'), true);
    assert.equal(validate('a'), false);
  });

  it('"/a/i" is not case-insensitive: it matches the text /a/i', () => {
    const validate = compile({ type: 'string', pattern: '/a/i' });
    assert.equal(validate('/a/i'), true);
    assert.equal(validate('A'), false);
    assert.equal(validate('a'), false);
    assert.equal(validate('/a/'), false);
  });

  it('"/\\\\$ref/" needs the slashes on both sides', () => {
    const validate = compile({ type: 'string', pattern: '/\\$ref/' });
    assert.equal(validate('/items/$ref/type'), true);
    assert.equal(validate('/items/$ref'), false);
  });

  it('the pattern-only and the combined string checks agree', () => {
    const only = compile({ type: 'string', pattern: '/a/' });
    const combined = compile({ type: 'string', minLength: 1, maxLength: 9, pattern: '/a/' });
    for (const text of ['a', 'x/a/y', '/a/'])
      assert.equal(combined(text), only(text), text);
  });

  it('a failure names the pattern as the schema wrote it', () => {
    for (const pattern of ['/a/', '^/users/[0-9]+$']) {
      // the pattern-only check and the combined one
      for (const schema of [{ type: 'string', pattern }, { type: 'string', minLength: 1, pattern }]) {
        const result = /** @type {any} */ (new JarenValidator({ collectErrors: true }).compile(schema))('a');
        assert.equal(result.valid, false);
        assert.deepEqual(result.errors.map((/** @type {any} */ e) => [e.keyword, e.params]),
          [['pattern', { pattern }]]);
      }
    }
  });

  it('a string that is no valid source but a v-mode literal is still read as the literal', () => {
    const validate = compile({ type: 'string', pattern: '/[\\p{L}--[a-z]]/v' });
    assert.equal(validate('A'), true);
    assert.equal(validate('a'), false);
    assert.throws(() => compile({ type: 'string', pattern: '/[\\p{L}--[a-z]]/' }),
      (e) => e.code === 'JK0014' && e.docPath === '#/pattern' && e.cause instanceof SyntaxError);
  });

  it('a RegExp a JavaScript caller places in a schema keeps its flags', () => {
    const validate = compile({ type: 'string', pattern: /^a$/i });
    assert.equal(validate('A'), true);
    assert.equal(validate('/a/'), false);
  });
});

describe('patternProperties reads its keys as pattern sources', () => {
  it('"/a/" covers the member x/a/y, not the member a', () => {
    const validate = compile({ patternProperties: { '/a/': { type: 'number' } } });
    assert.equal(validate({ a: 'text' }), true);
    assert.equal(validate({ 'x/a/y': 'text' }), false);
    assert.equal(validate({ 'x/a/y': 1 }), true);
  });

  it('the normalizer covers the same members the validator does', () => {
    const schema = { patternProperties: { '/a/i': { type: 'number' } }, additionalProperties: false };
    const normalize = compileNormalizer(schema, { removeAdditional: true, coerceTypes: true });
    assert.deepEqual(normalize({ A: '1', a: '2', 'x/a/i': '3' }), { 'x/a/i': 3 });
    assert.equal(compile(schema)({ 'x/a/i': 3 }), true);
    assert.equal(compile(schema)({ A: 3 }), false);
  });
});

describe('the 2020-12 output schema', () => {
  const outputSchema = JSON.parse(fs.readFileSync(
    new URL('./fixtures/output-formats/suite-draft2020-12-output-schema.json', import.meta.url), 'utf8'));
  const unit = /** @type {(data: unknown) => boolean} */ (/** @type {any} */ (new JarenValidator()
    .addSchema(outputSchema)
    .compile({ $ref: 'https://json-schema.org/draft/2020-12/output/schema#/$defs/outputUnit' })));

  it('asks for absoluteKeywordLocation only when a location passes through /$ref/', () => {
    assert.equal(unit({ valid: true, keywordLocation: '/properties/a/$ref', instanceLocation: '/a' }), true);
    assert.equal(unit({ valid: true, keywordLocation: '/properties/a/$ref/type', instanceLocation: '/a' }), false);
    assert.equal(unit({
      valid: true, keywordLocation: '/properties/a/$ref/type', instanceLocation: '/a',
      absoluteKeywordLocation: 'https://example.com/a#/type',
    }), true);
  });
});

describe('the instance-data pattern readers read a source too', () => {
  it('$data and data patterns: "/a/" matches x/a/y, not a', () => {
    for (const reader of [{ $data: '1/p' }, undefined]) {
      const value = reader === undefined
        ? { type: 'string', data: { pattern: '/p' } }
        : { type: 'string', pattern: reader };
      const validate = compile({ properties: { value, p: { type: 'string' } } });
      assert.equal(validate({ value: 'x/a/y', p: '/a/' }), true);
      assert.equal(validate({ value: 'a', p: '/a/' }), false);
    }
  });

  it('read a v-mode literal as the static pattern does', () => {
    const literal = '/[\\p{L}--[a-z]]/v';
    const fixed = compile({ type: 'string', pattern: literal });
    assert.deepEqual([fixed('A'), fixed('a')], [true, false]);
    for (const reader of [{ $data: '1/p' }, undefined]) {
      const value = reader === undefined
        ? { type: 'string', data: { pattern: '/p' } }
        : { type: 'string', pattern: reader };
      const validate = compile({ properties: { value, p: { type: 'string' } } });
      assert.deepEqual([validate({ value: 'A', p: literal }), validate({ value: 'a', p: literal })], [true, false]);
    }
  });
});

describe("format 'regex' accepts what pattern compiles", () => {
  const validate = /** @type {(data: unknown) => boolean} */ (/** @type {any} */ (new JarenValidator()
    .addFormats(stringFormats).compile({ format: 'regex' })));

  it('reads a slash-delimited string as a source', () => {
    // valid sources whose literal reading has flags the engine refuses
    assert.equal(validate('/a/gg'), true);
    assert.equal(validate('/a/uv'), true);
    assert.equal(validate('/a/i'), true);
    // no valid Unicode-mode source, but a v-mode literal: still the literal
    assert.equal(validate('/[\\p{L}--[a-z]]/v'), true);
    assert.equal(validate('/[\\p{L}--[a-z]]/'), false);
  });

  it('agrees with pattern on every case', () => {
    for (const source of ['/a/gg', '/a/uv', '/[\\p{L}--[a-z]]/v', '/[\\p{L}--[a-z]]/', '^(abc]', '([abc])+\\s+$']) {
      let compiles = true;
      try { compile({ pattern: source }); }
      catch { compiles = false; }
      assert.equal(validate(source), compiles, source);
    }
  });
});
