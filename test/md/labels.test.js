//@ts-check
/**
 * The accessible names the emitters write: a page break's, a heading
 * anchor's and a footnote back-reference's. They default to English and a
 * `labels` option replaces them, as message templates or closures, on
 * every surface that renders them.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  compileMarkdown, mdToVnode, toHtml, createMdRenderer, loadMarkdown, createMdCache, DEFAULT_LABELS,
  mdMessagesEn, labelsFromCatalog,
} from '@jarenjs/md';
import { createMdComponent } from '@jarenjs/md/component';

const SOURCE = '# Title\n\n## \n\nA claim[^1] and again[^1].\n\n<!-- pagebreak -->\n\n[^1]: The source.\n';
const ANCHORS = { headingIds: true, headingAnchors: true };
const DUTCH = {
  pageBreak: 'Paginascheiding',
  permalink: 'Permalink naar {text}',
  permalinkSection: 'Permalink naar deze sectie',
  backref: 'Terug naar verwijzing {number}',
  backrefOccurrence: 'Terug naar verwijzing {number}, keer {occurrence}',
};
const ENGLISH_NAMES = [
  'Permalink to Title', 'Permalink to this section', 'Page break', 'Footnotes',
  'Back to reference 1', 'Back to reference 1, occurrence 2',
];
const DUTCH_NAMES = [
  'Permalink naar Title', 'Permalink naar deze sectie', 'Paginascheiding', 'Footnotes',
  'Terug naar verwijzing 1', 'Terug naar verwijzing 1, keer 2',
];

/** @param {any} vnode @returns {string[]} every aria-label, in document order */
function vnodeLabels(vnode) {
  /** @type {string[]} */
  const out = [];
  const walk = (/** @type {any} */ node) => {
    if (!Array.isArray(node)) return;
    if (typeof node[0] === 'string') {
      const props = node[1];
      if (props !== null && typeof props === 'object' && !Array.isArray(props) && 'aria-label' in props) {
        out.push(props['aria-label']);
      }
    }
    for (const child of node) walk(child);
  };
  walk(vnode);
  return out;
}

/** @param {string} html @returns {string[]} */
function htmlLabels(html) {
  return [...html.matchAll(/aria-label="([^"]*)"/g)].map((match) => match[1]);
}

