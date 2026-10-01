//@ts-check
/**
 * @file The JavaScript formula translator at the edges of its subset
 * (FORMULA-FORMAT, "Translating a saved source"): where JavaScript reads a
 * value differently from the query — an element that is itself an array, the
 * skip sentinel inside an expression, an optional call, an ordering across
 * types or between texts outside the Basic Multilingual Plane, an array index,
 * a regular expression escape read without the u flag, a block's own names, a
 * sort or a push that changes an array in place — the translation is exact,
 * names the difference, or refuses with a positioned reason. Every
 * equivalence runs a function written in this file and translates that same
 * function's body text.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { compileFormula, formulaDocument } from '@jarenjs/json/formula';
import { translateFormulaBody, migrateFormulas } from '@jarenjs/json/formula/migrate';
import { compileJsonQuery } from '@jarenjs/json';
import { ar, compileNumberLocale, de, es, fr, ja, ko, nl, pt, ru, tr, zhTW } from '@jarenjs/locales';

// the English decimal format is the number catalog's default
const decimalFormats = { nl: compileNumberLocale(nl).decimalFormat, en: compileNumberLocale().decimalFormat };
const locales = {
  'nl-NL': { decimalFormat: 'nl', grouping: '.', decimal: ',', currencies: { EUR: '\u20AC\u00A0#.##0,00;\u20AC\u00A0-#.##0,00' } },
  'en-US': { decimalFormat: 'en', grouping: ',', decimal: '.', currencies: { USD: '$#,##0.00;-$#,##0.00' } },
};
/** The skip sentinel the outcome bodies return. */
const LEAVE = Symbol('leave');

/** The text between a function's outer braces. @param {Function} fn */
function bodyOf(fn) {
  const text = fn.toString();
  return text.slice(text.indexOf('{', text.indexOf('=>')) + 1, text.lastIndexOf('}')).replace(/^\n/, '').replace(/\n\s*$/, '');
}

/** The 1-based line and column of `needle` in `body`. @param {string} body @param {string} needle */
function at(body, needle) {
  const offset = body.indexOf(needle);
  assert.ok(offset >= 0, `${needle} in ${body}`);
  const lines = body.slice(0, offset).split('\n');
  return [lines.length, lines[lines.length - 1].length + 1];
}

/** A translation compiled as a formula. @param {any} t */
function compiled(t) {
  assert.notStrictEqual(t.state, 'untranslatable', JSON.stringify(t.reasons));
  return compileFormula(formulaDocument({ $formula: '1', id: 'f', revision: '1', expression: t.expression,
    ...(t.resultMode === 'outcome' ? { resultMode: 'outcome' } : {}) }), { decimalFormats });
}

/** A formula's value for a row, as JavaScript returns it: undefined for nothing. @param {any} formula @param {any} row */
function valueOf(formula, row) {
  const r = formula.evaluate(row);
  return r.kind === 'empty' ? undefined : r.kind === 'value' ? r.value : r;
}

/** Assert a translation agrees with its function on every row. @param {Function} fn @param {any[]} rows @param {any} [options] */
function agrees(fn, rows, options = {}) {
  const t = translateFormulaBody(bodyOf(fn), { locales, ...options });
  const formula = compiled(t);
  for (const row of rows) {
    const js = fn(structuredClone(row));
    // a JSON round trip, but for a number (its signed zero is the same in memory on both sides)
    const want = js === undefined ? undefined : typeof js === 'number' ? js : JSON.parse(JSON.stringify(js));
    assert.deepStrictEqual(valueOf(formula, row), want, `${bodyOf(fn)} on ${JSON.stringify(row)}`);
  }
  return t;
}

/** Assert an outcome translation agrees with its function: LEAVE or undefined skips. @param {Function} fn @param {any[]} rows */
function outcomes(fn, rows) {
  const t = translateFormulaBody(bodyOf(fn), { skip: 'LEAVE' });
  assert.strictEqual(t.resultMode, 'outcome');
  const formula = compiled(t);
  for (const row of rows) {
    const js = fn(structuredClone(row));
    const want = js === LEAVE || js === undefined ? { kind: 'skip' } : { kind: 'value', value: JSON.parse(JSON.stringify(js)) };
    assert.deepStrictEqual(formula.evaluate(row), want, `${bodyOf(fn)} on ${JSON.stringify(row)}`);
  }
  return t;
}

/** Assert a body is refused with a reason of `kind` at `needle`. @param {string} body @param {string} kind @param {string} needle @param {any} [options] */
function refuses(body, kind, needle, options = {}) {
  const t = translateFormulaBody(body, { locales, ...options });
  assert.strictEqual(t.state, 'untranslatable', body);
  const r = t.reasons.find((x) => x.kind === kind);
  assert.ok(r, `${body}: ${JSON.stringify(t.reasons)}`);
  assert.deepStrictEqual([r.at.line, r.at.column], at(body, needle), `${body}: ${kind}`);
  return t;
}

/** Assert a translation names a difference of `kind` at `needle`. @param {string} body @param {string} kind @param {string} needle @param {any} [options] */
function names(body, kind, needle, options = {}) {
  const t = translateFormulaBody(body, { locales, ...options });
  assert.notStrictEqual(t.state, 'untranslatable', `${body}: ${JSON.stringify(t.reasons)}`);
  const d = t.differences.find((x) => x.kind === kind);
  assert.ok(d, `${body}: ${JSON.stringify(t.differences)}`);
  assert.deepStrictEqual([d.at.line, d.at.column], at(body, needle), `${body}: ${kind}`);
  return t;
}

