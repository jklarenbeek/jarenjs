//@ts-check
/**
 * The programmer environment keeps a division's remainder past 2^53: a
 * division on the exact path answers the exact fraction (a `Ratio`) when
 * the quotient is not whole, so multiplying it back gives the dividend, as
 * `7/2*2` is `7`. A `bigint` scope value is the integer it holds there, and
 * `toExpression` prints an integer beyond 2^53 as the exact integer.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { evaluate, compileExpr, programmerEnv, parseExpression, toExpression } from '@jarenjs/calc';
import { evaluateExact, compileExact } from '../../components/calc/src/compile.js';
import { Ratio } from '../../components/calc/src/exact.js';
import { num } from '../../components/calc/src/ast.js';
import { calcEditEffects } from '../../components/calc/src/component/index.js';

const env = programmerEnv();
const U64 = { wordBits: 64, signed: false };
const S64 = { wordBits: 64, signed: true };

/**
 * The exact value of `source` in the programmer environment.
 * @param {string} source @param {any} [scope]
 * @returns {any}
 */
function exact(source, scope = U64) {
  const got = evaluateExact(source, scope, { env });
  assert.ok(got.ok, source);
  return got.value;
}

/**
 * Assert each source's exact value: a whole one by value and type, a
 * fraction by its numerator and denominator.
 * @param {[string, number | bigint | Ratio][]} cases @param {any} [scope]
 */
function expectExact(cases, scope = U64) {
  for (const [source, expected] of cases) {
    const value = exact(source, scope);
    if (expected instanceof Ratio) {
      assert.ok(value instanceof Ratio, `${source} is a Ratio`);
      assert.deepEqual([value.n, value.d], [expected.n, expected.d], source);
    }
    else {
      assert.equal(value, expected, source);
      assert.equal(typeof value, typeof expected, source);
    }
  }
}

/**
 * Run the `=` effect on `entry` and return what it commits.
 * @param {string} entry @param {any} props
 * @returns {any}
 */
function commit(entry, props) {
  /** @type {any[]} */
  const seen = [];
  calcEditEffects['calc-eval']({ entry, mode: 'programmer', base: 'HEX', ...props }, (_, payload) => seen.push(payload));
  assert.equal(seen.length, 1, `${entry} commits once`);
  return seen[0];
}

const HALF = '((2^53+1)/2)'; // 4503599627370496.5, which no double holds

