//@ts-check
/**
 * @file The other entrance to the document gate.
 *
 * `scripts/check-documents.js` parses every mermaid fence in the committed
 * Markdown surface — which reaches every workspace `site.md`, every README
 * and every format spec. It cannot reach the diagrams the SITE carries,
 * because those live inside JavaScript content modules: a studio template
 * whose app document holds a markdown page, and the playground's mermaid
 * examples. A file walk sees strings there, not documents.
 *
 * So the same parser is entered from the data side: every mermaid source
 * the site can render out of its own content is compiled here. One parser,
 * two entrances, and nothing renders a diagram the engine cannot read.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { parseMermaid } from '@jarenjs/mermaid';
import { EXAMPLES } from '@jarenjs/play';

import { STUDIO_TEMPLATES } from '../../packages/website/src/content/appTemplates.js';
import { PROJECT_TEMPLATES } from '../../packages/website/src/content/projectTemplates.js';
import { FLOW_TEMPLATES } from '../../packages/website/src/content/flowTemplates.js';
import { DOCS_SECTIONS } from '../../packages/website/src/content/docs.js';
import { HOME_CONTENT } from '../../packages/website/src/content/home.js';
import { fencesOf } from '../../scripts/check-documents.js';

/**
 * Every mermaid fence inside any string anywhere in a value. The content
 * documents are plain JSON-ish data, so a deep walk finds a diagram
 * wherever a template happens to keep its prose.
 * @param {any} value
 * @param {{ where: string, source: string }[]} [into]
 * @param {string} [path]
 */
function mermaidIn(value, into = [], path = '$') {
  if (typeof value === 'string') {
    for (const fence of fencesOf(value)) {
      if (fence.lang === 'mermaid') into.push({ where: path, source: fence.body });
    }
    return into;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => mermaidIn(item, into, `${path}[${i}]`));
    return into;
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) mermaidIn(value[key], into, `${path}.${key}`);
  }
  return into;
}

/** Every diagram the site's own content holds, from both shapes it takes. */
function siteDiagrams() {
  /** @type {{ where: string, source: string }[]} */
  const found = [];
  const content = {
    STUDIO_TEMPLATES, PROJECT_TEMPLATES, FLOW_TEMPLATES, DOCS_SECTIONS, HOME_CONTENT,
  };
  for (const [name, value] of Object.entries(content)) mermaidIn(value, found, name);
  // a playground mermaid example IS a diagram source — no fence around it
  for (const example of EXAMPLES) {
    if (example.engine !== 'mermaid') continue;
    found.push({ where: `EXAMPLES.${example.id}`, source: String(example.source?.source ?? '') });
  }
  return found;
}

describe('every diagram the site embeds parses through the engine it advertises', function () {
  const diagrams = siteDiagrams();

  it('finds the diagrams the site actually carries', function () {
    // a content refactor that loses the templates would otherwise leave
    // this suite passing over an empty list
    assert.ok(diagrams.length >= 5,
      `expected the site's own content to hold at least 5 diagrams, found ${diagrams.length}`);
  });

  for (const diagram of siteDiagrams()) {
    it(`compiles ${diagram.where}`, function () {
      parseMermaid(diagram.source);
    });
  }
});
