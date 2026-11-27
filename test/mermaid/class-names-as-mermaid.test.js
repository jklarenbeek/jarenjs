//@ts-check
/**
 * Class names and their generics as Mermaid reads them: a backtick-quoted
 * name split at its `~`s with the first two parts kept, a bare name's empty
 * `~~` dropped, a `~` Mermaid pairs with nothing refused, the generic a class
 * is first written with kept; and what `toMermaid` prints for a generic that
 * nests another (its nesting as `#lt;`/`#gt;`, which reads back as one
 * generic and draws nested in both engines).
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMermaid, toMermaid, renderMermaid } from '@jarenjs/mermaid';
import { renderToString } from '@jarenjs/view';

const classes = (/** @type {string} */ source) => /** @type {any} */ (parseMermaid(source).ast).classes
  .map((/** @type {any} */ c) => [c.name, c.generic ?? null, c.members.length]);
const C = (/** @type {string} */ body) => `classDiagram\n${body}`;

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

describe('classDiagram — a backtick-quoted name holding `~`', () => {
  it('keeps the first two parts its `~`s split it into, as Mermaid does', () => {
    assert.deepEqual(classes(C('class `Grid~List~int~~`')), [['Grid', 'List', 0]]);
    assert.deepEqual(classes(C('class `Grid~Map~K,V~~`')), [['Grid', 'Map', 0]]);
    assert.deepEqual(classes(C('class `A~B~C~D~`')), [['A', 'B', 0]]);
    assert.deepEqual(classes(C('class `A~B`')), [['A', 'B', 0]]);
    assert.deepEqual(classes(C('class `A~`')), [['A', '', 0]]);
    assert.deepEqual(classes(C('class `A B~T~`')), [['A B', 'T', 0]]);
    assert.deepEqual(classes(C('class `Grid~List~int~~` {\n  +x\n}')), [['Grid', 'List', 1]]);
    assert.deepEqual(classes(C('class `Grid~List~int~~`["lbl"]')), [['Grid', 'List', 0]]);
    assert.deepEqual(classes(C('`Grid~List~int~~` --> B')), [['Grid', 'List', 0], ['B', null, 0]]);
  });

  it('names the class without its backticks in a `Name : member` line', () => {
    assert.deepEqual(classes(C('`Foo` : +x')), [['Foo', null, 1]]);
    assert.deepEqual(classes(C('`Grid~List~int~~` : +x')), [['Grid', 'List', 1]]);
  });

  it('still keeps a name that opens with `~` whole, and one whose backtick nothing closes as written', () => {
    assert.deepEqual(classes(C('class `~A`')), [['~A', null, 0]]);
    assert.deepEqual(classes(C('`Foo : +x')), [['`Foo', null, 1]]);
  });
});

describe('classDiagram — a bare name holding a run of `~`', () => {
  it('drops each empty `~~`, as Mermaid does', () => {
    assert.deepEqual(classes(C('class A~~B~~')), [['AB', null, 0]]);
    assert.deepEqual(classes(C('class A~~B')), [['AB', null, 0]]);
    assert.deepEqual(classes(C('class ~~A')), [['A', null, 0]]);
    assert.deepEqual(classes(C('class A~~')), [['A', null, 0]]);
    assert.deepEqual(classes(C('class A~~~~B')), [['AB', null, 0]]);
    assert.deepEqual(classes(C('class A~~B~T~')), [['AB', 'T', 0]]);
    assert.deepEqual(classes(C('class A~T~~~')), [['A', 'T', 0]]);
    assert.deepEqual(classes(C('class A~~~T~')), [['A', 'T', 0]]);
    assert.deepEqual(classes(C('A~~B~~ --> Z')), [['AB', null, 0], ['Z', null, 0]]);
    assert.deepEqual(classes(C('A~~B~~ : +x')), [['AB', null, 1]]);
  });

  it('refuses a `~` paired with nothing, and text after a generic, as Mermaid refuses them', () => {
    for (const name of ['A~~B~', 'A~B~~', 'A~T~~', 'A~T~B', '~A~', 'A~T', 'A~B~C']) {
      refuses(C(`class ${name}`), 'mermaid/class/generic-tilde', 2, { name });
    }
    refuses(C('A --> B\nA~T --> B'), 'mermaid/class/generic-tilde', 3, { name: 'A~T' });
    refuses(C('A~~B~ : +x'), 'mermaid/class/generic-tilde', 2, { name: 'A~~B~' });
    // a generic nesting another keeps its own message
    refuses(C('class A~B~C~'), 'mermaid/class/nested-generic', 2, { name: 'A~B~C~' });
  });

  it('still reads a one-level generic and a member\'s nested type', () => {
    assert.deepEqual(classes(C('class Square~Shape~\nMap~K,V~ --> List~int~\nclass A {\n  +List~List~int~~ items\n}')),
      [['Square', 'Shape', 0], ['Map', 'K,V', 0], ['List', 'int', 0], ['A', null, 1]]);
  });
});

describe('classDiagram — the generic a class is first written with', () => {
  it('is the one it keeps, as Mermaid keeps it', () => {
    assert.deepEqual(classes(C('class A\nclass A~T~')), [['A', null, 0]]);
    assert.deepEqual(classes(C('class A~T~\nclass A~U~')), [['A', 'T', 0]]);
    assert.deepEqual(classes(C('A --> B~T~\nclass B~U~')), [['A', null, 0], ['B', 'T', 0]]);
  });
});

describe('toMermaid — a class generic that nests another', () => {
  const nested = () => {
    const doc = parseMermaid(C('class Grid~T~\nclass `A B~T~`'));
    const ast = /** @type {any} */ (doc.ast);
    ast.classes[0].generic = 'List~int~';
    ast.classes[1].generic = 'Map~K,List~V~~';
    return doc;
  };

  it('prints its nesting as `#lt;`/`#gt;`, which reads back as one generic', () => {
    const text = toMermaid(nested());
    assert.equal(text, 'classDiagram\nclass Grid~List#lt;int#gt;~\nclass `A B~Map#lt;K,List#lt;V#gt;#gt;~`\n');
    assert.deepEqual(classes(text), [['Grid', 'List#lt;int#gt;', 0], ['A B', 'Map#lt;K,List#lt;V#gt;#gt;', 0]]);
    assert.equal(toMermaid(parseMermaid(text)), text);
  });

  it('prints a bare-name generic bare and any other name\'s generic inside its backticks', () => {
    const doc = parseMermaid(C('class Square~Shape~\nclass `A B~T~`\nclass `C~`'));
    assert.equal(toMermaid(doc), 'classDiagram\nclass Square~Shape~\nclass `A B~T~`\nclass `C~~`\n');
  });

  it('draws the tree and its print alike, nested, as Mermaid draws the print', () => {
    const heading = (/** @type {string} */ svg) => [...svg.matchAll(/>([^<>]*&lt;[^<>]*)</g)].map((m) => m[1]);
    const want = ['Grid&lt;List&lt;int&gt;&gt;', 'A B&lt;Map&lt;K,List&lt;V&gt;&gt;&gt;'];
    assert.deepEqual(heading(renderToString(renderMermaid(nested()))), want);
    assert.deepEqual(heading(renderToString(renderMermaid(toMermaid(nested())))), want);
  });
});
