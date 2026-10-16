//@ts-check
/**
 * @file A `$ref` with white space around it, or a tab or line break inside
 * it, resolves in `@jarenjs/emit` to the node the validator applies (the URL
 * standard drops them, and `compileNormalizer` reads the reference so too):
 * the generated type is the one the clean spelling gives.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { emitTypeScript } from '@jarenjs/emit/typescript';
import { JarenValidator } from '@jarenjs/validate';

const DRAFT_2020 = 'https://json-schema.org/draft/2020-12/schema';
/** @param {string} ref @param {string} self */
const schema = (ref, self) => ({ $schema: DRAFT_2020, type: 'object', properties: { kid: { $ref: ref }, self: { $ref: self } }, $defs: { n: { type: 'integer' } } });

describe('emit — a $ref read as the URL standard reads it', () => {
  const clean = emitTypeScript(schema('#/$defs/n', '#'), { rootName: 'R' });

  it('the clean spelling types the target', () => {
    assert.match(clean, /kid\?: N;/);
    assert.match(clean, /self\?: Root;/);
  });

  it('a target outside $defs is named by its last token, whatever white space the reference carries', () => {
    /** @param {string} ref */
    const named = (ref) => emitTypeScript({ $schema: DRAFT_2020, type: 'object', properties: { a: { type: 'object', properties: { z: { type: 'string' } } }, b: { $ref: ref } } }, { rootName: 'R' });
    const plain = named('#/properties/a');
    assert.match(plain, /export interface A \{/);
    assert.match(plain, /b\?: A;/);
    for (const ref of [' #/properties/a', '#/properties/a\n', '\t#/prop\terties/a']) assert.equal(named(ref), plain, JSON.stringify(ref));
  });

  for (const [ref, self] of [['#/$defs/n ', ' #'], [' #/$defs/n', '#\t'], ['#/$defs/\nn', '\n#'], ['\t#/$de\tfs/n\r\n', '#  ']]) {
    it(`${JSON.stringify(ref)} and ${JSON.stringify(self)}: the clean spelling's types`, () => {
      const s = schema(ref, self);
      const check = new JarenValidator().compile(s);
      assert.deepEqual([check({ kid: 1, self: { kid: 2 } }), check({ self: { kid: 'x' } })], [true, false], 'the validator applies both');
      assert.equal(emitTypeScript(s, { rootName: 'R' }), clean);
    });
  }
});