describe('arrays whose elements are arrays', () => {
  it('reads an element that is itself an array as one element in every callback, sort and includes', () => {
    const rows = [{ sets: [['a', 'b'], [], ['c']] }, { sets: [[]] }, { sets: [] }];
    agrees((row) => { if (!row.sets) return null; return row.sets.map((t) => t.join('-')); }, rows);
    agrees((row) => { if (!row.sets) return null; return row.sets.map((t) => t); }, rows);
    agrees((row) => { if (!row.sets) return null; return row.sets.filter((t) => t !== null).length; }, rows);
    agrees((row) => { if (!row.sets) return null; return row.sets.some((t) => t.join('') === ''); }, rows);
    agrees((row) => { if (!row.sets) return null; return row.sets.every((t) => t.join('') !== ''); }, rows);
    agrees((row) => { if (!row.sets) return null; return row.sets.find((t) => t !== null) ?? 'none'; }, rows);
    agrees((row) => { if (!row.sets) return null; return row.sets.map((t, i) => i); }, rows);
    // `?? []` says the element is an array: an index into a value of unknown type is refused (see indexes into text)
    agrees((row) => { if (!row.pairs) return null; return [...row.pairs].sort((a, b) => (a ?? [])[0] - (b ?? [])[0]).map((p) => (p ?? [])[1]); },
      [{ pairs: [[2, 'b'], [1, 'a']] }]);
    agrees((row) => { return [row.a ?? 0, row.b ?? 0].includes(1); }, [{ a: [1], b: 2 }, { a: 1 }]);
  });
});

describe('the skip sentinel', () => {
  it('skips after ?? only where the value is null or missing', () => {
    outcomes((row) => { return row.q ?? LEAVE; }, [{ q: 5 }, { q: 0 }, { q: '' }, { q: null }, {}]);
    outcomes((row) => { return row.q ?? (row.r ?? LEAVE); }, [{ q: 5 }, { r: 2 }, { q: null, r: 0 }, {}]);
    outcomes((row) => { return row.q > 1 && LEAVE; }, [{ q: 5 }, { q: 0 }]);
  });

  it('refuses the sentinel kept as a value, where only a returned sentinel skips', () => {
    for (const body of ['const x = row.a || LEAVE;\nreturn x;', 'let x = row.a;\nif (!x) x = LEAVE;\nreturn x;', 'return [LEAVE];'])
      refuses(body, 'skip-value', 'LEAVE', { skip: 'LEAVE' });
  });
});

describe('optional calls', () => {
  it('yields undefined for a call on a missing or null receiver, along the whole chain', () => {
    const rows = [{}, { s: null }, { s: '  Ab  ' }];
    for (const fn of [
      (/** @type {any} */ row) => { return row.s?.trim() ?? 'none'; },
      (/** @type {any} */ row) => { return row.s?.trimEnd() ?? 'none'; },
      (/** @type {any} */ row) => { return row.s?.toLowerCase() ?? 'none'; },
      (/** @type {any} */ row) => { return row.s?.startsWith(' ') ?? 'none'; },
      (/** @type {any} */ row) => { return row.s?.split(' ')[0] ?? 'none'; },
      (/** @type {any} */ row) => { return row.s?.replace(/b/g, 'c') ?? 'none'; },
      (/** @type {any} */ row) => { return row.s?.trim().toUpperCase() ?? 'none'; },
    ]) agrees(fn, rows);
    for (const fn of [
      (/** @type {any} */ row) => { return row.x?.toFixed(1) ?? 'none'; },
      (/** @type {any} */ row) => { return row.x?.toString() ?? 'none'; },
      (/** @type {any} */ row) => { return row.x?.toLocaleString('nl-NL') ?? 'none'; },
    ]) agrees(fn, [{}, { x: null }, { x: 1.25 }]);
    assert.strictEqual(translateFormulaBody("return row.s?.trim() ?? 'none';").state, 'translated');
  });

  it('reads nothing for a plain call on a missing or null receiver, as the absent-receiver difference says', () => {
    const formula = compiled(names('return row.s.trim();', 'absent-receiver', 'row.s.trim'));
    assert.strictEqual(valueOf(formula, {}), undefined);
    assert.strictEqual(valueOf(formula, { s: null }), undefined);
    assert.strictEqual(valueOf(formula, { s: ' a ' }), 'a');
  });
});

describe('ordering comparisons', () => {
  it('refuses the row where JavaScript would compare a number with text, a boolean field, an array or an object', () => {
    const t = translateFormulaBody("if (row.qty > 0) return 'in stock';\nreturn 'sold out';");
    assert.strictEqual(t.state, 'translated');
    const formula = compiled(t);
    assert.deepStrictEqual([valueOf(formula, { qty: 12 }), valueOf(formula, { qty: 0 }), valueOf(formula, {})], ['in stock', 'sold out', 'sold out']);
    for (const qty of ['12', true, [3], { n: 1 }]) assert.throws(() => formula.evaluate({ qty }), { code: 'JQ2001' }, JSON.stringify(qty));
    const pair = compiled(translateFormulaBody('return row.a < row.b;'));
    for (const row of [{ a: 5, b: '7' }, { a: [1], b: [2] }, { a: true, b: 1 }]) assert.throws(() => pair.evaluate(row), { code: 'JQ2001' }, JSON.stringify(row));
    assert.deepStrictEqual([valueOf(pair, { a: 'a', b: 'b' }), valueOf(pair, { a: 1, b: 2 }), valueOf(pair, { a: 2 })], [true, true, false]);
    const fallback = compiled(translateFormulaBody('return (row.n ?? 0) > 5;'));
    assert.throws(() => fallback.evaluate({ n: '7' }), { code: 'JQ2001' });
    assert.deepStrictEqual([valueOf(fallback, { n: 7 }), valueOf(fallback, {})], [true, false]);
  });

  it('refuses + of a value that may be text or a number, which JavaScript adds or concatenates by the value', () => {
    refuses("return (row.f ? '1' : 1) + 2;", 'operator', "row.f ?");
    refuses("let n = 1;\nif (row.f) n = 'x';\nreturn n + 1;", 'operator', 'n + 1');
    agrees((row) => { return (row.f ? 'x' : 1) + ' units'; }, [{ f: true }, { f: false }]);
  });

  it('orders a boolean the body computes as 0 or 1, as JavaScript does', () => {
    agrees((row) => { return (row.a > 1) < (row.b > 1); }, [{ a: 0, b: 2 }, { a: 2, b: 0 }, { a: 2, b: 2 }]);
    agrees((row) => { return (row.a > 1) >= true; }, [{ a: 0 }, { a: 2 }]);
  });

  it('orders texts by their UTF-16 code units, as JavaScript does', () => {
    const rows = [['\uFF01', '\u{1F600}'], ['\u{1F600}', '\uFF01'], ['a\uFF01b', 'a\u{1F600}'], ['ab', 'a'], ['a', 'ab'], ['', 'x'],
      ['\u{1F600}a', '\u{1F600}b'], ['x\uFFFD', 'x\uFFFD'], ['\uE000\u{1F600}', '\uE000\uFFFE'], ['\u{10FFFF}', '\uFFFE']].map(([a, b]) => ({ a, b }));
    agrees((row) => { return row.a < row.b; }, rows);
    agrees((row) => { return row.a <= row.b; }, rows);
    agrees((row) => { return row.a > row.b; }, rows);
    agrees((row) => { return row.a >= row.b; }, rows);
    agrees((row) => { if (row.a == null || row.b == null) return null; return row.a.trim() < row.b.trim(); }, rows);
    agrees((row) => { return row.a < '\uFF01'; }, rows);
  });
});

