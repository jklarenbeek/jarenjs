//@ts-check
/**
 * @file Every key sequence of up to four keys, in every keypad mode, from a
 * representative of each key class: no key sequence throws, writes a parse
 * error the reader did not type, or leaves a parser diagnostic on the
 * display; `=` answers what the engine answers for the expression the
 * display showed (its open parentheses closed), and that answer is checked
 * against an evaluation written here: plain JavaScript `Math` for the real
 * modes and `BigInt` for the programmer mode's whole-word arithmetic.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { calcText, evaluate, programmerEnv } from '@jarenjs/calc';
import { calcInitialState, keyChange, applyChange, previewOf, tokenize } from '@jarenjs/calc/component';

/** The messages an `=` that has no result may leave: none names the parser. */
const ALLOWED = new Set(['', 'calc/display/incomplete', 'calc/display/not-real', 'calc/display/infinite', 'calc/display/no-result']);

/** A representative key of each class a mode's keypad has. */
const KEYS = {
  standard: ['7', '0', '.', '+', '-', '*', '/', '^', '%', '(', ')', 'ans', 'equals', 'back', 'clear'],
  scientific: ['7', '.', '-', '*', '^', '!', '(', ')', 'sin(', 'sqrt(', 'pi', 'e', 'ans', 'equals', 'back'],
  programmer: ['7', 'F', '0x', '0b', '+', '-', '*', '/', 'mod', 'xor', '<<', '~', '(', ')', 'equals', 'back'],
};

/**
 * A real-mode expression evaluated with plain JavaScript: the grammar the
 * calculator documents (power right-associative and binding tighter than a
 * sign, `a ± b%` adding b percent of a), radians, `log` base 10.
 * @param {string} source @param {number} ans
 * @returns {number | undefined} `undefined` for a factorial this oracle does not hold
 */
function realOracle(source, ans) {
  let p = 0;
  const s = source.replaceAll(' ', '');
  const peek = () => s[p];
  /** @returns {{ v: number, pct: boolean }} */
  const add = () => {
    let left = mul().v;
    while (peek() === '+' || peek() === '-') {
      const op = s[p++];
      const right = mul();
      const r = right.pct ? left * right.v : right.v;
      left = op === '+' ? left + r : left - r;
    }
    return { v: left, pct: false };
  };
  /** @returns {{ v: number, pct: boolean }} */
  const mul = () => {
    let term = unary();
    if (peek() !== '*' && peek() !== '/') return term;
    while (peek() === '*' || peek() === '/') {
      const op = s[p++];
      const right = unary().v;
      term = { v: op === '*' ? term.v * right : term.v / right, pct: false };
    }
    return term;
  };
  /** @returns {{ v: number, pct: boolean }} */
  const unary = () => {
    if (peek() === '-') { p++; return { v: -unary().v, pct: false }; }
    if (peek() === '+') { p++; return { v: unary().v, pct: false }; }
    const base = postfix();
    if (peek() === '^') { p++; return { v: base.v ** unary().v, pct: false }; }
    return base;
  };
  /** @returns {{ v: number, pct: boolean }} */
  const postfix = () => {
    let node = primary();
    while (peek() === '%' || peek() === '!') {
      if (s[p++] === '%') node = { v: node.v / 100, pct: true };
      else {
        if (!Number.isInteger(node.v) || node.v < 0 || node.v > 170) throw new RangeError('factorial');
        let f = 1;
        for (let k = 2; k <= node.v; k++) f *= k;
        node = { v: f, pct: false };
      }
    }
    return node;
  };
  const FUNCS = { sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, ln: Math.log, log: Math.log10, sqrt: Math.sqrt, exp: Math.exp };
  // parentheses group but leave no trace: `a + (b%)` is `a + b%`, as in the AST
  /** @returns {{ v: number, pct: boolean }} */
  const primary = () => {
    if (peek() === '(') { p++; const inner = addKeepingPercent(); p++; return inner; }
    const number = /^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/.exec(s.slice(p));
    if (number) { p += number[0].length; return { v: Number(number[0]), pct: false }; }
    const name = /^[a-z]+/.exec(s.slice(p))[0];
    p += name.length;
    if (s[p] === '(') { p++; const v = add().v; p++; return { v: FUNCS[/** @type {keyof typeof FUNCS} */ (name)](v), pct: false }; }
    return { v: name === 'ans' ? ans : name === 'pi' ? Math.PI : Math.E, pct: false };
  };
  /** A parenthesized expression: a lone percent inside stays a percent. @returns {{ v: number, pct: boolean }} */
  const addKeepingPercent = () => {
    const start = p;
    const first = mul();
    if (peek() !== '+' && peek() !== '-') return first;
    p = start;
    return add();
  };
  try { return add().v; }
  catch (err) {
    if (err instanceof RangeError) return undefined;
    throw err;
  }
}

