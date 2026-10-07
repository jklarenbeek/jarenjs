//@ts-check
/**
 * @file The site collector's refusal of a document the Markdown parser
 * fails on.
 *
 * Every refusal names the document at fault: the build reads a site
 * document from each of twenty-odd workspaces, and "the parser threw"
 * without a path is a hunt through all of them. A parser failure other
 * than a frontmatter error is caught and named too, and it says no more
 * than it knows. The failure can start in the frontmatter of a document
 * that has no body at all, so it never blames the body. The parser bounds
 * every nesting it reads, so the failure here is one it was not written
 * to expect: a source that is not text.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { readSiteDocument } from '../../scripts/generate-site-data.js';

describe('a site document the parser fails on', () => {
  it('is refused naming the document, without blaming a body it does not have', () => {
    // a parser failure that is not a frontmatter error, and no body
    const source = /** @type {any} */ (null);
    assert.throws(() => readSiteDocument('components/play', source, '@jarenjs/play'), (/** @type {Error} */ error) => {
      const [reason] = error.message.split('\n');
      assert.match(reason, /^components\/play\/site\.md: /);
      assert.doesNotMatch(reason, /\bbody\b/, reason);
      return true;
    });
  });
});
