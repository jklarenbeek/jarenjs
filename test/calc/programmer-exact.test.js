//@ts-check
/**
 * Programmer mode computes its integer operations exactly: a result past
 * 2^53 is the integer it is, not a rounded float wrapped to the word. The
 * public `evaluate` still answers a `Number`; the exact value is what the
 * calculator's display and the committed entry are built from.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { evaluate, programmerEnv, parseExpression, compileExpr, wordViews, programmerMode } from '@jarenjs/calc';
import { calcEditEffects, contributeCalcViewModel, calcInitialState } from '../../components/calc/src/component/index.js';
import { evaluateExact, compileExact } from '../../components/calc/src/compile.js';
import { num, binary } from '../../components/calc/src/ast.js';

/**
 * Run the `=` effect on `entry` and return what it commits.
 * @param {string} entry @param {any} props
 * @returns {{ value: number, display: string, entry: string }}
 */
function commit(entry, props) {
  /** @type {any[]} */
  const seen = [];
  calcEditEffects['calc-eval']({ entry, mode: 'programmer', ...props }, (name, payload) => seen.push([name, payload]));
  assert.equal(seen.length, 1, `${entry} commits once`);
  return seen[0][1];
}

const U64 = { wordBits: 64, signed: false };
const S64 = { wordBits: 64, signed: true };

