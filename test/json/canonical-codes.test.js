//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  canonicalizeJson,
  canonicalSha256,
  cloneJson,
  JsonCanonicalizeError,
  CANONICAL_CODES,
} from '@jarenjs/json/canonical';
import * as root from '@jarenjs/json';

const cyclic = {}; cyclic.self = cyclic;
const deep = (() => { let v = 0; for (let i = 0; i < 1001; i++) v = [v]; return v; })();

/** Each refusal kind: [input, code, dataPath, message], the message as before. */
const KINDS = /** @type {[any, string, string, string][]} */ ([
  [{ a: NaN }, 'JO2003', '/a', 'NaN is not a JSON number at /a'],
  [[1, -Infinity], 'JO2003', '/1', '-Infinity is not a JSON number at /1'],
  [{ a: undefined }, 'JO2004', '/a', 'undefined is not a JSON value at /a'],
  // eslint-disable-next-line no-sparse-arrays -- an array hole reads as undefined
  [[1, , 3], 'JO2004', '/1', 'undefined is not a JSON value at /1'],
  [{ n: 1n }, 'JO2005', '/n', 'a BigInt is not a JSON number at /n'],
  [{ f: () => 1 }, 'JO2006', '/f', 'a function is not a JSON value at /f'],
  [[Symbol('s')], 'JO2006', '/0', 'a symbol is not a JSON value at /0'],
  ['\ud800', 'JO2007', '', 'a string with an unpaired surrogate is not valid Unicode at the document root'],
  [{ '\udc00': 1 }, 'JO2007', '', 'a string with an unpaired surrogate is not valid Unicode at the document root'],
  [{ d: new Date(0) }, 'JO2008', '/d', 'a Date instance is not a JSON object at /d'],
  [new Map(), 'JO2008', '', 'a Map instance is not a JSON object at the document root'],
  [cyclic, 'JO2002', '/self', 'a circular reference cannot be canonicalized at /self'],
  [deep, 'JO2001', '/0'.repeat(1000), `a value nested deeper than 1000 levels cannot be canonicalized at ${'/0'.repeat(1000)}`],
]);

describe('canonicalizeJson refuses each kind of non-JSON data with its own code', () => {
  it('names the code and the data path; the message is unchanged', () => {
    for (const [input, code, dataPath, message] of KINDS) {
      assert.throws(() => canonicalizeJson(input), (e) => {
        assert.ok(e instanceof JsonCanonicalizeError && e instanceof TypeError, code);
        assert.deepStrictEqual([e.name, e.code, e.dataPath, e.message], ['JsonCanonicalizeError', code, dataPath, message]);
        return true;
      });
    }
  });

  it('cloneJson and canonicalSha256 carry the same codes', async () => {
    assert.throws(() => cloneJson({ a: NaN }), { code: 'JO2003', dataPath: '/a' });
    await assert.rejects(canonicalSha256({ d: new Set() }), { code: 'JO2008', dataPath: '/d' });
  });

  it('the cycle and depth codes are the ones equality and the walks raise', () => {
    assert.deepStrictEqual(Object.keys(CANONICAL_CODES),
      ['JO2001', 'JO2002', 'JO2003', 'JO2004', 'JO2005', 'JO2006', 'JO2007', 'JO2008']);
    assert.ok(Object.isFrozen(CANONICAL_CODES));
    assert.strictEqual(root.CANONICAL_CODES, CANONICAL_CODES);
  });

  it('the constructor keeps its two-argument form', () => {
    const e = new JsonCanonicalizeError('x is wrong', '/p');
    assert.deepStrictEqual([e.message, e.dataPath, e.code], ['x is wrong at /p', '/p', undefined]);
    assert.ok(e instanceof TypeError);
  });
});
