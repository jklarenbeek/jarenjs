//@ts-check
/**
 * An ER relationship's label as Mermaid reads it: the one word or quoted
 * string after the `:`, the rest of the line read as the statements after
 * it (`A ||--o{ B : places order` is the label `places` and an entity
 * `order`), a label or a rest that opens no statement refused; and what
 * `toMermaid` prints for a label of more than one word (quoted). Each reading
 * and each refusal here was checked against Mermaid 11.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMermaid, toMermaid } from '@jarenjs/mermaid';

const E = (/** @type {string} */ body) => `erDiagram\n${body}`;
/** Entities (name, alias, attribute count) and relationships (left, right, label). */
const er = (/** @type {string} */ source) => {
  const a = /** @type {any} */ (parseMermaid(source).ast);
  return {
    entities: a.entities.map((/** @type {any} */ e) => [e.name, e.alias ?? null, e.attributes.length]),
    relationships: a.relationships.map((/** @type {any} */ r) => [r.left, r.right, r.label]),
  };
};

/**
 * @param {string} source
 * @param {number} line
 * @param {string} text the refused line
 */
function refuses(source, line, text) {
  assert.throws(() => parseMermaid(source), (/** @type {any} */ error) => {
    assert.equal(error.name, 'MermaidParseError', source);
    assert.deepEqual([error.msgid, error.line, error.params], ['mermaid/er/relationship', line, { line: text }], source);
    return true;
  });
}

