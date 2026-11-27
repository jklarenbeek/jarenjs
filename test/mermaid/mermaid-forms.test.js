//@ts-check
/**
 * @file More of Mermaid's own syntax-doc forms read as Mermaid reads them;
 * each expected reading was taken from Mermaid's parser on the same input. A
 * quoted flowchart label runs over lines; a node's `@{ shape, label }`
 * metadata sets its shape and label; `subgraph1` is a node, not a subgraph; a
 * class is named without its generic wherever the generic is written; a
 * sequence participant keeps its `type`, and the half-arrow, two-way and
 * central-connection messages read; a state label ends at `;`, and `state X`
 * alone declares nothing; an ER line of names is that many entities, and a
 * relationship needs its `: label`. The printer's text reads back as the
 * same tree.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMermaid, toMermaid, renderMermaid } from '@jarenjs/mermaid';
import { renderToString } from '@jarenjs/view';

/** Print, re-parse, and require the same tree. @param {string} source @returns {string} */
function printsBack(source) {
  const doc = parseMermaid(source);
  const text = toMermaid(doc);
  assert.deepEqual(parseMermaid(text).ast, doc.ast, `drift for ${JSON.stringify(text)}`);
  return text;
}

/** @param {string} source */
const nodes = (source) => parseMermaid(source).ast.nodes.map((/** @type {any} */ n) => [n.id, n.label, n.shape]);

describe('flowchart — a quoted label over lines', () => {
  it('reads a markdown string\'s lines, each trimmed, and prints them as lines', () => {
    const source = 'flowchart LR\n    markdown["`This **is** _Markdown_`"]\n    newLines["`Line1\n    Line 2\n    Line 3`"]\n    markdown --> newLines';
    assert.deepEqual(nodes(source), [['markdown', '`This **is** _Markdown_`', 'rect'], ['newLines', '`Line1\nLine 2\nLine 3`', 'rect']]);
    assert.equal(printsBack(source), 'flowchart LR\nmarkdown["`This **is** _Markdown_`"]\nnewLines["`Line1\nLine 2\nLine 3`"]\nmarkdown --> newLines\n');
  });

  it('reads one in a round node, an edge label, a pipe label and a subgraph title', () => {
    const { ast } = parseMermaid('flowchart LR\nsubgraph s ["`T\n  U`"]\n  a("`The **cat**\n  in the hat`") -- "`x\n  y`" --> b\n  b -->|"p\n  q"| c\nend');
    assert.deepEqual(ast.nodes.map((/** @type {any} */ n) => [n.id, n.label, n.shape]),
      [['a', '`The **cat**\nin the hat`', 'round'], ['b', 'b', 'rect'], ['c', 'c', 'rect']]);
    assert.deepEqual(ast.edges.map((/** @type {any} */ e) => e.label), ['`x\ny`', 'p\nq']);
    assert.deepEqual(ast.subgraphs.map((/** @type {any} */ s) => [s.id, s.label]), [['s', '`T\nU`']]);
  });

  it('reads a plain quoted label over lines with its line break', () => {
    assert.deepEqual(nodes('flowchart LR\n  a["one\n  two"] --> b'), [['a', 'one\ntwo', 'rect'], ['b', 'b', 'rect']]);
  });

  it('refuses a quote inside a label that is not quoted at its line, reads a subgraph title the quote does not open alone, and refuses a quote no line closes at its line', () => {
    // Mermaid refuses `A[He said "hi]`; it was read as the text `He said "hi`
    assert.throws(() => parseMermaid('flowchart LR\n  A[He said "hi]\n  B["x"]'),
      (/** @type {any} */ error) => error.msgid === 'mermaid/flowchart/quote-in-label' && error.line === 2 && error.params.id === 'A');
    // a subgraph title the quote does not open reads alone, as before (its
    // blank leaves it no id, so it is numbered)
    const { ast } = parseMermaid('flowchart LR\n  subgraph 6" pipes\n  a\n  end\n  c[say hi]');
    assert.deepEqual([ast.subgraphs.map((/** @type {any} */ g) => [g.id, g.label, g.nodes]), ast.nodes.map((/** @type {any} */ n) => [n.id, n.label])],
      [[['subGraph0', '6" pipes', ['a']]], [['a', 'a'], ['c', 'say hi']]]);
    assert.throws(() => parseMermaid('flowchart LR\n  a["`never closed\n  b --> c'),
      (/** @type {any} */ error) => error.name === 'MermaidParseError' && error.line === 2);
  });
});

