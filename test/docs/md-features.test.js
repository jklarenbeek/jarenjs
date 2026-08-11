//@ts-check
/**
 * @file The markdown feature-list drift gate.
 *
 * Four documents state which dialect `@jarenjs/md` speaks, and for three
 * releases running they said "CommonMark core + GFM tables/strikethrough/
 * task lists" while the parser had grown footnotes and literal autolinks.
 * A feature sentence is a claim the code owns; this asserts it against
 * what the parser actually does, by PARSING each feature and checking a
 * node type comes out — not by grepping the source for a keyword, which
 * would pass on a feature that exists and does not work.
 *
 * Every claim is also checked to be OFF with `gfm: false`, so the
 * sentence "GFM extensions" keeps meaning something.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseMarkdown, walkAst } from '@jarenjs/md';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** Prose wraps, so a two-word feature name can straddle a line break. */
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\s+/g, ' ');

/**
 * Each GFM feature: the name the docs use for it, a document that uses
 * it, and the node type (or node predicate) that proves the parser
 * produced it.
 */
const GFM_FEATURES = [
  { name: 'tables', src: '| a |\n| - |\n| 1 |\n', proof: (n) => n.type === 'table' },
  { name: 'strikethrough', src: '~~struck~~\n', proof: (n) => n.type === 'strikethrough' },
  { name: 'task lists', src: '- [x] done\n', proof: (n) => n.type === 'listItem' && n.checked === true },
  { name: 'footnotes', src: 'a[^1]\n\n[^1]: note\n', proof: (n) => n.type === 'footnoteReference' },
  { name: 'autolink literals', src: 'see www.example.com now\n', proof: (n) => n.type === 'link' && n.auto === true },
];

/** Does parsing `src` with these options produce a node the proof accepts? */
function produces(src, proof, options) {
  let found = false;
  walkAst(parseMarkdown(src, { frontmatter: false, ...options }).ast, (node) => {
    if (proof(node)) found = true;
  });
  return found;
}

/** The documents that state the dialect, and how each spells the list. */
const CLAIMS = [
  { file: 'components/md/README.md', label: 'the package README' },
  { file: 'components/md/src/index.js', label: "the package's own file comment" },
  { file: 'README.md', label: 'the root README' },
  { file: 'packages/website/src/content/docs.js', label: 'the website docs page' },
];

describe('the markdown feature list matches the parser', function () {
  it('every GFM feature the docs name is one the parser produces', function () {
    for (const feature of GFM_FEATURES) {
      assert.ok(produces(feature.src, feature.proof, {}),
        `the parser does not produce ${feature.name}`);
    }
  });

  it('and every one of them is gated on gfm', function () {
    // "GFM extensions" has to mean something; a feature that stayed on
    // with the flag off would make the D5 promise false as well.
    for (const feature of GFM_FEATURES) {
      assert.equal(produces(feature.src, feature.proof, { gfm: false }), false,
        `${feature.name} still parses with gfm: false`);
    }
  });

  it('every document that states the dialect names all of them', function () {
    for (const claim of CLAIMS) {
      const text = read(claim.file);
      // the sentence that introduces the list — all four spell it "GFM"
      assert.ok(/GFM/.test(text), `${claim.label} does not mention GFM at all`);
      for (const feature of GFM_FEATURES) {
        assert.ok(text.includes(feature.name),
          `${claim.label} (${claim.file}) does not name '${feature.name}'`);
      }
    }
  });

  it('the two emitters and the directive layer are documented where a stranger looks', function () {
    // A capability with no entry in the format doc is not a contract,
    // and one with no entry in the README is one nobody finds.
    const format = read('components/md/docs/MD-FORMAT.md');
    const readme = read('components/md/README.md');
    // headings are matched on the collapsed text, so `### X` reads the same
    for (const [section, needle] of [
      ['raw HTML and the two emitters', '4.4a'],
      ['heading identifiers', '4.5'],
      ['footnotes', '4.6'],
      ['literal autolinks', '4.7'],
      ['directives', '4.8'],
    ]) {
      assert.ok(format.includes(`### ${needle}`), `MD-FORMAT has no §${needle} (${section})`);
    }
    for (const heading of ['### An HTML string, in one call', '### Heading anchors',
      '### Footnotes and bare links (GFM)', '### Directives', '### mdx']) {
      assert.ok(readme.includes(heading), `the README has no "${heading}" section`);
    }
  });
});
