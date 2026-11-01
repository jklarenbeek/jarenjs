//@ts-check
/**
 * @file Dates a saved formula writes with `toLocaleDateString` or
 * `Intl.DateTimeFormat` (FORMULA-FORMAT, "The report"): translated onto
 * `$date-format` for a language whose date pictures the host declares, in the
 * zone the host declares, the host's own zone named as a difference and
 * checked against `Intl` over the zone edges; the options and zones no picture
 * states named as reasons; the declaration's refusals; and the route the
 * document gives for a weight in grams, run as printed.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { checkFormulaParity, compileFormula, formulaDocument } from '@jarenjs/json/formula';
import { translateFormulaBody } from '@jarenjs/json/formula/migrate';
import { compileDateLocale, nl } from '@jarenjs/locales';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ICU = { skip: process.versions.icu !== '78.3' && `the Dutch pictures are those ICU 78.3 writes; this host runs ${process.versions.icu}` };
const dateNames = compileDateLocale(nl).names;
const NUMBERS = { decimalFormat: 'nl', grouping: '.', decimal: ',' };
/** The Dutch pictures ICU writes for the date fields and styles the tests name. */
const DUTCH = { yMd: 'd-M-y', yMMdd: 'dd-MM-y', yyMMdd: 'dd-MM-yy', yMMMMd: 'd MMMM y', yMMMd: 'd MMM y', yMMMMEEEEd: 'EEEE d MMMM y',
  yMMMEEEd: 'EEE d MMM y', MMMMd: 'd MMMM', MMMM: 'MMMM', EEEE: 'EEEE', y: 'y', short: 'dd-MM-y', medium: 'd MMM y', long: 'd MMMM y', full: 'EEEE d MMMM y' };
/** @param {Record<string, any>} [extra] */
const locales = (extra = {}) => ({ 'nl-NL': { ...NUMBERS, dates: DUTCH, ...extra } });

/**
 * Dates at the zone edges: a date alone, late evening in UTC (and in summer),
 * the nights Europe/Amsterdam changes its clock and the evening before,
 * offsets of their own, a lower-case form, a fraction past the millisecond
 * (JavaScript cuts it), the year 999 (written `999`) and the last day RFC 3339
 * spells.
 */
const FIXTURE = ['2026-10-31', '2026-01-05', '2028-02-29', '0999-01-05', '9999-12-31',
  '2026-10-31T22:59:59Z', '2026-10-31T23:00:00Z', '2026-10-31T23:30:00Z', '2026-07-15T22:30:00Z',
  '2026-10-24T22:30:00Z', '2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z', '2026-03-28T23:30:00Z', '2026-03-29T00:59:59Z', '2026-03-29T01:00:00Z',
  '2026-10-31T23:30:00+01:00', '2026-10-31T23:30:00-05:00', '2026-10-31T00:30:00+02:00', '2026-10-31t10:00:00z',
  '2026-12-31T23:59:59.999Z', '2026-12-31T23:59:59.9999Z'].map((date) => ({ date }));

/** @param {any} t */
const compiled = (t) => compileFormula(formulaDocument({ $formula: '1', id: 'd', revision: '1', expression: t.expression }), { dateNames });

/**
 * A body translated, compiled with the Dutch names, and checked against
 * `Intl.DateTimeFormat` in a zone over the rows.
 * @param {string} body @param {any} translate @param {Intl.DateTimeFormatOptions} intlOptions @param {string} timeZone
 */
function parity(body, translate, intlOptions, timeZone, rows = FIXTURE) {
  const t = translateFormulaBody(body, { argument: 'item', ...translate });
  assert.notStrictEqual(t.state, 'untranslatable', JSON.stringify(t.reasons));
  const intl = new Intl.DateTimeFormat('nl-NL', { ...intlOptions, timeZone });
  return { t, result: checkFormulaParity(compiled(t), rows, rows.map((r) => ({ kind: 'value', value: intl.format(new Date(r.date)) }))) };
}

