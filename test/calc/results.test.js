//@ts-check
/**
 * What the calculator keeps after a result and what a plot axis lays down.
 *
 * Pressing `=` on a result that is not a finite number (`1/0`, `0/0`, or any
 * programmer-mode value with no word) used to leave the display text as the
 * entry, and `∞`, `-∞` and `—` are not expressions: the next live
 * evaluation reported a parse error under a result the user had just read.
 * A refreshed rate table used to replace the stored one wholesale, so the
 * converter went on printing `rates: idle` under live rates. And a plot
 * axis whose step is smaller than the spacing of doubles at its position
 * (a domain near 1e16) never advanced, growing its tick array until the
 * engine refused to allocate it.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { evaluate, buildScene2d } from '@jarenjs/calc';
import {
  calcEditEffects, createCalcComponent, contributeCalcViewModel,
} from '../../components/calc/src/component/index.js';

/**
 * Run the `=` effect and return what it dispatches: the committed result,
 * or the entry kept with the message id of why it has none.
 * @param {string} entry @param {any} props
 * @returns {any}
 */
function commit(entry, props) {
  /** @type {any[]} */
  const seen = [];
  calcEditEffects['calc-eval']({ entry, base: 'DEC', mode: 'standard', angleMode: 'rad', ...props },
    (name, payload) => seen.push([name, payload]));
  assert.equal(seen.length, 1);
  return seen[0][1];
}

describe('#calc a result with no finite value leaves an entry that still evaluates', function () {
  it('standard mode keeps the expression the user typed and says why it has no result', () => {
    for (const [expr, error] of [['1/0', 'calc/display/infinite'], ['-1/0', 'calc/display/infinite'], ['0/0', 'calc/display/not-real']]) {
      const kept = commit(expr, { mode: 'standard' });
      assert.equal(kept.kind, 'entry', expr);
      assert.equal(kept.error, error, expr);
      assert.equal(kept.entry, expr, expr);
      assert.equal(evaluate(kept.entry).ok, true, expr);
    }
  });

  it('programmer mode keeps the expression instead of the em dash it displays', () => {
    for (const base of ['DEC', 'HEX']) {
      const kept = commit('1/0', { mode: 'programmer', base, wordBits: 8, signed: false });
      assert.equal(kept.entry, '1/0', base);
      assert.equal(kept.error, 'calc/display/no-result', base);
      assert.equal(evaluate(kept.entry).ok, true, base);
    }
  });

  it('a finite result still becomes the next entry', () => {
    assert.equal(commit('1/4', { mode: 'standard' }).entry, '0.25');
    assert.equal(commit('0xF+1', { mode: 'programmer', wordBits: 8, signed: false, base: 'HEX' }).entry, '0x10');
  });

  it('the display says why there is no result, and the next key dismisses it', () => {
    const comp = createCalcComponent({ fetch: async () => ({ ok: false, status: 503 }) });
    const app = comp.createApp({ schedule: (f) => f() });
    try {
      app.dispatch('calc/key', { k: '1/0' });
      app.dispatch('calc/equals');
      const vm = contributeCalcViewModel(app.getState());
      assert.equal(vm.display.error, 'The result is infinite: a division by zero or a number too large');
      assert.equal(vm.display.entry, '1÷0');
      assert.equal(vm.display.result, '');
      assert.equal(app.getState().calc.tape.length, 0);
      app.dispatch('calc/key', { k: '+' });
      assert.equal(contributeCalcViewModel(app.getState()).display.error, null);
    }
    finally { app.destroy(); }
  });
});

describe('#calc a fetched rate table is reported as live', function () {
  it('a successful refresh sets the status and clears the stale flag', async () => {
    const body = { bitcoin: { usd: 60000, eur: 55000 } };
    const comp = createCalcComponent({
      fetch: async () => ({ ok: true, status: 200, json: async () => body }),
      codes: ['USD', 'EUR', 'BTC'],
    });
    const app = comp.createApp({ schedule: (f) => f() });
    try {
      app.dispatch('calc/mode', { mode: 'converter' });
      assert.equal(contributeCalcViewModel(app.getState()).converter.rates.status, 'fallback');
      assert.equal(contributeCalcViewModel(app.getState()).converter.rates.stale, true);
      app.dispatch('calc/rates-ok', { base: 'USD', rates: { USD: 1, EUR: 2 }, at: 5 });
      const rates = contributeCalcViewModel(app.getState()).converter.rates;
      assert.deepEqual([rates.status, rates.stale, rates.at, rates.count], ['ok', false, 5, 2]);
      app.dispatch('calc/rates-err');
      assert.equal(contributeCalcViewModel(app.getState()).converter.rates.status, 'error');
      app.dispatch('calc/rates-ok', { base: 'USD', rates: { USD: 1 }, at: 6 });
      assert.equal(contributeCalcViewModel(app.getState()).converter.rates.status, 'ok');
    }
    finally { app.destroy(); }
  });
});

describe('#calc plot axes stay bounded where doubles are sparse', function () {
  it('a domain narrower than the spacing of doubles lays one tick, not billions', () => {
    const scene = buildScene2d('x', { domain: [1e16, 1e16 + 8] });
    assert.deepEqual(scene.xticks.map((t) => t.value), [1e16]);
  });

  it('an ordinary domain keeps its ticks', () => {
    const scene = buildScene2d('x', { domain: [0, 10] });
    assert.deepEqual(scene.xticks.map((t) => t.value), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});
