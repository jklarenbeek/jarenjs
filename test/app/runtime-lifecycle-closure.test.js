//@ts-check
/**
 * @file Terminal-lifecycle cross-product probes: the no-`update`
 * fallback may not start a fresh `mount` after its `unmount` requested
 * destroy (and must not double-unmount the ended acquisition), a
 * deferred app teardown failure carries `JA2012` provenance with the
 * first cleanup cause preserved by identity, an `unmount` that
 * detaches its own host cannot make the hardened walk skip a sibling,
 * and an ordinary update error thrown after requesting destroy stays
 * distinguishable from a cleanup failure.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { AppRuntimeError, createApp } from '@jarenjs/app';
import { createDomRenderer } from '@jarenjs/view';
import { createStubHost, serialize } from '../view/dom.stub.js';

describe('terminal lifecycle cross-products', () => {
  it('does not remount after fallback unmount requests destroy', () => {
    const { document, container } = createStubHost();
    const log = [];
    let nextId = 0;
    let render;

    render = createDomRenderer(container, {
      document,
      widgets: {
        probe: {
          mount(_node, props) {
            const handle = { id: nextId++, n: props.n };
            log.push(`mount:${handle.id}:${handle.n}`);
            return handle;
          },
          // No update(): changed props take the required fallback.
          unmount(handle) {
            log.push(`unmount:${handle.id}:${handle.n}`);
            if (handle.id === 0) render.destroy();
          },
        },
      },
    });

    render(['jaren-widget', { name: 'probe', props: { n: 0 } }]);
    render(['jaren-widget', { name: 'probe', props: { n: 1 } }]);

    assert.deepStrictEqual(log, ['mount:0:0', 'unmount:0:0'],
      'terminal destroy starts no fresh lifecycle and does not double-unmount');
    assert.strictEqual(serialize(container), '<div></div>');
    render(['p', {}, 'later']);
    assert.deepStrictEqual(log, ['mount:0:0', 'unmount:0:0']);
    assert.strictEqual(serialize(container), '<div></div>');
  });

  it('routes deferred app teardown failure as one JA2012 after cleanup', () => {
    const { document, container } = createStubHost();
    const log = [];
    const reported = [];
    const cleanupCause = new Error('unmount boom');
    let app;

    app = createApp({
      state: { n: 0 },
      view: [{
        match: '$',
        body: ['div', {},
          ['jaren-widget', {
            name: 'probe', key: 'a', props: { id: 'a', n: '$.n' },
          }],
          ['jaren-widget', {
            name: 'probe', key: 'b', props: { id: 'b', n: '$.n' },
          }],
          '$.extra',
        ],
      }],
      actions: {
        grow: { state: { n: 1, extra: 'x' } },
      },
    }, {
      node: container,
      document,
      schedule: (flush) => flush(),
      onError: (error) => reported.push(error),
      widgets: {
        probe: {
          mount(_node, props) {
            log.push(`mount:${props.id}`);
            return { id: props.id };
          },
          update(_handle, props) {
            log.push(`update:${props.id}`);
            if (props.id === 'a') app.destroy();
          },
          unmount(handle) {
            log.push(`unmount:${handle.id}`);
            if (handle.id === 'a') throw cleanupCause;
          },
        },
      },
    });

    app.dispatch('grow');

    assert.deepStrictEqual(log, [
      'mount:a', 'mount:b', 'update:a', 'unmount:a', 'unmount:b',
    ]);
    assert.strictEqual(serialize(container), '<div></div>');
    assert.strictEqual(reported.length, 1);
    assert.ok(reported[0] instanceof AppRuntimeError);
    assert.strictEqual(reported[0].code, 'JA2012');
    assert.strictEqual(reported[0].cause, cleanupCause);
  });

  it('does not skip siblings when unmount detaches its own host', () => {
    const { document, container } = createStubHost();
    const log = [];
    const widget = (id) => [
      'jaren-widget', { name: 'probe', key: id, props: { id } },
    ];
    const render = createDomRenderer(container, {
      document,
      widgets: {
        probe: {
          mount(node, props) { return { node, id: props.id }; },
          unmount(handle) {
            log.push(`unmount:${handle.id}`);
            handle.node.parentNode?.removeChild(handle.node);
          },
        },
      },
    });

    render(['div', {}, widget('a'), widget('b'), widget('c')]);
    render.destroy();

    assert.deepStrictEqual(log.sort(), ['unmount:a', 'unmount:b', 'unmount:c']);
    assert.strictEqual(serialize(container), '<div></div>');
  });

  it('an ordinary update error after requesting destroy is not mislabeled as cleanup', () => {
    const { document, container } = createStubHost();
    const reported = [];
    let app;
    app = createApp({
      state: { n: 0 },
      view: [{
        match: '$',
        body: ['div', {},
          ['jaren-widget', { name: 'probe', props: { n: '$.n' } }],
        ],
      }],
      actions: { bump: { state: { n: 1 } } },
    }, {
      node: container,
      document,
      schedule: (flush) => flush(),
      onError: (error) => reported.push(error),
      widgets: {
        probe: {
          mount() { return {}; },
          update() {
            app.destroy();
            throw new Error('update boom');
          },
          unmount() {},
        },
      },
    });

    app.dispatch('bump');

    assert.strictEqual(serialize(container), '<div></div>');
    assert.strictEqual(reported.length, 1);
    assert.strictEqual(reported[0].message, 'update boom',
      'the widget/render failure surfaces as itself');
    assert.notStrictEqual(/** @type {any} */ (reported[0]).code, 'JA2012',
      'a render-phase error is never dressed up as a cleanup failure');
  });
});
