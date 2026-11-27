//@ts-check
/**
 * @file The marks Mermaid draws that this renderer once read and drew plain:
 * a sequence participant's type as Mermaid's glyph for it, the half heads,
 * the two-way heads and the central-connection dots of a message, and a
 * flowchart node in each of Mermaid's shapes that has no bracket form. Each
 * is compared with Mermaid 11's own drawing by shape class (which elements,
 * which side of the line), not by pixels; the exact output is pinned in
 * `fixtures/marks-golden.json`. A diagram without these marks draws as it
 * did, byte for byte.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { parseMermaid, toMermaid, diagramToVnode, compileMermaid } from '@jarenjs/mermaid';
import { renderToString } from '@jarenjs/view';

const GOLDEN = JSON.parse(readFileSync(new URL('./fixtures/marks-golden.json', import.meta.url), 'utf8'));
const CSS = readFileSync(new URL('../../components/mermaid/styles/mermaid.css', import.meta.url), 'utf8');

/** @param {string} source @param {Record<string, any>} [options] */
const svgOf = (source, options = {}) => renderToString(diagramToVnode(source, options));

/** The elements of an SVG fragment as `tag.class` (`tag` alone where it has no class). @param {string} svg */
const shapes = (svg) => [...svg.matchAll(/<(rect|path|polygon|circle|line)\b([^>]*)>/g)]
  .map((m) => m[1] + (/class="([^"]*)"/.exec(m[2])?.[1].replace(/^|\s+/g, '.') ?? ''));

/** The head box of a sequence participant: the elements before its name. @param {string} svg @param {string} id */
const headBox = (svg, id) => /** @type {RegExpExecArray} */ (
  new RegExp(`<g class="mm-node mm-actor" data-id="${id}">(.*?)<text`).exec(svg))[1];

/** Each message's elements before its label. @param {string} svg */
const messages = (svg) => [...svg.matchAll(/<g class="mm-edge mm-message"[^>]*>(.*?)<text/g)].map((m) => m[1]);

describe('sequence — a participant type draws as Mermaid\'s glyph', () => {
  it('draws each type in its shape class, and a plain participant in its box', () => {
    const drawn = Object.fromEntries(['boundary', 'control', 'entity', 'database', 'collections', 'queue', 'participant']
      .map((type) => [type, shapes(headBox(svgOf(`sequenceDiagram\n  participant X@{ "type": "${type}" }`), 'X'))]));
    assert.deepEqual(drawn, {
      // a circle with a bar on its left, an arrow on its top, a line under it
      boundary: ['circle.mm-actor-shape', 'path.mm-actor-mark'],
      control: ['circle.mm-actor-shape', 'polygon.mm-actor-mark'],
      entity: ['circle.mm-actor-shape', 'path.mm-actor-mark'],
      // a cylinder, two boxes one behind the other, a cylinder on its side
      database: ['path.mm-actor-shape'],
      collections: ['rect', 'rect'],
      queue: ['path.mm-actor-shape', 'path.mm-actor-shape'],
      participant: ['rect'],
    });
  });

  it('draws the glyph above the name, in a box grown to hold it, and each other type around the name', () => {
    const glyph = 'sequenceDiagram\n  participant X@{ "type": "entity" }';
    assert.equal(headBox(svgOf(glyph), 'X'),
      '<circle cx="52" cy="29" r="13" class="mm-actor-shape" fill="#dbeafe" stroke="#2563eb" stroke-width="1.5"></circle>'
      + '<path d="M39,42 H65" class="mm-actor-mark" fill="#2563eb" stroke="#2563eb" stroke-width="1.5"></path>');
    assert.match(svgOf(glyph), /<text[^>]*class="mm-label"[^>]*><tspan x="52" y="61"/);
    assert.equal(compileMermaid(glyph).toLayout().actors[0].h, 66);
    // every box of the diagram grows with it, and none grows without one
    assert.deepEqual(compileMermaid('sequenceDiagram\n  participant A\n  participant X@{ "type": "boundary" }')
      .toLayout().actors.map((/** @type {any} */ a) => a.h), [66, 66]);
    const db = 'sequenceDiagram\n  participant X@{ "type": "database" }';
    assert.equal(compileMermaid(db).toLayout().actors[0].h, 34);
    assert.equal(headBox(svgOf(db), 'X'),
      '<path d="M12,18.8 a40,6.8 0 0 0 80,0 a40,6.8 0 0 0 -80,0 l0,20.4 a40,6.8 0 0 0 80,0 l0,-20.4"'
      + ' class="mm-actor-shape" fill="#dbeafe" stroke="#2563eb" stroke-width="1"></path>');
  });

  it('draws the same glyph on the foot box as on the head box', () => {
    const svg = svgOf('sequenceDiagram\n  participant X@{ "type": "control" }');
    const boxes = [...svg.matchAll(/<g class="mm-node mm-actor" data-id="X">(.*?)<text/g)].map((m) => shapes(m[1]));
    assert.deepEqual(boxes, [['circle.mm-actor-shape', 'polygon.mm-actor-mark'], ['circle.mm-actor-shape', 'polygon.mm-actor-mark']]);
  });
});