/** The text between a function's outer braces. @param {Function} fn */
function bodyOf(fn) {
  const text = fn.toString();
  return text.slice(text.indexOf('{', text.indexOf('=>')) + 1, text.lastIndexOf('}')).trim();
}

/** @param {string} body @param {any} [translate] */
const reasonsOf = (body, translate = { locales: locales() }) => translateFormulaBody(body, { argument: 'item', ...translate }).reasons;

describe('dates written in a language whose date pictures the host declares', () => {
  it('translates both spellings onto $date-format in the declared zone, names the host\'s zone, and agrees with Intl in the declared zone at every edge', ICU, () => {
    for (const [body, differences] of /** @type {[string, [string, number][]][]} */ ([
      ["return new Date(item.date).toLocaleDateString('nl-NL');", [['date-parse', 8], ['time-zone', 8]]],
      ["return new Intl.DateTimeFormat('nl-NL').format(new Date(item.date));", [['time-zone', 8], ['date-parse', 48]]],
    ])) {
      for (const timeZone of ['UTC', '+01:00', '-05:00']) {
        const { t, result } = parity(body, { locales: locales(timeZone === 'UTC' ? {} : { timeZone }) }, {}, timeZone);
        assert.strictEqual(t.state, 'translated-with-differences');
        assert.deepStrictEqual(t.differences.map((d) => [d.kind, d.at.column]), differences, body);
        assert.deepStrictEqual([result.rows, result.agree], [FIXTURE.length, FIXTURE.length], `${body} in ${timeZone}: ${JSON.stringify(result.mismatches)}`);
      }
    }
    // month names, written with the names the formula is compiled with
    const long = parity("return new Date(item.date).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });",
      { locales: locales() }, { day: 'numeric', month: 'long', year: 'numeric' }, 'UTC');
    assert.deepStrictEqual([long.result.agree, long.t.differences.map((d) => d.kind)], [FIXTURE.length, ['date-parse', 'time-zone']]);
    assert.strictEqual(compiled(long.t).evaluate({ date: '2026-10-31' }).value, '31 oktober 2026');
  });

  it('names the host\'s zone because it writes another day near midnight: in Europe/Amsterdam the late evenings differ', ICU, () => {
    const { result } = parity("return new Date(item.date).toLocaleDateString('nl-NL');", { locales: locales() }, {}, 'Europe/Amsterdam');
    assert.deepStrictEqual(result.mismatches.map((m) => FIXTURE[m.index].date), ['2026-10-31T23:00:00Z', '2026-10-31T23:30:00Z', '2026-07-15T22:30:00Z',
      '2026-10-24T22:30:00Z', '2026-03-28T23:30:00Z', '2026-12-31T23:59:59.999Z', '2026-12-31T23:59:59.9999Z']);
    // a fixed offset is no named zone either: +01:00 is Amsterdam's winter only
    const winter = parity("return new Date(item.date).toLocaleDateString('nl-NL');", { locales: locales({ timeZone: '+01:00' }) }, {}, 'Europe/Amsterdam');
    assert.deepStrictEqual(winter.result.mismatches.map((m) => FIXTURE[m.index].date), ['2026-07-15T22:30:00Z', '2026-10-24T22:30:00Z']);
  });

  it('is exact, without the difference, where a timeZone option names the declared zone in any spelling: it agrees with JavaScript itself', ICU, () => {
    for (const [fn, translate] of /** @type {[(item: any) => string, any][]} */ ([
      [(item) => { return new Date(item.date).toLocaleDateString('nl-NL', { timeZone: 'UTC' }); }, { locales: locales() }],
      [(item) => { return new Date(item.date).toLocaleDateString('nl-NL', { timeZone: 'Etc/UTC', month: 'long', day: 'numeric', year: 'numeric' }); }, { locales: locales() }],
      [(item) => { return new Intl.DateTimeFormat('nl-NL', { timeZone: '+00:00' }).format(new Date(item.date)); }, { locales: locales() }],
      [(item) => { return new Date(item.date).toLocaleDateString('nl-NL', { timeZone: '+0100' }); }, { locales: locales({ timeZone: '+01:00' }) }],
    ])) {
      const t = translateFormulaBody(bodyOf(fn), { argument: 'item', ...translate });
      assert.deepStrictEqual(t.differences.map((d) => d.kind), ['date-parse'], bodyOf(fn));
      const formula = compiled(t);
      for (const row of FIXTURE) assert.strictEqual(formula.evaluate(row).value, fn(row), `${bodyOf(fn)} on ${row.date}`);
    }
  });

  it('writes each set of date fields, and each dateStyle, with the picture declared for it', ICU, () => {
    for (const options of /** @type {Intl.DateTimeFormatOptions[]} */ ([{}, { year: 'numeric', month: 'numeric', day: 'numeric' }, { day: '2-digit', month: '2-digit', year: 'numeric' },
      { year: '2-digit', month: '2-digit', day: '2-digit' }, { day: 'numeric', month: 'short', year: 'numeric' }, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' },
      { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }, { day: 'numeric', month: 'long' }, { month: 'long' }, { weekday: 'long' }, { year: 'numeric' },
      { dateStyle: 'short' }, { dateStyle: 'medium' }, { dateStyle: 'long' }, { dateStyle: 'full' }])) {
      const written = Object.entries(options).map(([key, v]) => `${key}: '${v}', `).join('');
      const { result } = parity(`return new Date(item.date).toLocaleDateString('nl-NL', { ${written}timeZone: 'UTC' });`, { locales: locales() }, options, 'UTC');
      assert.strictEqual(result.agree, FIXTURE.length, `${JSON.stringify(options)}: ${JSON.stringify(result.mismatches)}`);
    }
  });

  it('refuses, naming it, an option or a value no picture states, fields without a picture and a zone it does not write', () => {
    const date = "return new Date(item.date).toLocaleDateString('nl-NL', ";
    for (const [body, kind, message] of /** @type {[string, string, RegExp][]} */ ([
      [`${date}{ era: 'long' });`, 'locale', /the formatting option 'era'/],
      [`${date}{ hour: 'numeric' });`, 'locale', /the formatting option 'hour'/],
      [`${date}{ timeZoneName: 'short' });`, 'locale', /the formatting option 'timeZoneName'/],
      [`${date}{ month: 'narrow' });`, 'locale', /the month 'narrow', which no picture writes/],
      [`${date}{ weekday: 'narrow', day: 'numeric' });`, 'locale', /the weekday 'narrow'/],
      [`${date}{ year: 2 });`, 'locale', /the year '2'/],
      [`${date}{ dateStyle: 'long', day: 'numeric' });`, 'locale', /a dateStyle beside a date field/],
      [`${date}{ dateStyle: 'huge' });`, 'locale', /the date style 'huge'/],
      [`${date}{ month: 'short', day: 'numeric' });`, 'locale', /the date fields 'MMMd', which have no picture this translation describes for 'nl-NL'/],
      [`${date}{ timeZone: 'Europe/Amsterdam' });`, 'locale', /the time zone 'Europe\/Amsterdam', where this translation writes the dates of 'nl-NL' in UTC/],
      [`${date}{ timeZone: 'Mars/Olympus' });`, 'locale', /the time zone 'Mars\/Olympus'/],
      [`const o = { month: 'long' };\n${date}o);`, 'locale', /formatting options that are not an object literal/],
      [`${date}{ month: item.m });`, 'locale', /a formatting option that is not a literal/],
      [`${date}{}, 'x');`, 'arguments', /a language and its options/],
      ["return new Date().toLocaleDateString('nl-NL');", 'date', /exactly one argument/],
      ["return new Date(item.y, item.m).toLocaleDateString('nl-NL');", 'date', /exactly one argument/],
      ["return new Date(Date.now()).toLocaleDateString('nl-NL');", 'date', /a value that is not text/],
      ["return new Intl.DateTimeFormat('nl-NL').format(item.date);", 'arguments', /anything but one new Date\(text\)/],
      ["return new Intl.DateTimeFormat('nl-NL').format();", 'arguments', /anything but one new Date\(text\)/],
    ])) {
      const reasons = reasonsOf(body);
      assert.deepStrictEqual(reasons.map((r) => r.kind), [kind], `${body}: ${JSON.stringify(reasons)}`);
      assert.match(reasons[0].message, message, body);
    }
    // positioned at the options, the argument and the call
    assert.deepStrictEqual(reasonsOf(`${date}{ era: 'long' });`)[0].at.column, 56);
    assert.deepStrictEqual(reasonsOf("return new Date(Date.now()).toLocaleDateString('nl-NL');")[0].at.column, 17);
  });

  it('names the date pictures a language lacks, and a tag that is no literal, as the reason locale, with no reason new', () => {
    const missing = /the language 'nl-NL' has no date pictures this translation describes \(translate\.locales\['nl-NL'\]\.dates\)/;
    for (const translate of [{}, { locales: { 'nl-NL': NUMBERS } }, { locales: { 'nl-BE': { ...NUMBERS, dates: DUTCH } } }]) {
      for (const [body, column] of /** @type {[string, number][]} */ ([["return new Date(item.date).toLocaleDateString('nl-NL');", 47],
        ["return new Intl.DateTimeFormat('nl-NL').format(new Date(item.date));", 32]])) {
        const t = translateFormulaBody(body, { argument: 'item', ...translate });
        assert.deepStrictEqual([t.reasons.map((r) => [r.kind, r.at.column]), t.differences], [[['locale', column]], []], `${body} ${JSON.stringify(translate)}`);
        assert.match(t.reasons[0].message, missing);
      }
    }
    for (const [body, line, column] of /** @type {[string, number, number][]} */ ([['return new Date(item.date).toLocaleDateString();', 1, 8],
      ["const tag = 'nl-NL';\nreturn new Date(item.date).toLocaleDateString(tag);", 2, 8],
      ['return new Intl.DateTimeFormat().format(new Date(item.date));', 1, 8]])) {
      const reasons = reasonsOf(body);
      assert.deepStrictEqual(reasons.map((r) => [r.kind, r.at.line, r.at.column]), [['locale', line, column]], body);
      assert.match(reasons[0].message, /date formatting without a literal language tag/);
    }
    // a new of another shape keeps its own reason
    for (const body of ["return new Date(item.date).toLocaleString('nl-NL');", "return new Intl.DateTimeFormat('nl-NL').formatToParts(new Date(item.date));"])
      assert.ok(reasonsOf(body).some((r) => r.kind === 'new'), body);
  });

  it('refuses the year 0000 where the picture writes a year, which JavaScript writes as the year 1 of the era before', ICU, () => {
    const numeric = compiled(translateFormulaBody("return new Date(item.date).toLocaleDateString('nl-NL');", { argument: 'item', locales: locales() }));
    assert.throws(() => numeric.evaluate({ date: '0000-06-15' }), { code: 'JQ2001' });
    assert.strictEqual(new Date('0000-06-15').toLocaleDateString('nl-NL', { timeZone: 'UTC' }), '15-6-1');
    const { result } = parity("return new Date(item.date).toLocaleDateString('nl-NL', { day: 'numeric', month: 'long' });", { locales: locales() },
      { day: 'numeric', month: 'long' }, 'UTC', [{ date: '0000-06-15' }]);
    assert.strictEqual(result.agree, 1, 'a picture without a year writes it');
    // a zone that moves a date past 9999 refuses the row, where JavaScript writes the year 10000
    const east = compiled(translateFormulaBody("return new Date(item.date).toLocaleDateString('nl-NL');", { argument: 'item', locales: locales({ timeZone: '+01:00' }) }));
    assert.throws(() => east.evaluate({ date: '9999-12-31T23:30:00Z' }), { code: 'JQ2001' });
  });

  it('reads the texts JavaScript reads otherwise as date-parse names them', () => {
    const formula = compiled(translateFormulaBody("return new Date(item.date).toLocaleDateString('nl-NL');", { argument: 'item', locales: locales() }));
    // JavaScript reads a date-time without an offset in the host's zone, and null as 1970-01-01: the query refuses both
    for (const date of ['2026-10-31T10:00:00', null, '31-10-2026', 1793404800000]) assert.throws(() => formula.evaluate({ date }), { code: 'JQ2001' }, JSON.stringify(date));
    // undefined: JavaScript writes 'Invalid Date', the query nothing; a leap second: JavaScript writes 'Invalid Date', the query reads it
    assert.deepStrictEqual(formula.evaluate({}), { kind: 'empty', values: [] });
    assert.deepStrictEqual(formula.evaluate({ date: '2016-12-31T23:59:60Z' }), { kind: 'value', value: '31-12-2016' });
  });

  it('refuses a malformed date declaration as the host\'s TypeError, as it refuses a malformed number one', () => {
    for (const extra of [{ dates: null }, { dates: [] }, { dates: 'd-M-y' }, { dates: { dMy: 'd-M-y' } }, { dates: { yMMMMMd: 'd MMMM y' } }, { dates: { '': 'd' } },
      { dates: { yMd: '' } }, { dates: { yMd: 5 } }, { dates: { yMd: 'd-M-y XXX' } }])
      assert.throws(() => translateFormulaBody('return 1;', { locales: locales(extra) }), /locale 'nl-NL' dates must map date fields/, JSON.stringify(extra));
    for (const timeZone of ['Europe/Amsterdam', 'Mars/Olympus', 60])
      assert.throws(() => translateFormulaBody('return 1;', { locales: locales({ timeZone }) }), /locale 'nl-NL' timeZone must be UTC or a fixed offset/, String(timeZone));
    // a quoted X is a literal, and JavaScript's other spellings of UTC and of an offset are the same zones
    for (const extra of [{ dates: { yMd: "d-M-y 'X'" } }, { timeZone: 'Etc/UTC' }, { timeZone: '+0100' }, { dates: {} }])
      assert.strictEqual(translateFormulaBody('return 1;', { locales: locales(extra) }).state, 'translated', JSON.stringify(extra));
  });
});

