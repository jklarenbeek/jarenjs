//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { compileJsonQuery, analyzeQuery } from '@jarenjs/json';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import { compileFormula, formulaDocument, checkFormulaParity } from '@jarenjs/json/formula';
import { compileFormulaBatch } from '@jarenjs/json/formula/batch';
import { translateFormulaBody, migrateFormulas } from '@jarenjs/json/formula/migrate';

it('quantity refuses numeric tails joined by unsupported separators and keeps independent quantities', () => {
  const q = compileJsonQuery({ $quantity: ['$', 'g'] });
  for (const separator of ["'", '’', '_', '·', '#', '%', '+', '*']) {
    assert.equal(q(`1${separator}500 kg`), undefined, separator);
    assert.equal(q(`1 ${separator} 500 kg`), undefined, separator);
    assert.equal(q(`1${separator}500 kg; 2 kg`), 2000, separator);
  }
  assert.equal(q("weight '500 kg'"), 500000);
  assert.equal(q('2 x 500 g'), 500);
  assert.equal(q('1,500 g'), 1500);
  const supplementary = compileJsonQuery({ $quantity: ['$', 'g', 'supplementary'] }, { decimalFormats: { supplementary: { zeroDigit: '\u{1d7ce}' } } });
  assert.equal(supplementary('𝟏 𝟓𝟎𝟎 g'), undefined);
  assert.equal(supplementary('𝟏_𝟓𝟎𝟎 g'), undefined);
  assert.equal(supplementary('𝟓𝟎𝟎 g'), 500);
});

it('quantity scans a long whitespace-only field without an unbounded lookbehind search', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import {compileJsonQuery} from '@jarenjs/json'; const q=compileJsonQuery({$quantity:['$','g']}); if(q(' '.repeat(524288))!==undefined)process.exit(1);"],
  { cwd: process.cwd(), encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
});

it('translation uses array/string semantics for statically named computed members', () => {
  for (const [body, expected] of [
    ["return (row.l ?? [])['0'];", 'a'],
    ["return 'abc'['0'];", 'a'],
    ["return (row.l ?? [])['length'];", 2],
    ["return 'abc'['length'];", 3],
    ["return ({length: 7})['length'];", 7],
    ["return 'a,b'.split(',')['0'];", 'a'],
  ]) {
    const t = translateFormulaBody(body);
    assert.notEqual(t.state, 'untranslatable', JSON.stringify(t.reasons));
    const f = compileFormula(formulaDocument({ $formula: '1', id: 'members', revision: '1', expression: t.expression }));
    assert.deepEqual(f.evaluate({ l: ['a', 'b'] }), { kind: 'value', value: expected });
  }
  for (const body of ["return /x/.source;", "var r=/x/g; return r.flags;", "return row.l?.['0'];"]) {
    const t = translateFormulaBody(body);
    assert.equal(t.state, 'untranslatable', body);
    assert.ok(t.reasons.length > 0);
    assert.ok(t.reasons.every(r => Number.isSafeInteger(r.at.offset)));
  }
});

it('deep source syntax and expression chains become positioned migration review items', async () => {
  for (const body of ['return ' + '('.repeat(2000) + '1' + ')'.repeat(2000) + ';', 'return ' + Array(10000).fill('1').join('+') + ';']) {
    const t = translateFormulaBody(body);
    assert.equal(t.state, 'untranslatable');
    assert.equal(t.reasons[0].kind, 'complexity');
    assert.deepEqual(t.reasons[0].at, { offset: 0, line: 1, column: 1 });
    const sources = [
      { id: 'deep', label: 'deep', body, enabled: true, storageVersion: 1 },
      { id: 'ordinary', label: 'ordinary', body: 'return 2;', enabled: true, storageVersion: 1 },
    ];
    const first = await migrateFormulas(sources);
    assert.deepEqual(first.records.map(r => r.state), ['untranslatable', 'translated']);
    assert.deepEqual(first.records.map(r => r.original), sources);
    assert.equal((await migrateFormulas(sources, first.records)).changed, 0);
  }
});

it('mixed expression nesting refuses before exhausting the compiler stack', () => {
  let q = /** @type {any} */ (true);
  for (let i = 0; i < 2000; i++) q = { [i % 2 ? '$and' : '$or']: [q, true] };
  for (const run of [() => compileJsonQuery(q), () => compileJsonQuery(q, { limits: { depth: 10 } }), () => analyzeQuery(q)])
    assert.throws(run, /** @param {any} e */ e => e.code === 'JQ0011' && typeof e.docPath === 'string');
  assert.equal(compileJsonQuery({ $and: [true, { $or: [false, true] }] }, { limits: { depth: 3 } })(null), true);
});

it('query compiler and analyzer reject mistyped or unknown options before silently dropping bounds', () => {
  for (const options of [{ limit: { resultItems: 2 } }, { analysis: 'yes' }, { compileTypeTest: 1 }, 'limits']) {
    for (const run of [() => compileJsonQuery({ $range: [1, 4] }, options), () => analyzeQuery('$', options)])
      assert.throws(run, TypeError);
  }
  assert.equal(compileJsonQuery({ $call: ['double', 2] }, { functions: { double: x => x * 2 }, analysis: true })(null), 4);
  assert.equal(compileJsonQuery(1, { compileTypeTest: null })(null), 1);
  assert.equal(compileJsltStylesheet({ $jslt: '0.1', rules: [{ match: '$', body: 3 }] })(null), 3);
  assert.throws(() => compileJsonQuery({ $valid: [1, true] }, { analysis: true }), { code: 'JQ0008' });
  assert.doesNotThrow(() => analyzeQuery({ $valid: [1, true] }, { analysis: false }));
});

it('formula compiler, parity and migration options refuse unknown members while batch options stay owned by the batch', async () => {
  const document = formulaDocument({ $formula: '1', id: 'options', revision: '1', expression: 1 });
  assert.throws(() => compileFormula(document, { limts: { depth: 2 } }), TypeError);
  const formula = compileFormula(document);
  assert.throws(() => checkFormulaParity(formula, [null], [{ kind: 'value', value: 1, values: [1] }], { maxRow: 1 }), TypeError);
  await assert.rejects(migrateFormulas([], [], { translat: { argument: 'item' } }), TypeError);
  assert.doesNotThrow(() => compileFormulaBatch([{ id: 'target', formula: document }], { maxRows: 1, maxCells: 1, maxErrors: 1, maxMessageChars: 50, memoSize: 1 }));
});
