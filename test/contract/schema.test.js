//@ts-check
/**
 * @file The jaren-contract grammar artifact and the format document:
 * the draft-07 twin is the mechanical downlevel of the 2020-12 source,
 * the source stays in the draft-neutral subset, the shop example and
 * every ```json block of CONTRACT-FORMAT.md validate against both twins
 * AND compile, the JC code tables in the doc equal `CONTRACT_CODES`, and
 * every negative the grammar can express fails the grammar — with the
 * compiler-only rules named as such and proven to pass the grammar.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { JarenValidator } from '@jarenjs/validate';
import { jsonFormats } from '@jarenjs/formats';
import { compileContract, ContractCompileError, CONTRACT_CODES } from '@jarenjs/contract';
import {
  downlevelDraft07,
  draftNeutralSubsetViolations,
  mapRefs,
} from '../json/schema-artifact-helpers.js';
import { load, ROUTES, routesToContract } from './helpers.js';

const schema = load('../../packages/contract/schemas/jaren-contract.schema.json');
const schema07 = load('../../packages/contract/schemas/jaren-contract.draft-07.schema.json');
const shop = load('./fixtures/shop.contract.json');
const FORMAT_DOC = new URL('../../packages/contract/docs/CONTRACT-FORMAT.md', import.meta.url);

/** @param {any} artifact */
function compileGrammar(artifact) {
  return new JarenValidator().addFormats(jsonFormats).compile(artifact);
}

/**
 * Every ```json block in CONTRACT-FORMAT.md is a COMPLETE contract
 * document by convention (fragments use other fences): each must
 * validate against the grammar AND compile.
 */
function formatDocExamples() {
  const md = readFileSync(FORMAT_DOC, 'utf8');
  return [...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));
}

/**
 * The codes a normative markdown table lists (rows shaped `| JC0001 |`).
 * @param {string} text
 */
function docCodes(text) {
  const codes = new Set();
  for (const m of text.matchAll(/^\|\s*`?(JC[0-9]{4})`?\s*\|/gm)) codes.add(m[1]);
  return [...codes].sort();
}

/**
 * A minimal document around one operation.
 * @param {any} op
 * @param {any} [rootExtra]
 */
function one(op, rootExtra = {}) {
  return { $contract: '0.1', operations: { a: op }, ...rootExtra };
}
const READ = { kind: 'read', output: true, http: { method: 'GET', path: '/a' } };

describe('CONTRACT-FORMAT.md is in sync with the code', () => {
  it('the JC error-code tables (§6 compile, §7 host and http) list exactly CONTRACT_CODES', () => {
    const inDoc = docCodes(readFileSync(FORMAT_DOC, 'utf8'));
    assert.deepStrictEqual(inDoc, Object.keys(CONTRACT_CODES).sort());
  });

  it('every ```json example is a complete document that validates and compiles', () => {
    const validate = compileGrammar(schema);
    const validate07 = compileGrammar(schema07);
    const examples = formatDocExamples();
    assert.ok(examples.length >= 3, 'the format doc carries its worked examples');
    for (const doc of examples) {
      assert.strictEqual(validate(doc), true, `a CONTRACT-FORMAT example must validate: ${JSON.stringify(doc).slice(0, 80)}`);
      assert.strictEqual(validate07(doc), true);
      assert.doesNotThrow(() => compileContract(doc), 'a CONTRACT-FORMAT example must compile');
    }
  });
});

