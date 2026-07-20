import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderToString } from '@jarenjs/view';
import {
  createCalcComponent, calcInitialState, contributeCalcViewModel, calcActions,
} from '../../components/calc/src/component/index.js';

/** A component whose fetch always fails, so only the fallback table is used. */
function makeApp() {
  const comp = createCalcComponent({ fetch: async () => ({ ok: false, status: 503 }) });
  const app = comp.createApp({ schedule: (f) => f() });
  return { comp, app };
}

describe('#calc component: state + viewModel', function () {
  it('initial state is plain JSON', () => {
    const s = calcInitialState();
    assert.equal(s.mode, 'standard');
    assert.equal(s.entry, '');
    assert.ok(Array.isArray(s.tape));
    assert.equal(typeof s.rates.rates.USD, 'number');
  });

  it('viewModel derives display, keypad and plot without storing them', () => {
    const vm = contributeCalcViewModel({ calc: calcInitialState() });
    assert.equal(vm.mode, 'standard');
    assert.ok(vm.keypad.length > 0);
    assert.ok(vm.plot && Array.isArray(vm.plot.svg));   // a vnode
    assert.equal(vm.display.entry, '0');
  });
});

describe('#calc component: app integration (synchronous dispatch)', function () {
  it('renders keypad + display + plot through the view', () => {
    const { app } = makeApp();
    const html = renderToString(app.getVnode());
    assert.match(html, /calc-modes/);
    assert.match(html, /calc-display/);
    assert.match(html, /calc-keypad/);
    assert.match(html, /<svg/);
  });

  it('keypresses patch entry (COW) and equals commits to the tape', () => {
    const { app } = makeApp();
    app.dispatch('calc/key', { k: '2' });
    app.dispatch('calc/key', { k: '+' });
    app.dispatch('calc/key', { k: '3' });
    assert.equal(app.getState().calc.entry, '2+3');
    app.dispatch('calc/equals');
    const st = app.getState().calc;
    assert.equal(st.ans, 5);
    assert.equal(st.tape.length, 1);
    assert.equal(st.tape[0].result, '5');
  });

  it('backspace edits the entry', () => {
    const { app } = makeApp();
    app.dispatch('calc/key', { k: '1' });
    app.dispatch('calc/key', { k: '2' });
    app.dispatch('calc/back');
    assert.equal(app.getState().calc.entry, '1');
  });

  it('mode switch is a patch of $.calc.mode', () => {
    const { app } = makeApp();
    app.dispatch('calc/mode', { mode: 'programmer' });
    assert.equal(app.getState().calc.mode, 'programmer');
    const html = renderToString(app.getVnode());
    assert.match(html, /calc-bases/);
  });

  it('converter renders a result from the static fallback (no network)', () => {
    const { app } = makeApp();
    app.dispatch('calc/mode', { mode: 'converter' });
    const html = renderToString(app.getVnode());
    assert.match(html, /calc-converter/);
    const m = html.match(/calc-conv-result[^>]*><strong>([^<]*)</);
    assert.ok(m, 'a conversion result is shown');
    assert.ok(Number.parseFloat(m[1].replace(/,/g, '')) > 0);
  });

  it('converter swap exchanges from/to in one transition', () => {
    const { app } = makeApp();
    app.dispatch('calc/mode', { mode: 'converter' });
    const before = app.getState().calc.conv;
    app.dispatch('calc/conv-swap');
    const after = app.getState().calc.conv;
    assert.equal(after.from, before.to);
    assert.equal(after.to, before.from);
  });

  it('financial mode renders the @jarenjs/forms panel and a solved result', () => {
    const { app } = makeApp();
    app.dispatch('calc/mode', { mode: 'financial' });
    const html = renderToString(app.getVnode());
    assert.match(html, /jaren-form/);
    assert.match(html, /calc-fin-result/);
  });

  it('exposes the standard action set', () => {
    assert.ok('calc/key' in calcActions);
    assert.ok('calc/equals' in calcActions);
    assert.ok('calc/mode' in calcActions);
    assert.ok('calc-form/input' in calcActions);  // namespaced createFormActions
  });
});
