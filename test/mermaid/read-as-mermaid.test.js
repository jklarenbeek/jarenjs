//@ts-check
/**
 * @file Forms of Mermaid's own syntax read as Mermaid reads them, and lines
 * Mermaid refuses refused; every expectation not marked otherwise was taken
 * from Mermaid's parser on the same input. A class body's `<<annotation>>` line is no member; a
 * subgraph inside another is a member of it, printed inside it; a subgraph
 * titled without an id of its own is named by its title (a quoted markdown
 * title without its backticks), or numbered when the title holds a blank; a
 * composite state's `{` may open the next line; a Gantt directive's word may
 * end at a tab; a pie's accessibility lines are no slices. Refused: a `"`
 * inside a node label that is not quoted, a bare `subgraph` line, a nested
 * generic in a class name, and a pie line that is no slice, title or
 * accessibility line.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMermaid, toMermaid } from '@jarenjs/mermaid';

/** Print, re-parse, and require the same tree. @param {string} source @returns {string} */
function printsBack(source) {
  const doc = parseMermaid(source);
  const text = toMermaid(doc);
  assert.deepEqual(parseMermaid(text).ast, doc.ast, `drift for ${JSON.stringify(text)}`);
  return text;
}

/** @param {string} source */
const ast = (source) => /** @type {any} */ (parseMermaid(source).ast);

/** @param {string} source @returns {[string, string, string[]][]} */
const subgraphs = (source) => ast(source).subgraphs.map((/** @type {any} */ g) => [g.id, g.label, g.nodes]);

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

describe('classDiagram — an annotation line in a class body', () => {
  it('is no member but the class\'s annotation, as Mermaid reads it', () => {
    const { classes } = ast('classDiagram\nclass Color{\n  <<enumeration>>\n  RED\n  GREEN\n}\nclass Shape{\n    <<interface>>\n    noOfVertices\n    draw()\n}');
    assert.deepEqual(classes.map((/** @type {any} */ c) => [c.name, c.members.map((/** @type {any} */ m) => [m.kind, m.text])]),
      [['Color', [['attribute', 'RED'], ['attribute', 'GREEN']]], ['Shape', [['attribute', 'noOfVertices'], ['method', 'draw()']]]]);
    assert.deepEqual(classes.map((/** @type {any} */ c) => c.annotations), [['enumeration'], ['interface']]);
    assert.equal(printsBack('classDiagram\nclass Color{\n  <<enumeration>>\n  RED\n}'), 'classDiagram\nclass Color {\n  <<enumeration>>\n  RED\n}\n');
  });
});

describe('flowchart — a subgraph inside another', () => {
  it('is a member of the subgraph around it, at any depth', () => {
    assert.deepEqual(subgraphs('flowchart TB\n  subgraph one\n    a1-->a2\n    subgraph two\n      b1-->b2\n    end\n  end'),
      [['two', 'two', ['b1', 'b2']], ['one', 'one', ['a1', 'a2', 'two']]]);
    assert.deepEqual(subgraphs('flowchart TB\n  subgraph A\n    subgraph B\n      subgraph C\n        c\n      end\n    end\n    x\n  end'),
      [['C', 'C', ['c']], ['B', 'B', ['C']], ['A', 'A', ['B', 'x']]]);
    // one left open is refused, as Mermaid refuses it (it was closed at the
    // end of the diagram)
    refuses('flowchart TB\n  subgraph one\n    subgraph two\n      b', 'mermaid/flowchart/subgraph-unclosed', 3, { id: 'two' });
  });

  it('prints inside the subgraph around it, and reads back as the same tree', () => {
    assert.equal(printsBack('flowchart TB\n  subgraph one\n    a1-->a2\n    subgraph two\n      b1-->b2\n    end\n  end\n  x --> two'),
      'flowchart TB\na1\na2\nb1\nb2\nx\ntwo\nsubgraph one [one]\n  a1\n  a2\n  subgraph two [two]\n    b1\n    b2\n  end\nend\na1 --> a2\nb1 --> b2\nx --> two\n');
    printsBack('flowchart TB\n  subgraph A\n    subgraph B\n      subgraph C\n        c\n      end\n    end\n    x\n  end');
  });

  it('still reads a subgraph named on a line of another as a node and a member, as Mermaid does', () => {
    const tree = ast('flowchart TB\n  subgraph two\n    b1\n  end\n  subgraph one\n    a1\n    two\n  end');
    assert.deepEqual([tree.nodes.map((/** @type {any} */ n) => n.id), tree.subgraphs.map((/** @type {any} */ g) => [g.id, g.nodes])],
      [['b1', 'a1', 'two'], [['two', ['b1']], ['one', ['a1', 'two']]]]);
  });
});

