//@ts-check
/**
 * @file `lintContract` (CONTRACT-FORMAT §13.1): the authoring checks a
 * contract compiles through but a request would meet in production — each
 * rule on the document that trips it, with its stable id and `docPath`,
 * and the documents that do not.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileContract, lintContract, LINT_RULES } from '@jarenjs/contract';
import { load } from './helpers.js';

/** @param {Record<string, any>} operations */
const contract = (operations) => compileContract({ $contract: '0.1', operations });

describe('lintContract', () => {
  it('names its three rules, and a clean contract (the shop example) has no finding', () => {
    assert.deepStrictEqual([...LINT_RULES], ['read-query-on-body-method', 'body-limit-unsatisfiable', 'retry-on-undeclared']);
    assert.deepStrictEqual(lintContract(compileContract(load('./fixtures/shop.contract.json'))), []);
  });

  it('read-query-on-body-method: a read bound to POST whose members default to the query', () => {
    const findings = lintContract(contract({
      'labels.search': { kind: 'read', input: { type: 'object', properties: { q: { type: 'string' } } }, output: true,
        http: { method: 'POST', path: '/labels/search' } },
    }));
    const f = findings[0];
    assert.strictEqual(findings.length, 1);
    assert.deepStrictEqual([f.rule, f.op, f.docPath], ['read-query-on-body-method', 'labels.search', '/operations/labels.search/http/method']);
    assert.match(f.message, /'q'/);
    assert.match(f.message, /Bind the read to GET/);
    // declared locations, a GET, or a command: no finding
    assert.deepStrictEqual(lintContract(contract({
      'a.b': { kind: 'read', input: { type: 'object', properties: { q: { type: 'string' } } }, output: true, http: { method: 'POST', path: '/a', in: { q: 'body' } } },
      'a.c': { kind: 'read', input: { type: 'object', properties: { q: { type: 'string' } } }, output: true, http: { method: 'GET', path: '/c' } },
      'a.d': { kind: 'command', input: { type: 'object', properties: { q: { type: 'string' } } }, output: true, http: { method: 'POST', path: '/d' } },
    })), []);
  });

  it('body-limit-unsatisfiable: the smallest valid body is already over the limit (a lower bound)', () => {
    const tight = (/** @type {number} */ minLength, /** @type {number} */ maxBodyBytes) => contract({
      'labels.put': { kind: 'command', input: { type: 'object', required: ['text'], properties: { text: { type: 'string', minLength } } },
        output: true, http: { method: 'POST', path: '/labels' }, policy: { limits: { maxBodyBytes } } },
    });
    // {"text":"<20 chars>"} is at least 2 + 6 + 1 + 22 = 31 bytes
    const [f] = lintContract(tight(20, 30));
    assert.deepStrictEqual([f.rule, f.docPath], ['body-limit-unsatisfiable', '/operations/labels.put/policy/limits/maxBodyBytes']);
    assert.match(f.message, /at least 31 bytes, over policy\.limits\.maxBodyBytes 30/);
    assert.match(f.message, /lower bound/);
    assert.deepStrictEqual(lintContract(tight(20, 31)), [], 'the exact minimum fits');
  });

  it('retry-on-undeclared: every entry that is neither a declared code nor a binding\'s JC code', () => {
    const findings = lintContract(contract({
      'labels.search': { kind: 'read', output: true, errors: { busy: { status: 503 } }, http: { method: 'GET', path: '/s' },
        policy: { retry: { max: 2, on: ['busy', 'bussy', 'JC2051', 'JC9999', 'not a code'] } } },
    }));
    assert.deepStrictEqual(findings.map((f) => [f.rule, f.docPath]), [
      ['retry-on-undeclared', '/operations/labels.search/policy/retry/on/1'],
      ['retry-on-undeclared', '/operations/labels.search/policy/retry/on/3'],
      ['retry-on-undeclared', '/operations/labels.search/policy/retry/on/4'],
    ]);
    assert.match(findings[0].message, /'bussy'/);
  });

  it('takes a document too; a document that does not compile refuses with its own code; anything else is JC1008', () => {
    const doc = { $contract: '0.1', operations: { 'a.b': { kind: 'read', output: true, http: { method: 'POST', path: '/a' },
      input: { type: 'object', properties: { q: { type: 'string' } } } } } };
    assert.strictEqual(lintContract(doc)[0].rule, 'read-query-on-body-method');
    assert.throws(() => lintContract({ $contract: '0.1', operations: {} }), (e) => e.code === 'JC0002');
    assert.throws(() => lintContract(/** @type {any} */ ('nope')), (e) => e.code === 'JC1008');
  });
});
