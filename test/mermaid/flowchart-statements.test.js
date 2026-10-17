//@ts-check
/**
 * A flowchart line's statements and inline edge labels, read as Mermaid reads
 * them. The inline form `A -- text --> B` took the first link operator after
 * its text for its end, so a quoted label holding one (`A -- "a --> b" --> B`)
 * read as an edge to `b` labelled `"a` and dropped `B`; and an opening run of
 * any length opened a label, so `A --- B --> C` read as one edge `A`→`C`
 * labelled `B`. The statement splitter took every quote for a label's quote,
 * so after the apostrophe in `A[it's]` no `;` separated and `C --> D`
 * vanished, while a `;` inside an unquoted label (`A[a;b]`) split the label
 * and was refused. A statement after a `;` that opens with a keyword
 * (`style`) read as a node of that name.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMermaid, toMermaid, MermaidParseError } from '@jarenjs/mermaid';
import { growthRatio } from '../lib/growth.js';

const parse = (/** @type {string} */ body) => parseMermaid('flowchart LR\n' + body).ast;
const summary = (/** @type {any} */ ast) => ({
  nodes: ast.nodes.map((/** @type {any} */ n) => [n.id, n.label]),
  edges: ast.edges.map((/** @type {any} */ e) => [e.from, e.to, e.label]),
});
/** The graph a body reads as, and the graph its printed source reads back as. */
const both = (/** @type {string} */ body) => {
  const doc = parseMermaid('flowchart LR\n' + body);
  return [summary(doc.ast), summary(parseMermaid(toMermaid(doc)).ast)];
};

describe('flowchart — an inline edge label reads a quoted label as one unit', function () {
  for (const quote of ['"', "'"]) {
    it(`reads A -- ${quote}a --> b${quote} --> B as one labelled edge`, () => {
      const want = { nodes: [['A', 'A'], ['B', 'B']], edges: [['A', 'B', 'a --> b']] };
      assert.deepEqual(both(`A -- ${quote}a --> b${quote} --> B`), [want, want]);
    });
  }
  it('closes a quoted label at the link run after its quote, a blank between them or not', () => {
    assert.deepEqual(summary(parse('A -- "x --> y"--> B')).edges, [['A', 'B', 'x --> y']]);
    assert.deepEqual(summary(parse('A -- "x"-->B')).edges, [['A', 'B', 'x']]);
  });
  it('keeps the closing run the label is followed by', () => {
    const edge = parse('A == "x --> y" ==> B').edges[0];
    assert.deepEqual([edge.stroke, edge.head, edge.length, edge.label], ['thick', 'arrow', 2, 'x --> y']);
  });
  it('opens a label only at --, == or -. and a blank: A --- B --> C is two links', () => {
    const want = { nodes: [['A', 'A'], ['B', 'B'], ['C', 'C']], edges: [['A', 'B', null], ['B', 'C', null]] };
    assert.deepEqual(both('A --- B --> C'), [want, want]);
    assert.deepEqual(summary(parse('A === B ==> C')).edges, [['A', 'B', null], ['B', 'C', null]]);
  });
  it('still reads every inline form that read right', () => {
    assert.deepEqual(summary(parse('A -- x --> B')).edges, [['A', 'B', 'x']]);
    assert.deepEqual(summary(parse('A -- "x" --> B')).edges, [['A', 'B', 'x']]);
    assert.deepEqual(summary(parse('A -. y .-> B')).edges, [['A', 'B', 'y']]);
    assert.deepEqual(summary(parse('A == z ==> B')).edges, [['A', 'B', 'z']]);
    assert.deepEqual(summary(parse('A <-- w --> B')).edges, [['A', 'B', 'w']]);
    assert.deepEqual(summary(parse("A -- it's --> B")).edges, [['A', 'B', "it's"]]);
    assert.deepEqual(summary(parse('A -- "a" b --> B')).edges, [['A', 'B', '"a" b']]);
  });
});

