//@ts-check
/**
 * @file Dates written in a named time zone (QUERY-FORMAT §8.13, FORMULA-FORMAT
 * "The report"): `$date-format`'s zone operand reads the wall clock from the
 * injected zone provider, the formula compiler takes that provider and keys
 * its compiled entries by the provider's identity, and the translator writes a
 * `toLocaleDateString` / `Intl.DateTimeFormat` date in a named zone exactly,
 * checked against `Intl` in that same zone over instants around both 2026
 * Europe/Amsterdam transitions and local midnight. A provider with made-up
 * transitions shows the output follows the provider, not the host.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { compileJsonQuery } from '@jarenjs/json';
import { checkFormulaParity, compileFormula, createFormulaCompiler, formulaDocument } from '@jarenjs/json/formula';
import { translateFormulaBody, migrateFormulas } from '@jarenjs/json/formula/migrate';
import { compileDateLocale, nl } from '@jarenjs/locales';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';
import { partsFromEpoch } from '@jarenjs/core/dates';

const ICU = { skip: process.versions.icu !== '78.3' && `the Dutch and English pictures are those ICU 78.3 writes; this host runs ${process.versions.icu}` };
const zoneProvider = createIntlZoneProvider({ revision: 'host' });
const AMS = 'Europe/Amsterdam';
const dutch = compileDateLocale(nl).names;
const english = compileDateLocale().names;
const NL = { 'nl-NL': { decimalFormat: 'nl', grouping: '.', decimal: ',', dates: { yMd: 'd-M-y', yMMMMd: 'd MMMM y', full: 'EEEE d MMMM y' } } };
const EN = { 'en-US': { decimalFormat: 'en', grouping: ',', decimal: '.', dates: { yMd: 'M/d/y', yMMMMd: 'MMMM d, y', full: 'EEEE, MMMM d, y' } } };

const HOUR = 3600000;
/** Every quarter hour over the nights 2026 Europe/Amsterdam changes its clock (UTC 20:00 to 04:00), and the instants a millisecond and a fraction either side of each local midnight. */
function instants() {
  const out = [];
  for (const night of ['2026-03-28T20:00:00Z', '2026-10-24T20:00:00Z'])
    for (let t = Date.parse(night); t <= Date.parse(night) + 8 * HOUR; t += HOUR / 4) out.push(new Date(t).toISOString());
  // local midnight: 23:00Z in winter, 22:00Z in summer
  for (const midnight of ['2026-03-28T23:00:00', '2026-03-29T22:00:00', '2026-10-24T22:00:00', '2026-10-25T23:00:00', '2026-12-31T23:00:00', '2026-06-30T22:00:00']) {
    const at = Date.parse(`${midnight}Z`);
    out.push(new Date(at - 1).toISOString(), new Date(at).toISOString(), `${new Date(at - 1000).toISOString().slice(0, 19)}.9999Z`);
  }
  // other offsets, a date alone, before 1970 and far ahead
  out.push('2026-10-31', '2026-03-29', '2026-10-24T23:59:59+02:00', '2026-10-25T01:30:00+05:30', '2026-03-28T16:30:00-08:00',
    '1969-12-31T23:30:00Z', '1950-07-01T22:30:00Z', '1900-01-01T00:00:00Z', '1830-06-15T23:50:00Z', '9999-12-30T12:00:00Z', '2026-10-31t23:30:00z');
  return out.map((date) => ({ date }));
}

/** @param {any} expression @param {any} [options] */
const formula = (expression, options = {}) => compileFormula(formulaDocument({ $formula: '1', id: 'z', revision: '1', expression }), options);

/** The wall clock Intl reads in a zone, as `yyyy-MM-dd HH:mm:ss`. @param {number} epoch @param {string} zone */
function intlWall(epoch, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(epoch).map((p) => [p.type, p.value]));
  return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/** A provider with one made-up transition: `Test/Shift` is +01:00 before 2026-06-01T00:00Z and +03:00 from it. */
const SHIFT = Date.parse('2026-06-01T00:00:00Z');
const tableProvider = Object.freeze({
  identity: Object.freeze({ name: 'table', revision: '1' }),
  toParts(/** @type {number} */ epoch, /** @type {string} */ zone) {
    if (zone !== 'Test/Shift') throw new RangeError(`unknown zone ${zone}`);
    return partsFromEpoch(epoch, epoch < SHIFT ? 60 : 180);
  },
  toEpoch: () => NaN,
});

