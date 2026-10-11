//@ts-check
/**
 * @file An annuity-due schedule (`type: 1`, payments at the start of each
 * period) takes its instalment from the due-annuity formula, so its rows must
 * accrue interest the way that formula does: the first row carries none, and
 * the last instalment equals the others. The rows used to accrue ordinary
 * interest, and the final row absorbed the difference (99.13 against 87.97).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { amortizationSchedule, pmt } from '@jarenjs/core/finance';

describe('amortizationSchedule — type 1', () => {
  const rows = amortizationSchedule(1000, 0.01, 12, { type: 1 });

  it('pays the due-annuity instalment in every period, the last included', () => {
    const instalment = -pmt(0.01, 12, 1000, 0, 1);
    for (const row of rows) assert.ok(Math.abs(row.payment - instalment) < 1e-9, `period ${row.period}: ${row.payment}`);
  });

  it('accrues nothing on the first row', () => {
    assert.strictEqual(rows[0].interest, 0);
    assert.ok(Math.abs(rows[0].principal - rows[0].payment) < 1e-12);
    assert.ok(Math.abs(rows[1].interest - rows[0].balance * 0.01) < 1e-12);
  });

  it('repays exactly the principal and ends at zero', () => {
    assert.strictEqual(rows.length, 12);
    assert.strictEqual(rows[11].balance, 0);
    assert.ok(Math.abs(rows.reduce((sum, row) => sum + row.principal, 0) - 1000) < 1e-9);
  });

  it('leaves the ordinary schedule as it was', () => {
    const ordinary = amortizationSchedule(1000, 0.01, 12);
    assert.strictEqual(ordinary[0].interest, 10);
    assert.strictEqual(ordinary[11].balance, 0);
    assert.deepStrictEqual(amortizationSchedule(1000, 0.01, 12, { type: 0 }), ordinary);
  });
});