describe('sequence — the half heads, the two-way heads and the central dots', () => {
  // Mermaid draws a half head with a marker oriented along the line: its
  // `top` is the side left of the way the line travels, so a message right
  // to left draws `-|\` under its line; a head written before the line
  // (`/|-`) stands at the sender's end and points back at the sender.
  it('draws each half head on Mermaid\'s side, at Mermaid\'s end, both ways along the line', () => {
    const OPS = {
      'half-top': '-|\\', 'half-bottom': '-|/', 'stick-top': '-\\\\', 'stick-bottom': '-//',
      'half-top-reverse': '/|-', 'half-bottom-reverse': '\\|-', 'stick-top-reverse': '//-', 'stick-bottom-reverse': '\\\\-',
    };
    /** @type {Record<string, string[]>} */
    const drawn = {};
    for (const [name, op] of Object.entries(OPS)) {
      const source = `sequenceDiagram\n  participant A\n  participant B\n  A${op}B: x\n  B${op}A: y`;
      assert.deepEqual(parseMermaid(source).ast.statements.map((/** @type {any} */ m) => m.head), [name, name]);
      drawn[name] = messages(svgOf(source)).map((m) => /** @type {RegExpExecArray} */ (/<(?:polygon|path) (?:points|d)="([^"]*)"/.exec(m))[1]);
    }
    // A is at x 52, B at 192; the first message runs at y 86 rightwards, the second at y 126 leftwards
    assert.deepEqual(drawn, {
      'half-top': ['192,86 184,86 184,80', '52,126 60,126 60,132'],
      'half-bottom': ['192,86 184,86 184,92', '52,126 60,126 60,120'],
      'stick-top': ['M192,86 L185,79', 'M52,126 L59,133'],
      'stick-bottom': ['M192,86 L185,93', 'M52,126 L59,119'],
      'half-top-reverse': ['52,86 60,86 60,80', '192,126 184,126 184,132'],
      'half-bottom-reverse': ['52,86 60,86 60,92', '192,126 184,126 184,120'],
      'stick-top-reverse': ['M52,86 L59,79', 'M192,126 L185,133'],
      'stick-bottom-reverse': ['M52,86 L59,93', 'M192,126 L185,119'],
    });
  });

  it('draws a two-way message with a head at each end', () => {
    assert.deepEqual(messages(svgOf('sequenceDiagram\n  participant A\n  participant B\n  A<<->>B: x')).map(shapes),
      [['line.mm-message-line', 'polygon.mm-arrowhead', 'polygon.mm-arrowhead']]);
  });

  it('draws a central-connection mark as a dot on the lifeline, the line stopping at it', () => {
    const drawn = ['()->>()', '->>()', '()->>'].map((op) => messages(svgOf(`sequenceDiagram\n  participant A\n  participant B\n  A${op}B: x`))[0]);
    const dots = drawn.map((m) => [...m.matchAll(/<circle cx="([^"]*)" cy="([^"]*)" r="([^"]*)"/g)].map((c) => c.slice(1).join(',')));
    assert.deepEqual(dots, [['52,86,4', '192,86,4'], ['192,86,4'], ['52,86,4']]);
    const ends = drawn.map((m) => /** @type {RegExpExecArray} */ (/<line x1="([^"]*)" y1="[^"]*" x2="([^"]*)"/.exec(m)).slice(1).join('-'));
    assert.deepEqual(ends, ['56-188', '52-188', '56-192']);
  });

  it('draws a self-message\'s reverse head at the loop\'s start and its dots on the lifeline', () => {
    const [reverse, central] = messages(svgOf('sequenceDiagram\n  A/|-A: x\n  A()->>()A: y'));
    assert.match(reverse, /<polygon points="58,86 66,86 66,80"/);
    assert.deepEqual([...central.matchAll(/<circle cx="([^"]*)" cy="([^"]*)"/g)].map((c) => c.slice(1).join(',')), ['52,138', '52,164']);
  });
});

