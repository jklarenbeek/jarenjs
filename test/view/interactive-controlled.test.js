//@ts-check
/**
 * @file Controlled inputs under the interactive profile: an `input`'s
 * `value`/`checked` is authoritative there as in trusted mode, so app state
 * resets a field the user edited — reasserted to what the control's
 * attributes say, which is what the serializer's markup starts from. The
 * attribute itself is written as before, so markup is unchanged; `safe: true`
 * stays attribute-only, a file input's value is never assigned, and a
 * `textarea` or `select` keeps the attribute-only display.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { createDomRenderer, createSafePolicy, renderToString } from '@jarenjs/view';

import { createStubHost, fire } from './dom.stub.js';
import { childMarkup } from './interactive-corpus.js';

const INTERACTIVE = /** @type {const} */ ('interactive');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A renderer over a fresh stub host.
 * @param {Record<string, any>} [options]
 */
function host(options = {}) {
  const { document, container } = createStubHost();
  /** @type {string[]} */
  const seen = [];
  /** @type {any[]} */
  const events = [];
  const render = createDomRenderer(container, {
    document,
    onEvent: (binding, event) => events.push({ binding, event }),
    onUnsafe: (info) => seen.push(`${info.kind}:${info.name}`),
    ...options,
  });
  return { render, container, document, seen, events, root: () => /** @type {any} */ (container.childNodes[0]) };
}

/** A form whose state resets a text field and a checkbox. @param {string} text @param {boolean} box */
const form = (text, box) => ['form', {}, ['input', { value: text }], ['input', { type: 'checkbox', checked: box }]];

describe('interactive profile — state resets an input the user edited', () => {
  it('reasserts a text input and a checkbox, as the trusted renderer does', () => {
    /** @type {Record<string, any>} */
    const answers = {};
    for (const safe of [false, INTERACTIVE, true]) {
      const h = host({ safe });
      h.render(form('start', true));
      const [text, box] = h.root().childNodes;
      const initial = { text: text.value, box: box.checked };
      text.value = 'typed';
      box.checked = false;
      h.render(form('', true));
      answers[String(safe)] = { initial, reset: { text: text.value, box: box.checked } };
    }
    assert.deepEqual(answers.false, { initial: { text: 'start', box: true }, reset: { text: '', box: true } });
    assert.deepEqual(answers.interactive, answers.false);
    // the strict profile is unchanged: attribute-only, so the stub (which
    // reflects no attribute into the live value) keeps what the user typed
    assert.deepEqual(answers.true, { initial: { text: '', box: false }, reset: { text: 'typed', box: false } });
  });

  it('reasserts an unchanged value over a user edit, across a same-object frame', () => {
    const h = host({ safe: INTERACTIVE });
    const vnode = ['input', { value: 'server' }];
    h.render(vnode);
    h.root().value = 'user';
    h.render(vnode);
    assert.equal(h.root().value, 'server');
  });

  it('writes the same attributes as safe: true, and the markup is the serializer\'s', () => {
    const vnode = ['div', {}, ['input', { value: 'v', type: 'text' }], ['input', { type: 'checkbox', checked: true }],
      ['input', { type: 'radio', checked: false, value: 3 }]];
    const safe = host({ safe: true });
    const interactive = host({ safe: INTERACTIVE });
    safe.render(vnode);
    interactive.render(vnode);
    assert.equal(childMarkup(interactive.container), childMarkup(safe.container));
    assert.equal(childMarkup(interactive.container),
      '<div><input value="v" type="text"><input type="checkbox" checked><input type="radio" value="3"></div>');
    assert.equal(childMarkup(interactive.container), renderToString(vnode, { safe: INTERACTIVE }));
  });

  it('reads a value and a checked as their attributes do, so the DOM shows what the markup starts from', () => {
    /** @type {Array<[any, string, string]>} [value, live value, markup] */
    const values = [
      ['text', 'text', '<input value="text">'],
      [0, '0', '<input value="0">'],
      [true, '', '<input value>'],
      [false, '', '<input>'],
      [null, '', '<input>'],
      [['a', 'b'], 'a,b', '<input value="a,b">'],
      [{ a: 1 }, '', '<input>'],
    ];
    for (const [value, live, markup] of values) {
      const h = host({ safe: INTERACTIVE });
      h.render(['input', { value }]);
      assert.equal(h.root().value, live, `value ${JSON.stringify(value)}`);
      assert.equal(renderToString(['input', { value }], { safe: INTERACTIVE }), markup);
    }
    /** @type {Array<[any, boolean, string]>} [checked, live checked, markup] */
    const checks = [
      [true, true, '<input type="checkbox" checked>'],
      [1, true, '<input type="checkbox" checked="1">'],
      [0, true, '<input type="checkbox" checked="0">'],
      ['x', true, '<input type="checkbox" checked="x">'],
      [false, false, '<input type="checkbox">'],
      [null, false, '<input type="checkbox">'],
    ];
    for (const [checked, live, markup] of checks) {
      const h = host({ safe: INTERACTIVE });
      h.render(['input', { type: 'checkbox', checked }]);
      h.root().checked = !live;
      h.render(['input', { type: 'checkbox', checked }]);
      assert.equal(h.root().checked, live, `checked ${JSON.stringify(checked)}`);
      assert.equal(renderToString(['input', { type: 'checkbox', checked }], { safe: INTERACTIVE }), markup);
    }
  });

  it('a stripped object value is reported, and controls the field to the empty value its markup has', () => {
    const h = host({ safe: INTERACTIVE });
    h.render(['input', { value: { toString: () => 'run' } }]);
    assert.deepEqual(h.seen, ['prop:value']);
    h.root().value = 'typed';
    h.render(['input', { value: { toString: () => 'run' } }]);
    assert.equal(h.root().value, '');
  });

  it('only an own, exactly spelled value or checked is controlled', () => {
    const h = host({ safe: INTERACTIVE });
    h.render(['div', {}, ['input', { Value: 'cased' }], ['input', Object.create({ value: 'inherited' })]]);
    const [cased, inherited] = h.root().childNodes;
    assert.equal(cased.__jarenControlled, undefined);
    assert.equal(inherited.__jarenControlled, undefined);
    // both keep the attribute-only answer they had
    assert.equal(cased.getAttribute('Value'), 'cased');
    assert.equal(inherited.getAttribute('value'), 'inherited');
  });

  it('follows a genuine state change, and stops controlling a field that drops its value', () => {
    const h = host({ safe: INTERACTIVE });
    h.render(['input', { value: 'a' }]);
    h.render(['input', { value: 'b' }]);
    assert.equal(h.root().value, 'b');
    h.render(['input', {}]);
    assert.equal(h.root().__jarenControlled, undefined);
    assert.equal(h.root().listeners.get('compositionstart')?.size ?? 0, 0);
    h.root().value = 'typed';
    h.render(['input', {}]);
    assert.equal(h.root().value, 'typed', 'an uncontrolled field keeps what the user typed');
  });

  it('a textarea and a select keep the attribute-only display', () => {
    const h = host({ safe: INTERACTIVE });
    const vnode = ['div', {}, ['textarea', { value: 'x' }], ['select', { value: 'b' }, ['option', { value: 'a' }, 'A'], ['option', { value: 'b' }, 'B']]];
    h.render(vnode);
    const [area, select] = h.root().childNodes;
    area.value = 'typed';
    select.value = 'a';
    h.render(vnode);
    assert.deepEqual({ area: area.value, select: select.value }, { area: 'typed', select: 'a' });
    assert.equal(area.getAttribute('value'), 'x');
    assert.equal(renderToString(vnode, { safe: INTERACTIVE }),
      '<div><textarea value="x"></textarea><select value="b"><option value="a">A</option><option value="b">B</option></select></div>');
  });

  it('a granted widget\'s host input stays attribute-only: the widget owns it', () => {
    const h = host({ safe: INTERACTIVE, widgets: { w: { mount() {} } }, capabilities: { widgets: ['w'] } });
    h.render(['jaren-widget', { name: 'w', tag: 'input', value: 'x' }]);
    const node = h.root();
    assert.equal(node.getAttribute('value'), 'x');
    assert.equal(node.__jarenControlled, undefined);
  });
});

