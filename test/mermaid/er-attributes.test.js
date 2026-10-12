//@ts-check
/**
 * An entity attribute is `type name [keys] ["comment"]`. The quoted comment
 * had no place in the AST and was dropped, so `toMermaid` lost it, and the
 * keys were read only when separated by spaces: `PK, FK` (the comma form
 * Mermaid writes for an attribute with two keys) kept `FK` and lost `PK`.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMermaid, toMermaid } from '@jarenjs/mermaid';

const SOURCE = `erDiagram
  A {
    string id PK, FK
    string name UK "the display name"
    int count
    string note ""
  }`;

describe('erDiagram — attribute keys and comments', function () {
  it('reads comma-separated keys and the quoted comment', () => {
    const { ast } = parseMermaid(SOURCE);
    assert.deepEqual(ast.entities[0].attributes, [
      { type: 'string', name: 'id', keys: ['PK', 'FK'] },
      { type: 'string', name: 'name', keys: ['UK'], comment: 'the display name' },
      { type: 'int', name: 'count', keys: [] },
      { type: 'string', name: 'note', keys: [], comment: '' },
    ]);
  });

  it('prints them so they read back the same', () => {
    const first = parseMermaid(SOURCE);
    const text = toMermaid(first);
    assert.equal(text, 'erDiagram\nA {\n  string id PK, FK\n  string name UK "the display name"\n  int count\n  string note ""\n}\n');
    assert.deepEqual(parseMermaid(text).ast, first.ast);
  });

  it('still reads space-separated keys', () => {
    const { ast } = parseMermaid('erDiagram\nA {\n  string id PK FK\n}');
    assert.deepEqual(ast.entities[0].attributes, [{ type: 'string', name: 'id', keys: ['PK', 'FK'] }]);
  });
});