/** Mermaid 11's shapes with no bracket form, by its short name, and each name or alias that names one. */
const NAMED = {
  datastore: ['data-store'], bang: [], cloud: [], text: [], 'notch-rect': ['card', 'notched-rectangle'],
  'lin-rect': ['lined-rectangle', 'lined-process', 'lin-proc', 'shaded-process'],
  'sm-circ': ['start', 'small-circle'], 'fr-circ': ['stop', 'framed-circle'], fork: ['join'],
  hourglass: ['collate'], brace: ['comment', 'brace-l'], 'brace-r': [], braces: [],
  bolt: ['com-link', 'lightning-bolt'], doc: ['document'], delay: ['half-rounded-rectangle'],
  'h-cyl': ['das', 'horizontal-cylinder'], 'lin-cyl': ['disk', 'lined-cylinder'],
  'curv-trap': ['curved-trapezoid', 'display'], 'div-rect': ['div-proc', 'divided-rectangle', 'divided-process'],
  tri: ['extract', 'triangle'], 'win-pane': ['internal-storage', 'window-pane'],
  'f-circ': ['junction', 'filled-circle'], 'notch-pent': ['loop-limit', 'notched-pentagon'],
  'flip-tri': ['manual-file', 'flipped-triangle'], 'sl-rect': ['manual-input', 'sloped-rectangle'],
  docs: ['documents', 'st-doc', 'stacked-document'], 'st-rect': ['procs', 'processes', 'stacked-rectangle'],
  'bow-rect': ['stored-data', 'bow-tie-rectangle'], 'cross-circ': ['summary', 'crossed-circle'],
  'tag-doc': ['tagged-document'], 'tag-rect': ['tagged-rectangle', 'tag-proc', 'tagged-process'],
  flag: ['paper-tape'], 'lin-doc': ['lined-document'],
};