describe('flowchart — a subgraph titled without an id of its own', () => {
  it('is named by a quoted markdown title without its backticks', () => {
    assert.deepEqual(subgraphs('flowchart LR\n  subgraph "`**Two**`"\n    c2["`Shape**s**`"]\n  end'), [['**Two**', '`**Two**`', ['c2']]]);
    // a title in brackets beside an id keeps the id
    assert.deepEqual(subgraphs('flowchart LR\n  subgraph s1 ["`**T**`"]\n    c2\n  end'), [['s1', '`**T**`', ['c2']]]);
  });

  it('is numbered in the order subgraphs finish when its title holds a blank, as Mermaid numbers it', () => {
    assert.deepEqual(subgraphs('flowchart LR\n  subgraph "x y"\n    subgraph "p q"\n      a\n    end\n    subgraph s1\n      b\n    end\n  end\n  subgraph m n\n    c\n  end'),
      [['subGraph0', 'p q', ['a']], ['s1', 's1', ['b']], ['subGraph2', 'x y', ['subGraph0', 's1']], ['subGraph3', 'm n', ['c']]]);
    assert.deepEqual(subgraphs('flowchart LR\n  subgraph "`two words`"\n    c\n  end'), [['subGraph0', '`two words`', ['c']]]);
    // two blanks after the keyword read as an untitled subgraph
    assert.deepEqual(subgraphs('flowchart LR\n  subgraph  \n    a\n  end'), [['subGraph0', '', ['a']]]);
    assert.equal(printsBack('flowchart LR\n  subgraph "x y"\n    a\n  end'), 'flowchart LR\na\nsubgraph subGraph0 [x y]\n  a\nend\n');
  });
});

describe('stateDiagram — a composite state whose `{` opens a later line', () => {
  it('opens the state, as `state X {` does', () => {
    const tree = ast('stateDiagram-v2\n  state X\n  {\n    a --> b\n  }\n  c');
    assert.deepEqual([tree.states, tree.transitions.map((/** @type {any} */ t) => [t.from, t.to, t.parent])],
      [[{ id: 'X', label: 'X' }, { id: 'a', label: 'a', parent: 'X' }, { id: 'b', label: 'b', parent: 'X' }, { id: 'c', label: 'c' }], [['a', 'b', 'X']]]);
    // past a comment line, with a statement after the brace, and named by `state "…" as X`
    for (const source of ['stateDiagram-v2\n  state X\n  %% c\n  {\n    a\n  }', 'stateDiagram-v2\n  state X\n  { a\n  }']) {
      assert.deepEqual(ast(source).states, [{ id: 'X', label: 'X' }, { id: 'a', label: 'a', parent: 'X' }], source);
    }
    assert.deepEqual(ast('stateDiagram-v2\n  state "Long" as X\n  {\n    a\n  }').states, [{ id: 'X', label: 'Long' }, { id: 'a', label: 'a', parent: 'X' }]);
  });

  it('names the state of `state "…" as X {` X, where it was named by its description', () => {
    assert.deepEqual(ast('stateDiagram-v2\n  state "Long" as X {\n    a\n  }').states, [{ id: 'X', label: 'Long' }, { id: 'a', label: 'a', parent: 'X' }]);
  });
});

describe('gantt — a directive whose word ends at a tab', () => {
  it('reads as the directive, as Mermaid reads it', () => {
    const tree = ast('gantt\n  title\tPlan\n  dateFormat\tYYYY-MM-DD\n  axisFormat\t%d/%m\n  excludes\tweekends\n  todayMarker\toff\n  section\tS1\n  A :a1, 2024-01-01, 3d');
    assert.deepEqual(tree.meta, { title: 'Plan', dateFormat: 'YYYY-MM-DD', axisFormat: '%d/%m', excludes: 'weekends', todayMarker: 'off' });
    assert.deepEqual(tree.sections.map((/** @type {any} */ s) => [s.name, s.tasks.map((/** @type {any} */ t) => t.name)]), [['S1', ['A']]]);
  });
});

describe('pie — accessibility lines', () => {
  it('are no slices, whatever they hold, as Mermaid reads them', () => {
    const tree = ast('pie\n  accTitle: 2024\n  accTitle : 5\n  accDescr: 7\n  accDescr {\n  Revenue : 5\n  }\n  "z" : 2');
    assert.deepEqual(tree.slices, [{ label: 'z', value: 2 }]);
  });
});

