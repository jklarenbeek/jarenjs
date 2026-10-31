//@ts-check
/**
 * @file `multipleOf` is decided on the decimals the step and the value
 * spell — the shortest decimal that reads back as each — so a value is a
 * multiple exactly when the quotient of those decimals is a whole number,
 * at every magnitude, for a step the schema writes and for one a `$data`
 * reference reads from the instance. A fixed tolerance on the float
 * quotient took values far from any multiple under a large step
 * (`20000001` for `10000000`) and refused true multiples whose float
 * quotient drifted (`0.5` for `1e-15`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';

/** @param {number} step @param {number[]} values @param {object} [schema] */
const answers = (step, values, schema = {}) => {
  const validate = new JarenValidator().compile({ ...schema, multipleOf: step });
  return values.map((value) => validate(value));
};

/** The answers under a step a `$data` reference reads. @param {number} step @param {number[]} values */
const dataAnswers = (step, values) => {
  const validate = new JarenValidator().compile({ properties: { n: { multipleOf: { $data: '1/step' } } } });
  return values.map((n) => validate({ step, n }));
};

/**
 * The decimal `String(x)` spells for a finite number's magnitude, as an
 * integer over a power of ten.
 * @param {number} x
 */
function spelled(x) {
  const [mantissa, exponent = '0'] = String(Math.abs(x)).split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  let digits = whole + fraction;
  let scale = fraction.length - Number(exponent);
  if (scale < 0) {
    digits += '0'.repeat(-scale);
    scale = 0;
  }
  return { n: BigInt(digits), scale };
}

/** Exact decimal truth. @param {number} value @param {number} step */
function isMultiple(value, step) {
  const a = spelled(value);
  const b = spelled(step);
  const scale = Math.max(a.scale, b.scale);
  return (a.n * 10n ** BigInt(scale - a.scale)) % (b.n * 10n ** BigInt(scale - b.scale)) === 0n;
}

/** The double next to `x` away from zero, and toward it. @param {number} x */
function neighbours(x) {
  const bits = new BigInt64Array(new Float64Array([x]).buffer);
  const up = new Float64Array(new BigInt64Array([bits[0] + 1n]).buffer)[0];
  const down = new Float64Array(new BigInt64Array([bits[0] - 1n]).buffer)[0];
  return [up, down];
}

describe('multipleOf reads the decimals the step and the value spell', () => {
  it('refuses a value near no multiple under a large step (it took 5, 9 and 20000001 for 10000000)', () => {
    assert.deepEqual(answers(10000000, [5, 9, 20000001, 10000000, 20000000, 0, -10000000]), [false, false, false, true, true, true, true]);
    assert.deepEqual(answers(10000000, [9, 30000000], { type: 'integer' }), [false, true]);
  });

  it('reads a decimal step as written: 0.3 is a multiple of 0.1, 0.30000000000000004 is none (it took both)', () => {
    assert.deepEqual(answers(0.1, [0.3, 0.7, 1.1, 0.30000000000000004, 0.10000001]), [true, true, true, false, false]);
    assert.deepEqual(answers(0.01, [12.34, 19.99, 0.07, 1.005, 0.015]), [true, true, true, false, false]);
    assert.deepEqual(answers(1, [2, 1.0000005]), [true, false]);
    // a step's multiples are those of its magnitude
    assert.deepEqual(answers(-0.1, [0.3, -0.3, 0.30000000000000004]), [true, true, false]);
  });

  it('takes a multiple whose float quotient drifts (it refused 0.5 and 0.25 for 1e-15)', () => {
    assert.deepEqual(answers(1e-15, [0.5, 0.25, 1e-15, 1.5e-15]), [true, true, true, false]);
  });

  it('answers at every magnitude', () => {
    assert.deepEqual(answers(0.5, [1e308], { type: 'integer' }), [true]);
    assert.deepEqual(answers(0.123456789, [1e308], { type: 'integer' }), [false]);
    assert.deepEqual(answers(1e-8, [12391239123], { type: 'integer' }), [true]);
    // 1e308 spells a 1 and 308 zeros: no multiple of 3 (it took it)
    assert.deepEqual(answers(3, [1e308, 3e300, 2 ** 53]), [false, true, false]);
    // past a quotient of 1e15 a decimal still reads as it is spelled, not as its binary value
    assert.deepEqual(answers(0.1, [123456789012345.6, 123456789012345.66]), [true, false]);
  });

  it('reads a $data step alike', () => {
    assert.deepEqual(dataAnswers(10000000, [5, 20000001, 20000000]), [false, false, true]);
    assert.deepEqual(dataAnswers(0.1, [0.3, 0.30000000000000004]), [true, false]);
    assert.deepEqual(dataAnswers(1e-15, [0.5]), [true]);
  });

  it('agrees with exact decimal arithmetic on and next to the multiples of integer and decimal steps', () => {
    const steps = [1, 3, 7, 25, 10000000, 123456789, 1e12, 0.1, 0.01, 0.0001, 1e-8, 0.5, 2.5, 0.3, 1e-15, 1e-23, 1e21];
    const counts = [0, 1, 2, 7, 99, 12345, 1e6, 999999999999999, 1e15, 2 ** 53, 1e20];
    const extremes = [1e308, 1.7976931348623157e308, 5e-324, 2.2250738585072014e-308, 1e-300, 9007199254740991];
    const validator = new JarenValidator();
    const viaData = validator.compile({ properties: { n: { multipleOf: { $data: '1/step' } } } });
    /** @type {string[]} */
    const wrong = [];
    let checked = 0;
    for (const step of steps) {
      const validate = validator.compile({ multipleOf: step });
      const { n, scale } = spelled(step);
      const values = [...extremes];
      for (const count of counts) {
        const on = Number(`${BigInt(count) * n}e-${scale}`);
        if (Number.isFinite(on)) values.push(on, ...neighbours(on), on + step / 1e7);
      }
      for (const value of values.filter(Number.isFinite).flatMap((v) => [v, -v])) {
        checked++;
        const truth = value === 0 || isMultiple(value, step);
        if (validate(value) !== truth || viaData({ step, n: value }) !== truth)
          wrong.push(`multipleOf ${step}, ${value}: ${validate(value)}, $data ${viaData({ step, n: value })}, exact ${truth}`);
      }
    }
    assert.ok(checked > 1000);
    assert.deepEqual(wrong.slice(0, 5), []);
  });

  it('keeps the answers for a value or a $data step that is not finite, and for a $data step of zero', () => {
    assert.deepEqual(answers(2, [Infinity, -Infinity, NaN]), [false, false, false]);
    assert.deepEqual(dataAnswers(0, [0, 1]), [false, false]);
    assert.deepEqual(dataAnswers(Infinity, [1, Infinity]), [true, false]);
  });

  it('names the step in a collected error as before', () => {
    const result = /** @type {any} */ (new JarenValidator({ collectErrors: true }).compile({ multipleOf: 10000000 }))(15);
    assert.deepEqual(result.errors.map((/** @type {any} */ e) => [e.keyword, e.params, e.message]),
      [['multipleOf', { multipleOf: 10000000 }, 'must be multiple of 10000000']]);
    // beside a bound, each assertion reports its own fault
    const beside = /** @type {any} */ (new JarenValidator({ collectErrors: true }).compile({ minimum: 0, multipleOf: 10000000 }));
    assert.deepEqual([-15, 20000000, -20000000].map((value) => beside(value).errors.map((/** @type {any} */ e) => e.keyword)),
      [['minimum', 'multipleOf'], [], ['minimum']]);
  });
});
