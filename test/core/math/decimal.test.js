import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  exactDecimal, shortestDecimal, shiftDecimal, roundDecimal, decimalToNumber, roundExact, multipleOfTester,
} from '@jarenjs/core/math';

describe('#decimal digits of a double', function () {
  it('exactDecimal carries every digit of the stored value', () => {
    assert.deepEqual(exactDecimal(1.005), { digits: '100499999999999989341858963598497211933135986328125', scale: 50 });
    assert.deepEqual(exactDecimal(0.5), { digits: '5', scale: 1 });
    assert.deepEqual(exactDecimal(-2.5), { digits: '25', scale: 1 });
    assert.deepEqual(exactDecimal(1e21), { digits: '1000000000000000000000', scale: 0 });
    assert.deepEqual(exactDecimal(0), { digits: '0', scale: 0 });
    const tiny = exactDecimal(Number.MIN_VALUE);
    assert.equal(tiny.scale, 1074);
    assert.ok(tiny.digits.startsWith('49406564584124654417656879286822137236505980'));
  });

  it('shortestDecimal carries the digits String(x) prints', () => {
    assert.deepEqual(shortestDecimal(1.005), { digits: '1005', scale: 3 });
    assert.deepEqual(shortestDecimal(-1500), { digits: '1500', scale: 0 });
    assert.deepEqual(shortestDecimal(1.5e-7), { digits: '15', scale: 8 });
    assert.deepEqual(shortestDecimal(1.5e21), { digits: '1500000000000000000000', scale: 0 });
    assert.deepEqual(shortestDecimal(0), { digits: '0', scale: 0 });
  });

  it('shiftDecimal multiplies by a power of ten without binary scaling', () => {
    assert.deepEqual(shiftDecimal({ digits: '1005', scale: 3 }, 2), { digits: '1005', scale: 1 });
    assert.deepEqual(shiftDecimal({ digits: '15', scale: 1 }, 3), { digits: '1500', scale: 0 });
    assert.deepEqual(shiftDecimal({ digits: '15', scale: 0 }, -2), { digits: '15', scale: 2 });
  });

  it('roundDecimal breaks an exact half the requested way', () => {
    const d = (digits, scale) => ({ digits, scale });
    assert.deepEqual(roundDecimal(d('25', 1), 0, 'half-up'), d('3', 0));
    assert.deepEqual(roundDecimal(d('25', 1), 0, 'half-down'), d('2', 0));
    assert.deepEqual(roundDecimal(d('25', 1), 0, 'half-even'), d('2', 0));
    assert.deepEqual(roundDecimal(d('35', 1), 0, 'half-even'), d('4', 0));
    assert.deepEqual(roundDecimal(d('251', 2), 0, 'half-down'), d('3', 0), 'past the half rounds up whatever the tie rule');
    assert.deepEqual(roundDecimal(d('1005', 3), 2, 'half-up'), d('101', 2));
    assert.deepEqual(roundDecimal(d('1234', 0), -2, 'half-up'), d('1200', 0));
    assert.deepEqual(roundDecimal(d('1250', 0), -2, 'half-even'), d('1200', 0));
    assert.deepEqual(roundDecimal(d('5', 0), -1, 'half-up'), d('10', 0));
    assert.deepEqual(roundDecimal(d('4', 0), -1, 'half-up'), d('0', 0));
    assert.deepEqual(roundDecimal(d('15', 1), 3, 'half-up'), d('15', 1), 'nothing to drop');
    assert.deepEqual(roundDecimal(d('1234', 0), -1e9, 'half-up'), d('0', 0), 'a far precision builds no padding');
  });

  it('decimalToNumber reads a decimal back as the nearest double', () => {
    assert.equal(decimalToNumber({ digits: '101', scale: 2 }, false), 1.01);
    assert.equal(decimalToNumber({ digits: '25', scale: 1 }, true), -2.5);
    assert.ok(Object.is(decimalToNumber({ digits: '0', scale: 0 }, true), -0));
  });
});