describe('flowchart — a quote inside a node label that is not quoted', () => {
  it('is refused, as Mermaid refuses it, where it was read as text', () => {
    refuses('flowchart LR\n  A[He said "hi]', 'mermaid/flowchart/quote-in-label', 2, { id: 'A' });
    refuses('flowchart LR\n  A[x "y" z]', 'mermaid/flowchart/quote-in-label', 2, { id: 'A' });
    refuses('flowchart LR\n  A(x"y)', 'mermaid/flowchart/quote-in-label', 2, { id: 'A' });
    refuses('flowchart LR\n  A[x] --> B[y"z]', 'mermaid/flowchart/quote-in-label', 2, { id: 'B' });
  });

  it('still reads the shapes that read before: an empty `""` (dropped, as Mermaid drops it), a quote as its code, and a quote closed in a later bracket (one label, as Mermaid reads it)', () => {
    const labels = (/** @type {string} */ source) => ast(source).nodes.map((/** @type {any} */ n) => [n.id, n.label]);
    assert.deepEqual(labels('flowchart LR\n  A[a""b]'), [['A', 'ab']]);
    assert.deepEqual(labels('flowchart LR\n  A["He said #34;Hi#34;"]'), [['A', 'He said #34;Hi#34;']]);
    assert.deepEqual(labels('flowchart LR\n  A["x] --> B[y"]'), [['A', 'x] --> B[y']]);
    assert.deepEqual(labels('flowchart LR\n  A[He said &quot;hi]'), [['A', 'He said &quot;hi']]);
  });
});

describe('flowchart — a bare `subgraph` line', () => {
  it('is refused, as Mermaid refuses it, where it read as a subgraph named `sub`', () => {
    refuses('flowchart LR\n  subgraph\n    a\n  end', 'mermaid/flowchart/subgraph-unnamed', 2, {});
    refuses('flowchart LR\n  subgraph s\n    subgraph \n      a\n    end\n  end', 'mermaid/flowchart/subgraph-unnamed', 3, {});
    refuses('flowchart LR\n  subgraph\t\n    a\n  end', 'mermaid/flowchart/subgraph-unnamed', 2, {});
  });
});

describe('classDiagram — a nested generic in a class name', () => {
  it('is refused wherever a name is written, as Mermaid refuses it', () => {
    const name = { name: 'List~List~int~~' };
    refuses('classDiagram\nclass List~List~int~~', 'mermaid/class/nested-generic', 2, name);
    refuses('classDiagram\nclass List~List~int~~ {\n  +int x\n}', 'mermaid/class/nested-generic', 2, name);
    refuses('classDiagram\nA <|-- B\nList~List~int~~ <|-- B', 'mermaid/class/nested-generic', 3, name);
    refuses('classDiagram\nList~List~int~~ : +x', 'mermaid/class/nested-generic', 2, name);
    refuses('classDiagram\nclass A~B~C~', 'mermaid/class/nested-generic', 2, { name: 'A~B~C~' });
  });

  it('still reads one in a member\'s type, a one-level generic and a backtick-quoted name', () => {
    const classes = (/** @type {string} */ source) => ast(source).classes.map((/** @type {any} */ c) => [c.name, c.generic ?? null, c.members.length]);
    // a backtick-quoted name keeps the first two parts its `~`s split it into, as Mermaid does
    assert.deepEqual(classes('classDiagram\nclass A {\n  +List~List~int~~ items\n}\nB : +List~List~int~~ items\nclass Map~K,V~\nclass `Grid~List~int~~`'),
      [['A', null, 1], ['B', null, 1], ['Map', 'K,V', 0], ['Grid', 'List', 0]]);
    // a run of `~` Mermaid reads (as a class `AB`) is no nested generic
    assert.deepEqual(classes('classDiagram\nclass A~~B~~'), [['AB', null, 0]]);
  });
});

describe('pie — a line that is no slice, title or accessibility line', () => {
  it('is refused at its line, as Mermaid refuses it, where it was read as a slice or dropped', () => {
    for (const line of ['Dogs : 1', 'a b : 1', '"a" : -1', '"a" : .5', '"a" : 01', '"a" : 1e3', 'hello', 'showData', '"a" : 1;']) {
      refuses(`pie\n  "z" : 2\n  ${line}`, 'mermaid/pie/line', 3, { line });
    }
  });

  it('prints a label holding a `"` in `\'…\'`, which Mermaid reads, one holding both kinds with the `"` as its code, and reads every printed label back as itself', () => {
    const tree = { diagram: 'pie', title: null, showData: false,
      slices: [{ label: 'a"b', value: 1 }, { label: "it's", value: 2 }, { label: 'both "x" it\'s', value: 3 }] };
    const text = toMermaid(tree);
    // Mermaid has no escape inside quotes: a label holding both quote kinds
    // prints its `"` as the code, which reads back as the quote it draws
    assert.equal(text, 'pie\n\'a"b\' : 1\n"it\'s" : 2\n"both #34;x#34; it\'s" : 3\n');
    assert.deepEqual(ast(text).slices, tree.slices);
  });

  it('still reads every slice Mermaid reads', () => {
    const tree = ast('pie title Pets\n  "Dogs" : 386\n  \'Cats\' : 85\n  "a b" : 0\n  "a:b" : 1.5\n  "c":1 %% note\n  title Other');
    assert.deepEqual([tree.title, tree.slices], ['Other', [{ label: 'Dogs', value: 386 }, { label: 'Cats', value: 85 },
      { label: 'a b', value: 0 }, { label: 'a:b', value: 1.5 }, { label: 'c', value: 1 }]]);
  });
});