describe('flowchart — a node\'s `@{ … }` metadata', () => {
  it('sets the shape by Mermaid\'s name for it, and the label', () => {
    assert.deepEqual(nodes('flowchart TD\n  A@{ shape: rect, label: "This is a process" }\n  A --> B@{ shape: circle, label: "x" }'),
      [['A', 'This is a process', 'rect'], ['B', 'x', 'circle']]);
    assert.deepEqual(nodes('flowchart TD\n  a@{ shape: diam, label: "a: b" }\n  b@{ shape: "hex", label: "q, r" }\n  c@{ label: plain words }'
      + '\n  d@{ shape: lean-l }\n  e@{ shape: trap-t }\n  f@{ shape: dbl-circ }\n  g@{ shape: fr-rect }\n  h@{ shape: odd }'),
    [['a', 'a: b', 'diamond'], ['b', 'q, r', 'hexagon'], ['c', 'plain words', 'rect'], ['d', 'd', 'parallelogram_alt'],
      ['e', 'e', 'trapezoid_alt'], ['f', 'f', 'doublecircle'], ['g', 'g', 'subroutine'], ['h', 'h', 'asymmetric']]);
  });

  it('reads with the brackets as Mermaid does: the later statement sets what it names', () => {
    assert.deepEqual(nodes('flowchart LR\n  a["x"]@{ shape: diamond }'), [['a', 'x', 'diamond']]);
    assert.deepEqual(nodes('flowchart LR\n  a@{ shape: diamond, label: "m" }\n  a["x"]'), [['a', 'x', 'rect']]);
    assert.deepEqual(nodes('flowchart LR\n  a(round)@{ label: m }'), [['a', 'm', 'round']]);
  });

  it('names a shape with no bracket form by Mermaid\'s short name, draws a Mermaid name this tree has no shape for a rectangle, keeps the shape for an empty name, and an empty label shows the id', () => {
    assert.deepEqual(nodes('flowchart LR\n  a@{ shape: manual-file, label: "File Handling" }\n  b(x)@{ shape: anchor }\n  c@{ label: "" }\n  d(y)@{ shape: }\n  e@{ shape: doublecircle }'),
      [['a', 'File Handling', 'flip-tri'], ['b', 'x', 'rect'], ['c', 'c', 'rect'], ['d', 'y', 'round'], ['e', 'e', 'doublecircle']]);
  });

  it('refuses a shape name Mermaid has not, as Mermaid refuses it, where the node kept its shape', () => {
    for (const shape of ['nope', 'Diamond', 'lean_right', 'square', 'roundedRect', '"nope"']) {
      assert.throws(() => parseMermaid(`flowchart LR\n  a\n  b(x)@{ shape: ${shape} }`),
        (/** @type {any} */ error) => error.msgid === 'mermaid/flowchart/unknown-shape' && error.line === 3
          && error.params.id === 'b' && error.params.shape === shape.replaceAll('"', ''), shape);
    }
  });

  it('prints the shape it read in brackets', () => {
    assert.equal(printsBack('flowchart LR\n  A@{ shape: diamond, label: "Decision" } --> B@{ shape: cyl }'),
      'flowchart LR\nA{Decision}\nB[(B)]\nA --> B\n');
  });
});

describe('flowchart — `subgraph` is a keyword only as a word of its own', () => {
  it('reads `subgraph1` as a node, as Mermaid does', () => {
    const { ast } = parseMermaid('flowchart LR\n  subgraph1 --> b\n  subgraphX');
    assert.deepEqual([ast.nodes.map((/** @type {any} */ n) => n.id), ast.subgraphs], [['subgraph1', 'b', 'subgraphX'], []]);
  });

  it('reads the printed node line of a subgraph linked to by its id back as the same tree', () => {
    const text = printsBack('flowchart LR\n  subgraph subgraph1\n    top1[top] --> bottom1[bottom]\n  end\n  outside --> subgraph1');
    assert.match(text, /^subgraph1\nsubgraph subgraph1 \[subgraph1\]$/m);
    assert.deepEqual(parseMermaid(text).ast.subgraphs.map((/** @type {any} */ s) => s.id), ['subgraph1']);
  });
});

