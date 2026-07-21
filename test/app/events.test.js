//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createApp, AppRuntimeError } from '@jarenjs/app';
import { createStubHost, fire, serialize } from '../view/dom.stub.js';

/** Synchronous render scheduler for deterministic assertions. */
const sync = (flush) => flush();

/**
 * An app that stores the whole `$event` of its `capture` action in the
 * state, so tests can assert exactly what crossed the boundary.
 */
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

describe('configurable $event extraction', function () {
  it('keeps the default slice byte-identical when "event" is absent (string binding)', function () {
    const { app, container } = mount(captureDoc('capture'));
    fire(container.childNodes[0], 'click', { shiftKey: true, clientX: 4 });
    assert.deepStrictEqual(app.getState().last,
      { type: 'click', value: null, checked: null, key: null },
      'extra event members never leak in uninvited');
  });

  it('keeps the default slice byte-identical when "event" is absent (object binding)', function () {
    const { app, container } = mount(captureDoc({ action: 'capture', with: 1 }));
    fire(container.childNodes[0], 'click', { shiftKey: true });
    assert.deepStrictEqual(app.getState().last,
      { type: 'click', value: null, checked: null, key: null });
  });

  it('requested built-ins arrive beside the default slice and the "with" payload', function () {
    const doc = captureDoc({
      action: 'capture',
      with: { id: 7 },
      event: ['shiftKey', 'clientX'],
    });
    doc.actions.capture = {
      patch: [
        { op: 'add', path: '/last', value: '$event' },
        { op: 'add', path: '/payload', value: '$payload' },
      ],
    };
    const { app, container } = mount(doc);
    fire(container.childNodes[0], 'click', { shiftKey: true, clientX: 42 });
    assert.deepStrictEqual(app.getState().last, {
      type: 'click', value: null, checked: null, key: null,
      shiftKey: true, clientX: 42,
    });
    assert.deepStrictEqual(app.getState().payload, { id: 7 });
  });

  it('resolves absent built-ins to null (a plain click has no shiftKey in the stub)', function () {
    const { app, container } = mount(
      captureDoc({ action: 'capture', event: ['shiftKey'] }));
    fire(container.childNodes[0], 'click');
    assert.strictEqual(app.getState().last.shiftKey, null);
  });

  it('reads selection offsets from event.target', function () {
    const doc = captureDoc({ action: 'capture', event: ['selectionStart', 'selectionEnd'] });
    doc.view = [{
      match: '$',
      body: ['input', { on: { select: { action: 'capture', event: ['selectionStart', 'selectionEnd'] } } }],
    }];
    const { app, container } = mount(doc);
    fire(container.childNodes[0], 'select',
      { target: { value: 'hello', selectionStart: 1, selectionEnd: 4 } });
    assert.deepStrictEqual(app.getState().last, {
      type: 'select', value: 'hello', checked: null, key: null,
      selectionStart: 1, selectionEnd: 4,
    });
  });

  it('an unknown field is JA2009: bound null, dispatch NOT dropped', function () {
    const errors = [];
    const { app, container } = mount(
      captureDoc({ action: 'capture', event: ['shiftKey', 'nope'] }),
      { onError: (err) => errors.push(err) });
    fire(container.childNodes[0], 'click', { shiftKey: false });
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(/** @type {any} */ (errors[0]).code, 'JA2009');
    assert.ok(errors[0] instanceof AppRuntimeError);
    assert.match(errors[0].message, /'nope'/);
    const last = app.getState().last;
    assert.notStrictEqual(last, null, 'the action still ran, the state still transitioned');
    assert.strictEqual(last.nope, null, 'the offending member is bound null');
    assert.strictEqual(last.shiftKey, false, 'the valid fields still resolved');
  });

  it('a malformed "event" member is JA2001: the binding is unusable, dispatch dropped', function () {
    for (const event of ['shiftKey', { 0: 'shiftKey' }, ['shiftKey', 7]]) {
      const errors = [];
      const { app, container } = mount(
        captureDoc({ action: 'capture', event }),
        { onError: (err) => errors.push(err) });
      fire(container.childNodes[0], 'click', { shiftKey: true });
      assert.strictEqual(/** @type {any} */ (errors[0]).code, 'JA2001');
      assert.strictEqual(app.getState().last, null, 'the dispatch was dropped');
    }
  });

  it('options.eventFields extractors provide non-allow-listed names and override built-ins', function () {
    const doc = captureDoc({ action: 'capture', event: ['fileTokens', 'clientX'] });
    const { app, container } = mount(doc, {
      eventFields: {
        fileTokens: (event) => (event.target?.files ?? []).map((f, i) => `file:${i}:${f.name}`),
        clientX: () => 'host wins',
      },
    });
    fire(container.childNodes[0], 'click',
      { clientX: 42, target: { files: [{ name: 'a.png' }, { name: 'b.png' }] } });
    const last = app.getState().last;
    assert.deepStrictEqual(last.fileTokens, ['file:0:a.png', 'file:1:b.png'],
      'the extractor mapped host objects to JSON at the boundary');
    assert.strictEqual(last.clientX, 'host wins',
      'a registered extractor takes precedence over the built-in allow-list');
  });

  it('an extractor returning undefined coerces to null', function () {
    const { app, container } = mount(
      captureDoc({ action: 'capture', event: ['maybe'] }),
      { eventFields: { maybe: () => undefined } });
    fire(container.childNodes[0], 'click');
    assert.strictEqual(app.getState().last.maybe, null);
  });

  it('the whole $event value survives a JSON round-trip', function () {
    const doc = captureDoc({
      action: 'capture',
      event: ['shiftKey', 'ctrlKey', 'metaKey', 'clientX', 'clientY', 'button', 'fileTokens'],
    });
    const { app, container } = mount(doc, {
      eventFields: { fileTokens: () => ['file:0'] },
    });
    fire(container.childNodes[0], 'click',
      { shiftKey: true, ctrlKey: false, clientX: 10, clientY: 20, button: 0 });
    const last = app.getState().last;
    assert.deepStrictEqual(JSON.parse(JSON.stringify(last)), last,
      '$event is JSON end to end, the same invariant as state');
  });

  it('headless dispatch takes the field list as its fourth parameter', function () {
    const app = createApp(captureDoc('capture'), { schedule: sync });
    app.dispatch('capture', null, { type: 'keydown', key: 'a', shiftKey: true }, ['shiftKey']);
    assert.deepStrictEqual(app.getState().last,
      { type: 'keydown', value: null, checked: null, key: 'a', shiftKey: true });
  });

  it('shift-click extends a selection range, plain click replaces it (end to end)', function () {
    const doc = {
      state: {
        rows: [{ id: 'a', i: 0 }, { id: 'b', i: 1 }, { id: 'c', i: 2 }, { id: 'd', i: 3 }],
        anchor: 0, from: 0, to: 0,
      },
      view: [
        { match: '$', body: ['table', {}, [{ $apply: '$.rows[*]' }]] },
        {
          match: '$.rows[*]',
          body: ['tr', {
            key: '$.id',
            on: {
              click: {
                action: 'selectRow',
                with: { i: '$.i' },
                event: ['shiftKey', 'ctrlKey', 'metaKey'],
              },
            },
          }, '$.id'],
        },
      ],
      actions: {
        selectRow: {
          $if: ['$event.shiftKey',
            {
              patch: [
                { op: 'replace', path: '/from', value: { $if: [{ $lt: ['$payload.i', '$.anchor'] }, '$payload.i', '$.anchor'] } },
                { op: 'replace', path: '/to', value: { $if: [{ $gt: ['$payload.i', '$.anchor'] }, '$payload.i', '$.anchor'] } },
              ],
            },
            {
              patch: [
                { op: 'replace', path: '/anchor', value: '$payload.i' },
                { op: 'replace', path: '/from', value: '$payload.i' },
                { op: 'replace', path: '/to', value: '$payload.i' },
              ],
            }],
        },
      },
    };
    const { app, container } = mount(doc);
    const rows = container.childNodes[0].childNodes;
    assert.strictEqual(serialize(rows[0]), '<tr>a</tr>');

    fire(rows[2], 'click', { shiftKey: true });
    assert.deepStrictEqual(
      { from: app.getState().from, to: app.getState().to, anchor: app.getState().anchor },
      { from: 0, to: 2, anchor: 0 }, 'shift-click extends the range from the anchor');

    fire(rows[1], 'click');
    assert.deepStrictEqual(
      { from: app.getState().from, to: app.getState().to, anchor: app.getState().anchor },
      { from: 1, to: 1, anchor: 1 }, 'plain click replaces the selection');

    fire(rows[3], 'click', { shiftKey: true });
    assert.deepStrictEqual(
      { from: app.getState().from, to: app.getState().to, anchor: app.getState().anchor },
      { from: 1, to: 3, anchor: 1 }, 'the next shift-click extends from the new anchor');
  });
});
