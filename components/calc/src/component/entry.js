//@ts-check
/**
 * @file The entry editor: what a key press writes into the expression a
 * reader is typing, and what `=` does with it. Pure — a `$.calc` slice and
 * a key in, the next slice out — so the component's effect, a host and a
 * test drive the same machine.
 *
 * The rules, in the order a key meets them:
 *  - after a result (`fresh`), an operator or a postfix key continues from
 *    it (`ans +`), anything else starts a new expression;
 *  - a key that would write what cannot follow the expression is dropped
 *    (a second `.` in one number, `)` with nothing open, `%` with no
 *    operand, a digit the number's base lacks), so no key sequence writes
 *    a parse error;
 *  - an operator after an operator replaces it, except a `-` that can be
 *    a sign (`6 × −2`);
 *  - an operand key right after a complete operand multiplies (`2 sin` is
 *    `2*sin(`, `(2)(3` is `(2)*(3`);
 *  - `=` closes every parenthesis still open and evaluates; an expression
 *    that still cannot complete, or a value with no real or finite result,
 *    leaves a message id in `error` instead of a result.
 *
 * The live preview is the value of the longest complete prefix with its
 * parentheses closed (`2 × (3 +` previews 2 × 3 = 6), and nothing when no
 * prefix is complete; typing never shows a diagnostic.
 */

import { evaluateExact } from '../compile.js';
import { defaultEnv, programmerEnv } from '../env.js';
import { DECIMAL_INTEGER, fit, isFiniteValue, toNumber } from '../exact.js';
import { formatSignificant } from '../format.js';
import { format as formatReal } from '../modes/standard.js';
import { formatWord, wordExact } from '../modes/programmer.js';

/**
 * One piece of an entry: a number (`num`, possibly a bare base prefix
 * `0x`), a name (`ans`, `pi`), a function opening (`fn`, `sin(`), a binary
 * operator (`op`), a sign or bitwise not (`unary`), a postfix `!`/`%`
 * (`post`), a parenthesis (`open`, `close`), an argument separator
 * (`comma`), or a character the editor does not write (`other`). `raw`
 * is the token as the entry spelled it, whitespace before it included, so
 * an entry a host wrote keeps its text through an edit (`2 3` stays two
 * numbers, never `23`).
 * @typedef {{ t: 'num'|'name'|'fn'|'op'|'unary'|'post'|'open'|'close'|'comma'|'other', s: string, raw?: string }} Token
 */

/** A number, a bare base prefix included (`0x`, `0b`, `0o`). */
const RE_NUMBER = /0[xX][0-9a-fA-F]*|0[oO][0-7]*|0[bB][01]*|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
/** A name: an identifier or a Greek constant glyph. */
const RE_NAME = /[A-Za-z_][A-Za-z0-9_]*|[πφτ]/y;
/** The operators written between two operands. */
const BINARY = new Set(['+', '-', '*', '/', '^', '&', '|', '<<', '>>', 'mod', 'xor']);
/** The word operators, written with a space on each side. */
const WORD_OPS = new Set(['mod', 'xor']);
/** The postfix keys. */
const POSTFIX = new Set(['%', '!']);
/** The names a key writes as an operand. */
const NAMES = new Set(['ans', 'pi', 'e', 'mem']);
/** The base prefixes. */
const PREFIXES = new Set(['0x', '0b', '0o']);
/** The digits each base prefix accepts. */
const BASE_DIGITS = { x: /^[0-9A-Fa-f]$/, o: /^[0-7]$/, b: /^[01]$/ };
/** The commands. */
const COMMANDS = new Set(['equals', 'clear', 'back']);
/** The diagnostics that mean the expression stops before it is complete. */
const INCOMPLETE = new Set(['calc/parse/end', 'calc/parse/empty']);

/**
 * Split an entry into tokens. Total: any text tokenizes, a character the
 * editor never writes becoming an `other` token.
 * @param {string} entry
 * @returns {Token[]}
 */
