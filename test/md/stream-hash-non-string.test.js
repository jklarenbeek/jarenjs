//@ts-check
/**
 * @file A non-string chunk fed to the incremental parser is appended to
 * its buffer as its text, and the streamed hash now reads that same
 * text: it used to skip the chunk, so `meta.hash` differed from the
 * whole-source parse of the text the stream did parse.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createIncrementalParser, parseMarkdown } from '../../components/md/src/parser.js';

describe('incremental parser hash over a non-string chunk', () => {
  it('hashes a number chunk as the text it parses', () => {
    const inc = createIncrementalParser();
    inc.feed('# a\n\n');
    inc.feed(/** @type {any} */ (5));
    const doc = inc.end();
    const whole = parseMarkdown('# a\n\n5');
    assert.strictEqual(doc.meta.hash, whole.meta.hash);
    assert.deepStrictEqual(doc.children, whole.children);
  });

  it('hashes a boolean and a bigint chunk as their text', () => {
    const inc = createIncrementalParser();
    inc.feed(/** @type {any} */ (true));
    inc.feed(/** @type {any} */ (10n));
    assert.strictEqual(inc.end().meta.hash, parseMarkdown('true10').meta.hash);
  });

  it('still refuses the chunks that threw before: bytes, null, undefined, an array', () => {
    for (const chunk of [new Uint8Array([35, 32, 97]), null, undefined, ['a']])
      assert.throws(() => createIncrementalParser().feed(/** @type {any} */ (chunk)), TypeError);
  });

  it('string chunks hash as before', () => {
    const inc = createIncrementalParser();
    inc.feed('# a\n');
    inc.feed('\ntext');
    assert.strictEqual(inc.end().meta.hash, parseMarkdown('# a\n\ntext').meta.hash);
  });
});