describe('flowchart — Mermaid\'s shapes with no bracket form', () => {
  it('reads each by its short name or an alias, and prints it back by its short name', () => {
    for (const [shape, aliases] of Object.entries(NAMED)) {
      for (const name of [shape, ...aliases]) {
        const doc = parseMermaid(`flowchart LR\n  A@{ shape: ${name}, label: "x" }\n  B@{ shape: ${name} }`);
        assert.deepEqual(doc.ast.nodes.map((/** @type {any} */ n) => [n.label, n.shape]), [['x', shape], ['B', shape]], name);
        const text = toMermaid(doc);
        assert.equal(text, `flowchart LR\nA[x]@{ shape: ${shape} }\nB@{ shape: ${shape} }\n`, name);
        assert.deepEqual(parseMermaid(text).ast, doc.ast, name);
      }
    }
    assert.equal(Object.keys(NAMED).length, 34);
  });

  it('draws each in its shape class, and the marks Mermaid draws without a label without one', () => {
    /** @type {Record<string, [string[], boolean]>} */
    const drawn = {};
    for (const shape of Object.keys(NAMED)) {
      const svg = svgOf(`flowchart LR\n  A["x"]@{ shape: ${shape} }`);
      const node = /** @type {RegExpExecArray} */ (/<g class="mm-node" data-id="A">(.*)<\/g><\/svg>$/.exec(svg))[1];
      drawn[shape] = [shapes(node), node.includes('class="mm-label"')];
    }
    assert.deepEqual(drawn, {
      datastore: [['rect.mm-node-shape'], true],
      bang: [['polygon.mm-node-shape'], true],
      cloud: [['path.mm-node-shape'], true],
      text: [['rect.mm-node-shape.mm-node-bare'], true],
      'notch-rect': [['polygon.mm-node-shape'], true],
      'lin-rect': [['rect.mm-node-shape', 'path.mm-node-detail'], true],
      'sm-circ': [['circle.mm-node-mark'], false],
      'fr-circ': [['circle.mm-node-shape', 'circle.mm-node-mark'], false],
      fork: [['rect.mm-node-mark'], false],
      hourglass: [['polygon.mm-node-shape'], false],
      brace: [['rect.mm-node-shape.mm-node-bare', 'path.mm-node-detail'], true],
      'brace-r': [['rect.mm-node-shape.mm-node-bare', 'path.mm-node-detail'], true],
      braces: [['rect.mm-node-shape.mm-node-bare', 'path.mm-node-detail'], true],
      bolt: [['polygon.mm-node-mark'], false],
      doc: [['path.mm-node-shape'], true],
      delay: [['path.mm-node-shape'], true],
      'h-cyl': [['path.mm-node-shape', 'path.mm-node-detail'], true],
      'lin-cyl': [['path.mm-node-shape', 'path.mm-node-detail'], true],
      'curv-trap': [['path.mm-node-shape'], true],
      'div-rect': [['rect.mm-node-shape', 'path.mm-node-detail'], true],
      tri: [['polygon.mm-node-shape'], true],
      'win-pane': [['rect.mm-node-shape', 'path.mm-node-detail'], true],
      'f-circ': [['circle.mm-node-mark'], false],
      'notch-pent': [['polygon.mm-node-shape'], true],
      'flip-tri': [['polygon.mm-node-shape'], true],
      'sl-rect': [['polygon.mm-node-shape'], true],
      docs: [['path.mm-node-shape', 'path.mm-node-shape', 'path.mm-node-shape'], true],
      'st-rect': [['rect.mm-node-shape', 'rect.mm-node-shape', 'rect.mm-node-shape'], true],
      'bow-rect': [['path.mm-node-shape'], true],
      'cross-circ': [['circle.mm-node-shape', 'path.mm-node-detail'], false],
      'tag-doc': [['path.mm-node-shape', 'polygon.mm-node-mark'], true],
      'tag-rect': [['rect.mm-node-shape', 'polygon.mm-node-mark'], true],
      flag: [['path.mm-node-shape'], true],
      'lin-doc': [['path.mm-node-shape', 'path.mm-node-detail'], true],
    });
  });

  it('draws a data store as its two lines, and a mark Mermaid draws unlabelled at its own size', () => {
    assert.match(svgOf('flowchart LR\n  A["x"]@{ shape: datastore }'),
      /<rect x="12" y="12" width="48" height="34.8" class="mm-node-shape" fill="#dbeafe" stroke="#2563eb" stroke-width="1" stroke-dasharray="48 34.8">/);
    const layout = compileMermaid('flowchart LR\n  A["a long label"]@{ shape: fork }\n  B["x"]@{ shape: sm-circ }').toLayout();
    assert.deepEqual(layout.nodes.map((/** @type {any} */ n) => [n.w, n.h]), [[70, 10], [14, 14]]);
  });

  it('paints a named shape in the colors an author\'s style gives it', () => {
    const svg = svgOf('flowchart LR\n  A["x"]@{ shape: lin-rect }\n  style A fill:#ffeeaa,stroke:#aa5500');
    assert.match(svg, /<rect [^>]*class="mm-node-shape"[^>]*stroke="#aa5500"[^>]*style="fill:#ffeeaa;stroke:#aa5500"/);
    assert.match(svg, /<path d="M20,12 V46.8" class="mm-node-detail" fill="none" stroke="#aa5500"/);
    // a line inside, a filled mark and a brace's empty box take the author's
    // stroke and never the author's fill
    const styled = (/** @type {string} */ shape) => /** @type {RegExpExecArray} */ (/<g class="mm-node" data-id="A">(.*)<\/g><\/svg>$/.exec(
      svgOf(`flowchart LR\n  A["x"]@{ shape: ${shape} }\n  style A fill:#ffeeaa,stroke:#aa5500`)))[1];
    assert.match(styled('lin-rect'), /class="mm-node-detail" fill="none" stroke="#aa5500" stroke-width="1" style="stroke:#aa5500"/);
    assert.match(styled('tag-rect'), /<polygon [^>]*class="mm-node-mark" fill="#aa5500" stroke="#aa5500" stroke-width="1" style="fill:#aa5500;stroke:#aa5500">/);
    assert.match(styled('fr-circ'), /<circle cx="23" cy="23" r="7" class="mm-node-mark" fill="#aa5500" stroke="#aa5500" stroke-width="1" style="fill:#aa5500;stroke:#aa5500">/);
    assert.match(styled('braces'), /<rect x="12" y="12" width="51" height="34.8" class="mm-node-shape mm-node-bare" fill="none" stroke="none" stroke-width="1"><\/rect>/);
  });
});

