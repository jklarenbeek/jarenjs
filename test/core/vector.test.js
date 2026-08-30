//@ts-check
/**
 * @file `@jarenjs/core/vector` — the properties every caller of the
 * kernels relies on: similarities answer higher-is-better and agree
 * with each other; a malformed comparison scores 0 and never throws;
 * the packed form round-trips exactly and unpacks from any alignment.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  isVector, dotProduct, cosineSimilarity, euclideanSimilarity, l2Normalize,
  packVector, unpackVector,
} from '@jarenjs/core/vector';
import { mulberry32 } from '@jarenjs/core/random';

/** `actual` within `tol` of `expected`, with a message that names the case. */
const near = (actual, expected, tol, what) =>
  assert.ok(Math.abs(actual - expected) <= tol,
    `${what}: ${actual} is not within ${tol} of ${expected}`);

/** A deterministic vector in [-1, 1) — seeded, so every run sees the same numbers. */
function seeded(dims, seed) {
  const random = mulberry32(seed);
  return Array.from({ length: dims }, () => random() * 2 - 1);
}

const MALFORMED = [
  ['mismatched lengths', [1, 2, 3], [1, 2]],
  ['empty', [], []],
  ['one empty', [1], []],
  ['a NaN component', [1, NaN], [1, 2]],
  ['an Infinity component', [Infinity, 1], [1, 1]],
  ['null', null, [1, 2]],
  ['undefined', [1, 2], undefined],
  ['a NaN in a Float32Array', new Float32Array([NaN, 1]), new Float32Array([1, 1])],
];

describe('vector — the similarity kernels', function () {
  it('score a vector against itself as the maximum, for arrays and typed arrays alike', function () {
    for (const a of [[3, 4], seeded(384, 1), Float32Array.from(seeded(64, 2)), Float64Array.from(seeded(8, 3))]) {
      near(cosineSimilarity(a, a), 1, 1e-12, 'cosine(a, a)');
      assert.strictEqual(euclideanSimilarity(a, a), 1, 'euclidean(a, a) is exactly 1');
      let squared = 0;
      for (let i = 0; i < a.length; i++) squared += a[i] * a[i];
      near(dotProduct(a, a), squared, 1e-9 * squared, 'dot(a, a) = |a|²');
    }
  });

  it('are symmetric', function () {
    const a = seeded(96, 4);
    const b = seeded(96, 5);
    assert.strictEqual(dotProduct(a, b), dotProduct(b, a));
    assert.strictEqual(cosineSimilarity(a, b), cosineSimilarity(b, a));
    assert.strictEqual(euclideanSimilarity(a, b), euclideanSimilarity(b, a));
  });

  it('answer higher-is-better in every metric, within their documented ranges', function () {
    assert.strictEqual(cosineSimilarity([1, 0], [1, 0]), 1);
    assert.strictEqual(cosineSimilarity([1, 0], [0, 1]), 0, 'orthogonal');
    assert.strictEqual(cosineSimilarity([1, 0], [-2, 0]), -1, 'opposite');
    near(cosineSimilarity([1, 2], [2, 4]), 1, 1e-12, 'scale-free: the same direction is 1 at any length');
    // a closer vector scores higher under every kernel
    const q = [1, 1, 0];
    const close = [1, 0.9, 0.1];
    const far = [-1, 0, 1];
    assert.ok(cosineSimilarity(q, close) > cosineSimilarity(q, far));
    assert.ok(euclideanSimilarity(q, close) > euclideanSimilarity(q, far));
    assert.ok(dotProduct(q, close) > dotProduct(q, far));
    // euclidean is 1 / (1 + d): distance 3 → 0.25
    assert.strictEqual(euclideanSimilarity([0, 0], [3, 0]), 0.25);
    // and cosine is clamped to its interval even when rounding overshoots
    const v = seeded(1000, 6);
    const c = cosineSimilarity(v, v);
    assert.ok(c <= 1 && c >= -1);
  });

  it('agree: the dot product of two unit vectors is their cosine', function () {
    for (let seed = 10; seed < 16; seed++) {
      const a = seeded(128, seed);
      const b = seeded(128, seed + 100);
      const ua = l2Normalize(a);
      const ub = l2Normalize(b);
      assert.ok(ua !== null && ub !== null);
      // binary32 storage costs ~1e-7 per component; the agreement is to 1e-6
      near(dotProduct(ua, ub), cosineSimilarity(a, b), 1e-6, `seed ${seed}`);
      // and the normalized form is unit length
      near(Math.sqrt(dotProduct(ua, ua)), 1, 1e-6, 'unit length');
    }
  });

  it('score a malformed comparison 0 and never throw — one bad vector loses, it does not kill the sweep', function () {
    for (const [what, a, b] of MALFORMED) {
      for (const [name, kernel] of [['dot', dotProduct], ['cosine', cosineSimilarity], ['euclidean', euclideanSimilarity]]) {
        let score;
        assert.doesNotThrow(() => { score = kernel(/** @type {any} */ (a), /** @type {any} */ (b)); }, `${name} over ${what} must not throw`);
        assert.strictEqual(score, 0, `${name} over ${what} scores 0`);
      }
    }
    // a vector with no direction has no cosine: 0, not NaN
    assert.strictEqual(cosineSimilarity([0, 0], [1, 1]), 0);
    // an overflowing product is not a finite answer either
    assert.strictEqual(dotProduct([1e200, 1e200], [1e200, 1e200]), 0);
  });
});

