//@ts-check
/**
 * A quoted flowchart label is one unit: the brackets inside it are text.
 * The parser used to look for a node's closing bracket without regard for
 * the quotes, so `A("f(x)") --> B` read the label `"f(x`, ended the
 * statement there, and dropped the edge and node `B` without a word. The
 * printer, which quotes exactly the labels holding a bracket, produced
 * text the parser then read wrongly. A label starting or ending with `/`
 * or `\` (a path, a URL with a trailing slash) or with a space printed bare
 * and read back as another shape or as a trimmed label.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMermaid, toMermaid, diagramToVnode } from '@jarenjs/mermaid';
import { renderToString } from '@jarenjs/view';
import { decodeEntityCodes } from '../../components/mermaid/src/label-text.js';

const parse = (/** @type {string} */ body) => parseMermaid('flowchart TD\n  ' + body).ast;
const summary = (/** @type {any} */ ast) => ({
  nodes: ast.nodes.map((/** @type {any} */ n) => [n.id, n.label, n.shape]),
  edges: ast.edges.map((/** @type {any} */ e) => [e.from, e.to]),
});

describe('flowchart — a quoted label may hold its own closing bracket', function () {
  const CASES = [
    ['A("f(x)") --> B', 'f(x)', 'round'],
    ['A["arr[0]"] --> B', 'arr[0]', 'rect'],
    ['A{"a}b"} --> B', 'a}b', 'diamond'],
    ['A["x]y"] --> B', 'x]y', 'rect'],
    ['A("(a)") --> B', '(a)', 'round'],
    ["A['it)s'] --> B", 'it)s', 'rect'],
    ['A([" ] "]) --> B', ' ] ', 'stadium'],
  ];
  for (const [body, label, shape] of CASES) {
    it(`reads ${body}`, () => {
      assert.deepEqual(summary(parse(body)), { nodes: [['A', label, shape], ['B', 'B', 'rect']], edges: [['A', 'B']] });
    });
  }

  it('does not take an apostrophe inside an unquoted label for a quote', () => {
    assert.deepEqual(summary(parse("A[it's] --> B")), { nodes: [['A', "it's", 'rect'], ['B', 'B', 'rect']], edges: [['A', 'B']] });
  });

  it('keeps an unterminated quote lenient: the closer still ends the label', () => {
    assert.deepEqual(summary(parse('A["open] --> B')), { nodes: [['A', '"open', 'rect'], ['B', 'B', 'rect']], edges: [['A', 'B']] });
  });

  it('a stray quote does not pair with a quote that belongs to the next node', () => {
    assert.deepEqual(summary(parse('A["] --> B["]')), { nodes: [['A', '"', 'rect'], ['B', '"', 'rect']], edges: [['A', 'B']] });
    assert.deepEqual(summary(parse('A["x] --> B[y"]')), { nodes: [['A', '"x', 'rect'], ['B', 'y"', 'rect']], edges: [['A', 'B']] });
    for (const arrow of ['-->', '---', '==>', '-.->', '--o', '--x', '<-->']) {
      assert.equal(parse(`A["a] ${arrow} B["b]`).edges.length, 1, arrow);
    }
  });

  it('a quoted label may still contain text that looks like an arrow when no bracket needs protecting', () => {
    assert.deepEqual(summary(parse('A["a --> b"] --> C')), { nodes: [['A', 'a --> b', 'rect'], ['C', 'C', 'rect']], edges: [['A', 'C']] });
  });

  it('does not let a quote that is never closed swallow the next node', () => {
    assert.deepEqual(summary(parse('A["open] --> B["y"]')),
      { nodes: [['A', '"open', 'rect'], ['B', 'y', 'rect']], edges: [['A', 'B']] });
  });
});

