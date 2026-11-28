//@ts-check
/**
 * Flowchart forms as Mermaid reads them: a node id may hold a `'`; an inline
 * label's text runs to the first link of its opening run's kind, as Mermaid
 * lexes it, a run in it that ends no such link refused (`'…'` is no quoting,
 * so `A -- 'a -- b' --> B` is refused and `A -- 'a --> b' --> B` is a link to
 * a node `b'`); a subgraph id before a bracketed title holds no bracket,
 * `<`, `>` or `|`, unless quoted. Each reading and each refusal here was
 * checked against Mermaid 11.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';

import { parseMermaid, toMermaid, renderMermaid } from '@jarenjs/mermaid';
import { renderToString } from '@jarenjs/view';
import { transformJson } from '@jarenjs/json/jslt';

const F = (/** @type {string} */ body) => `flowchart TD\n${body}`;
/** Nodes (id, label, shape) in order, edges (from, to, label, stroke, head, tail). */
const graph = (/** @type {string} */ source) => {
  const a = /** @type {any} */ (parseMermaid(source).ast);
  return {
    nodes: a.nodes.map((/** @type {any} */ n) => [n.id, n.label, n.shape]),
    edges: a.edges.map((/** @type {any} */ e) => [e.from, e.to, e.label, e.stroke, e.head, e.tail]),
  };
};

/**
 * @param {string} source
 * @param {string} msgid
 * @param {number} line
 * @param {object} [params]
 */
function refuses(source, msgid, line, params) {
  assert.throws(() => parseMermaid(source), (/** @type {any} */ error) => {
    assert.equal(error.name, 'MermaidParseError', source);
    assert.deepEqual([error.msgid, error.line], [msgid, line], source);
    if (params !== undefined) assert.deepEqual(error.params, params, source);
    return true;
  });
}