describe('flowchart — a ; separates statements outside every label', function () {
  const FOUR = { nodes: [['A', "it's"], ['B', 'B'], ['C', 'C'], ['D', 'D']], edges: [['A', 'B', null], ['C', 'D', null]] };
  for (const body of ["A[it's] --> B; C --> D", "A(it's) --> B; C --> D", "A{it's} --> B; C --> D"]) {
    it(`reads ${body} as two statements`, () => {
      assert.deepEqual(both(body), [FOUR, FOUR]);
    });
  }
  it('reads an apostrophe in an edge label as text', () => {
    const want = { nodes: [['A', 'A'], ['B', 'B'], ['C', 'C'], ['D', 'D']], edges: [['A', 'B', "it's"], ['C', 'D', null]] };
    assert.deepEqual(both("A -->|it's| B; C --> D"), [want, want]);
    assert.deepEqual(both("A -- it's --> B; C --> D"), [want, want]);
  });
  it('reads a ; inside a label, quoted or not, as text', () => {
    for (const [body, label] of [['A[a;b] --> B', 'a;b'], ['A["a;b"] --> B', 'a;b'], ['A[I #9829; you] --> B', 'I #9829; you']]) {
      const want = { nodes: [['A', label], ['B', 'B']], edges: [['A', 'B', null]] };
      assert.deepEqual(both(body), [want, want], body);
    }
    for (const body of ['A -->|a;b| B', 'A -- a;b --> B', 'A -- "a;b" --> B']) {
      assert.deepEqual(summary(parse(body)).edges, [['A', 'B', 'a;b']], body);
    }
  });
  it('reads a statement after a ; that opens with a keyword as that keyword', () => {
    const ast = parse('A --> B; style A fill:#f00; class B hot');
    assert.deepEqual(summary(ast).nodes, [['A', 'A'], ['B', 'B']]);
    assert.deepEqual(ast.styles, [{ node: 'A', styles: 'fill:#f00' }]);
    assert.deepEqual(ast.classes, [{ node: 'B', name: 'hot' }]);
  });
  it('reads an end after a ; as the end of the open subgraph, and refuses it with none open', () => {
    const ast = parse('subgraph S\nA --> B; end\nC');
    assert.deepEqual(ast.subgraphs.map((/** @type {any} */ g) => [g.id, g.nodes]), [['S', ['A', 'B']]]);
    assert.deepEqual(summary(ast).nodes, [['A', 'A'], ['B', 'B'], ['C', 'C']]);
    // it read as a node named end; Mermaid refuses the line
    assert.throws(() => parse('A --> B; end'), MermaidParseError);
  });
  it('still separates statements that read right', () => {
    assert.deepEqual(summary(parse('A --> B; C --> D;')).edges, [['A', 'B', null], ['C', 'D', null]]);
    assert.deepEqual(summary(parse('A["x;y"] --> B; C')).nodes, [['A', 'x;y'], ['B', 'B'], ['C', 'C']]);
  });
});

describe('flowchart — finding the labels that hold a ; stays linear', function () {
  const unclosed = (/** @type {string} */ unit, /** @type {number} */ n) => 'flowchart LR\n' + unit.repeat(n) + ';B';
  for (const unit of ['x[', 'x(', 'x{{']) {
    it(`a line of unclosed ${unit} shapes is refused, and eight times the line costs far less than sixty-four times`, () => {
      assert.throws(() => parseMermaid(unclosed(unit, 10)), MermaidParseError);
      const refuse = (/** @type {string} */ source) => { try { parseMermaid(source); } catch { /* refused */ } };
      // linear is about 8x, quadratic about 64x (a shape that never closes
      // was scanned to the end of the line again from every opener)
      const ratio = growthRatio(refuse, unclosed(unit, 2000), unclosed(unit, 16000), { limit: 24 });
      assert.ok(ratio < 24, `${unit}: eight times the line multiplied the time by ${ratio.toFixed(1)}`);
    });
  }
});