describe('text and its UTF-16 code units', () => {
  it('counts UTF-16 code units in .length, as JavaScript does', () => {
    agrees((row) => { if (row.s == null) return null; return row.s.trim().length; }, [{ s: '\u{1F600}' }, { s: 'a\u{1F600}b' }, { s: '' }, { s: 'abc' }]);
    agrees((row) => { return `${row.s ?? ''}`.length; }, [{ s: '\u{1F600}\u{1F600}' }, {}]);
  });

  it('names code-units where a pattern matches one code unit and an emoji is two of them', () => {
    names('if (row.s == null) return null;\nreturn /^.$/.test(row.s.trim());', 'code-units', '/^.$/');
    names("if (row.s == null) return null;\nreturn row.s.replace(/./g, '*');", 'code-units', '/./g');
    names("if (row.s == null) return null;\nreturn row.s.replace(/[^a-z]/g, '-');", 'code-units', '/[^a-z]/g');
    names('if (row.s == null) return null;\nreturn /a\\Sb/.test(row.s.trim());', 'code-units', '/a\\Sb/');
  });

  it('translates one such class replaced away, a run of it, or a test for it exactly', () => {
    const rows = [{ s: 'a\u{1F600}b' }, { s: '\u{1F600}' }, { s: 'Ab-c' }, { s: '' }];
    for (const fn of [
      (/** @type {any} */ row) => { if (row.s == null) return null; return row.s.replace(/[^a-z]/g, ''); },
      (/** @type {any} */ row) => { if (row.s == null) return null; return row.s.replace(/[^a-z]+/g, '-'); },
      (/** @type {any} */ row) => { if (row.s == null) return null; return /[^a-z]/.test(row.s.trim()); },
      (/** @type {any} */ row) => { if (row.s == null) return null; return /\S+/.test(row.s.trim()); },
    ]) assert.strictEqual(agrees(fn, rows).state, 'translated', bodyOf(fn));
  });
});

describe('case-insensitive patterns', () => {
  it('refuses a case-insensitive pattern with a capital in it, and names case-fold for the rest', () => {
    refuses('if (row.s == null) return null;\nreturn /\u00C9/i.test(row.s.trim());', 'regex', '/\u00C9/i');
    refuses('if (row.s == null) return null;\nreturn /\\u00C9t\\u00E9/i.test(row.s.trim());', 'regex', '/\\u00C9');
    names('if (row.s == null) return null;\nreturn /abc/i.test(row.s.trim());', 'case-fold', '/abc/i');
    agrees((row) => { if (row.s == null) return null; return /abc|\u00E9/i.test(row.s.trim()); }, [{ s: 'xABCx' }, { s: '\u00C9' }, { s: 'x' }]);
  });
});

describe('array indexes', () => {
  it('reads nothing at a negative computed index, and the element at a text JavaScript reads as an index', () => {
    agrees((row) => { if (row.m == null) return null; const MONTHS = ['jan', 'feb', 'mar']; return MONTHS[row.m - 1] ?? 'unknown'; },
      [{ m: 1 }, { m: 3 }, { m: 0 }, { m: -1 }, { m: 4 }, { m: 1.5 }]);
    agrees((row) => { const L = ['a', 'b']; return L[row.i] ?? 'none'; }, [{ i: 0 }, { i: 1 }, { i: -1 }, { i: '1' }, { i: '01' }, { i: -0 }, {}]);
    names("const L = ['a', 'b'];\nreturn L[row.i];", 'prototype-key', 'L[row.i]');
  });
});

describe('indexes into text', () => {
  it('reads the character at an index of a text, and nothing past its end, naming code-units', () => {
    const rows = [{ code: ' ABC ' }, { code: 'x' }, { code: '' }, { code: 'Zoë' }];
    const t = agrees((row) => { if (row.code == null) return null; return row.code.trim()[0]; }, rows);
    assert.deepStrictEqual(t.differences.map((d) => d.kind), ['code-units']);
    names("if (row.code == null) return null;\nreturn row.code.trim()[2];", 'code-units', 'row.code.trim()[2]');
    agrees((row) => { if (row.code == null) return null; return row.code.trim()[2] ?? '-'; }, rows);
    agrees((row) => { return (row.code ?? '')[0] ?? '-'; }, [...rows, {}, { code: null }]);
    agrees((row) => { if (!row.first || !row.last) return null; return `${row.first.trim()[0]}${row.last.trim()[0]}`.toUpperCase(); },
      [{ first: 'john', last: 'Doe' }, { first: 'Ann', last: 'lee' }]);
    agrees((_row) => { const names = ['ab', 'cd']; return names.map((n) => n[1]).join(''); }, [{}]);
  });

  it('reads a character where JavaScript reads one code unit of a character beyond U+FFFF, as code-units says', () => {
    const t = translateFormulaBody('if (row.s == null) return null;\nreturn row.s.trim()[1];');
    const formula = compiled(t);
    assert.strictEqual(valueOf(formula, { s: 'ab' }), 'b');
    assert.strictEqual(valueOf(formula, { s: '\u{1F600}x' }), 'x', 'the query reads the second character; JavaScript a lone surrogate');
    assert.ok(t.differences.some((d) => d.kind === 'code-units' && /code unit/.test(d.note)));
  });

  it('refuses an index into a value it cannot tell is text or an array, as .length is refused', () => {
    refuses("return row.code?.[0] ?? '-';", 'index', 'row.code?.[0]');
    refuses('if (!row.first || !row.last) return null;\nreturn `${row.first[0]}${row.last[0]}`;', 'index', 'row.first[0]');
    refuses('return row.list[0];', 'index', 'row.list[0]');
    agrees((row) => { return (row.list ?? [])[0] ?? 'none'; }, [{ list: ['a', 'b'] }, { list: [] }, {}]);
  });
});

