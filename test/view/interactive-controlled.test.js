//@ts-check
/**
 * @file Controlled inputs under the interactive profile: an `input`'s
 * `value`/`checked` is authoritative there as in trusted mode, so app state
 * resets a field the user edited — reasserted to what the control's
 * attributes say, which is what the serializer's markup starts from. The
 * attribute itself is written as before, so markup is unchanged. A
 * `textarea`'s and a `select`'s `value` is authoritative too, written by the
 * serializer in the trusted form (the text, `selected` options) and by the
 * DOM renderer as no attribute. `safe: true` stays attribute-only and a file
 * input's value is never assigned.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { createDomRenderer, createSafePolicy, renderToString } from '@jarenjs/view';

import { bookkeeping, createStubHost, fire } from './dom.stub.js';
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
    assert.equal(bookkeeping(cased, 'controlled'), undefined);
    assert.equal(bookkeeping(inherited, 'controlled'), undefined);
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
    assert.equal(bookkeeping(h.root(), 'controlled'), undefined);
    assert.equal(h.root().listeners.get('compositionstart')?.size ?? 0, 0);
    h.root().value = 'typed';
    h.render(['input', {}]);
    assert.equal(h.root().value, 'typed', 'an uncontrolled field keeps what the user typed');
  });

  it('reasserts a textarea and a select, as the trusted renderer does; safe: true keeps the attribute', () => {
    const OPTIONS = [['option', { value: '' }, '-'], ['option', { value: 'a' }, 'A'], ['option', { value: 'b' }, 'B']];
    /** @param {string} v */
    const doc = (v) => ['div', {}, ['textarea', { value: v }], ['select', { value: v }, ...OPTIONS],
      ['select', { multiple: true, value: v === '' ? [] : ['a', v] }, ...OPTIONS]];
    /** @type {Record<string, any>} */
    const answers = {};
    for (const safe of [false, INTERACTIVE, true]) {
      const h = host({ safe });
      h.render(doc('b'));
      const [area, select, multi] = h.root().childNodes;
      const initial = { area: area.value, select: select.value, multi: multi.options.map((o) => o.selected === true) };
      area.value = 'typed';
      select.value = 'a';
      multi.options[0].selected = true;
      h.render(doc(''));
      answers[String(safe)] = {
        initial, reset: { area: area.value, select: select.value, multi: multi.options.map((o) => o.selected === true) },
        attributes: [area, select, multi].map((node) => node.getAttribute('value')),
      };
    }
    assert.deepEqual(answers.false, {
      initial: { area: 'b', select: 'b', multi: [false, true, true] },
      reset: { area: '', select: '', multi: [false, false, false] },
      attributes: [null, null, null],
    });
    assert.deepEqual(answers.interactive, answers.false);
    // attribute-only: the stub reflects no attribute, and the edit survives
    assert.deepEqual(answers.true, {
      initial: { area: '', select: '', multi: [false, false, false] },
      reset: { area: 'typed', select: 'a', multi: [true, false, false] },
      attributes: ['', '', ''],
    });
  });

  it('serializes a textarea\'s text and a select\'s selection as trusted mode does', () => {
    const vnode = ['div', {}, ['textarea', { value: 'x' }, 'y'], ['select', { value: 'b' }, ['option', { value: 'a' }, 'A'], ['option', { value: 'b' }, 'B']]];
    const expected = '<div><textarea>x</textarea><select><option value="a">A</option><option value="b" selected>B</option></select></div>';
    assert.equal(renderToString(vnode, { safe: INTERACTIVE }), expected);
    assert.equal(renderToString(vnode), expected);
    assert.equal(renderToString(vnode, { safe: true }),
      '<div><textarea value="x">y</textarea><select value="b"><option value="a">A</option><option value="b">B</option></select></div>');
    // a leading newline survives the parser, as in trusted mode
    assert.equal(renderToString(['textarea', { value: '\nx' }], { safe: INTERACTIVE }), '<textarea>\n\nx</textarea>');
  });

  it('reads a textarea\'s and a select\'s value as trusted mode does, of the value the policy keeps', () => {
    /** @type {Array<[any, string]>} */
    const areas = [[null, ''], [true, 'true'], [false, 'false'], [0, '0'], ['<b>', '&lt;b&gt;'], [['a', 'b'], 'a,b']];
    for (const [value, text] of areas) {
      const vnode = ['textarea', { value }];
      assert.equal(renderToString(vnode, { safe: INTERACTIVE }), `<textarea>${text}</textarea>`, JSON.stringify(value));
      assert.equal(renderToString(vnode), `<textarea>${text}</textarea>`, JSON.stringify(value));
      const h = host({ safe: INTERACTIVE });
      h.render(vnode);
      assert.equal(h.root().value, renderToString(vnode).slice(10, -11).replace('&lt;', '<').replace('&gt;', '>'), JSON.stringify(value));
    }
    // a value the policy strips (an object) is reported by both renderers and reads ''
    const stripped = ['textarea', { value: { a: 1 } }, 'kept'];
    const h = host({ safe: INTERACTIVE });
    h.render(stripped);
    assert.deepEqual({ value: h.root().value, attribute: h.root().getAttribute('value'), seen: h.seen }, { value: '', attribute: null, seen: ['prop:value'] });
    /** @type {string[]} */
    const seen = [];
    assert.equal(renderToString(stripped, { safe: INTERACTIVE, onUnsafe: (info) => seen.push(`${info.kind}:${info.name}`) }), '<textarea></textarea>');
    assert.deepEqual(seen, ['prop:value']);
    // and `safe: true` reports it alike
    seen.length = 0;
    assert.equal(renderToString(stripped, { safe: true, onUnsafe: (info) => seen.push(`${info.kind}:${info.name}`) }), '<textarea>kept</textarea>');
    assert.deepEqual(seen, ['prop:value']);
  });

  it('matches a select\'s options as their markup says: text, a stripped value, an optgroup, no match, a scalar on a multiple', () => {
    const cases = [
      // an option with no value matches by its normalized text
      [['select', { value: 'Two words' }, ['option', {}, ' Two   words '], ['option', { value: 'x' }, 'X']],
        '<select><option selected> Two   words </option><option value="x">X</option></select>'],
      // a stripped (object) option value writes no attribute: its text is its value
      [['select', { value: 'T' }, ['option', { value: { a: 1 } }, 'T'], ['option', { value: '[object Object]' }, 'O']],
        '<select><option selected>T</option><option value="[object Object]">O</option></select>'],
      // through an optgroup
      [['select', { value: 'b' }, ['optgroup', { label: 'g' }, ['option', { value: 'a' }, 'A'], ['option', { value: 'b' }, 'B']]],
        '<select><optgroup label="g"><option value="a">A</option><option value="b" selected>B</option></optgroup></select>'],
      // no match: nothing selected, an authored `selected` overridden
      [['select', { value: 'z' }, ['option', { value: 'a', selected: true }, 'A']], '<select><option value="a">A</option></select>'],
      // a scalar on a multiple select selects the one option
      [['select', { multiple: true, value: 'b' }, ['option', { value: 'a' }, 'A'], ['option', { value: 'b' }, 'B']],
        '<select multiple><option value="a">A</option><option value="b" selected>B</option></select>'],
      // a single select marks its first match only
      [['select', { value: 'a' }, ['option', { value: 'a' }, '1'], ['option', { value: 'a' }, '2']],
        '<select><option value="a" selected>1</option><option value="a">2</option></select>'],
    ];
    for (const [vnode, expected] of cases) {
      assert.equal(renderToString(vnode, { safe: INTERACTIVE }), expected);
    }
  });

  it('an inherited value is controlled, as trusted mode reads it; a Value spelling stays an attribute', () => {
    const inherited = ['textarea', Object.create({ value: 'x' })];
    const h = host({ safe: INTERACTIVE });
    h.render(inherited);
    assert.deepEqual({ value: h.root().value, markup: childMarkup(h.container) }, { value: 'x', markup: '<textarea></textarea>' });
    assert.equal(renderToString(inherited, { safe: INTERACTIVE }), '<textarea>x</textarea>');
    const spelled = ['select', { Value: 'b' }, ['option', { value: 'b' }, 'B']];
    const g = host({ safe: INTERACTIVE });
    g.render(spelled);
    assert.equal(bookkeeping(g.root(), 'controlled'), undefined);
    assert.equal(childMarkup(g.container), '<select Value="b"><option value="b">B</option></select>');
    assert.equal(renderToString(spelled, { safe: INTERACTIVE }), '<select Value="b"><option value="b">B</option></select>');
  });

  it('dropping a textarea\'s value releases its control and its listeners', () => {
    const h = host({ safe: INTERACTIVE });
    h.render(['textarea', { value: 'x' }]);
    assert.equal(h.root().listeners.get('compositionstart')?.size, 1);
    h.render(['textarea', {}]);
    assert.equal(bookkeeping(h.root(), 'controlled'), undefined);
    assert.equal(h.root().listeners.get('compositionstart')?.size ?? 0, 0);
    h.root().value = 'typed';
    h.render(['textarea', {}]);
    assert.equal(h.root().value, 'typed');
    assert.equal(h.root().getAttribute('value'), null);
  });

  it('a textarea waits for composition and controlled: \'focus\' as in trusted mode', async () => {
    /** @type {Record<string, any>} */
    const answers = {};
    for (const safe of [false, INTERACTIVE]) {
      const h = host({ safe, controlled: 'focus' });
      h.render(['textarea', { value: 'a' }]);
      const area = h.root();
      h.document.activeElement = area;
      area.value = 'typing';
      h.render(['textarea', { value: 'b' }]);
      const focused = area.value;
      h.document.activeElement = null;
      fire(area, 'focusout');
      await tick();
      answers[String(safe)] = { focused, settled: area.value };
    }
    assert.deepEqual(answers.false, { focused: 'typing', settled: 'b' });
    assert.deepEqual(answers.interactive, answers.false);
  });

  it('a granted widget\'s host input stays attribute-only: the widget owns it', () => {
    const h = host({ safe: INTERACTIVE, widgets: { w: { mount() {} } }, capabilities: { widgets: ['w'] } });
    h.render(['jaren-widget', { name: 'w', tag: 'input', value: 'x' }]);
    const node = h.root();
    assert.equal(node.getAttribute('value'), 'x');
    assert.equal(bookkeeping(node, 'controlled'), undefined);
    // a host textarea or select keeps its attribute too, in both renderers
    for (const tag of ['textarea', 'select']) {
      const g = host({ safe: INTERACTIVE, widgets: { w: { mount() {} } }, capabilities: { widgets: ['w'] } });
      const vnode = ['jaren-widget', { name: 'w', tag, value: 'x' }];
      g.render(vnode);
      assert.equal(g.root().getAttribute('value'), 'x', tag);
      assert.equal(bookkeeping(g.root(), 'controlled'), undefined, tag);
      assert.equal(renderToString(vnode, { safe: INTERACTIVE, widgets: { w: {} }, capabilities: { widgets: ['w'] } }), `<${tag} value="x"></${tag}>`);
    }
  });
});