describe('createSafePolicy — the control decision', () => {
  it('answers for an interactive input only, from the attributes it writes', () => {
    const plain = createSafePolicy();
    const policy = createSafePolicy({ interactive: true });
    assert.equal(plain.control('input', { value: 'a' }), null);
    assert.equal(policy.control('textarea', { value: 'a' }), null);
    assert.equal(policy.control('select', { value: 'a' }), null);
    assert.equal(policy.control('input', { type: 'text' }), null);
    assert.deepEqual(policy.control('input', { value: 7 }), { hasValue: true, hasChecked: false, value: '7', checked: undefined });
    assert.deepEqual(policy.control('input', { checked: 'yes' }), { hasValue: false, hasChecked: true, value: undefined, checked: true });
    assert.deepEqual(policy.control('input', { value: true, checked: false }), { hasValue: true, hasChecked: true, value: '', checked: false });
  });
});

describe('interactive profile — a file input is never assigned', () => {
  /**
   * A stub host whose inputs throw on a non-empty value assignment to a file
   * input, as a browser does.
   * @param {Record<string, any>} options
   */
  function fileHost(options) {
    const h = host(options);
    const create = h.document.createElement.bind(h.document);
    h.document.createElement = (/** @type {string} */ tag) => {
      const node = create(tag);
      if (tag !== 'input') return node;
      let value = '';
      Object.defineProperty(node, 'value', {
        get: () => value,
        set: (next) => {
          if (node.getAttribute('type') === 'file' && next !== '') throw new DOMException('file value', 'InvalidStateError');
          value = String(next);
        },
      });
      return node;
    };
    return h;
  }

  it('renders and patches a file input\'s value as its attribute only', () => {
    const h = fileHost({ safe: INTERACTIVE });
    assert.doesNotThrow(() => h.render(['input', { type: 'file', value: 'C:\\fakepath\\x' }]));
    assert.equal(h.root().getAttribute('value'), 'C:\\fakepath\\x');
    assert.equal(h.root().value, '');
    assert.doesNotThrow(() => h.render(['input', { type: 'file', value: 'y' }]));
    assert.equal(h.root().getAttribute('value'), 'y');
  });

  it('reads the type at reconcile time: a field a later frame makes a file input is left alone', () => {
    const h = fileHost({ safe: INTERACTIVE });
    h.render(['input', { type: 'text', value: 'a' }]);
    assert.equal(h.root().value, 'a');
    h.root().value = '';
    assert.doesNotThrow(() => h.render(['input', { type: 'file', value: 'b' }]));
    assert.equal(h.root().value, '');
  });

  it('proves the teeth: the trusted renderer assigns it, and the assignment throws', () => {
    const h = fileHost({});
    assert.throws(() => h.render(['input', { type: 'file', value: 'x' }]), /file value/);
  });
});

