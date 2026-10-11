//@ts-check
/**
 * A streamed document parses to what the whole document parses to, whatever
 * the chunk boundaries. A line beginning `---` at the end of a chunk used to
 * close the frontmatter on the spot, before the rest of the line arrived and
 * made it `----` or `--- text` — body, in the whole document.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMarkdown, createIncrementalParser } from '@jarenjs/md';

/**
 * @param {string} source @param {string[]} chunks
 * @returns {{ ast: any, frontmatter: any }}
 */
function streamed(source, chunks) {
  assert.equal(chunks.join(''), source);
  const parser = createIncrementalParser();
  for (const chunk of chunks) parser.feed(chunk);
  const doc = parser.end();
  return { ast: doc.ast, frontmatter: doc.frontmatter };
}

/** Every two-chunk split and every fixed chunk size from one character up. */
function* splits(/** @type {string} */ source) {
  for (let at = 0; at <= source.length; at++) yield [source.slice(0, at), source.slice(at)];
  for (let size = 1; size <= 4; size++) {
    const chunks = [];
    for (let at = 0; at < source.length; at += size) chunks.push(source.slice(at, at + size));
    yield chunks;
  }
}

const DOCUMENTS = [
  '---\n--- - ~~~',
  '---\na: 1\n----\nbody\n',
  '---\na: 1\n--- x\nbody\n',
  '---\ntitle: t\n---\nbody\n',
  '---\ntitle: t\n---',
  '{"title": "t"}\nbody\n',
  '+++\ntitle = "t"\n+++\nbody\n',
  '---\n\nnot frontmatter\n',
];

describe('createIncrementalParser — chunk boundaries do not change the document', function () {
  for (const source of DOCUMENTS) {
    it(`parses ${JSON.stringify(source)} the same at every split`, () => {
      const whole = parseMarkdown(source);
      for (const chunks of splits(source)) {
        const doc = streamed(source, chunks);
        assert.deepEqual(doc.ast, whole.ast, JSON.stringify(chunks));
        assert.deepEqual(doc.frontmatter ?? null, whole.frontmatter ?? null, JSON.stringify(chunks));
      }
    });
  }

  it('reads a `----` line after a leading rule as body, not as a fence', () => {
    const doc = streamed('---\na: 1\n----\nbody\n', ['---\na: 1\n---', '-\nbody\n']);
    assert.equal(doc.frontmatter, null);
    assert.deepEqual(doc.ast.map((/** @type {any} */ n) => n.type), ['thematicBreak', 'heading', 'paragraph']);
  });

  it('closes frontmatter at a complete fence line once its newline arrives', () => {
    const doc = streamed('---\na: 1\n---\nbody', ['---\na: 1\n---', '\nbody']);
    assert.deepEqual(doc.frontmatter, { a: 1 });
    assert.deepEqual(doc.ast.map((/** @type {any} */ n) => n.type), ['paragraph']);
  });
});
