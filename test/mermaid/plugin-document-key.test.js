//@ts-check
/**
 * @file The Markdown plugin keys a diagram given as a parsed document by
 * the hash its parse recorded, as the renderer reads it: it used to hash
 * the document object, which answered the empty string's hash for every
 * document, so two different diagrams shared one key.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mermaidPlugin } from '../../components/mermaid/src/plugin.js';
import { parseMermaid } from '../../components/mermaid/src/index.js';
import { hashContent } from '../../packages/core/src/string.js';

const source = 'graph TD\nA-->B';
const other = 'graph TD\nC-->D';

describe('mermaid plugin key for a parsed document', () => {
  it('keys a document as its source keys', () => {
    const plugin = mermaidPlugin({ interactive: true });
    const fromSource = plugin.render({ value: source });
    const fromDoc = plugin.render({ value: parseMermaid(source) });
    assert.strictEqual(fromSource[1].key, hashContent(source));
    assert.strictEqual(fromDoc[1].key, fromSource[1].key);
    assert.strictEqual(fromDoc[1]['data-md-hash'], fromSource[1]['data-md-hash']);
    assert.notStrictEqual(plugin.render({ value: parseMermaid(other) })[1].key, fromDoc[1].key);
    assert.deepStrictEqual(fromDoc[2], fromSource[2]);
  });

  it('a value with no recorded hash keys as the renderer names it', () => {
    assert.strictEqual(mermaidPlugin().render({ value: /** @type {any} */ (42) })[1].key, '0');
  });
});
