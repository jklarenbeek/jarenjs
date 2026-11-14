//@ts-check
/**
 * @file The Mermaid engine speaks the reader's language. A pseudo-locale
 * (every mermaid message id rendered as `⟦id⟧`, followed by the words it
 * was handed) renders a source for every parse diagnostic onto the error
 * card, every placeholder, the class and ER panels, a Gantt's accessible
 * title and description, and the interactive viewer's controls: none of it
 * may show the English catalog's text, every diagnostic id must reach the
 * card, and every id must be reached. Without a catalog the card, the
 * diagnostic's `message` and every word are the English they were.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import { compileMessageCatalog } from '@jarenjs/core/message';
import { renderMermaid, parseMermaid, compileMermaid, mermaidMessagesEn, mermaidText, mermaidErrorText, MermaidParseError } from '@jarenjs/mermaid';
import { createMermaidComponent } from '@jarenjs/mermaid/component';
import { attachInteractiveDiagram } from '@jarenjs/mermaid/interactive';
import { mermaidPlugin } from '@jarenjs/mermaid/plugin';
import { renderToString } from '@jarenjs/view';
import { mermaid, mermaidFor } from '../../packages/website/src/boundaries/mermaid.js';

const IDS = Object.keys(mermaidMessagesEn);
const reached = new Set();
/** `⟦id⟧`, then the string parameters it was handed (a diagnostic's own words
 * are the diagram's text; the card's line label hands on the diagnostic). */
const PSEUDO = compileMessageCatalog(Object.fromEntries(IDS.map((id) => [id, (/** @type {any} */ p) => {
  reached.add(id);
  return [`⟦${id}⟧`, ...Object.values(p ?? {}).filter((v) => typeof v === 'string')].join(' ');
}])));

