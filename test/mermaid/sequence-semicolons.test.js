//@ts-check
/**
 * A `;` in a sequence diagram as Mermaid reads it: it ends a statement, so a
 * message, note, block or participant line whose `;` is followed by what is
 * no statement is refused (where the text kept the `;`), and every line
 * Mermaid reads still reads. Each reading and each refusal here was checked
 * against Mermaid 11.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMermaid } from '@jarenjs/mermaid';

const S = (/** @type {string} */ body) => `sequenceDiagram\n${body}`;
/** Each statement as [kind, text or label], blocks with their branches' labels. */
const read = (/** @type {string} */ source) => /** @type {any} */ (parseMermaid(source).ast).statements.map((/** @type {any} */ s) =>
  s.kind === 'block' ? [s.blockType, s.branches.map((/** @type {any} */ b) => b.label)] : [s.kind, s.text ?? s.actor]);

/**
 * @param {string} source
 * @param {number} line
 * @param {string} rest
 */
function refuses(source, line, rest) {
  assert.throws(() => parseMermaid(source), (/** @type {any} */ error) => {
    assert.equal(error.name, 'MermaidParseError', source);
    assert.deepEqual([error.msgid, error.line, error.params], ['mermaid/sequence/semicolon', line, { rest }], source);
    return true;
  });
}

describe('sequenceDiagram — a `;` before what is no statement', () => {
  it('is refused in a message, a note, a block label and a participant line, as Mermaid refuses it', () => {
    refuses(S('A->>B: a;b'), 2, 'b');
    refuses(S('A->>B: ;a'), 2, 'a');
    refuses(S('A->>B: a; b'), 2, 'b');
    refuses(S('A->>B: a ; b'), 2, 'b');
    refuses(S('A->>B: a;;b'), 2, 'b');
    refuses(S('A->>B: a;b;'), 2, 'b');
    refuses(S('A->>B: a\nB->>A: b;c'), 3, 'c');
    refuses(S('A->>+B: a;b'), 2, 'b');
    refuses(S('A-)B: a;b'), 2, 'b');
    refuses(S('A->>B: a%%;b'), 2, 'b');
    refuses(S('Note over A: a;b'), 2, 'b');
    refuses(S('Note right of A: a;b'), 2, 'b');
    refuses(S('Note over A,B: a;b'), 2, 'b');
    refuses(S('loop a;b\nA->>B: x\nend'), 2, 'b');
    refuses(S('opt a;b\nA->>B: x\nend'), 2, 'b');
    refuses(S('break a;b\nA->>B: x\nend'), 2, 'b');
    refuses(S('alt a\nA->>B: x\nelse c;d\nA->>B: y\nend'), 4, 'd');
    refuses(S('par a\nA->>B: x\nand c;d\nA->>B: y\nend'), 4, 'd');
    refuses(S('critical a\nA->>B: x\noption c;d\nA->>B: y\nend'), 4, 'd');
    refuses(S('participant A as x;y'), 2, 'y');
    refuses(S('actor A as x;y'), 2, 'y');
  });
});

describe('sequenceDiagram — a `;` Mermaid reads', () => {
  it('ends a statement, and one at the end of a line ends its last', () => {
    assert.deepEqual(read(S('A->>B: a;')), [['message', 'a']]);
    assert.deepEqual(read(S('A->>B: a ;')), [['message', 'a']]);
    assert.deepEqual(read(S('A->>B: a;;')), [['message', 'a']]);
    assert.deepEqual(read(S('A->>B: a;  ')), [['message', 'a']]);
    assert.deepEqual(read(S('Note left of A: a;')), [['note', 'a']]);
    assert.deepEqual(read(S('loop a;\nA->>B: x\nend')), [['loop', ['a']]]);
    assert.deepEqual(read(S('A->>B: a;B->>A: c')), [['message', 'a'], ['message', 'c']]);
    assert.deepEqual(read(S('Note over A: a;A->>B: c')), [['note', 'a'], ['message', 'c']]);
    assert.deepEqual(read(S('A->>B: a;destroy B')), [['message', 'a']]);
    assert.deepEqual(read(S('A->>B: x\nactivate B;deactivate B')), [['message', 'x'], ['activate', 'B'], ['deactivate', 'B']]);
    assert.deepEqual(read(S('autonumber;A->>B: x')), [['message', 'x']]);
    assert.deepEqual(/** @type {any} */ (parseMermaid(S('participant A;participant B')).ast).participants.map((/** @type {any} */ p) => p.id), ['A', 'B']);
    assert.deepEqual(/** @type {any} */ (parseMermaid(S('participant A as x;')).ast).participants.map((/** @type {any} */ p) => p.label), ['x']);
  });

  it('ends a message before a title or an accessible title, which this tree does not keep', () => {
    assert.deepEqual(read(S('A->>B: a;title x')), [['message', 'a']]);
    assert.deepEqual(read(S('A->>B: a;accTitle: x')), [['message', 'a']]);
  });

  it('is text in an entity code, an accessible title or description, and a comment', () => {
    assert.deepEqual(read(S('A->>B: a#59;b')), [['message', 'a#59;b']]);
    assert.deepEqual(read(S('Note over A: a#59;b')), [['note', 'a#59;b']]);
    assert.deepEqual(read(S('accTitle: a;b\nA->>B: x')), [['message', 'x']]);
    assert.deepEqual(read(S('accDescr: a;b\nA->>B: x')), [['message', 'x']]);
    assert.deepEqual(read(S('%% a;b\nA->>B: x')), [['message', 'x']]);
  });
});