describe('anchored patterns', () => {
  const rows = ['', 'a', 'ab', 'abc', '0', '5', 'b', 'x1', 'xb', ' abc ', 'abc  ', '0042'].map((s) => ({ s }));

  it('matches no end of the text with ., a negated class, \\D, \\W or \\S', () => {
    for (const fn of [
      (/** @type {any} */ row) => { if (row.s == null) return null; return /^.{3}/.test(row.s); },
      (/** @type {any} */ row) => { if (row.s == null) return null; return /.{3}$/.test(row.s); },
      (/** @type {any} */ row) => { if (row.s == null) return null; return /^[^a]/.test(row.s); },
      (/** @type {any} */ row) => { if (row.s == null) return null; return /[^a]$/.test(row.s); },
      (/** @type {any} */ row) => { if (row.s == null) return null; return /^\D/.test(row.s); },
      (/** @type {any} */ row) => { if (row.s == null) return null; return /\W$/.test(row.s); },
      (/** @type {any} */ row) => { if (row.s == null) return null; return /^\S\S/.test(row.s); },
      (/** @type {any} */ row) => { if (row.s == null) return null; return /^0./.test(row.s); },
      (/** @type {any} */ row) => { if (row.s == null) return null; return /.$/.test(row.s); },
      (/** @type {any} */ row) => { if (row.s == null) return null; return row.s.replace(/^[^b]/, 'X'); },
      (/** @type {any} */ row) => { if (row.s == null) return null; return row.s.replace(/.$/, '!'); },
    ]) agrees(fn, rows);
  });

  it('marks the start and the end of the text apart: ^ matches at the start only and $ at the end only', () => {
    for (const fn of [
      (/** @type {any} */ row) => { if (row.s == null) return null; return /^$/.test(row.s); },
      (/** @type {any} */ row) => { if (row.s == null) return null; return /^a|c$/.test(row.s); },
      (/** @type {any} */ row) => { if (row.s == null) return null; return /a^|$b/.test(row.s); },
      (/** @type {any} */ row) => { if (row.s == null) return null; return row.s.replace(/$x|b/g, '_'); },
      (/** @type {any} */ row) => { if (row.s == null) return null; return row.s.replace(/^0+/, '#'); },
      (/** @type {any} */ row) => { if (row.s == null) return null; return row.s.replace(/\s+$/, '.'); },
      (/** @type {any} */ row) => { if (row.s == null) return null; return row.s.replace(/^a|c$/g, '_'); },
      (/** @type {any} */ row) => { if (row.s == null) return null; return row.s.replace(/^\s+|\s+$/g, ''); },
    ]) agrees(fn, rows);
  });

  it('refuses a replace, with or without the g flag, whose pattern can match the empty text', () => {
    for (const pattern of ['/\\s*$/', '/^/', '/$/', '/^0*/', '/x*$/g', '/\\s*$/g', '/(a|)/g', '/a*/g', '/a?/'])
      refuses(`if (row.s == null) return null;\nreturn row.s.replace(${pattern}, '.');`, 'regex', pattern);
    refuses("if (row.s == null) return null;\nreturn row.s.replaceAll(/x*$/g, '-');", 'regex', '/x*$/g');
  });

  it('tests a pattern that can match the empty text as JavaScript does', () => {
    for (const fn of [
      (/** @type {any} */ row) => { if (row.s == null) return null; return /^\d*$/.test(row.s); },
      (/** @type {any} */ row) => { if (row.s == null) return null; return /^/.test(row.s); },
      (/** @type {any} */ row) => { if (row.s == null) return null; return /x*/.test(row.s); },
      (/** @type {any} */ row) => { if (row.s == null) return null; return /^(a|)$/.test(row.s); },
    ]) agrees(fn, rows);
  });

  it('replaces the first match only where an anchor that begins or ends the pattern lets it match once', () => {
    refuses("if (row.s == null) return null;\nreturn row.s.replace(/(^a)?b/, '-');", 'replace-first', 'row.s.replace');
    agrees((row) => { if (row.s == null) return null; return row.s.replace(/^\d+/, '#'); }, rows);
    agrees((row) => { if (row.s == null) return null; return row.s.replace(/\\$/, '/'); }, [{ s: 'a\\' }, { s: '\\a\\' }, { s: '' }]);
  });
});

