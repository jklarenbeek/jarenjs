//@ts-check
/**
 * `'…'` in a flowchart label, which is no quoting to Mermaid: its quotes are
 * the label's text in nodes, links and subgraph titles, and a closer inside
 * them closes the label.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMermaid, toMermaid } from '@jarenjs/mermaid';

const ast = (/** @type {string} */ body) => /** @type {any} */ (parseMermaid(`flowchart LR\n${body}`).ast);

describe('flowchart — a label in `\'…\'`', () => {
  it('keeps its quotes as text, as Mermaid does', () => {
    assert.deepEqual(ast("A['x']\nB('x')\nC{'x'}\nD(('x'))\nE['']\nF['x' y]\nG['x<br>y']\nH['it''s']").nodes.map((/** @type {any} */ n) => n.label),
      ["'x'", "'x'", "'x'", "'x'", "''", "'x' y", "'x\ny'", "'it''s'"]);
    assert.deepEqual(ast("A -->|'x'| B\nA -- 'x' --> B\nA == 'x' ==> B\nA -- 'x' y --> B").edges.map((/** @type {any} */ e) => e.label),
      ["'x'", "'x'", "'x'", "'x' y"]);
    assert.deepEqual(ast("subgraph s ['x']\n  a\nend\nsubgraph \"'y'\"\n  b\nend").subgraphs.map((/** @type {any} */ g) => [g.id, g.label]),
      [['s', "'x'"], ["'y'", "'y'"]]);
  });

  it('closes at the first closer inside it, as Mermaid reads it', () => {
    assert.deepEqual(ast("A['a] --> B[b']").nodes.map((/** @type {any} */ n) => [n.id, n.label]), [['A', "'a"], ['B', "b'"]]);
    for (const [body, msgid] of [["A['a]b']", 'mermaid/flowchart/expected-link'], ["A('a)b')", 'mermaid/flowchart/expected-link'],
      ["A{'a}b'}", 'mermaid/flowchart/expected-link'], ["A -->|'a|b'| B", 'mermaid/flowchart/expected-link']]) {
      assert.throws(() => parseMermaid(`flowchart LR\n${body}`), (/** @type {any} */ error) => {
        assert.deepEqual([error.msgid, error.line], [msgid, 2], body);
        return true;
      });
    }
  });

  it('prints in `"…"`, which reads back with the quotes', () => {
    const text = toMermaid(parseMermaid("flowchart LR\nA['x'] -->|'y'| B"));
    assert.equal(text, 'flowchart LR\nA["\'x\'"]\nB\nA -->|"\'y\'"| B\n');
    assert.deepEqual(parseMermaid(text).ast, parseMermaid("flowchart LR\nA['x'] -->|'y'| B").ast);
  });
});
