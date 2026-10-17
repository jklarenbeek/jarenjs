//@ts-check
/**
 * @file Lines real Mermaid reads are read the same, and the printer's text
 * reads back as the same tree. Each expected reading here was taken from
 * Mermaid's own parser on the same input: a state note that does not close
 * on the exact text `end note` no longer swallows the diagram after it; a
 * class relation with quoted cardinalities, backtick names, no blanks or a
 * lollipop reads as a relation instead of being refused or dropped; a
 * sequence statement's closing `;` ends it; a quoted click string's `;`
 * after another statement is text; a refusal's line is its line in the
 * source, front-matter and directives counted; the flowchart link forms
 * `A--text-->B`, `A --> |text| B`, `~~~`, `e1@-->` and `o--o` read; and an
 * ER relationship written without blanks or with the word cardinalities
 * reads.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMermaid, toMermaid, renderMermaid } from '@jarenjs/mermaid';
import { renderToString } from '@jarenjs/view';
import { growthRatio } from '../lib/growth.js';

/** @param {string} source @param {number} line @param {RegExp} message */
const refused = (source, line, message) => assert.throws(() => parseMermaid(source),
  (/** @type {any} */ error) => error.name === 'MermaidParseError' && error.line === line && message.test(error.message));

/** Print, re-parse, and require the same tree. @param {string} source @returns {string} */
function printsBack(source) {
  const doc = parseMermaid(source);
  const text = toMermaid(doc);
  assert.deepEqual(parseMermaid(text).ast, doc.ast, `drift for ${JSON.stringify(text)}`);
  return text;
}

