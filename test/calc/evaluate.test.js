import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluate, programmerEnv, wordViews,
  solveTvm, buildAmortization, npvOf, irrOf,
  convertValue, unitOptions, converterDimensions,
} from '@jarenjs/calc';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !~= ${b}`);

describe('#calc standard/scientific evaluation', function () {
  it('arithmetic + precedence', () => {
    close(evaluate('2 + 3 * 4').value, 14);
    close(evaluate('(2 + 3) * 4').value, 20);
    close(evaluate('2 ^ 10').value, 1024);
    close(evaluate('10% + 1').value, 1.1);   // % is postfix percent
    close(evaluate('mod(10, 3)').value, 1);  // modulo is a function
    close(evaluate('5!').value, 120);
  });

  it('angle modes affect trig', () => {
    close(evaluate('sin(90)', { angleMode: 'deg' }).value, 1);
    close(evaluate('sin(pi/2)', { angleMode: 'rad' }).value, 1);
    close(evaluate('asin(1)', { angleMode: 'deg' }).value, 90);
  });

  it('constants and functions', () => {
    close(evaluate('pi').value, Math.PI);
    close(evaluate('e').value, Math.E);
    close(evaluate('log(2, 8)').value, 3);
    close(evaluate('sqrt(144)').value, 12);
    close(evaluate('hypot(3, 4)').value, 5);
  });

  it('plot variables resolve from scope', () => {
    close(evaluate('x^2 + y', { x: 3, y: 1 }).value, 10);
  });

  it('is error-safe (never throws)', () => {
    const r = evaluate('1 + )');
    assert.equal(r.ok, false);
    assert.ok(r.error.line !== undefined);
  });
});

describe('#calc programmer evaluation (word math)', function () {
  const env = programmerEnv();
  it('bitwise operators at word size', () => {
    close(evaluate('0xff & 0x0f', { wordBits: 32 }, { env }).value, 0x0f);
    close(evaluate('0x0f | 0xf0', { wordBits: 32 }, { env }).value, 0xff);
    close(evaluate('1 << 4', { wordBits: 32 }, { env }).value, 16);
    close(evaluate('xor(0xff, 0x0f)', { wordBits: 32 }, { env }).value, 0xf0);
  });

  it('two\'s-complement views by word size', () => {
    assert.deepEqual(wordViews(255, 8, false), { hex: 'FF', dec: '255', oct: '377', bin: '1111 1111' });
    assert.equal(wordViews(-1, 8, true).dec, '-1');
    assert.equal(wordViews(-1, 8, true).hex, 'FF');
    assert.equal(wordViews(256, 8, false).dec, '0');   // wraps
  });

  it('not is word-width aware', () => {
    close(evaluate('~0', { wordBits: 8 }, { env }).value, 255);
    close(evaluate('~0', { wordBits: 8, signed: true }, { env }).value, -1);
  });
});

describe('#calc financial orchestration (no formulas here)', function () {
  it('solve-for-unknown picks the right core function', () => {
    // 30y monthly mortgage, 6%/yr → 0.5%/mo
    close(solveTvm({ nper: 360, rate: 0.5, pv: 200000, fv: 0, solveFor: 'pmt' }).value ?? solveTvm({ nper: 360, rate: 0.5, pv: 200000, fv: 0, solveFor: 'pmt' }), -1199.10, 1e-2);
    const pay = solveTvm({ nper: 360, rate: 0.5, pv: 200000, fv: 0, solveFor: 'pmt' });
    close(solveTvm({ nper: 360, rate: 0.5, pmt: pay, fv: 0, solveFor: 'pv' }), 200000, 1e-2);
    close(solveTvm({ rate: 0.5, pv: 200000, pmt: pay, fv: 0, solveFor: 'nper' }), 360, 1e-4);
  });

  it('amortization + npv + irr delegate to core', () => {
    const rows = buildAmortization({ principal: 1000, rate: 1, nper: 12 });
    assert.equal(rows.length, 12);
    close(rows[rows.length - 1].balance, 0, 1e-6);
    close(npvOf(10, [-1000, 500, 400, 300, 100]), 78.8199, 1e-3);
    close(irrOf([-1000, 500, 400, 300, 100]), 14.48884, 1e-3);
  });
});

describe('#calc converter orchestration (no factors here)', function () {
  it('static dimensions', () => {
    close(convertValue('length', 1, 'km', 'm'), 1000);
    close(convertValue('temperature', 100, 'C', 'F'), 212);
    close(convertValue('data', 1, 'KiB', 'B'), 1024);
  });
  it('currency uses the injected rate table (no fetch)', () => {
    const rates = { base: 'USD', rates: { USD: 1, EUR: 1.1, BTC: 60000 } };
    close(convertValue('currency', 1, 'BTC', 'USD', rates), 60000);
    close(convertValue('currency', 100, 'USD', 'EUR', rates), 100 / 1.1, 1e-6);
  });
  it('dimensions include currency; unit options list codes', () => {
    assert.ok(converterDimensions().includes('currency'));
    assert.ok(converterDimensions().includes('length'));
    const codes = unitOptions('currency', { rates: { USD: 1, EUR: 1.1 } }).map((u) => u.id);
    assert.deepEqual(codes.sort(), ['EUR', 'USD']);
    assert.ok(unitOptions('length').some((u) => u.id === 'm'));
  });
  it('cross-dimension returns NaN, never throws', () => {
    assert.ok(Number.isNaN(convertValue('length', 1, 'kg', 'm')));
  });
});
