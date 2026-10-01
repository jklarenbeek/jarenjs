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
  it('names its four rules, and a clean contract (the shop example) has no finding', () => {
    assert.deepStrictEqual([...LINT_RULES], ['read-query-on-body-method', 'body-limit-unsatisfiable', 'body-limit-exceedable', 'retry-on-undeclared']);
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

  it('body-limit-exceedable: a member\'s own bound admits a valid value whose encoding alone exceeds the limit', () => {
    const labels = (/** @type {Record<string, any>} */ text, /** @type {Record<string, any>} */ policy = {}) => contract({
      'labels.put': { kind: 'command', input: { type: 'object', properties: { text, meta: { type: 'object', properties: { note: text } } } },
        output: true, http: { method: 'POST', path: '/labels' }, policy },
    });
    // up to 2,097,152 characters under the default 1 MiB limit: a valid request that long is refused JC2003
    const findings = lintContract(labels({ type: 'string', maxLength: 2097152 }));
    assert.deepStrictEqual(findings.map((f) => [f.rule, f.docPath]), [
      ['body-limit-exceedable', '/operations/labels.put/policy/limits/maxBodyBytes'],
    ]);
    assert.match(findings[0].message, /'\/text' admits strings of up to 2097152 characters — at least 2097154 bytes encoded — over policy\.limits\.maxBodyBytes 1048576/);
    assert.match(findings[0].message, /refused JC2003/);
    // a nested member, a nullable spelling and a union branch are read too; the largest bound is named
    const nested = lintContract(contract({
      'a.b': { kind: 'command', output: true, http: { method: 'POST', path: '/a' }, policy: { limits: { maxBodyBytes: 100 } },
        input: { type: 'object', properties: { meta: { type: 'object', properties: { note: { type: ['string', 'null'], maxLength: 120 } } },
          tag: { anyOf: [{ type: 'string', maxLength: 99 }, { type: 'null' }] } } } },
    }));
    assert.deepStrictEqual(nested.map((f) => f.rule), ['body-limit-exceedable']);
    assert.match(nested[0].message, /'\/meta\/note' admits strings of up to 120 characters/);
    // within the limit, or a bound that a pattern, format or value set may keep out of reach: no finding
    assert.deepStrictEqual(lintContract(labels({ type: 'string', maxLength: 1000 })), []);
    assert.deepStrictEqual(lintContract(labels({ type: 'string', maxLength: 2097152 }, { limits: { maxBodyBytes: 4 * 2097152 } })), []);
    for (const narrowed of [{ pattern: '^[a-z]{3}$' }, { format: 'date' }, { enum: ['a'] }, { const: 'a' }]) {
      assert.deepStrictEqual(lintContract(labels({ type: 'string', maxLength: 2097152, ...narrowed })), [], JSON.stringify(narrowed));
    }
    // a query member travels in the URL, not the body: not this rule's
    assert.deepStrictEqual(lintContract(contract({
      'a.q': { kind: 'read', output: true, http: { method: 'GET', path: '/q' },
        input: { type: 'object', properties: { q: { type: 'string', maxLength: 2097152 } } } },
    })), []);
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
