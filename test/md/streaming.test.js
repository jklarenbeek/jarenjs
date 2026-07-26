//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMarkdown, createIncrementalParser, streamMarkdown } from '@jarenjs/md';

const SAMPLE = '---\ntitle: Stream\n---\n# One\n\npara text\nwraps\n\n```js\nlet x;\n```\n\n- a\n- b\n\nlast\n';

/**
 * Split a string into chunks of `size` code units.
 * @param {string} src
 * @param {number} size
 */
function chunked(src, size) {
  const out = [];
  for (let i = 0; i < src.length; i += size) out.push(src.slice(i, i + size));
  return out;
}

describe('createIncrementalParser', function () {
  it('agrees with batch parsing for any chunking', function () {
    const batch = parseMarkdown(SAMPLE);
    for (const size of [1, 3, 7, 16, 64, 4096]) {
      const inc = createIncrementalParser({});
      const streamed = [];
      for (const chunk of chunked(SAMPLE, size)) streamed.push(...inc.feed(chunk));
      const doc = inc.end();
      assert.deepEqual(doc.ast, batch.ast, `chunk size ${size}`);
      assert.deepEqual(doc.frontmatter, batch.frontmatter);
      assert.equal(doc.meta.hash, batch.meta.hash, `hash at chunk size ${size}`);
      // Everything yielded early is in the final AST, by reference.
      for (let i = 0; i < streamed.length; i++) assert.equal(streamed[i], doc.ast[i]);
    }
  });

  it('binds a reference defined AFTER the block that uses it', function () {
    // the streaming gap: the paragraph closes before the definition
    // arrives, so it is emitted with literal text and re-resolved at end()
    const source = 'See [ref] and [gone] here.\n\nmore\n\n[ref]: /target "T"\n';
    for (const size of [1, 5, 17, 4096]) {
      const inc = createIncrementalParser({ frontmatter: false });
      const streamed = [];
      for (const chunk of chunked(source, size)) streamed.push(...inc.feed(chunk));
      const doc = inc.end();
      assert.deepEqual(doc.ast, parseMarkdown(source, { frontmatter: false }).ast,
        `chunk size ${size}`);
      // patched IN PLACE: what feed() handed out is what end() fixed
      for (let i = 0; i < streamed.length; i++) assert.equal(streamed[i], doc.ast[i]);
      const kinds = doc.ast[0].children.map((c) => c.type);
      assert.deepEqual(kinds, ['text', 'link', 'text'], `chunk size ${size}`);
      assert.equal(doc.ast[0].children[2].value, ' and [gone] here.',
        'a reference nothing ever defines stays literal, as in batch mode');
    }
  });

  it('yields blocks as soon as their end is certain', function () {
    const inc = createIncrementalParser({});
    assert.deepEqual(inc.feed('# A\n\nstart'), [
      { type: 'heading', depth: 1, children: [{ type: 'text', value: 'A' }] },
    ]);
    // The open paragraph is not yielded yet.
    assert.deepEqual(inc.feed(' more\n\n'), [
      { type: 'paragraph', children: [{ type: 'text', value: 'start more' }] },
    ]);
    const doc = inc.end();
    assert.equal(doc.ast.length, 2);
  });

  it('resolves frontmatter as soon as its fence closes', function () {
    const inc = createIncrementalParser({});
    inc.feed('---\ntitle: ');
    assert.equal(inc.frontmatter, null);
    inc.feed('Early\n---\nbody');
    assert.deepEqual(inc.frontmatter, { title: 'Early' });
    const doc = inc.end();
    assert.deepEqual(doc.frontmatter, { title: 'Early' });
    assert.equal(doc.meta.frontmatterLang, 'yaml');
  });

  it('does not split blocks across an open fence', function () {
    const inc = createIncrementalParser({});
    const fed = [
      ...inc.feed('```js\nlet a;\n'),
      ...inc.feed('let b;\n'),
    ];
    assert.deepEqual(fed, []); // fence still open
    const doc = inc.end();
    assert.deepEqual(doc.ast, [{ type: 'code', lang: 'js', meta: null, value: 'let a;\nlet b;\n' }]);
  });
});

describe('streamMarkdown', function () {
  it('streams from an async iterable of chunks', async function () {
    async function* chunks() {
      for (const chunk of chunked(SAMPLE, 10)) yield chunk;
    }
    const blocks = [];
    const iterator = streamMarkdown(chunks());
    let step = await iterator.next();
    while (!step.done) {
      blocks.push(step.value);
      step = await iterator.next();
    }
    const doc = step.value; // the generator's return value
    assert.deepEqual(doc.ast, parseMarkdown(SAMPLE).ast);
    assert.equal(blocks.length, doc.ast.length);
    for (let i = 0; i < blocks.length; i++) assert.equal(blocks[i], doc.ast[i]);
  });

  it('accepts Uint8Array chunks (TextDecoder path)', async function () {
    const bytes = new TextEncoder().encode('# é unicode ✓\n\npara\n');
    async function* chunks() {
      // Split inside the multi-byte sequence on purpose.
      yield bytes.slice(0, 4);
      yield bytes.slice(4);
    }
    const seen = [];
    const iterator = streamMarkdown(chunks());
    let step = await iterator.next();
    while (!step.done) {
      seen.push(step.value);
      step = await iterator.next();
    }
    assert.equal(seen[0].children[0].value, 'é unicode ✓');
  });

  it('honors an already-aborted signal', async function () {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await assert.rejects(async () => {
      const iterator = streamMarkdown((async function* () { yield '# x\n'; })(), {
        signal: controller.signal,
      });
      await iterator.next();
    }, /stop/);
  });
});