export function tokenize(entry) {
  /** @type {Token[]} */
  const out = [];
  const text = String(entry);
  let p = 0;
  let from = 0;
  /** @param {Token} token */
  const push = (token) => { out.push({ ...token, raw: text.slice(from, p) }); from = p; };
  while (p < text.length) {
    const c = text[p];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { p++; continue; }
    const last = out.at(-1);
    RE_NUMBER.lastIndex = p;
    const number = /[0-9.]/.test(c) ? RE_NUMBER.exec(text) : null;
    if (number !== null && number.index === p) { p += number[0].length; push({ t: 'num', s: number[0] }); continue; }
    RE_NAME.lastIndex = p;
    const name = RE_NAME.exec(text);
    if (name !== null && name.index === p) {
      p += name[0].length;
      let q = p;
      while (text[q] === ' ') q++;
      if (text[q] === '(') { p = q + 1; push({ t: 'fn', s: `${name[0]}(` }); }
      else push({ t: WORD_OPS.has(name[0]) && complete(last) ? 'op' : 'name', s: name[0] });
      continue;
    }
    const two = text.slice(p, p + 2);
    if (two === '<<' || two === '>>') { p += 2; push({ t: 'op', s: two }); continue; }
    p++;
    if (c === '+' || c === '-') push({ t: complete(last) ? 'op' : 'unary', s: c });
    else if (c === '~') push({ t: 'unary', s: c });
    else if ('*/^&|'.includes(c)) push({ t: 'op', s: c });
    else if (POSTFIX.has(c)) push({ t: 'post', s: c });
    else if (c === '(') push({ t: 'open', s: c });
    else if (c === ')') push({ t: 'close', s: c });
    else if (c === ',') push({ t: 'comma', s: c });
    else push({ t: 'other', s: c });
  }
  return out;
}

/**
 * The entry text of tokens: a word operator spaced, everything else as is.
 * @param {Token[]} tokens
 * @returns {string}
 */
export function untokenize(tokens) {
  let text = '';
  let word = false;
  for (const token of tokens) {
    const piece = token.raw ?? (token.t === 'op' && WORD_OPS.has(token.s) ? ` ${token.s} ` : token.s);
    // a word operator stays a word: `mod` then `3` is `mod 3`, never `mod3`
    text += word && /^[A-Za-z0-9_.]/.test(piece) ? ` ${piece}` : piece;
    word = token.t === 'op' && WORD_OPS.has(token.s) && /[A-Za-z]$/.test(piece);
  }
  return text;
}

/**
 * A number token with `tail` appended (or, with `drop`, its last character
 * removed), its spelling before it kept.
 * @param {Token} token @param {string} tail @param {boolean} [drop]
 * @returns {Token}
 */
function grown(token, tail, drop = false) {
  const raw = token.raw ?? token.s;
  return { t: token.t, s: drop ? token.s.slice(0, -1) : token.s + tail, raw: drop ? raw.slice(0, -1) : raw + tail };
}

/** @param {Token | undefined} token @returns {boolean} a bare base prefix */
const isPrefix = (token) => token !== undefined && token.t === 'num' && /^0[xob]$/i.test(token.s);

/**
 * Whether a token ends an operand, so an operator may follow it.
 * @param {Token | undefined} token
 * @returns {boolean}
 */
function complete(token) {
  if (token === undefined) return false;
  if (token.t === 'num') return !isPrefix(token);
  return token.t === 'name' || token.t === 'close' || token.t === 'post';
}

/** @param {Token[]} tokens @returns {boolean} whether the innermost open parenthesis is a call's */
function inCall(tokens) {
  /** @type {string[]} */
  const open = [];
  for (const token of tokens) {
    if (token.t === 'open' || token.t === 'fn') open.push(token.t);
    else if (token.t === 'close') open.pop();
  }
  return open.at(-1) === 'fn';
}

/** @param {Token[]} tokens @returns {number} the parentheses still open */
function depthOf(tokens) {
  let depth = 0;
  for (const token of tokens) {
    if (token.t === 'open' || token.t === 'fn') depth++;
    else if (token.t === 'close') depth--;
  }
  return Math.max(0, depth);
}

/**
 * The tokens of a key's operand, after a complete operand multiplied by it.
 * @param {Token[]} tokens @param {Token} operand
 * @returns {Token[] | null}
 */