describe('stateDiagram — notes, comments and statement forms', () => {
  const read = (/** @type {string} */ src) => {
    const { ast } = parseMermaid(src);
    return { states: ast.states.map((/** @type {any} */ s) => s.id),
      transitions: ast.transitions.map((/** @type {any} */ t) => [t.from, t.to, t.label]) };
  };

  it('closes a block note at `end note` in any case, and reads the lines after it', () => {
    assert.deepEqual(read('stateDiagram-v2\n A --> B\n note right of B\n  waits\n End Note\n B --> C\n C --> [*]'),
      { states: ['A', 'B', 'C'], transitions: [['A', 'B', null], ['B', 'C', null], ['C', '[*]', null]] });
    assert.deepEqual(read('stateDiagram-v2\n A --> B\n note right of B\n x\n end note B --> C'),
      { states: ['A', 'B', 'C'], transitions: [['A', 'B', null], ['B', 'C', null]] });
  });

  it('reads a floating note as one line, and no note text as states', () => {
    assert.deepEqual(read('stateDiagram-v2\n note "x" as N1\n A --> B\n B --> C'),
      { states: ['A', 'B', 'C'], transitions: [['A', 'B', null], ['B', 'C', null]] });
    assert.deepEqual(read('stateDiagram-v2\n A --> B\n Note right of A : go --> back'),
      { states: ['A', 'B'], transitions: [['A', 'B', null]] });
    assert.deepEqual(read('stateDiagram-v2\n A --> B\n Note right of B\n retry --> A\n end note'),
      { states: ['A', 'B'], transitions: [['A', 'B', null]] });
  });

  it('refuses a block note never closed, and a note form Mermaid has not, at the note\'s line', () => {
    refused('stateDiagram-v2\n A --> B\n note right of B\n waits\n B --> C', 3, /^a note opened here is never closed with 'end note'$/);
    refused('stateDiagram-v2\n A --> B\n note over B\n x\n end note', 3, /^'note over B' is no note/);
  });

  it('ends a statement at a `%%` comment outside its label', () => {
    assert.deepEqual(read('stateDiagram-v2\n A --> B %% c\n B --> C : x %% c\n C --> D: y%%z'),
      { states: ['A', 'B', 'C', 'D'], transitions: [['A', 'B', null], ['B', 'C', 'x %% c'], ['C', 'D', 'y%%z']] });
  });

  it('reads the statements of a line one after another, as Mermaid does', () => {
    assert.deepEqual(read('stateDiagram-v2\n A --> B C --> D'),
      { states: ['A', 'B', 'C', 'D'], transitions: [['A', 'B', null], ['C', 'D', null]] });
    assert.deepEqual(read('stateDiagram-v2\n A B --> C'), { states: ['A', 'B', 'C'], transitions: [['B', 'C', null]] });
    assert.deepEqual(read('stateDiagram-v2\n E-->F:x'), { states: ['E', 'F'], transitions: [['E', 'F', 'x']] });
    assert.deepEqual(read('stateDiagram-v2\n stateId'), { states: ['stateId'], transitions: [] });
    assert.deepEqual(read('stateDiagram-v2\n A --> B; C D --> E'),
      { states: ['A', 'B', 'C', 'D', 'E'], transitions: [['A', 'B', null], ['D', 'E', null]] });
    assert.deepEqual(read('stateDiagram-v2\n A --> B; C'), { states: ['A', 'B', 'C'], transitions: [['A', 'B', null]] });
    // a label ends at a `;` after which a transition follows
    assert.deepEqual(read('stateDiagram-v2\n A --> B : x; C D --> E'),
      { states: ['A', 'B', 'C', 'D', 'E'], transitions: [['A', 'B', 'x'], ['D', 'E', null]] });
  });

  it('drops the styling Mermaid reads and this tree does not keep', () => {
    assert.deepEqual(read('stateDiagram-v2\n A:::c --> B:::d : go\n C:::c\n Y:::c : d2'),
      { states: ['A', 'B', 'C', 'Y'], transitions: [['A', 'B', 'go']] });
    assert.deepEqual(read('stateDiagram-v2\n state if_state <<choice>>\n A --> if_state'),
      { states: ['if_state', 'A'], transitions: [['A', 'if_state', null]] });
    assert.deepEqual(read('stateDiagram-v2\n accTitle: a --> b\n accDescr {\n c --> d\n }\n classDef k fill:#f00 --> x\n'
      + ' click A "https://x.test" "t --> u"\n A --> B'), { states: ['A', 'B'], transitions: [['A', 'B', null]] });
  });

  it('refuses the transitions Mermaid refuses, naming the line', () => {
    refused('stateDiagram-v2\n A--->B', 2, /^'A--->B' is no transition/);
    refused('stateDiagram-v2\n "A" --> B', 2, /^'"A" --> B' is no transition/);
  });

  it('prints a lone state as its name, which Mermaid reads as that state, and `state X` for a keyword', () => {
    assert.equal(printsBack('stateDiagram-v2\n X\n state end\n A --> B'), 'stateDiagram-v2\nX\nstate end\nA --> B\n');
  });
});