describe('flowchart — a node id holding a `\'`', () => {
  it('reads as Mermaid reads it, at any place in the id and in every statement', () => {
    assert.deepEqual(graph(F("A --> b'")).edges, [['A', "b'", null, 'solid', 'arrow', 'none']]);
    assert.deepEqual(graph(F("b' --> A\nA' --> B'\nA --> b'c'd\n'a' --> B\nA-->'b")).nodes.map((/** @type {any} */ n) => n[0]),
      ["b'", 'A', "A'", "B'", "b'c'd", "'a'", 'B', "'b"]);
    assert.deepEqual(graph(F("A --> b''")).nodes.map((/** @type {any} */ n) => n[0]), ['A', "b''"]);
    assert.deepEqual(graph(F("A'[x] --> b'(y)\nc'{z}\nd'>w]\ne'@{ shape: rect }")).nodes,
      [["A'", 'x', 'rect'], ["b'", 'y', 'round'], ["c'", 'z', 'diamond'], ["d'", 'w', 'asymmetric'], ["e'", "e'", 'rect']]);
    assert.deepEqual(graph(F("A --> b' & c'")).edges.map((/** @type {any} */ e) => e.slice(0, 2)), [['A', "b'"], ['A', "c'"]]);
    assert.deepEqual(graph(F("A --> b' ; b' --> C")).edges.map((/** @type {any} */ e) => e.slice(0, 2)), [['A', "b'"], ["b'", 'C']]);
    // a `;` in the label of a shape after such an id is text, as everywhere
    assert.deepEqual(graph(F("A --> b'[x;y]; C --> D")).nodes, [['A', 'A', 'rect'], ["b'", 'x;y', 'rect'], ['C', 'C', 'rect'], ['D', 'D', 'rect']]);
    assert.deepEqual(graph(F("A -->|x| b'\nA -- y --> c'\nA ~~~ d'\nA <--> e'")).edges.map((/** @type {any} */ e) => e.slice(0, 4)),
      [['A', "b'", 'x', 'solid'], ['A', "c'", 'y', 'solid'], ['A', "d'", null, 'invisible'], ['A', "e'", null, 'solid']]);
  });

  it('is the id its class, style and click lines name', () => {
    const a = /** @type {any} */ (parseMermaid(F("A --> b'\nstyle b' fill:#f00\nclass b' x\nclick b' call f()\nb':::d"))).ast;
    assert.deepEqual([a.styles.map((/** @type {any} */ s) => s.node), a.classes.map((/** @type {any} */ c) => [c.node, c.name]),
      a.clicks.map((/** @type {any} */ c) => c.ids)], [["b'"], [["b'", 'x'], ["b'", 'd']], [["b'"]]]);
  });

  it('is the id the drawing marks and the dag projection names', () => {
    const svg = renderToString(renderMermaid("flowchart LR\nA -->|x| b'"));
    assert.deepEqual([...svg.matchAll(/data-id="([^"]*)"/g)].map((m) => m[1]), ['A', "b'"]);
    assert.deepEqual([...svg.matchAll(/data-(?:from|to)="([^"]*)"/g)].map((m) => m[1]), ['A', "b'"]);
    const toDag = JSON.parse(readFileSync(new URL('../../components/mermaid/stylesheets/flowchart-to-dag.jslt.json', import.meta.url), 'utf8'));
    assert.deepEqual(transformJson(toDag, parseMermaid("flowchart LR\nA -->|x| b'")), {
      $dag: '0.1', nodes: { A: { kind: 'task', run: 'A' }, "b'": { kind: 'task', run: "b'" } }, edges: [{ from: 'A', to: "b'", port: 'x' }],
    });
  });

  it('prints as written and reads back', () => {
    const doc = parseMermaid(F("A['x'] --> b' --> 'c"));
    assert.equal(toMermaid(doc), 'flowchart TD\nA["\'x\'"]\nb\'\n\'c\nA --> b\'\nb\' --> \'c\n');
    assert.deepEqual(parseMermaid(toMermaid(doc)).ast, doc.ast);
  });
});

describe('flowchart — an inline label\'s text', () => {
  it('reads `\'…\'` as text, so a link in it ends the label, as Mermaid reads it', () => {
    assert.deepEqual(graph(F("A -- 'a --> b' --> B")), {
      nodes: [['A', 'A', 'rect'], ["b'", "b'", 'rect'], ['B', 'B', 'rect']],
      edges: [['A', "b'", "'a", 'solid', 'arrow', 'none'], ["b'", 'B', null, 'solid', 'arrow', 'none']],
    });
    assert.deepEqual(graph(F("A -- 'a --- b' --- B")).edges.map((/** @type {any} */ e) => e.slice(0, 3)), [['A', "b'", "'a"], ["b'", 'B', null]]);
  });

  it('refuses a run that ends no link of the label\'s kind, as Mermaid refuses it', () => {
    refuses(F("A -- 'a -- b' --> B"), 'mermaid/flowchart/link-in-link-label', 2, { from: 'A', run: '--' });
    refuses(F('A -- a -- b --> B'), 'mermaid/flowchart/link-in-link-label', 2, { from: 'A', run: '--' });
    refuses(F('A -- a -- b'), 'mermaid/flowchart/link-in-link-label', 2);
    refuses(F('A -- a-- B'), 'mermaid/flowchart/link-in-link-label', 2);
    refuses(F("A -- 'a -- b' --- B"), 'mermaid/flowchart/link-in-link-label', 2);
    refuses(F("A == 'a == b' ==> B"), 'mermaid/flowchart/link-in-link-label', 2, { from: 'A', run: '=' });
    refuses(F('A == a == b ==> B'), 'mermaid/flowchart/link-in-link-label', 2);
    refuses(F('A == a=b ==> B'), 'mermaid/flowchart/link-in-link-label', 2, { from: 'A', run: '=' });
    refuses(F("A -. 'a -. b' .-> B"), 'mermaid/flowchart/link-in-link-label', 2, { from: 'A', run: '.' });
    refuses(F('A -. a -. b .-> B'), 'mermaid/flowchart/link-in-link-label', 2);
    refuses(F('A -. a.b .-> B'), 'mermaid/flowchart/link-in-link-label', 2, { from: 'A', run: '.' });
    refuses(F('X --> Y & Z -- a -- b --> B'), 'mermaid/flowchart/link-in-link-label', 2, { from: 'Y & Z', run: '--' });
  });

  it('ends at a link with no blank before it, its mark before the run the link\'s, as Mermaid reads it', () => {
    assert.deepEqual(graph(F('A -- a--> B')).edges, [['A', 'B', 'a', 'solid', 'arrow', 'none']]);
    assert.deepEqual(graph(F('A == a==> B')).edges, [['A', 'B', 'a', 'thick', 'arrow', 'none']]);
    assert.deepEqual(graph(F('A -- fox--> B')).edges.map((/** @type {any} */ e) => e.slice(0, 3)), [['A', 'B', 'fo']]);
    assert.deepEqual(graph(F('A -- a <--> B')).edges.map((/** @type {any} */ e) => e.slice(0, 3)), [['A', 'B', 'a']]);
  });

  it('still reads every inline form that read right', () => {
    const edges = (/** @type {string} */ body) => graph(F(body)).edges.map((/** @type {any} */ e) => e.slice(0, 5));
    assert.deepEqual(edges("A -- 'x' --> B"), [['A', 'B', "'x'", 'solid', 'arrow']]);
    assert.deepEqual(edges("A -- 'a ==> b' --> B"), [['A', 'B', "'a ==> b'", 'solid', 'arrow']]);
    assert.deepEqual(edges("A == 'a --> b' ==> B"), [['A', 'B', "'a --> b'", 'thick', 'arrow']]);
    assert.deepEqual(edges("A -- 'a' b' --> B"), [['A', 'B', "'a' b'", 'solid', 'arrow']]);
    assert.deepEqual(edges('A -- "a -- b" --> B'), [['A', 'B', 'a -- b', 'solid', 'arrow']]);
    assert.deepEqual(edges('A -- "a" b --> B'), [['A', 'B', 'a b', 'solid', 'arrow']]);
    assert.deepEqual(edges('A -- a-b --> B'), [['A', 'B', 'a-b', 'solid', 'arrow']]);
    assert.deepEqual(edges('A -- a ---> B'), [['A', 'B', 'a', 'solid', 'arrow']]);
    assert.deepEqual(edges('A -- a ----> B'), [['A', 'B', 'a', 'solid', 'arrow']]);
    assert.deepEqual(edges('A -- a --o B'), [['A', 'B', 'a', 'solid', 'circle']]);
    assert.deepEqual(edges('A -- a --x B'), [['A', 'B', 'a', 'solid', 'cross']]);
    assert.deepEqual(edges('A -- a --- B --> C'), [['A', 'B', 'a', 'solid', 'none'], ['B', 'C', null, 'solid', 'arrow']]);
    assert.deepEqual(edges('A <-- a --> B'), [['A', 'B', 'a', 'solid', 'arrow']]);
    assert.deepEqual(edges('A == a === B'), [['A', 'B', 'a', 'thick', 'none']]);
    assert.deepEqual(edges('A -. a .- B'), [['A', 'B', 'a', 'dotted', 'none']]);
    assert.deepEqual(edges('A -. a -.- B'), [['A', 'B', 'a', 'dotted', 'none']]);
    assert.deepEqual(edges('A -. a -.-> B'), [['A', 'B', 'a', 'dotted', 'arrow']]);
    assert.deepEqual(edges('A -- a & b --> B'), [['A', 'B', 'a & b', 'solid', 'arrow']]);
    assert.deepEqual(edges('A -- a | b --> B'), [['A', 'B', 'a | b', 'solid', 'arrow']]);
    assert.deepEqual(edges('A -- a; b --> B'), [['A', 'B', 'a; b', 'solid', 'arrow']]);
    assert.deepEqual(edges('A -- a --> B & C'), [['A', 'B', 'a', 'solid', 'arrow'], ['A', 'C', 'a', 'solid', 'arrow']]);
    assert.deepEqual(edges('A -- a --- b --> B'), [['A', 'b', 'a', 'solid', 'none'], ['b', 'B', null, 'solid', 'arrow']]);
    assert.deepEqual(edges('A -- it\'s --> B'), [['A', 'B', "it's", 'solid', 'arrow']]);
  });
});

describe('flowchart — a subgraph id before a bracketed title', () => {
  it('refuses a bracket, `<`, `>` or `|` in it, as Mermaid refuses it', () => {
    for (const id of ['a(b)', 'a{b}', 'a)b', 'a]b', 'a}b', 'a>b', 'a<b', 'a|b', 'a(b', '(a)', 'a(b)c', 'a{b']) {
      refuses(F(`subgraph ${id} [t]\n A\nend`), 'mermaid/flowchart/bracket-in-subgraph-id', 2, { id });
    }
    refuses(F('subgraph a(b)[t]\n A\nend'), 'mermaid/flowchart/bracket-in-subgraph-id', 2, { id: 'a(b)' });
    refuses(F('subgraph a(b) ["t"]\n A\nend'), 'mermaid/flowchart/bracket-in-subgraph-id', 2);
  });

  it('still reads an id that read right, and a quoted one holding a bracket', () => {
    const subs = (/** @type {string} */ header) => /** @type {any} */ (parseMermaid(F(`subgraph ${header}\n A\nend`)).ast).subgraphs
      .map((/** @type {any} */ g) => [g.id, g.label]);
    for (const id of ['a-b', 'a.b', 'a/b', 'a&b', 'a:b', "a'b", 'a"b']) assert.deepEqual(subs(`${id} [t]`), [[id, 't']]);
    assert.deepEqual(subs('"a(b)" [t]'), [['a(b)', 't']]);
  });

  it('prints such an id quoted, which both readers read back', () => {
    for (const id of ['a(b)', 'a{b}', 'a<b', 'a|b', 'a]b']) {
      const doc = parseMermaid(F('subgraph x [t]\n A\nend'));
      /** @type {any} */ (doc.ast).subgraphs[0].id = id;
      const text = toMermaid(doc);
      assert.equal(text, `flowchart TD\nA\nsubgraph "${id}" [t]\n  A\nend\n`);
      assert.deepEqual(parseMermaid(text).ast, doc.ast);
    }
  });
});
