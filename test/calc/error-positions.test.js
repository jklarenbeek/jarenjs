//@ts-check
/**
 * A compile error names the place the call was written. Unknown functions
 * and wrong argument counts are found after parsing, from an AST that holds
 * no offsets, so they used to report line 1 column 1 wherever the call
 * stood; the parser now records where each call and constant was written,
 * in a side table that leaves the AST itself geometry-free.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { compileExpr, evaluate, parseExpression } from '@jarenjs/calc';

describe('calc — compile errors carry the position of the call', function () {
  it('places an unknown function on its own line and column', () => {
    assert.deepEqual(evaluate('1 + 2 +\n  foo(3)'), {
      ok: false,
      error: { message: "unknown function 'foo'", line: 2, column: 3 },
    });
  });

  it('places an arity error at the function name', () => {
    assert.deepEqual(evaluate('2*pi + max()'), {
      ok: false,
      error: { message: 'max() expected at least 1 argument, got 0', line: 1, column: 8 },
    });
    assert.deepEqual(evaluate('sin(1) + sin(1, 2)'), {
      ok: false,
      error: { message: 'sin() expected 1 argument, got 2', line: 1, column: 10 },
    });
  });

  it('places a constant the environment lacks', () => {
    const ast = parseExpression('1 +\n pi');
    const env = { constants: {}, funcs: {}, unops: {}, postops: {}, binops: { '+': (/** @type {number} */ a, /** @type {number} */ b) => a + b } };
    assert.throws(() => compileExpr(ast, { env }), (/** @type {any} */ e) =>
      e.message === "unknown constant 'pi'" && e.line === 2 && e.column === 2 && e.position === 5);
  });

  it('leaves a built node unpositioned, as before', () => {
    const ast = { type: 'call', name: 'nope', args: [] };
    assert.throws(() => compileExpr(ast), (/** @type {any} */ e) =>
      e.message === "unknown function 'nope'" && e.line === 1 && e.column === 1 && e.position === 0);
  });

  it('keeps the AST free of positions', () => {
    assert.deepEqual(parseExpression('f(1)'), { type: 'call', name: 'f', args: [{ type: 'num', value: 1 }] });
  });
});
