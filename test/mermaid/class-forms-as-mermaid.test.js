//@ts-check
/**
 * Class-diagram forms as Mermaid reads them: where a backtick name starts,
 * Mermaid's lexer reads its own tokens (each `~~` dropped, a `~` left over or
 * a keyword refused); a `;` outside quotes, backticks or a body is refused;
 * a class's `<<annotation>>`s are kept and the first drawn above its name.
 * Each reading and each refusal here was checked against Mermaid 11; the
 * one text that differs (Mermaid's HTML sanitizer) is its own test.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMermaid, toMermaid, renderMermaid } from '@jarenjs/mermaid';
import { renderToString } from '@jarenjs/view';

const C = (/** @type {string} */ body) => `classDiagram\n${body}`;
const ast = (/** @type {string} */ source) => /** @type {any} */ (parseMermaid(source).ast);
const classes = (/** @type {string} */ source) => ast(source).classes
  .map((/** @type {any} */ c) => [c.name, c.generic ?? null, c.annotations ?? null, c.members.length]);

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

/** A one-class tree named `name`, printed. */
const printed = (/** @type {string} */ name) => {
  const doc = parseMermaid(C('class X'));
  Object.assign(/** @type {any} */ (doc.ast).classes[0], { name, label: name });
  return toMermaid(doc);
};

/** The texts a class diagram draws. */
const drawn = (/** @type {string} */ source) => [...renderToString(renderMermaid(source)).matchAll(/<text[^>]*>([^<]*)</g)].map((m) => m[1]);

describe('classDiagram — where a backtick name starts', () => {
  it('drops each leading `~~`, as Mermaid does', () => {
    assert.deepEqual(classes(C('class `~~A`')), [['A', null, null, 0]]);
    assert.deepEqual(classes(C('class `~~A~T~`')), [['A', 'T', null, 0]]);
    assert.deepEqual(classes(C('class `~~A B`')), [['A B', null, null, 0]]);
  });

  it('refuses a `~` the `~~`s leave over, and a name of `~~`s alone, as Mermaid refuses them', () => {
    refuses(C('class `~A`'), 'mermaid/class/generic-tilde', 2, { name: '`~A`' });
    refuses(C('class `~A~`'), 'mermaid/class/generic-tilde', 2, { name: '`~A~`' });
    refuses(C('class `~~~A`'), 'mermaid/class/generic-tilde', 2, { name: '`~~~A`' });
    refuses(C('class `~T~A`'), 'mermaid/class/generic-tilde', 2);
    refuses(C('class `~~`'), 'mermaid/class/generic-tilde', 2, { name: '`~~`' });
    refuses(C('class `~`'), 'mermaid/class/generic-tilde', 2);
    refuses(C('A --> `~A`'), 'mermaid/class/generic-tilde', 2);
    refuses(C('`~A` : +x'), 'mermaid/class/generic-tilde', 2);
    refuses(C('class `~A`["l"]'), 'mermaid/class/generic-tilde', 2);
  });

  it('refuses a keyword, `<<`, `>>` or a `"` where the text starts, as Mermaid refuses it', () => {
    refuses(C('class `note A`'), 'mermaid/class/backtick-lead', 2, { name: '`note A`', lead: 'note', coded: '#110;ote' });
    refuses(C('class `link A`'), 'mermaid/class/backtick-lead', 2, { name: '`link A`', lead: 'link', coded: '#108;ink' });
    refuses(C('class `<<A`'), 'mermaid/class/backtick-lead', 2, { name: '`<<A`', lead: '<<', coded: '#60;#60;' });
    refuses(C('class `"A"`'), 'mermaid/class/backtick-lead', 2, { name: '`"A"`', lead: '"', coded: '#34;' });
    for (const word of ['cssClass', 'callback', 'click', 'note for', 'href', '>>']) {
      refuses(C(`class \`${word} x\``), 'mermaid/class/backtick-lead', 2);
    }
  });

  it('still reads every name that read right: a `~` after the start, a keyword inside a word or after it, a blank first', () => {
    assert.deepEqual(classes(C('class `A~`')), [['A', '', null, 0]]);
    assert.deepEqual(classes(C('class ` ~A`')), [[' ', 'A', null, 0]]);
    assert.deepEqual(classes(C('class `notes`\nclass `linked`\nclass `A note`')),
      [['notes', null, null, 0], ['linked', null, null, 0], ['A note', null, null, 0]]);
    assert.deepEqual(classes(C('class `#126;A`')), [['#126;A', null, null, 0]]);
  });

  it('prints such a first character, and every `~` of a name, as its entity code, which both readers read and the panel draws as the character', () => {
    assert.equal(printed('~A'), 'classDiagram\nclass `#126;A`\n');
    assert.equal(printed('A~B'), 'classDiagram\nclass `A#126;B`\n');
    assert.equal(printed('note A'), 'classDiagram\nclass `#110;ote A`\n');
    assert.equal(printed('<<A'), 'classDiagram\nclass `#60;#60;A`\n');
    assert.equal(printed('"A"'), 'classDiagram\nclass `#34;A"`\n');
    assert.deepEqual(classes(printed('~A')), [['#126;A', null, null, 0]]);
    assert.deepEqual(drawn(printed('~A')), ['Class diagram', '~A']);
  });

  it('prints a bare name Mermaid reads as a keyword in backticks, its first character coded', () => {
    assert.equal(printed('link'), 'classDiagram\nclass `#108;ink`\n');
    assert.equal(printed('_self'), 'classDiagram\nclass `_self`\n');
    assert.equal(printed('notes'), 'classDiagram\nclass notes\n');
    assert.equal(printed('style'), 'classDiagram\nclass style\n');
  });
});