describe('vector — the shape guard', function () {
  it('accepts plain arrays and float typed arrays of finite numbers, optionally of an exact width', function () {
    assert.strictEqual(isVector([0.1, 0.2, 0.3]), true);
    assert.strictEqual(isVector(new Float32Array([0.1, 0.2])), true);
    assert.strictEqual(isVector(new Float64Array([0.1, 0.2])), true);
    assert.strictEqual(isVector([0.1, 0.2, 0.3], 3), true);
    assert.strictEqual(isVector([0.1, 0.2, 0.3], 4), false, 'wrong width');
    assert.strictEqual(isVector([-0, 0, 1e-45], 3), true, 'zeros and denormals are finite');
  });

  it('refuses everything that is not a vector', function () {
    for (const bad of [[], [NaN], [1, Infinity], [1, '2'], [1, null], null, undefined, 'abc', 42, {}, { length: 2, 0: 1, 1: 2 },
      new Uint8Array([1, 2, 3, 4]), new Int32Array([1, 2]), new BigInt64Array([1n])]) {
      assert.strictEqual(isVector(bad), false, `refuses ${String(bad && bad.constructor && bad.constructor.name)} ${JSON.stringify(bad, (k, v) => typeof v === 'bigint' ? 'bigint' : v)}`);
    }
  });
});

describe('vector — normalization', function () {
  it('returns a new unit-length Float32Array and leaves the input alone', function () {
    const a = [3, 4];
    const u = l2Normalize(a);
    assert.ok(u instanceof Float32Array);
    assert.deepStrictEqual(a, [3, 4], 'input untouched');
    assert.deepStrictEqual(Array.from(/** @type {Float32Array} */ (u)), [Math.fround(0.6), Math.fround(0.8)]);
    // a typed-array input is copied too, never returned as itself
    const f = new Float32Array([0, 2]);
    const uf = l2Normalize(f);
    assert.notStrictEqual(uf, f);
    assert.deepStrictEqual(Array.from(/** @type {Float32Array} */ (uf)), [0, 1]);
  });

  it('keeps the zero vector zero, and refuses what is not a vector with null', function () {
    assert.deepStrictEqual(Array.from(/** @type {Float32Array} */ (l2Normalize([0, 0, 0]))), [0, 0, 0]);
    assert.strictEqual(l2Normalize([]), null);
    assert.strictEqual(l2Normalize([1, NaN]), null);
    assert.strictEqual(l2Normalize(null), null);
    assert.strictEqual(l2Normalize(/** @type {any} */ ('abc')), null);
    assert.strictEqual(l2Normalize([1e200, 1e200]), null, 'a norm that overflows is not a direction');
  });
});

