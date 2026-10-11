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

import { parseMermaid, toMermaid } from '@jarenjs/mermaid';

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