describe('#calc programmer mode is exact past 2^53', function () {
  it('shows a 64-bit result as the word it is, in every base', () => {
    /** @type {[string, any, string, string][]} */
    const CASES = [
      ['0xFFFFFFFFFFFFFFFF', U64, 'HEX', '0xFFFF FFFF FFFF FFFF'],
      ['0xFFFFFFFFFFFFFFFF', U64, 'DEC', '18446744073709551615'],
      ['0xFFFFFFFFFFFFFFFF', S64, 'DEC', '-1'],
      ['0x7FFFFFFFFFFFFFFF', S64, 'DEC', '9223372036854775807'],
      ['0x7FFFFFFFFFFFFFFF', U64, 'HEX', '0x7FFF FFFF FFFF FFFF'],
      ['0x8000000000000001', U64, 'DEC', '9223372036854775809'],
      ['9007199254740993', U64, 'DEC', '9007199254740993'],
      ['9007199254740991+2', U64, 'DEC', '9007199254740993'],
      ['0x8000000000000000+1', S64, 'DEC', '-9223372036854775807'],
      ['0xFFFFFFFF*0xFFFFFFFF', U64, 'HEX', '0xFFFF FFFE 0000 0001'],
      ['0xFFFFFFFFFFFFFFFF+1', U64, 'HEX', '0x0'],
      ['0x0-1', U64, 'HEX', '0xFFFF FFFF FFFF FFFF'],
      ['2^64-1', U64, 'HEX', '0xFFFF FFFF FFFF FFFF'],
      ['2^63', U64, 'HEX', '0x8000 0000 0000 0000'],
      ['-0x7FFFFFFFFFFFFFFF', S64, 'DEC', '-9223372036854775807'],
      ['0xFFFFFFFFFFFFFFFF/2', U64, 'HEX', '0x7FFF FFFF FFFF FFFF'],
      ['0xFFFFFFFFFFFFFFFE/2', U64, 'HEX', '0x7FFF FFFF FFFF FFFF'],
      ['0x123456789ABCDEF1*3', U64, 'HEX', '0x369D 0369 D036 9CD3'],
    ];
    for (const [entry, props, base, display] of CASES) {
      const committed = commit(entry, { base, ...props });
      assert.equal(committed.display, display, `${entry} on a ${props.signed ? 'signed' : 'unsigned'} 64-bit word in ${base}`);
    }
  });

  it('applies the word operators and functions to the whole word', () => {
    /** @type {[string, any, string, string][]} */
    const CASES = [
      ['not(0)', U64, 'HEX', '0xFFFF FFFF FFFF FFFF'],
      ['~0', U64, 'HEX', '0xFFFF FFFF FFFF FFFF'],
      ['0xFFFFFFFFFFFFFFFF & 0xFF00000000000001', U64, 'HEX', '0xFF00 0000 0000 0001'],
      ['0xF000000000000000 | 0x0F00000000000001', U64, 'HEX', '0xFF00 0000 0000 0001'],
      ['0xFFFFFFFFFFFFFFFF << 4', U64, 'HEX', '0xFFFF FFFF FFFF FFF0'],
      ['0xFFFFFFFFFFFFFFFF >> 4', U64, 'HEX', '0xFFF FFFF FFFF FFFF'],
      ['shl(1, 63) | 1', U64, 'HEX', '0x8000 0000 0000 0001'],
      ['and(0xFFFFFFFFFFFFFFFF, 0x8000000000000001)', U64, 'HEX', '0x8000 0000 0000 0001'],
      ['or(0x8000000000000000, 0x1)', U64, 'HEX', '0x8000 0000 0000 0001'],
      ['xor(0xFFFFFFFFFFFFFFFF, 0x8000000000000001)', U64, 'HEX', '0x7FFF FFFF FFFF FFFE'],
      ['not(0x8000000000000001)', U64, 'HEX', '0x7FFF FFFF FFFF FFFE'],
      ['shr(0x8000000000000001, 1)', U64, 'HEX', '0x4000 0000 0000 0000'],
      ['rol(0x8000000000000001, 1)', U64, 'HEX', '0x3'],
      ['ror(0x8000000000000001, 1)', U64, 'HEX', '0xC000 0000 0000 0000'],
      ['mod(0xFFFFFFFFFFFFFFFF, 10)', U64, 'DEC', '5'],
      ['mod(0xFFFFFFFFFFFFFFFF, 0x8000000000000000)', U64, 'HEX', '0x7FFF FFFF FFFF FFFF'],
    ];
    for (const [entry, props, base, display] of CASES) {
      const committed = commit(entry, { base, ...props });
      assert.equal(committed.display, display, entry);
    }
  });

  it('keeps abs, min, max and the whole-number roundings exact on a big operand', () => {
    /** @type {[string, any, string, string][]} */
    const CASES = [
      ['abs(-0x7FFFFFFFFFFFFFFF)', S64, 'DEC', '9223372036854775807'],
      ['max(0x7FFFFFFFFFFFFFFE, 0x7FFFFFFFFFFFFFFF)', S64, 'DEC', '9223372036854775807'],
      ['min(0x7FFFFFFFFFFFFFFF, 0x7FFFFFFFFFFFFFFE, 5)', S64, 'DEC', '5'],
      ['floor(0x7FFFFFFFFFFFFFFF)', S64, 'DEC', '9223372036854775807'],
      ['ceil(0x7FFFFFFFFFFFFFFF)', S64, 'DEC', '9223372036854775807'],
      ['trunc(0x7FFFFFFFFFFFFFFF)', S64, 'DEC', '9223372036854775807'],
      ['round(0x7FFFFFFFFFFFFFFF)', S64, 'DEC', '9223372036854775807'],
      ['pow(2, 64) - 1', U64, 'DEC', '18446744073709551615'],
    ];
    for (const [entry, props, base, display] of CASES) {
      assert.equal(commit(entry, { base, ...props }).display, display, entry);
    }
  });

  it('commits an entry that evaluates to the same word again', () => {
    for (const entry of ['0xFFFFFFFFFFFFFFFF', 'not(0)', '0x123456789ABCDEF1*3', '2^64-1', '9007199254740991+2']) {
      const first = commit(entry, { base: 'HEX', ...U64 });
      const again = commit(first.entry, { base: 'HEX', ...U64 });
      assert.equal(again.display, first.display, entry);
      assert.equal(again.entry, first.entry, entry);
    }
  });

  it('shows the live four-base view of a big result', () => {
    const views = commit('0x8000000000000001', { base: 'HEX', ...U64 });
    assert.equal(views.display, '0x8000 0000 0000 0001');
    assert.deepEqual(wordViews(2 ** 53, 64, false), {
      hex: '20 0000 0000 0000', dec: '9007199254740992', oct: '400 000 000 000 000 000', bin: '0000 0000 0010 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000 0000',
    });
  });

  it('derives the live display and the four-base view of a big entry from the exact word', () => {
    const state = { calc: { ...calcInitialState(), mode: 'programmer', base: 'HEX', wordBits: 64, entry: 'not(0)' } };
    const vm = contributeCalcViewModel(state);
    assert.equal(vm.display.result, '0xFFFF FFFF FFFF FFFF');
    assert.equal(vm.display.error, null);
    assert.equal(vm.bases.views.hex, 'FFFF FFFF FFFF FFFF');
    assert.equal(vm.bases.views.dec, '18446744073709551615');
    assert.equal(vm.bases.views.oct, '1 777 777 777 777 777 777 777');
  });

  it('still refuses a bigint scope value, as the Number-only scope always did', () => {
    const env = programmerEnv();
    assert.deepEqual(evaluate('ans & 0xFF', { wordBits: 64, signed: false, ans: 0xFFFFFFFFFFFFFFFFn }, { env }), {
      ok: false, error: { message: 'Cannot convert a BigInt value to a number', line: undefined, column: undefined },
    });
  });
});

