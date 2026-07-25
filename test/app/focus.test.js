//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createApp, createFocusEffect, createTransactionLog } from '@jarenjs/app';
import { createStubHost, fire } from '../view/dom.stub.js';

/** Synchronous render scheduler for deterministic assertions. */
const sync = (flush) => flush();

/**
 * An accessible dialog skeleton (APP-FORMAT §8.4): opening moves focus
 * to the dialog's first control through a post-render intent; closing
 * restores it to the opener. The dialog focus-lifecycle contract,
 * exercised headlessly.
 */
function dialogDoc() {
  return {
    state: { open: false },
    view: [{
      match: '$',
      body: ['main', {},
        ['button', {
          'data-ref': 'opener',
          on: { click: 'open' },
        }, 'Open'],
        {
          $if: ['$.open',
            ['div', { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings' },
              ['input', { 'data-ref': 'dialog-first' }],
              ['button', { on: { click: 'close' } }, 'Close'],
            ],
            null],
        },
      ],
    }],
    actions: {
      open: {
        patch: [{ op: 'replace', path: '/open', value: true }],
        effects: [{ run: 'focus', with: { ref: 'dialog-first' } }],
      },
      close: {
        patch: [{ op: 'replace', path: '/open', value: false }],
        effects: [{ run: 'focus', with: { ref: 'opener' } }],
      },
    },
  };
}

function mountWithFocus(doc, options = {}) {
  const { document, container } = createStubHost();
  const focus = createFocusEffect({ container, ...options.focusOptions });
  const app = createApp(doc, {
    node: container, document, schedule: sync,
    effects: { focus, ...(options.effects ?? {}) },
    afterRender: focus.flush,
    ...options.appOptions,
  });
  return { app, container, document, focus };
}

describe('the post-render focus queue (APP-FORMAT §8.4)', function () {
  it('a focus intent resolves against the NEXT committed frame — a target born this transaction is focusable', function () {
    const { app, container, document } = mountWithFocus(dialogDoc());
    fire(container.childNodes[0].childNodes[0], 'click'); // open
    assert.strictEqual(app.getState().open, true);
    assert.strictEqual(document.activeElement?.getAttribute('data-ref'), 'dialog-first',
      'the input rendered by this very transition received focus');
  });

  it('closing restores focus to the opener (the dialog lifecycle contract)', function () {
    const { container, document } = mountWithFocus(dialogDoc());
    fire(container.childNodes[0].childNodes[0], 'click'); // open
    const dialog = container.childNodes[0].childNodes[1];
    fire(dialog.childNodes[1], 'click'); // close
    assert.strictEqual(document.activeElement?.getAttribute('data-ref'), 'opener',
      'focus returned to the element that opened the dialog');
  });

  it('a select intent selects a text control', function () {
    const doc = dialogDoc();
    doc.actions.open.effects = [{ run: 'focus', with: { ref: 'dialog-first', op: 'select' } }];
    const { container, document } = mountWithFocus(doc);
    fire(container.childNodes[0].childNodes[0], 'click');
    assert.strictEqual(/** @type {any} */ (document.activeElement).selected, true);
  });

  it('a measure intent dispatches the JSON-reduced rect', function () {
    const doc = dialogDoc();
    doc.state = { open: false, box: null };
    doc.actions.open.effects = [{ run: 'focus', with: { ref: 'dialog-first', op: 'measure', done: 'measured', id: 9 } }];
    doc.actions.measured = { patch: [{ op: 'replace', path: '/box', value: '$payload' }] };
    const { app, container } = mountWithFocus(doc);
    fire(container.childNodes[0].childNodes[0], 'click');
    assert.deepStrictEqual(app.getState().box, {
      id: 9, ref: 'dialog-first',
      rect: { x: 1, y: 2, width: 30, height: 40, top: 2, left: 1, right: 31, bottom: 42 },
    });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(app.getState().box)), app.getState().box);
  });

  it('a missing target is a diagnosable JA2014, and sibling intents still resolve', function () {
    const errors = [];
    const doc = dialogDoc();
    doc.actions.open.effects = [
      { run: 'focus', with: { ref: 'does-not-exist' } },
      { run: 'focus', with: { ref: 'dialog-first' } },
    ];
    const { container, document } = mountWithFocus(doc, {
      focusOptions: { onError: (err) => errors.push(err) },
    });
    fire(container.childNodes[0].childNodes[0], 'click');
    assert.strictEqual(/** @type {any} */ (errors[0]).code, 'JA2014');
    assert.match(errors[0].message, /does-not-exist/);
    assert.strictEqual(document.activeElement?.getAttribute('data-ref'), 'dialog-first',
      'the valid sibling intent still ran');
  });

  it('app.destroy() disposes the queue: pending intents are canceled', function () {
    const { app, container, document, focus } = mountWithFocus(dialogDoc());
    void focus;
    app.destroy();
    assert.strictEqual(document.activeElement, null);
    fire(container.childNodes?.[0]?.childNodes?.[0] ?? { listeners: new Map() }, 'click');
    assert.strictEqual(document.activeElement, null, 'nothing focuses after destroy');
  });

  it('malformed intents are host programming errors (TypeError → JA2007)', function () {
    const errors = [];
    const doc = dialogDoc();
    doc.actions.open.effects = [{ run: 'focus', with: { op: 'focus' } }]; // no ref
    const { container } = mountWithFocus(doc, {
      appOptions: { onError: (err) => errors.push(err) },
    });
    fire(container.childNodes[0].childNodes[0], 'click');
    assert.strictEqual(/** @type {any} */ (errors[0]).code, 'JA2007');
    assert.ok(errors[0].cause instanceof TypeError);
  });
});

describe('the bounded transaction log (APP-FORMAT §8.3)', function () {
  function counterApp(options = {}) {
    return createApp({
      state: { n: 0 },
      view: [{ match: '$', body: ['p', {}, '$.n'] }],
      actions: { bump: { patch: [{ op: 'replace', path: '/n', value: { $add: ['$.n', 1] } }] } },
    }, { schedule: sync, ...options });
  }

  it('retains at most limit records, oldest falling off, and exports a versioned envelope', function () {
    const log = createTransactionLog({ limit: 2 });
    const app = counterApp();
    app.observe(log.observer);
    app.dispatch('bump');
    app.dispatch('bump');
    app.dispatch('bump');
    const entries = log.entries();
    assert.strictEqual(entries.length, 2);
    assert.deepStrictEqual(entries.map((tx) => tx.seq), [2, 3]);
    const dump = log.export();
    assert.strictEqual(dump.version, 1);
    assert.strictEqual(dump.entries.length, 2);
    log.clear();
    assert.deepStrictEqual(log.entries(), []);
  });

  it('the redaction hook rewrites or drops records before retention', function () {
    const log = createTransactionLog({
      redact: (tx) => (tx.seq === 1 ? null : { ...tx, action: '[redacted]' }),
    });
    const app = counterApp();
    app.observe(log.observer);
    app.dispatch('bump');
    app.dispatch('bump');
    const entries = log.entries();
    assert.strictEqual(entries.length, 1, 'the first record was dropped');
    assert.strictEqual(entries[0].action, '[redacted]');
  });

  it('rejects a non-positive limit', function () {
    assert.throws(() => createTransactionLog({ limit: 0 }), TypeError);
  });
});
