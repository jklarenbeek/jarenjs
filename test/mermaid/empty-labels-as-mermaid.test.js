//@ts-check
/**
 * A flowchart label with nothing in it, or a bracket Mermaid refuses, as
 * Mermaid reads it: a node's or a link's label empty but for the `""` pairs
 * Mermaid drops is refused, a blank reads as an empty label, and `toMermaid`
 * prints an empty label as a blank; a bracket in a pipe label or subgraph
 * title that is not quoted is refused, and reads quoted or inline.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMermaid, toMermaid } from '@jarenjs/mermaid';

/**
 * @param {string} body
 * @param {string} msgid
 * @param {object} params
 */
function refuses(body, msgid, params) {
  assert.throws(() => parseMermaid(`flowchart LR\n${body}`), (/** @type {any} */ error) => {
    assert.equal(error.name, 'MermaidParseError', body);
    assert.deepEqual([error.msgid, error.line, error.params], [msgid, 2, params], body);
    return true;
  });
}

const labels = (/** @type {string} */ body) => {
  const ast = /** @type {any} */ (parseMermaid(`flowchart LR\n${body}`).ast);
  return [ast.nodes.map((/** @type {any} */ n) => [n.id, n.label, n.shape]), ast.edges.map((/** @type {any} */ e) => e.label)];
};

describe('flowchart — an empty label', () => {
  it('is refused in a node, as Mermaid refuses it', () => {
    for (const node of ['A[]', 'A[""]', 'A[""""]', 'A()', 'A("")', 'A{}', 'A{""}', 'A(())', 'A((""))', 'A>""]', 'A[("")]']) {
      refuses(node, 'mermaid/flowchart/empty-label', { id: 'A' });
    }
    refuses('A[""] --> B', 'mermaid/flowchart/empty-label', { id: 'A' });
  });

  it('is refused in a link, as Mermaid refuses it', () => {
    for (const link of ['A -->|| B', 'A -->|""| B', 'A -->|""""| B', 'A -- "" --> B', 'A -- """" --> B', 'A == "" ==> B', 'A -. "" .-> B']) {
      refuses(link, 'mermaid/flowchart/empty-link-label', { from: 'A' });
    }
  });

  it('still reads a blank, or an empty pair beside a blank or text, as Mermaid does', () => {
    assert.deepEqual(labels('A[ ]\nB[" "]\nC["" ]\nD[ ""]\nE[""x]\nF[x""]'),
      [[['A', '', 'rect'], ['B', ' ', 'rect'], ['C', '', 'rect'], ['D', '', 'rect'], ['E', 'x', 'rect'], ['F', 'x', 'rect']], []]);
    assert.deepEqual(labels('A -->| | B\nA -->|"" | B')[1], ['', '']);
  });
});

describe('toMermaid — an empty label', () => {
  it('prints as a blank, which reads back empty', () => {
    const doc = parseMermaid('flowchart LR\nA[x] -->|y| B(z)\nC{w} -- u --> D((v))\nE>q]');
    const ast = /** @type {any} */ (doc.ast);
    for (const n of ast.nodes) n.label = '';
    for (const e of ast.edges) e.label = '';
    const text = toMermaid(doc);
    assert.equal(text, 'flowchart LR\nA[ ]\nB( )\nC{ }\nD(( ))\nE> ]\nA -->| | B\nC -->| | D\n');
    assert.deepEqual(parseMermaid(text).ast, ast);
  });
});

describe('flowchart — a bracket in a label that is not quoted', () => {
  it('is refused in a pipe label and a subgraph title, as Mermaid refuses it', () => {
    for (const label of ['x(y)', 'x[y]', 'x{y}', '(y)', 'x)', 'x(', 'x]', 'a[b', 'x}', '"x"(y)']) {
      refuses(`A -->|${label}| B`, 'mermaid/flowchart/bracket-in-link-label', { from: 'A' });
    }
    for (const header of ['s [Core (x)]', 's [a[b]]', 's [a{b}]', 's [a)]', 's [(a]', 's [a]b]', 's ["a"(b)]', 'a(b)', 'a{b}', 'Core (x)']) {
      refuses(`subgraph ${header}
  x
end`, 'mermaid/flowchart/bracket-in-title', {});
    }
  });

  it('still reads one quoted, and one in the inline form, as Mermaid does', () => {
    assert.deepEqual(labels('A -->|"x(y)"| B\nA -- x(y) --> B\nA -- x[y] --> B\nA -- x{y} --> B')[1], ['x(y)', 'x(y)', 'x[y]', 'x{y}']);
    const titles = /** @type {any} */ (parseMermaid('flowchart LR\nsubgraph s ["Core (x)"]\n  a\nend\nsubgraph "Core (y)"\n  b\nend').ast)
      .subgraphs.map((/** @type {any} */ g) => g.label);
    assert.deepEqual(titles, ['Core (x)', 'Core (y)']);
  });

  it('prints quoted, which reads back', () => {
    const doc = parseMermaid('flowchart LR\nsubgraph s [t]\n  a\nend\na -->|x| b');
    const ast = /** @type {any} */ (doc.ast);
    ast.subgraphs[0].label = 'Core (x)';
    ast.edges[0].label = 'x(y)';
    const text = toMermaid(doc);
    assert.ok(text.includes('subgraph s ["Core (x)"]') && text.includes('a -->|"x(y)"| b'), text);
    assert.deepEqual(parseMermaid(text).ast, ast);
  });
});