describe("$date-format's zone operand", () => {
  const wall = compileJsonQuery({ '$date-format': ['$', "yyyy-MM-dd HH:mm:ss", AMS] }, { zoneProvider });

  it('writes the wall clock the provider reads for the instant, across both transitions, before 1970 and far ahead', () => {
    for (const { date } of instants()) {
      if (!date.includes('T') && !date.includes('t')) continue;
      assert.strictEqual(wall.first(date), intlWall(Date.parse(date.replace('.9999', '.999')), AMS), date);
    }
  });

  it('writes an instant in the repeated hour as its own wall time and its own offset', () => {
    const q = compileJsonQuery({ '$date-format': ['$', 'HH:mm XXX', AMS] }, { zoneProvider });
    assert.strictEqual(q.first('2026-10-25T00:30:00Z'), '02:30 +02:00');
    assert.strictEqual(q.first('2026-10-25T01:30:00Z'), '02:30 +01:00');
    // the 23- and 25-hour days: the hour after 01:59 on 29 March is 03:00
    assert.strictEqual(q.first('2026-03-29T01:00:00Z'), '03:00 +02:00');
  });

  it('cuts a fraction finer than a millisecond, never rounding it into the next day', () => {
    assert.strictEqual(compileJsonQuery({ '$date-format': ['$', 'yyyy-MM-dd HH:mm:ss.SSS', AMS] }, { zoneProvider }).first('2026-10-24T21:59:59.9999Z'),
      '2026-10-24 23:59:59.999');
    // a leap second is the instant after it, as $epoch reads it
    assert.strictEqual(wall.first('2026-12-31T23:59:60Z'), '2027-01-01 01:00:00');
  });

  it('follows the provider it is given, not the host', () => {
    const q = compileJsonQuery({ '$date-format': ['$', 'yyyy-MM-dd HH:mm XXX', 'Test/Shift'] }, { zoneProvider: tableProvider });
    assert.strictEqual(q.first('2026-05-31T23:30:00Z'), '2026-06-01 00:30 +01:00');
    assert.strictEqual(q.first('2026-06-01T00:30:00Z'), '2026-06-01 03:30 +03:00');
  });

  it("writes UTC without a provider, as the two-operand form writes a UTC date-time", () => {
    const q = compileJsonQuery({ '$date-format': ['$', 'yyyy-MM-dd HH:mm', 'UTC'] });
    assert.strictEqual(q.first('2026-10-31T23:30:00-05:00'), '2026-11-01 04:30');
    assert.strictEqual(compileJsonQuery({ '$date-format': ['$', 'yyyy-MM-dd HH:mm'] }).first('2026-10-31T23:30:00-05:00'), '2026-10-31 23:30');
  });

  it('refuses at compile: a named zone without a provider, a zone the provider does not know, a zone that is no text', () => {
    /** @param {any} doc @param {any} options @param {RegExp} message */
    const refused = (doc, options, message) => assert.throws(() => compileJsonQuery(doc, options), (/** @type {any} */ e) => e.code === 'JQ0003' && message.test(e.message));
    refused({ '$date-format': ['$', 'y', AMS] }, {}, /the zone 'Europe\/Amsterdam' needs a time-zone provider/);
    refused({ '$date-format': ['$', 'y', 'Mars/Olympus'] }, { zoneProvider }, /does not know the zone 'Mars\/Olympus'/);
    // the zone is captured verbatim, as a series spec's zone is: a path is a name no provider knows, an expression no name
    refused({ '$date-format': ['$', 'y', '$.zone'] }, { zoneProvider }, /does not know the zone '\$\.zone'/);
    refused({ '$date-format': ['$', 'y', { $concat: ['Europe/', 'Amsterdam'] }] }, { zoneProvider }, /'zone' is an IANA zone name, got an object/);
    refused({ '$date-format': ['$', 'y', 3] }, { zoneProvider }, /'zone' is an IANA zone name, got a number/);
  });

  it('refuses a row: a value without an instant, a wall year past 9999, an offset no RFC 3339 text writes, a provider that fails', () => {
    /** @param {any} q @param {any} v @param {RegExp} message */
    const refused = (q, v, message) => assert.throws(() => q.first(v), (/** @type {any} */ e) => e.code === 'JQ2001' && message.test(e.message));
    refused(wall, '2026-10-31', /names no instant/);
    refused(wall, '10:30:00Z', /names no instant/);
    refused(wall, 'yesterday', /expected an RFC 3339/);
    refused(wall, '9999-12-31T23:30:00Z', /past 9999 or before 0000/);
    refused(compileJsonQuery({ '$date-format': ['$', 'y', 'America/New_York'] }, { zoneProvider }), '0000-01-01T01:00:00Z', /past 9999 or before 0000/);
    // the zone data's Amsterdam of 1885 keeps a local mean time an odd number of seconds east
    const lmt = intlWall(Date.parse('1885-01-01T00:00:00Z'), AMS);
    assert.notStrictEqual(lmt.slice(-2), '00', 'the zone data keeps a local mean time in 1885');
    assert.strictEqual(compileJsonQuery({ '$date-format': ['$', 'yyyy-MM-dd HH:mm:ss', AMS] }, { zoneProvider }).first('1885-01-01T00:00:00Z'), lmt);
    refused(compileJsonQuery({ '$date-format': ['$', 'HH:mm XXX', AMS] }, { zoneProvider }), '1885-01-01T00:00:00Z', /not a whole number of minutes/);
    const failing = { toParts: () => { throw new Error('no data'); }, toEpoch: () => NaN };
    assert.throws(() => compileJsonQuery({ '$date-format': ['$', 'y', 'Test/Gone'] }, { zoneProvider: failing }), /does not know the zone 'Test\/Gone'/);
    // known at compile (instant 0), failing or answering nothing at the row's instant
    const once = { toEpoch: () => NaN, toParts: (/** @type {number} */ e) => { if (e !== 0) throw new Error('no data'); return partsFromEpoch(e, 0); } };
    refused(compileJsonQuery({ '$date-format': ['$', 'y', 'Test/Gone'] }, { zoneProvider: once }), '2026-01-01T00:00:00Z', /'Test\/Gone'.*no data/);
    const empty = { toEpoch: () => NaN, toParts: (/** @type {number} */ e) => (e === 0 ? partsFromEpoch(e, 0) : null) };
    refused(compileJsonQuery({ '$date-format': ['$', 'y', 'Test/Empty'] }, { zoneProvider: empty }), '2026-01-01T00:00:00Z', /gave no wall clock in 'Test\/Empty'/);
  });

  it("knows a zone whose data does not reach the instant it is asked at, as a compiled VTIMEZONE's horizon", () => {
    const horizon = { toEpoch: () => NaN, toParts: (/** @type {number} */ e, /** @type {string} */ zone) => {
      if (zone !== 'Test/Horizon') throw new RangeError('unknown');
      if (e < SHIFT) throw Object.assign(new Error('before the horizon'), { code: 'JY0024' });
      return partsFromEpoch(e, 60);
    } };
    const q = compileJsonQuery({ '$date-format': ['$', 'yyyy-MM-dd HH:mm', 'Test/Horizon'] }, { zoneProvider: horizon });
    assert.strictEqual(q.first('2026-07-01T23:30:00Z'), '2026-07-02 00:30');
    assert.throws(() => q.first('2026-01-01T00:00:00Z'), (/** @type {any} */ e) => e.code === 'JQ2001' && /before the horizon/.test(e.message));
  });

  it('writes a computed pattern in the zone, an offset only where it is whole minutes', () => {
    const q = compileJsonQuery({ '$date-format': ['$.at', '$.pattern', AMS] }, { zoneProvider });
    assert.strictEqual(q.first({ at: '2026-10-25T00:30:00Z', pattern: 'HH:mm XXX' }), '02:30 +02:00');
    assert.strictEqual(q.first({ at: '1885-01-01T00:00:00Z', pattern: "yyyy 'XXX'" }), '1885 XXX');
    assert.throws(() => q.first({ at: '1885-01-01T00:00:00Z', pattern: 'XXX' }), /not a whole number of minutes/);
    assert.throws(() => q.first({ at: '2026-10-25T00:30:00Z', pattern: "'open" }), (/** @type {any} */ e) => e.code === 'JQ2001');
  });

  it('leaves a date the operand is empty for empty', () => {
    assert.deepStrictEqual(compileJsonQuery({ '$date-format': ['$.missing', 'y', AMS] }, { zoneProvider }).items({}), []);
  });
});