describe('erDiagram — a relationship label', () => {
  it('is the one word after the `:`, the rest of the line the statements after it, as Mermaid reads it', () => {
    assert.deepEqual(er(E('A ||--o{ B : places order')), { entities: [['A', null, 0], ['B', null, 0], ['order', null, 0]], relationships: [['A', 'B', 'places']] });
    assert.deepEqual(er(E('A ||--o{ B : a b c')).entities.map((/** @type {any} */ e) => e[0]), ['A', 'B', 'b', 'c']);
    assert.deepEqual(er(E('A ||--o{ B : places  order')).relationships, [['A', 'B', 'places']]);
    assert.deepEqual(er(E('A||--o{B : places order')).relationships, [['A', 'B', 'places']]);
    assert.deepEqual(er(E('A only one to zero or more B : places order')).relationships, [['A', 'B', 'places']]);
    assert.deepEqual(er(E('A ||--o{ B : places A')), { entities: [['A', null, 0], ['B', null, 0]], relationships: [['A', 'B', 'places']] });
    assert.deepEqual(er(E('A ||--o{ B : places o[Order]')).entities, [['A', null, 0], ['B', null, 0], ['o', 'Order', 0]]);
    assert.deepEqual(er(E('A ||--o{ B : places order["An order"]')).entities.at(-1), ['order', 'An order', 0]);
    assert.deepEqual(er(E('A ||--o{ B : places order:::c')).entities.at(-1), ['order', null, 0]);
    assert.deepEqual(er(E('A ||--o{ B : places order {\n string x\n}')).entities.at(-1), ['order', null, 1]);
    assert.deepEqual(er(E('A ||--o{ B : places B ||--o{ C : has')).relationships, [['A', 'B', 'places'], ['B', 'C', 'has']]);
    assert.deepEqual(er(E('A ||--o{ B : places order\nB ||--|{ order : has')).relationships, [['A', 'B', 'places'], ['B', 'order', 'has']]);
  });

  it('reads a word of Mermaid\'s lexer: `-`, `_`, `*`, `.`, non-ASCII letters and entity codes in it, a `"` ending it', () => {
    for (const label of ['a-b', 'a.b', 'a_b', 'a*b', 'v2', 'zero', 'only', 'oneself', 'é', 'has#9829;']) {
      assert.deepEqual(er(E(`A ||--o{ B : ${label}`)).relationships, [['A', 'B', label]], label);
    }
    assert.deepEqual(er(E('A ||--o{ B : a_b c-d')), { entities: [['A', null, 0], ['B', null, 0], ['c-d', null, 0]], relationships: [['A', 'B', 'a_b']] });
    assert.deepEqual(er(E('A ||--o{ B : é ü')).entities.at(-1), ['ü', null, 0]);
    assert.deepEqual(er(E('A ||--o{ B : has #9829;')).entities.at(-1), ['#9829;', null, 0]);
    assert.deepEqual(er(E('A ||--o{ B : say"hi"')), { entities: [['A', null, 0], ['B', null, 0], ['hi', null, 0]], relationships: [['A', 'B', 'say']] });
    assert.deepEqual(er(E('A ||--o{ B : a"b"c')).entities.map((/** @type {any} */ e) => e[0]), ['A', 'B', 'b', 'c']);
  });

  it('is one quoted string, which may hold blanks, the rest of the line after it the statements after it', () => {
    assert.deepEqual(er(E('A ||--o{ B : "places order"')).relationships, [['A', 'B', 'places order']]);
    assert.deepEqual(er(E('A ||--o{ B : ""')).relationships, [['A', 'B', '']]);
    assert.deepEqual(er(E('A ||--o{ B : "a" b')), { entities: [['A', null, 0], ['B', null, 0], ['b', null, 0]], relationships: [['A', 'B', 'a']] });
    assert.deepEqual(er(E('A ||--o{ B : "a b" c')).relationships, [['A', 'B', 'a b']]);
    assert.deepEqual(er(E('A ||--o{ B : "a" "b"')).entities.at(-1), ['b', null, 0]);
    assert.deepEqual(er(E('A ||--o{ B : "a""b"')).entities.at(-1), ['b', null, 0]);
    assert.deepEqual(er(E('A ||--o{ B : "a"b')).entities.at(-1), ['b', null, 0]);
    assert.deepEqual(er(E('A ||--o{ B : places "big order"')).entities.at(-1), ['big order', null, 0]);
    assert.deepEqual(er(E('A ||--o{ B : places "o"[x]')).entities.at(-1), ['o', 'x', 0]);
    assert.deepEqual(er(E('A ||--o{ B :   places  ')).relationships, [['A', 'B', 'places']]);
  });

  it('refuses a label that opens with no word, or a rest that opens no statement, as Mermaid refuses it', () => {
    for (const label of ['places, order', 'places,order', 'a/b', 'a:b', 'a(b)', 'places:::c', 'places ||--o{ C', 'a"b']) {
      refuses(E(`A ||--o{ B : ${label}`), 2, `A ||--o{ B : ${label}`);
    }
    refuses(E('A ||--o{ B : x\nC ||--|| D : (y)'), 3, 'C ||--|| D : (y)');
  });

  it('reads a names line whose quoted name stands against a word, or holding a `.`, as Mermaid reads it', () => {
    assert.deepEqual(er(E('"b"c')).entities, [['b', null, 0], ['c', null, 0]]);
    // a `.` is a word character of Mermaid's, in a names line as in a label
    assert.deepEqual(er(E('a.b c')).entities, [['a.b', null, 0], ['c', null, 0]]);
    assert.deepEqual(er(E('A ||--o{ B : a.b c')).entities.at(-1), ['c', null, 0]);
  });

  it('prints a label of more than one word, a digit or keyword first, quoted, which reads back as that label', () => {
    const doc = parseMermaid(E('A ||--o{ B : x'));
    const rel = /** @type {any} */ (doc.ast).relationships[0];
    for (const [label, written] of [['places order', '"places order"'], ['places', 'places'], ['a-b.c*_d', 'a-b.c*_d'], ['é', 'é'],
      ['2nd', '"2nd"'], ['one', '"one"'], ['Many', '"Many"'], ['to', '"to"'], ['class', '"class"'], ['u-turn', '"u-turn"'], ['a(b)', '"a(b)"'],
      ['', '""'], ['say"hi"', '"say#34;hi#34;"']]) {
      rel.label = label;
      const text = toMermaid(doc);
      assert.equal(text.split('\n').at(-2), `A ||--o{ B : ${written}`, label);
      assert.deepEqual(er(text).relationships, [['A', 'B', label.replaceAll('"', '#34;')]], label);
    }
  });
});