describe('interactive profile — caret, composition and focus behave as the trusted path', () => {
  /**
   * Run one edit sequence under a profile and return what the user sees.
   * @param {false | 'interactive'} safe
   */
  function caretRun(safe) {
    const h = host({ safe });
    h.render(['input', { value: 'hello world' }]);
    const field = h.root();
    /** @type {any[]} */
    const ranges = [];
    field.selectionStart = 5;
    field.selectionEnd = 8;
    field.selectionDirection = 'forward';
    field.setSelectionRange = (/** @type {number} */ start, /** @type {number} */ end, /** @type {string} */ direction) => {
      ranges.push([start, end, direction]);
    };
    field.focus();
    field.value = 'hello there world';
    h.render(['input', { value: 'hello' }]);
    // an already-matching control is not rewritten
    h.render(['input', { value: 'hello' }]);
    return { value: field.value, ranges };
  }

  it('a reasserted focused field keeps its caret, clamped, and an equal one is not rewritten', () => {
    const trusted = caretRun(false);
    assert.deepEqual(trusted, { value: 'hello', ranges: [[5, 5, 'forward']] });
    assert.deepEqual(caretRun(INTERACTIVE), trusted);
  });

  /** @param {false | 'interactive'} safe */
  async function compositionRun(safe) {
    const h = host({ safe });
    h.render(['input', { value: 'start' }]);
    const field = h.root();
    /** @type {string[]} */
    const seen = [];
    fire(field, 'compositionstart');
    field.value = 'composing';
    h.render(['input', { value: 'state' }]);
    seen.push(field.value);
    fire(field, 'compositionend');
    await Promise.resolve();
    seen.push(field.value);
    await tick();
    seen.push(field.value);
    h.render.destroy();
    await tick();
    seen.push(String(field.listeners.get('compositionend')?.size ?? 0));
    return seen;
  }

  it('a composition holds the authoritative write back until one task after it ends', async () => {
    const trusted = await compositionRun(false);
    assert.deepEqual(trusted, ['composing', 'composing', 'state', '0']);
    assert.deepEqual(await compositionRun(INTERACTIVE), trusted);
  });

  it("with controlled: 'focus', a focused field keeps the user's text until it blurs", async () => {
    for (const safe of [false, INTERACTIVE]) {
      const h = host({ safe, controlled: 'focus' });
      h.render(['input', { value: 'start' }]);
      const field = h.root();
      field.focus();
      field.value = 'typing';
      h.render(['input', { value: 'refresh' }]);
      assert.equal(field.value, 'typing', `${safe}: deferred while focused`);
      h.document.activeElement = null;
      fire(field, 'focusout');
      await tick();
      assert.equal(field.value, 'refresh', `${safe}: reconciled after the blur`);
      h.render.destroy();
    }
  });
});

describe('interactive profile — a controlled write reads nothing back', () => {
  it('a controlled password field still withholds what the user typed from a binding', () => {
    const h = host({ safe: INTERACTIVE });
    h.render(['input', { type: 'password', value: '', on: { input: 'typed' } }]);
    const field = h.root();
    field.value = 'hunter2';
    fire(field, 'input');
    assert.equal(h.events.length, 1);
    assert.equal(h.events[0].event.target.value, null);
    h.render(['input', { type: 'password', value: '', on: { input: 'typed' } }]);
    assert.equal(field.value, '', 'the document resets the value it owns');
  });

  it('a text field\'s own binding reads the typed value through the target slice, then the state wins', () => {
    const h = host({ safe: INTERACTIVE });
    h.render(['input', { value: 'a', on: { input: 'edit' } }]);
    const field = h.root();
    field.value = 'ab';
    fire(field, 'input');
    assert.equal(h.events[0].event.target.value, 'ab');
    h.render(['input', { value: 'a', on: { input: 'edit' } }]);
    assert.equal(field.value, 'a');
  });
});
