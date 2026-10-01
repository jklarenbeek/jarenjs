//@ts-check
/**
 * @file The JavaScript formula translator (FORMULA-FORMAT, "Translating a
 * saved source"): the parser's grammar, positions and refusals; each
 * translation agreeing with the JavaScript it replaces on present, null and
 * absent members; each named difference and each reason, with its position;
 * the options; and a translation that does not depend on what ran before it.
 * Every equivalence runs a function written in this file and translates that
 * same function's body text, so the two cannot drift apart.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { compileFormula, formulaDocument } from '@jarenjs/json/formula';
import { translateFormulaBody } from '@jarenjs/json/formula/migrate';
import { compileNumberLocale, nl } from '@jarenjs/locales';

const decimalFormats = { nl: compileNumberLocale(nl).decimalFormat };
const locales = { 'nl-NL': { decimalFormat: 'nl', grouping: '.', decimal: ',', currencies: { EUR: '€ #.##0,00;€ -#.##0,00' } } };

/** The text between a function's outer braces. @param {Function} fn */
function bodyOf(fn) {
  const text = fn.toString();
  return text.slice(text.indexOf('{', text.indexOf('=>')) + 1, text.lastIndexOf('}')).replace(/^\n/, '').replace(/\n\s*$/, '');
}

/** Translate a function's body and evaluate it on a row, as a formula. @param {Function} fn @param {any} [options] */
function translated(fn, options = {}) {
  const t = translateFormulaBody(bodyOf(fn), { locales, ...options });
  assert.notStrictEqual(t.state, 'untranslatable', JSON.stringify(t.reasons));
  const formula = compileFormula(formulaDocument({ $formula: '1', id: 'f', revision: '1', expression: t.expression,
    ...(t.resultMode === 'outcome' ? { resultMode: 'outcome' } : {}) }), { decimalFormats });
  return { t, run: (/** @type {any} */ row) => { const r = formula.evaluate(row); return r.kind === 'empty' ? undefined : r.kind === 'value' ? r.value : r; } };
}

/** Assert a translation agrees with its function on every row. @param {Function} fn @param {any[]} rows @param {any} [options] */
function agrees(fn, rows, options) {
  const { t, run } = translated(fn, options);
  for (const row of rows) {
    const js = fn(row);
    // a JSON round trip, but for a number (its signed zero is the same in memory on both sides)
    const want = js === undefined ? undefined : typeof js === 'number' ? js : JSON.parse(JSON.stringify(js));
    assert.deepStrictEqual(run(row), want, `${bodyOf(fn)} on ${JSON.stringify(row)}`);
  }
  return t;
}

const PRESENCE = [{ a: 3 }, { a: null }, {}, { a: 0 }, { a: '' }, { a: 'x' }, { a: false }, { a: [] }, { a: {} }];

describe('the parser', () => {
  it('reads statements, expressions and comments, and positions what it cannot read', () => {
    const t = translateFormulaBody('const a = row.x?.y; // a comment\n/* block */ if (!a) return null;\nreturn `${a}`;');
    assert.strictEqual(t.state, 'translated', 'the guard proves the template\'s value present');
    for (const [body, line, column, message] of /** @type {[string, number, number, RegExp][]} */ ([
      ['return 1 +', 1, 11, /an expression expected, the source ended/],
      ["return 'open", 1, 8, /an unterminated string/],
      ['return row.\\u0061;', 1, 12, /an escaped identifier/],
      ['return 010;', 1, 8, /a legacy octal number/],
      ['const x = 1;\nreturn x +* 2;', 2, 11, /an expression expected, '\*' found/],
      ['return row.a\n  .b c;', 2, 6, /';' expected/],
      ['class A {}', 1, 1, null],
    ])) {
      const r = translateFormulaBody(body);
      assert.strictEqual(r.state, 'untranslatable', body);
      if (message) {
        assert.strictEqual(r.reasons[0].kind, 'syntax', body);
        assert.deepStrictEqual([r.reasons[0].at.line, r.reasons[0].at.column], [line, column], body);
        assert.match(r.reasons[0].message, message);
      }
    }
  });

  it('accepts what JavaScript accepts and nothing more: Unicode names by their properties', () => {
    assert.strictEqual(translateFormulaBody('const größe = row.a; return größe;').state, 'translated');
    assert.strictEqual(translateFormulaBody('return row.💩;').reasons[0].kind, 'syntax');
    assert.strictEqual(translateFormulaBody('return row.a +﻿1;').state, 'translated-with-differences', 'no-break space and BOM are white space');
  });
});

