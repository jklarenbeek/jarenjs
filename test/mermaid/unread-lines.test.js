//@ts-check
/**
 * @file A state, class or ER line that no form reads is no longer dropped
 * without a word. A state line splits at `;` as Mermaid's does (`A --> B;
 * B --> C` is two transitions) where every piece reads as a statement; a
 * transition, relation or relationship line that still reads as nothing is
 * refused with its line, as Mermaid refuses it; an ER relationship without
 * a label reads as one (it used to open an entity block at the brace of
 * `o{` and swallow the lines after it); and a state note's text is never
 * read as states or transitions.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMermaid, toMermaid } from '@jarenjs/mermaid';

/** @param {string} source @param {number} line @param {RegExp} message */
const refused = (source, line, message) => assert.throws(() => parseMermaid(source),
  (/** @type {any} */ error) => error.name === 'MermaidParseError' && error.line === line && message.test(error.message));

describe('stateDiagram-v2 — every line reads, or is refused', () => {
  const transitions = (/** @type {string} */ src) => parseMermaid(src).ast.transitions
    .map((/** @type {any} */ t) => [t.from, t.to, t.label]);

  it('splits at `;` where every piece is a statement, and keeps a label\'s `;` otherwise', () => {
    assert.deepEqual(transitions('stateDiagram-v2\n  A --> B; B --> C'), [['A', 'B', null], ['B', 'C', null]]);
    assert.deepEqual(transitions('stateDiagram-v2\n  A --> B : x; y z'), [['A', 'B', 'x; y z']]);
    assert.deepEqual(transitions('stateDiagram-v2\n  A --> B : I #9829; you'), [['A', 'B', 'I #9829; you']]);
  });

  it('refuses a transition no form reads, naming its line', () => {
    refused('stateDiagram-v2\n  A --> B\n  A --> B --> C', 3, /^'A --> B --> C' is no transition/);
  });

  it('reads no state or transition out of a note', () => {
    const { ast } = parseMermaid('stateDiagram-v2\n  note right of A\n    a --> b : c\n  end note\n  note left of A : x --> y\n  A --> B');
    assert.deepEqual(ast.transitions.map((/** @type {any} */ t) => [t.from, t.to]), [['A', 'B']]);
    assert.deepEqual(ast.states.map((/** @type {any} */ s) => s.id), ['A', 'B']);
  });

  it('prints a label\'s `;` as #59; only where the line would split, so it reads back as one transition', () => {
    const doc = parseMermaid('stateDiagram-v2\n  A --> B : x; y z');
    doc.ast.transitions.push({ ...doc.ast.transitions[0], label: 'p; B --> C', event: 'p; B --> C' });
    const text = toMermaid(doc);
    assert.match(text, /^A --> B : x; y z$/m);
    assert.match(text, /^A --> B : p#59; B --> C$/m);
    assert.deepEqual(parseMermaid(text).ast.transitions.map((/** @type {any} */ t) => t.label), ['x; y z', 'p#59; B --> C']);
  });
});

describe('classDiagram — a relation no form reads is refused', () => {
  it('refuses two relations on one line, as Mermaid does, and reads a note\'s operator as text', () => {
    refused('classDiagram\n  A <|-- B; C <|-- D', 2, /^'A <\|-- B; C <\|-- D' is no relation/);
    const { ast } = parseMermaid('classDiagram\n  note "a --> b"\n  A <|-- B : x -- y');
    assert.deepEqual(ast.relations, [{ from: 'A', to: 'B', type: '<|--', label: 'x -- y' }]);
  });
});

describe('erDiagram — a relationship reads, or is refused', () => {
  it('reads a relationship without a label, and the lines after it', () => {
    const doc = parseMermaid('erDiagram\n  A ||--o{ B\n  C ||--|| D : owns\n  E {\n    string x\n  }');
    assert.deepEqual(doc.ast.entities.map((/** @type {any} */ e) => e.name), ['A', 'B', 'C', 'D', 'E']);
    assert.deepEqual(doc.ast.relationships.map((/** @type {any} */ r) => [r.left, r.right, r.label]), [['A', 'B', ''], ['C', 'D', 'owns']]);
    assert.deepEqual(parseMermaid(toMermaid(doc)).ast, doc.ast);
  });

  it('refuses a connector line no form reads, naming its line', () => {
    refused('erDiagram\n  A ||--o{ B C D', 2, /^'A \|\|--o\{ B C D' is no relationship/);
  });
});