describe('md accessible names', () => {
  const doc = compileMarkdown(SOURCE).doc;

  it('stay the English ones by default, unchanged by an empty or absent labels option', () => {
    assert.deepEqual(vnodeLabels(mdToVnode(doc, ANCHORS)), ENGLISH_NAMES);
    assert.deepEqual(htmlLabels(toHtml(doc, ANCHORS)), ENGLISH_NAMES);
    assert.deepEqual(mdToVnode(doc, { ...ANCHORS, labels: {} }), mdToVnode(doc, ANCHORS));
    assert.deepEqual(mdToVnode(doc, { ...ANCHORS, labels: undefined }), mdToVnode(doc, ANCHORS));
    assert.equal(toHtml(doc, { ...ANCHORS, labels: { pageBreak: undefined } }), toHtml(doc, ANCHORS));
  });

  it('publishes the English templates a labels option replaces', () => {
    assert.deepEqual(Object.keys(DEFAULT_LABELS),
      ['pageBreak', 'permalink', 'permalinkSection', 'backref', 'backrefOccurrence']);
    assert.ok(Object.isFrozen(DEFAULT_LABELS));
    assert.deepEqual(vnodeLabels(mdToVnode(doc, { ...ANCHORS, labels: { ...DEFAULT_LABELS } })), ENGLISH_NAMES);
  });

  it('render the labels option through both emitters', () => {
    assert.deepEqual(vnodeLabels(mdToVnode(doc, { ...ANCHORS, labels: DUTCH })), DUTCH_NAMES);
    assert.deepEqual(htmlLabels(toHtml(doc, { ...ANCHORS, labels: DUTCH })), DUTCH_NAMES);
  });

  it('keep the English default for a member the option leaves out', () => {
    const names = vnodeLabels(mdToVnode(doc, { ...ANCHORS, labels: { pageBreak: 'Paginascheiding' } }));
    assert.deepEqual(names, ENGLISH_NAMES.map((name) => (name === 'Page break' ? 'Paginascheiding' : name)));
  });

  it('take a closure over the same parameters, and read its answer as a string', () => {
    const labels = {
      permalink: (/** @type {any} */ p) => `§ ${p.text}`,
      backref: (/** @type {any} */ p) => p.number,
      backrefOccurrence: (/** @type {any} */ p) => `${p.number}/${p.occurrence}`,
    };
    const names = vnodeLabels(mdToVnode(doc, { ...ANCHORS, labels: /** @type {any} */ (labels) }));
    assert.deepEqual(names, ['§ Title', 'Permalink to this section', 'Page break', 'Footnotes', '1', '1/2']);
  });

  it('spell a literal brace as {{ and leave an unknown placeholder literally', () => {
    const names = htmlLabels(toHtml(doc, { ...ANCHORS, labels: { permalink: '{{{text}} {missing}' } }));
    assert.equal(names[0], '{Title} {missing}');
  });

  it('are escaped as attribute text by the string emitter', () => {
    const html = toHtml(doc, { labels: { pageBreak: 'Break "here" <now> & then' } });
    assert.match(html, /aria-label="Break &quot;here&quot; <now> &amp; then"/);
  });

  it('reach a compiled document and a loaded one, keyed by what each label renders', async () => {
    assert.deepEqual(vnodeLabels(compileMarkdown(SOURCE, { ...ANCHORS, labels: DUTCH }).toVnode()), DUTCH_NAMES);

    /** @type {any} */
    const fetchFn = async () => ({
      ok: true, status: 200, statusText: 'OK', headers: { get: () => null }, body: null, text: async () => SOURCE,
    });
    const cache = createMdCache(8);
    const load = (/** @type {any} */ labels) =>
      loadMarkdown('https://x.test/a.md', { ...ANCHORS, labels, fetch: fetchFn, cache });
    const first = (/** @type {any} */ p) => `first ${p.text}`;
    const second = (/** @type {any} */ p) => `second ${p.text}`;
    assert.equal(vnodeLabels((await load({ permalink: first })).toVnode())[0], 'first Title');
    // the same source under a different closure is a different compilation
    assert.equal(vnodeLabels((await load({ permalink: second })).toVnode())[0], 'second Title');
    assert.equal(vnodeLabels((await load({ permalink: 'tekst {text}' })).toVnode())[0], 'tekst Title');
    assert.equal(vnodeLabels((await load(undefined)).toVnode())[0], 'Permalink to Title');
  });

  it('reach the component at construction and per view policy, one memo per closure', () => {
    const md = createMdComponent({ ...ANCHORS, labels: DUTCH, plugins: [] });
    assert.deepEqual(vnodeLabels(md.view(SOURCE)), DUTCH_NAMES);
    // a policy's labels replace the construction-time ones whole
    assert.deepEqual(vnodeLabels(md.view(SOURCE, { labels: {} })), ENGLISH_NAMES);

    const first = { permalink: (/** @type {any} */ p) => `first ${p.text}` };
    const second = { permalink: (/** @type {any} */ p) => `second ${p.text}` };
    assert.equal(vnodeLabels(md.view(SOURCE, { labels: first }))[0], 'first Title');
    assert.equal(vnodeLabels(md.view(SOURCE, { labels: second }))[0], 'second Title');
    assert.equal(md.view(SOURCE, { labels: first }), md.view(SOURCE, { labels: first }));
  });

  it('are refused when the labels option names an unknown member or a value of the wrong kind', () => {
    assert.throws(() => mdToVnode(doc, { labels: /** @type {any} */ ({ pagebreak: 'x' }) }),
      { name: 'TypeError', message: "md mdToVnode: unknown labels member 'pagebreak' — did you mean 'pageBreak'?" });
    assert.throws(() => toHtml(doc, { labels: /** @type {any} */ ({ pageBreak: null }) }),
      { name: 'TypeError', message: "md toHtml: labels member 'pageBreak' must be a string or a function, got null" });
    assert.throws(() => toHtml(doc, { labels: /** @type {any} */ ({ backref: 1 }) }),
      /labels member 'backref' must be a string or a function, got 1/);
    assert.throws(() => mdToVnode(doc, { labels: /** @type {any} */ (['Page break']) }),
      /option 'labels' must be a plain object of labels, got an array/);
    assert.throws(() => compileMarkdown(SOURCE, { labels: /** @type {any} */ ({ permaLink: 'x' }) }).toVnode(),
      /unknown labels member 'permaLink' — did you mean 'permalink'\?/);
  });

  it('are not forwarded by createMdRenderer, which refuses the option like footnotesLabel', () => {
    assert.throws(() => createMdRenderer(/** @type {any} */ ({ container: {}, labels: DUTCH })),
      /unknown option 'labels'/);
  });
});

