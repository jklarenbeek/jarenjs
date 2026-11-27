//@ts-check
/**
 * Quotes, subgraph headers and state braces as Mermaid reads them: what
 * `toMermaid` prints for a label holding a `"` (Mermaid reads a `"` in no
 * label, so the quote prints as its entity code), each line Mermaid refuses
 * refused with its own message, and the shapes beside each refusal that read
 * as they did.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMermaid, toMermaid, renderMermaid } from '@jarenjs/mermaid';
import { mermaidPieRenderer } from '@jarenjs/charts/transforms/mermaid-adapter';
import { renderToString } from '@jarenjs/view';
import { decodeEntityCodes } from '../../components/mermaid/src/label-text.js';

const ast = (/** @type {string} */ source) => /** @type {any} */ (parseMermaid(source).ast);
const F = (/** @type {string} */ body) => `flowchart LR\n  ${body}`;

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

/**
 * Print a tree, check that it reads back with each label spelled as the
 * printed codes (drawn as the label) and that the print is a fixed point.
 * @param {any} doc
 * @param {(ast: any) => string[]} labelsOf
 * @returns {string[]} the printed lines after the header
 */
function printed(doc, labelsOf) {
  const text = toMermaid(doc);
  const again = parseMermaid(text);
  assert.deepEqual(labelsOf(again.ast).map(decodeEntityCodes), labelsOf(doc.ast), text);
  assert.equal(toMermaid(again), text, 'a fixed point after one print');
  return text.split('\n').slice(1, -1);
}

describe('toMermaid — a label holding a `"`', () => {
  const flow = () => parseMermaid(F('A[x] -->|y| B\n  subgraph s1 [t]\n    A\n  end'));
  const flowLabels = (/** @type {any} */ a) => [a.nodes[0].label, a.edges[0].label, a.subgraphs[0].label];

  it('prints the quote as its code `#34;` in `"…"`, for a node, a link and a subgraph title (it printed `\'…\'`, which Mermaid refuses)', () => {
    const doc = flow();
    doc.ast.nodes[0].label = 'He said "Hi"';
    doc.ast.edges[0].label = 'a"b';
    doc.ast.subgraphs[0].label = '"t"';
    assert.deepEqual(printed(doc, flowLabels),
      ['A["He said #34;Hi#34;"]', 'B', 'subgraph s1 ["#34;t#34;"]', '  A', 'end', 'A -->|"a#34;b"| B']);
    assert.deepEqual(flowLabels(ast(toMermaid(doc))), ['He said #34;Hi#34;', 'a#34;b', '#34;t#34;']);
    doc.ast.nodes[0].shape = 'round';
    doc.ast.nodes[0].label = 'a"b\'c';
    assert.equal(printed(doc, flowLabels)[0], 'A("a#34;b\'c")');
  });

  it('quotes a link label or a title holding a bracket, which Mermaid refuses bare', () => {
    const doc = flow();
    doc.ast.edges[0].label = 'imports (one way)';
    doc.ast.subgraphs[0].label = 'Core Module (index.js)';
    assert.deepEqual(printed(doc, flowLabels),
      ['A[x]', 'B', 'subgraph s1 ["Core Module (index.js)"]', '  A', 'end', 'A -->|"imports (one way)"| B']);
  });

  it('prints a label holding a link and its closer whole in its quotes, which reads back as it is', () => {
    const doc = flow();
    doc.ast.nodes[0].label = 'a --> b]';
    doc.ast.edges[0].label = 'a --> b|c';
    const text = toMermaid(doc);
    assert.deepEqual(text.split('\n').filter((l) => l.startsWith('A')), ['A["a --> b]"]', 'A -->|"a --> b|c"| B']);
    assert.deepEqual(parseMermaid(text).ast, doc.ast);
  });

  it('prints the quote as its code in every quoted ER and class field', () => {
    const er = parseMermaid('erDiagram\n  "A B"["al x"] {\n    string name PK "c"\n  }\n  "A B" ||--o{ C : "has x"');
    Object.assign(er.ast.entities[0], { alias: 'a"b' });
    er.ast.entities[0].attributes[0].comment = '"c"';
    er.ast.relationships[0].label = 'say"hi';
    er.ast.entities[1].name = 'q"r';
    er.ast.relationships[0].right = 'q"r';
    assert.deepEqual(printed(er, (a) => [a.entities[0].alias, a.entities[0].attributes[0].comment, a.relationships[0].label, a.entities[1].name]),
      ['"A B"["a#34;b"] {', '  string name PK "#34;c#34;"', '}', '"q#34;r"', '"A B" ||--o{ "q#34;r" : "say#34;hi"']);
    const cls = parseMermaid('classDiagram\n  class A["Lab x"]\n  A "1" --> "*" B');
    cls.ast.classes[0].label = 'a"b';
    cls.ast.relations[0].fromCardinality = '"1"';
    assert.deepEqual(printed(cls, (a) => [a.classes[0].label, a.relations[0].fromCardinality]),
      ['class A["a#34;b"]', 'class B', 'A "#34;1#34;" --> "*" B']);
  });
});