describe('the formula compiler and a zone provider', () => {
  it('compiles a named zone with the provider and refuses it, coded, without one', () => {
    const doc = { '$date-format': ['$.at', 'd-M-y', AMS] };
    assert.deepStrictEqual(formula(doc, { zoneProvider }).evaluate({ at: '2026-10-31T23:30:00Z' }), { kind: 'value', value: '1-11-2026' });
    assert.throws(() => formula(doc), (/** @type {any} */ e) => e.code === 'JQ0003' && /needs a time-zone provider/.test(e.message) && e.docPath === '/expression/$date-format/2');
  });

  it('refuses a malformed provider as the host\'s TypeError, when the compiler is made', () => {
    assert.throws(() => createFormulaCompiler({ zoneProvider: /** @type {any} */ ({ toParts() {} }) }), TypeError);
    assert.throws(() => createFormulaCompiler({ zoneProvider: /** @type {any} */ ({ ...zoneProvider, identity: { name: 'intl' } }) }), /identity must be \{ name, revision \}/);
  });

  it("keys a compiled formula by the provider's identity, and keeps every key without one", () => {
    const doc = formulaDocument({ $formula: '1', id: 'z', revision: '1', expression: { '$date-format': ['$.at', 'd-M-y', AMS] } });
    const plain = formulaDocument({ $formula: '1', id: 'p', revision: '1', expression: '$.at' });
    const a = createFormulaCompiler({ zoneProvider: createIntlZoneProvider({ revision: '2026a' }) }).compile(doc).key;
    const b = createFormulaCompiler({ zoneProvider: createIntlZoneProvider({ revision: '2026b' }) }).compile(doc).key;
    assert.notStrictEqual(a, b);
    assert.strictEqual(createFormulaCompiler({ zoneProvider: createIntlZoneProvider({ revision: '2026a' }) }).compile(doc).key, a);
    assert.notStrictEqual(createFormulaCompiler({ zoneProvider }).compile(plain).key, createFormulaCompiler().compile(plain).key);
    // a provider that names no identity is keyed by its object within the compiler
    const unnamed = { toParts: zoneProvider.toParts, toEpoch: zoneProvider.toEpoch };
    const c = createFormulaCompiler({ zoneProvider: unnamed });
    assert.strictEqual(c.compile(doc), c.compile(doc));
    assert.notStrictEqual(c.compile(doc).key, a);
  });
});