describe('replace', () => {
  it('refuses a first-match replace whose anchored pattern can match more than once', () => {
    refuses("if (row.s == null) return null;\nreturn row.s.replace(/^\\s+|\\s+$/, '');", 'replace-first', 'row.s.replace');
    refuses("if (row.s == null) return null;\nreturn row.s.replace(/^a|b/, '-');", 'replace-first', 'row.s.replace');
    agrees((row) => { if (row.s == null) return null; return row.s.replace(/^\s+/, ''); }, [{ s: '  x  ' }, { s: 'x' }]);
  });

  it('matches a dollar sign in a literal pattern, a regular expression and a split', () => {
    const rows = [{ s: '$ 12.50' }, { s: 'a$b$c' }, { s: 'none' }];
    agrees((row) => { if (row.s == null) return null; return row.s.replaceAll('$', '').trim(); }, rows);
    agrees((row) => { if (row.s == null) return null; return row.s.replace(/\$/g, 'S'); }, rows);
    agrees((row) => { if (row.s == null) return null; return row.s.split('$')[0]; }, rows);
  });

  it('reads \\p, \\u{\u2026}, \\c, \\x, a lone brace and a dollar sign as JavaScript reads them without the u flag', () => {
    for (const [source, input] of [['\\p{Lu}', 'Ab p{Lu}'], ['a{,2}', 'a{,2}aa'], ['x\\u{2}', 'xuu xu'], ['\\cJ', 'a\nb'], ['\\$', 'a$b$'],
      ['\\x41|\\u0042', 'AB'], ['a]', 'a]b']]) {
      const body = `if (row.s == null) return null;\nreturn row.s.replace(/${source}/g, '_');`;
      const t = translateFormulaBody(body);
      assert.notStrictEqual(t.state, 'untranslatable', `${body}: ${JSON.stringify(t.reasons)}`);
      assert.strictEqual(valueOf(compiled(t), { s: input }), input.replace(new RegExp(source, 'g'), '_'), body);
    }
    refuses('if (row.s == null) return null;\nreturn /\\01/.test(row.s.trim());', 'regex', '/\\01/');
  });

  it('reads \\B inside a class as the letter B, and only \\b there as a backspace', () => {
    for (const source of ['[\\B]', '[\\b]', '[a\\B]']) {
      const replaced = translateFormulaBody(`if (row.s == null) return null;\nreturn row.s.replace(/${source}/g, '_');`);
      const tested = translateFormulaBody(`if (row.s == null) return null;\nreturn /${source}/.test(row.s);`);
      assert.deepStrictEqual([replaced.state, tested.state], ['translated', 'translated'], source);
      for (const s of ['B', '\b', 'aBc', 'a\bc', 'x']) {
        assert.strictEqual(valueOf(compiled(replaced), { s }), s.replace(new RegExp(source, 'g'), '_'), `${source} replacing in ${JSON.stringify(s)}`);
        assert.strictEqual(valueOf(compiled(tested), { s }), new RegExp(source).test(s), `${source} testing ${JSON.stringify(s)}`);
      }
    }
  });
});

describe('text search arguments', () => {
  it('reads a missing, null or number argument of startsWith, endsWith and includes as JavaScript does', () => {
    const rows = [{ s: 'abc' }, { s: 'undefined!' }, { s: 'abc', p: null }, { s: 'null', p: null }, { s: '123', p: 1 }, { s: 'abc', p: 'a' }];
    agrees((row) => { if (row.s == null) return null; return row.s.trim().startsWith(row.p); }, rows);
    agrees((row) => { if (row.s == null) return null; return row.s.trim().endsWith(row.p); }, rows);
    agrees((row) => { if (row.s == null) return null; return row.s.trim().includes(row.p); }, rows);
  });
});

describe('concat', () => {
  it('concatenates text, flattens an array argument, and refuses a receiver it cannot tell is text or an array', () => {
    agrees((row) => { return `${row.first ?? ''}`.concat(' ', row.last ?? '', 1); }, [{ first: 'Ada', last: 'Lovelace' }, {}]);
    agrees((row) => { if (!row.a) return null; return (row.a ?? []).concat(row.b ?? [], row.c ?? 'x'); },
      [{ a: [1, 2], b: [3, 4], c: [5] }, { a: [1], b: 2, c: null }]);
    refuses("return row.first.concat('!');", 'concat', 'row.first.concat');
  });
});

describe('number and currency text', () => {
  it('writes a currency whose picture starts with a dollar sign', () => {
    agrees((row) => { if (row.x == null) return null; return row.x.toLocaleString('en-US', { style: 'currency', currency: 'USD' }); },
      [{ x: 1234.5 }, { x: -2 }, { x: 0 }]);
  });

  it('names Number() of a text as the refusal it is: the query refuses the row where JavaScript reads 0, hex or a sign', () => {
    const t = names('if (row.s == null) return null;\nreturn Number(row.s);', 'number-parse', 'Number(row.s)');
    const note = t.differences.find((d) => d.kind === 'number-parse')?.note ?? '';
    assert.match(note, /refuses .*\(JQ2001\)/);
    assert.doesNotMatch(note, /NaN/);
    const formula = compiled(t);
    for (const s of ['', ' ', '0x10', '.5', '+5', 'Infinity']) assert.throws(() => formula.evaluate({ s }), { code: 'JQ2001' }, JSON.stringify(s));
    assert.strictEqual(valueOf(formula, { s: '12' }), 12);
  });

  it('writes toFixed exactly where it can, as String does from 1e21, and refuses the row in between', () => {
    agrees((row) => { if (row.x == null) return null; return row.x.toFixed(2); },
      [{ x: 1e15 }, { x: 1e21 }, { x: -1.5e21 }, { x: 123.456 }, { x: -0.004 }, { x: 9007199254740990 }, { x: 99999999999.995 }]);
    agrees((row) => { if (row.x == null) return null; return row.x.toFixed(20); }, [{ x: 0.000001 }, { x: 1 }]);
    const two = compiled(translateFormulaBody('if (row.x == null) return null;\nreturn row.x.toFixed(2);'));
    assert.throws(() => two.evaluate({ x: 1000000000000000.25 }), { code: 'JQ2001' });
    const twelve = compiled(translateFormulaBody('if (row.x == null) return null;\nreturn row.x.toFixed(12);'));
    assert.throws(() => twelve.evaluate({ x: 123456.789 }), { code: 'JQ2001' });
  });
});

