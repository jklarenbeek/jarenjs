//@ts-check
/**
 * @file Controlled form inputs: an authoritative value must survive a user
 * edit, even when the vnode value did not change between renders.
 *
 * The bug this pins: `patchProps` diffed vnode SNAPSHOTS, so when state said
 * `value: 'server'` on two successive renders while the user typed something
 * else in between, the value looked unchanged and was never reasserted — the
 * live input kept the user's text. React's contract is the opposite: the
 * passed value wins. The fix reconciles value/checked against the LIVE DOM
 * property, not the previous vnode.
 *
 * The DOM stub models `value`/`checked` on form controls only, exactly as a
 * browser does; a test simulates a user edit by writing the property directly.
 * Caret/IME behavior across real engines is the browser-suite follow-up the
 * review calls for — not expressible against a Node stub.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { createDomRenderer } from '@jarenjs/view';

import { createStubHost, fire } from './dom.stub.js';

/** A renderer over a fresh host, plus the current root node. */
function host() {
  const { document, container } = createStubHost();
  const render = createDomRenderer(container, { document, onEvent: () => {} });
  return { render, root: () => container.childNodes[0] };
}

describe('controlled inputs — an authoritative value survives a user edit', () => {
  it('reasserts a same-valued text input over a user edit', () => {
    const h = host();
    h.render(['input', { value: 'server', class: 'a' }]);
    assert.strictEqual(h.root().value, 'server');
    // the user types
    h.root().value = 'user';
    // a re-render whose vnode value is UNCHANGED, only an unrelated prop moved
    h.render(['input', { value: 'server', class: 'b' }]);
    assert.strictEqual(h.root().value, 'server',
      'the authoritative value must win over the user edit');
  });

  it('reasserts a checkbox that the user toggled', () => {
    const h = host();
    h.render(['input', { type: 'checkbox', checked: true, class: 'a' }]);
    assert.strictEqual(h.root().checked, true);
    h.root().checked = false; // user unchecks
    h.render(['input', { type: 'checkbox', checked: true, class: 'b' }]);
    assert.strictEqual(h.root().checked, true);
  });

  it('reasserts a select whose option the user changed', () => {
    const h = host();
    h.render(['select', { value: 'a' }]);
    assert.strictEqual(h.root().value, 'a');
    h.root().value = 'b';
    h.render(['select', { value: 'a' }]);
    assert.strictEqual(h.root().value, 'a');
  });

  it('follows a genuine state change', () => {
    const h = host();
    h.render(['input', { value: 'one' }]);
    h.render(['input', { value: 'two' }]);
    assert.strictEqual(h.root().value, 'two');
  });

  it('does not rewrite an already-equal value (caret is left alone)', () => {
    // The guard is `node.value !== want`: when the live value already matches,
    // nothing is written, which is what keeps the caret where the user has it.
    const h = host();
    h.render(['input', { value: 'x', class: 'a' }]);
    let writes = 0;
    const node = h.root();
    let backing = 'x';
    Object.defineProperty(node, 'value', {
      get() { return backing; },
      set(v) { writes += 1; backing = v; },
      configurable: true,
    });
    // same value present on both sides, only an unrelated prop changes
    h.render(['input', { value: 'x', class: 'b' }]);
    assert.strictEqual(writes, 0, 'an unchanged live value must not be rewritten');
  });

  it('leaves a non-form element untouched by the reconciliation', () => {
    // A div carrying a `value` prop is not a control; it must not gain a live
    // `value` property, only the attribute path the renderer already used.
    const h = host();
    h.render(['div', { value: 'x' }]);
    assert.strictEqual(h.root().getAttribute('value'), 'x');
  });
});

describe('controlled inputs — survive the ===/memo skip fast paths', () => {
  // The reconciliation runs once per settled pass over a registry, not inside
  // the prop diff, so it fires even when the subtree is skipped whole. These
  // are the exact cases a re-audit found still drifting at v0.22.32.

  it('reasserts across a same-object root re-render', () => {
    const h = host();
    const v = ['input', { value: 'server' }];
    h.render(v);
    h.root().value = 'user';
    h.render(v); // the identical vnode object: patchNode returns at oldV === newV
    assert.strictEqual(h.root().value, 'server');
  });

  it('reasserts across a shared input subtree by reference', () => {
    const h = host();
    const input = ['input', { value: 'server' }];
    h.render(['form', {}, input]);
    // the live input is the form's first child
    const live = () => h.root().childNodes[0];
    live().value = 'user';
    h.render(['form', { class: 'changed' }, input]); // fresh parent, SAME input object
    assert.strictEqual(live().value, 'server',
      'the shared subtree is skipped by ===, but the registry still reconciles it');
  });

  it('reasserts across an equal memo marker', () => {
    const h = host();
    const tree = () => ['div', { memo: 'k' }, ['input', { value: 'server' }]];
    h.render(tree());
    const live = () => h.root().childNodes[0];
    live().value = 'user';
    h.render(tree()); // fresh objects, equal memo → the subtree is skipped
    assert.strictEqual(live().value, 'server');
  });

  it('reasserts a checkbox across a same-object re-render', () => {
    const h = host();
    const v = ['input', { type: 'checkbox', checked: true }];
    h.render(v);
    h.root().checked = false;
    h.render(v);
    assert.strictEqual(h.root().checked, true);
  });

  it('stops reconciling a control once it leaves the tree', () => {
    // The registry self-cleans: a removed control is dropped, so a stale entry
    // never rewrites a detached node or leaks.
    const h = host();
    h.render(['div', {}, ['input', { value: 'a' }]]);
    const removed = h.root().childNodes[0];
    h.render(['div', {}, ['span', {}, 'no input']]);
    removed.value = 'edited';
    h.render(['div', {}, ['span', {}, 'still no input']]);
    assert.strictEqual(removed.value, 'edited', 'a detached control is left alone');
  });

  it('releases the registry on destroy without error, and no-ops afterward', () => {
    // teardown() clears the controlled registry so a destroyed renderer does
    // not retain detached controls. A post-destroy render is an exact no-op.
    const { document, container } = createStubHost();
    const render = createDomRenderer(container, { document, onEvent: () => {} });
    render(['form', {}, ['input', { value: 'a' }], ['input', { type: 'checkbox', checked: true }]]);
    assert.doesNotThrow(() => render.destroy());
    assert.doesNotThrow(() => render(['input', { value: 'b' }]));
    assert.strictEqual(container.childNodes.length, 0, 'destroyed renderer stays empty');
  });
});