describe('createSafePolicy — the control decision', () => {
  it('answers for an interactive input from the attributes it writes, and a textarea and a select in the trusted form', () => {
    const plain = createSafePolicy();
    const policy = createSafePolicy({ interactive: true });
    assert.equal(plain.control('input', { value: 'a' }), null);
    assert.equal(plain.control('textarea', { value: 'a' }), null);
    assert.equal(plain.control('select', { value: 'a' }), null);
    assert.equal(policy.control('div', { value: 'a' }), null);
    assert.equal(policy.control('textarea', {}), null);
    assert.equal(policy.control('select', { checked: true }), null);
    assert.deepEqual(policy.control('textarea', { value: true }), { hasValue: true, hasChecked: false, value: 'true', checked: undefined });
    assert.deepEqual(policy.control('textarea', { value: { a: 1 } }), { hasValue: true, hasChecked: false, value: '', checked: undefined });
    assert.deepEqual(policy.control('select', { value: 7 }), { hasValue: true, hasChecked: false, value: '7', checked: undefined });
    assert.deepEqual(policy.control('select', { value: null }), { hasValue: true, hasChecked: false, value: '', checked: undefined });
    assert.deepEqual(policy.control('select', { value: ['a', 1] }), { hasValue: true, hasChecked: false, value: ['a', 1], checked: undefined });
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
