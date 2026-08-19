//@ts-check
/**
 * @file The outcome assembler, pure (no fetch): every row of the
 * CONTRACT-FORMAT.md §10.2 assembly table has the test case the table
 * names (a test enumerates the table from the markdown and checks each
 * name exists in the client test files); every `JC2001–JC2015` taxonomy row maps to a
 * `failure` outcome with its status, code and retryable; the §10.3
 * client-code table ⇔ `CLIENT_ERRORS` ⇔ `CONTRACT_CODES` ⇔ the English
 * catalog; and `invoke` never rejects for any server response.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { compileContract, CONTRACT_CODES, contractMessagesEn } from '@jarenjs/contract';
import { HTTP_ERRORS } from '@jarenjs/contract/http';
import {
  CLIENT_ERRORS, assembleOutcome, prepareOutcomeRoute, makeMeta, outcomeError, isOutcome, openHttpClient,
  hostFailureOutcome, OUTCOME_ERROR_MEMBERS, OUTCOME_META_MEMBERS,
} from '@jarenjs/contract/client';
import { load } from './helpers.js';

const shop = compileContract(load('./fixtures/shop.contract.json'));
const FORMAT_DOC = new URL('../../packages/contract/docs/CONTRACT-FORMAT.md', import.meta.url);
const THIS_FILE = new URL(import.meta.url);

const save = prepareOutcomeRoute(shop.operations['product.save']);
const catalog = prepareOutcomeRoute(shop.operations['catalog.load']);
const remove = prepareOutcomeRoute(shop.operations['product.remove']);

/**
 * Assemble from a status + text, a fresh meta each time.
 * @param {import('@jarenjs/contract/client').OutcomeRoute} route
 * @param {number | null} status
 * @param {string | null} text
 * @param {Record<string, string> | null} [headers]
 */
function from(route, status, text, headers = null) {
  return assembleOutcome(route, { status, headers, text }, makeMeta(route.id, 42, 'trace-1'), null);
}

const PRODUCT = { id: 1, name: 'x', price: 1 };