describe('number formats of every shipped language', () => {
  const PACKS = { ar, de, es, fr, ja, ko, nl, pt, ru, tr, 'zh-TW': zhTW };
  /** The option sets toLocaleString translates in the decimal style. */
  const OPTION_SETS = [{}, { maximumFractionDigits: 0 }, { maximumFractionDigits: 1 }, { minimumFractionDigits: 2 },
    { minimumFractionDigits: 1, maximumFractionDigits: 2 }];
  const ICU = { skip: process.versions.icu !== '78.3' && `the packs carry CLDR as ICU 78.3 ships it; this host runs ${process.versions.icu}` };
  const F64 = new Float64Array(1);
  const U64 = new BigUint64Array(F64.buffer);
  /** The doubles either side of a positive one. @param {number} x */
  const neighbours = (x) => [-1n, 1n].map((step) => { F64[0] = x; U64[0] += step; return F64[0]; });
  /** The values where rounding carries the integer part to 1000, 10000 or 100000, and the doubles either side. @param {number} fraction */
  const boundaries = (fraction) => [3, 4, 5].flatMap((digits) => {
    const half = Number(`${'9'.repeat(digits)}.${'9'.repeat(fraction)}5`);
    return [half, ...neighbours(half), 10 ** digits, 10 ** digits - 1];
  });
  /** A body's translation under a pack's number description, compiled. @param {string} tag @param {any} pack @param {string} body @param {Record<string, string>} [currencies] */
  const translatedUnder = (tag, pack, body, currencies) => {
    const { decimalFormat, minimumGroupingDigits } = compileNumberLocale(pack);
    const described = { decimalFormat: tag, grouping: decimalFormat.groupingSeparator, decimal: decimalFormat.decimalSeparator, minimumGroupingDigits, currencies };
    const t = translateFormulaBody(body, { locales: { [tag]: described } });
    assert.notStrictEqual(t.state, 'untranslatable', `${body}: ${JSON.stringify(t.reasons)}`);
    return compileJsonQuery(t.expression, { decimalFormats: { [tag]: decimalFormat } });
  };

  it('writes every value from 1000 to 99999 and every rounding boundary as Intl.NumberFormat does, four-digit numbers included', ICU, () => {
    const integers = Array.from({ length: 99000 }, (_, i) => 1000 + i);
    for (const [tag, pack] of Object.entries(PACKS)) {
      for (const options of OPTION_SETS) {
        const written = Object.entries(options).map(([key, n]) => `${key}: ${n}`).join(', ');
        const query = translatedUnder(tag, pack, `if (row.x == null) return null;\nreturn row.x.toLocaleString('${tag}'${written ? `, { ${written} }` : ''});`);
        const intl = new Intl.NumberFormat(tag, options);
        const fraction = options.maximumFractionDigits ?? Math.max(options.minimumFractionDigits ?? 0, 3);
        const differ = [];
        for (const x of [...integers, ...boundaries(fraction), 1234.5, 9999.25, 12345.678, 999.5]) {
          const got = query({ x });
          if (got !== intl.format(x)) differ.push(`${x}: ${got} for ${intl.format(x)}`);
        }
        assert.deepStrictEqual(differ.slice(0, 5), [], `${tag} ${JSON.stringify(options)}`);
      }
    }
  });

  it('writes a currency in a language that groups from five digits only as Intl.NumberFormat does', ICU, () => {
    const query = translatedUnder('es', es, "if (row.x == null) return null;\nreturn row.x.toLocaleString('es', { style: 'currency', currency: 'EUR' });",
      { EUR: '#.##0,00\u00a0\u20ac;-#.##0,00\u00a0\u20ac' });
    const intl = new Intl.NumberFormat('es', { style: 'currency', currency: 'EUR' });
    const differ = [];
    for (const x of [...Array.from({ length: 9900 }, (_, i) => 100 + i * 10 + 0.25), ...boundaries(2), -1234.5, -12345.5, 0])
      if (query({ x }) !== intl.format(x)) differ.push(`${x}: ${query({ x })} for ${intl.format(x)}`);
    assert.deepStrictEqual(differ.slice(0, 5), []);
    const ungrouped = translatedUnder('es', es, "if (row.x == null) return null;\nreturn row.x.toLocaleString('es', { style: 'currency', currency: 'XTS' });",
      { XTS: '0,00\u00a0X' });
    assert.deepStrictEqual([1234.5, 12345.5].map((x) => ungrouped({ x })), ['1234,50\u00a0X', '12345,50\u00a0X'], 'a picture without separators is written as it is');
  });

  it('refuses a language description whose minimum grouping digits are not a positive whole number', () => {
    for (const minimumGroupingDigits of [0, 1.5, '2'])
      assert.throws(() => translateFormulaBody('return 1;', { locales: { es: /** @type {any} */ ({ decimalFormat: 'es', grouping: '.', decimal: ',', minimumGroupingDigits }) } }),
        /locale 'es' must be/);
  });
});

describe('names that only Object.prototype holds, and literals JSON cannot hold', () => {
  it('maps no helper, language or currency that only Object.prototype names', () => {
    refuses('return toString(row.a);', 'helper', 'toString');
    refuses('return helpers.valueOf(row.a);', 'helper', 'helpers.valueOf');
    refuses("return row.n.toLocaleString('constructor');", 'locale', "'constructor'");
    refuses("return row.n.toLocaleString('nl-NL', { style: 'currency', currency: 'toString' });", 'locale', '{ style');
  });

  it('writes an overflowing literal as Infinity and keeps the sign of a negative zero through a stored formula', () => {
    // 1e999 is Infinity in JavaScript
    const huge = compiled(translateFormulaBody("if (row.x == null) return null;\nreturn row.x < 1e999 ? 'finite' : 'huge';"));
    assert.deepStrictEqual([valueOf(huge, { x: 1 }), valueOf(huge, { x: 1e308 })], ['finite', 'finite']);
    const stored = JSON.parse(JSON.stringify(translateFormulaBody('return 1 / -0 < 0;').expression));
    assert.strictEqual(compileFormula(formulaDocument({ $formula: '1', id: 'z', revision: '1', expression: stored })).evaluate({}).value, true);
  });

  it('records a translation the formula document refuses as untranslatable, and migrates the other sources', async () => {
    const translate = { helpers: { huge: { native: { params: ['v'], expression: { $mul: ['$v', Infinity] } } } } };
    const sources = [
      { id: 'ok', label: 'ok', enabled: true, storageVersion: 1, body: 'return row.a ?? 0;' },
      { id: 'bad', label: 'bad', enabled: true, storageVersion: 1, body: 'return huge(row.a);' },
    ];
    const { records } = await migrateFormulas(sources, [], { translate });
    assert.deepStrictEqual(records.map((r) => [r.id, r.state, r.reason]), [['ok', 'translated', 'translated'], ['bad', 'untranslatable', 'compile']]);
  });
});