/**
 * A programmer-mode expression of `+ - *`, signs and parentheses over
 * decimal and hex literals, in BigInt, wrapped once to the unsigned word.
 * @param {string} source @param {bigint} ans @param {number} bits
 * @returns {bigint | undefined} `undefined` for an operator this oracle does not hold
 */
function wordOracle(source, ans, bits) {
  if (!/^(?:[-+*() ]|ans|0x[0-9A-F]+|\d+)*$/.test(source)) return undefined;
  let p = 0;
  const s = source.replaceAll(' ', '');
  /** @returns {bigint} */
  const add = () => { let v = mul(); while (s[p] === '+' || s[p] === '-') v = s[p++] === '+' ? v + mul() : v - mul(); return v; };
  /** @returns {bigint} */
  const mul = () => { let v = unary(); while (s[p] === '*') { p++; v *= unary(); } return v; };
  /** @returns {bigint} */
  const unary = () => {
    if (s[p] === '-') { p++; return -unary(); }
    if (s[p] === '(') { p++; const v = add(); p++; return v; }
    if (s.startsWith('ans', p)) { p += 3; return ans; }
    const literal = /^(?:0x[0-9A-F]+|\d+)/.exec(s.slice(p))[0];
    p += literal.length;
    return BigInt(literal);
  };
  return BigInt.asUintN(bits, add());
}

/** All sequences of length 1..`n` over `keys`. @returns {Generator<string[]>} */
function* sequences(/** @type {string[]} */ keys, /** @type {number} */ n) {
  /** @type {string[][]} */
  let level = [[]];
  for (let length = 1; length <= n; length++) {
    /** @type {string[][]} */
    const next = [];
    for (const prefix of level) for (const key of keys) next.push([...prefix, key]);
    yield* next;
    level = next;
  }
}

describe('#calc entry harness: every key sequence up to four keys', () => {
  it('the messages = may leave name no parser internals', () => {
    for (const id of ALLOWED) {
      if (id === '') continue;
      assert.doesNotMatch(calcText()(id), /\(\d+:\d+\)|unexpected|expected|end of input|token/, id);
    }
  });

  for (const [mode, keys] of Object.entries(KEYS)) {
    it(`${mode}: ${keys.length} key classes`, (t) => {
      const start = { ...calcInitialState(), mode, ans: 3 };
      const env = mode === 'programmer' ? { env: programmerEnv() } : {};
      let commits = 0;
      let checked = 0;
      let count = 0;
      for (const sequence of sequences(keys, 4)) {
        count++;
        let calc = start;
        for (const k of sequence) {
          const change = keyChange(calc, k);
          calc = applyChange(calc, change);
          assert.ok(ALLOWED.has(calc.error), `${mode} ${sequence.join(' ')}: ${calc.error}`);
        }
        const preview = previewOf(calc);
        const equals = keyChange(calc, 'equals');
        if (equals === null) continue;
        if (equals.kind === 'entry') {
          assert.ok(ALLOWED.has(equals.error), `${mode} ${sequence.join(' ')} =: ${equals.error}`);
          if (equals.error === 'calc/display/incomplete') {
            // only an expression that ends where an operand is still owed
            const last = tokenize(calc.entry).at(-1);
            assert.ok(last !== undefined && ['op', 'unary', 'open', 'fn', 'num'].includes(last.t), `${mode} ${sequence.join(' ')}: ${calc.entry}`);
          }
          continue;
        }
        commits++;
        // = closes what the display left open, and answers what the engine does
        const open = tokenize(calc.entry).filter((t) => t.t === 'open' || t.t === 'fn').length
          - tokenize(calc.entry).filter((t) => t.t === 'close').length;
        assert.equal(equals.expr, calc.entry + ')'.repeat(open), `${mode} ${sequence.join(' ')}`);
        assert.equal(equals.display, preview, `${mode} ${sequence.join(' ')}: the preview was the answer`);
        const engine = evaluate(equals.expr, { ans: calc.ans, wordBits: 32, signed: false, angleMode: 'rad' }, env);
        assert.ok(engine.ok, equals.expr);
        if (mode === 'programmer') {
          const want = wordOracle(equals.expr, BigInt(calc.ansExact || calc.ans), 32);
          if (want !== undefined) {
            checked++;
            assert.equal(BigInt(equals.exact || equals.value), want, `${equals.expr}`);
          }
        }
        else {
          const want = realOracle(equals.expr, calc.ans);
          assert.ok(Math.abs(engine.value - equals.value) <= 1e-12 * Math.abs(equals.value), equals.expr);
          if (want !== undefined) {
            checked++;
            assert.ok(Math.abs(equals.value - want) <= 1e-9 * Math.max(1, Math.abs(want)), `${equals.expr}: ${equals.value} vs ${want}`);
          }
        }
      }
      assert.ok(commits > 1000 && checked > 500, `${mode}: ${commits} answers, ${checked} checked independently`);
      t.diagnostic(`${mode}: ${count} sequences, ${commits} answers, ${checked} checked independently`);
    });
  }
});
