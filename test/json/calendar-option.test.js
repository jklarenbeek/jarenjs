//@ts-check
/**
 * @file The calendar seam (`calendar: queryCalendar()`, QUERY-FORMAT §8.13)
 * reaches every layer that compiles a query: the one-call `queryJson`, a
 * formula compiler (and the batch and migration that build one), a JSLT
 * stylesheet and a JTLT template. Without it `$instant` and `$wall` are
 * refused when the document compiles; a cached compilation made with the
 * seam never answers a call without it, nor the reverse.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { queryJson, compileJsonQuery } from '@jarenjs/json/query';
import { queryCalendar } from '@jarenjs/json/query/calendar';
import { compileFormula, createFormulaCompiler } from '@jarenjs/json/formula';
import { compileFormulaBatch } from '@jarenjs/json/formula/batch';
import { resolveFormulaMigration } from '@jarenjs/json/formula/migrate';
import { compileJsltStylesheet, transformJson, createJsltRegistry } from '@jarenjs/json/jslt';
import { compileJtltStylesheet, renderText, validateJtltTemplate } from '@jarenjs/json/jtlt';
import { defineFormula } from '@jarenjs/linq/formula';

const calendar = queryCalendar();
const data = { v: { kind: 'floating', date: '2026-07-01', time: '10:00' } };
const WALL = '2026-07-01T10:00:00.000';
/** @param {() => unknown} fn @param {(e: any) => void} check */
const refused = (fn, check) => assert.throws(fn, (/** @type {any} */ e) => { check(e); return true; });
const seamMissing = (/** @type {any} */ e) => assert.match(e.message, /JQ0003[^]*'\$wall' reads a calendar value/);

describe('queryJson takes compile options', () => {
  it('answers a calendar operator with the seam as its fourth argument, and refuses it without', () => {
    const doc = { $wall: '$.v' };
    assert.equal(queryJson(doc, data, undefined, { calendar }), WALL);
    refused(() => queryJson(doc, data), (e) => assert.equal(e.code, 'JQ0003'));
    assert.equal(queryJson({ $instant: ['$.u'] }, { u: { kind: 'utc', instant: '2026-01-01T00:00:00.5Z' } }, undefined, { calendar }),
      Date.parse('2026-01-01T00:00:00.500Z'));
  });

  it('never answers one document from the other compilation, in either order', () => {
    const options = { calendar };
    const first = { $wall: '$.v' };
    assert.equal(queryJson(first, data, undefined, options), WALL);
    refused(() => queryJson(first, data), (e) => assert.equal(e.code, 'JQ0003'));
    assert.equal(queryJson(first, data, undefined, options), WALL);
    const second = { $wall: '$.v' };
    refused(() => queryJson(second, data), (e) => assert.equal(e.code, 'JQ0003'));
    assert.equal(queryJson(second, data, undefined, options), WALL);
    // a string document and a scalar one take the options too
    assert.equal(queryJson('$.v.date', data, undefined, options), '2026-07-01');
    assert.equal(queryJson('$.v.date', data), '2026-07-01');
    assert.equal(queryJson(7, data, undefined, options), 7);
    // another options object compiles afresh: what it lacks is refused
    refused(() => queryJson(first, data, undefined, {}), (e) => assert.equal(e.code, 'JQ0003'));
  });

  it('compiles once per document and option values, as transformJson does', () => {
    let compiles = 0;
    const compileTypeTest = () => { compiles++; return () => true; };
    const doc = { $and: [{ $valid: ['$', { type: 'object' }] }, { $eq: [{ $wall: '$.v' }, WALL] }] };
    for (let i = 0; i < 3; i++) assert.equal(queryJson(doc, data, undefined, { calendar, compileTypeTest }), true);
    assert.equal(compiles, 1, 'a fresh options object with the same values reuses the compilation');
    assert.equal(queryJson(doc, data, undefined, { compileTypeTest, calendar, limits: { steps: 100 } }), true);
    assert.equal(compiles, 2, 'other option values compile afresh');
    // a member compilation refuses is refused on every call, never answered from a variant without it
    assert.throws(() => queryJson(doc, data, undefined, /** @type {any} */ ({ calendar, compileTypeTest, bogus: 1 })), TypeError);
    assert.throws(() => queryJson(doc, data, undefined, /** @type {any} */ ({ calendar, compileTypeTest, bogus: 1 })), TypeError);
    // a string document caches under its options too
    const path = '$.v[?@ == "2026-07-01"]';
    assert.deepEqual(queryJson(path, data, undefined, { calendar }), queryJson(path, data));
  });

  it('answers what compileJsonQuery answers under the same options, externals included', () => {
    const doc = { $concat: [{ $wall: '$.v' }, '$x'] };
    assert.equal(queryJson(doc, data, { x: '!' }, { calendar, externals: ['x'] }),
      compileJsonQuery(doc, { calendar, externals: ['x'] })(data, { x: '!' }));
  });

  it('refuses options that are not an object, and a calendar that is not the seam, as TypeError', () => {
    for (const bad of [null, 1, 'calendar', []])
      assert.throws(() => queryJson({ $wall: '$.v' }, data, undefined, /** @type {any} */ (bad)), TypeError);
    assert.throws(() => queryJson({ $wall: '$.v' }, data, undefined, { calendar: { instantOf() {}, wallOf() {} } }), TypeError);
  });
});

