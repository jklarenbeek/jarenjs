//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { compileFormula, createFormulaCompiler, formulaDocument } from '@jarenjs/json/formula';
import { defineFormula } from '@jarenjs/linq/formula';
import { createTypeTestCompiler } from '@jarenjs/validate/query';
import { QUERY_CODES } from '@jarenjs/json/query';

const doc = (expression, options = {}) => defineFormula('amount', expression, options);
it('saved structured formulas retain JSON types, optional absence and explicit inputs', () => {
  const profile = doc({ title: { $default: ['$.meta.label', 'unknown'] }, active: { $gt: ['$.price', 0] },
    branch: { $if: [{ $gt: ['$.price', 1] }, 'large', 'small'] }, rows: { $const: [1, 2] }, rate: '$rate' }, { bindings: { rate: 2 } });
  const compiled = compileFormula(profile);
  assert.deepEqual(compiled.evaluate({ price: 3 }), { kind: 'value', value: { title: 'unknown', active: true, branch: 'large', rows: [1, 2], rate: 2 } });
  assert.deepEqual(compileFormula(doc('$.missing')).evaluate({}), { kind: 'empty', values: [] });
  assert.deepEqual(compileFormula(doc(null)).evaluate({}), { kind: 'value', value: null });
  assert.deepEqual(compileFormula(doc({ $const: [] })).evaluate({}), { kind: 'value', value: [] });
  assert.deepEqual(compileFormula(doc('$.meta')).evaluate({ meta: null }), { kind: 'value', value: null });
  assert.deepEqual(compiled.dependencies, { source: ['meta', 'price'], computed: [], all: false });
});

it('capabilities and schemas compile once, invalidate by content/function identity, and protect caller data', () => {
  let schemaCompiles = 0;
  const typeTest = createTypeTestCompiler();
  const options = { helpers: { twice: { version: '1', run: (x) => x * 2, trust: /** @type {const} */ ('pure'), cost: 1 } },
    schemas: { row: { version: '1', schema: { type: 'object' } }, number: { version: '1', schema: { type: 'number' } } },
    compileTypeTest: (schema, path) => { schemaCompiles++; return typeTest(schema, path); } };
  const compiler = createFormulaCompiler(options);
  const profile = doc({ $call: ['twice', '$.price'] }, { helpers: [{ name: 'twice', version: '1' }], inputSchema: { id: 'row', version: '1' }, resultSchema: { id: 'number', version: '1' } });
  const first = compiler.compile(profile);
  assert.equal(compiler.compile(structuredClone(profile)), first);
  assert.equal(schemaCompiles, 2);
  assert.deepEqual(first.evaluate({ price: 3 }), { kind: 'value', value: 6 });
  options.helpers.twice.run = (x) => x * 3;
  assert.notEqual(compiler.compile(profile), first);
  assert.equal(compiler.compile(profile).evaluate({ price: 3 }).value, 9);
  options.schemas.number.schema = { type: 'string' };
  assert.throws(() => compiler.compile(profile).evaluate({ price: 3 }), { code: 'JQ2013', formulaId: 'amount', docPath: '/resultSchema' });
  assert.throws(() => first.evaluate(3), { code: 'JQ2013', docPath: '/inputSchema' });
  assert.notEqual(compiler.compile({ ...profile, revision: '2' }), first);
  assert.ok(compiler.size() > 0);
  compiler.clear(); assert.equal(compiler.size(), 0);
  const data = { values: [1] };
  const mutant = compileFormula(doc({ $call: ['change', '$.values'] }, { helpers: [{ name: 'change', version: '1' }] }),
    { helpers: { change: { version: '1', trust: 'pure', cost: 1, run: (x) => x.push(2) } } });
  assert.throws(() => mutant.evaluate(data), { code: 'JQ2010' });
  assert.deepEqual(data, { values: [1] });
  assert.equal(Object.isFrozen(data), false);
});