describe('#calc programmer mode answers a Number at the public boundary', function () {
  it('rounds a big result to the nearest Number, as it always did', () => {
    const env = programmerEnv();
    const U = { wordBits: 64, signed: false };
    assert.equal(evaluate('0xFFFFFFFFFFFFFFFF', U, { env }).value, 18446744073709552000);
    assert.equal(evaluate('not(0)', U, { env }).value, 18446744073709552000);
    assert.equal(evaluate('0xFFFFFFFFFFFFFFFF & 0xFF00000000000001', U, { env }).value, 18374686479671624000);
    assert.equal(evaluate('2^64-1', U, { env }).value, 18446744073709552000);
    const fn = compileExpr(parseExpression('0x7FFFFFFFFFFFFFFF'), { env });
    assert.equal(typeof fn({}), 'number');
  });

  it('leaves the standard environment on floats', () => {
    assert.equal(evaluate('9007199254740993+0').value, 9007199254740992);
    assert.equal(evaluate('0xFFFFFFFFFFFFFFFF').value, 18446744073709552000);
  });
});

describe('#calc programmer answers that were already right do not move', function () {
  it('keeps float arithmetic, fractions and non-finite results as they were', () => {
    const env = programmerEnv();
    const U = { wordBits: 64, signed: false };
    /** @type {[string, number][]} */
    const CASES = [
      ['7/2*2', 7],
      ['7/2', 3.5],
      ['1/0', Infinity],
      ['-1/0', -Infinity],
      ['0/0', NaN],
      ['2^1024', Infinity],
      ['2^-1', 0.5],
      ['2^0.5', Math.SQRT2],
      ['sqrt(16)', 4],
      ['10%', 0.1],
      ['4!', 24],
      ['0.5*4', 2],
      ['-0', -0],
      ['3^33', 5559060566555523],
      ['9007199254740991+1', 9007199254740992],
      ['0xFF & 0x0F', 15],
      ['0xFFFFFFFF+1', 4294967296],
      ['max(1, 3, 2)', 3],
      ['min(1, 3, 2)', 1],
      ['abs(-5)', 5],
      ['floor(2.5)', 2],
      ['round(2.567, 2)', 2.57],
      ['sin(0)', 0],
      ['mod(7, 3)', 1],
      ['shl(1, 4)', 16],
    ];
    for (const [source, expected] of CASES) {
      const got = evaluate(source, U, { env });
      assert.ok(got.ok, source);
      assert.ok(Object.is(got.value, expected), `${source}: ${String(got.value)}`);
    }
    assert.equal(evaluate('~5', { wordBits: 32, signed: false }, { env }).value, 4294967290);
  });

  it('keeps the refusals and their words', () => {
    const env = programmerEnv();
    const U = { wordBits: 64, signed: false };
    assert.deepEqual(evaluate('x & 1', U, { env }), {
      ok: false, error: { message: 'a word operand must be a finite number, got NaN', line: undefined, column: undefined },
    });
    assert.deepEqual(evaluate('mod(5, 0)', U, { env }), {
      ok: false, error: { message: 'wMod: division by zero', line: undefined, column: undefined },
    });
    assert.equal(commit('1/0', { base: 'DEC', ...U }).display, '—');
    assert.equal(commit('2^1024', { base: 'DEC', ...U }).display, '—');
    assert.equal(commit('7/2*2', { base: 'DEC', ...U }).display, '7');
    const huge = '0x' + 'F'.repeat(300);
    assert.equal(evaluate(huge, U, { env }).value, Infinity);
    assert.equal(commit(huge, { base: 'DEC', ...U }).display, '—');
  });

  it('bounds a power so it cannot grow without limit', () => {
    const env = programmerEnv();
    const U = { wordBits: 64, signed: false };
    assert.equal(evaluate('(2^1000)^1000', U, { env }).value, Infinity);
    assert.equal(evaluate('9^999999', U, { env }).value, Infinity);
    assert.equal(evaluate('3^100000000', U, { env }).value, Infinity);
    assert.equal(evaluate('3^1000000000', U, { env }).value, Infinity);
    assert.equal(evaluate('0-(3^100000000)', U, { env }).value, -Infinity);
  });
});

