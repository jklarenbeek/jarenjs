//@ts-check
/**
 * Every calculator function declares how many arguments it takes, and a
 * call outside that is refused when the expression compiles. A surplus
 * argument used to be dropped and a missing one read as `NaN`, so
 * `or(1, 2, 4)` answered 3 and `abs()` answered nothing, both as
 * `ok: true`; a name inherited from `Object.prototype` resolved as a
 * function; and a word operation on a non-finite operand leaked the
 * engine's own BigInt message.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { evaluate, defaultEnv, programmerEnv, calcToVnode } from '@jarenjs/calc';

const P = { env: programmerEnv() };
const D = { env: defaultEnv() };

/**
 * @param {string} expr @param {any} scope @param {any} opts
 * @returns {string | null} the refusal message, or null when it evaluated
 */
const refusal = (expr, scope, opts) => {
  const result = evaluate(expr, scope, opts);
  return result.ok ? null : result.error.message;
};

describe('#calc function arity', function () {
  it('refuses surplus arguments to a word function', () => {
    assert.equal(refusal('or(1,2,4)', { wordBits: 8 }, P), 'or() expected 2 arguments, got 3');
    assert.equal(refusal('xor(1,2,4)', { wordBits: 8 }, P), 'xor() expected 2 arguments, got 3');
    assert.equal(refusal('shl(1,2,3)', { wordBits: 8 }, P), 'shl() expected 2 arguments, got 3');
    assert.equal(refusal('not(1, 2)', { wordBits: 8 }, P), 'not() expected 1 argument, got 2');
  });

  it('refuses a missing argument instead of reading it as NaN', () => {
    assert.equal(refusal('xor(1)', { wordBits: 8 }, P), 'xor() expected 2 arguments, got 1');
    assert.equal(refusal('abs()', {}, D), 'abs() expected 1 argument, got 0');
    assert.equal(refusal('pow(2)', {}, D), 'pow() expected 2 arguments, got 1');
    assert.equal(refusal('min()', {}, D), 'min() expected at least 1 argument, got 0');
  });

  it('refuses surplus arguments to a float function', () => {
    assert.equal(refusal('sin(1,2)', {}, D), 'sin() expected 1 argument, got 2');
    assert.equal(refusal('sqrt(4,9)', {}, D), 'sqrt() expected 1 argument, got 2');
    assert.equal(refusal('log(100, 10, 1)', {}, D), 'log() expected 1 or 2 arguments, got 3');
    assert.equal(refusal('round(1, 2, 3)', {}, D), 'round() expected 1 or 2 arguments, got 3');
  });

  it('keeps every valid call, the variadic ones included', () => {
    assert.equal(evaluate('max(1,2,3)', {}, D).value, 3);
    assert.equal(evaluate('min(5,1,0)', {}, D).value, 0);
    assert.equal(evaluate('hypot(3,4)', {}, D).value, 5);
    assert.equal(evaluate('log(2, 8)', {}, D).value, 3);
    assert.equal(evaluate('round(2.567, 1)', {}, D).value, 2.6);
    assert.equal(evaluate('round(2.5)', {}, D).value, 3);
    assert.equal(evaluate('and(12, 10)', { wordBits: 8 }, P).value, 8);
    assert.equal(evaluate('shl(1, 3)', { wordBits: 8 }, P).value, 8);
    assert.equal(evaluate('not(0)', { wordBits: 8 }, P).value, 255);
  });

  it('is declared for every function of both environments', () => {
    for (const env of [defaultEnv(), programmerEnv()]) {
      const undeclared = Object.keys(env.funcs).filter((name) => !Object.hasOwn(env.arity, name));
      assert.deepEqual(undeclared, []);
    }
  });

  it('is a compile error the plot path renders as one', () => {
    const vnode = calcToVnode('sin(x, 2)');
    assert.match(JSON.stringify(vnode), /sin\(\) expected 1 argument, got 2/);
  });
});

describe('#calc names and operands the engine used to leak', function () {
  it('does not resolve a function through Object.prototype', () => {
    assert.equal(refusal('constructor(1)', {}, D), "unknown function 'constructor'");
    assert.equal(refusal('toString(1)', {}, D), "unknown function 'toString'");
    assert.equal(refusal('hasOwnProperty(1)', {}, D), "unknown function 'hasOwnProperty'");
  });

  it('refuses a non-finite word operand in its own words', () => {
    for (const expr of ['shl(1, 0/0)', '(1/0) & 1', '~(0/0)', 'not(1/0)', '1 << (1/0)', 'rol(1, 0/0)']) {
      const message = refusal(expr, { wordBits: 8 }, P);
      assert.ok(message !== null && !/BigInt/.test(message), `${expr}: ${message}`);
      assert.match(/** @type {string} */ (message), /^a word operand must be a finite number, got (NaN|Infinity)$/);
    }
  });
});