describe('a formula compiler takes the calendar seam', () => {
  const formula = defineFormula('wall', { $wall: '$.v' });

  it('compiles a calendar operator with it, and refuses it at the expression without', () => {
    assert.deepEqual(compileFormula(formula, { calendar }).evaluate(data), { kind: 'value', value: WALL });
    refused(() => compileFormula(formula), (e) => {
      assert.equal(e.name, 'FormulaError');
      assert.equal(e.code, 'JQ0003');
      assert.equal(e.docPath, '/expression/$wall');
    });
  });

  it('keeps every key a compiler without the seam had, and keys the seam apart', () => {
    const plain = defineFormula('plain', { $add: ['$.a', 1] });
    const without = createFormulaCompiler().compile(plain).key;
    const withSeam = createFormulaCompiler({ calendar }).compile(plain).key;
    assert.notEqual(without, withSeam);
    assert.equal(createFormulaCompiler({}).compile(plain).key, without);
  });

  it('refuses a calendar that is not the seam as TypeError, before any formula compiles', () => {
    assert.throws(() => createFormulaCompiler({ calendar: /** @type {any} */ ({}) }), TypeError);
  });

  it('reaches the batch and the manual migration through the same option', async () => {
    const batch = compileFormulaBatch([{ id: 'wall', formula }], { calendar });
    assert.equal(batch.evaluate([{ id: 1, ...data }]).counts.value, 1);
    assert.equal(compileFormulaBatch([{ id: 'wall', formula }]).evaluate([{ id: 1, ...data }]).counts.error, 1);
    // resolveFormulaMigration compiles the reviewed native formula with its options
    const record = { id: 'wall', state: 'pending', sourceHash: 's', nativeHash: null, original: {}, native: null };
    const review = { sourceHash: 's', expectedNativeHash: null, actor: 'a', reason: 'r' };
    const resolved = await resolveFormulaMigration(record, { formula }, review, { calendar });
    assert.equal(resolved.state, 'resolved');
    await assert.rejects(() => resolveFormulaMigration(record, { formula }, review), (/** @type {any} */ e) => e.code === 'JQ0003');
  });
});

describe('a JSLT stylesheet takes the calendar seam', () => {
  const stylesheet = [{ match: '$', body: { $wall: '$.v' } }];

  it('compiles a rule body reading a calendar value with it, and refuses it without', () => {
    assert.equal(compileJsltStylesheet(stylesheet, { calendar })(data), WALL);
    refused(() => compileJsltStylesheet(stylesheet), (e) => {
      assert.equal(e.code, 'JT0007');
      assert.equal(e.cause.code, 'JQ0003');
      seamMissing(e);
    });
  });

  it('caches transformJson per seam, in either order', () => {
    const first = [{ match: '$', body: { $wall: '$.v' } }];
    assert.equal(transformJson(first, data, undefined, { calendar }), WALL);
    refused(() => transformJson(first, data), (e) => assert.equal(e.code, 'JT0007'));
    const second = [{ match: '$', body: { $wall: '$.v' } }];
    refused(() => transformJson(second, data), (e) => assert.equal(e.code, 'JT0007'));
    assert.equal(transformJson(second, data, undefined, { calendar }), WALL);
  });

  it('flows through a registry and beside its operators', () => {
    const registry = createJsltRegistry();
    assert.equal(registry.compile(stylesheet, { calendar })(data), WALL);
    assert.equal(registry.compileQuery({ $wall: '$.v' }, { calendar })(data), WALL);
    assert.equal(compileJsltStylesheet(stylesheet, { calendar, ...registry.toOptions() })(data), WALL);
  });

  it('refuses a calendar that is not the seam as TypeError, even with no rule body', () => {
    assert.throws(() => compileJsltStylesheet([], { calendar: /** @type {any} */ ({}) }), TypeError);
  });
});

describe('a JTLT template takes the calendar seam', () => {
  const template = [{ match: '$', body: ['at ', { $wall: '$.v' }] }];

  it('compiles, renders and validates a segment reading a calendar value with it', () => {
    assert.equal(compileJtltStylesheet(template, { calendar })(data), `at ${WALL}`);
    refused(() => compileJtltStylesheet(template), (e) => {
      assert.equal(e.code, 'TL0005');
      assert.equal(e.cause.cause.code, 'JQ0003');
    });
    assert.deepEqual(validateJtltTemplate(template, { calendar }), { valid: true, errors: [] });
    assert.equal(validateJtltTemplate(template).valid, false);
  });

  it('caches renderText per seam, in either order', () => {
    const first = [{ match: '$', body: ['at ', { $wall: '$.v' }] }];
    assert.equal(renderText(first, data, undefined, { calendar }), `at ${WALL}`);
    refused(() => renderText(first, data), (e) => assert.equal(e.code, 'TL0005'));
    const second = [{ match: '$', body: ['at ', { $wall: '$.v' }] }];
    refused(() => renderText(second, data), (e) => assert.equal(e.code, 'TL0005'));
    assert.equal(renderText(second, data, undefined, { calendar }), `at ${WALL}`);
  });
});