describe('#calc programmer exact values', function () {
  const env = programmerEnv();
  const W64 = { wordBits: 64, signed: false };

  it('holds a whole number as a Number while it is safe and a bigint past that', () => {
    /** @type {[string, number | bigint][]} */
    const CASES = [
      ['0xFF', 255],
      ['0xFFFFFFFFFFFFFFFF', 18446744073709551615n],
      ['0o1777777777777777777777', 18446744073709551615n],
      ['0b1' + '0'.repeat(63), 9223372036854775808n],
      ['9007199254740992', 9007199254740992n],
      ['9007199254740991', 9007199254740991],
      ['9007199254740991+1', 9007199254740992n],
      ['9007199254740992-1', 9007199254740991],
      ['1e20+1', 100000000000000000001n],
      ['2^64', 18446744073709551616n],
      ['(-2)^63', -9223372036854775808n],
      ['3^40', 12157665459056928801n],
      ['2^1023*2', Infinity],
      ['0-0xFFFFFFFFFFFFFFFF', -18446744073709551615n],
      ['-(0-0xFFFFFFFFFFFFFFFF)', 18446744073709551615n],
      ['0xFFFFFFFFFFFFFFFF*0xFFFFFFFFFFFFFFFF', 340282366920938463426481119284349108225n],
      ['0.5+0xFFFFFFFFFFFFFFFF', 18446744073709552000],
      ['sqrt(0xFFFFFFFFFFFFFFFF)', 4294967296],
      ['0xFFFFFFFFFFFFFFFF!', Infinity],
      ['min(nan, 0xFFFFFFFFFFFFFFFF)', NaN],
      ['max(0xFFFFFFFFFFFFFFFF, nan)', NaN],
      ['1.5^200', Math.pow(1.5, 200)],
      ['round(0x7FFFFFFFFFFFFFFF, 2)', Math.round(2 ** 63 * 100) / 100],
    ];
    for (const [source, expected] of CASES) {
      const got = evaluateExact(source, W64, { env });
      assert.ok(got.ok, source);
      assert.equal(got.value, expected, source);
      assert.equal(typeof got.value, typeof expected, source);
    }
  });

  it('divides a big whole number exactly, or truncates what a double could not hold', () => {
    /** @type {[string, number | bigint][]} */
    const CASES = [
      ['0x8000000000000000/0x1000000000000000', 8],
      ['0xFFFFFFFFFFFFFFFF/3', 6148914691236517205n],
      ['0xFFFFFFFFFFFFFFFF/2', 9223372036854775807n],
      ['(0-0xFFFFFFFFFFFFFFFF)/2', -9223372036854775807n],
      ['0xFFFFFFFFFFFFFFFF/0xFFFFFFFFFFFFFFFE', 1],
      ['0x7FFFFFFFFFFFFFFF/0x1000000000000000', 7],
      ['0xFFFFFFFFFFFFFFFF/0', Infinity],
      ['(0-0xFFFFFFFFFFFFFFFF)/0', -Infinity],
      ['0xFFFFFFFFFFFFFFFF/0.5', 36893488147419103000],
      ['0xFFFFFFFFFFFFFFFF%', 184467440737095516n],
    ];
    for (const [source, expected] of CASES) {
      const got = evaluateExact(source, W64, { env });
      assert.ok(got.ok, source);
      assert.equal(got.value, expected, source);
      assert.equal(typeof got.value, typeof expected, source);
    }
  });

  it('reads a built literal and a parsed one alike', () => {
    assert.equal(compileExact(num(2 ** 64), { env })(W64), 18446744073709551616n);
    assert.equal(compileExact(binary('+', num(2 ** 64), num(1)), { env })(W64), 18446744073709551617n);
    assert.equal(evaluateExact('ans', { ...W64, ans: '7' }, { env }).value, 7);
    assert.deepEqual(parseExpression('0xFFFFFFFFFFFFFFFF'), { type: 'num', value: 18446744073709552000 });
    assert.deepEqual(parseExpression('0xFF'), { type: 'num', value: 255 });
  });

  it('keeps a bigint scope value a refusal outside the programmer environment', () => {
    const got = evaluate('x+1', { x: 2n ** 64n });
    assert.deepEqual(got, { ok: false, error: { message: 'Cannot convert a BigInt value to a number', line: undefined, column: undefined } });
  });

  it('refuses a word operand with no integer to become, as it did', () => {
    assert.equal(/** @type {any} */ (evaluate('0xFFFFFFFFFFFFFFFF & nan', W64, { env })).error.message,
      'a word operand must be a finite number, got NaN');
    assert.equal(/** @type {any} */ (evaluate('shl(1, inf)', W64, { env })).error.message,
      'a word operand must be a finite number, got Infinity');
  });
});