describe('the new marks theme through the stylesheet', () => {
  it('maps every class a new mark carries to the theme\'s tokens', () => {
    for (const [cls, rule] of [
      ['mm-actor-shape', 'fill: var(--mm-actor-fill); stroke: var(--mm-actor-stroke);'],
      ['mm-actor-mark', 'fill: var(--mm-actor-stroke); stroke: var(--mm-actor-stroke);'],
      ['mm-node-detail', 'stroke: var(--mm-node-stroke);'],
      ['mm-node-mark', 'fill: var(--mm-node-stroke); stroke: var(--mm-node-stroke);'],
      ['mm-node-bare', 'fill: none; stroke: none;'],
    ]) assert.ok(CSS.includes(`.mermaid .${cls} { ${rule} }`), cls);
  });

  it('stamps the host-linked tokens the new marks read, and draws them in a host theme\'s colors', () => {
    const svg = svgOf('sequenceDiagram\n  participant X@{ "type": "control" }\n  X-|\\X: x', { theme: 'host' });
    for (const token of ['--mm-actor-fill', '--mm-actor-stroke', '--mm-line-color']) assert.match(svg, new RegExp(`${token}:var\\(--`), token);
    const dark = svgOf('flowchart LR\n  A["x"]@{ shape: tag-rect }', { theme: 'dark' });
    assert.match(dark, /<polygon [^>]*class="mm-node-mark" fill="#81B1DB" stroke="#81B1DB"/);
  });
});

describe('the golden drawings of the new marks', () => {
  it('draws each golden source byte for byte', () => {
    assert.ok(GOLDEN.cases.length >= 3);
    for (const entry of GOLDEN.cases) assert.equal(svgOf(entry.source), entry.svg, entry.source);
  });
});