describe('toMermaid — labels print so they read back as they were', function () {
  /** @param {string} source */
  function roundTrips(source) {
    const doc = parseMermaid(source);
    const text = toMermaid(doc);
    const again = parseMermaid(text);
    assert.deepEqual(again.ast, doc.ast, JSON.stringify(text));
    assert.equal(toMermaid(again), text);
    return doc.ast;
  }

  it('round-trips labels that hold brackets', () => {
    const ast = roundTrips('flowchart TD\n  A("f(x)") --> B["arr[0]"]\n  B --> C{"a}b"}');
    assert.deepEqual(ast.nodes.map((/** @type {any} */ n) => n.label), ['f(x)', 'arr[0]', 'a}b']);
  });

  it('quotes a label that starts or ends with a slash, backslash or space', () => {
    for (const label of ['/api/users', 'https://x.test/', '\\win\\', ' lead', 'trail ']) {
      const ast = roundTrips(`flowchart TD\n  A["${label}"] --> B`);
      assert.equal(ast.nodes[0].label, label);
      assert.equal(ast.nodes[0].shape, 'rect');
    }
  });

  it('leaves an ordinary label bare', () => {
    assert.equal(toMermaid(parseMermaid('flowchart TD\n  A[plain text] --> B')), 'flowchart TD\nA[plain text]\nB\nA --> B\n');
    assert.equal(toMermaid(parseMermaid('flowchart TD\n  A[a/b] --> B')), 'flowchart TD\nA[a/b]\nB\nA --> B\n');
  });
});

describe('toMermaid — an edge label prints in a pipe form that reads back as the same graph', function () {
  /** @param {string} source */
  const edgeLine = (source) => toMermaid(parseMermaid(source)).split('\n').find((line) => line.startsWith('A -'));

  it('quotes an inline label holding a semicolon, which ended the statement', () => {
    const source = 'flowchart LR\n  A -- "semi;colon" --> B';
    assert.equal(edgeLine(source), 'A -->|"semi;colon"| B');
    const again = parseMermaid(toMermaid(parseMermaid(source))).ast;
    assert.deepEqual(again.edges.map((/** @type {any} */ e) => [e.from, e.label, e.to]), [['A', 'semi;colon', 'B']]);
  });

  it('quotes an inline label holding a pipe, which read back as an edge to a new node', () => {
    const source = 'flowchart LR\n  A -- "x|y" --> B';
    assert.equal(edgeLine(source), 'A -->|"x|y"| B');
    const again = parseMermaid(toMermaid(parseMermaid(source))).ast;
    assert.deepEqual(again.edges.map((/** @type {any} */ e) => [e.from, e.label, e.to]), [['A', 'x|y', 'B']]);
    assert.deepEqual(again.nodes.map((/** @type {any} */ n) => n.id), ['A', 'B']);
  });

  it('reads a quoted pipe-form label as one unit', () => {
    const edges = parseMermaid('flowchart LR\n  A -->|"x|y"| B -->|\'a|"b\'| C').ast.edges;
    assert.deepEqual(edges.map((/** @type {any} */ e) => [e.from, e.label, e.to]), [['A', 'x|y', 'B'], ['B', 'a|"b', 'C']]);
  });

  it('leaves a label that needs no quotes bare', () => {
    assert.equal(edgeLine('flowchart LR\n  A -->|plain words| B'), 'A -->|plain words| B');
  });
});

