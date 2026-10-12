//@ts-check
/**
 * A `{ … }` body (a class's members, an entity's attributes) ends at its
 * closing brace. When the source ends first the body is the rest of the
 * source, and all of it: the closing brace was looked for by cutting the
 * last character off, so the last member of an unclosed class read `ba`
 * for `-bar` and the last attribute of an entity lost its `PK`. The search
 * also rescanned the whole body for every line it added, so an unclosed
 * body of N lines cost N squared.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMermaid } from '@jarenjs/mermaid';

/** @param {string} source @returns {number} best of three, in ms */
function best(source) {
  let low = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    parseMermaid(source);
    low = Math.min(low, performance.now() - t);
  }
  return low;
}

describe('an unclosed brace body keeps all of what follows it', function () {
  it('keeps the whole last member of a class', () => {
    const { ast } = parseMermaid('classDiagram\nclass A {\n  +foo()\n  -bar');
    assert.deepEqual(ast.classes[0].members, [
      { kind: 'method', visibility: '+', text: 'foo()' },
      { kind: 'attribute', visibility: '-', text: 'bar' },
    ]);
  });

  it('keeps the keys of the last attribute of an entity', () => {
    const { ast } = parseMermaid('erDiagram\nA {\n  string name\n  int id PK');
    assert.deepEqual(ast.entities[0].attributes, [
      { type: 'string', name: 'name', keys: [] },
      { type: 'int', name: 'id', keys: ['PK'] },
    ]);
  });

  it('still ends a body at its closing brace, mid-line included', () => {
    assert.deepEqual(parseMermaid('classDiagram\nclass A { +x }').ast.classes[0].members,
      [{ kind: 'attribute', visibility: '+', text: 'x' }]);
    assert.deepEqual(parseMermaid('classDiagram\nclass A {\n  +x\n  +y }\nclass B').ast.classes.map((/** @type {any} */ c) => c.name), ['A', 'B']);
  });
});

describe('an unclosed brace body is read in linear time', function () {
  const lines = (/** @type {string} */ head, /** @type {string} */ row) => (/** @type {number} */ n) => head + '\n' + Array.from({ length: n }, () => row).join('\n');
  for (const [name, make] of [
    ['a class body', lines('classDiagram\nclass A {', '  +m()')],
    ['an entity body', lines('erDiagram\nA {', '  string a PK')],
  ]) {
    it(`${name}: eight times the lines cost far less than sixty-four times`, () => {
      const small = Math.max(best(make(4000)), 0.5);
      const large = best(make(32000));
      assert.ok(large / small < 24, `${name}: ${small.toFixed(1)} ms -> ${large.toFixed(1)} ms`);
    });
  }
});