describe('#calc programmer division keeps its remainder past 2^53', function () {
  it('answers the exact fraction when a division on the exact path is not whole', () => {
    expectExact([
      ['0xFFFFFFFFFFFFFFFF/2', new Ratio(18446744073709551615n, 2n)],
      ['(0-0xFFFFFFFFFFFFFFFF)/2', new Ratio(-18446744073709551615n, 2n)],
      ['0xFFFFFFFFFFFFFFFF%', new Ratio(3689348814741910323n, 20n)],
      [HALF, new Ratio(9007199254740993n, 2n)],
      ['0x8000000000000000/6', new Ratio(4611686018427387904n, 3n)],
      ['0xFFFFFFFFFFFFFFFF/0xFFFFFFFFFFFFFFFE', new Ratio(18446744073709551615n, 18446744073709551614n)],
      ['0x7FFFFFFFFFFFFFFF/0x1000000000000000', new Ratio(9223372036854775807n, 1152921504606846976n)],
      ['0x8000000000000000/0x1000000000000000', 8],
      ['0xFFFFFFFFFFFFFFFF/0', Infinity],
      ['0/0xFFFFFFFFFFFFFFFF', 0],
      [`${HALF}/0`, Infinity],
    ]);
  });

  it('multiplies the quotient back to the dividend, as 7/2*2 is 7', () => {
    expectExact([
      ['7/2*2', 7],
      ['(2^53+1)/2*2', 9007199254740993n],
      ['0x7FFFFFFFFFFFFFFF/2*2', 9223372036854775807n],
      ['(-2)^63/3*3', -9223372036854775808n],
      ['(2^64+1)/2*2', 18446744073709551617n],
      ['0xFFFFFFFFFFFFFFFF/0x1000000000000000*0x1000000000000000', 18446744073709551615n],
      [`(2^53+3)/2-${HALF}`, 1],
      [`${HALF}+${HALF}`, 9007199254740993n],
      [`${HALF}/${HALF}`, 1],
      [`3/${HALF}*${HALF}`, 3],
      [`-${HALF}*2`, -9007199254740993n],
      [`${HALF}^2*4`, 81129638414606699710187514626049n],
      [`pow(${HALF}, 3)`, new Ratio(730750818665451702490757660178213618792745926657n, 8n)],
    ]);
  });

  it('takes the float path again beside a fractional Number', () => {
    expectExact([
      ['0xFFFFFFFFFFFFFFFF/2*0.5', 4611686018427387904],
      [`${HALF}^0.5`, Math.pow(4503599627370496, 0.5)],
      [`${HALF}^-1`, Math.pow(4503599627370496, -1)],
      // a numerator power past a double is the float power
      [`((2^64+1)/2^60)^20`, 2 ** 80],
      [`sqrt(0xFFFFFFFFFFFFFFFF/2)`, Math.sqrt(2 ** 63)],
      [`${HALF}!`, Infinity],
    ]);
  });

  it('answers ±Infinity for a fraction past what a double holds', () => {
    expectExact([
      ['2^1023/((2^64+1)/2^66)', Infinity],
      ['(0-2^1023)/((2^64+1)/2^66)', -Infinity],
    ]);
  });

  it('rounds the fraction once to the nearest Number at the public boundary', () => {
    // 9007199254740993.5 is nearer 9007199254740994 than 9007199254740992
    assert.equal(evaluate('(2^55+6)/4', U64, { env }).value, 9007199254740994);
    assert.equal(evaluate('0-(2^55+6)/4', U64, { env }).value, -9007199254740994);
    assert.equal(compileExpr(parseExpression('(2^55+6)/4'), { env })(U64), 9007199254740994);
    // a tie rounds to even, as the double of the decimal text does
    assert.equal(evaluate(HALF, U64, { env }).value, 4503599627370496);
    assert.equal(evaluate('1/2^60', U64, { env }).value, 2 ** -60);
    // 9007199254740993.2 is past the tie between its two doubles, so it rounds up
    assert.equal(evaluate('(5*2^53+6)/5', U64, { env }).value, 9007199254740994);
    assert.equal(evaluate('0-(5*2^53+6)/5', U64, { env }).value, -9007199254740994);
    // far below 1, and below the normal range, where a double's step is 2^-1074
    assert.equal(evaluate('1/2^1020/3', U64, { env }).value, 2 ** -1020 / 3);
    assert.equal(evaluate('1/2^1021/3', U64, { env }).value, 2 ** -1021 / 3);
    assert.equal(evaluate('1/2^1000/(2^70*7)', U64, { env }).value, 2 ** -1070 / 7);
    // 7.99999999999999999913 is nearer 8 than 7; its word is still 7
    assert.equal(evaluate('0x7FFFFFFFFFFFFFFF/0x1000000000000000', U64, { env }).value, 8);
    assert.equal(commit('0x7FFFFFFFFFFFFFFF/0x1000000000000000', U64).display, '0x7');
  });

  it('reads the word of a fraction by its whole part, truncated toward zero', () => {
    expectExact([
      ['0xFFFFFFFFFFFFFFFF/2 & 0xFF', 255],
      ['not(0xFFFFFFFFFFFFFFFF/2)', 9223372036854775808n],
      [`shl(1, (2^64+1)/2^63)`, 4],
    ]);
    expectExact([[`(0-0xFFFFFFFFFFFFFFFF)/2 | 0`, -9223372036854775807n]], S64);
  });

  it('rounds a fraction exactly, half toward +Infinity as Math.round does', () => {
    expectExact([
      [`trunc(${HALF})`, 4503599627370496],
      [`floor(${HALF})`, 4503599627370496],
      [`ceil(${HALF})`, 4503599627370497],
      [`round(${HALF})`, 4503599627370497],
      [`trunc(-${HALF})`, -4503599627370496],
      [`floor(-${HALF})`, -4503599627370497],
      [`ceil(-${HALF})`, -4503599627370496],
      [`round(-${HALF})`, -4503599627370496],
      ['round(0xFFFFFFFFFFFFFFFF/2)', 9223372036854775808n],
      ['floor(0xFFFFFFFFFFFFFFFF/2)', 9223372036854775807n],
      [`round(${HALF}, 2)`, 4503599627370496],
    ]);
  });

  it('keeps abs, min, max and negation of a fraction exact', () => {
    expectExact([
      [`abs(-${HALF})`, new Ratio(9007199254740993n, 2n)],
      [`abs(${HALF})`, new Ratio(9007199254740993n, 2n)],
      [`-${HALF}`, new Ratio(-9007199254740993n, 2n)],
      [`min(${HALF}, 4503599627370497)`, new Ratio(9007199254740993n, 2n)],
      [`max(${HALF}, 4503599627370496)`, new Ratio(9007199254740993n, 2n)],
      [`min(${HALF}, (2^53+3)/2)`, new Ratio(9007199254740993n, 2n)],
      [`max(4503599627370496, ${HALF})`, new Ratio(9007199254740993n, 2n)],
      [`min(4503599627370497, ${HALF})`, new Ratio(9007199254740993n, 2n)],
      [`max(${HALF}, 0.5)`, new Ratio(9007199254740993n, 2n)],
      [`min(${HALF}, 0.5)`, 0.5],
      [`max(inf, ${HALF})`, Infinity],
      [`min(${HALF}, nan)`, NaN],
    ]);
  });

  it('divides a whole Number beyond the safe range exactly, as a bigint divides', () => {
    for (const x of [2 ** 60, 2n ** 60n, '1152921504606846976']) {
      const scope = { ...U64, x };
      expectExact([
        ['x/3', new Ratio(1152921504606846976n, 3n)],
        ['x/3*3', 1152921504606846976n],
        ['3/x', new Ratio(3n, 1152921504606846976n)],
      ], scope);
    }
    // two safe Numbers still divide as floats
    assert.equal(exact('x/3', { ...U64, x: 7 }), 7 / 3);
  });
});