describe('#calc programmer unary plus and the mode formatter', function () {
  it('leaves a value as it is under unary plus, big or not', () => {
    const env = programmerEnv();
    const W64 = { wordBits: 64, signed: false };
    assert.equal(evaluate('+5', W64, { env }).value, 5);
    assert.equal(evaluate('+-5', { wordBits: 64, signed: true }, { env }).value, -5);
    assert.equal(evaluateExact('+0xFFFFFFFFFFFFFFFF', W64, { env }).value, 18446744073709551615n);
    assert.equal(commit('+0xFFFFFFFFFFFFFFFF', { base: 'HEX', ...W64 }).display, '0xFFFF FFFF FFFF FFFF');
  });

  it('formats a Number through the public mode descriptor', () => {
    assert.equal(programmerMode.format(255, { base: 'HEX' }), '0xFF');
    assert.equal(programmerMode.format(255, { base: 'BIN', wordBits: 8 }), '0b1111 1111');
    assert.equal(programmerMode.format(-1, { base: 'DEC', wordBits: 8, signed: true }), '-1');
    assert.equal(programmerMode.format(255, { base: 'OCT' }), '0o377');
    assert.equal(programmerMode.format(255), '255');
    assert.equal(programmerMode.format(Infinity, { base: 'DEC' }), '—');
  });
});
