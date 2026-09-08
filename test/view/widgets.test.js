//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createDomRenderer, renderToString, isWidgetNode, WIDGET_TAG } from '@jarenjs/view';
import { createStubHost, serialize } from './dom.stub.js';

/**
 * A recording widget definition: every lifecycle call lands in `log` as
 * `[name, hook, ...detail]`, and mount returns a fresh handle object so
 * handle threading is observable.
 */
function recorder(name, log, overrides = {}) {
  return {
    mount(host, props, emit) {
      log.push([name, 'mount', props]);
      return { name, host, emit };
    },
    update(handle, props, prevProps) {
      log.push([name, 'update', props, prevProps, handle]);
    },
    unmount(handle) {
      log.push([name, 'unmount', handle]);
    },
    ...overrides,
  };
}

function host(widgets, onEvent) {
  const { document, container } = createStubHost();
  const render = createDomRenderer(container, { document, widgets, onEvent });
  return { container, render };
}

describe('widget vnodes (VIEW-FORMAT §7)', function () {
  it('classifies widget nodes: isWidgetNode and the reserved tag', function () {
    assert.strictEqual(WIDGET_TAG, 'jaren-widget');
    assert.strictEqual(isWidgetNode(['jaren-widget', { name: 'w' }]), true);
    assert.strictEqual(isWidgetNode(['div', { name: 'w' }]), false);
    assert.strictEqual(isWidgetNode('jaren-widget'), false);
  });

  it('mounts once, after the host is connected to the container', function () {
    const log = [];
    const { container, render } = host({
      probe: {
        mount(node) {
          let root = node;
          while (root.parentNode !== null) root = root.parentNode;
          log.push(['probe', 'mount', root === container ? 'connected' : 'detached']);
          return {};
        },
      },
    });
    render(['div', {}, ['section', {}, ['jaren-widget', { name: 'probe' }]]]);
    render(['div', {}, ['section', {}, ['jaren-widget', { name: 'probe' }]]]);
    assert.deepStrictEqual(log, [['probe', 'mount', 'connected']],
      'exactly one mount, with the host already reachable from the container');
  });

  it('applies host props to the host element; widget-local members never reach the DOM', function () {
    const { container, render } = host({ w: recorder('w', []) });
    render(['jaren-widget', {
      name: 'w', props: { a: 1 }, tag: 'section',
      key: 'k', class: 'grid-host', id: 'g1',
    }]);
    assert.strictEqual(serialize(container),
      '<div><section class="grid-host" id="g1"></section></div>');
  });

  it('reference-equal props across renders never poke the widget', function () {
    const log = [];
    const props = { rows: [1, 2, 3] };
    const { render } = host({ w: recorder('w', log) });
    render(['main', {}, ['p', {}, 'a'], ['jaren-widget', { name: 'w', key: 'w', props }]]);
    render(['main', {}, ['p', {}, 'b'], ['jaren-widget', { name: 'w', key: 'w', props }]]);
    assert.deepStrictEqual(log, [['w', 'mount', props]], 'mount only — no update');
  });

  it('a changed props reference calls update(handle, props, prevProps) with the mount handle', function () {
    const log = [];
    const p1 = { n: 1 };
    const p2 = { n: 2 };
    const { render } = host({ w: recorder('w', log) });
    render(['jaren-widget', { name: 'w', props: p1 }]);
    render(['jaren-widget', { name: 'w', props: p2 }]);
    assert.strictEqual(log.length, 2);
    assert.deepStrictEqual(log[0].slice(0, 3), ['w', 'mount', p1]);
    const [, hook, props, prevProps, handle] = log[1];
    assert.strictEqual(hook, 'update');
    assert.strictEqual(props, p2);
    assert.strictEqual(prevProps, p1);
    assert.strictEqual(handle.name, 'w', 'the same handle mount returned');
  });

  it('without an update hook, changed props unmount and remount into the same host', function () {
    const log = [];
    const hosts = [];
    const { render } = host({
      w: {
        mount(node, props) { hosts.push(node); log.push(['mount', props]); return { id: hosts.length }; },
        unmount(handle) { log.push(['unmount', handle.id]); },
      },
    });
    render(['jaren-widget', { name: 'w', props: { n: 1 } }]);
    render(['jaren-widget', { name: 'w', props: { n: 2 } }]);
    assert.deepStrictEqual(log, [
      ['mount', { n: 1 }], ['unmount', 1], ['mount', { n: 2 }],
    ]);
    assert.strictEqual(hosts[0], hosts[1], 'the SAME host element is recycled');
  });

  it('a name change under the same key replaces: old unmounted, new mounted', function () {
    const log = [];
    const { render } = host({ a: recorder('a', log), b: recorder('b', log) });
    render(['jaren-widget', { name: 'a', key: 'k', props: 1 }]);
    render(['jaren-widget', { name: 'b', key: 'k', props: 2 }]);
    assert.deepStrictEqual(log.map((c) => [c[0], c[1]]),
      [['a', 'mount'], ['a', 'unmount'], ['b', 'mount']]);
  });

  it('inserts before the live tail when a keyed widget replaces its host', function () {
    const log = [];
    const { container, render } = host({ w: recorder('w', log) });
    render(['main', {},
      ['p', { key: 'a' }, 'A'],
      ['jaren-widget', { key: 'w', name: 'w', tag: 'div' }]]);
    render(['main', {},
      ['p', { key: 'a' }, 'A'],
      ['p', { key: 'b' }, 'B'],
      ['jaren-widget', { key: 'w', name: 'w', tag: 'section' }]]);
    assert.strictEqual(serialize(container),
      '<div><main><p>A</p><p>B</p><section></section></main></div>');
    assert.deepStrictEqual(log.map((call) => call[1]), ['mount', 'unmount', 'mount']);
  });

  it('inserts before a poisoned keyed tail widget when recovery replaces it', function () {
    const log = [];
    let mounts = 0;
    const { container, render } = host({
      w: {
        mount() {
          mounts++;
          log.push('mount');
          if (mounts === 1) throw new Error('first mount failed');
          return {};
        },
        unmount() { log.push('unmount'); },
      },
    });
    const widget = ['jaren-widget', { key: 'w', name: 'w' }];
    assert.throws(() => render(['main', {}, ['p', { key: 'a' }, 'A'], widget]),
      /first mount failed/);
    render(['main', {}, ['p', { key: 'a' }, 'A'], ['p', { key: 'b' }, 'B'], widget]);
    assert.strictEqual(serialize(container),
      '<div><main><p>A</p><p>B</p><div></div></main></div>');
    assert.deepStrictEqual(log, ['mount', 'mount']);
    render.destroy();
    assert.deepStrictEqual(log, ['mount', 'mount', 'unmount']);
  });

  it('patches host props (class) without any widget call', function () {
    const log = [];
    const props = { n: 1 };
    const { container, render } = host({ w: recorder('w', log) });
    render(['jaren-widget', { name: 'w', props, class: 'cold' }]);
    render(['jaren-widget', { name: 'w', props, class: 'hot' }]);
    assert.strictEqual(serialize(container), '<div><div class="hot"></div></div>');
    assert.strictEqual(log.length, 1, 'mount only');
  });

  it('unmounts a widget dropped from a child list, releasing its timer and listener', function () {
    const activeTimers = new Set();
    const log = [];
    const { container, render } = host({
      w: {
        mount(node) {
          const timer = {};
          activeTimers.add(timer);
          const onScroll = () => {};
          node.addEventListener('scroll', onScroll);
          return { node, timer, onScroll };
        },
        unmount(handle) {
          log.push('unmount');
          activeTimers.delete(handle.timer);
          handle.node.removeEventListener('scroll', handle.onScroll);
        },
      },
    });
    render(['ul', {},
      ['li', { key: 1 }, 'a'],
      ['jaren-widget', { name: 'w', key: 'w' }],
      ['li', { key: 2 }, 'b']]);
    const widgetHost = container.childNodes[0].childNodes[1];
    assert.strictEqual(widgetHost.listeners.get('scroll').size, 1);
    assert.strictEqual(activeTimers.size, 1);
    render(['ul', {}, ['li', { key: 1 }, 'a'], ['li', { key: 2 }, 'b']]);
    assert.deepStrictEqual(log, ['unmount'], 'exactly once');
    assert.strictEqual(activeTimers.size, 0, 'the timer died');
    assert.strictEqual(widgetHost.listeners.get('scroll').size, 0, 'the listener died');
  });

  it('unmounts a widget nested two elements deep inside a replaced subtree', function () {
    const log = [];
    const { render } = host({ w: recorder('w', log) });
    render(['main', {},
      ['section', {}, ['div', {}, ['jaren-widget', { name: 'w', props: 1 }]]]]);
    render(['main', {}, ['p', {}, 'replaced']]);
    assert.deepStrictEqual(log.map((c) => [c[0], c[1]]),
      [['w', 'mount'], ['w', 'unmount']], 'exactly once, through the ancestor replace');
  });

  it('a throwing unmount does not leak its siblings; the error surfaces after the walk', function () {
    const order = [];
    const def = (name, boom) => ({
      mount() { return {}; },
      unmount() {
        order.push(name);
        if (boom) throw new Error(`boom:${name}`);
      },
    });
    const { render } = host({ a: def('a', false), b: def('b', true), c: def('c', false) });
    render(['div', {},
      ['jaren-widget', { name: 'a', key: 'a' }],
      ['jaren-widget', { name: 'b', key: 'b' }],
      ['jaren-widget', { name: 'c', key: 'c' }]]);
    assert.throws(() => render(['div', {}]), /boom:b/,
      'the first captured error is rethrown after the frame settles');
    assert.deepStrictEqual(order, ['a', 'b', 'c'], 'every sibling still unmounted');
  });

  it('emit delivers (binding, event) verbatim to onEvent', function () {
    const seen = [];
    const binding = { action: 'pick', with: { id: 7 } };
    const nativeEvent = { type: 'click', shiftKey: true };
    let emitFn = null;
    const { render } = host(
      { w: { mount(node, props, emit) { emitFn = emit; return {}; } } },
      (b, e) => seen.push([b, e]));
    render(['jaren-widget', { name: 'w' }]);
    emitFn(binding, nativeEvent);
    emitFn(binding);
    assert.strictEqual(seen.length, 2);
    assert.strictEqual(seen[0][0], binding, 'the binding object, by reference');
    assert.strictEqual(seen[0][1], nativeEvent, 'the native event, by reference');
    assert.strictEqual(seen[1][1], undefined, 'no event emits nothing in its place');
  });

  it('emit without an onEvent hook is a safe no-op', function () {
    let emitFn = null;
    const { render } = host({ w: { mount(node, props, emit) { emitFn = emit; return {}; } } });
    render(['jaren-widget', { name: 'w' }]);
    assert.doesNotThrow(() => emitFn({ action: 'pick' }, { type: 'click' }));
  });

  it('rejects vnode children under jaren-widget and unregistered or missing names', function () {
    const { render } = host({ w: recorder('w', []) });
    assert.throws(() => render(['jaren-widget', { name: 'w' }, ['div', {}]]),
      /must not have vnode children/);
    assert.throws(() => render(['jaren-widget', { name: 'nope' }]),
      /unregistered widget 'nope'/);
    assert.throws(() => render(['jaren-widget', {}]),
      /non-empty "name"/);
  });

  it('renderToString serializes the ssr fallback of a registered widget', function () {
    const widgets = {
      list: {
        mount() { return {}; },
        ssr: (props) => ['ul', { class: 'list' },
          [(props.items ?? []).map((item) => ['li', {}, item])]],
      },
    };
    const vnode = ['main', {},
      ['jaren-widget', { name: 'list', class: 'viewport', props: { items: ['a', 'b'] } }]];
    assert.strictEqual(renderToString(vnode, { widgets }),
      '<main><div class="viewport"><ul class="list"><li>a</li><li>b</li></ul></div></main>');
  });

  it('renderToString without ssr, and without a registry, serializes an empty host', function () {
    const vnode = ['jaren-widget', { name: 'list', tag: 'section', class: 'viewport', props: 1 }];
    assert.strictEqual(renderToString(vnode, { widgets: { list: { mount() { return {}; } } } }),
      '<section class="viewport"></section>');
    assert.strictEqual(renderToString(vnode), '<section class="viewport"></section>');
  });
});