describe('flowchart — a subgraph header Mermaid refuses', () => {
  it('refuses an empty title, where it read as one', () => {
    refuses(F('subgraph s []\n    a\n  end'), 'mermaid/flowchart/subgraph-empty-title', 2, {});
    refuses(F('subgraph s [""]\n    a\n  end'), 'mermaid/flowchart/subgraph-empty-title', 2, {});
    refuses(F('subgraph ""\n    a\n  end'), 'mermaid/flowchart/subgraph-empty-title', 2, {});
  });

  it('still reads the empty titles Mermaid reads: a blank in the brackets, and `""` with a blank after it (untitled, numbered)', () => {
    const subs = (/** @type {string} */ s) => ast(s).subgraphs.map((/** @type {any} */ g) => [g.id, g.label, g.nodes]);
    assert.deepEqual(subs(F('subgraph s [ ]\n    a\n  end')), [['s', '', ['a']]]);
    assert.deepEqual(subs(F('subgraph s ["" ]\n    a\n  end')), [['s', '', ['a']]]);
    // it read as a subgraph with the id ''
    assert.deepEqual(subs(F('subgraph "" \n    a\n  end')), [['subGraph0', '', ['a']]]);
  });

  it('refuses a bare `subgraph` after a `;` as on a line of its own, and still reads one with a name or two blanks', () => {
    refuses(F('a --> b; subgraph\n    c\n  end'), 'mermaid/flowchart/subgraph-unnamed', 2, {});
    refuses(F('a --> b; subgraph \n    c\n  end'), 'mermaid/flowchart/subgraph-unnamed', 2, {});
    const subs = (/** @type {string} */ s) => ast(s).subgraphs.map((/** @type {any} */ g) => [g.id, g.nodes]);
    assert.deepEqual(subs(F('a --> b; subgraph  \n    c\n  end')), [['subGraph0', ['c']]]);
    assert.deepEqual(subs(F('a; subgraph s\n    c\n  end')), [['s', ['c']]]);
  });

  it('refuses a subgraph no `end` closes at the line that opens it, where it was closed at the end', () => {
    refuses(F('subgraph s\n    a'), 'mermaid/flowchart/subgraph-unclosed', 2, { id: 's' });
    refuses(F('subgraph s\n    a\n  subgraph t\n    b\n  end'), 'mermaid/flowchart/subgraph-unclosed', 2, { id: 's' });
    refuses(F('subgraph "two words"\n    a'), 'mermaid/flowchart/subgraph-unclosed', 2, { id: 'two words' });
  });

  it('refuses a `"` in a bracketed title outside its quoted unit, and still reads a quoted one, a bare title as written, an empty `""` (dropped in brackets) and a code', () => {
    for (const title of ['say "x"', '\'x"y\'', 'a"b"', 'x "y" z', '"a"b"c"']) {
      refuses(F(`subgraph s [${title}]\n    a\n  end`), 'mermaid/flowchart/quote-in-title', 2, {});
    }
    const subs = (/** @type {string} */ s) => ast(s).subgraphs.map((/** @type {any} */ g) => [g.id, g.label]);
    assert.deepEqual(subs(F('subgraph s [a""b]\n    x\n  end')), [['s', 'ab']]);
    assert.deepEqual(subs(F('subgraph s ["a"b]\n    x\n  end')), [['s', 'ab']]);
    // a bare title is read as written, quotes and all, as Mermaid reads it
    assert.deepEqual(subs(F('subgraph a""b\n    x\n  end')), [['a""b', 'a""b']]);
    assert.deepEqual(subs(F('subgraph a"b\n    x\n  end')), [['a"b', 'a"b']]);
    assert.deepEqual(subs(F('subgraph a"b"\n    x\n  end')), [['a"b"', 'a"b"']]);
    assert.deepEqual(subs(F('subgraph s1 ["x"]\n    a\n  end')), [['s1', 'x']]);
    assert.deepEqual(subs(F('subgraph s ["say #34;x#34;"]\n    a\n  end')), [['s', 'say #34;x#34;']]);
  });
});

