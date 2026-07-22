//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { createApp } from '@jarenjs/app';
import { JarenValidator } from '@jarenjs/validate';
import { createStubHost, fire } from '../view/dom.stub.js';

/** Synchronous render scheduler for deterministic assertions. */
const sync = (flush) => flush();

function captureDoc(binding) {
  return {
    state: { last: null },
    view: [{
      match: '$',
      body: ['button', { on: { click: binding } }, 'go'],
    }],
    actions: {
      capture: { patch: [{ op: 'add', path: '/last', value: '$event' }] },
    },
  };
}

function mount(doc, options = {}) {
  const { document, container } = createStubHost();
  const app = createApp(doc, { node: container, document, schedule: sync, ...options });
  return { app, container };
}

describe('declarative preventDefault/stopPropagation (APP-FORMAT §3.1)', function () {
  /** A stub event with spy methods and a call log. */
  function spyEvent(log) {
    return {
      preventDefault: () => log.push('preventDefault'),
      stopPropagation: () => log.push('stopPropagation'),
    };
  }

  it('runs the declared native controls synchronously, before the action is queued', function () {
    const log = [];
    const { app, container } = mount(captureDoc({
      action: 'capture', preventDefault: true, stopPropagation: true,
    }));
    app.subscribe(() => log.push('transition'));
    fire(container.childNodes[0], 'click', spyEvent(log));
    assert.deepStrictEqual(log, ['preventDefault', 'stopPropagation', 'transition'],
      'the native controls ran in the event callback, before the transaction');
    assert.notStrictEqual(app.getState().last, null);
  });

  it('defaults to false: no declaration, no native call', function () {
    const log = [];
    const { container } = mount(captureDoc({ action: 'capture' }));
    fire(container.childNodes[0], 'click', spyEvent(log));
    assert.deepStrictEqual(log, []);
  });

  it('an action failure cannot retroactively change the already-performed native control', function () {
    const log = [];
    const errors = [];
    const doc = captureDoc({ action: 'explode', preventDefault: true });
    doc.actions.explode = { $assertFails: [1] }; // unknown operator: compile-... use runtime failure instead
    delete doc.actions.explode;
    doc.actions.explode = { patch: [{ op: 'replace', path: '/missing/deep', value: 1 }] };
    const { container } = mount(doc, { onError: (err) => errors.push(err) });
    fire(container.childNodes[0], 'click', spyEvent(log));
    assert.deepStrictEqual(log, ['preventDefault'],
      'preventDefault had already run when the action later failed');
    assert.ok(errors.length > 0);
  });

  it('a non-boolean control member makes the binding unusable (JA2001): dropped, nothing called', function () {
    const log = [];
    const errors = [];
    const { app, container } = mount(
      captureDoc({ action: 'capture', preventDefault: 'yes' }),
      { onError: (err) => errors.push(err) });
    fire(container.childNodes[0], 'click', spyEvent(log));
    assert.strictEqual(/** @type {any} */ (errors[0]).code, 'JA2001');
    assert.deepStrictEqual(log, [], 'no native control ran');
    assert.strictEqual(app.getState().last, null, 'the dispatch was dropped');
  });

  it('a widget emit follows the same binding path, controls included', function () {
    const log = [];
    const { document, container } = createStubHost();
    const doc = {
      state: { got: null },
      view: [{ match: '$', body: ['main', {}, ['jaren-widget', { name: 'w' }]] }],
      actions: {
        fromWidget: { patch: [{ op: 'add', path: '/got', value: '$payload' }] },
      },
    };
    let emitBinding = null;
    const app = createApp(doc, {
      node: container, document, schedule: sync,
      widgets: {
        w: {
          mount: (host, props, emit) => { emitBinding = emit; return null; },
        },
      },
    });
    emitBinding(
      { action: 'fromWidget', with: 7, preventDefault: true },
      spyEvent(log));
    assert.deepStrictEqual(log, ['preventDefault']);
    assert.strictEqual(app.getState().got, 7);
  });

  it('headless dispatch with an event lacking the methods is a documented no-op', function () {
    const app = createApp(captureDoc('capture'), { schedule: sync });
    // no preventDefault/stopPropagation members on the event object
    app.dispatch('capture', null, { type: 'submit' });
    assert.strictEqual(app.getState().last.type, 'submit');
  });
});

