//@ts-check
/**
 * @file Terminal-destroy closure probes (VIEW-FORMAT §7.3.1): a
 * `destroy()` requested inside a widget hook is terminal regardless of
 * how the aborted pass diverged from the committed DOM. Teardown is
 * OWNERSHIP-based — it drains what the renderer actually acquired (the
 * widget-host markers in the live DOM), never a vnode that may be old,
 * new or partially committed — so every successfully mounted widget
 * unmounts exactly once, pending mounts are canceled, the container
 * ends empty, a throwing unmount never skips siblings, and no raw
 * traversal error can escape.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createApp } from '@jarenjs/app';
import { createDomRenderer } from '@jarenjs/view';
import { createStubHost, serialize } from '../view/dom.stub.js';

function scenario(nextChildren) {
  const { document, container } = createStubHost();
  const log = [];
  let render;
  const widget = (id, n) => [
    'jaren-widget',
    { name: 'probe', key: id, props: { id, n } },
  ];

  render = createDomRenderer(container, {
    document,
    widgets: {
      probe: {
        mount(_node, props) {
          log.push(`mount:${props.id}`);
          return { id: props.id };
        },
        update(handle, props) {
          log.push(`update:${props.id}`);
          if (props.id === 'a') render.destroy();
          handle.id = props.id;
        },
        unmount(handle) {
          log.push(`unmount:${handle.id}`);
        },
      },
    },
  });

  render(['div', {}, widget('a', 0), widget('b', 0)]);
  let error = null;
  try {
    render(['div', {}, ...nextChildren(widget)]);
  }
  catch (caught) {
    error = caught;
  }
  return { log, error, container, render };
}

describe('VIEW-FORMAT terminal destroy under an aborted structural patch', () => {
  it('unmounts an old sibling omitted by the desired tree', () => {
    const result = scenario((widget) => [widget('a', 1)]);
    assert.strictEqual(result.error, null);
    assert.deepStrictEqual(result.log.slice(0, 3), [
      'mount:a', 'mount:b', 'update:a',
    ]);
    assert.deepStrictEqual([...result.log.slice(3)].sort(), [
      'unmount:a', 'unmount:b',
    ]);
    assert.strictEqual(serialize(result.container), '<div></div>');
  });

  it('survives an insertion and tears down every old widget', () => {
    const result = scenario((widget) => [
      widget('a', 1),
      ['span', { key: 'inserted' }, 'x'],
      widget('b', 1),
    ]);
    assert.strictEqual(result.error, null);
    assert.deepStrictEqual(result.log.slice(0, 3), [
      'mount:a', 'mount:b', 'update:a',
    ]);
    assert.deepStrictEqual([...result.log.slice(3)].sort(), [
      'unmount:a', 'unmount:b',
    ]);
    assert.strictEqual(serialize(result.container), '<div></div>');

    const settledLogLength = result.log.length;
    result.render(['p', {}, 'later']);
    assert.strictEqual(serialize(result.container), '<div></div>');
    assert.strictEqual(result.log.length, settledLogLength);
  });

  it('replacement and keyed reorder after the destroying widget still tear down fully', () => {
    // replacement: b's slot becomes an ordinary element
    const replaced = scenario((widget) => [
      widget('a', 1),
      ['p', { key: 'replacement' }, 'y'],
    ]);
    assert.strictEqual(replaced.error, null);
    assert.deepStrictEqual([...replaced.log.slice(3)].sort(), [
      'unmount:a', 'unmount:b',
    ]);
    assert.strictEqual(serialize(replaced.container), '<div></div>');

    // keyed reorder: the tail-move path reaches a first, then destroys
    const reordered = scenario((widget) => [widget('b', 1), widget('a', 1)]);
    assert.strictEqual(reordered.error, null);
    assert.strictEqual(
      reordered.log.filter((entry) => entry === 'update:b').length, 0,
      'no sibling update after destroy was requested');
    assert.deepStrictEqual([...reordered.log.slice(3)].sort(), [
      'unmount:a', 'unmount:b',
    ]);
    assert.strictEqual(serialize(reordered.container), '<div></div>');
  });

  it('a structural change BEFORE the destroying widget leaks nothing, nested widgets included', () => {
    const { document, container } = createStubHost();
    const log = [];
    let render;
    const probe = (id, n) => ['jaren-widget', { name: 'probe', key: id, props: { id, n } }];
    render = createDomRenderer(container, {
      document,
      widgets: {
        probe: {
          mount(_node, props) { log.push(`mount:${props.id}`); return { id: props.id }; },
          update(handle, props) {
            log.push(`update:${props.id}`);
            if (props.id === 'a') render.destroy();
          },
          unmount(handle) { log.push(`unmount:${handle.id}`); },
        },
      },
    });
    // the nested widget c lives inside an ordinary element BEFORE a
    render(['div', {},
      ['section', { key: 's' }, probe('c', 0)],
      probe('a', 0),
    ]);
    // the section keeps its identity but drops its child, so the
    // removal of c is GENUINELY APPLIED (unmount + removeChild) before
    // the walk reaches a, whose update then destroys the renderer —
    // the aborted pass follows a real structural change, not a
    // tail-match shortcut
    render(['div', {},
      ['section', { key: 's' }],
      probe('a', 1),
    ]);
    assert.deepStrictEqual(log, ['mount:c', 'mount:a', 'unmount:c', 'update:a', 'unmount:a'],
      'c was removed by the applied patch before the destroyer ran; teardown then owned only a');
    assert.strictEqual(serialize(container), '<div></div>');
  });

  it('destroy requested inside mount is terminal; the returned handle still unmounts once, pending mounts cancel', () => {
    const { document, container } = createStubHost();
    const log = [];
    let render;
    render = createDomRenderer(container, {
      document,
      widgets: {
        probe: {
          mount(_node, props) {
            log.push(`mount:${props.id}`);
            if (props.id === 'a') render.destroy();
            return { id: props.id };
          },
          unmount(handle) { log.push(`unmount:${handle.id}`); },
        },
      },
    });
    render(['div', {},
      ['jaren-widget', { name: 'probe', key: 'a', props: { id: 'a' } }],
      ['jaren-widget', { name: 'probe', key: 'b', props: { id: 'b' } }],
    ]);
    assert.deepStrictEqual(log, ['mount:a', 'unmount:a'],
      'the pending sibling mount was canceled; the destroyer unmounted exactly once');
    assert.strictEqual(serialize(container), '<div></div>');
  });

  it('a throwing unmount during the deferred teardown cleans every sibling first, container still empties', () => {
    const { document, container } = createStubHost();
    const log = [];
    let render;
    const probe = (id, n) => ['jaren-widget', { name: 'probe', key: id, props: { id, n } }];
    render = createDomRenderer(container, {
      document,
      widgets: {
        probe: {
          mount(_node, props) { return { id: props.id }; },
          update(handle, props) {
            if (props.id === 'a') render.destroy();
          },
          unmount(handle) {
            log.push(`unmount:${handle.id}`);
            if (handle.id === 'a') throw new Error('unmount boom');
          },
        },
      },
    });
    render(['div', {}, probe('a', 0), probe('b', 0)]);
    assert.throws(() => render(['div', {}, probe('a', 1)]), /unmount boom/,
      'the first unmount error surfaces after the teardown completes');
    assert.deepStrictEqual([...log].sort(), ['unmount:a', 'unmount:b'],
      'the throwing unmount never skipped its sibling');
    assert.strictEqual(serialize(container), '<div></div>');
  });

  it('app.destroy() from a widget update under a structural change: clean teardown, no error, exact no-ops after', () => {
    const { document, container } = createStubHost();
    const log = [];
    const reported = [];
    /** @type {any} */
    let app = null;
    app = createApp({
      // `$.extra` is the empty sequence at boot, so the text child only
      // exists after the dispatch — a structural change after the widget
      state: { n: 0 },
      view: [{
        match: '$',
        body: ['div', {},
          ['jaren-widget', { name: 'probe', props: { n: '$.n' } }],
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
          mount(_node, props) { log.push(`mount:${props.n}`); return { n: props.n }; },
          update(handle, props) {
            log.push(`update:${props.n}`);
            app.destroy();
          },
          unmount(handle) { log.push(`unmount:${handle.n}`); },
        },
      },
    });

    app.dispatch('grow');

    assert.deepStrictEqual(log, ['mount:0', 'update:1', 'unmount:0'],
      'the widget unmounted exactly once through the app teardown');
    assert.strictEqual(serialize(container), '<div></div>');
    assert.deepStrictEqual(reported, [],
      'a nonthrowing teardown reports nothing — no code-less traversal error exists');
    app.dispatch('grow'); // the destroyed app ignores dispatches
    assert.strictEqual(serialize(container), '<div></div>');
    assert.deepStrictEqual(log, ['mount:0', 'update:1', 'unmount:0']);
  });
});