/** The English a rendering must not show: every literal run of letters in a template. */
const ENGLISH = IDS.flatMap((id) => {
  const entry = mermaidMessagesEn[id];
  const text = typeof entry === 'function' ? entry({ count: 2, from: '', to: '' }) : String(entry);
  return text.split(/\{\{|\{[^{}]*\}/).map((part) => part.trim()).filter((part) => /\p{L}{4}/u.test(part)).map((part) => [id, part]);
});
/** Every text of an SVG string. */
const texts = (/** @type {string} */ svg) => [...svg.matchAll(/>([^<]+)</g)].map((m) => m[1]);
/** The English a rendering shows. @returns {string[]} */
function english(/** @type {string} */ svg, /** @type {string} */ where) {
  const shown = texts(svg).join('\n').replace(/⟦[^⟧]*⟧/g, '');
  return ENGLISH.filter(([, part]) => shown.includes(part)).map(([id, part]) => `${where}: English of ${id}: "${part}"`);
}

const G = (body, head = 'dateFormat YYYY-MM-DD') => `gantt\n${head}\nsection S\n${body}`;
const CASES = {
  'mermaid/parse/empty': '   \n',
  'mermaid/parse/unknown-type': 'nonsense\nA',
  'mermaid/flowchart/stray-end': 'flowchart TD\nend',
  'mermaid/flowchart/expected-link': 'flowchart TD\nA B',
  'mermaid/flowchart/expected-node': 'flowchart TD\nA -->',
  'mermaid/flowchart/too-many-edges': `flowchart TD\n${Array.from({ length: 300 }, (_, i) => `n${i}`).join(' & ')} --> ${Array.from({ length: 300 }, (_, i) => `m${i}`).join(' & ')}`,
  'mermaid/flowchart/unterminated-shape': 'flowchart TD\nA[open',
  'mermaid/sequence/outside-block': 'sequenceDiagram\nelse x',
  'mermaid/sequence/stray-end': 'sequenceDiagram\nend',
  'mermaid/state/transition': 'stateDiagram-v2\nA --> ',
  'mermaid/state/note': 'stateDiagram-v2\nnote over A',
  'mermaid/state/unclosed-note': 'stateDiagram-v2\nnote left of A\ntext',
  'mermaid/class/relation': 'classDiagram\nA <|-- ',
  'mermaid/er/relationship': 'erDiagram\n||--o{',
  'mermaid/click/no-id': G('a : a1, 2024-01-01, 1d\nclick'),
  'mermaid/click/href-unquoted': G('a : a1, 2024-01-01, 1d\nclick a1 href x'),
  'mermaid/click/href-unclosed': G('a : a1, 2024-01-01, 1d\nclick a1 href "x'),
  'mermaid/click/href-empty': G('a : a1, 2024-01-01, 1d\nclick a1 href ""'),
  'mermaid/click/unexpected': G('a : a1, 2024-01-01, 1d\nclick a1 bogus'),
  'mermaid/click/nothing': G('a : a1, 2024-01-01, 1d\nclick a1'),
  'mermaid/click/call-no-parens': G('a : a1, 2024-01-01, 1d\nclick a1 call f'),
  'mermaid/click/call-unclosed': G('a : a1, 2024-01-01, 1d\nclick a1 call f(1'),
  'mermaid/click/call-no-name': G('a : a1, 2024-01-01, 1d\nclick a1 call (1)'),
  'mermaid/gantt/date-escape': G('a : 2024-01-01, 1d', 'dateFormat [YYYY'),
  'mermaid/gantt/date-hundredths': G('a : 1d', 'dateFormat SS'),
  'mermaid/gantt/date-quarter': G('a : 1d', 'dateFormat Q'),
  'mermaid/gantt/date-ordinal': G('a : 1d', 'dateFormat Do'),
  'mermaid/gantt/date-day-of-year': G('a : 1d', 'dateFormat DDD'),
  'mermaid/gantt/date-week-number': G('a : 1d', 'dateFormat ww'),
  'mermaid/gantt/date-epoch': G('a : 1d', 'dateFormat YYYY X'),
  'mermaid/gantt/axis-bare-percent': G('a : 2024-01-01, 1d', 'dateFormat YYYY-MM-DD\naxisFormat %'),
  'mermaid/gantt/axis-space-padded': G('a : 2024-01-01, 1d', 'dateFormat YYYY-MM-DD\naxisFormat %e'),
  'mermaid/gantt/axis-locale-date': G('a : 2024-01-01, 1d', 'dateFormat YYYY-MM-DD\naxisFormat %c'),
  'mermaid/gantt/axis-sunday-week': G('a : 2024-01-01, 1d', 'dateFormat YYYY-MM-DD\naxisFormat %U'),
  'mermaid/gantt/axis-monday-week': G('a : 2024-01-01, 1d', 'dateFormat YYYY-MM-DD\naxisFormat %W'),
  'mermaid/gantt/axis-sunday-zero': G('a : 2024-01-01, 1d', 'dateFormat YYYY-MM-DD\naxisFormat %w'),
  'mermaid/gantt/axis-unknown': G('a : 2024-01-01, 1d', 'dateFormat YYYY-MM-DD\naxisFormat %K'),
  'mermaid/gantt/tick-interval': G('a : 2024-01-01, 1d', 'dateFormat YYYY-MM-DD\ntickInterval 2fortnights'),
  'mermaid/gantt/weekday': G('a : 2024-01-01, 1d', 'dateFormat YYYY-MM-DD\nweekday caturday'),
  'mermaid/gantt/weekend': G('a : 2024-01-01, 1d', 'dateFormat YYYY-MM-DD\nweekend sunday'),
  'mermaid/gantt/inclusive-end-dates': G('a : 2024-01-01, 1d', 'dateFormat YYYY-MM-DD\ninclusiveEndDates yes'),
  'mermaid/gantt/needs-names': G('a : 2024-01-01, 1d', 'dateFormat YYYY-MM-DD\naxisFormat %b'),
  'mermaid/gantt/unreadable-pattern': G('a : 2024-01-01, 1d', 'dateFormat Z Z'),
  'mermaid/gantt/excludes': G('a : 2024-01-01, 1d', 'dateFormat YYYY-MM-DD\nexcludes someday'),
  'mermaid/gantt/duplicate-id': G('a : t1, 2024-01-01, 1d\nb : t1, 2024-01-02, 1d'),
  'mermaid/gantt/too-many-fields': G('a : t1, 2024-01-01, 1d, x, y'),
  'mermaid/gantt/empty-id': G('a : , 2024-01-01, 1d'),
  'mermaid/gantt/no-end': G('a : t1, 2024-01-01,'),
  'mermaid/gantt/cycle': G('a : t1, after t1, 1d'),
  'mermaid/gantt/unknown-reference': G('a : t1, after t9, 1d'),
  'mermaid/gantt/bad-start': G('a : t1, someday, 1d'),
  'mermaid/gantt/no-start': G('a : 1d'),
  'mermaid/gantt/bad-end': G('a : t1, 2024-01-01, sometime'),
  'mermaid/gantt/never-finishes': G('a : t1, 2024-01-01, 3d', 'dateFormat YYYY-MM-DD\nexcludes monday tuesday wednesday thursday friday saturday sunday'),
  'mermaid/gantt/ends-before-start': G('a : t1, 2024-01-05, 2024-01-01'),
  'mermaid/gantt/empty-task': G('a : t1, 2024-01-01, 2024-01-01'),
  'mermaid/gantt/bad-duration': G('a : t1, 2024-01-01, 1.5M'),
  'mermaid/gantt/past-last-instant': G('a : t1, 2024-01-01, 99999999y'),
};


/** The diagrams whose words the render adds. */
const CHROME = {
  'mermaid/class/title': 'classDiagram\nclass A\nA <|-- B',
  'mermaid/er/title': 'erDiagram\nA ||--o{ B : has',
  'mermaid/gantt/title': 'gantt\ndateFormat YYYY-MM-DD\nsection S\na : t1, 2024-01-01, 1d\nb : t2, after t1, 2d',
  'mermaid/gantt/title-named': 'gantt\ntitle Plan\ndateFormat YYYY-MM-DD\nsection S\na : t1, 2024-01-01, 1d',
  'mermaid/gantt/empty': 'gantt\ndateFormat YYYY-MM-DD',
  'mermaid/placeholder/pie': 'pie\n"a" : 1',
  'mermaid/placeholder/secondary': 'journey\ntitle A day',
};

describe('mermaid messages', () => {
  it('puts every parse diagnostic on the card in the reader\'s language', () => {
    const found = [];
    for (const [id, source] of Object.entries(CASES)) {
      const svg = renderToString(renderMermaid(source, { messages: PSEUDO }));
      assert.ok(svg.includes(`⟦${id}⟧`), `${id} reaches the card`);
      assert.ok(svg.includes('⟦mermaid/error/title⟧'), `${id}: the card's title`);
      found.push(...english(svg, id));
    }
    assert.deepEqual(found, []);
  });

  it('renders the words the render adds through the catalog, on every entry point', () => {
    const found = [];
    for (const [id, source] of Object.entries(CHROME)) {
      for (const svg of [renderToString(renderMermaid(source, { messages: PSEUDO })),
        renderToString(compileMermaid(source, { messages: PSEUDO }).toVnode()),
        renderToString(createMermaidComponent({ messages: PSEUDO }).view(source)),
        // the site's component draws a pie (charts' renderer) instead of the placeholder
        ...(id === 'mermaid/placeholder/pie' ? [] : [renderToString(mermaidFor(PSEUDO).view(source))]),
        renderToString(mermaidPlugin({ messages: PSEUDO }).render({ value: source }))]) {
        assert.ok(svg.includes(`⟦${id}⟧`), `${id} is drawn`);
        found.push(...english(svg, id));
      }
    }
    assert.deepEqual(found, []);
    assert.equal(mermaidFor(PSEUDO), mermaidFor(PSEUDO), 'one component per catalog');
    assert.equal(mermaidFor(undefined), mermaid, 'no catalog is the English component');
  });

  it('names the interactive viewer\'s controls in the reader\'s language', () => {
    const make = (/** @type {string} */ tag) => ({
      tagName: tag, style: {}, children: /** @type {any[]} */ ([]), attrs: new Map(), parentNode: null, textContent: '',
      setAttribute(/** @type {string} */ k, /** @type {any} */ v) { this.attrs.set(k, String(v)); },
      getAttribute(/** @type {string} */ k) { return this.attrs.get(k) ?? null; },
      appendChild(/** @type {any} */ c) { this.children.push(c); return c; },
      addEventListener() {}, removeEventListener() {}, classList: { add() {}, remove() {} },
    });
    const svg = make('svg'); svg.setAttribute('viewBox', '0 0 100 80');
    const el = /** @type {any} */ (make('div')); el.appendChild(svg); el.querySelector = () => svg;
    const document = { createElement: make };
    attachInteractiveDiagram(el, { document, messages: PSEUDO });
    const labels = [el.getAttribute('aria-label'), ...el.children[1].children.map((/** @type {any} */ b) => b.getAttribute('aria-label'))];
    assert.deepEqual(labels, ['⟦mermaid/interactive/diagram⟧', '⟦mermaid/interactive/zoom-in⟧', '⟦mermaid/interactive/zoom-out⟧', '⟦mermaid/interactive/reset⟧']);
    const plain = /** @type {any} */ (make('div')); const svg2 = make('svg'); svg2.setAttribute('viewBox', '0 0 1 1');
    plain.appendChild(svg2); plain.querySelector = () => svg2;
    attachInteractiveDiagram(plain, { document });
    assert.deepEqual([plain.getAttribute('aria-label'), ...plain.children[1].children.map((/** @type {any} */ b) => b.getAttribute('aria-label'))],
      ['Diagram. Use plus and minus to zoom, arrow keys to pan, zero to reset.', 'Zoom in', 'Zoom out', 'Reset view']);
  });

  it('reaches every id', () => {
    assert.deepEqual(IDS.filter((id) => !reached.has(id)), []);
  });

  it('keeps the English without a catalog', () => {
    const card = renderToString(renderMermaid('flowchart TD\nA B'));
    assert.ok(card.includes('>Mermaid parse error<'));
    assert.ok(card.includes('>Line 2: expected a link after a node, found &#39;B&#39;<') || card.includes(">Line 2: expected a link after a node, found 'B'<"), card);
    for (const [source, words] of [[CHROME['mermaid/class/title'], ['Class diagram', 'relations']],
      [CHROME['mermaid/er/title'], ['Entity–relationship', 'relationships']],
      [CHROME['mermaid/gantt/title'], ['<title>Gantt chart</title>', '<desc>2 tasks from 2024-01-01 to 2024-01-04.</desc>']],
      [CHROME['mermaid/gantt/title-named'], ['<title>Gantt chart: Plan</title>', '<desc>1 task from 2024-01-01 to 2024-01-02.</desc>']],
      [CHROME['mermaid/gantt/empty'], ['An empty schedule.']],
      [CHROME['mermaid/placeholder/pie'], ['pie diagram', 'parsed — no pie renderer was injected']],
      [CHROME['mermaid/placeholder/secondary'], ['journey diagram', 'parsed — not yet laid out in v1']]]) {
      const svg = renderToString(renderMermaid(source));
      for (const word of words) assert.ok(svg.includes(word), `${word} in ${svg.slice(0, 200)}`);
    }
  });

  it('carries the id and parameters on the error, and renders it in either language', () => {
    let error;
    try { parseMermaid(CASES['mermaid/gantt/unknown-reference']); }
    catch (err) { error = err; }
    assert.ok(error instanceof MermaidParseError);
    assert.equal(error.msgid, 'mermaid/gantt/unknown-reference');
    assert.deepEqual(error.params, { id: 't1', keyword: 'after', target: 't9' });
    assert.equal(error.message, "task 't1' says 'after t9', and no task has that id");
    assert.equal(mermaidErrorText(error), error.message);
    assert.equal(mermaidErrorText(error, PSEUDO), '⟦mermaid/gantt/unknown-reference⟧ t1 after t9');
    assert.equal(mermaidErrorText(new Error('plain'), PSEUDO), 'plain');
    assert.equal(mermaidErrorText('thrown text', PSEUDO), 'thrown text');
  });

  it('falls back to English per id, for a missing, throwing or non-string entry', () => {
    assert.equal(mermaidText(compileMessageCatalog({ 'mermaid/error/title': () => { throw new Error('x'); } }))('mermaid/error/title'), 'Mermaid parse error');
    assert.equal(mermaidText(/** @type {any} */ ({ 'mermaid/gantt/empty': () => 3 }))('mermaid/gantt/empty'), 'An empty schedule.');
    assert.equal(mermaidText()('mermaid/unknown'), 'mermaid/unknown');
  });

  it('uses every id of its catalog in the source', () => {
    const dir = new URL('../../components/mermaid/src/', import.meta.url);
    const files = ['errors.js', 'interactive.js', ...readdirSync(new URL('parser/', dir)).map((f) => `parser/${f}`), ...readdirSync(new URL('render/', dir)).map((f) => `render/${f}`)];
    const source = files.map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n');
    for (const id of IDS) assert.ok(source.includes(`'${id}'`), `${id} is used`);
  });
});