describe('vector — the packed form', function () {
  const SAMPLES = [
    [1], [-2], [0.1, 0.2, 0.3], [1 / 3, -1 / 7, 2 / 9], [3.4028235e38, -3.4028235e38, 1e-45, 1.17549435e-38],
    seeded(384, 42), seeded(768, 43), seeded(7, 44),
  ];

  it('is 4·d bytes of little-endian binary32', function () {
    assert.deepStrictEqual(Array.from(/** @type {Uint8Array} */ (packVector([1]))), [0, 0, 0x80, 0x3f]);
    assert.deepStrictEqual(Array.from(/** @type {Uint8Array} */ (packVector([-2]))), [0, 0, 0, 0xc0]);
    assert.deepStrictEqual(Array.from(/** @type {Uint8Array} */ (packVector([1, 0.5]))), [0, 0, 0x80, 0x3f, 0, 0, 0, 0x3f]);
    for (const v of SAMPLES) {
      const bytes = packVector(v);
      assert.ok(bytes instanceof Uint8Array);
      assert.strictEqual(bytes.byteLength, v.length * 4);
    }
  });

  it('round-trips exactly: every component comes back as its Math.fround', function () {
    for (const v of SAMPLES) {
      const bytes = /** @type {Uint8Array} */ (packVector(v));
      const back = unpackVector(bytes, v.length);
      assert.ok(back instanceof Float32Array);
      assert.deepStrictEqual(back, Float32Array.from(v));
      for (let i = 0; i < v.length; i++) assert.strictEqual(back[i], Math.fround(v[i]));
    }
    // typed-array inputs pack the same bytes as their plain twins
    const plain = seeded(16, 7);
    assert.deepStrictEqual(packVector(Float32Array.from(plain)), packVector(plain));
    assert.deepStrictEqual(packVector(Float64Array.from(plain)), packVector(plain));
    // and a negative zero survives as itself
    assert.ok(Object.is(/** @type {Float32Array} */ (unpackVector(/** @type {Uint8Array} */ (packVector([-0])), 1))[0], -0));
  });

  it('refuses to pack what is not a vector, and to unpack the wrong number of bytes', function () {
    assert.strictEqual(packVector([]), null);
    assert.strictEqual(packVector([1, NaN]), null);
    assert.strictEqual(packVector([1, Infinity]), null);
    assert.strictEqual(packVector(null), null);
    assert.strictEqual(packVector(/** @type {any} */ (new Uint8Array(4))), null, 'bytes are not a vector');
    // a finite double with no finite binary32 nearest it: packing it
    // would answer bytes that unpack to Infinity — a vector `isVector`
    // refuses, made out of one it accepted, with nothing said about it
    assert.strictEqual(packVector([1e39, 0]), null, 'a component that overflows binary32');
    assert.strictEqual(packVector([1, -3.5e38]), null);
    assert.notStrictEqual(packVector([3.4e38]), null, 'the largest binary32 still packs');

    const bytes = /** @type {Uint8Array} */ (packVector([1, 2, 3]));
    assert.strictEqual(unpackVector(bytes, 2), null, 'too many bytes for the width');
    assert.strictEqual(unpackVector(bytes, 4), null, 'too few');
    assert.strictEqual(unpackVector(bytes, 0), null);
    assert.strictEqual(unpackVector(bytes, 1.5), null);
    assert.strictEqual(unpackVector(bytes.subarray(0, 11), 3), null, 'a truncated record is refused, never partially read');
    assert.strictEqual(unpackVector(null, 3), null);
    assert.strictEqual(unpackVector(/** @type {any} */ (bytes.buffer), 3), null, 'a bare ArrayBuffer is not the packed form');
    assert.strictEqual(unpackVector(/** @type {any} */ ([0, 0, 128, 63]), 1), null);
  });

  it('unpacks aligned bytes as a view over the same buffer — the fetch-and-rank path is paid for by this', function () {
    const v = seeded(384, 9);
    const bytes = /** @type {Uint8Array} */ (packVector(v));
    const back = /** @type {Float32Array} */ (unpackVector(bytes, 384));
    assert.strictEqual(back.buffer, bytes.buffer, 'no copy on the aligned path');
    assert.strictEqual(back.byteOffset, 0);
    // an aligned slice of a larger record is still a view
    const record = new Uint8Array(8 + bytes.byteLength);
    record.set(bytes, 8);
    const sliced = /** @type {Float32Array} */ (unpackVector(record.subarray(8), 384));
    assert.strictEqual(sliced.buffer, record.buffer);
    assert.deepStrictEqual(sliced, Float32Array.from(v));
  });

  it('unpacks a deliberately misaligned view through the copy path, to the same values', function () {
    // alignment is an observation about one driver today, not a contract:
    // a pooled allocation or an odd offset into a record hands over bytes
    // a Float32Array cannot be laid over, and the kernel must still answer
    const v = seeded(384, 11);
    const bytes = /** @type {Uint8Array} */ (packVector(v));
    const expected = Float32Array.from(v);
    for (const offset of [1, 2, 3, 5]) {
      const holder = new Uint8Array(offset + bytes.byteLength);
      holder.set(bytes, offset);
      const view = holder.subarray(offset);
      assert.strictEqual(view.byteOffset % 4 === 0, false, `offset ${offset} is misaligned`);
      const back = unpackVector(view, 384);
      assert.ok(back instanceof Float32Array, `offset ${offset} unpacks`);
      assert.deepStrictEqual(back, expected, `offset ${offset} answers the same values`);
      assert.notStrictEqual(back.buffer, holder.buffer, `offset ${offset} took the copy path`);
    }
  });

  it('unpacks bytes that arrive as a Node Buffer, whatever the pool gave them for an offset', function () {
    const v = seeded(32, 12);
    const bytes = /** @type {Uint8Array} */ (packVector(v));
    // Buffer.from(Uint8Array) copies into the shared pool; the offset is
    // whatever the pool happens to be at — aligned or not, the answer holds
    const pooled = Buffer.from(bytes);
    assert.deepStrictEqual(unpackVector(pooled, 32), Float32Array.from(v));
    const odd = Buffer.concat([Buffer.from([0xff]), Buffer.from(bytes)]).subarray(1);
    assert.deepStrictEqual(unpackVector(odd, 32), Float32Array.from(v));
  });

  it('composes with normalization: the stored form is the unit vector, packed', function () {
    const v = seeded(384, 13);
    const stored = packVector(l2Normalize(v));
    assert.ok(stored instanceof Uint8Array);
    const back = /** @type {Float32Array} */ (unpackVector(stored, 384));
    near(Math.sqrt(dotProduct(back, back)), 1, 1e-6, 'unit length survives the round trip');
    near(cosineSimilarity(back, v), 1, 1e-6, 'and the direction is the original');
    // a refused vector refuses all the way down the chain, never a partial record
    assert.strictEqual(packVector(l2Normalize([1, NaN])), null);
  });
});