describe('a weight in grams', () => {
  it('leaves parseFloat untranslated: no operator reads the longest decimal prefix it reads', () => {
    assert.deepStrictEqual(reasonsOf('return parseFloat(item.weight);').map((r) => [r.kind, r.message]), [['helper', "'parseFloat' is not a helper this translation maps"]]);
    // what it would have to say: the longest decimal prefix after white space, NaN where there is none
    assert.deepStrictEqual(['1,5 kg', ' 1.5e3kg', '.5', '1.', 'kg 1'].map((s) => parseFloat(s)), [1, 1500, 0.5, 1, NaN]);
  });

  it('runs the route FORMULA-FORMAT documents as printed', () => {
    const doc = readFileSync(new URL('../../packages/json/docs/FORMULA-FORMAT.md', import.meta.url), 'utf8');
    const open = doc.indexOf('```js\n', doc.indexOf('A weight in grams'));
    const fence = doc.slice(open + 6, doc.indexOf('\n```', open));
    // each `expression; // value` line is checked against the value it prints
    const checked = fence.replace(/^(.+?); \/\/ (.+)$/gm, '__check($1, $2);');
    assert.ok((checked.match(/__check\(/g) ?? []).length >= 3, checked);
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', `import { deepStrictEqual as __check } from 'node:assert/strict';\n${checked}`],
      { cwd: ROOT, encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } });
    assert.strictEqual(run.status, 0, run.stderr);
  });
});
