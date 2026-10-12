//@ts-check
/**
 * A quote protects a `#` only in a scalar that begins with one. The
 * comment stripper tracked quotes anywhere in the text, so the apostrophe
 * in `title: It's fine # note` opened a quote that never closed, and the
 * comment stayed in the value.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMarkdown } from '@jarenjs/md';

/** @param {string} yaml @returns {any} */
const front = (yaml) => parseMarkdown(`---\n${yaml}\n---\n`).frontmatter;

describe('YAML frontmatter — a comment after a plain scalar holding a quote', function () {
  it('ends the value at the comment', () => {
    assert.deepEqual(front("title: It's fine # note"), { title: "It's fine" });
    assert.deepEqual(front('k: say "hi" # c'), { k: 'say "hi"' });
    assert.deepEqual(front("- it's # c"), ["it's"]);
    assert.deepEqual(front('k: a "b # c" d'), { k: 'a "b' });
  });

  it('still reads a comment after a quoted scalar, and keeps a # inside one', () => {
    assert.deepEqual(front('k: "a # b" # c'), { k: 'a # b' });
    assert.deepEqual(front("k: 'a # b' # c"), { k: 'a # b' });
    assert.deepEqual(front('k: "a"# c'), { k: 'a' });
    assert.deepEqual(front("k: 'it''s' # c"), { k: "it's" });
  });
});