describe('block scope and the row parameter', () => {
  it('ends a let or const at its block, and keeps what the block assigns to an outer let', () => {
    // eslint-disable-next-line no-unused-vars
    agrees((row) => { const x = row.a; { const x = row.b; } return x; }, [{ a: 1, b: 2 }]);
    // eslint-disable-next-line no-unused-vars
    agrees((row) => { let label = 'low'; if (row.f) { const label = 'high'; } return label; }, [{ f: true }, { f: false }]);
    agrees((row) => { let t = 1; { const k = 2; t = t + k; } return t + (row.n ?? 0); }, [{}, { n: 1 }]);
    agrees((row) => { let t = 1; if (row.f) { const k = 2; t = t * k; } return t; }, [{ f: true }, {}]);
    refuses('{ const y = row.a; }\nreturn y;', 'unknown-name', 'y;');
  });

  it('refuses a name read or assigned before its let or const, and an assignment to a const', () => {
    refuses('const x = row.a;\n{ const x = x + 1; }\nreturn x;', 'unknown-name', 'x + 1');
    refuses('let y = 1;\nif (row.f) { let y = y * 2; }\nreturn y;', 'unknown-name', 'y * 2');
    refuses('let y = 1;\n{ y = 2; let y = 3; }\nreturn y;', 'assignment', 'y = 2');
    refuses('const x = 1;\nx = 2;\nreturn x;', 'assignment', 'x = 2');
  });

  it("reads a callback parameter or a var named like the row's parameter as itself", () => {
    const rows = [{ n: 'outer', items: [{ n: 'a' }, { n: 'b' }] }];
    agrees((row) => { if (!row.items) return null; return row.items.filter((row) => row.n === 'a').length; }, rows);
    agrees((row) => { if (!row.items) return null; return row.items.map((row) => row.n); }, rows);
    assert.strictEqual(valueOf(compiled(translateFormulaBody("var row = { n: 'mine' };\nreturn row.n;")), { n: 'outer' }), 'mine');
    refuses('let row = 1;\nreturn row;', 'syntax', 'row = 1');
  });
});

describe('arrays changed in place', () => {
  it('refuses sorting an array the body reads in place, and sorts a copy or a fresh result', () => {
    refuses('if (!row.l) return null;\nconst sorted = row.l.sort((a, b) => a.k - b.k);\nreturn row.l.map((e) => e.n);', 'sort', 'row.l.sort');
    const rows = [{ l: [{ n: 'a', k: 1 }, { n: 'b', k: 3 }, { n: 'c', k: 2 }] }];
    agrees((row) => { if (!row.l) return null; return [...row.l].sort((a, b) => b.k - a.k).map((e) => e.n); }, rows);
    agrees((row) => { if (!row.l) return null; return row.l.filter((e) => e.k > 1).sort((a, b) => a.k - b.k).map((e) => e.n); }, rows);
  });

  it("refuses a push to an array that may be the row's own, or that another name holds too", () => {
    refuses("const l = row.tags ?? [];\nl.push('x');\nreturn row.tags;", 'push', 'l.push');
    refuses('const l = [];\nconst m = l;\nm.push(1);\nreturn l;', 'push', 'm.push');
    refuses('const l = [];\nconst m = l;\nl.push(1);\nreturn m;', 'push', 'l.push');
    agrees((row) => { const l = []; if (row.a) l.push('a'); if (row.b) { l.push('b'); l.push('c'); } return l.join(','); }, [{ a: 1, b: 1 }, {}]);
  });
});

describe('spread, join and includes', () => {
  it('spreads text into its characters, and joins with a comma where the separator is missing', () => {
    agrees((row) => { if (row.s == null) return null; return [...row.s].length; }, [{ s: 'abc' }, { s: '\u{1F600}x' }, { s: '' }]);
    agrees((row) => { if (row.s == null) return null; return [...row.s].join('|'); }, [{ s: 'a\u{1F600}' }]);
    agrees((row) => { if (!row.l) return null; return row.l.join(row.sep); }, [{ l: [1, 2] }, { l: [1, 2], sep: '+' }, { l: [1, 2], sep: null }, { l: ['a'], sep: 0 }]);
  });

  it('writes a null element as empty text, as JavaScript joins', () => {
    agrees((row) => { if (!row.l) return null; return row.l.join('-'); }, [{ l: [1, null, 2] }, { l: ['a', null, 'b'] }, { l: [null] }, { l: [] }]);
    agrees((row) => { if (!row.l) return null; return row.l.join(); }, [{ l: [1, null, 2] }]);
  });

  it('finds NaN as includes does, and names identity for a value that may be an object', () => {
    agrees((row) => { if (row.a == null || row.b == null) return null; return [row.a / row.b].includes(row.a / row.b); }, [{ a: 0, b: 0 }, { a: 1, b: 2 }]);
    names('const l = row.l ?? [];\nreturn l.includes(row.o);', 'identity', 'l.includes');
  });
});