describe('controlled selects — value after options, and multiple', () => {
  it('applies a single select value after its options exist', () => {
    // createNode sets props before children, so the value is written before
    // the options; the end-of-pass reconciliation settles it once they exist.
    const h = host();
    h.render(['select', { value: 'b' },
      ['option', { value: 'a' }, 'A'], ['option', { value: 'b' }, 'B']]);
    assert.strictEqual(h.root().value, 'b');
  });

  it('selects each option of a multiple select from an array', () => {
    const h = host();
    h.render(['select', { multiple: true, value: ['a', 'c'] },
      ['option', { value: 'a' }, 'A'],
      ['option', { value: 'b' }, 'B'],
      ['option', { value: 'c' }, 'C']]);
    const opts = h.root().options;
    assert.deepStrictEqual(opts.map((o) => o.selected), [true, false, true],
      'a multiple-select array marks each matching option selected, not a stringified value');
  });

  it('reasserts a multiple selection the user changed', () => {
    const h = host();
    const tree = () => ['select', { multiple: true, value: ['a'] },
      ['option', { value: 'a' }, 'A'], ['option', { value: 'b' }, 'B']];
    h.render(tree());
    // user selects b as well
    h.root().options[1].selected = true;
    h.render(tree());
    assert.deepStrictEqual(h.root().options.map((o) => o.selected), [true, false]);
  });
});

describe("controlled: 'focus' — the operator's focused edit holds until blur", () => {
  /** One task: the deferral settles after the focus loss's event sequence. */
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** @param {any} [options] */
  function focused(options) {
    const { document, container } = createStubHost();
    const render = createDomRenderer(container, { document, ...options });
    render(['input', { value: 'server' }]);
    const input = container.childNodes[0];
    input.focus();
    input.value = 'typed'; // the operator types
    return { render, input, document, container };
  }

  it('a background refresh waits for the blur, then the state\'s value is reconciled', async () => {
    const { render, input, document } = focused({ controlled: 'focus' });
    render(['input', { value: 'refreshed' }]);
    assert.strictEqual(input.value, 'typed', 'the refresh did not overwrite the focused edit');
    render(['input', { value: 'refreshed', class: 'again' }]);
    assert.strictEqual(input.value, 'typed', 'nor did a second pass');
    document.activeElement = null; // the focus leaves
    fire(input, 'focusout');
    assert.strictEqual(input.value, 'typed', 'the write settles one task later, after change and blur');
    await tick();
    assert.strictEqual(input.value, 'refreshed');
    render.destroy();
  });

  it('a render the blur scheduled lands first: the value it registers is the one reconciled', async () => {
    const { render, input, document } = focused({ controlled: 'focus' });
    render(['input', { value: 'refreshed' }]);
    document.activeElement = null;
    fire(input, 'focusout');
    render(['input', { value: 'typed' }]); // the change event put the edit into the state
    await tick();
    assert.strictEqual(input.value, 'typed');
    render.destroy();
  });

  it('without the option the state\'s value wins at once, as before', () => {
    const { render, input } = focused();
    render(['input', { value: 'refreshed' }]);
    assert.strictEqual(input.value, 'refreshed');
    render.destroy();
  });

  it('a control without focus reconciles at once even with the option', () => {
    const { render, input, document } = focused({ controlled: 'focus' });
    document.activeElement = null;
    render(['input', { value: 'refreshed' }]);
    assert.strictEqual(input.value, 'refreshed');
    render.destroy();
  });

  it('removing the control cancels the pending write, and releases the listener', async () => {
    const { render, input, document, container } = focused({ controlled: 'focus' });
    render(['input', { value: 'refreshed' }]);
    document.activeElement = null;
    fire(input, 'focusout');
    render(['p', {}, 'gone']);
    await tick();
    assert.strictEqual(input.value, 'typed', 'a removed control is never written');
    assert.strictEqual(input.listeners.get('focusout')?.size ?? 0, 0);
    assert.strictEqual(container.childNodes[0].tagName, 'p');
    render.destroy();
  });

  it("refuses any other value of the option", () => {
    const { document, container } = createStubHost();
    for (const controlled of ['always', true, 1]) {
      assert.throws(() => createDomRenderer(container, { document, controlled: /** @type {any} */ (controlled) }),
        (/** @type {any} */ error) => error instanceof TypeError && /controlled option is 'focus'/.test(error.message));
    }
  });
});