function withOperand(tokens, operand) {
  const last = tokens.at(-1);
  if (isPrefix(last)) return null;
  if (complete(last)) return [...tokens, { t: 'op', s: '*' }, operand];
  return [...tokens, operand];
}

/**
 * A binary operator `op` written after `tokens`, or `null` when nothing
 * it can follow is there.
 * @param {Token[]} tokens @param {string} op
 * @returns {Token[] | null}
 */
function withOperator(tokens, op) {
  const last = tokens.at(-1);
  if (last === undefined) return op === '-' ? [{ t: 'unary', s: '-' }] : [{ t: 'num', s: '0' }, { t: 'op', s: op }];
  if (complete(last)) return [...tokens, { t: 'op', s: op }];
  if (last.t === 'op') {
    // a minus after another operator is the next operand's sign
    if (op === '-' && last.s !== '+' && last.s !== '-') return [...tokens, { t: 'unary', s: '-' }];
    return [...tokens.slice(0, -1), { t: 'op', s: op }];
  }
  if (last.t === 'unary') {
    if (op === '-') return last.s === '-' ? null : [...tokens, { t: 'unary', s: '-' }];
    return withOperator(tokens.slice(0, -1), op);
  }
  if ((last.t === 'open' || last.t === 'fn' || last.t === 'comma') && op === '-') return [...tokens, { t: 'unary', s: '-' }];
  return null;
}

/**
 * A digit (`0`-`9`, or `A`-`F` in the programmer mode) written after
 * `tokens`.
 * @param {Token[]} tokens @param {string} digit @param {boolean} programmer
 * @returns {Token[] | null}
 */
function withDigit(tokens, digit, programmer) {
  const hex = /^[A-F]$/.test(digit);
  if (hex && !programmer) return null;
  const last = tokens.at(-1);
  if (last !== undefined && last.t === 'num') {
    const base = /^0[xob]/i.test(last.s) ? last.s[1].toLowerCase() : '';
    if (base !== '') return BASE_DIGITS[/** @type {'x'|'o'|'b'} */ (base)].test(digit) ? [...tokens.slice(0, -1), grown(last, digit)] : null;
    if (hex) return null;
    // a lone 0 is replaced, never led: 0 then 5 is 5
    return [...tokens.slice(0, -1), last.s === '0' ? { t: 'num', s: digit, raw: (last.raw ?? '0').slice(0, -1) + digit } : grown(last, digit)];
  }
  return withOperand(tokens, { t: 'num', s: hex ? `0x${digit}` : digit });
}

/**
 * The tokens after pressing `k`, or `null` when the key writes nothing.
 * @param {Token[]} tokens @param {string} k @param {boolean} programmer
 * @returns {Token[] | null}
 */
