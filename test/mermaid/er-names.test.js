//@ts-check
/**
 * An entity name in quotes may hold spaces (`"PRODUCT CATEGORY"`), in a
 * relationship as in a block. The relationship pattern read a name as a run
 * of non-space characters, so `"PRODUCT CATEGORY" ||--o{ PRODUCT : has` was
 * taken for an entity block named `"PRODUCT CATEGORY" ||--o` with an
 * attribute `PRODUCT :` — the relationship vanished and the entity list
 * held a name that was never written. Quotes belong to the spelling, not the
 * name, and a name with a space prints in quotes again.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMermaid, renderMermaid, toMermaid } from '@jarenjs/mermaid';
import { renderToString } from '@jarenjs/view';

const SOURCE = `erDiagram
  "PRODUCT CATEGORY" ||--o{ PRODUCT : has
  "PRODUCT CATEGORY" {
    string id PK
  }
  PRODUCT }o--|| "SALES ORDER" : in`;

describe('erDiagram — quoted entity names', function () {
  it('reads a quoted name in a relationship and in a block as one entity', () => {
    const { ast } = parseMermaid(SOURCE);
    assert.deepEqual(ast.entities.map((/** @type {any} */ e) => e.name), ['PRODUCT CATEGORY', 'PRODUCT', 'SALES ORDER']);
    assert.deepEqual(ast.entities[0].attributes, [{ type: 'string', name: 'id', keys: ['PK'] }]);
    assert.deepEqual(ast.relationships, [
      { left: 'PRODUCT CATEGORY', right: 'PRODUCT', leftCard: '||', rightCard: 'o{', identifying: true, label: 'has' },
      { left: 'PRODUCT', right: 'SALES ORDER', leftCard: '}o', rightCard: '||', identifying: true, label: 'in' },
    ]);
  });

  it('prints a name with a space in quotes and reads it back', () => {
    const doc = parseMermaid(SOURCE);
    const text = toMermaid(doc);
    assert.match(text, /^"PRODUCT CATEGORY" \{$/m);
    assert.match(text, /^"PRODUCT CATEGORY" \|\|--o\{ PRODUCT : has$/m);
    assert.deepEqual(parseMermaid(text).ast, doc.ast);
    assert.equal(toMermaid(parseMermaid(text)), text);
  });

  it('leaves unquoted names exactly as before', () => {
    const { ast } = parseMermaid('erDiagram\n  A ||--o{ B : has\n  C {\n    int n\n  }');
    assert.deepEqual(ast.entities.map((/** @type {any} */ e) => e.name), ['A', 'B', 'C']);
    assert.equal(toMermaid(parseMermaid('erDiagram\n  A ||--o{ B : has')), 'erDiagram\nA\nB\nA ||--o{ B : has\n');
  });

  it('reads a bare entity line, so an isolated entity survives the round trip', () => {
    const doc = parseMermaid('erDiagram\n  "E F"\n  G\n  H {\n    int n\n  }');
    assert.deepEqual(doc.ast.entities.map((/** @type {any} */ e) => e.name), ['E F', 'G', 'H']);
    const text = toMermaid(doc);
    assert.deepEqual(parseMermaid(text).ast, doc.ast);
  });

  it('keeps the order of entities when a bare one precedes a block', () => {
    const doc = parseMermaid('erDiagram\n  "x y" ||--o{ "z" : x\n  "z" {\n    int n\n  }');
    const again = parseMermaid(toMermaid(doc));
    assert.deepEqual(again.ast.entities.map((/** @type {any} */ e) => e.name), doc.ast.entities.map((/** @type {any} */ e) => e.name));
    assert.deepEqual(again.ast, doc.ast);
  });

  it('an empty quoted name names nothing', () => {
    const doc = parseMermaid('erDiagram\n  "" ||--o{ A : x\n  ""\n  B');
    assert.deepEqual(doc.ast.entities.map((/** @type {any} */ e) => e.name), ['B']);
    assert.deepEqual(doc.ast.relationships, []);
  });
});

describe('erDiagram — a quoted relationship label', function () {
  it('reads the label without its quotes, draws it so and prints it back in them', () => {
    const doc = parseMermaid('erDiagram\n  A ||--o{ B : "has x"\n  B ||--|| C : owns\n  C ||--|| D : ""');
    assert.deepEqual(doc.ast.relationships.map((/** @type {any} */ r) => r.label), ['has x', 'owns', '']);
    const text = toMermaid(doc);
    assert.match(text, /^A \|\|--o\{ B : "has x"$/m);
    assert.match(text, /^B \|\|--\|\| C : owns$/m);
    assert.match(text, /^C \|\|--\|\| D : ""$/m);
    assert.deepEqual(parseMermaid(text).ast, doc.ast);
    const svg = renderToString(renderMermaid('erDiagram\n  A ||--o{ B : "has x"'));
    assert.ok(svg.includes('>A ||--o{ B : has x<'), 'the drawn relationship row');
    assert.ok(!svg.includes('"has x"') && !svg.includes('&quot;has x&quot;'), 'no quotes drawn');
  });

  it('prints a quote inside a label with spaces as its entity code, which reads back as that code', () => {
    const doc = parseMermaid('erDiagram\n  A ||--o{ B : say"hi"');
    assert.equal(doc.ast.relationships[0].label, 'say"hi"');
    assert.match(toMermaid(doc), /^A \|\|--o\{ B : say"hi"$/m);
    const spaced = { ...doc, ast: { ...doc.ast, relationships: [{ ...doc.ast.relationships[0], label: 'say "hi"' }] } };
    assert.match(toMermaid(spaced), /^A \|\|--o\{ B : "say #34;hi#34;"$/m);
  });
});
