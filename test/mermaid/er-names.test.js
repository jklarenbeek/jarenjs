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

import { parseMermaid, toMermaid } from '@jarenjs/mermaid';

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