describe('flowchart — quotes in a label as Mermaid reads them', () => {
  const labels = (/** @type {string} */ s) => ast(s).nodes.map((/** @type {any} */ n) => [n.id, n.label]);
  const links = (/** @type {string} */ s) => ast(s).edges.map((/** @type {any} */ e) => [e.from, e.to, e.label]);

  it('refuses a `"` in a link label that opens with no quote, as Mermaid refuses it, where it was read as text', () => {
    for (const body of ['A -- a"b --> B', 'A -->|a"b| B', 'A ==>|a"b| B', 'A -. a"b .-> B', 'A -->|a "b" c| B', 'A -->|a"| B',
      'A -- a" --> B', 'A -->|\'x"y\'| B', 'A -- a "b" --> B', 'A -->|a"b"| B', 'A -->|"a"b"c"| B']) {
      refuses(F(body), 'mermaid/flowchart/quote-in-link-label', 2, { from: 'A' });
    }
    refuses(F('A & C -->|a"b| B'), 'mermaid/flowchart/quote-in-link-label', 2, { from: 'A & C' });
  });

  it('still reads the link labels Mermaid reads, an empty `""` dropped and a quoted unit joined to the text after it', () => {
    assert.deepEqual(links(F('A -->|a""b| B')), [['A', 'B', 'ab']]);
    assert.deepEqual(links(F('A -- a""b --> B')), [['A', 'B', 'ab']]);
    assert.deepEqual(links(F('A -->|"a"| B')), [['A', 'B', 'a']]);
    assert.deepEqual(links(F('A -- "a" --> B')), [['A', 'B', 'a']]);
    assert.deepEqual(links(F('A -->|it\'s| B')), [['A', 'B', 'it\'s']]);
    assert.deepEqual(links(F('A -->|"a"b| B')), [['A', 'B', 'ab']]);
    assert.deepEqual(links(F('A -->|say #34;x#34;| B')), [['A', 'B', 'say #34;x#34;']]);
  });

  it('refuses a `"` in a label in `\'…\'`, no quoting to Mermaid (it read as the label inside), and a second quoted unit', () => {
    refuses(F('A[\'He said "Hi"\']'), 'mermaid/flowchart/quote-in-label', 2, { id: 'A' });
    refuses(F('A(\'x"y\')'), 'mermaid/flowchart/quote-in-label', 2, { id: 'A' });
    // the old printer's spelling of a label holding both quote kinds; it read as `a"b"c'd`
    for (const label of ['"a"b"c\'d"', '"a"b"c"', '"a" "b"', '""a"b"']) {
      refuses(F(`A[${label}]`), 'mermaid/flowchart/quote-in-label', 2, { id: 'A' });
    }
  });

  it('refuses a quote that opens a label and nothing closes, in every shape', () => {
    for (const body of ['A["x]', 'A("x)', 'A{"x}', 'A["x]\n  B', 'A["x] --> B']) {
      refuses(F(body), 'mermaid/flowchart/quote-unclosed', 2, { id: 'A' });
    }
  });

  it('drops an empty `""` from a label that opens with no quote, and joins quoted units, as Mermaid reads them', () => {
    assert.deepEqual(labels(F('A[a""b]')), [['A', 'ab']]);
    assert.deepEqual(labels(F('A[a""]')), [['A', 'a']]);
    assert.deepEqual(labels(F('A(a""b)')), [['A', 'ab']]);
    assert.deepEqual(labels(F('A[a""b""c]')), [['A', 'abc']]);
    assert.deepEqual(labels(F('A[""a""]')), [['A', 'a']]);
    assert.deepEqual(labels(F('A["x"y]')), [['A', 'xy']]);
    assert.deepEqual(labels(F('A["a"b""]')), [['A', 'ab']]);
    assert.deepEqual(labels(F('A["\'x\'"]')), [['A', '\'x\'']]);
  });

  it('still reads a label in `\'…\'` without its quotes, where Mermaid keeps them as text', () => {
    assert.deepEqual(labels(F('A[\'x\']')), [['A', 'x']]);
  });
});