describe('$event default members and prototype safety (A5)', function () {
  it('requesting a default member never overwrites it with null', function () {
    const { app, container } = mount(
      captureDoc({ action: 'capture', event: ['value', 'key', 'type', 'checked'] }));
    fire(container.childNodes[0], 'click', { target: { value: 'kept' }, key: 'Enter' });
    assert.deepStrictEqual(app.getState().last, {
      type: 'click', value: 'kept', checked: null, key: 'Enter',
    }, 'the default slice survived being requested explicitly');
  });

  it('a registered extractor still wins over a default member — the host chose to redefine it', function () {
    const { app, container } = mount(
      captureDoc({ action: 'capture', event: ['value'] }),
      { eventFields: { value: () => 'extracted' } });
    fire(container.childNodes[0], 'click', { target: { value: 'native' } });
    assert.strictEqual(app.getState().last.value, 'extracted');
  });

  it('requesting __proto__ binds a plain null member and never mutates a prototype', function () {
    const errors = [];
    const { app, container } = mount(
      captureDoc({ action: 'capture', event: ['__proto__'] }),
      { onError: (err) => errors.push(err) });
    fire(container.childNodes[0], 'click');
    const last = app.getState().last;
    assert.strictEqual(Object.getPrototypeOf(last), Object.prototype,
      'the event object kept its ordinary prototype');
    assert.strictEqual(Object.getOwnPropertyDescriptor(last, '__proto__')?.value, null,
      'the member is an own data property bound null');
    assert.strictEqual(/** @type {any} */ (errors[0]).code, 'JA2009',
      'an unknown field, reported as usual');
    assert.deepStrictEqual(JSON.parse(JSON.stringify(last)), last,
      'the whole $event value, own __proto__ member included, survives a JSON round-trip');
  });

  it('requesting constructor shadows with an own member and never touches the prototype', function () {
    const errors = [];
    const { app, container } = mount(
      captureDoc({ action: 'capture', event: ['constructor'] }),
      { onError: (err) => errors.push(err) });
    fire(container.childNodes[0], 'click');
    const last = app.getState().last;
    assert.strictEqual(last.constructor, null, 'own member, bound null');
    assert.strictEqual(Object.getPrototypeOf(last), Object.prototype);
    assert.strictEqual(({}).constructor, Object, 'Object.prototype was never mutated');
  });
});

describe('the vnode schema rejects malformed widget nodes (A5)', function () {
  const load = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
  const validate = new JarenValidator()
    .compile(load('../../packages/view/schemas/jaren-vnode.schema.json'));

  it('accepts a well-formed widget node and ordinary elements', function () {
    assert.strictEqual(validate(['jaren-widget', { name: 'grid' }]), true);
    assert.strictEqual(validate(['jaren-widget', { name: 'grid', props: { rows: [] }, tag: 'section' }]), true);
    assert.strictEqual(validate(['div', { id: 'x' }, 'hello']), true);
  });

  it('rejects widget nodes missing a name, with children, or with a malformed name', function () {
    assert.strictEqual(validate(['jaren-widget', {}]), false,
      'no name — must NOT pass through the generic element branch');
    assert.strictEqual(validate(['jaren-widget', { name: '' }]), false);
    assert.strictEqual(validate(['jaren-widget', { name: 'grid' }, ['p', {}, 'child']]), false,
      'a widget owns its subtree; vnode children are invalid');
    assert.strictEqual(validate(['jaren-widget']), false, 'props are required');
  });
});