describe('client outcomes — the §10.2 assembly table, row by row', () => {
  it('2xx empty body is a null value when the output allows it', () => {
    const r = from(remove, 204, '');
    assert.deepStrictEqual(r, { ok: true, value: null, meta: { op: 'product.remove', attempt: 42, trace: 'trace-1', revision: null, etag: null, notModified: false } });
    assert.strictEqual(from(remove, 200, null).ok, true);
  });

  it('2xx empty body against a non-null output is JC2053', () => {
    const r = from(save, 200, '');
    assert.strictEqual(r.ok, false);
    if (r.ok) return;
    assert.strictEqual(r.kind, 'contract');
    assert.strictEqual(r.error.code, 'JC2053');
    assert.strictEqual(r.error.status, 200);
    assert.strictEqual(r.error.retryable, false);
    assert.deepStrictEqual(r.error.details, [{ path: '', keyword: 'type' }], 'details by policy (paths)');
  });

  it('2xx valid JSON is ok with meta.etag from the header', () => {
    const r = from(save, 200, JSON.stringify(PRODUCT), { etag: '"v1"' });
    assert.deepStrictEqual(r, { ok: true, value: PRODUCT, meta: { op: 'product.save', attempt: 42, trace: 'trace-1', revision: null, etag: '"v1"', notModified: false } });
    assert.strictEqual(from(save, 201, JSON.stringify(PRODUCT)).ok, true, 'any 2xx is a success');
  });

  it('2xx invalid output is JC2053 with details by policy', () => {
    const r = from(save, 200, JSON.stringify({ id: 'nope' }));
    assert.strictEqual(r.ok, false);
    if (r.ok) return;
    assert.strictEqual(r.kind, 'contract');
    assert.strictEqual(r.error.code, 'JC2053');
    assert.ok(Array.isArray(r.error.details) && r.error.details.length > 0);
    assert.ok(r.error.details.every((/** @type {any} */ d) => typeof d.path === 'string' && typeof d.keyword === 'string' && !('value' in d)), 'paths: no values');
    // details: full on product.remove → the validator's own records
    const full = from(remove, 200, 'null');
    assert.strictEqual(full.ok, true, 'output true accepts null');
    const none = assembleOutcome(prepareOutcomeRoute(compileContract({ $contract: '0.1', operations: { a: { kind: 'read', output: { type: 'integer' }, policy: { errors: { details: 'none' } } } } }).operations.a),
      { status: 200, headers: null, text: '"x"' }, makeMeta('a', null, null), null);
    assert.strictEqual(none.ok, false);
    if (!none.ok) assert.strictEqual(none.error.details, null, 'details none → null (never undefined)');
  });

  it('2xx non-JSON is JC2053', () => {
    const r = from(save, 200, '<html>');
    assert.strictEqual(r.ok, false);
    if (r.ok) return;
    assert.strictEqual(r.kind, 'contract');
    assert.strictEqual(r.error.code, 'JC2053');
    assert.deepStrictEqual(r.error.details, [{ path: '', keyword: 'json' }]);
  });

  it('304 is ok null with notModified and the etag', () => {
    const r = from(catalog, 304, '', { etag: 'W/"r1"' });
    assert.deepStrictEqual(r, { ok: true, value: null, meta: { op: 'catalog.load', attempt: 42, trace: 'trace-1', revision: null, etag: 'W/"r1"', notModified: true } });
  });

  it('an error body with a declared code is a failure', () => {
    const r = from(save, 409, JSON.stringify({ code: 'conflict', message: 'nope', requestId: 't', details: { current: PRODUCT }, retryable: false }));
    assert.deepStrictEqual(r, {
      ok: false, kind: 'failure',
      error: { code: 'conflict', message: 'nope', status: 409, details: { current: PRODUCT }, retryable: false },
      meta: { op: 'product.save', attempt: 42, trace: 'trace-1', revision: null, etag: null, notModified: false },
    });
    // message rendered and retryable from policy.retry.on when the body carries neither
    const bare = from(save, 404, JSON.stringify({ code: 'not-found' }));
    assert.strictEqual(bare.ok, false);
    if (bare.ok) return;
    assert.strictEqual(bare.error.message, 'operation product.save failed with not-found');
    assert.strictEqual(bare.error.retryable, true, 'retry.on names not-found');
    assert.strictEqual(bare.error.details, null);
    // the body's retryable wins over the policy
    const explicit = from(save, 404, JSON.stringify({ code: 'not-found', retryable: false }));
    if (!explicit.ok) assert.strictEqual(explicit.error.retryable, false);
    // a declared code wins even when the status is not the declared one
    const odd = from(save, 418, JSON.stringify({ code: 'conflict' }));
    if (!odd.ok) assert.deepStrictEqual([odd.kind, odd.error.code, odd.error.status], ['failure', 'conflict', 418]);
  });

  it('an error body with a taxonomy code is a failure', () => {
    const r = from(save, 400, JSON.stringify({ code: 'JC2006', message: 'the input of operation product.save is invalid', requestId: 't', details: [{ path: '/id', keyword: 'type' }], retryable: false }));
    assert.strictEqual(r.ok, false);
    if (r.ok) return;
    assert.strictEqual(r.kind, 'failure');
    assert.deepStrictEqual(r.error, { code: 'JC2006', message: 'the input of operation product.save is invalid', status: 400, details: [{ path: '/id', keyword: 'type' }], retryable: false });
    // message rendered from the taxonomy msgid when the body has none
    const bare = from(save, 409, JSON.stringify({ code: 'JC2009', retryable: true }));
    if (!bare.ok) {
      assert.match(bare.error.message, /^the Idempotency-Key of operation product.save conflicts with an earlier request/);
      assert.strictEqual(bare.error.retryable, true);
    }
  });

  it('an undeclared code is JC2055', () => {
    const r = from(save, 400, JSON.stringify({ code: 'teapot', message: 'x' }));
    assert.strictEqual(r.ok, false);
    if (r.ok) return;
    assert.strictEqual(r.kind, 'contract');
    assert.deepStrictEqual([r.error.code, r.error.status, r.error.retryable], ['JC2055', 400, false]);
    assert.match(r.error.message, /status 400/);
    // a code another operation declares is undeclared for this one
    const other = from(catalog, 409, JSON.stringify({ code: 'conflict' }));
    if (!other.ok) assert.strictEqual(other.error.code, 'JC2055');
    // retryable by status class: 5xx and 429
    const five = from(save, 503, JSON.stringify({ code: 'teapot' }));
    if (!five.ok) assert.strictEqual(five.error.retryable, true);
    const rate = from(save, 429, JSON.stringify({ code: 'teapot' }));
    if (!rate.ok) assert.strictEqual(rate.error.retryable, true);
  });

  it('an error body without a code is JC2055', () => {
    const r = from(save, 400, JSON.stringify({ error: 'legacy shape' }));
    assert.strictEqual(r.ok, false);
    if (r.ok) return;
    assert.deepStrictEqual([r.kind, r.error.code, r.error.status], ['contract', 'JC2055', 400]);
    const num = from(save, 400, JSON.stringify({ code: 409 }));
    if (!num.ok) assert.strictEqual(num.error.code, 'JC2055');
    const arr = from(save, 400, '[1]');
    if (!arr.ok) assert.strictEqual(arr.error.code, 'JC2055');
  });

  it('a non-JSON error body is JC2055', () => {
    const html = from(save, 502, '<html>bad gateway</html>');
    assert.strictEqual(html.ok, false);
    if (html.ok) return;
    assert.deepStrictEqual([html.kind, html.error.code, html.error.status, html.error.retryable], ['contract', 'JC2055', 502, true]);
    const empty = from(save, 404, '');
    if (!empty.ok) assert.deepStrictEqual([empty.error.code, empty.error.status, empty.error.retryable], ['JC2055', 404, false]);
    const redirect = from(save, 301, null);
    if (!redirect.ok) assert.deepStrictEqual([redirect.kind, redirect.error.code, redirect.error.status], ['contract', 'JC2055', 301]);
  });

  it('a status-less wire (port/local shape) assembles from a value or an error envelope', () => {
    const ok = assembleOutcome(save, { status: null, headers: null, value: PRODUCT }, makeMeta('product.save', null, null), null);
    assert.deepStrictEqual(ok, { ok: true, value: PRODUCT, meta: { op: 'product.save', attempt: null, trace: null, revision: null, etag: null, notModified: false } });
    const bad = assembleOutcome(save, { status: null, headers: null, value: { id: 'x' } }, makeMeta('product.save', null, null), null);
    if (!bad.ok) assert.deepStrictEqual([bad.kind, bad.error.code, bad.error.status], ['contract', 'JC2053', null]);
    const fail = assembleOutcome(save, { status: null, headers: null, error: { code: 'conflict', details: { current: PRODUCT } } }, makeMeta('product.save', null, null), null);
    if (!fail.ok) assert.deepStrictEqual([fail.kind, fail.error.code, fail.error.status, fail.error.details], ['failure', 'conflict', null, { current: PRODUCT }]);
    const undeclared = assembleOutcome(save, { status: null, headers: null, error: { code: 'zzz' } }, makeMeta('product.save', null, null), null);
    if (!undeclared.ok) assert.deepStrictEqual([undeclared.kind, undeclared.error.code, undeclared.error.retryable], ['contract', 'JC2055', false]);
  });

  it('every outcome is JSON and is recognized by isOutcome', () => {
    const all = [from(remove, 204, ''), from(save, 200, JSON.stringify(PRODUCT)), from(save, 409, JSON.stringify({ code: 'conflict' })),
      from(save, 502, 'x'), from(catalog, 304, '', { etag: 'W/"1"' }), from(save, 200, '')];
    for (const o of all) {
      assert.strictEqual(isOutcome(o), true);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(o)), o, 'no undefined member, no host object');
    }
    assert.strictEqual(isOutcome(null), false);
    assert.strictEqual(isOutcome({ ok: false }), false);
    assert.strictEqual(isOutcome({ ok: true }), false);
    assert.strictEqual(isOutcome({ ok: false, kind: 'weird', error: { code: 'x' }, meta: {} }), false);
    assert.strictEqual(isOutcome(new Proxy({}, { get() { throw new Error('hostile'); } })), false);
    // D6 (03A): the fixed shapes — a meta or error missing a member, or carrying undefined in one, is not an outcome
    const META = makeMeta('a', 1, null);
    const ERROR = outcomeError('c', 'm', null, undefined, false);
    assert.strictEqual(isOutcome({ ok: false, kind: 'failure', error: { code: 'x' }, meta: {} }), false);
    assert.strictEqual(isOutcome({ ok: true, value: 1, meta: META }), true);
    assert.strictEqual(isOutcome({ ok: true, value: 1, meta: { ...META, notModified: undefined } }), false, 'undefined is not a member');
    const { notModified: _n, ...noNotModified } = META;
    assert.strictEqual(isOutcome({ ok: true, value: 1, meta: noNotModified }), false, 'a meta missing notModified');
    assert.strictEqual(isOutcome({ ok: false, kind: 'failure', error: ERROR, meta: META }), true);
    assert.strictEqual(isOutcome({ ok: false, kind: 'failure', error: { ...ERROR, details: undefined }, meta: META }), false, 'an error with details: undefined');
    const { status: _s, ...noStatus } = ERROR;
    assert.strictEqual(isOutcome({ ok: false, kind: 'failure', error: noStatus, meta: META }), false, 'an error missing status (a binding without statuses carries null)');
    assert.strictEqual(isOutcome({ ok: false, kind: 'failure', error: { ...ERROR, code: 5 }, meta: META }), false);
    assert.strictEqual(isOutcome(hostFailureOutcome('a', null, null)), true);
  });

  it('the D6 member lists are exactly the keys of a fresh makeMeta / outcomeError, in order, frozen', () => {
    assert.deepStrictEqual([...OUTCOME_META_MEMBERS], Object.keys(makeMeta('a', null, null)));
    assert.deepStrictEqual([...OUTCOME_ERROR_MEMBERS], Object.keys(outcomeError('c', 'm', null, undefined, false)));
    assert.deepStrictEqual([...OUTCOME_META_MEMBERS], ['op', 'attempt', 'trace', 'revision', 'etag', 'notModified']);
    assert.deepStrictEqual([...OUTCOME_ERROR_MEMBERS], ['code', 'message', 'status', 'details', 'retryable']);
    assert.strictEqual(Object.isFrozen(OUTCOME_META_MEMBERS) && Object.isFrozen(OUTCOME_ERROR_MEMBERS), true);
    // every outcome the assembler produces carries exactly these members (no extra, none undefined)
    for (const o of [from(save, 200, JSON.stringify(PRODUCT)), from(save, 409, JSON.stringify({ code: 'conflict' })), from(save, 502, 'x'), from(catalog, 304, '', { etag: 'W/"1"' })]) {
      assert.deepStrictEqual(Object.keys(o.meta), [...OUTCOME_META_MEMBERS]);
      if (!o.ok) assert.deepStrictEqual(Object.keys(o.error), [...OUTCOME_ERROR_MEMBERS]);
    }
  });
});