describe('toMermaid — every label text reads back as the same graph (round-trip property)', function () {
  const CORPUS = ['x', ' x ', 'semi;colon', 'a;b', 'x|y', '|', 'a|b|c', '"x"', "'x'", 'a"b', "a'b", 'a"b\'c', 'a\'b"c',
    'a"b\'c|d', 'a|b"c\'d', 'a"b\'c;d', 'a\'b"c;d', 'a --> b', 'a --> b|c', 'x -.- y|z', 'a ==> b', 'p\nq', 'p\nq|r',
    '#35;', 'x#124;y', '&amp;', '`**md**`', '`a|b`', '`a"b\'c|d`', 'a]b', 'a)b', 'a}b', '[x]', '(x)', '{x}', 'a --> b]',
    'a"b\'c]', '/x', 'x\\', 'é ü', 'x %% y'];
  // Mermaid has no escape inside a quoted label: these print one character
  // as its entity code, so they read back spelled with the code
  const SPELLED = {
    edge: ['a"b\'c|d', 'a|b"c\'d', 'a"b\'c;d', 'a\'b"c;d', 'a --> b|c', 'x -.- y|z', '`a"b\'c|d`'],
    node: ['a"b\'c;d', 'a\'b"c;d', 'a --> b]', 'a"b\'c]'],
  };
  const SHAPES = ['rect', 'round', 'stadium', 'subroutine', 'cylinder', 'circle', 'doublecircle', 'diamond', 'hexagon',
    'parallelogram', 'parallelogram_alt', 'trapezoid', 'trapezoid_alt', 'asymmetric'];
  const base = parseMermaid('flowchart LR\n  subgraph S [t]\n    C\n  end\n  A --> B');
  const graph = (/** @type {any} */ ast) => ({
    nodes: ast.nodes.map((/** @type {any} */ n) => [n.id, n.shape]),
    edges: ast.edges.map((/** @type {any} */ e) => [e.from, e.to]),
    subgraphs: ast.subgraphs.map((/** @type {any} */ s) => [s.id, s.nodes]),
  });
  /**
   * @param {any} doc
   * @param {(ast: any) => string} labelOf
   * @param {boolean} spelled
   */
  function readsBack(doc, labelOf, spelled) {
    const text = toMermaid(doc);
    const again = parseMermaid(text);
    assert.deepEqual(graph(again.ast), graph(doc.ast), text);
    const label = labelOf(doc.ast);
    if (!spelled) {
      assert.deepEqual(again.ast, doc.ast, text);
      return;
    }
    assert.notEqual(labelOf(again.ast), label, text);
    assert.equal(decodeEntityCodes(labelOf(again.ast)), decodeEntityCodes(label), text);
    for (const options of [{}, { htmlLabels: true }]) {
      assert.equal(renderToString(diagramToVnode(again, options)), renderToString(diagramToVnode(doc, options)), text);
    }
    assert.equal(toMermaid(again), text, 'a fixed point after one print');
  }

  it('an edge label', () => {
    for (const label of CORPUS) {
      const doc = structuredClone(base);
      doc.ast.edges[0].label = label;
      readsBack(doc, (ast) => ast.edges[0].label, SPELLED.edge.includes(label));
    }
  });

  it('a node label in every shape', () => {
    for (const label of CORPUS) {
      for (const shape of SHAPES) {
        const doc = structuredClone(base);
        Object.assign(doc.ast.nodes.find((/** @type {any} */ n) => n.id === 'A'), { label, shape });
        // a label spells a character only where it holds a `;` or its own shape's closer
        const closer = /[\])}]$/.exec(toMermaid(doc).split('\n').find((line) => line.startsWith('A')) ?? '')?.[0] ?? '';
        const spelled = SPELLED.node.includes(label) && (label.includes(';') || label.includes(closer));
        readsBack(doc, (ast) => ast.nodes.find((/** @type {any} */ n) => n.id === 'A').label, spelled);
      }
    }
  });

  it('a subgraph title', () => {
    for (const label of CORPUS) {
      const doc = structuredClone(base);
      doc.ast.subgraphs[0].label = label;
      readsBack(doc, (ast) => ast.subgraphs[0].label, false);
    }
  });

  it('spells only the character no quoting can hold', () => {
    const print = (/** @type {string} */ label) => {
      const doc = structuredClone(base);
      doc.ast.edges[0].label = label;
      return toMermaid(doc).split('\n').find((line) => line.startsWith('A -'));
    };
    assert.equal(print('a --> b|c'), 'A -->|"a --> b#124;c"| B');
    assert.equal(print('a"b\'c|d'), 'A -->|"a#34;b\'c|d"| B');
    assert.equal(print('a"b\'c'), 'A -->|a"b\'c| B');
    assert.equal(print('a --> b'), 'A -->|a --> b| B');
  });
});