describe('classDiagram — a generic', () => {
  /** @param {string} source */
  const classes = (source) => {
    const { ast } = parseMermaid(source);
    return [ast.classes.map((/** @type {any} */ c) => [c.name, c.generic ?? null]), ast.relations.map((/** @type {any} */ r) => [r.from, r.to])];
  };

  it('names the class without it wherever it is written, and keeps it as `generic`', () => {
    assert.deepEqual(classes('classDiagram\n  class Square~Shape~\n  Square : int id'), [[['Square', 'Shape']], []]);
    assert.deepEqual(classes('classDiagram\n  class Square~Shape~{\n    int id\n  }\n  Square~Shape~ <|-- Rect~T~\n  Square~Shape~ : -List~string~ messages'),
      [[['Square', 'Shape'], ['Rect', 'T']], [['Square', 'Rect']]]);
    const { ast } = parseMermaid('classDiagram\n  class Square~Shape~{\n    int id\n  }\n  Square : -List~string~ messages');
    assert.deepEqual(ast.classes[0].members.map((/** @type {any} */ m) => m.text), ['int id', 'List~string~ messages']);
  });

  it('drops an annotation after the name in the body form too, as Mermaid does', () => {
    assert.deepEqual(classes('classDiagram\n  class Foo <<interface>> {\n    +x\n  }\n  class Bar <<service>>'), [[['Foo', null], ['Bar', null]], []]);
    // a `<` inside a quoted label or a backtick name is text
    const { ast } = parseMermaid('classDiagram\n  class A["x<y"] {\n    +m\n  }\n  class B["p<q"]\n  class `a<b` {\n    +n\n  }');
    assert.deepEqual(ast.classes.map((/** @type {any} */ c) => [c.name, c.label]), [['A', 'x<y'], ['B', 'p<q'], ['a<b', 'a<b']]);
    printsBack('classDiagram\n  class A["x<y"] {\n    +m\n  }');
  });

  it('prints it back after the name and draws it as Mermaid does, a nested one (read only in a backtick-quoted name) nested', () => {
    assert.equal(printsBack('classDiagram\n  class Square~Shape~\n  Map~K,V~ --> List~int~\n  class `Grid~List~int~~`'),
      'classDiagram\nclass Square~Shape~\nclass Map~K,V~\nclass List~int~\nclass `Grid~List~int~~`\nMap --> List\n');
    const svg = renderToString(renderMermaid('classDiagram\n  class Square~Shape~\n  class Map~K,V~\n  class `Grid~List~int~~`'));
    assert.ok(svg.includes('Square&lt;Shape&gt;') && svg.includes('Map&lt;K,V&gt;') && svg.includes('Grid&lt;List&lt;int&gt;&gt;'), svg);
  });
});

describe('sequenceDiagram — participant types and the other arrows', () => {
  it('keeps a participant\'s type, an `actor` type drawing an actor', () => {
    const { ast } = parseMermaid('sequenceDiagram\n  participant API@{ "type": "boundary" } as Public API\n  actor DB@{ "type": "database" } as User Database'
      + '\n  participant A@{ "type": "actor" }\n  API->>DB: q');
    assert.deepEqual(ast.participants, [
      { id: 'API', label: 'Public API', kind: 'participant', type: 'boundary' },
      { id: 'DB', label: 'User Database', kind: 'participant', type: 'database' },
      { id: 'A', label: 'A', kind: 'actor' },
    ]);
    assert.match(printsBack('sequenceDiagram\n  participant API@{ "type": "boundary" } as Public API'),
      /^participant API@\{ "type": "boundary" \} as Public API$/m);
  });

  it('reads the half arrows, the two-way arrows and the central-connection marks, and prints each back', () => {
    const source = 'sequenceDiagram\n  A-|\\B: a\n  A-|/B: b\n  A-\\\\B: c\n  A-//B: d\n  A/|-B: e\n  A\\|-B: f\n  A//-B: g\n  A\\\\-B: h'
      + '\n  A--|\\B: i\n  A//--B: j\n  A<<->>B: k\n  A<<-->>B: l\n  A()->>()B: m\n  A->>()B: n\n  A()-->>B: o';
    const { ast } = parseMermaid(source);
    assert.deepEqual(ast.statements.map((/** @type {any} */ m) => [m.text, m.line, m.head, m.central ?? null]), [
      ['a', 'solid', 'half-top', null], ['b', 'solid', 'half-bottom', null], ['c', 'solid', 'stick-top', null],
      ['d', 'solid', 'stick-bottom', null], ['e', 'solid', 'half-top-reverse', null], ['f', 'solid', 'half-bottom-reverse', null],
      ['g', 'solid', 'stick-top-reverse', null], ['h', 'solid', 'stick-bottom-reverse', null], ['i', 'dotted', 'half-top', null],
      ['j', 'dotted', 'stick-top-reverse', null], ['k', 'solid', 'both', null], ['l', 'dotted', 'both', null],
      ['m', 'solid', 'arrow', 'both'], ['n', 'solid', 'arrow', 'to'], ['o', 'dotted', 'arrow', 'from'],
    ]);
    assert.deepEqual(ast.participants.map((/** @type {any} */ p) => p.id), ['A', 'B']);
    const text = printsBack(source);
    assert.deepEqual(text.split('\n').slice(3, -1), ['A-|\\B: a', 'A-|/B: b', 'A-\\\\B: c', 'A-//B: d', 'A/|-B: e', 'A\\|-B: f',
      'A//-B: g', 'A\\\\-B: h', 'A--|\\B: i', 'A//--B: j', 'A<<->>B: k', 'A<<-->>B: l', 'A()->>()B: m', 'A->>()B: n', 'A()-->>B: o']);
  });

  it('reads `create` as a declaration and `destroy` as no statement', () => {
    const { ast } = parseMermaid('sequenceDiagram\n  Alice->>Bob: hi\n  create actor D as Donald\n  Bob->>D: yo\n  destroy D\n  D->>Alice: bye');
    assert.deepEqual([ast.participants.map((/** @type {any} */ p) => [p.id, p.label, p.kind]), ast.statements.length],
      [[['Alice', 'Alice', 'participant'], ['Bob', 'Bob', 'participant'], ['D', 'Donald', 'actor']], 3]);
  });
});

