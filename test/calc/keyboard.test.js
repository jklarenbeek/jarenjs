//@ts-check
/**
 * @file Typing on the calculator: each physical key presses the keypad key
 * it stands for while focus is in the keypad region, and the listener leaves
 * alone what is not the calculator's (Tab, Space on a button, shortcuts,
 * the panels' form fields, the modes without a keypad).
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { createCalcComponent, calcKeyOf, bindCalcKeyboard } from '@jarenjs/calc/component';

/**
 * A DOM-shaped stand-in: an element inside or outside the keypad region, a
 * `BUTTON` when `tagName` says so, and inside the keypad grid when `inKeypad`.
 */
function element(/** @type {boolean} */ inPad, /** @type {any} */ doc = { activeElement: null }, /** @type {string} */ tagName = 'DIV', inKeypad = false) {
  const pad = { ownerDocument: doc, focused: 0, contains: (/** @type {any} */ el) => el === pad || el?.inPad === true, focus() { this.focused++; doc.activeElement = pad; } };
  const closest = (/** @type {string} */ selector) => (selector === '.calc-pad' && inPad ? pad : selector === '.calc-keypad' && inKeypad ? {} : null);
  return { inPad, pad, tagName, closest };
}

/** An event target that records its listeners. */
function root() {
  /** @type {Record<string, Function[]>} */
  const listeners = {};
  return {
    listeners,
    addEventListener(/** @type {string} */ type, /** @type {Function} */ fn) { (listeners[type] ??= []).push(fn); },
    removeEventListener(/** @type {string} */ type, /** @type {Function} */ fn) { listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn); },
    fire(/** @type {string} */ type, /** @type {any} */ event) { for (const fn of listeners[type] ?? []) fn(event); },
  };
}

/** A keydown event: whether its default was prevented is recorded. */
function keydown(/** @type {string} */ key, /** @type {any} */ target, /** @type {any} */ extra = {}) {
  return { type: 'keydown', key, target, prevented: false, preventDefault() { this.prevented = true; }, ...extra };
}

describe('#calc keyboard: the key a physical key stands for', () => {
  it('maps digits, operators and commands in every keypad mode', () => {
    for (const mode of ['standard', 'scientific', 'programmer']) {
      assert.equal(calcKeyOf('7', mode), '7', mode);
      assert.equal(calcKeyOf('+', mode), '+', mode);
      assert.equal(calcKeyOf('Enter', mode), 'equals', mode);
      assert.equal(calcKeyOf('=', mode), 'equals', mode);
      assert.equal(calcKeyOf('Backspace', mode), 'back', mode);
      assert.equal(calcKeyOf('Escape', mode), 'clear', mode);
      assert.equal(calcKeyOf('Tab', mode), null, mode);
      assert.equal(calcKeyOf(' ', mode), null, mode);
    }
    assert.equal(calcKeyOf('.', 'standard'), '.');
    assert.equal(calcKeyOf(',', 'standard'), '.');
    assert.equal(calcKeyOf('%', 'standard'), '%');
    assert.equal(calcKeyOf('^', 'standard'), '^');
    assert.equal(calcKeyOf('e', 'scientific'), 'e');
    assert.equal(calcKeyOf('!', 'scientific'), '!');
    assert.equal(calcKeyOf('!', 'standard'), null, 'standard has no factorial key');
  });
  it('a letter a-f is a hex digit and % is mod in the programmer mode', () => {
    assert.equal(calcKeyOf('c', 'programmer'), 'C');
    assert.equal(calcKeyOf('F', 'programmer'), 'F');
    assert.equal(calcKeyOf('%', 'programmer'), 'mod');
    assert.equal(calcKeyOf('<', 'programmer'), '<<');
    assert.equal(calcKeyOf('>', 'programmer'), '>>');
    assert.equal(calcKeyOf('.', 'programmer'), null, 'whole numbers only');
    assert.equal(calcKeyOf('g', 'programmer'), null);
    assert.equal(calcKeyOf('c', 'standard'), null);
  });
  it('the modes without a keypad take no key', () => {
    for (const mode of ['financial', 'converter', 'nope']) assert.equal(calcKeyOf('7', mode), null, mode);
  });
});

