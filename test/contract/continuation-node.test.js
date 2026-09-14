//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { sealContinuation, openContinuation } from '@jarenjs/contract/continuation-node';
import { compileContract } from '@jarenjs/contract';
import scalar from '@jarenjs/contract/schemas/continuation.schema.json' with { type: 'json' };
import { qualifyContinuation } from '../consumer/continuation.js';

const key = new Uint8Array(32).fill(7);
const cursor = { order: [{ column: 'age', desc: false }], keys: [20], key: 'u1' };
const scope = { tenant: 'one', subject: 'reader' };
const common = { scope, query: 'users:age:v1', order: cursor.order, now: 1000 };
const sealing = { ...common, keyId: 'current', key, expiresAt: 2000 };
const opening = { ...common, getKey: id => id === 'current' ? key : null };
const token = sealContinuation(cursor, sealing);
const original = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
function signedBytes(bytes) {
  const payload = Buffer.from(bytes).toString('base64url');
  const mac = createHmac('sha256', key).update('jaren-continuation\0jc1.' + payload).digest('base64url');
  return `jc1.${payload}.${mac}`;
}
const rewritten = fields => signedBytes(JSON.stringify({ ...original, ...fields }));
const refuses = (code, body) => assert.throws(body, { code });

describe('optional Node continuations', () => {
  it('is deterministic, rotates explicit lookup keys and has an exact validity interval', () => {
    assert.equal(token, signedBytes('{"alg":"HS256","cursor":{"key":"u1","keys":[20],"order":[{"column":"age","desc":false}]},"exp":2000,"iat":1000,"kid":"current","order":[{"column":"age","desc":false}],"query":"users:age:v1","scope":{"subject":"reader","tenant":"one"},"v":1}'));
    assert.equal(sealContinuation({ key: 'u1', keys: [20], order: cursor.order }, {
      ...sealing, scope: { subject: 'reader', tenant: 'one' }, now: () => 1000,
    }), token);
    assert.deepEqual(openContinuation(token, opening), cursor);
    assert.deepEqual(openContinuation(token, { ...opening, now: () => 1999 }), cursor);
    refuses('JC2123', () => openContinuation(token, { ...opening, now: 999 }));
    refuses('JC2123', () => openContinuation(token, { ...opening, now: 2000 }));
    const nextKey = new Uint8Array(32).fill(8);
    const rotated = sealContinuation(cursor, { ...sealing, key: nextKey, keyId: 'next' });
    const getKey = id => ({ current: key, next: nextKey })[id];
    assert.deepEqual(openContinuation(token, { ...opening, getKey }), cursor);
    assert.deepEqual(openContinuation(rotated, { ...opening, getKey }), cursor);
    refuses('JC2122', () => openContinuation(token, { ...opening, getKey: () => undefined }));
  });

  it('rejects modified payloads/signatures and wrong or unknown keys before a Store is queried', () => {
    const parts = token.split('.');
    parts[1] = Buffer.from(JSON.stringify({ ...original, cursor: { key: 'admin' } })).toString('base64url');
    refuses('JC2122', () => openContinuation(parts.join('.'), opening));
    const badTag = token.slice(0, -43) + (token.at(-43) === 'A' ? 'B' : 'A') + token.slice(-42);
    refuses('JC2122', () => openContinuation(badTag, opening));
    refuses('JC2122', () => openContinuation(token, { ...opening, getKey: () => new Uint8Array(32) }));
    refuses('JC2122', () => openContinuation(token, { ...opening, getKey: () => null }));
    for (const change of [{ scope: { ...scope, tenant: 'two' } }, { scope: { ...scope, subject: 'other' } },
      { query: 'users:age:v2' }, { order: [...cursor.order, { column: 'id' }] }])
      refuses('JC2124', () => openContinuation(token, { ...opening, ...change }));
  });

  it('refuses malformed encodings, UTF-8, duplicate members, versions, algorithms and shapes', () => {
    for (const invalid of [null, '', 'jc2.' + token.slice(4), token + '.', token + '\n',
      token.replace('jc1.', 'jc1.=')]) refuses('JC2120', () => openContinuation(invalid, opening));
    for (const invalid of [signedBytes([0xff]), signedBytes('{'), signedBytes('{}'),
      signedBytes('\ufeff' + JSON.stringify(original)),
      signedBytes(JSON.stringify(original).replace('"v":1', '"v":1,"v":1')),
      signedBytes(JSON.stringify(original, null, 2)),
      rewritten({ v: 2 }), rewritten({ alg: 'none' }), rewritten({ extra: 1 }),
      rewritten({ cursor: null }), rewritten({ order: null }), rewritten({ query: '' }),
      rewritten({ iat: -1 }), rewritten({ exp: 1000 }), rewritten({ kid: 'bad\n' })])
      refuses('JC2120', () => openContinuation(invalid, opening));
    const parts = token.split('.');
    parts[1] += 'A';
    // Malformed/noncanonical base64 never becomes a valid continuation.
    assert.throws(() => openContinuation(parts.join('.'), opening));
  });

  it('bounds wire, decoded JSON, depth and member work without partial output', () => {
    refuses('JC2121', () => openContinuation('a'.repeat(16385), opening));
    refuses('JC2121', () => openContinuation(token, { ...opening, maxBytes: 256 }));
    refuses('JC2121', () => sealContinuation({ key: 'a'.repeat(16385) }, sealing));
    refuses('JC2121', () => sealContinuation({ key: '\u0001'.repeat(3000) }, sealing));
    refuses('JC2121', () => sealContinuation({ key: 'é'.repeat(10000) }, sealing));
    refuses('JC2121', () => sealContinuation({ key: 'a'.repeat(13000) }, sealing));
    refuses('JC2121', () => sealContinuation({ keys: Array(2049).fill(0) }, sealing));
    refuses('JC2121', () => sealContinuation({ keys: Array(1100).fill(0) }, sealing));
    let nested = {};
    for (let i = 0; i < 33; i++) nested = { child: nested };
    refuses('JC2121', () => sealContinuation(nested, sealing));
    refuses('JC2121', () => openContinuation(rewritten({ cursor: nested }), opening));
  });

  it('rejects invalid host data/keys and never reads accessors or uses a hidden clock', () => {
    for (const invalid of ['', new Uint8Array(0), new Uint8Array(31), new Uint8Array(1025), null])
      refuses('JC1014', () => sealContinuation(cursor, { ...sealing, key: invalid }));
    for (const options of [null, { ...sealing, now: undefined }, { ...sealing, now: NaN },
      { ...sealing, now: () => { throw new Error('clock'); } }, { ...sealing, expiresAt: 1000 },
      { ...sealing, keyId: '' }, { ...sealing, keyId: 'x\n' }, { ...sealing, query: '' },
      { ...sealing, query: 'x'.repeat(257) }, { ...sealing, order: {} }, { ...sealing, scope: undefined },
      { ...sealing, maxBytes: null }, { ...sealing, maxBytes: 255 }, { ...sealing, maxBytes: 16385 }])
      refuses('JC1014', () => sealContinuation(cursor, options));
    const cycle = {}; cycle.self = cycle;
    for (const invalid of [null, [], new Date(), { key: undefined }, { key: 1n }, { key: NaN },
      { key: '\ud800' }, { key: new Date() }, { keys: Array(1) }, cycle,
      { get key() { return assert.fail('accessor was read'); } }])
      refuses('JC1014', () => sealContinuation(invalid, sealing));
    refuses('JC1014', () => openContinuation(token, { ...opening, getKey: null }));
    refuses('JC1014', () => openContinuation(token, { ...opening, getKey: () => '' }));
    refuses('JC1014', () => openContinuation(token, { ...opening, getKey: () => { throw new Error('lookup'); } }));
    const prior = Date.now;
    try { Date.now = () => { throw new Error('hidden clock'); }; assert.deepEqual(openContinuation(token, opening), cursor); }
    finally { Date.now = prior; }
  });

  it('exposes the bounded scalar through ordinary contract $defs', () => {
    const contract = compileContract({ $contract: '0.1', $defs: { Continuation: scalar }, operations: {
      'users.page': { kind: 'read', input: { type: 'object', required: ['after'], properties: {
        after: { $ref: '#/$defs/Continuation' },
      } }, output: true },
    } });
    const validate = contract.operations['users.page'].input.validate;
    assert.equal(validate({ after: token }).valid, true);
    for (const after of [token + '\n', 'x'.repeat(16385), '', {}, 'jc2.' + token.slice(4)])
      assert.equal(validate({ after }).valid, false);
  });

  it('round-trips public Store pages while preserving JD0035', qualifyContinuation);
});