describe('the translation agrees with JavaScript', () => {
  it('?? and == null over present, null and absent members (the documented equivalents)', () => {
    agrees((row) => { return row.a ?? 'fallback'; }, PRESENCE);
    agrees((row) => { return row.a == null; }, PRESENCE);
    agrees((row) => { return row.a != null; }, PRESENCE);
    agrees((row) => { return row.a === null; }, PRESENCE);
    agrees((row) => { return row.a === undefined; }, PRESENCE);
    agrees((row) => { return row.a?.b ?? 7; }, [{ a: { b: 1 } }, { a: { b: null } }, { a: null }, {}]);
  });

  it('truthiness as the effective boolean value, and && and || as the values they pick', () => {
    agrees((row) => { return row.a ? 'yes' : 'no'; }, PRESENCE);
    agrees((row) => { return !row.a; }, PRESENCE);
    agrees((row) => { if (!row.a || row.a === 'x') return 'skip'; return 'keep'; }, PRESENCE);
    agrees((row) => { const v = row.n || 5; return v * 2; }, [{ n: 3 }, { n: 0 }, {}]);
    agrees((row) => { return row.n && row.n > 2; }, [{ n: 3 }, { n: 1 }, { n: 0 }]);
  });

  it('statements: declarations, early returns, if/else, reassignment and push', () => {
    const rows = [{ p: 120, t: { r: 21, i: true } }, { p: 120, t: { r: 9, i: false } }, { p: 0, t: { r: 0, i: true } }, { t: null }, {}];
    agrees((row) => {
      const p = row.p;
      const t = row.t;
      if (p == null || t?.r == null) return null;
      const net = t.i ? p / (1 + t.r / 100) : p;
      if (net <= 0) return 'none';
      return Math.round(net);
    }, rows);
    agrees((row) => {
      let total = 0;
      const notes = [];
      if (row.a) { total += 2; notes.push('a'); }
      if (!row.b) notes.push('no b');
      else total = total * 10;
      return notes.join(', ') + ' ' + total;
    }, [{ a: 1, b: 1 }, { a: 1 }, { b: 2 }, {}]);
  });

  it('numbers: rounding, Math, and + as addition until the first text', () => {
    const rows = [{ x: 2.5 }, { x: -2.5 }, { x: 1.005 }, { x: 0.125 }, { x: -0.125 }, { x: 14 }];
    agrees((row) => { return Math.round(row.x); }, rows);
    agrees((row) => { return Math.ceil(row.x) + Math.floor(row.x) + Math.abs(row.x); }, rows);
    agrees((row) => { return Math.round(row.x * 100) / 100; }, rows);
    agrees((row) => { return Math.max(0, row.x) - Math.min(1, row.x); }, rows);
    // of two zeros Math.max takes +0 and Math.min -0, in either order
    agrees((row) => { return [1 / Math.max(row.x * 0, 0) > 0, 1 / Math.max(0, row.x * 0) > 0, 1 / Math.min(row.x * 0, 0) < 0, 1 / Math.min(0, row.x * 0) < 0]; },
      [{ x: -5 }, { x: 5 }]);
    agrees((row) => { return 1 + 2 + 'x' + row.x + 3; }, rows);
    agrees((row) => { return `t ${row.x} ${row.x * 2}`; }, rows);
  });

  it('numbers as text: toFixed and the Dutch number formats, as ICU writes them', () => {
    const rows = [{ x: 1234.5 }, { x: -1234.567 }, { x: 0.015 }, { x: 1.005 }, { x: -0.125 }, { x: 0 }, { x: 1e15 }];
    agrees((row) => { return row.x.toFixed(2); }, rows);
    agrees((row) => { return row.x.toFixed(0) + '|' + row.x.toFixed(1); }, rows);
    agrees((row) => { return row.x.toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' }); }, rows);
    agrees((row) => { return row.x.toLocaleString('nl-NL', { maximumFractionDigits: 1 }); }, rows);
    agrees((row) => { return row.x.toLocaleString('nl-NL'); }, rows);
    agrees((row) => { return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(row.x / 100); }, rows);
    agrees((row) => { return (row.x / 0 - row.x / 0).toLocaleString('nl-NL', { style: 'currency', currency: 'EUR' }); }, [{ x: 1 }], {});
  });

  it('text: case, trimming as JavaScript trims, searching and the text before a separator', () => {
    const rows = [{ s: '  Fern Mix  ' }, { s: 'ROSE' }, { s: '' }, { s: 'one two three' }, { s: '﻿x　' }];
    agrees((row) => { return row.s.trim(); }, rows);
    agrees((row) => { return row.s.toLowerCase() + '|' + row.s.toUpperCase(); }, rows);
    agrees((row) => { return row.s.toLowerCase().includes('e') && row.s.startsWith('o') || row.s.endsWith(' '); }, rows);
    agrees((row) => { return row.s.split(' ')[0]; }, rows);
    agrees((row) => { return row.s.trim().length; }, rows);
  });

  it('regular expressions: \\s, \\d, . and the anchors exactly, case-insensitive tests', () => {
    const rows = [{ s: 'a  b c' }, { s: '#rose' }, { s: 'Item-12' }, { s: 'x y' }, { s: 'ABC 9' }, { s: '' }];
    agrees((row) => { return row.s.replace(/\s+/g, ' '); }, rows);
    agrees((row) => { return row.s.replace(/^#/, ''); }, rows);
    agrees((row) => { return row.s.replace(/-\d+$/, ''); }, rows);
    agrees((row) => { return row.s.replace(/^-+|-+$/g, ''); }, [{ s: '--a-b--' }, { s: 'a' }, { s: '-' }]);
    agrees((row) => { return /\d/.test(row.s) + '|' + /b.c/.test(row.s) + '|' + /abc/i.test(row.s); }, rows);
    agrees((row) => { return row.s.replace(/[^a-z0-9]+/g, '-'); }, rows);
  });

  it('arrays: callbacks, sort, join, length, includes and spread', () => {
    const rows = [{ list: [{ n: 'b', s: 3 }, { n: 'a', s: 1 }, { n: 'c', s: 5 }] }, { list: [] }, { list: [{ n: 'x', s: 0 }] }];
    agrees((row) => { return row.list.map((e) => e.n).join('-'); }, rows);
    agrees((row) => { return row.list.filter((e) => e.s > 1).length; }, rows);
    agrees((row) => { return row.list.find((e) => e.s >= 3)?.n ?? 'none'; }, rows);
    agrees((row) => { return row.list.some((e) => e.s === 0) + '|' + row.list.every((e) => e.s >= 1); }, rows);
    agrees((row) => { return [...row.list].sort((a, b) => b.s - a.s).map((e) => e.n).join(''); }, rows);
    agrees((row) => { return row.list.map((e) => e.n).includes('a'); }, rows);
    agrees((row) => { return row.list.every((e, i) => e.n !== 'a' || i > 0); }, rows);
  });

  it('dates: the clock is the host\'s, and an RFC 3339 date reads as JavaScript reads it', () => {
    const { t, run } = translated((row) => { return Math.floor((Date.now() - new Date(row.since).getTime()) / 86400000); });
    assert.deepStrictEqual(t.differences.map((d) => d.kind), ['clock', 'date-parse']);
    const formula = compileFormula(formulaDocument({ $formula: '1', id: 'd', revision: '1', expression: t.expression }));
    const now = Date.parse('2026-10-01T12:00:00Z');
    assert.deepStrictEqual(formula.evaluate({ since: '2026-09-01T12:00:00Z' }, { now }), { kind: 'value', value: 30 });
    void run;
  });
});

describe('outcomes: the skip sentinel, explanations and undefined', () => {
  it('returns skip for the sentinel and for undefined, an explanation for the explaining helper', () => {
    const options = { skip: 'LEAVE', explain: 'note' };
    const body = 'if (row.p == null) return LEAVE;\nif (row.p === 1) return;\nreturn row.q || LEAVE;';
    const t = translateFormulaBody(body, options);
    assert.strictEqual(t.resultMode, 'outcome');
    const f = compileFormula(formulaDocument({ $formula: '1', id: 'o', revision: '1', expression: t.expression, resultMode: 'outcome' }));
    assert.deepStrictEqual([f.evaluate({}), f.evaluate({ p: 1 }), f.evaluate({ p: 2, q: 0 }), f.evaluate({ p: 2, q: 5 })],
      [{ kind: 'skip' }, { kind: 'skip' }, { kind: 'skip' }, { kind: 'value', value: 5 }]);
    const e = translateFormulaBody('return lib.note(row.v, `because ${row.why}`);', { ...options, helperObject: 'lib' });
    const g = compileFormula(formulaDocument({ $formula: '1', id: 'e', revision: '1', expression: e.expression, resultMode: 'outcome' }));
    assert.deepStrictEqual(g.evaluate({ v: 3, why: 'x' }), { kind: 'explanation', text: 'because x', value: 3 });
    assert.deepStrictEqual(g.evaluate({ why: 'x' }), { kind: 'skip' }, 'an explained undefined skips');
    const m = translateFormulaBody("return { explanation: 'protected' };", { explanationMember: 'explanation' });
    assert.deepStrictEqual(m.expression, { kind: 'explanation', text: 'protected' });
  });
});

describe('the named differences, each with its position', () => {
  /** @param {string} body @param {string} kind @param {[number, number]} at @param {any} [options] */
  const names = (body, kind, at, options = {}) => {
    const t = translateFormulaBody(body, { locales, ...options });
    const d = t.differences.find((x) => x.kind === kind);
    assert.ok(d, `${body}: ${JSON.stringify(t.differences)} ${JSON.stringify(t.reasons)}`);
    assert.deepStrictEqual([d.at.line, d.at.column], at, `${body}: ${kind}`);
    assert.ok(d.note.length > 10);
  };
  it('names where JavaScript and the query part ways', () => {
    names("return 'x' + row.a;", 'concat-undefined', [1, 14]);
    names('return row.a.b;', 'absent-receiver', [1, 8]);
    names('return row.a * 2;', 'nullish-arithmetic', [1, 8]);
    names('return row.a < 5;', 'nullish-comparison', [1, 8]);
    names('return Date.now();', 'clock', [1, 8]);
    names('return new Date(row.d).getTime();', 'date-parse', [1, 8]);
    names('const T = { a: 1 }; return T[row.k];', 'prototype-key', [1, 28]);
    names('const l = row.list ?? []; return l.filter((x) => x !== l[0]).length;', 'identity', [1, 50]);
    names('return [row.a];', 'absent-element', [1, 9]);
    names('return row.s.replace(/a\\b/g, "");', 'regex-subset', [1, 22]);
    names('return [...row.l ?? []].sort((a, b) => a.k - b.k);', 'sort-key', [1, 30]);
    names('return row.a % row.b;', 'remainder-by-zero', [1, 8]);
    names('return Number(row.s);', 'number-parse', [1, 8]);
    names("return row.s.replace(/x/g, row.r ?? '');", 'replacement-pattern', [1, 28]);
    names('return row.a == row.b;', 'loose-equality', [1, 8]);
  });

  it('reads a destructuring of plain names as the members it names', () => {
    agrees((row) => { const { p, q: r } = row; return p + r; }, [{ p: 1, q: 2 }]);
    agrees((row) => { const { a, b } = row.o ?? {}; return [a ?? 0, b ?? 0].join('/'); }, [{ o: { a: 1, b: 2 } }, { o: null }, {}]);
    const t = translateFormulaBody('const { a, b } = row.o;\nreturn a ?? b;');
    assert.deepStrictEqual(t.differences.map((d) => [d.kind, d.at.line, d.at.column]), [['absent-receiver', 1, 9], ['absent-receiver', 1, 12]]);
    for (const body of ['const { a = 1 } = row; return a;', 'const { a: { b } } = row; return b;', 'const [a] = row.l; return a;', 'const { ...r } = row; return r;'])
      assert.strictEqual(translateFormulaBody(body).reasons[0]?.kind, 'destructuring', body);
    assert.strictEqual(translateFormulaBody('return row.a === void 0;').state, 'translated');
  });

  it('names nothing for a guarded read', () => {
    for (const body of ['if (row.a == null) return null;\nreturn row.a * 2;', 'if (!row.a) return 0;\nreturn row.a.b;', 'return row.a?.b ?? 1;', "return 'x' + (row.a ?? '');"])
      assert.deepStrictEqual(translateFormulaBody(body).differences, [], body);
  });
});

describe('the reasons, each with its position', () => {
  it('names every construct outside the subset, and reads no code inside a string or a comment', () => {
    for (const [body, kind, at] of /** @type {[string, string, [number, number]][]} */ ([
      ['for (const x of row.l) {}\nreturn 1;', 'loop', [1, 1]],
      ["throw new Error('no');", 'throw', [1, 1]],
      ['return 1;\nrow.a = 2;', 'unreachable', [2, 1]],
      ['return\nrow.a;', 'return-line-break', [1, 1]],
      ['row.a = 1; return 1;', 'statement', [1, 1]],
      ['return row.s.match(/(\\d+)/)[1];', 'method', [1, 8]],
      ['return row.s.replace(/(?=a)/, "");', 'regex', [1, 22]],
      ['return row.s.replace("a", "b");', 'replace-first', [1, 8]],
      ['return row.n.toLocaleString("en-GB");', 'locale', [1, 29]],
      ['return helper(row.a);', 'helper', [1, 8]],
      ['return unknownName;', 'unknown-name', [1, 8]],
      ['return typeof row.a;', 'typeof', [1, 8]],
      ['return row.s.split(" ");', 'split', [1, 8]],
      ['return row.l.reduce((a, b) => a + b, 0);', 'method', [1, 8]],
      ["return row.s.includes('e');", 'includes', [1, 8]],
      ['return new Set(row.l).size;', 'new', [1, 8]],
      ['return row.s.length;', 'length', [1, 8]],
    ])) {
      const t = translateFormulaBody(body, { locales });
      assert.strictEqual(t.state, 'untranslatable', body);
      const r = t.reasons.find((x) => x.kind === kind);
      assert.ok(r, `${body}: ${JSON.stringify(t.reasons)}`);
      assert.deepStrictEqual([r.at.line, r.at.column], at, body);
    }
    // text inside strings and comments is not read as code
    assert.strictEqual(translateFormulaBody("return 'throw';").state, 'translated');
    assert.strictEqual(translateFormulaBody('// uses the helpers\nreturn row.a ?? 1;').state, 'translated');
  });

  it('lists every blocker, not the first', () => {
    const t = translateFormulaBody('while (row.a) {}\nthrow row.b;\nreturn typeof row.c;');
    assert.deepStrictEqual(t.reasons.map((r) => [r.kind, r.at.line]), [['loop', 1], ['throw', 2], ['unreachable', 3], ['typeof', 3]]);
  });
});

describe('the options', () => {
  it('names the row, the helpers and the conventions; refuses an unknown option', () => {
    assert.strictEqual(translateFormulaBody('return item.a ?? 0;', { argument: 'item' }).state, 'translated');
    assert.strictEqual(translateFormulaBody('return row.a ?? 0;', { argument: 'item' }).reasons[0].kind, 'unknown-name');
    assert.throws(() => translateFormulaBody('return 1;', /** @type {any} */ ({ argumnet: 'x' })), /unknown translation option 'argumnet'/);
    assert.throws(() => translateFormulaBody('return 1;', { helpers: /** @type {any} */ ({ f: { run: () => 1 } }) }), /must be \{ call/);
    const t = translateFormulaBody('return twice(row.a);', { helpers: { twice: { native: { params: ['v'], expression: { $mul: ['$v', 2] } }, returns: 'number' } } });
    assert.strictEqual(compileFormula(formulaDocument({ $formula: '1', id: 'n', revision: '1', expression: t.expression })).evaluate({ a: 4 }).value, 8);
    const c = translateFormulaBody('return slugOf(row.a);', { helpers: { slugOf: { call: { name: 'slug', version: '2' } } } });
    assert.deepStrictEqual(c.helpers, [{ name: 'slug', version: '2' }]);
  });

  it('translates one body the same whatever was translated before it', () => {
    const body = 'const a = row.x ?? 1;\nlet b = a * 2;\nif (row.y) b = b + 1;\nreturn [a, b].map((v) => v * 2).join(", ");';
    const first = translateFormulaBody(body);
    translateFormulaBody('const t = 1; const items = [t]; return items.length;');
    assert.deepStrictEqual(translateFormulaBody(body), first);
  });
});