describe('stateDiagram — a `{` Mermaid refuses', () => {
  const states = (/** @type {string} */ s) => ast(s).states.map((/** @type {any} */ x) => [x.id, x.parent ?? null]);

  it('refuses a `{` that follows no `state X`, where it was read as a state `{`', () => {
    refuses('stateDiagram-v2\n  {\n    a --> b\n  }', 'mermaid/state/brace-unopened', 2, {});
    refuses('stateDiagram-v2\n  a --> b\n  {\n    c\n  }', 'mermaid/state/brace-unopened', 3, {});
    refuses('stateDiagram-v2\n  state X <<choice>>\n  {\n    a --> b\n  }', 'mermaid/state/brace-unopened', 3, {});
  });

  it('refuses the `{` of a choice, fork or join, which holds no states', () => {
    refuses('stateDiagram-v2\n  state X <<choice>> {\n    a --> b\n  }', 'mermaid/state/stereotype-composite', 2, { id: 'X', kind: 'choice' });
    refuses('stateDiagram-v2\n  state F <<fork>> {\n  }', 'mermaid/state/stereotype-composite', 2, { id: 'F', kind: 'fork' });
  });

  it('still reads a composite opened on its line or the next, past a comment, and a choice with no braces', () => {
    assert.deepEqual(states('stateDiagram-v2\n  state X {\n    a --> b\n  }'), [['X', null], ['a', 'X'], ['b', 'X']]);
    assert.deepEqual(states('stateDiagram-v2\n  state X\n  {\n    a --> b\n  }'), [['X', null], ['a', 'X'], ['b', 'X']]);
    assert.deepEqual(states('stateDiagram-v2\n  state X\n  %% c\n  {\n    a --> b\n  }'), [['X', null], ['a', 'X'], ['b', 'X']]);
    assert.deepEqual(states('stateDiagram-v2\n  state X <<choice>>\n  X --> a'), [['X', null], ['a', null]]);
  });
});

describe('pie — a `"` inside a label in `"…"`', () => {
  it('is refused, as Mermaid refuses it, where the label ran to the last `"` of its line', () => {
    for (const line of ['"a"b" : 1', '"a" : 1 "b" : 2', '"a""b" : 1', '"a" "b" : 1']) {
      refuses(`pie\n  ${line}`, 'mermaid/pie/line', 2, { line });
    }
  });

  it('reads an entity code in a slice label as the character Mermaid draws (it kept the code, which the pie drew as written)', () => {
    assert.deepEqual(ast('pie\n  "a\'b#34;c" : 1\n  "#35;" : 2\n  "x #quot; y" : 3\n  "#9829;" : 4\n  "a#amp;b" : 5').slices.map((/** @type {any} */ x) => x.label),
      ['a\'b"c', '#', 'x " y', '♥', 'a&b']);
    const svg = renderToString(renderMermaid('pie\n  "a\'b#34;c" : 1\n  "z" : 2', { renderers: { pie: mermaidPieRenderer } }));
    assert.ok(!svg.includes('#34;') && svg.includes('>a\'b"c ('), svg);
  });

  it('prints a label holding both quote kinds, or a code\'s spelling, so it reads back as itself and draws it', () => {
    const tree = { diagram: 'pie', title: null, showData: false, slices: [{ label: 'a\'b"c', value: 1 }, { label: '#nope; #35;', value: 2 }] };
    const text = toMermaid(tree);
    assert.equal(text, 'pie\n"a\'b#34;c" : 1\n"#35;nope; #35;35;" : 2\n');
    assert.deepEqual(ast(text).slices, tree.slices);
    assert.equal(toMermaid({ ...tree, slices: ast(text).slices }), text);
    const svg = renderToString(renderMermaid(text, { renderers: { pie: mermaidPieRenderer } }));
    assert.ok(!svg.includes('#34;') && svg.includes('>a\'b"c ('), svg);
  });

  it('still reads a `"` in `\'…\'`, a `\'` in `"…"` and an empty label', () => {
    assert.deepEqual(ast('pie\n  \'a"b\' : 1\n  "a\'b" : 2\n  "" : 3').slices,
      [{ label: 'a"b', value: 1 }, { label: 'a\'b', value: 2 }, { label: '', value: 3 }]);
  });
});