describe('equality', () => {
  it('names loose-equality where == compares a literal with a value of unknown type', () => {
    for (const body of ['return row.a == 1;', 'return row.a != 0;', "return row.a == '';", 'return row.a == true;'])
      names(body, 'loose-equality', 'row.a');
  });

  it('compares two reads by identity, as === compares objects', () => {
    agrees((row) => { return row.a === row.b; }, [{ a: [1], b: [1] }, { a: { x: 1 }, b: { x: 1 } }, { a: 1, b: 1 }, { a: 'x', b: 'x' }, { a: null, b: null }, {}, { a: 0, b: -0 }]);
    agrees((row) => { const o = row.o; return o === row.o; }, [{ o: { x: 1 } }, { o: [1] }, {}]);
    assert.strictEqual(translateFormulaBody('return row.a === row.b;').state, 'translated');
  });
});

describe('case mapping in a language', () => {
  it('refuses case mapping in a language with its own rules, whatever spelling names it, and a tag JavaScript refuses', () => {
    for (const tag of ['tur', 'aze', 'lit', 'TR', 'tr_TR', 'az-Latn'])
      refuses(`if (row.s == null) return null;\nreturn row.s.toLocaleUpperCase('${tag}');`, 'locale', 'row.s.toLocaleUpperCase');
    agrees((row) => { if (row.s == null) return null; return row.s.toLocaleUpperCase('nl-NL'); }, [{ s: 'istanbul' }]);
  });
});

describe('explanations', () => {
  it("writes an explanation's null or missing text as empty text", () => {
    const note = (/** @type {any} */ value, /** @type {any} */ text) => ({ value, text: String(text ?? '') });
    const formula = compiled(translateFormulaBody('return note(row.v, row.why);', { explain: 'note' }));
    for (const row of [{ v: 1, why: 'x' }, { v: 1, why: null }, { v: 1 }, { v: 1, why: 3 }]) {
      const js = note(row.v, row.why);
      assert.deepStrictEqual(formula.evaluate(row), { kind: 'explanation', text: js.text, value: js.value }, JSON.stringify(row));
    }
  });
});

describe('the parser', () => {
  it('refuses what JavaScript refuses, at its position', () => {
    for (const [body, needle] of [
      ['return row.a ?? row.b || 1;', '||'],
      ['return row.a || row.b ?? 1;', '??'],
      ['return row.a && row.b ?? 1;', '??'],
      ['return 1__0;', '1__0'],
      ['return 1_;', '1_'],
      ['return 1._5;', '1._5'],
      ['return 0_1;', '0_1'],
      ['return 00.5;', '00.5'],
      ['return 0x_1;', '0x_1'],
      ['return typeof row.a ** 2;', '**'],
      ['const x = 1;\nconst x = 2;\nreturn x;', 'x = 2'],
      ['let x = 1;\nlet x = 2;\nreturn x;', 'x = 2'],
      ['var x = 1;\nlet x = 2;\nreturn x;', 'x = 2'],
      ['let x = 1;\n{ var x = 2; }\nreturn x;', 'x = 2'],
      ['if (row.a) const x = 1;\nreturn 2;', 'const'],
      ['return new row.a?.b();', '?.'],
    ]) {
      const t = translateFormulaBody(body);
      assert.strictEqual(t.reasons[0]?.kind, 'syntax', body);
      assert.deepStrictEqual([t.reasons[0].at.line, t.reasons[0].at.column], at(body, needle), body);
    }
    for (const body of ['return (row.a ?? row.b) || 1;', 'return row.a ?? (row.b || 1);', 'return 1_000.5;', 'return 0x1_F;', 'return (-row.a) ** 2;',
      'var x = 1;\nvar x = 2;\nreturn x;', 'const x = 1;\n{ const x = 2; }\nreturn x;', 'if (row.a) var x = 1;\nreturn 2;', 'return new Date(row.d).getTime();'])
      assert.notStrictEqual(translateFormulaBody(body).reasons[0]?.kind, 'syntax', body);
  });
});

describe('numbers and sorts at the edges of the subset', () => {
  it('reads octal and binary literals as JavaScript does', () => {
    agrees((row) => { if (row.n == null) return null; return row.n + 0o17 + 0b101; }, [{ n: 1 }, { n: -20 }]);
    refuses('return row.n + 0o;', 'syntax', '0o');
    refuses('return row.n + 0b2;', 'syntax', '0b2');
  });

  it('refuses a sort without a key comparator, or with one that is no difference of keys', () => {
    refuses('return [...row.l].sort((a, b) => a.k * b.k);', 'sort', '[...row.l]');
    refuses('return [...row.l].sort((a, b) => a.k - a.j);', 'sort', '[...row.l]');
    refuses('return [...row.l].sort((a) => a.k);', 'sort', '[...row.l]');
  });
});

describe('the format', () => {
  it('lists every difference and reason kind the translation emits in FORMULA-FORMAT, and none it never emits', () => {
    const doc = readFileSync(new URL('../../packages/json/docs/FORMULA-FORMAT.md', import.meta.url), 'utf8');
    const migration = doc.slice(doc.indexOf('## Explicit migration'), doc.indexOf('## Reviewed plans'));
    const source = ['translate.js', 'migrate.js'].map((file) => readFileSync(new URL(`../../packages/json/src/formula/${file}`, import.meta.url), 'utf8')).join('\n');
    const emitted = new Set([...source.matchAll(/\b(?:differ|reason)\('([A-Za-z-]+)'|\bkind: '([A-Za-z-]+)', at:/g)].map((m) => m[1] ?? m[2]));
    for (const kind of emitted) assert.ok(migration.includes(`\`${kind}\``), `${kind} is not in FORMULA-FORMAT`);
    // the difference and reason tables list nothing the translation does not emit
    const table = (/** @type {string} */ header) => migration.slice(migration.indexOf(header)).split('\n\n')[0];
    const listed = [...`${table('| Difference |')}\n${table('| Reason |')}`.matchAll(/^\| `([A-Za-z-]+)`/gm)].map((m) => m[1]);
    assert.ok(listed.length > 40, `${listed.length} kinds listed`);
    for (const kind of listed) assert.ok(emitted.has(kind), `FORMULA-FORMAT lists ${kind}, which the translation never emits`);
  });
});
