//@ts-check
/**
 * @file Typing into the calculator, key by key, as a reader does: an
 * incomplete expression never shows a diagnostic while it is typed, `=`
 * closes the parentheses the function keys opened, a result starts or
 * continues the next expression, percent reads the way a desk calculator
 * reads it, and the panels show only what their mode uses.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { renderToString } from '@jarenjs/view';
import { compileMessageCatalog } from '@jarenjs/core/message';
import { de, fr } from '@jarenjs/locales';

import { MODE_BY_ID } from '@jarenjs/calc';
import { createCalcComponent, contributeCalcViewModel, calcInitialState, pressKeys, previewOf } from '@jarenjs/calc/component';

/** A headless calculator whose fetch always fails (fallback rates only). */
function calculator() {
  const component = createCalcComponent({ fetch: async () => ({ ok: false, status: 503 }) });
  return { component, app: component.createApp({ schedule: (/** @type {any} */ f) => f() }) };
}

/** The keypad key of `mode` a reader sees as `label` (the digit C, not Clear). */
function keyOf(/** @type {string} */ mode, /** @type {string} */ label) {
  for (const row of MODE_BY_ID[mode].keypad) {
    for (const key of row) if (key.label === label && key.k !== 'clear') return key.k;
  }
  throw new Error(`${mode} has no key '${label}'`);
}

/** Press keys by their labels; `AC` is Clear, `⌫` backspace, `=` equals. */
function press(/** @type {any} */ app, /** @type {string[]} */ labels) {
  const mode = app.getState().calc.mode;
  for (const label of labels) {
    if (label === 'AC') app.dispatch('calc/clear');
    else if (label === '=') app.dispatch('calc/equals');
    else if (label === '⌫') app.dispatch('calc/back');
    else app.dispatch('calc/key', { k: keyOf(mode, label) });
  }
  return contributeCalcViewModel(app.getState()).display;
}

/** A diagnostic that names parser internals: a position, a token, an expectation. */
const INTERNALS = /\(\d+:\d+\)|unexpected|expected|end of input/;

/** Run `labels` in `mode` (after `setup` keys) and answer the display. */
function run(/** @type {string} */ mode, /** @type {string[]} */ labels, /** @type {(app: any) => void} */ setup = () => {}) {
  const { app } = calculator();
  try {
    app.dispatch('calc/mode', { mode });
    setup(app);
    return press(app, labels);
  }
  finally { app.destroy(); }
}

describe('#calc entry: typing shows no diagnostic', () => {
  for (const labels of [['3', '+'], ['('], ['2', '×'], ['2', '×', '('], ['%'], ['^']]) {
    it(`standard ${labels.join(' ')}`, () => {
      const display = run('standard', labels);
      assert.equal(display.error, null, `${labels.join(' ')} shows ${display.error}`);
    });
  }
  it('scientific function keys while typing', () => {
    for (const fn of ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'ln', 'log', '√', 'eˣ']) {
      assert.equal(run('scientific', [fn]).error, null, fn);
      assert.equal(run('scientific', ['2', fn]).error, null, `2 ${fn}`);
    }
  });
});