describe('classDiagram — a `;`', () => {
  it('is refused outside quotes, backticks, an entity code or a class body, as Mermaid refuses it', () => {
    const line = (/** @type {string} */ text) => ({ line: text });
    refuses(C('A --> B : a;b'), 'mermaid/class/semicolon', 2, line('A --> B : a;b'));
    refuses(C('A --> B : a;'), 'mermaid/class/semicolon', 2, line('A --> B : a;'));
    refuses(C('A <|-- B : x;y'), 'mermaid/class/semicolon', 2);
    refuses(C('A "1" --> "2" B : a;b'), 'mermaid/class/semicolon', 2);
    refuses(C('A : +x;y'), 'mermaid/class/semicolon', 2, line('A : +x;y'));
    refuses(C('A : +x;'), 'mermaid/class/semicolon', 2);
    refuses(C('class A;'), 'mermaid/class/semicolon', 2, line('class A;'));
    refuses(C('class A:::c;'), 'mermaid/class/semicolon', 2);
    refuses(C('class B\nA --> B : a;b\nclass C'), 'mermaid/class/semicolon', 3);
  });

  it('still reads where Mermaid reads it: coded, quoted, in backticks, in a body, in styling', () => {
    assert.deepEqual(ast(C('A --> B : a#59;b')).relations.map((/** @type {any} */ r) => r.label), ['a#59;b']);
    assert.deepEqual(classes(C('class A["a;b"]\nA "1;2" --> B\nclass `C;D`\nclass E {\n +x;y\n}\nstyle E fill:#f00;\nclassDef c fill:#f00;')),
      [['A', null, null, 0], ['B', null, null, 0], ['C;D', null, null, 0], ['E', null, null, 1]]);
    assert.deepEqual(ast(C('class A["a;b"]')).classes[0].label, 'a;b');
  });

  it('prints in a `Name : member` line as its code, which reads back', () => {
    const doc = parseMermaid(C('class A {\n +x\n}'));
    /** @type {any} */ (doc.ast).classes[0].members = [{ kind: 'attribute', visibility: '+', text: 'a;b}' }];
    const text = toMermaid(doc);
    assert.equal(text, 'classDiagram\nclass A\nA : +a#59;b}\n');
    assert.deepEqual(ast(text).classes[0].members, [{ kind: 'attribute', visibility: '+', text: 'a#59;b}' }]);
  });
});