describe('classDiagram — the relation forms Mermaid reads', () => {
  it('reads quoted cardinalities on either side and prints them back', () => {
    const source = 'classDiagram\n Customer "1" --> "*" Ticket\n Galaxy --> "many" Star : Contains\n classA "1" *-- "many" classB : contains';
    assert.deepEqual(parseMermaid(source).ast.relations, [
      { from: 'Customer', to: 'Ticket', type: '-->', label: null, fromCardinality: '1', toCardinality: '*' },
      { from: 'Galaxy', to: 'Star', type: '-->', label: 'Contains', toCardinality: 'many' },
      { from: 'classA', to: 'classB', type: '*--', label: 'contains', fromCardinality: '1', toCardinality: 'many' },
    ]);
    assert.match(printsBack(source), /^Customer "1" --> "\*" Ticket\nGalaxy --> "many" Star : Contains\nclassA "1" \*-- "many" classB : contains$/m);
  });

  it('reads backtick names, unspaced operators and names Mermaid joins', () => {
    const rel = (/** @type {string} */ src) => parseMermaid(src).ast.relations.map((/** @type {any} */ r) => [r.from, r.type, r.to]);
    assert.deepEqual(rel('classDiagram\n `Animal Class!` --> `Car Class`'), [['Animal Class!', '-->', 'Car Class']]);
    assert.deepEqual(rel('classDiagram\n A<|--B\n C"1"-->"2"D\n Fooo--Bar\n Foo o-- Baz'),
      [['A', '<|--', 'B'], ['C', '-->', 'D'], ['Fooo', '--', 'Bar'], ['Foo', 'o--', 'Baz']]);
    assert.deepEqual(rel('classDiagram\n A --> B C\n A B --> C'), [['A', '-->', 'BC'], ['AB', '-->', 'C']]);
    assert.deepEqual(rel('classDiagram\n A --> B %% c'), [['A', '-->', 'B']]);
    // a `%%` inside a one-line body is the member's text, and the body ends at its `}`
    const body = parseMermaid('classDiagram\n class A { +x %% y }\n B --> C').ast;
    assert.deepEqual([body.classes[0].members.map((/** @type {any} */ m) => m.text), rel('classDiagram\n class A { +x %% y }\n B --> C')],
      [['x %% y'], [['B', '-->', 'C']]]);
    assert.equal(printsBack('classDiagram\n `Animal Class!` --> `Car Class`'),
      'classDiagram\nclass `Animal Class!`\nclass `Car Class`\n`Animal Class!` --> `Car Class`\n');
  });

  it('reads a lollipop as a relation to an interface that is no class', () => {
    const { ast } = parseMermaid('classDiagram\n bar ()-- foo\n foo --() baz');
    assert.deepEqual(ast.classes.map((/** @type {any} */ c) => c.name), ['foo']);
    assert.deepEqual(ast.relations.map((/** @type {any} */ r) => [r.from, r.type, r.to]), [['bar', '()--', 'foo'], ['foo', '--()', 'baz']]);
    printsBack('classDiagram\n bar ()-- foo\n foo --() baz');
  });

  it('reads a class statement\'s label and drops its style class', () => {
    const { ast } = parseMermaid('classDiagram\n class B["Bee"]:::k\n class C:::k\n class D["Dee"] {\n +x\n }');
    assert.deepEqual(ast.classes.map((/** @type {any} */ c) => [c.name, c.label]), [['B', 'Bee'], ['C', 'C'], ['D', 'Dee']]);
    assert.equal(printsBack('classDiagram\n class B["Bee"]:::k\n class D["Dee"] {\n +x\n }'),
      'classDiagram\nclass B["Bee"]\nclass D["Dee"] {\n  +x\n}\n');
  });

  it('refuses the relation lines Mermaid refuses, naming the line', () => {
    refused('classDiagram\n A --> B\n A ---> B', 3, /^'A ---> B' is no relation/);
    refused('classDiagram\n C --> D --> E', 2, /^'C --> D --> E' is no relation/);
  });
});