describe('a translated date written in a named zone', () => {
  const zones = { zoneProvider };
  /**
   * A body translated with the provider, compiled with it, checked against
   * `Intl.DateTimeFormat` in the zone over the rows.
   * @param {string} body @param {any} locales @param {any} names @param {string} tag @param {Intl.DateTimeFormatOptions} intlOptions
   */
  function parity(body, locales, names, tag, intlOptions, rows = instants()) {
    const t = translateFormulaBody(body, { argument: 'item', locales, ...zones });
    assert.notStrictEqual(t.state, 'untranslatable', JSON.stringify(t.reasons));
    const compiled = formula(t.expression, { dateNames: names, zoneProvider });
    const intl = new Intl.DateTimeFormat(tag, intlOptions);
    const expected = rows.map((r) => {
      const year = Number(new Intl.DateTimeFormat('en-US', { timeZone: AMS, year: 'numeric' }).format(new Date(r.date)));
      return year > 9999 ? { kind: 'error' } : { kind: 'value', value: intl.format(new Date(r.date)) };
    });
    return { t, result: checkFormulaParity(compiled, rows, expected, { maxMismatches: 5 }) };
  }
  const kinds = (/** @type {any} */ t) => t.differences.map((/** @type {any} */ d) => d.kind);

  it('writes a timeZone option the provider knows exactly: Dutch and English pictures, numeric and with names', ICU, () => {
    for (const [tag, locales, names] of /** @type {const} */ ([['nl-NL', NL, dutch], ['en-US', EN, english]])) {
      for (const fields of ['', "month: 'long', day: 'numeric', year: 'numeric', ", "dateStyle: 'full', "]) {
        const body = `return new Date(item.date).toLocaleDateString('${tag}', { ${fields}timeZone: '${AMS}' });`;
        const options = Function(`return { ${fields}timeZone: '${AMS}' }`)();
        const { t, result } = parity(body, locales, names, tag, options);
        assert.deepStrictEqual(kinds(t), ['date-parse'], body);
        assert.deepStrictEqual(result.mismatches, [], body);
        assert.strictEqual(result.agree, instants().length);
      }
      const intl = `return new Intl.DateTimeFormat('${tag}', { timeZone: '${AMS}' }).format(new Date(item.date));`;
      assert.deepStrictEqual(parity(intl, locales, names, tag, { timeZone: AMS }).result.mismatches, [], intl);
    }
  });

  it("writes a declared named zone where the body names none: the time-zone difference, exact when the host runs that zone", ICU, () => {
    const body = "return new Date(item.date).toLocaleDateString('nl-NL');";
    const { t, result } = parity(body, { 'nl-NL': { ...NL['nl-NL'], timeZone: AMS } }, dutch, 'nl-NL', { timeZone: AMS });
    assert.deepStrictEqual(kinds(t).sort(), ['date-parse', 'time-zone']);
    assert.match(t.differences.find((/** @type {any} */ d) => d.kind === 'time-zone').note, /the query in Europe\/Amsterdam, the zone declared for 'nl-NL'/);
    assert.deepStrictEqual(result.mismatches, []);
  });

  it('honours the call\'s named zone whatever zone the language declares', ICU, () => {
    const body = `return new Date(item.date).toLocaleDateString('nl-NL', { timeZone: '${AMS}' });`;
    const { t, result } = parity(body, { 'nl-NL': { ...NL['nl-NL'], timeZone: '+05:00' } }, dutch, 'nl-NL', { timeZone: AMS });
    assert.deepStrictEqual(kinds(t), ['date-parse']);
    assert.deepStrictEqual(result.mismatches, []);
  });

  it('refuses a date in the year 0000 where the picture writes a year, as the fixed-offset path does', () => {
    const t = translateFormulaBody(`return new Date(item.date).toLocaleDateString('nl-NL', { timeZone: '${AMS}' });`, { argument: 'item', locales: NL, ...zones });
    const compiled = formula(t.expression, { dateNames: dutch, zoneProvider });
    assert.throws(() => compiled.evaluate({ date: '0000-06-15T12:00:00Z' }), /the year 0000/);
    assert.deepStrictEqual(compiled.evaluate({ date: '0001-01-01T12:00:00Z' }), { kind: 'value', value: '1-1-1' });
  });

  it("writes a call's own fixed offset, exactly, whatever offset the language declares, and needs no provider", ICU, () => {
    for (const [call, declared, zone] of [['+05:30', undefined, '+05:30'], ['UTC', '+01:00', 'UTC'], ['-0800', '+01:00', '-08:00'], ['+02:00', AMS, '+02:00']]) {
      const body = `return new Date(item.date).toLocaleDateString('nl-NL', { timeZone: '${call}' });`;
      const locales = { 'nl-NL': { ...NL['nl-NL'], ...(declared === undefined ? {} : { timeZone: declared }) } };
      // a declared named zone needs the provider; a fixed one does not
      const t = translateFormulaBody(body, { argument: 'item', locales, ...(declared === AMS ? zones : {}) });
      assert.deepStrictEqual(kinds(t), ['date-parse'], body);
      // the instants hold fractions finer than a millisecond a second before local midnight: cut, never rounded into the next day
      const rows = instants();
      const intl = new Intl.DateTimeFormat('nl-NL', { timeZone: zone });
      const result = checkFormulaParity(formula(t.expression, { dateNames: dutch }), rows, rows.map((r) => ({ kind: 'value', value: intl.format(new Date(r.date)) })));
      assert.deepStrictEqual(result.mismatches, [], body);
    }
  });

  it('keeps the shapes that answered right before byte-identical: a call offset equal to the declared one, no call timeZone', () => {
    const declared = { 'nl-NL': { ...NL['nl-NL'], timeZone: '+01:00' } };
    const same = translateFormulaBody("return new Date(item.date).toLocaleDateString('nl-NL', { timeZone: '+0100' });", { argument: 'item', locales: declared });
    // the expression the declared offset writes, as it was: the clock moved by 60 minutes less the text's own offset
    assert.match(JSON.stringify(same.expression), /\{"\$date-add":\[[^\]]*\{"\$sub":\[60,\{"\$offset":/);
    assert.deepStrictEqual(kinds(same), ['date-parse']);
    const none = translateFormulaBody("return new Date(item.date).toLocaleDateString('nl-NL');", { argument: 'item', locales: declared });
    assert.deepStrictEqual(none.expression, same.expression);
    assert.deepStrictEqual(kinds(none).sort(), ['date-parse', 'time-zone']);
    // and the declared default stays UTC
    const utc = translateFormulaBody("return new Date(item.date).toLocaleDateString('nl-NL', { timeZone: 'Etc/UTC' });", { argument: 'item', locales: NL });
    assert.deepStrictEqual(utc.expression, translateFormulaBody("return new Date(item.date).toLocaleDateString('nl-NL');", { argument: 'item', locales: NL }).expression);
  });

  it('names a zone the provider does not know: the reason locale in a body, the host\'s TypeError in a declaration', () => {
    const t = translateFormulaBody("return new Date(item.date).toLocaleDateString('nl-NL', { timeZone: 'Mars/Olympus' });", { argument: 'item', locales: NL, ...zones });
    assert.strictEqual(t.state, 'untranslatable');
    assert.deepStrictEqual(t.reasons.map((r) => [r.kind, r.at.column]), [['locale', 56]]);
    assert.match(t.reasons[0].message, /the time zone 'Mars\/Olympus', which the zone provider does not know/);
    assert.throws(() => translateFormulaBody('return 1;', { locales: { 'nl-NL': { ...NL['nl-NL'], timeZone: 'Mars/Olympus' } }, ...zones }),
      (/** @type {any} */ e) => e instanceof TypeError && /locale 'nl-NL' timeZone 'Mars\/Olympus' is a zone the zone provider does not know/.test(e.message));
    assert.throws(() => translateFormulaBody('return 1;', { zoneProvider: /** @type {any} */ ({}) }), TypeError);
  });

  it('keeps the UTC and fixed-offset translations byte-identical when a provider is given', () => {
    for (const [body, locales] of [
      ["return new Date(item.date).toLocaleDateString('nl-NL');", NL],
      ["return new Date(item.date).toLocaleDateString('nl-NL', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });", NL],
      ["return new Date(item.date).toLocaleDateString('nl-NL', { timeZone: '+0100' });", { 'nl-NL': { ...NL['nl-NL'], timeZone: '+01:00' } }],
      [`return new Date(item.date).toLocaleDateString('nl-NL', { timeZone: '${AMS}' });`, { 'nl-NL': { ...NL['nl-NL'], timeZone: '+01:00' } }]]) {
      const without = translateFormulaBody(body, { argument: 'item', locales });
      const withProvider = translateFormulaBody(body, { argument: 'item', locales, ...zones });
      if (body.includes(AMS)) { assert.strictEqual(without.state, 'untranslatable'); continue; }
      assert.deepStrictEqual(withProvider, without, body);
    }
  });

  it('migrates a body with the provider in both the translation and the formula options', async () => {
    const source = { id: 'ams', label: 'ams', enabled: true, storageVersion: 1,
      body: `return new Date(item.date).toLocaleDateString('nl-NL', { timeZone: '${AMS}' });` };
    const translate = { argument: 'item', locales: NL, ...zones };
    const report = await migrateFormulas([source], [], { translate, formula: { dateNames: dutch, zoneProvider } });
    const [record] = report.records;
    assert.strictEqual(record.state, 'translated-with-differences', JSON.stringify(record));
    assert.deepStrictEqual(compileFormula(record.native.formula, { dateNames: dutch, zoneProvider }).evaluate({ date: '2026-10-31T23:30:00Z' }),
      { kind: 'value', value: '1-11-2026' });
    const without = await migrateFormulas([source], [], { translate, formula: { dateNames: dutch } });
    assert.strictEqual(without.records[0].state, 'untranslatable');
    assert.match(JSON.stringify(without.records[0].reasons), /needs a time-zone provider/);
  });
});