describe('client outcomes — every 02 taxonomy row is a tested failure outcome', () => {
  for (const [code, row] of Object.entries(HTTP_ERRORS)) {
    it(`${code} ${row.status} → kind failure, status and retryable from the wire`, () => {
      const body = { code, message: `m-${code}`, requestId: 'trace-x', retryable: row.retryable };
      const r = from(save, row.status, JSON.stringify(body));
      assert.strictEqual(r.ok, false);
      if (r.ok) return;
      assert.strictEqual(r.kind, 'failure');
      assert.strictEqual(r.error.code, code);
      assert.strictEqual(r.error.status, row.status);
      assert.strictEqual(r.error.message, `m-${code}`);
      assert.strictEqual(r.error.retryable, row.retryable);
      assert.strictEqual(r.error.details, null);
      assert.strictEqual(r.meta.trace, 'trace-1', 'the trace is the client\'s reading of x-jaren-trace, not the body');
    });
  }
});

/**
 * The §10.2 assembly table's test column: every backticked name in the
 * last column of the rows whose first cell is a status class.
 * @returns {string[]}
 */
function docAssemblyTests() {
  const md = readFileSync(FORMAT_DOC, 'utf8');
  const section = md.slice(md.indexOf('### §10.2'), md.indexOf('### §10.3'));
  const names = [];
  for (const m of section.matchAll(/^\|\s*(?:2xx|304|other|none)\s*\|(?:[^|]*\|){4}\s*`([^`]+)`\s*\|/gm)) names.push(m[1]);
  return names;
}

/**
 * The §10.3 client-code table: code → { kind, msgid, retryable }.
 * @returns {Record<string, { kind: string, msgid: string, retryable: string }>}
 */
function docClientCodes() {
  const md = readFileSync(FORMAT_DOC, 'utf8');
  /** @type {Record<string, { kind: string, msgid: string, retryable: string }>} */
  const rows = {};
  for (const m of md.matchAll(/^\|\s*`(JC205\d)`\s*\|\s*([^|]+?)\s*\|\s*`(contract\/[a-z-]+)`\s*\|\s*([^|]+?)\s*\|/gm)) {
    rows[m[1]] = { kind: m[2], msgid: m[3], retryable: m[4] };
  }
  return rows;
}

describe('client outcomes — the tables and the tests agree', () => {
  it('every row of the §10.2 assembly table names a test case that exists in the client test files', () => {
    const names = docAssemblyTests();
    assert.ok(names.length >= 15, `the table carries its rows (${names.length})`);
    // the pure rows live here; the transport rows (network, abort, pre-send) need a fetch and live beside the client
    const source = ['client-outcomes', 'client', 'client-idempotency']
      .map((f) => readFileSync(new URL(`./${f}.test.js`, THIS_FILE), 'utf8')).join('\n');
    for (const name of names) {
      assert.ok(source.includes(`it('${name}'`), `a test named '${name}' exists for its table row`);
    }
  });

  it('§10.3 client codes ⇔ CLIENT_ERRORS ⇔ CONTRACT_CODES ⇔ contractMessagesEn', () => {
    const doc = docClientCodes();
    assert.deepStrictEqual(Object.keys(doc).sort(), Object.keys(CLIENT_ERRORS).sort(), 'the doc lists exactly the client codes');
    for (const [code, row] of Object.entries(CLIENT_ERRORS)) {
      assert.strictEqual(doc[code].msgid, row.msgid, code);
      if (doc[code].retryable === 'yes' || doc[code].retryable === 'no') {
        assert.strictEqual(row.retryable, doc[code].retryable === 'yes', code);
      }
      assert.ok(Object.hasOwn(CONTRACT_CODES, code), `${code} in CONTRACT_CODES`);
      assert.ok(Object.hasOwn(contractMessagesEn, row.msgid), `${row.msgid} in the English catalog`);
    }
    const clientCodes = Object.keys(CONTRACT_CODES).filter((c) => /^JC20[5-6]\d$/.test(c));
    assert.deepStrictEqual(clientCodes.sort(), Object.keys(CLIENT_ERRORS).sort(), 'every JC2050–JC2069 of the code table is a client row');
  });
});

describe('client outcomes — invoke never rejects for a response', () => {
  it('every status × body shape resolves; only JC1005 throws', async () => {
    const responses = [];
    for (const status of [100, 200, 201, 204, 301, 304, 400, 404, 409, 418, 429, 500, 503]) {
      for (const text of ['', 'null', '{}', '[1]', '<html>', JSON.stringify(PRODUCT), JSON.stringify({ code: 'conflict' }), JSON.stringify({ code: 'JC2006' }), JSON.stringify({ code: 'zzz' }), JSON.stringify({ code: 5 })]) {
        responses.push([status, text]);
      }
    }
    let n = 0;
    const client = openHttpClient(shop, {
      fetch: async () => {
        const [status, text] = responses[n++];
        // a status the platform refuses in a Response (1xx, 204/304 with a body) still answers through the structural shape
        return { status, headers: new Headers({ 'x-jaren-trace': 't' }), text: async () => text };
      },
    });
    for (let i = 0; i < responses.length; i++) {
      const o = await client.invoke('product.save', { id: 1, revision: 1, product: PRODUCT });
      assert.strictEqual(isOutcome(o), true, `response ${responses[i]} → an outcome`);
    }
    assert.strictEqual(n, responses.length);
    await assert.rejects(client.invoke('nope', {}), (/** @type {any} */ err) => err.code === 'JC1005' && err instanceof TypeError);
    await assert.rejects(client.invoke('image.bytes', { id: 1 }), (/** @type {any} */ err) => err.code === 'JC1005' && /url/.test(err.message));
    // a response object the transport cannot have produced: status outside 100–599 → JC2053, still resolved
    const broken = openHttpClient(shop, { fetch: async () => ({ status: 0, headers: new Headers(), text: async () => '' }) });
    const o = await broken.invoke('catalog.load');
    if (!o.ok) assert.deepStrictEqual([o.kind, o.error.code], ['contract', 'JC2053']);
    const garbage = openHttpClient(shop, { fetch: async () => 'not a response' });
    const g = await garbage.invoke('catalog.load');
    assert.strictEqual(isOutcome(g), true);
  });
});