describe('stateDiagram — a label\'s `;`, and `state X` alone', () => {
  /** @param {string} source */
  const read = (source) => {
    const { ast } = parseMermaid(source);
    return [ast.states.map((/** @type {any} */ s) => [s.id, s.label]), ast.transitions.map((/** @type {any} */ t) => [t.from, t.to, t.label])];
  };

  it('ends a transition label and a description at `;`, and reads what follows', () => {
    assert.deepEqual(read('stateDiagram-v2\n  A --> B : x;\n  B --> C : y'), [[['A', 'A'], ['B', 'B'], ['C', 'C']], [['A', 'B', 'x'], ['B', 'C', 'y']]]);
    assert.deepEqual(read('stateDiagram-v2\n  S : desc;\n  S : a; b'), [[['S', 'a'], ['b', 'b']], []]);
    assert.deepEqual(read('stateDiagram-v2\n  A --> B : x#59; y\n  state "a;b" as X\n  classDef c fill:red;color:white\n  accTitle: a; b'),
      [[['A', 'A'], ['B', 'B'], ['X', 'a;b']], [['A', 'B', 'x#59; y']]]);
  });

  it('reads several names on a line as states, and a keyword line as its keyword', () => {
    assert.deepEqual(read('stateDiagram-v2\n  y z\n  direction LR\n  hide empty description'), [[['y', 'y'], ['z', 'z']], []]);
  });

  it('reads `state X` with nothing after it as no state, and `state X <<choice>>` as one', () => {
    assert.deepEqual(read('stateDiagram-v2\n  state X\n  state Y:::c\n  state C <<choice>>\n  A --> B'),
      [[['C', 'C'], ['A', 'A'], ['B', 'B']], [['A', 'B', null]]]);
  });

  it('prints a keyword-named state and a label holding a `;` in the quoted form', () => {
    assert.equal(printsBack('stateDiagram-v2\n  state "end" as end\n  state "a;b" as X\n  A --> B'),
      'stateDiagram-v2\nstate "end" as end\nstate "a;b" as X\nA --> B\n');
  });
});

describe('erDiagram — names, and relationships', () => {
  /** @param {string} source */
  const read = (source) => {
    const { ast } = parseMermaid(source);
    return [ast.entities.map((/** @type {any} */ e) => e.name), ast.relationships.map((/** @type {any} */ r) => [r.left, r.leftCard, r.rightCard, r.right, r.label])];
  };

  it('reads a line of names as that many entities, `o--o` among them', () => {
    assert.deepEqual(read('erDiagram\n  A o--o B\n  C "D e" F'), [['A', 'o--o', 'B', 'C', 'D e', 'F'], []]);
    assert.deepEqual(read('erDiagram\n  direction LR\n  A ||--o{ B : x'), [['A', 'B'], [['A', '||', 'o{', 'B', 'x']]]);
    printsBack('erDiagram\n  A o--o B');
  });

  it('reads a cardinality symbol on either end', () => {
    assert.deepEqual(read('erDiagram\n  A o{--|| B : x\n  C }|..|{ D : y'), [['A', 'B', 'C', 'D'], [['A', 'o{', '||', 'B', 'x'], ['C', '}|', '|{', 'D', 'y']]]);
  });
});