describe('the jaren-contract schema artifact', () => {
  it('stays in the draft-neutral subset and its draft-07 twin is in sync', () => {
    assert.deepStrictEqual(draftNeutralSubsetViolations(schema), []);
    assert.deepStrictEqual(schema07, mapRefs(downlevelDraft07(schema)),
      'regenerate the committed twin from the canonical artifact');
    assert.strictEqual(schema.$id, 'https://jarenjs.dev/schemas/jaren-contract/0.1');
    assert.strictEqual(schema07.$id, 'https://jarenjs.dev/schemas/jaren-contract/0.1/draft-07');
  });

  it('accepts the shop example and the partner table under both drafts', () => {
    const validate = compileGrammar(schema);
    const validate07 = compileGrammar(schema07);
    assert.strictEqual(validate(shop), true);
    assert.strictEqual(validate07(shop), true);
    const wms = routesToContract(ROUTES);
    assert.strictEqual(validate(wms), true, ':name templates are grammatical');
    assert.strictEqual(validate07(wms), true);
  });

  it('accepts the smallest document and the canonical-binding operation', () => {
    const validate = compileGrammar(schema);
    assert.strictEqual(validate({ $contract: '0.1', operations: { a: { kind: 'command', output: true } } }), true);
    assert.strictEqual(validate({ $contract: '0.1', operations: { a: { kind: 'read', output: false, http: { method: 'GET', path: '/' } } } }), true);
  });

  /**
   * The negatives the GRAMMAR can express, by the compiler code they
   * correspond to. Each fails the grammar under both drafts and is
   * refused by the compiler with that code.
   * @type {[string, any][]}
   */
  const grammatical = [
    ['JC0001', { operations: { a: READ } }],
    ['JC0001', { $contract: '0.2', operations: { a: READ } }],
    ['JC0001', one(READ, { $defs: [] })],
    ['JC0001', one(READ, { $defs: { X: 5 } })],
    ['JC0002', { $contract: '0.1' }],
    ['JC0002', { $contract: '0.1', operations: {} }],
    ['JC0002', { $contract: '0.1', operations: [] }],
    ['JC0002', { $contract: '0.1', operations: { a: 1 } }],
    ['JC0003', { $contract: '0.1', operations: { 'Bad.Id': READ } }],
    ['JC0003', { $contract: '0.1', operations: { 'a-b': READ } }],
    ['JC0004', one({ output: true })],
    ['JC0004', one({ kind: 'write', output: true })],
    ['JC0004', one({ kind: 'subscribe', output: true })],
    ['JC0005', one({ kind: 'read', input: true, output: true })],
    ['JC0005', one({ kind: 'read', input: 'x', output: true })],
    ['JC0006', one({ kind: 'read' })],
    ['JC0006', one({ kind: 'read', output: 'yes' })],
    ['JC0008', one({ kind: 'read', output: true, http: { method: 'GET' } })],
    ['JC0008', one({ kind: 'read', output: true, http: { method: 'GET', path: 'api' } })],
    ['JC0008', one({ kind: 'read', output: true, http: { method: 'GET', path: '/a/' } })],
    ['JC0008', one({ kind: 'read', output: true, http: { method: 'GET', path: '/a//b' } })],
    ['JC0008', one({ kind: 'read', output: true, http: { method: 'GET', path: '/files/{path+}' } })],
    ['JC0008', one({ kind: 'read', output: true, http: { method: 'GET', path: '/x/*' } })],
    ['JC0008', one({ kind: 'read', output: true, http: { method: 'GET', path: '/x/{?q}' } })],
    ['JC0008', one({ kind: 'read', output: true, http: { method: 'GET', path: '/x/{id}.json' } })],
    ['JC0008', one({ kind: 'read', output: true, http: { method: 'GET', path: '/a b' } })],
    ['JC0009', one({ kind: 'read', input: { type: 'object', properties: { x: { type: 'string' } } }, output: true, http: { method: 'GET', path: '/a', in: { x: 'cookie' } } })],
    ['JC0011', one({ kind: 'read', output: true, errors: [] })],
    ['JC0011', one({ kind: 'read', output: true, errors: { Bad: {} } })],
    ['JC0011', one({ kind: 'read', output: true, errors: { e: 404 } })],
    ['JC0011', one({ kind: 'read', output: true, errors: { e: { status: 99 } } })],
    ['JC0011', one({ kind: 'read', output: true, errors: { e: { status: 600 } } })],
    ['JC0011', one({ kind: 'read', output: true, errors: { e: { schema: 5 } } })],
    ['JC0012', one({ kind: 'read', output: true, http: 'GET /a' })],
    ['JC0012', one({ kind: 'read', output: true, http: { method: 'get', path: '/a' } })],
    ['JC0012', one({ kind: 'read', output: true, http: { method: 'BREW', path: '/a' } })],
    ['JC0012', one({ kind: 'read', output: true, http: { path: '/a' } })],
    ['JC0012', one({ kind: 'read', output: true, http: { method: 'GET', path: '/a', status: 300 } })],
    ['JC0012', one({ kind: 'read', output: true, http: { method: 'GET', path: '/a', media: 'json' } })],
    ['JC0013', one(READ, { extra: 1 })],
    ['JC0013', one({ ...READ, extra: 1 })],
    ['JC0013', one({ ...READ, policy: { extra: 1 } })],
    ['JC0013', one({ ...READ, policy: { limits: { maxBytes: 1 } } })],
    ['JC0013', one({ ...READ, policy: { retry: { max: 1, on: [], backoff: 2 } } })],
    ['JC0013', one({ ...READ, http: { method: 'GET', path: '/a', extra: 1 } })],
    ['JC0013', one({ ...READ, errors: { e: { status: 404, message: 'x' } } })],
    ['JC0014', one({ ...READ, policy: 'fast' })],
    ['JC0014', one({ ...READ, policy: { task: 'serial' } })],
    ['JC0014', one({ ...READ, policy: { idempotency: 'maybe' } })],
    ['JC0014', one({ ...READ, policy: { revision: '/revision' } })],
    ['JC0014', one({ ...READ, policy: { revision: 'input:x' } })],
    ['JC0014', one({ ...READ, policy: { cache: 'all' } })],
    ['JC0014', one({ ...READ, policy: { limits: { maxBodyBytes: 0 } } })],
    ['JC0014', one({ ...READ, policy: { errors: { details: 'some' } } })],
    ['JC0014', one({ ...READ, policy: { retry: { max: -1, on: [] } } })],
    ['JC0014', one({ ...READ, policy: { retry: { max: 1, on: 'x' } } })],
    ['JC0015', one(READ, { id: 5 })],
    ['JC0015', one(READ, { id: '9shop' })],
    ['JC0015', one(READ, { version: '' })],
    ['JC0015', one(READ, { compat: '4' })],
    ['JC0015', one({ ...READ, doc: 5 })],
  ];

  it('every negative the grammar can express fails the grammar under both drafts and is refused by the compiler with the same code', () => {
    const validate = compileGrammar(schema);
    const validate07 = compileGrammar(schema07);
    const covered = new Set();
    for (const [code, doc] of grammatical) {
      assert.strictEqual(validate(doc), false, `${code}: ${JSON.stringify(doc)} must fail the grammar`);
      assert.strictEqual(validate07(doc), false, `${code}: ${JSON.stringify(doc)} must fail the draft-07 twin`);
      assert.throws(() => compileContract(doc), (err) => err instanceof ContractCompileError && err.code === code,
        `${code}: ${JSON.stringify(doc)} must be refused by the compiler with ${code}`);
      covered.add(code);
    }
    assert.deepStrictEqual([...covered].sort(),
      ['JC0001', 'JC0002', 'JC0003', 'JC0004', 'JC0005', 'JC0006', 'JC0008', 'JC0009', 'JC0011', 'JC0012', 'JC0013', 'JC0014', 'JC0015']);
  });

  /**
   * The rules only the COMPILER can decide — cross-member, resolution
   * and semantic checks a structural grammar cannot express. Each is
   * grammatical (the grammar accepts it) and refused by the compiler.
   * @type {[string, string, any][]}
   */
  const compilerOnly = [
    ['JC0005', 'the effective input type after $ref', one({ kind: 'read', input: { $ref: '#/$defs/S' }, output: true }, { $defs: { S: { type: 'string' } } })],
    ['JC0005', 'an input object schema without "type": "object"', one({ kind: 'read', input: { properties: {} }, output: true })],
    ['JC0007', '$ref resolution', one({ kind: 'read', output: { $ref: '#/$defs/Nope' } })],
    ['JC0009', 'a path variable against input.properties', one({ kind: 'read', output: true, http: { method: 'GET', path: '/a/{id}' } })],
    ['JC0009', 'a location conflict', one({ kind: 'read', input: { type: 'object', properties: { id: { type: 'string' } } }, output: true, http: { method: 'GET', path: '/a/{id}', in: { id: 'query' } } })],
    ['JC0010', 'route-shape uniqueness', { $contract: '0.1', operations: { first: READ, second: { kind: 'command', output: true, http: { method: 'GET', path: '/a' } } } }],
    ['JC0014', 'a read declaring idempotency', one({ ...READ, policy: { idempotency: 'required' } })],
    ['JC0016', 'a GET body', one({ kind: 'read', input: { type: 'object', properties: { x: { type: 'string' } } }, output: true, http: { method: 'GET', path: '/a', in: { x: 'body' } } })],
    ['JC0017', 'an opaque body member', one({ kind: 'command', input: { type: 'object', properties: { x: { type: 'string' } } }, output: true, http: { method: 'PUT', path: '/a', media: 'application/octet-stream' } })],
  ];

  it('the compiler-only rules pass the grammar and are refused by the compiler', () => {
    const validate = compileGrammar(schema);
    for (const [code, what, doc] of compilerOnly) {
      assert.strictEqual(validate(doc), true, `${code} (${what}) is beyond a structural grammar; the compiler owns it`);
      assert.throws(() => compileContract(doc), (err) => err instanceof ContractCompileError && err.code === code, `${code} (${what})`);
    }
    // JC0001's hostile-accessor branch is likewise the compiler's alone
    assert.throws(() => compileContract({ $contract: '0.1', operations: { a: { kind: 'read', output: true, get http() { throw new Error('x'); } } } }),
      (err) => err instanceof ContractCompileError && err.code === 'JC0001');
  });
});