describe('#calc entry: equals', () => {
  it('3 + 3 = is 6', () => assert.equal(run('standard', ['3', '+', '3', '=']).result, '6'));
  it('closes the parentheses the function keys opened', () => {
    const deg = (/** @type {any} */ app) => app.dispatch('calc/angle', { mode: 'deg' });
    assert.equal(run('scientific', ['sin', '3', '0', '='], deg).result, '0.5');
    assert.equal(run('scientific', ['√', '1', '6', '=']).result, '4');
    assert.equal(run('scientific', ['ln', 'e', '=']).result, '1');
    assert.equal(run('scientific', ['log', '1', '0', '0', '=']).result, '2');
    assert.equal(run('scientific', ['asin', '1', '='], deg).result, '90');
    assert.equal(run('standard', ['(', '2', '+', '3', '×', '4', '=']).result, '14');
  });
  it('a prefix key after an operand multiplies, so 2 eˣ 1 = is 2e', () => {
    assert.equal(run('scientific', ['2', 'eˣ', '1', '=']).result, '5.43656365692');
    assert.equal(run('scientific', ['2', 'π', '=']).result, '6.28318530718');
    assert.equal(run('scientific', ['(', '2', ')', '(', '3', '=']).result, '6');
  });
  it('an expression = cannot complete shows one short message, never parser internals', () => {
    for (const [mode, labels] of /** @type {Array<[string, string[]]>} */ ([
      ['standard', ['3', '+', '=']], ['standard', ['(', '=']], ['scientific', ['2', 'eˣ', '=']],
      ['programmer', ['0x', '=']], ['scientific', ['sin', '(', '=']],
    ])) {
      const display = run(mode, labels);
      assert.equal(display.error, 'Incomplete expression', `${mode} ${labels.join(' ')}`);
    }
    // a key with nothing to apply to writes nothing, so = has nothing to say
    assert.deepEqual(run('standard', ['%', '=']), { entry: '0', result: '', error: null });
  });
  it('a result outside the real numbers is a sentence', () => {
    const undefinedResult = run('scientific', ['√', '−', '4', '=']);
    assert.doesNotMatch(String(undefinedResult.error), INTERNALS);
    assert.match(String(undefinedResult.error), /real/i);
    assert.match(String(run('standard', ['1', '÷', '0', '=']).error), /infinite/i);
    assert.match(String(run('programmer', ['7', 'mod', '0', '=']).error), /zero/i);
  });
  it('after =, a digit or ans starts a new expression and an operator continues from the result', () => {
    assert.equal(run('standard', ['3', '=', 'ans', '+', '1', '=']).result, '4');
    assert.equal(run('standard', ['3', '=', '4', '=']).result, '4');
    assert.equal(run('standard', ['3', '=', '+', '1', '=']).result, '4');
    // the continuation is the exact result, not the rounded text the display shows
    assert.equal(run('standard', ['1', '÷', '3', '=', '×', '3', '=']).result, '1');
  });
  it('ignores a second point in one number and replaces an operator with the next', () => {
    assert.equal(run('standard', ['1', '.', '2', '.', '3', '=']).result, '1.23');
    assert.equal(run('standard', ['6', '+', '×', '2', '=']).result, '12');
    assert.equal(run('standard', ['6', '×', '−', '2', '=']).result, '-12');
  });
  it('Clear clears the expression, the result and the message', () => {
    const display = run('standard', ['2', '+', '3', '=', 'AC', '=']);
    assert.deepEqual(display, { entry: '0', result: '', error: null });
    assert.deepEqual(run('standard', ['3', '+', '=', 'AC']), { entry: '0', result: '', error: null });
  });
  it('percent reads as a desk calculator reads it', () => {
    assert.equal(run('standard', ['2', '0', '0', '+', '1', '0', '%', '=']).result, '220');
    assert.equal(run('standard', ['2', '0', '0', '−', '1', '0', '%', '=']).result, '180');
    assert.equal(run('standard', ['2', '0', '0', '×', '1', '0', '%', '=']).result, '20');
    assert.equal(run('standard', ['2', '0', '0', '÷', '1', '0', '%', '=']).result, '2,000');
    assert.equal(run('standard', ['5', '0', '%', '=']).result, '0.5');
  });
  it('formats a result with twelve significant digits and no padding zeros', () => {
    const setEntry = (/** @type {string} */ entry) => (/** @type {any} */ app) => app.dispatch('calc/set-entry', entry);
    assert.equal(run('standard', ['='], setEntry('1e20*999')).result, '9.99e+22');
    assert.equal(run('standard', ['='], setEntry('1234567890123456')).result, '1,234,567,890,123,456');
    assert.equal(run('standard', ['='], setEntry('1e-7')).result, '1e-7');
    assert.equal(run('standard', ['='], setEntry('123456.5*2')).result, '246,913');
  });
});

describe('#calc entry: a host-typed entry and a run of keys', () => {
  it('a function the environment lacks names itself, its parameter kept through the state', () => {
    const display = run('standard', ['='], (app) => app.dispatch('calc/set-entry', 'nope(1)'));
    assert.equal(display.error, "unknown function 'nope'");
  });
  it('a run of keys is typed whole: an argument separator stays one', () => {
    const { app } = calculator();
    try {
      app.dispatch('calc/mode', { mode: 'scientific' });
      app.dispatch('calc/key', { k: 'max(1,2)' });
      assert.equal(app.getState().calc.entry, 'max(1,2)');
      app.dispatch('calc/equals');
      assert.equal(app.getState().calc.ans, 2);
      app.dispatch('calc/key', { k: 'log(2,8' });
      app.dispatch('calc/equals');
      assert.equal(app.getState().calc.ans, 3);
    }
    finally { app.destroy(); }
  });
  it('or not at all: a run with a key that writes nothing changes nothing', () => {
    const { app } = calculator();
    try {
      app.dispatch('calc/key', { k: '7' });
      app.dispatch('calc/key', { k: '2*x' });
      assert.equal(app.getState().calc.entry, '7');
      app.dispatch('calc/key', { k: ',' });
      assert.equal(app.getState().calc.entry, '7', 'a comma outside a call writes nothing');
    }
    finally { app.destroy(); }
  });
});

describe('#calc entry: the pure editor', () => {
  it('pressKeys drives a slice without an app, a run of keys included', () => {
    const after = pressKeys(calcInitialState(), '2', '+', '3', 'equals');
    assert.deepEqual([after.ans, after.entry, after.fresh, after.tape.at(-1)], [5, '5', true, { expr: '2+3', result: '5' }]);
    const programmer = pressKeys({ ...calcInitialState(), mode: 'programmer', base: 'HEX' }, '0xff', '+1', 'equals');
    assert.deepEqual([programmer.ans, programmer.entry], [256, '0x100']);
    assert.equal(previewOf(pressKeys(calcInitialState(), '2', '*', '(', '3', '+')), '6');
  });
});