describe('sequenceDiagram — a statement ends at its `;`', () => {
  const read = (/** @type {string} */ src) => {
    const { ast } = parseMermaid(src);
    return { participants: ast.participants.map((/** @type {any} */ p) => [p.id, p.label]),
      texts: ast.statements.map((/** @type {any} */ s) => s.text) };
  };

  it('reads a closing `;` as the end of the statement', () => {
    assert.deepEqual(read('sequenceDiagram\n A->>B: hi;\n B->>A: yo;;'), { participants: [['A', 'A'], ['B', 'B']], texts: ['hi', 'yo'] });
    assert.deepEqual(read('sequenceDiagram\n participant A;\n A->>B: y'), { participants: [['A', 'A'], ['B', 'B']], texts: ['y'] });
    assert.deepEqual(read('sequenceDiagram\n Note right of A: x;'), { participants: [['A', 'A']], texts: ['x'] });
  });

  it('prints a text that ends in `;` with #59;, so it reads back as one statement with its text', () => {
    const doc = parseMermaid('sequenceDiagram\n A->>B: hi');
    doc.ast.statements[0].text = 'hi;';
    assert.match(toMermaid(doc), /^A->>B: hi#59;$/m);
  });

  it('declares the actors a note names, and reads participant metadata and half arrows', () => {
    assert.deepEqual(read('sequenceDiagram\n A->>B: x\n Note over A,C: n'), { participants: [['A', 'A'], ['B', 'B'], ['C', 'C']], texts: ['x', 'n'] });
    assert.deepEqual(read('sequenceDiagram\n participant API@{ "type": "boundary" } as Public API\n'
      + ' participant DB@{ "type": "database", "alias": "Store" }\n API->>()DB: q\n DB()->>API: r'),
    { participants: [['API', 'Public API'], ['DB', 'Store']], texts: ['q', 'r'] });
  });
});

describe('flowchart — statements and links', () => {
  const edges = (/** @type {string} */ src) => parseMermaid(src).ast.edges
    .map((/** @type {any} */ e) => [e.from, e.to, e.label, e.stroke, e.tail, e.head]);

  it('keeps a quoted click string whole after another statement', () => {
    const { ast } = parseMermaid('flowchart LR\n A --> B; click B "https://e.com" "tip; more"\n C --> D; click D href "https://e.com/?a=1;b=2"');
    assert.deepEqual(ast.nodes.map((/** @type {any} */ n) => n.id), ['A', 'B', 'C', 'D']);
    assert.deepEqual(ast.clicks.map((/** @type {any} */ c) => [c.ids, c.href, c.tooltip]),
      [[['B'], 'https://e.com', 'tip; more'], [['D'], 'https://e.com/?a=1;b=2', null]]);
  });

  it('reads an inline label with no blank after its opening run', () => {
    assert.deepEqual(edges('flowchart LR\n A--yes-->B\n C--text---D\n E==t==>F\n G-.t.->H\n I--a-b-->J'), [
      ['A', 'B', 'yes', 'solid', 'none', 'arrow'], ['C', 'D', 'text', 'solid', 'none', 'none'],
      ['E', 'F', 't', 'thick', 'none', 'arrow'], ['G', 'H', 't', 'dotted', 'none', 'arrow'], ['I', 'J', 'a-b', 'solid', 'none', 'arrow']]);
    // `--o` is a link with a circle head, as in Mermaid
    assert.deepEqual(edges('flowchart LR\n A--oops-->B'), [['A', 'ops', null, 'solid', 'none', 'circle'], ['ops', 'B', null, 'solid', 'none', 'arrow']]);
  });

  it('reads a pipe label after blanks, the invisible link, edge ids and circle and cross tails', () => {
    assert.deepEqual(edges('flowchart LR\n A --> |text| B\n A ~~~ C\n A e1@==> D\n e1@{ animate: true }\n A o--o E\n A x--x F'), [
      ['A', 'B', 'text', 'solid', 'none', 'arrow'], ['A', 'C', null, 'invisible', 'none', 'none'],
      ['A', 'D', null, 'thick', 'none', 'arrow'], ['A', 'E', null, 'solid', 'circle', 'circle'], ['A', 'F', null, 'solid', 'cross', 'cross']]);
    assert.deepEqual(parseMermaid('flowchart LR\n A e1@==> D\n e1@{ animate: true }').ast.nodes.map((/** @type {any} */ n) => n.id), ['A', 'D']);
    assert.deepEqual(edges('flowchart LR\n A@{ shape: rect } --> B'), [['A', 'B', null, 'solid', 'none', 'arrow']]);
    assert.match(printsBack('flowchart LR\n A ~~~ B\n A o--o C'), /^A ~~~ B\nA o--o C$/m);
  });

  it('draws no line for an invisible link', () => {
    const svg = renderToString(renderMermaid('flowchart LR\n A ~~~ B'));
    assert.match(svg, /class="mm-edge-line" fill="none" stroke="none"/);
  });

  it('refuses text after a node where a link belongs, as Mermaid does', () => {
    refused('flowchart LR\n A --> B garbage', 2, /^expected a link after a node, found 'garbage'$/);
  });
});

describe('erDiagram — every relationship spelling Mermaid reads', () => {
  const rels = (/** @type {string} */ src) => parseMermaid(src).ast.relationships
    .map((/** @type {any} */ r) => [r.left, r.leftCard, r.identifying, r.rightCard, r.right, r.label]);

  it('reads a relationship written without blanks', () => {
    assert.deepEqual(rels('erDiagram\n CUSTOMER||--o{ORDER : places\n ORDER ||--|{ ITEM : contains'),
      [['CUSTOMER', '||', true, 'o{', 'ORDER', 'places'], ['ORDER', '||', true, '|{', 'ITEM', 'contains']]);
  });

  it('reads the word cardinalities and `to` / `optionally to`, and prints them back', () => {
    const source = 'erDiagram\n CAR 1 to zero or more NAMED-DRIVER : allows\n PERSON one or more--zero or one CAR : drives\n'
      + ' A only one optionally to many(1) B : x';
    assert.deepEqual(rels(source), [['CAR', '1', true, 'zero or more', 'NAMED-DRIVER', 'allows'],
      ['PERSON', 'one or more', true, 'zero or one', 'CAR', 'drives'], ['A', 'only one', false, 'many(1)', 'B', 'x']]);
    printsBack(source);
  });

  it('reads a connector inside a one-line entity block as text, and an alias and a style class', () => {
    assert.deepEqual(parseMermaid('erDiagram\n CUSTOMER { string name "a ||--o{ b" }').ast.entities,
      [{ name: 'CUSTOMER', attributes: [{ type: 'string', name: 'name', keys: [], comment: 'a ||--o{ b' }] }]);
    const { ast } = parseMermaid('erDiagram\n A:::k ||--o{ B : r\n p[Person] {\n string x\n }\n q["Q q"]');
    assert.deepEqual(ast.entities.map((/** @type {any} */ e) => [e.name, e.alias]), [['A', undefined], ['B', undefined], ['p', 'Person'], ['q', 'Q q']]);
    printsBack('erDiagram\n p[Person] {\n string x\n }\n q["Q q"]');
  });

  it('refuses a connector line no form reads, naming its line, and reads a name a connector is no part of', () => {
    refused('erDiagram\n A||--o{B C D', 2, /^'A\|\|--o\{B C D' is no relationship/);
    refused('erDiagram\n A ||--o{ B C D', 2, /^'A \|\|--o\{ B C D' is no relationship/);
    assert.deepEqual(parseMermaid('erDiagram\n A--\n "my||--o{x" {\n string a\n }').ast.entities.map((/** @type {any} */ e) => e.name),
      ['A--', 'my||--o{x']);
  });

  it('reads a line of unspaced connectors in linear time', () => {
    // every connector is a place the left name could end; a right name that
    // ran on through the next connectors made the line quadratic
    const line = (/** @type {number} */ n) => 'erDiagram\n ' + 'a||--o{'.repeat(n) + 'a b';
    const attempt = (/** @type {string} */ source) => { try { parseMermaid(source); } catch { /* refused */ } };
    const ratio = growthRatio(attempt, line(2000), line(16000), { limit: 24 });
    assert.ok(ratio < 24, `eight times the line multiplied the time by ${ratio.toFixed(1)}`);
  });
});

describe('a refusal names its line in the source', () => {
  const HEAD = '---\ntitle: t\n---\n%%{init: {}}%%\n%% a comment\n';

  it('counts the front-matter, an init directive and a comment line', () => {
    refused(HEAD + 'classDiagram\n A <|-- B\n C --> D --> E', 8, /^'C --> D --> E' is no relation/);
    refused(HEAD + 'flowchart LR\n A[x --> B', 7, /^unterminated '\[' shape for node 'A'$/);
    refused(HEAD + 'sequenceDiagram\n A->>B: x\n end', 8, /^unexpected 'end'$/);
    refused(HEAD + 'stateDiagram-v2\n %% inside\n A --> B --> C', 8, /^'A --> B --> C' is no transition/);
    refused(HEAD + 'erDiagram\n A ||--o{ B C D', 7, /^'A \|\|--o\{ B C D' is no relationship/);
  });
});