describe('classDiagram — a class\'s `<<annotation>>`', () => {
  it('is kept, in the order written, from a body line, a head or a statement, as Mermaid keeps it', () => {
    assert.deepEqual(classes(C('class A {\n <<interface>>\n +x\n}')), [['A', null, ['interface'], 1]]);
    assert.deepEqual(classes(C('class A {\n <<a>>\n <<b>>\n}')), [['A', null, ['a', 'b'], 0]]);
    assert.deepEqual(classes(C('class A {\n << x y >>\n}')), [['A', null, [' x y '], 0]]);
    assert.deepEqual(classes(C('class A {\n<<>>\n}')), [['A', null, [''], 0]]);
    assert.deepEqual(classes(C('class A <<interface>>')), [['A', null, ['interface'], 0]]);
    assert.deepEqual(classes(C('class A~T~ <<abstract>>')), [['A', 'T', ['abstract'], 0]]);
    assert.deepEqual(classes(C('class A <<interface>> {\n +x\n}')), [['A', null, ['interface'], 1]]);
    assert.deepEqual(classes(C('class A\n<<interface>> A')), [['A', null, ['interface'], 0]]);
    assert.deepEqual(classes(C('class A\n<< x >> A\nclass B\n<<y>>B')), [['A', null, ['x'], 0], ['B', null, ['y'], 0]]);
    assert.deepEqual(classes(C('class A~T~\n<<x>> A~U~')), [['A', 'T', ['x'], 0]]);
    assert.deepEqual(classes(C('class `A B`\n<<x>> `A B`')), [['A B', null, ['x'], 0]]);
    assert.deepEqual(classes(C('A --> B\n<<interface>> B')), [['A', null, null, 0], ['B', null, ['interface'], 0]]);
    assert.deepEqual(classes(C('class A <<x>>\nclass A {\n <<y>>\n}\n<<z>> A')), [['A', null, ['x', 'y', 'z'], 0]]);
    assert.deepEqual(classes(C('class A\n<<x_y>> A\n<<1a>> A\n<<é>> A')), [['A', null, ['x_y', '1a', 'é'], 0]]);
  });

  it('keeps a body annotation holding a `<` as written, where Mermaid\'s HTML sanitizer cuts it (`<<a<b>>` is `a` there)', () => {
    // an annotation to Mermaid too, no member; only the sanitized text differs
    assert.deepEqual(classes(C('class A {\n<<a<b>>\n}')), [['A', null, ['a<b'], 0]]);
  });

  it('keeps a body line that only opens with `<<` a member, and a class with no annotation without the field', () => {
    assert.deepEqual(classes(C('class A {\n<<x>> +y\n}')), [['A', null, null, 1]]);
    assert.equal('annotations' in ast(C('class A {\n +x\n}')).classes[0], false);
  });

  it('refuses a statement that names a class not yet written, on which Mermaid fails', () => {
    refuses(C('<<interface>> A'), 'mermaid/class/annotation-unwritten', 2, { line: '<<interface>> A', name: 'A' });
    refuses(C('<<interface>> A\nclass A'), 'mermaid/class/annotation-unwritten', 2, { line: '<<interface>> A', name: 'A' });
    refuses(C('class A\n<<x>> B'), 'mermaid/class/annotation-unwritten', 3, { line: '<<x>> B', name: 'B' });
    refuses(C('<<x>> A~T~'), 'mermaid/class/annotation-unwritten', 2, { line: '<<x>> A~T~', name: 'A' });
    refuses(C('<<x>> `A B`'), 'mermaid/class/annotation-unwritten', 2, { line: '<<x>> `A B`', name: 'A B' });
    refuses(C('class A\n<<x>> A B'), 'mermaid/class/annotation-unwritten', 3, { line: '<<x>> A B', name: 'AB' });
    refuses(C('<<x>> A\nA --> B'), 'mermaid/class/annotation-unwritten', 2);
    // a class written before, by any statement, takes it
    assert.deepEqual(classes(C('A --> B\n<<x>> B\nC : +y\n<<z>> C')).map((/** @type {any} */ c) => c[2]), [null, ['x'], ['z']]);
  });

  it('refuses an annotation outside a body that is not one word, or that more text follows, as Mermaid refuses it', () => {
    const line = (/** @type {string} */ text) => ({ line: text });
    refuses(C('class A\n<<x y>> A'), 'mermaid/class/annotation', 3, line('<<x y>> A'));
    refuses(C('class A\n<<x-y>> A'), 'mermaid/class/annotation', 3);
    refuses(C('class A\n<<x.y>> A'), 'mermaid/class/annotation', 3);
    refuses(C('class A\n<<éé>> A'), 'mermaid/class/annotation', 3);
    refuses(C('class A\n<<>> A'), 'mermaid/class/annotation', 3);
    refuses(C('class A\n<<x>>'), 'mermaid/class/annotation', 3);
    refuses(C('class A <<x y>>'), 'mermaid/class/annotation', 2, line('class A <<x y>>'));
    refuses(C('class A <<x>> <<y>>'), 'mermaid/class/annotation', 2);
    refuses(C('class A <<x>>:::c'), 'mermaid/class/annotation', 2);
    refuses(C('class A <x>'), 'mermaid/class/annotation', 2);
  });

  it('prints as body lines, which read back as the same annotations', () => {
    const cases = [
      ['class A <<interface>>', 'classDiagram\nclass A {\n  <<interface>>\n}\n'],
      ['class A {\n <<a>>\n <<b x>>\n +m()\n}', 'classDiagram\nclass A {\n  <<a>>\n  <<b x>>\n  +m()\n}\n'],
    ];
    for (const [source, text] of cases) {
      assert.equal(toMermaid(parseMermaid(C(source))), text);
      assert.deepEqual(classes(text), classes(C(source)));
    }
    const doc = parseMermaid(C('class A <<x>>'));
    const cls = /** @type {any} */ (doc.ast).classes[0];
    cls.annotations = ['a}b'];
    cls.members = [{ kind: 'attribute', visibility: null, text: 'x}' }];
    const text = toMermaid(doc);
    assert.equal(text, 'classDiagram\nclass A {\n  <<a#125;b>>\n}\nA : x}\n');
    assert.deepEqual(classes(text), [['A', null, ['a#125;b'], 1]]);
  });

  it('draws the first annotation as «text» above the name, as Mermaid draws it', () => {
    assert.deepEqual(drawn(C('class A {\n <<interface>>\n +x\n}')), ['Class diagram', '«interface»', 'A', '+x']);
    assert.deepEqual(drawn(C('class A {\n <<a>>\n <<b>>\n}')), ['Class diagram', '«a»', 'A']);
    assert.deepEqual(drawn(C('class A~T~ <<abstract>>')), ['Class diagram', '«abstract»', 'A&lt;T&gt;']);
    assert.deepEqual(drawn(C('class A {\n<<a#59;b>>\n}')), ['Class diagram', '«a;b»', 'A']);
    // the annotation takes a row's height in the box
    const height = (/** @type {string} */ s) => Number(renderToString(renderMermaid(s)).match(/height="(\d+)"/)?.[1]);
    assert.equal(height(C('class A {\n <<x>>\n}')) - height(C('class A')), 22);
  });
});
