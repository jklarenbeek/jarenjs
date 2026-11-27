//@ts-check
/**
 * What `toMermaid` prints for text Mermaid refuses as written: a `;` in a
 * sequence message, note, block label or participant alias and in a class
 * relation label prints as `#59;`, and a `"` in a click tooltip as `#34;`;
 * each reads back in this reader and in Mermaid, the print is a fixed
 * point, and the drawing decodes the code.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMermaid, toMermaid, renderMermaid } from '@jarenjs/mermaid';
import { renderToString } from '@jarenjs/view';

describe('toMermaid — a `;` Mermaid refuses', () => {
  it('prints as #59; in a sequence message, note, block label and participant alias', () => {
    const doc = parseMermaid('sequenceDiagram\nparticipant A as x\nA->>B: m\nnote left of A: n\nalt l\nA->>B: z\nelse e\nA->>B: w\nend');
    const ast = /** @type {any} */ (doc.ast);
    ast.participants[0].label = 'a;b';
    ast.statements[0].text = 'c;d';
    ast.statements[1].text = 'e;f';
    ast.statements[2].branches[0].label = 'g;h';
    ast.statements[2].branches[1].label = 'i;j';
    const text = toMermaid(doc);
    assert.equal(text, 'sequenceDiagram\nparticipant A as a#59;b\nparticipant B\nA->>B: c#59;d\nnote left of A: e#59;f\n'
      + 'alt g#59;h\n  A->>B: z\nelse i#59;j\n  A->>B: w\nend\n');
    const again = /** @type {any} */ (parseMermaid(text).ast);
    assert.deepEqual([again.participants[0].label, again.statements[0].text, again.statements[1].text,
      again.statements[2].branches.map((/** @type {any} */ b) => b.label)], ['a#59;b', 'c#59;d', 'e#59;f', ['g#59;h', 'i#59;j']]);
    assert.equal(toMermaid(parseMermaid(text)), text);
    const svg = renderToString(renderMermaid(text));
    assert.ok(svg.includes('a;b') && svg.includes('c;d') && svg.includes('e;f') && !svg.includes('#59;'), svg);
  });

  it('prints as #59; in a class relation label', () => {
    const doc = parseMermaid('classDiagram\nA --> B : x');
    /** @type {any} */ (doc.ast).relations[0].label = 'g;h';
    const text = toMermaid(doc);
    assert.equal(text, 'classDiagram\nclass A\nclass B\nA --> B : g#59;h\n');
    assert.equal(/** @type {any} */ (parseMermaid(text).ast).relations[0].label, 'g#59;h');
    assert.equal(toMermaid(parseMermaid(text)), text);
    assert.ok(renderToString(renderMermaid(text)).includes('A --&gt; B : g;h'));
  });
});

describe('toMermaid — a `"` in a click tooltip', () => {
  for (const [source, printed] of [
    ['flowchart LR\nA\nclick A href "https://e" "t"', 'flowchart LR\nA\nclick A href "https://e" "a#34;b"\n'],
    ['classDiagram\nclass A\nclick A href "u" "t"', 'classDiagram\nclass A\nclick A href "u" "a#34;b"\n'],
  ]) {
    it(`prints as #34;, which reads back and shows the quote: ${source.split('\n')[0]}`, () => {
      const doc = parseMermaid(source);
      /** @type {any} */ (doc.ast).clicks[0].tooltip = 'a"b';
      const text = toMermaid(doc);
      assert.equal(text, printed);
      assert.equal(/** @type {any} */ (parseMermaid(text).ast).clicks[0].tooltip, 'a#34;b');
      assert.equal(toMermaid(parseMermaid(text)), text);
      assert.deepEqual(renderToString(renderMermaid(text)).match(/<desc>[^<]*<\/desc>/g), ['<desc>a"b</desc>']);
    });
  }
});
