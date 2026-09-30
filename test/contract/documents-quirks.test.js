//@ts-check
/**
 * @file The contract documents' quiet defects — the diff, the linter, the
 * revision and the tool projection — each reproduced before it was fixed:
 *
 * 1. A member added to an output closed by `unevaluatedProperties: false`
 *    read as additive, and one added beside a constraining catch-all
 *    (`additionalProperties` as a schema) as additive too: the old client
 *    refuses both answers.
 * 2. Under `audience: 'all'` an audience flip hid every other change of
 *    the operation from the internal gate.
 * 3. A type set did not count `integer` inside `number`: `number → integer`
 *    on an output read as breaking, `integer → number` on an input too.
 * 4. A constraint moved into an `anyOf` (a nullable respelled with a `$ref`
 *    branch, an enum moved into the branch) read as removed — breaking on
 *    an output — where the rule table promises R15.
 * 5. Two union spellings of one nullable node reported their changes at a
 *    pointer that resolves in neither document, and a reorder inside one
 *    spelling (a type array's items, a union's branches) reported R16.
 * 6. `body-limit-unsatisfiable` counted an optional whole-body member, and
 *    a requirement listed twice, toward its lower bound.
 * 7. `retry-on-undeclared` let through any JC code, though a compile code,
 *    a host code or a client-side contract code never arrives as a
 *    retryable outcome.
 * 8. `read-query-on-body-method` fired on a read that declares a body, and
 *    on an opaque read, where both of its fixes are refused (JC0017).
 * 9. The host revision's JC0061 called its projection "public"; the tool
 *    projection's audiences hint doubled 'public'.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileContract, lintContract, ContractCompileError } from '@jarenjs/contract';
import { diffContracts } from '@jarenjs/contract/diff';
import { contractTools } from '@jarenjs/contract/project';
import { openLocalClient } from '@jarenjs/contract/local';

/**
 * A one-operation contract.
 * @param {Record<string, any>} op
 * @param {Record<string, any>} [extra]
 */
const one = (op, extra = {}) => ({ $contract: '0.1', ...extra, operations: { 'a.b': op } });
/** @param {any} output */
const readOf = (output) => one({ kind: 'read', output, http: { method: 'GET', path: '/a' } });
/** @param {any} member */
const commandOf = (member) => one({ kind: 'command', input: { type: 'object', properties: { x: member } }, output: true, http: { method: 'POST', path: '/a' } });
/** @param {import('@jarenjs/contract/diff').ContractDiff} d */
const summary = (d) => ({
  breaking: d.breaking.map((c) => `${c.rule} ${c.kind}`),
  additive: d.additive.map((c) => `${c.rule} ${c.kind}`),
  neutral: d.neutral.map((c) => `${c.rule} ${c.kind}`),
  unknown: d.unknown.map((c) => `${c.rule} ${c.note}`),
});

