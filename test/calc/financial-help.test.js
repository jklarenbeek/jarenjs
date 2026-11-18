//@ts-check
/**
 * @file The financial panel explains itself: what time value of money is,
 * what each field means, why an answer has its sign, and four worked
 * examples one click fills in. Every example's answer is checked against
 * the closed-form time-value-of-money formulas written here, not against
 * the solver under test.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { renderToString } from '@jarenjs/view';

import { createCalcComponent, contributeCalcViewModel } from '@jarenjs/calc/component';

/** Two decimals, thousands grouped: the amount as the panel shows it. */
function money(/** @type {number} */ value) {
  const [whole, fraction] = Math.abs(value).toFixed(2).split('.');
  return `${value < 0 ? '-' : ''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
}

/** Closed-form TVM, payments at the end of each period, i a fraction. */
const TVM = {
  pmt: (/** @type {any} */ x) => { const g = (1 + x.i) ** x.nper; return -(x.pv * g + x.fv) * x.i / (g - 1); },
  fv: (/** @type {any} */ x) => { const g = (1 + x.i) ** x.nper; return -(x.pv * g + x.pmt * (g - 1) / x.i); },
  nper: (/** @type {any} */ x) => Math.log((x.pmt - x.fv * x.i) / (x.pmt + x.pv * x.i)) / Math.log(1 + x.i),
  // with no payments: PV·(1+i)^N + FV = 0, in percent per period
  rate: (/** @type {any} */ x) => ((-x.fv / x.pv) ** (1 / x.nper) - 1) * 100,
};

function calculator() {
  const app = createCalcComponent({ fetch: async () => ({ ok: false, status: 503 }) }).createApp({ schedule: (/** @type {any} */ f) => f() });
  app.dispatch('calc/mode', { mode: 'financial' });
  return app;
}

describe('#calc financial: worked examples', () => {
  it('offers the mortgage, savings, payoff and return examples, each filling every field', () => {
    const app = calculator();
    try {
      const examples = contributeCalcViewModel(app.getState()).financial.examples;
      assert.deepEqual(examples.map((/** @type {any} */ e) => e.key), ['mortgage', 'savings', 'payoff', 'return']);
      const expected = {
        mortgage: '-1,199.10',
        savings: money(TVM.fv({ i: 0.0025, nper: 120, pv: 0, pmt: -200 })),
        payoff: money(TVM.nper({ i: 0.01, pmt: -300, pv: 10000, fv: 0 })),
        return: money(TVM.rate({ nper: 10, pv: -1000, fv: 2000 })),
      };
      assert.equal(money(TVM.pmt({ i: 0.005, nper: 360, pv: 200000, fv: 0 })), expected.mortgage);
      for (const example of examples) {
        app.dispatch('calc/fin-example', example.on.click.with);
        const vm = contributeCalcViewModel(app.getState()).financial;
        assert.equal(vm.solveFor, example.on.click.with.solveFor, example.key);
        assert.equal(vm.result, expected[/** @type {keyof typeof expected} */ (example.key)], example.key);
        assert.equal(vm.noSolution, null, example.key);
        assert.ok(example.text.length > 20 && !/\{/.test(example.text), `${example.key} explains itself: ${example.text}`);
      }
      assert.equal(expected.savings, '27,948.28');
      assert.equal(expected.payoff, '40.75');
      assert.equal(expected.return, '7.18');
    }
    finally { app.destroy(); }
  });

  it('shows the solved field as the answer, read-only, and the four others editable', () => {
    const app = calculator();
    try {
      const fields = contributeCalcViewModel(app.getState()).financial.form.children;
      const solved = fields.find((/** @type {any} */ f) => f.key === 'pmt');
      assert.equal(solved.readOnly, true);
      assert.equal(solved.value, -1199.1);
      for (const key of ['nper', 'rate', 'pv', 'fv']) assert.equal(fields.find((/** @type {any} */ f) => f.key === key).readOnly, false, key);
      const html = renderToString(app.getVnode());
      assert.match(html, /<input type="number" value="-1199.1"[^>]*readonly/);
    }
    finally { app.destroy(); }
  });

  it('says when the values have no solution', () => {
    const app = calculator();
    try {
      // 1% a month on 1,000 is 10 of interest: a payment of 1 never pays it off
      app.dispatch('calc/fin-example', { nper: 0, rate: 1, pv: 1000, pmt: -1, fv: 0, solveFor: 'nper' });
      const vm = contributeCalcViewModel(app.getState()).financial;
      assert.equal(vm.result, '—');
      assert.match(vm.noSolution, /opposite signs/);
    }
    finally { app.destroy(); }
  });
});

describe('#calc financial: help', () => {
  it('explains the panel, each field, the sign of the answer and the formula', () => {
    const app = calculator();
    try {
      const html = renderToString(app.getVnode());
      for (const text of [
        'Time value of money: an amount today is worth more',
        'Enter four of the five values',
        '6% a year paid monthly is 6 ÷ 12 = 0.5',
        'How many periods: years × periods per year.',
        'The interest rate per period, in percent',
        'Signs follow the money',
        'Borrowing 200,000 (PV) at 6% a year over 30 years costs 1,199.10 a month, so the answer is PMT = −1,199.10.',
        'How it works:',
        'PMT (payment)',
        'Result (PMT (payment)): ',
      ]) assert.ok(html.includes(text), text);
    }
    finally { app.destroy(); }
  });
});
