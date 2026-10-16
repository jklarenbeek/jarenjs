//@ts-check
/**
 * @file `@jarenjs/contract/auth-node`: an HS256 bearer token verifies
 * only as HS256 — whatever its header claims — with the host's clock
 * and leeway, an optional audience and issuer, and a constant-time
 * signature comparison; every refusal is coded. `hmacSha256Matches`
 * compares a presented request signature in constant time. The RFC 7515
 * Appendix A vectors are vendored under fixtures/jws-rfc7515.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createHmac } from 'node:crypto';

import { ContractRuntimeError, ContractHostError } from '@jarenjs/contract';
import { verifyHs256Token, hmacSha256Matches } from '@jarenjs/contract/auth-node';
import { load } from './helpers.js';

const RFC = load('./fixtures/jws-rfc7515/vectors.json');
const RFC_KEY = Buffer.from(RFC.hs256.key, 'base64url');
const RFC_EXP_MS = RFC.hs256.claims.exp * 1000;

const KEY = new TextEncoder().encode('an hs256 secret of thirty-two by');
const NOW = 1_800_000_000_000;
const SEC = NOW / 1000;

/** @param {unknown} value */
const segment = (value) => Buffer.from(value instanceof Uint8Array ? value : typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

/**
 * Mint a compact token; `alg` in the header is whatever the test writes,
 * the signature is always HMAC-SHA256 under `key`.
 * @param {unknown} header @param {unknown} payload @param {Uint8Array} [key]
 */
function mint(header, payload, key = KEY) {
  const input = `${segment(header)}.${segment(payload)}`;
  return `${input}.${createHmac('sha256', key).update(input).digest('base64url')}`;
}

/** @param {() => unknown} run @param {string} code */
function refuses(run, code) {
  assert.throws(run, (/** @type {any} */ e) => {
    assert.ok(e instanceof ContractRuntimeError, `a ContractRuntimeError, got ${e?.name}: ${e?.message}`);
    assert.strictEqual(e.code, code);
    assert.strictEqual(e.status, 401);
    assert.strictEqual(e.retryable, false);
    return true;
  });
}

/** @param {() => unknown} run */
function hostError(run) {
  assert.throws(run, (/** @type {any} */ e) => e instanceof ContractHostError && e.code === 'JC1016');
}

describe('verifyHs256Token: RFC 7515 Appendix A', () => {
  it('A.1 verifies before its exp and answers its claims', () => {
    assert.deepStrictEqual({ ...verifyHs256Token(RFC.hs256.token, { key: RFC_KEY, now: RFC_EXP_MS - 1 }) }, RFC.hs256.claims);
  });

  it('A.1 is expired at exactly exp, and within the leeway still valid', () => {
    refuses(() => verifyHs256Token(RFC.hs256.token, { key: RFC_KEY, now: RFC_EXP_MS }), 'JC2143');
    assert.strictEqual(verifyHs256Token(RFC.hs256.token, { key: RFC_KEY, now: RFC_EXP_MS + 29_999, leewayMs: 30_000 }).iss, 'joe');
    refuses(() => verifyHs256Token(RFC.hs256.token, { key: RFC_KEY, now: RFC_EXP_MS + 30_000, leewayMs: 30_000 }), 'JC2143');
  });

  it('A.5, the unsecured JWS (alg none, empty signature), is refused as an algorithm', () => {
    refuses(() => verifyHs256Token(RFC.unsecured.token, { key: RFC_KEY, now: RFC_EXP_MS - 1 }), 'JC2141');
  });

  it('A.1 with one payload byte changed and the original signature is a signature mismatch', () => {
    const [h, p, s] = RFC.hs256.token.split('.');
    const tampered = Buffer.from(p, 'base64url').toString().replace('"joe"', '"eve"');
    refuses(() => verifyHs256Token(`${h}.${segment(tampered)}.${s}`, { key: RFC_KEY, now: RFC_EXP_MS - 1 }), 'JC2142');
  });
});

describe('verifyHs256Token: the algorithm is never the header\'s choice', () => {
  const claims = { sub: 'u1', exp: SEC + 60 };
  for (const header of [{ alg: 'none' }, { alg: 'HS384' }, { alg: 'RS256' }, { alg: 'hs256' }, { typ: 'JWT' }, { alg: 'HS256', crit: ['exp'] }]) {
    it(`header ${JSON.stringify(header)} is refused JC2141 even when its HMAC-SHA256 signature is right`, () => {
      refuses(() => verifyHs256Token(mint(header, claims), { key: KEY, now: NOW }), 'JC2141');
    });
  }

  it('an alg none token with an empty signature is refused JC2141, never accepted', () => {
    refuses(() => verifyHs256Token(`${segment({ alg: 'none' })}.${segment(claims)}.`, { key: KEY, now: NOW }), 'JC2141');
  });

  it('a token signed under another key is a signature mismatch', () => {
    refuses(() => verifyHs256Token(mint({ alg: 'HS256' }, claims, new Uint8Array(32)), { key: KEY, now: NOW }), 'JC2142');
  });

  it('a signature of another length is a signature mismatch, never a crash', () => {
    const [h, p] = mint({ alg: 'HS256' }, claims).split('.');
    refuses(() => verifyHs256Token(`${h}.${p}.${Buffer.alloc(31).toString('base64url')}`, { key: KEY, now: NOW }), 'JC2142');
    refuses(() => verifyHs256Token(`${h}.${p}.${Buffer.alloc(48).toString('base64url')}`, { key: KEY, now: NOW }), 'JC2142');
  });
});

describe('verifyHs256Token: the claims and the host clock', () => {
  it('answers the claims of a valid token; typ is not required', () => {
    const claims = verifyHs256Token(mint({ alg: 'HS256' }, { sub: 'u1', exp: SEC + 60, role: 'staff' }), { key: KEY, now: NOW });
    assert.deepStrictEqual({ ...claims }, { sub: 'u1', exp: SEC + 60, role: 'staff' });
  });

  it('now may be a clock function', () => {
    assert.strictEqual(verifyHs256Token(mint({ alg: 'HS256' }, { exp: SEC + 1 }), { key: KEY, now: () => NOW }).exp, SEC + 1);
  });

  it('exp is required and numeric', () => {
    refuses(() => verifyHs256Token(mint({ alg: 'HS256' }, { sub: 'u1' }), { key: KEY, now: NOW }), 'JC2140');
    refuses(() => verifyHs256Token(mint({ alg: 'HS256' }, { exp: String(SEC + 60) }), { key: KEY, now: NOW }), 'JC2140');
  });

  it('nbf: not yet valid before it, valid inside the leeway', () => {
    const token = mint({ alg: 'HS256' }, { exp: SEC + 600, nbf: SEC + 30 });
    refuses(() => verifyHs256Token(token, { key: KEY, now: NOW }), 'JC2144');
    refuses(() => verifyHs256Token(token, { key: KEY, now: NOW, leewayMs: 29_999 }), 'JC2144');
    assert.strictEqual(verifyHs256Token(token, { key: KEY, now: NOW, leewayMs: 30_000 }).nbf, SEC + 30);
    refuses(() => verifyHs256Token(mint({ alg: 'HS256' }, { exp: SEC + 600, nbf: 'soon' }), { key: KEY, now: NOW }), 'JC2140');
  });

  it('audience: a string or a list member must match; issuer must equal', () => {
    const one = mint({ alg: 'HS256' }, { exp: SEC + 60, aud: 'authenticated', iss: 'https://id.example' });
    const list = mint({ alg: 'HS256' }, { exp: SEC + 60, aud: ['other', 'authenticated'] });
    assert.strictEqual(verifyHs256Token(one, { key: KEY, now: NOW, audience: 'authenticated', issuer: 'https://id.example' }).iss, 'https://id.example');
    assert.ok(verifyHs256Token(list, { key: KEY, now: NOW, audience: 'authenticated' }));
    refuses(() => verifyHs256Token(one, { key: KEY, now: NOW, audience: 'service' }), 'JC2145');
    refuses(() => verifyHs256Token(list, { key: KEY, now: NOW, audience: 'service' }), 'JC2145');
    refuses(() => verifyHs256Token(mint({ alg: 'HS256' }, { exp: SEC + 60 }), { key: KEY, now: NOW, audience: 'authenticated' }), 'JC2145');
    refuses(() => verifyHs256Token(one, { key: KEY, now: NOW, issuer: 'https://other.example' }), 'JC2145');
  });
});

describe('verifyHs256Token: malformed tokens and host options', () => {
  const good = mint({ alg: 'HS256' }, { exp: SEC + 60 });
  const [h, p, s] = good.split('.');

  for (const [name, token] of /** @type {[string, unknown][]} */ ([
    ['two parts', `${h}.${p}`], ['four parts', `${good}.${s}`], ['not a string', 42], ['an empty string', ''],
    ['padded base64url', `${h}=.${p}.${s}`], ['standard base64', `${h}.${p}.${s.replace(/-/g, '+').replace(/_/g, '/')}+`],
    ['a header that is an array', mint([], { exp: SEC + 60 })], ['a header that is not JSON', `${segment('{alg')}.${p}.${s}`],
    ['a payload that is not an object', mint({ alg: 'HS256' }, [1])], ['a payload that is not UTF-8', mint({ alg: 'HS256' }, new Uint8Array([0x7b, 0xff, 0x7d]))],
  ])) {
    it(`${name} is malformed (JC2140)`, () => refuses(() => verifyHs256Token(/** @type {any} */ (token), { key: KEY, now: NOW }), 'JC2140'));
  }

  it('a signature spelled with nonzero trailing bits decodes to the same MAC and is still malformed (JC2140): one token, one spelling', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const malleated = s.slice(0, -1) + alphabet[alphabet.indexOf(s.at(-1)) | 1];
    assert.deepStrictEqual(Buffer.from(malleated, 'base64url'), Buffer.from(s, 'base64url'));
    refuses(() => verifyHs256Token(`${h}.${p}.${malleated}`, { key: KEY, now: NOW }), 'JC2140');
  });

  it('a token over 16384 characters is refused before decoding (JC2146)', () => {
    refuses(() => verifyHs256Token(mint({ alg: 'HS256' }, { exp: SEC + 60, pad: 'x'.repeat(12_300) }), { key: KEY, now: NOW }), 'JC2146');
  });

  it('a key shorter than 32 bytes, or not bytes, is the host\'s error (JC1016)', () => {
    const short = new Uint8Array(31);
    hostError(() => verifyHs256Token(mint({ alg: 'HS256' }, { exp: SEC + 60 }, short), { key: short, now: NOW }));
    hostError(() => verifyHs256Token(good, { key: /** @type {any} */ ('an hs256 secret of thirty-two by'), now: NOW }));
  });

  it('a missing or malformed clock, leeway, audience or issuer is the host\'s error (JC1016)', () => {
    for (const options of [{ key: KEY }, { key: KEY, now: -1 }, { key: KEY, now: () => 'x' }, { key: KEY, now: NOW, leewayMs: -1 },
      { key: KEY, now: NOW, leewayMs: 0.5 }, { key: KEY, now: NOW, audience: 7 }, { key: KEY, now: NOW, issuer: '' }, { key: KEY, now: NOW, kid: 'x' }]) {
      hostError(() => verifyHs256Token(good, /** @type {any} */ (options)));
    }
    hostError(() => verifyHs256Token(good, /** @type {any} */ (null)));
    hostError(() => verifyHs256Token(good, { key: KEY, now: () => { throw new Error('clock offline'); } }));
  });
});