function edit(tokens, k, programmer) {
  const last = tokens.at(-1);
  if (/^[0-9]$/.test(k) || /^[A-F]$/.test(k)) return withDigit(tokens, k, programmer);
  if (programmer && /^[a-f]$/.test(k)) return withDigit(tokens, k.toUpperCase(), programmer);
  if (k === '.') {
    if (programmer) return null;
    if (last !== undefined && last.t === 'num') {
      return /[.eExXoObB]/.test(last.s) ? null : [...tokens.slice(0, -1), grown(last, '.')];
    }
    return withOperand(tokens, { t: 'num', s: '0.' });
  }
  if (BINARY.has(k)) return withOperator(tokens, k);
  if (POSTFIX.has(k)) return complete(last) ? [...tokens, { t: 'post', s: k }] : null;
  if (k === ')') return complete(last) && depthOf(tokens) > 0 ? [...tokens, { t: 'close', s: ')' }] : null;
  // an argument separator, inside a call after a complete argument (`max(1,2`)
  if (k === ',') return complete(last) && inCall(tokens) ? [...tokens, { t: 'comma', s: ',' }] : null;
  if (k === '(') return withOperand(tokens, { t: 'open', s: '(' });
  if (k === '~') return withOperand(tokens, { t: 'unary', s: '~' });
  if (PREFIXES.has(k)) return last !== undefined && last.t === 'num' ? null : withOperand(tokens, { t: 'num', s: k });
  if (k.endsWith('(') && /^[A-Za-z_][A-Za-z0-9_]*\($/.test(k)) return withOperand(tokens, { t: 'fn', s: k });
  if (NAMES.has(k)) return withOperand(tokens, { t: 'name', s: k });
  return null;
}

/**
 * Backspace: the last digit of a number, else the last whole token.
 * @param {Token[]} tokens
 * @returns {Token[]}
 */
function backspace(tokens) {
  const last = tokens.at(-1);
  if (last === undefined) return tokens;
  if (last.t === 'num' && last.s.length > 1 && !isPrefix(last)) return [...tokens.slice(0, -1), grown(last, '', true)];
  return tokens.slice(0, -1);
}

/**
 * Whether `k` is one key the editor knows (a command, a key some keypad
 * presses, or a name or function opening), rather than a run of keys.
 * @param {string} k
 * @returns {boolean}
 */
function isKey(k) {
  return k.length === 1 || COMMANDS.has(k) || BINARY.has(k) || NAMES.has(k) || PREFIXES.has(k)
    || /^[A-Za-z_][A-Za-z0-9_]*\($/.test(k);
}

/** One key of a run: a base prefix, a shift, a function opening, a word, else one character. */
const RE_RUN_KEY = /0[xob]|<<|>>|[A-Za-z_][A-Za-z0-9_]*\(|(?:ans|pi|mod|xor)(?![A-Za-z0-9_])|[^]/gy;

/**
 * The keys `k` presses: itself when it is one key, else the keys of the
 * run it spells (`'0xFF+1'` is `0x`, `F`, `F`, `+`, `1`).
 * @param {string} k
 * @returns {string[]}
 */
export function keysOf(k) {
  if (isKey(k)) return [k];
  RE_RUN_KEY.lastIndex = 0;
  return (k.match(RE_RUN_KEY) ?? []).filter((key) => !/^\s$/.test(key));
}

/**
 * The changes a press of `k` makes: one key's change (none when it writes
 * nothing), or, for a run of keys, the change of each key in turn — and
 * none at all when any key of the run would write nothing, so a run is
 * typed whole or not at all (`max(1,2)` is never `max(12)`).
 * @param {any} calc @param {string} k
 * @returns {KeyChange[]}
 */
export function changesOf(calc, k) {
  const keys = keysOf(k);
  /** @type {KeyChange[]} */
  const changes = [];
  let next = calc;
  for (const key of keys) {
    const change = keyChange(next, key);
    if (change === null) {
      if (keys.length > 1) return [];
      continue;
    }
    changes.push(change);
    next = applyChange(next, change);
  }
  return changes;
}

/**
 * The exact word beside a held `Number`, or `undefined`. The decimal string
 * is trusted only while it is the integer the `Number` rounds from, so a
 * state a host patched at `ans` or `memory` alone, or one written before
 * the exact form existed, reads as the `Number` it holds.
 * @param {any} held the `ans` or `memory` Number
 * @param {any} text the `ansExact` or `memoryExact` sibling
 * @returns {bigint | undefined}
 */
function exactWord(held, text) {
  return typeof text === 'string' && DECIMAL_INTEGER.test(text) && Number(text) === held ? BigInt(text) : undefined;
}

/**
 * The decimal text of a word a `Number` cannot hold exactly, else the empty
 * text the state slice holds beside a safe `Number`.
 * @param {number | bigint} word
 * @returns {string}
 */
export function exactText(word) {
  return typeof word === 'bigint' ? String(word) : '';
}

/**
 * The scope for evaluating an entry against a state slice or an effect's
 * props. A programmer-mode `ans` and memory that have an exact form enter
 * the scope as that decimal integer, which the exact environment reads
 * without rounding; every other mode holds the `Number`.
 * @param {any} calc
 * @returns {Record<string, unknown>}
 */
export function scopeOf(calc) {
  const programmer = calc.mode === 'programmer';
  const held = (/** @type {any} */ number, /** @type {any} */ text) => {
    const word = programmer ? exactWord(number, text) : undefined;
    return word === undefined ? number : String(word);
  };
  const memory = held(calc.memory, calc.memoryExact);
  return {
    angleMode: calc.angleMode,
    wordBits: calc.wordBits,
    signed: calc.signed,
    ans: held(calc.ans, calc.ansExact),
    mem: memory,
    memory,
  };
}

/**
 * The value a scope entry stands for. In the programmer mode a decimal-integer
 * string is the integer it spells; any other value, a string a host patched
 * into the slice included, is what the state holds.
 * @param {any} held @param {string} mode
 * @returns {any}
 */
export function scopeValue(held, mode) {
  return mode === 'programmer' && typeof held === 'string' && DECIMAL_INTEGER.test(held) ? fit(BigInt(held)) : held;
}

/** @param {string} mode @returns {any} the evaluation env for a mode */
export function envForMode(mode) {
  return mode === 'programmer' ? programmerEnv() : defaultEnv();
}

/**
 * A value as the display's result line shows it: the word in the selected
 * base in the programmer mode, else twelve significant digits with grouped
 * thousands.
 * @param {any} value @param {any} calc
 * @returns {string}
 */
export function resultText(value, calc) {
  return calc.mode === 'programmer' ? formatWord(value, calc) : formatReal(value, { group: true });
}

/**
 * The live preview of an entry: the value of its longest complete prefix,
 * parentheses closed, or the empty text when no prefix is complete or the
 * value is not finite. Never a diagnostic.
 * @param {any} calc a `$.calc` slice
 * @returns {string}
 */
export function previewOf(calc) {
  const value = previewValue(calc);
  return value === undefined ? '' : resultText(value, calc);
}

/**
 * The value the live preview shows (see {@link previewOf}): the committed
 * result right after `=`, else the longest complete prefix's finite value,
 * else `undefined`.
 * @param {any} calc a `$.calc` slice
 * @returns {any}
 */
export function previewValue(calc) {
  if (calc.fresh === true) return scopeValue(scopeOf(calc).ans, calc.mode);
  let tokens = tokenize(calc.entry ?? '');
  while (tokens.length > 0 && !complete(tokens.at(-1))) tokens = tokens.slice(0, -1);
  if (tokens.length === 0) return undefined;
  const result = evaluateExact(untokenize(tokens) + ')'.repeat(depthOf(tokens)), scopeOf(calc), { env: envForMode(calc.mode) });
  return result.ok && isFiniteValue(result.value) ? result.value : undefined;
}

/**
 * What a key press changes: the entry fields (`entry`, `fresh`, `error`,
 * `errorParams`), or, for an `=` that answers, the committed result.
 * @typedef {{ kind: 'entry', entry: string, fresh: boolean, error: string, errorParams: Record<string, unknown> }
 *   | { kind: 'commit', value: number, exact: string, display: string, expr: string, entry: string }} KeyChange
 */

/**
 * A diagnostic's parameters as the state slice holds them, plain JSON: the
 * strings and finite numbers (an unbounded arity's `max: Infinity` is not
 * JSON, and no message the display renders reads it).
 * @param {Record<string, unknown> | undefined} params
 * @returns {Record<string, string | number>}
 */
function jsonParams(params) {
  /** @type {Record<string, string | number>} */
  const out = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) out[key] = value;
  }
  return out;
}

/**
 * The message id of an `=` that has no result, by the engine's diagnostic
 * or by the value: an expression that stops early, one that cannot be
 * read, a function or a name the environment lacks (its own sentence), a
 * value with no real or no finite result.
 * @param {any} result an `evaluateExact` result
 * @param {boolean} programmer
 * @returns {{ id: string, params: Record<string, unknown> } | null}
 */
function refusalOf(result, programmer) {
  if (!result.ok) {
    const id = result.error.id;
    if (id === undefined) return { id: 'calc/display/no-result', params: {} };
    if (INCOMPLETE.has(id)) return { id: 'calc/display/incomplete', params: {} };
    if (id.startsWith('calc/compile/')) return { id, params: jsonParams(result.error.params) };
    return { id: 'calc/display/invalid', params: {} };
  }
  if (isFiniteValue(result.value)) return null;
  if (programmer) return { id: 'calc/display/no-result', params: {} };
  return { id: Number.isNaN(result.value) ? 'calc/display/not-real' : 'calc/display/infinite', params: {} };
}

/**
 * The change one key press makes to a `$.calc` slice, or `null` when it
 * makes none. `k` is a key token (`7`, `+`, `sin(`, `mod`, `equals`, …).
 * @param {any} calc
 * @param {string} k
 * @returns {KeyChange | null}
 */
export function keyChange(calc, k) {
  const programmer = calc.mode === 'programmer';
  const entry = String(calc.entry ?? '');
  const fresh = calc.fresh === true;
  const hadError = typeof calc.error === 'string' && calc.error !== '';
  /** @param {Token[]} tokens @param {boolean} [stillFresh] @returns {KeyChange} */
  const write = (tokens, stillFresh = false) => ({ kind: 'entry', entry: untokenize(tokens), fresh: stillFresh, error: '', errorParams: {} });

  if (k === 'clear') return entry === '' && !fresh && !hadError ? null : write([]);
  if (k === 'back') return entry === '' && !hadError ? null : write(backspace(tokenize(entry)));
  if (k === 'equals') {
    if (fresh || entry === '') return hadError ? { kind: 'entry', entry, fresh, error: '', errorParams: {} } : null;
    const tokens = tokenize(entry);
    if (!complete(tokens.at(-1))) return { kind: 'entry', entry, fresh: false, error: 'calc/display/incomplete', errorParams: {} };
    const expr = untokenize(tokens) + ')'.repeat(depthOf(tokens));
    const result = evaluateExact(expr, scopeOf(calc), { env: envForMode(calc.mode) });
    const refusal = refusalOf(result, programmer);
    if (refusal !== null || !result.ok) {
      const { id, params } = refusal ?? { id: 'calc/display/no-result', params: {} };
      return { kind: 'entry', entry, fresh: false, error: id, errorParams: params };
    }
    const display = resultText(result.value, calc);
    // `ans` is the word the display shows, so the next calculation uses the
    // value the user saw; a word beyond 2^53 is also kept as its decimal text
    const word = programmer ? wordExact(result.value, calc.wordBits ?? 32, calc.signed ?? false) : result.value;
    const value = toNumber(word);
    // the next entry is the result as a literal the parser reads back:
    // ungrouped, the selected base's prefix kept
    const next = programmer ? display.replaceAll(' ', '') : formatSignificant(value);
    return { kind: 'commit', value, exact: exactText(word), display, expr, entry: next };
  }
  // after a result, an operator continues from it and any other key starts anew
  const continues = BINARY.has(k) || POSTFIX.has(k);
  const base = fresh ? (continues ? [{ t: /** @type {const} */ ('name'), s: 'ans' }] : []) : tokenize(entry);
  const next = edit(base, k, programmer);
  // a key that writes nothing still dismisses the last `=` message
  if (next === null) return hadError ? { kind: 'entry', entry, fresh, error: '', errorParams: {} } : null;
  return write(next);
}

/**
 * Apply a key change to a `$.calc` slice (the pure twin of the component's
 * `calc/entry` and `calc/commit` actions).
 * @param {any} calc @param {KeyChange | null} change
 * @returns {any} the next slice
 */
export function applyChange(calc, change) {
  if (change === null) return calc;
  if (change.kind === 'entry') return { ...calc, entry: change.entry, fresh: change.fresh, error: change.error, errorParams: change.errorParams };
  return {
    ...calc, ans: change.value, ansExact: change.exact, entry: change.entry, fresh: true, error: '', errorParams: {},
    tape: [...(calc.tape ?? []), { expr: change.expr, result: change.display }],
  };
}

/**
 * Press keys on a `$.calc` slice: each `k` one key, or a run of keys
 * (`'65535'`, `'+1'`, `'0xFF'`) pressed one by one, whole or not at all
 * (see {@link changesOf}).
 * @param {any} calc
 * @param {...string} keys
 * @returns {any} the next slice
 * @example
 * pressKeys(calcInitialState(), '2', '+', '3', 'equals').ans; // 5
 */
export function pressKeys(calc, ...keys) {
  let next = calc;
  for (const k of keys) {
    for (const change of changesOf(next, k)) next = applyChange(next, change);
  }
  return next;
}