describe('#calc entry: results in the reader\'s separators', () => {
  it('groups and points as the reader\'s language does, and keeps the expression as typed', () => {
    const calc = pressKeys(calcInitialState(), '1', '2', '3', '4', '.', '5', '*', '3', 'equals');
    const english = contributeCalcViewModel({ calc });
    assert.deepEqual([english.display.result, english.tape[0].result], ['3,703.5', '3,703.5']);
    const german = contributeCalcViewModel({ calc }, { messages: compileMessageCatalog(de) });
    assert.deepEqual([german.display.result, german.tape[0].result, german.display.entry, german.tape[0].expr], ['3.703,5', '3.703,5', '3703,5', '1234,5*3']);
    assert.equal(calc.entry, '3703.5', 'the stored entry stays expression text');
    const french = contributeCalcViewModel({ calc: { ...calc, mode: 'financial' } }, { messages: compileMessageCatalog(fr) });
    assert.equal(french.financial.result, '-1\u202f199,10');
  });
  it('separates a function\'s arguments with ; where the point is a comma, and reads , . and ; as typed', () => {
    const calc = pressKeys({ ...calcInitialState(), mode: 'scientific' }, 'max(', '1', ',', '.', '5', ';', '2');
    assert.equal(calc.entry, 'max(1,0.5,2');
    const german = contributeCalcViewModel({ calc }, { messages: compileMessageCatalog(de) });
    assert.deepEqual([german.display.entry, german.display.result], ['max(1;0,5;2', '2']);
    assert.equal(contributeCalcViewModel({ calc }).display.entry, 'max(1,0.5,2');
  });
});

describe('#calc entry: programmer', () => {
  it('Clear is unambiguous: one key reads C, the hex digit', () => {
    const labels = MODE_BY_ID.programmer.keypad.flat().filter((/** @type {any} */ key) => key.label === 'C');
    assert.equal(labels.length, 1);
    assert.equal(labels[0].k, 'C');
  });
  it('a shift count is taken modulo the word size at every word size, and the page says so', () => {
    for (const bits of [8, 16, 32, 64]) {
      const at = (/** @type {string[]} */ keys) => run('programmer', keys, (app) => app.dispatch('calc/word', { bits })).result;
      const digits = (/** @type {number} */ n) => [...String(n)];
      assert.equal(at(['1', '«', ...digits(bits), '=']), '1', `${bits}: 1 « ${bits}`);
      assert.equal(at(['1', '«', ...digits(bits + 1), '=']), '2', `${bits}: 1 « ${bits + 1}`);
      assert.equal(at(['1', '«', ...digits(bits - 1), '=']), String(2n ** BigInt(bits - 1)), `${bits}: the top bit`);
      assert.equal(at(['2', '»', ...digits(bits + 1), '=']), '1', `${bits}: 2 » ${bits + 1}`);
      const { app } = calculator();
      try {
        app.dispatch('calc/mode', { mode: 'programmer' });
        app.dispatch('calc/word', { bits });
        assert.equal(contributeCalcViewModel(app.getState()).bases.shiftNote,
          `A shift count is taken modulo the word size, as in JavaScript: at ${bits}-bit, 1 « ${bits} is 1 and 1 « ${bits + 1} is 2.`);
        assert.match(renderToString(app.getVnode()), /A shift count is taken modulo the word size/);
      }
      finally { app.destroy(); }
    }
  });
  it('mod, xor, &, |, « and » are binary operators', () => {
    assert.equal(run('programmer', ['7', 'mod', '3', '=']).result, '1');
    assert.equal(run('programmer', ['5', 'xor', '3', '=']).result, '6');
    assert.equal(run('programmer', ['6', '&', '3', '=']).result, '2');
    assert.equal(run('programmer', ['6', '|', '3', '=']).result, '7');
    assert.equal(run('programmer', ['1', '«', '4', '=']).result, '16');
    assert.equal(run('programmer', ['1', '6', '»', '2', '=']).result, '4');
  });
});

describe('#calc layout: each mode shows its own panel', () => {
  for (const mode of ['financial', 'converter']) {
    it(`${mode} shows no keypad, memory row or display`, () => {
      const { app } = calculator();
      try {
        app.dispatch('calc/mode', { mode });
        const html = renderToString(app.getVnode());
        for (const cls of ['calc-keypad', 'calc-mem', 'calc-display']) assert.doesNotMatch(html, new RegExp(`class="${cls}"`), cls);
      }
      finally { app.destroy(); }
    });
  }
  it('the display is a polite live output', () => {
    const { app } = calculator();
    try {
      const html = renderToString(app.getVnode());
      assert.match(html, /<output[^>]*aria-live="polite"/);
    }
    finally { app.destroy(); }
  });
});