describe('hmacSha256Matches', () => {
  const parts = ['POST', '\n', '/hooks?x=1', '\n', new Uint8Array([0, 255])];
  const expected = createHmac('sha256', KEY).update('POST\n/hooks?x=1\n').update(new Uint8Array([0, 255])).digest();

  it('matches the HMAC-SHA256 of the concatenated parts, strings as UTF-8', () => {
    assert.strictEqual(hmacSha256Matches(KEY, parts, expected), true);
    assert.strictEqual(hmacSha256Matches(KEY, 'é', createHmac('sha256', KEY).update('é', 'utf8').digest()), true);
    assert.strictEqual(hmacSha256Matches(KEY, new Uint8Array([1]), createHmac('sha256', KEY).update(new Uint8Array([1])).digest()), true);
  });

  it('a changed bit, another length or an empty signature is false, never a throw', () => {
    const flipped = Uint8Array.from(expected);
    flipped[31] ^= 1;
    assert.strictEqual(hmacSha256Matches(KEY, parts, flipped), false);
    assert.strictEqual(hmacSha256Matches(KEY, parts, expected.subarray(0, 31)), false);
    assert.strictEqual(hmacSha256Matches(KEY, parts, new Uint8Array(0)), false);
  });

  it('a short key, a non-byte signature or a malformed message is the host\'s error (JC1016)', () => {
    hostError(() => hmacSha256Matches(new Uint8Array(31), parts, expected));
    hostError(() => hmacSha256Matches(KEY, parts, /** @type {any} */ (expected.toString('hex'))));
    hostError(() => hmacSha256Matches(KEY, /** @type {any} */ ([1]), expected));
    hostError(() => hmacSha256Matches(KEY, /** @type {any} */ (null), expected));
  });
});