describe('#roundExact (F&O fn:round and fn:round-half-to-even)', function () {
  it('rounds the exact value, ties toward positive infinity', () => {
    assert.equal(roundExact(2.5), 3);
    assert.equal(roundExact(-2.5), -2);
    assert.equal(roundExact(-2.6), -3);
    assert.equal(roundExact(1.005, 2), 1, '1.005 is stored just below 1.005');
    assert.equal(roundExact(1.125, 2), 1.13, '1.125 is exact: a real tie');
    assert.equal(roundExact(-1.125, 2), -1.12);
    assert.equal(roundExact(1234.5678, -2), 1200);
    assert.equal(roundExact(5, -1), 10);
    assert.equal(roundExact(0.1 + 0.2, 1), 0.3);
  });

  it('half-even ties go to the even neighbour', () => {
    assert.equal(roundExact(2.5, 0, 'half-even'), 2);
    assert.equal(roundExact(3.5, 0, 'half-even'), 4);
    assert.equal(roundExact(-2.5, 0, 'half-even'), -2);
    assert.equal(roundExact(1.125, 2, 'half-even'), 1.12);
    assert.equal(roundExact(1250, -2, 'half-even'), 1200);
  });

  it('keeps the sign of a negative value that rounds to zero; passes NaN, infinities and zeros through', () => {
    assert.ok(Object.is(roundExact(-0.4), -0));
    assert.ok(Object.is(roundExact(-0.5), -0));
    assert.ok(Object.is(roundExact(-0), -0));
    assert.ok(Number.isNaN(roundExact(NaN)));
    assert.equal(roundExact(Infinity, 2), Infinity);
    assert.equal(roundExact(-Infinity), -Infinity);
  });

  it('a far precision either keeps the value or zeroes it', () => {
    assert.equal(roundExact(6, -2), 0, 'under a tenth of the unit');
    assert.ok(Object.is(roundExact(-6, -2), -0));
    assert.equal(roundExact(60, -2), 100, 'at least a tenth: compared with the half');
    assert.equal(roundExact(49, -2), 0);
    assert.equal(roundExact(1.5, 1e9), 1.5);
    assert.equal(roundExact(1234.5, -1e9), 0);
    assert.ok(Object.is(roundExact(-1234.5, -1e9), -0));
    assert.equal(roundExact(Number.MAX_VALUE, -400), 0);
    assert.equal(roundExact(Number.MIN_VALUE, 1074), Number.MIN_VALUE);
  });
});

describe('#multipleOfTester (multipleOf on the decimals both numbers spell)', function () {
  /** @param {number} step @param {number[]} values */
  const answers = (step, values) => values.map(multipleOfTester(step));

  it('reads a step and a value as the decimals they spell', () => {
    assert.deepEqual(answers(0.1, [0.3, 0.7, 0.30000000000000004, 0.10000001]), [true, true, false, false]);
    assert.deepEqual(answers(10000000, [5, 20000001, 20000000, -10000000, 0, -0]), [false, false, true, true, true, true]);
    // a step's multiples are those of its magnitude
    assert.deepEqual(answers(-0.1, [0.3, -0.3, 0.30000000000000004]), [true, true, false]);
    // a true multiple whose float quotient drifts
    assert.deepEqual(answers(1e-15, [0.5, 0.25, 1.5e-15]), [true, true, false]);
  });

  it('answers exactly at every magnitude', () => {
    // every whole number is a multiple of 0.5; 1e308 spells a 1 and 308 zeros, no multiple of 3
    assert.deepEqual(answers(0.5, [1e308, 7]), [true, true]);
    assert.deepEqual(answers(3, [1e308, 3e300, 9007199254740990, 9007199254740991]), [false, true, true, false]);
    // past 2^53 a whole value is read as it is spelled, not by its float quotient
    assert.deepEqual(answers(3, [29999999999999990, 30000000000000000]), [false, true]);
    assert.deepEqual(answers(7, [69999999999999980]), [false]);
    // past a quotient of 1e15, and under a step finer than 1e-22
    assert.deepEqual(answers(0.1, [123456789012345.6, 123456789012345.66]), [true, false]);
    assert.deepEqual(answers(1e-23, [0.5, 1e-22, 1.5e-23]), [true, true, false]);
  });

  it('takes no value that is not finite, and reads a step that is not finite, or zero, by its quotient', () => {
    assert.deepEqual(answers(2, [Infinity, -Infinity, NaN]), [false, false, false]);
    assert.deepEqual(answers(Infinity, [5, -1e308, Infinity]), [true, true, false]);
    assert.deepEqual(answers(0, [0, 1]), [false, false]);
    assert.deepEqual(answers(NaN, [1]), [false]);
  });
});