describe('#calc keyboard: the host listener', () => {
  /** A calculator app with the listener on a stand-in document. */
  function setup(/** @type {string} */ mode = 'standard') {
    const app = createCalcComponent({ fetch: async () => ({ ok: false, status: 503 }) }).createApp({ schedule: (/** @type {any} */ f) => f() });
    app.dispatch('calc/mode', { mode });
    const doc = root();
    const unbind = bindCalcKeyboard(doc, app);
    const type = (/** @type {string[]} */ keys, /** @type {any} */ target = element(true)) => keys.map((key) => {
      const event = keydown(key, target);
      doc.fire('keydown', event);
      return event;
    });
    return { app, doc, unbind, type };
  }

  it('typing 7*6 Enter evaluates', () => {
    const { app, type } = setup();
    try {
      const events = type(['7', '*', '6', 'Enter']);
      assert.equal(app.getState().calc.ans, 42);
      assert.ok(events.every((e) => e.prevented), 'a key the calculator takes does not also do its browser default');
    }
    finally { app.destroy(); }
  });
  it('Enter on a focused keypad button evaluates once and does not press the button', () => {
    const { app, type } = setup();
    try {
      const button = element(true, undefined, 'BUTTON', true);
      type(['2', '+', '3']);
      const [enter] = type(['Enter'], button);
      assert.equal(enter.prevented, true, 'the button is not activated by the same Enter');
      assert.deepEqual(app.getState().calc.tape.map((/** @type {any} */ row) => row.result), ['5']);
    }
    finally { app.destroy(); }
  });
  it('Enter on a button of the region that is no keypad key presses that button', () => {
    const { app, type } = setup('scientific');
    try {
      type(['2', '+', '3']);
      const [enter] = type(['Enter'], element(true, undefined, 'BUTTON', false));
      assert.equal(enter.prevented, false, 'the angle toggle takes its own Enter');
      assert.equal(app.getState().calc.tape.length, 0);
      const [typed] = type(['4'], element(true, undefined, 'BUTTON', false));
      assert.equal(typed.prevented, true, 'a digit still types');
      assert.equal(app.getState().calc.entry, '2+34');
    }
    finally { app.destroy(); }
  });
  it('leaves Tab, Space and every shortcut alone', () => {
    const { app, doc, type } = setup('programmer');
    try {
      const [tab, space] = type(['Tab', ' ']);
      assert.equal(tab.prevented, false);
      assert.equal(space.prevented, false);
      for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
        const copy = keydown('c', element(true), { [modifier]: true });
        doc.fire('keydown', copy);
        assert.equal(copy.prevented, false, modifier);
      }
      const composing = keydown('7', element(true), { isComposing: true });
      doc.fire('keydown', composing);
      assert.equal(app.getState().calc.entry, '', 'Ctrl+C is not the hex digit C');
    }
    finally { app.destroy(); }
  });
  it('never types while focus is outside the keypad region, or in a mode without one', () => {
    const { app, doc, type } = setup();
    try {
      const field = element(false);
      const [typed] = type(['7'], field);
      assert.equal(typed.prevented, false);
      assert.equal(app.getState().calc.entry, '');
      doc.fire('keydown', keydown('7', null));
      const handled = keydown('7', element(true), { defaultPrevented: true });
      doc.fire('keydown', handled);
      assert.equal(app.getState().calc.entry, '');
      app.dispatch('calc/mode', { mode: 'financial' });
      type(['7']);
      assert.equal(app.getState().calc.entry, '');
    }
    finally { app.destroy(); }
  });
  it('a press in the region focuses it when nothing in it has focus, and unbind removes both listeners', () => {
    const { app, doc, unbind } = setup();
    try {
      const target = element(true);
      doc.fire('pointerdown', { target });
      assert.equal(target.pad.focused, 1);
      doc.fire('pointerdown', { target });
      assert.equal(target.pad.focused, 1, 'focus already in the region stays where it is');
      doc.fire('pointerdown', { target: element(false) });
      doc.fire('pointerdown', { target: null });
      unbind();
      assert.deepEqual([doc.listeners.keydown.length, doc.listeners.pointerdown.length], [0, 0]);
    }
    finally { app.destroy(); }
  });
});