describe('md message catalog', () => {
  const doc = compileMarkdown(SOURCE).doc;

  it('spells the English names under the ids a locale pack translates', () => {
    assert.deepEqual(mdMessagesEn, {
      'md/footnotes': 'Footnotes',
      'md/page-break': DEFAULT_LABELS.pageBreak,
      'md/permalink': DEFAULT_LABELS.permalink,
      'md/permalink-section': DEFAULT_LABELS.permalinkSection,
      'md/backref': DEFAULT_LABELS.backref,
      'md/backref-occurrence': DEFAULT_LABELS.backrefOccurrence,
    });
    assert.ok(Object.isFrozen(mdMessagesEn));
    assert.deepEqual(vnodeLabels(mdToVnode(doc, { ...ANCHORS, ...labelsFromCatalog(mdMessagesEn) })), ENGLISH_NAMES);
  });

  it('turns a catalog into the options every surface takes, keeping English for an id it lacks', () => {
    const catalog = {
      'md/footnotes': 'Voetnoten',
      'md/page-break': DUTCH.pageBreak,
      'md/permalink': DUTCH.permalink,
      'md/permalink-section': DUTCH.permalinkSection,
      'md/backref': DUTCH.backref,
      'md/backref-occurrence': DUTCH.backrefOccurrence,
      'type': 'unrelated',
    };
    const dutch = DUTCH_NAMES.map((name) => (name === 'Footnotes' ? 'Voetnoten' : name));
    assert.deepEqual(vnodeLabels(mdToVnode(doc, { ...ANCHORS, ...labelsFromCatalog(catalog) })), dutch);
    assert.deepEqual(htmlLabels(toHtml(doc, { ...ANCHORS, ...labelsFromCatalog(catalog) })), dutch);
    assert.deepEqual(labelsFromCatalog({}), { footnotesLabel: undefined, labels: {} });
    assert.deepEqual(vnodeLabels(mdToVnode(doc, { ...ANCHORS, ...labelsFromCatalog({ 'md/page-break': 'Pagina' }) })),
      ENGLISH_NAMES.map((name) => (name === 'Page break' ? 'Pagina' : name)));
  });

  it('renders a footnotes entry once, as a template or a closure', () => {
    assert.equal(labelsFromCatalog({ 'md/footnotes': '{{Notes}' }).footnotesLabel, '{Notes}');
    assert.equal(labelsFromCatalog({ 'md/footnotes': () => 'Noten' }).footnotesLabel, 'Noten');
    const md = createMdComponent({ ...ANCHORS, plugins: [], ...labelsFromCatalog({ 'md/permalink': (/** @type {any} */ p) => `§ ${p.text}` }) });
    assert.equal(vnodeLabels(md.view(SOURCE))[0], '§ Title');
  });

  it('passes an entry of another kind on for the surface to refuse', () => {
    assert.throws(() => toHtml(doc, { ...labelsFromCatalog({ 'md/page-break': 5 }) }),
      /labels member 'pageBreak' must be a string or a function, got 5/);
    assert.throws(() => toHtml(doc, { ...labelsFromCatalog({ 'md/footnotes': 5 }) }),
      /option 'footnotesLabel' must be a string, got 5/);
  });
});

describe('md component view policy', () => {
  it('treats a member passed as undefined as absent: the construction-time value answers it', () => {
    const md = createMdComponent({ headingIds: true, slugPrefix: 'user-content-', plugins: [] });
    const html = JSON.stringify(md.view('# Hi\n', { headingAnchors: true, slugPrefix: undefined }));
    assert.match(html, /"id":"user-content-hi"/);
    assert.match(html, /"href":"#user-content-hi"/);
  });
});
