//@ts-check
/**
 * @file The externals input of the query runner: a name the query uses is
 * bound only by a member the input holds itself, and an input that is not
 * an object says so instead of leaking the engine's operator error.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { runQuery } from '../../packages/website/src/boundaries/engines.js';

const run = (query, externals) => runQuery({ query, data: '{}', externals });

describe('website — the externals of the query runner', () => {
  it('an external bound by the input runs', () => {
    const nodes = run('"$limit"', '{"limit": 5}');
    assert.strictEqual(nodes[0].kind, 'cards');
    assert.strictEqual(nodes[1].text, '5');
  });

  for (const name of ['constructor', 'toString', 'hasOwnProperty']) {
    it(`${name} is unbound until the input holds it`, () => {
      const unbound = run(`"$${name}"`, '{"x": 1}');
      assert.deepStrictEqual([unbound[0].kind, unbound[0].title], ['callout', 'Unbound externals']);
      assert.match(unbound[0].text, new RegExp(`not provided: ${name}\\.`));
      assert.strictEqual(run(`"$${name}"`, `{"${name}": 7}`)[1].text, '7');
    });
  }

  for (const externals of ['null', '5', '"text"', '[1]', 'true']) {
    it(`${externals} is not an object of externals`, () => {
      const nodes = run('"$limit"', externals);
      assert.deepStrictEqual(nodes.map((node) => [node.kind, node.title]), [['callout', 'Externals must be an object']]);
    });
  }

  it('an empty input binds nothing, and a query without externals needs none', () => {
    assert.strictEqual(run('"$limit"', '')[0].title, 'Unbound externals');
    assert.strictEqual(run('1', '')[0].kind, 'cards');
  });
});