describe('contract documents — the quiet defects, fixed', () => {
  it('1. an output closed by unevaluatedProperties is closed; a constraining catch-all makes an added member R15', () => {
    const closed = (/** @type {Record<string, any>} */ extra) => readOf({ type: 'object', properties: { s: { type: 'string' } }, unevaluatedProperties: false, ...extra });
    assert.deepStrictEqual(summary(diffContracts(closed({}), closed({ properties: { s: { type: 'string' }, n: { type: 'integer' } } }))).breaking,
      ['R8 output-member-added']);
    const catchAll = (/** @type {Record<string, any>} */ props) => readOf({ type: 'object', properties: props, additionalProperties: { type: 'string' } });
    assert.deepStrictEqual(summary(diffContracts(catchAll({ s: { type: 'string' } }), catchAll({ s: { type: 'string' }, n: { type: 'integer' } }))),
      { breaking: [], additive: [], neutral: [], unknown: ['R15 additionalProperties'] });
    // an open output still gains a member additively
    const open = (/** @type {Record<string, any>} */ props) => readOf({ type: 'object', properties: props });
    assert.deepStrictEqual(summary(diffContracts(open({ s: { type: 'string' } }), open({ s: { type: 'string' }, n: { type: 'integer' } }))).additive,
      ['R9 output-member-added']);
  });

  it('2. under audience: all, a flipped operation\'s other changes are compared too, marked server', () => {
    const op = (/** @type {'public' | 'server'} */ audience, /** @type {string[]} */ required) => one({
      kind: 'command', input: { type: 'object', required, properties: { x: { type: 'string' }, y: { type: 'string' } } },
      output: true, http: { method: 'POST', path: '/a' }, policy: { audience },
    });
    const d = diffContracts(op('server', ['x']), op('public', ['x', 'y']), { audience: 'all' });
    assert.deepStrictEqual(summary(d).additive, ['R14 audience-widened']);
    assert.deepStrictEqual(d.breaking.map((c) => [c.rule, c.audience]), [['R4', 'server']]);
    assert.strictEqual(d.additive[0].audience, undefined, 'the flip itself is what a public client sees');
    // the public reading is unchanged: the flip alone
    assert.deepStrictEqual(summary(diffContracts(op('server', ['x']), op('public', ['x', 'y']))).breaking, []);
  });

  it('3. a type set counts integer inside number', () => {
    assert.deepStrictEqual(summary(diffContracts(readOf({ type: 'number' }), readOf({ type: 'integer' }))),
      { breaking: [], additive: ['R9 output-narrowed'], neutral: [], unknown: [] });
    assert.deepStrictEqual(summary(diffContracts(commandOf({ type: 'integer' }), commandOf({ type: 'number' }))),
      { breaking: [], additive: ['R7 input-widened'], neutral: [], unknown: [] });
    // the reverse moves stay what they are
    assert.deepStrictEqual(summary(diffContracts(readOf({ type: 'integer' }), readOf({ type: 'number' }))).breaking, ['R8 output-widened']);
  });

  it('4. a constraint moved into an anyOf is R15, never a guessed direction', () => {
    const withRef = (/** @type {any} */ output) => readOf(output);
    const a = { ...withRef({ type: ['string', 'null'] }) };
    const b = { ...withRef({ anyOf: [{ $ref: '#/$defs/S' }, { type: 'null' }] }), $defs: { S: { type: 'string' } } };
    assert.deepStrictEqual(summary(diffContracts(a, b)), { breaking: [], additive: [], neutral: [], unknown: ['R15 anyOf', 'R15 type'] });
    const union = commandOf({ anyOf: [{ type: 'string', enum: ['a'] }, { type: 'null' }] });
    const array = commandOf({ type: ['string', 'null'], enum: ['a', null] });
    const d = diffContracts(union, array);
    assert.deepStrictEqual(d.breaking, [], 'the same values: nothing breaks');
    assert.ok(d.unknown.length > 0);
  });

  it('5. two union spellings report at a pointer that resolves; a reorder inside one spelling is silent', () => {
    const named = (/** @type {number} */ min) => commandOf({ anyOf: [{ type: 'string', minLength: min }, { type: 'null' }] });
    const d = diffContracts(named(1), named(3));
    assert.deepStrictEqual(d.breaking.map((c) => c.docPath), ['/operations/a.b/input/properties/x/anyOf/0/minLength']);
    for (const [from, to] of /** @type {[any, any][]} */ ([
      [{ type: ['null', 'string'] }, { type: ['string', 'null'] }],
      [{ anyOf: [{ type: 'string' }, { type: 'null' }] }, { anyOf: [{ type: 'null' }, { type: 'string' }] }],
    ])) {
      assert.deepStrictEqual(summary(diffContracts(commandOf(from), commandOf(to))), { breaking: [], additive: [], neutral: [], unknown: [] });
    }
    // a real respelling still reports R16
    assert.deepStrictEqual(summary(diffContracts(commandOf({ type: ['string', 'null'] }), commandOf({ anyOf: [{ type: 'string' }, { type: 'null' }] }))).neutral,
      ['R16 schema-respelled']);
  });

  it('6. the body lower bound skips an optional whole-body member and counts a requirement once', () => {
    const lint = (/** @type {Record<string, any>} */ op) => lintContract(one(op)).map((f) => f.rule);
    assert.deepStrictEqual(lint({
      kind: 'command', input: { type: 'object', properties: { title: { type: 'string' }, text: { type: 'string', minLength: 64 } } },
      output: true, http: { method: 'POST', path: '/a', in: { title: 'query' }, body: 'text' }, policy: { limits: { maxBodyBytes: 32 } },
    }), []);
    assert.deepStrictEqual(lint({
      kind: 'command', input: { type: 'object', required: ['doc'], properties: { doc: { type: 'object', required: ['text', 'text', 'text'], properties: { text: { type: 'string', minLength: 20 } } } } },
      output: true, http: { method: 'POST', path: '/a' }, policy: { limits: { maxBodyBytes: 48 } },
    }), []);
  });

  it('7. retry.on accepts a declared code, a JC20xx wire code and JC2051; any other JC code is flagged', () => {
    const findings = lintContract(one({
      kind: 'read', output: true, errors: { gone: { status: 410 } }, http: { method: 'GET', path: '/a' },
      policy: { retry: { max: 2, on: ['gone', 'JC2009', 'JC2051', 'JC0003', 'JC1008', 'JC2053', 'JC2050', 'bussy'] } },
    }));
    assert.deepStrictEqual(findings.map((f) => f.docPath.split('/').pop()), ['3', '4', '5', '6', '7']);
    assert.ok(findings.every((f) => f.rule === 'retry-on-undeclared'));
  });

  it('8. read-query-on-body-method stays quiet for a read that declares a body, and for an opaque read', () => {
    const lint = (/** @type {Record<string, any>} */ http) => lintContract(one({
      kind: 'read', input: { type: 'object', properties: { limit: { type: 'integer' }, filter: { type: 'object' } } }, output: true, http,
    })).map((f) => f.rule);
    assert.deepStrictEqual(lint({ method: 'POST', path: '/a' }), ['read-query-on-body-method']);
    assert.deepStrictEqual(lint({ method: 'POST', path: '/a', body: 'filter' }), []);
    assert.deepStrictEqual(lint({ method: 'POST', path: '/a', media: 'image/*' }), []);
  });

  it('9. the host revision names its own projection; the audiences hint keeps the audiences given', async () => {
    const contract = compileContract({ $contract: '0.1', operations: {
      'a.b': { kind: 'read', output: true, http: { method: 'GET', path: '/a' } },
      'admin.purge': { kind: 'command', output: true, doc: 'bad \uD800', http: { method: 'POST', path: '/p' }, policy: { audience: 'server' } },
    } });
    assert.match(await contract.revision(), /^[0-9a-f]{64}$/);
    await assert.rejects(contract.revision({ audience: 'all' }), (/** @type {any} */ err) =>
      err instanceof ContractCompileError && err.code === 'JC0061' && /the host projection is not canonicalizable/.test(err.message));
    const client = openLocalClient(contract, { 'a.b': () => true, 'admin.purge': () => true });
    assert.throws(() => contractTools(contract, client, { audiences: ['server'], ops: ['a.b'] }),
      (/** @type {any} */ err) => err.code === 'JC1008' && err.message.includes("pass audiences: ['server', 'public']"));
    client.close();
  });
});