describe('#calc the calculator commits the word of an exact quotient', function () {
  it('shows and commits the dividend a quotient multiplies back to', () => {
    const all = commit('0xFFFFFFFFFFFFFFFF/2*2', U64);
    assert.equal(all.display, '0xFFFF FFFF FFFF FFFF');
    assert.equal(all.exact, '18446744073709551615');
    assert.equal(all.entry, '0xFFFFFFFFFFFFFFFF');
    const half = commit('0xFFFFFFFFFFFFFFFF/2', U64);
    assert.equal(half.display, '0x7FFF FFFF FFFF FFFF');
    assert.equal(half.exact, '9223372036854775807');
  });

  it('wraps the exact quotient to the word', () => {
    // 2^64 + 1 wraps to 1 on an unsigned 64-bit word, 2^63 to -2^63 on a signed one
    const one = commit('(2^64+1)/2*2', U64);
    assert.equal(one.display, '0x1');
    assert.equal(one.value, 1);
    const min = commit('0x7FFFFFFFFFFFFFFF/2*2+1', S64);
    assert.equal(min.display, '0x8000 0000 0000 0000');
    assert.equal(min.exact, '-9223372036854775808');
  });
});

describe('#calc a bigint scope value', function () {
  it('is the integer it holds in the programmer environment', () => {
    expectExact([
      ['x', 9007199254740993n],
      ['x-1', 9007199254740992n],
    ], { ...U64, x: 2n ** 53n + 1n });
    expectExact([['x', 9223372036854775807n]], { ...U64, x: 2n ** 63n - 1n });
    expectExact([['x', -9223372036854775808n]], { ...S64, x: -(2n ** 63n) });
    expectExact([['x', 5]], { ...U64, x: 5n });
    expectExact([['x', Infinity]], { ...U64, x: 2n ** 1100n });
  });

  it('wraps to the word as the integer it is', () => {
    expectExact([['x & 0xFFFFFFFFFFFFFFFF', 1]], { ...U64, x: 2n ** 64n + 1n });
    expectExact([['x | 0', -9223372036854775808n]], { ...S64, x: 2n ** 63n });
  });

  it('answers the nearest Number at the public boundary', () => {
    assert.equal(evaluate('x', { ...U64, x: 2n ** 53n + 1n }, { env }).value, 9007199254740992);
  });

  it('is refused outside the programmer environment, as it always was', () => {
    assert.deepEqual(evaluate('x', { x: 5n }), {
      ok: false, error: { message: 'Cannot convert a BigInt value to a number', line: undefined, column: undefined },
    });
  });
});

describe('#calc toExpression prints an integer beyond 2^53 exactly', function () {
  it('prints the integer a literal was written as', () => {
    /** @type {[string, string][]} */
    const CASES = [
      ['9007199254740993', '9007199254740993'],
      ['0x7FFFFFFFFFFFFFFF', '9223372036854775807'],
      ['-9223372036854775808', '-9223372036854775808'],
      ['0xFFFFFFFFFFFFFFFF + 1', '18446744073709551615 + 1'],
      ['0xFFFFFFFFFFFFFFFFFFFF', '1208925819614629174706175'],
      ['9007199254740992', '9007199254740992'],
      ['1e300', '1e+300'],
      ['0xFF', '255'],
    ];
    for (const [source, printed] of CASES) assert.equal(toExpression(parseExpression(source)), printed, source);
  });

  it('prints the integer a built Number stands for', () => {
    assert.equal(toExpression(num(2 ** 64)), '18446744073709551616');
    assert.equal(toExpression(num(1e21)), '1e+21');
  });

  it('reads back the integer it printed, and the same AST', () => {
    const sources = ['9007199254740993', '0x7FFFFFFFFFFFFFFF', '-9223372036854775808', '0xFFFFFFFFFFFFFFFF + 1', '0xFFFFFFFFFFFFFFFFFFFF', '1e300'];
    for (const source of sources) {
      const ast = parseExpression(source);
      const again = parseExpression(toExpression(ast));
      assert.deepEqual(again, ast, source);
      assert.equal(compileExact(again, { env })(U64), compileExact(ast, { env })(U64), source);
    }
    const built = num(2 ** 64);
    assert.equal(compileExact(parseExpression(toExpression(built)), { env })(U64), compileExact(built, { env })(U64));
  });
});