it('compile refusals identify the profile and exact document location', () => {
  for (const patch of [{ $formula: '2' }, { id: '' }, { revision: '' }, { resultMode: 'wrong' }, { bindings: [] }, { bindings: { context: 1 } }, { helpers: {} }, { helpers: [{ name: '', version: '1' }] }])
    assert.throws(() => formulaDocument({ ...doc(1), ...patch }), { code: 'JQ0013' });
  assert.throws(() => formulaDocument(null), { code: 'JQ0013' });
  assert.throws(() => formulaDocument({ id: 'bad', expression: NaN }), { code: 'JQ0013' });
  assert.throws(() => formulaDocument({ $formula: '1', id: 'a', revision: '1' }), { docPath: '/expression' });
  assert.throws(() => compileFormula(doc(1, { helpers: [{ name: 'missing', version: '1' }] })), { code: 'JQ0014', formulaId: 'amount', docPath: '/helpers/0' });
  const withSchema = doc(1, { inputSchema: { id: 'row', version: '1' } });
  assert.throws(() => compileFormula(withSchema), { code: 'JQ0014', docPath: '/inputSchema' });
  assert.throws(() => compileFormula(withSchema, { schemas: { row: { version: '1', schema: {} } }, compileTypeTest: () => { throw Error('invalid'); } }), { code: 'JQ0014' });
  assert.throws(() => compileFormula(doc({ $unknown: 1 })), { code: 'JQ0002', docPath: '/expression', formulaId: 'amount' });
  assert.throws(() => compileFormula(doc('$undeclared')), { code: 'JQ0005' });
  assert.throws(() => compileFormula(doc('$computed')), { code: 'JQ0015' });
  assert.throws(() => createFormulaCompiler({ cacheSize: 0 }), TypeError);
});

it('outcomes round trip and numeric/JSON boundaries never silently coerce', () => {
  for (const value of [{ kind: 'skip' }, { kind: 'explanation', text: 'protected' }, { kind: 'explanation', text: 'rounded', value: 3 }, { kind: 'value', value: null }, { kind: 'error', message: 'invalid' }]) {
    const result = compileFormula(doc({ $const: value }, { resultMode: 'outcome' })).evaluate({});
    assert.deepEqual(JSON.parse(JSON.stringify(result)), value);
  }
  assert.throws(() => compileFormula(doc(3, { resultMode: 'outcome' })).evaluate({}), { code: 'JQ2014' });
  assert.throws(() => compileFormula(doc({ kind: 'skip', value: 3 }, { resultMode: 'outcome' })).evaluate({}), { code: 'JQ2014' });
  assert.deepEqual(compileFormula(doc({ $const: { kind: 'path', name: 'computed' } })).evaluate({}), { kind: 'value', value: { kind: 'path', name: 'computed' } });
  assert.throws(() => compileFormula(doc({ $mul: [1e308, 1e308] })).evaluate({}), { code: 'JQ2013' });
  assert.throws(() => compileFormula(doc({ $mul: ['$.price', 2] })).evaluate({ price: '3' }), { code: 'JQ2001' });
  assert.throws(() => compileFormula(doc('$')).evaluate({ x: undefined }), { code: 'JQ2013' });
  const data = JSON.parse('{"__proto__":{"safe":true}}');
  assert.deepEqual(compileFormula(doc('$')).evaluate(data).value, data);
  assert.equal(QUERY_CODES.JQ0013, 'invalid versioned formula profile');
  assert.equal(QUERY_CODES.JQ0014, 'missing or incompatible formula capability');
  assert.equal(QUERY_CODES.JQ0015, 'invalid computed dependency graph');
  assert.equal(QUERY_CODES.JQ2013, 'formula input or result is not valid JSON/schema data');
  assert.equal(QUERY_CODES.JQ2014, 'invalid formula outcome');
  assert.equal(QUERY_CODES.JQ2015, 'invalid reviewed rule plan');
});

it('live cache identities distinguish signed zero without changing Query arithmetic', () => {
  const compiler = createFormulaCompiler({ helpers: { sign: { version: '1', trust: 'pure', cost: 1, run: (value) => Object.is(value, -0) } } });
  const profile = { $formula: '1', id: 'sign', revision: '1', helpers: [{ name: 'sign', version: '1' }], expression: { $call: ['sign', '$zero'] }, bindings: { zero: -0 } };
  assert.equal(compiler.compile(profile).evaluate({}).value, true);
  assert.equal(compiler.compile({ ...profile, bindings: { zero: 0 } }).evaluate({}).value, false);
});
