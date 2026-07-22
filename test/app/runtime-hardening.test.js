//@ts-check
/**
 * @file Adversarial runtime-hardening probes for the app/view
 * ownership boundaries: boot atomicity for queued work, renderer
 * serialization, widget failure policy, validator/extractor/
 * deferred-render error boundaries, native-modifier ordering, option
 * validation and focus-sink isolation. Each test states a normative
 * contract (APP-FORMAT §8, VIEW-FORMAT §7) and intentionally probes
 * its failure edges.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createApp, createFocusEffect } from '@jarenjs/app';
import { createDomRenderer } from '@jarenjs/view';
import { createStubHost, serialize, fire } from '../view/dom.stub.js';

const sync = (flush) => flush();
const widgetVnode = (n) => [
  'jaren-widget', { name: 'probe', props: { n } },
];

/** Drain the microtask queue (no wall-clock timers anywhere here). */
async function drain() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('boot, renderer and validator atomicity probes', function () {
  it('rolls back when a boot subscription queues a failing action', function () {
    const { document, container } = createStubHost();
    const log = [];

    assert.throws(() => createApp({
      state: {},
      view: [{ match: '$', body: ['main', {}, 'booted'] }],
      actions: {},
      subs: [{ run: 'eager' }],
    }, {
      node: container,
      document,
      schedule: sync,
      subs: {
        eager: (props, dispatch) => {
          log.push('started');
          dispatch('missing');
          return () => log.push('cleaned');
        },
      },
    }), (error) => error?.code === 'JA0007' && error.cause?.code === 'JA2001');

    assert.deepStrictEqual(log, ['started', 'cleaned']);
    assert.strictEqual(serialize(container), '<div></div>');
  });

  it('serializes direct mount/update reentrancy at the renderer boundary', function () {
    {
      const { document, container } = createStubHost();
      const calls = [];
      let render;
      render = createDomRenderer(container, {
        document,
        onEvent: () => render(widgetVnode(1)),
        widgets: {
          probe: {
            mount(node, props, emit) {
              calls.push(['mount-before', props.n]);
              emit('nested');
              calls.push(['mount-after', props.n]);
              return { n: props.n, emit };
            },
            update(handle, props, previous) {
              calls.push(['update', handle?.n ?? null, props.n, previous.n]);
              handle.n = props.n;
            },
          },
        },
      });
      render(widgetVnode(0));
      assert.deepStrictEqual(calls, [
        ['mount-before', 0],
        ['mount-after', 0],
        ['update', 0, 1, 0],
      ]);
    }

    {
      const { document, container } = createStubHost();
      const updates = [];
      let handle;
      let render;
      render = createDomRenderer(container, {
        document,
        onEvent: () => render(widgetVnode(2)),
        widgets: {
          probe: {
            mount(node, props, emit) {
              handle = { n: props.n, emit };
              return handle;
            },
            update(current, props, previous) {
              updates.push([props.n, previous.n]);
              if (props.n === 1) current.emit('nested');
              current.n = props.n;
            },
          },
        },
      });
      render(widgetVnode(0));
      render(widgetVnode(1));
      assert.deepStrictEqual(updates, [[1, 0], [2, 1]]);
      assert.strictEqual(handle.n, 2);
      render(widgetVnode(3));
      assert.deepStrictEqual(updates.at(-1), [3, 2]);
    }
  });

  it('isolates a throwing validator and drains already queued work', function () {
    const reported = [];
    const observed = [];
    const app = createApp({
      state: { n: 0 },
      view: [{ match: '$', body: ['p', {}, '$.n'] }],
      actions: {
        start: {
          patch: [{ op: 'replace', path: '/n', value: 1 }],
          effects: [{ run: 'queue' }],
        },
        bad: { patch: [{ op: 'replace', path: '/n', value: 2 }] },
        good: { patch: [{ op: 'replace', path: '/n', value: 3 }] },
      },
    }, {
      schedule: sync,
      onError: (error) => reported.push(error),
      effects: {
        queue: (props, dispatch) => {
          dispatch('bad');
          dispatch('good');
        },
      },
      validateState: (next, context) => {
        if (context.action === 'bad') throw new Error('validator boom');
        return true;
      },
    });
    app.observe((transaction) => observed.push(transaction));

    app.dispatch('start');

    assert.strictEqual(app.getState().n, 3);
    assert.strictEqual(reported.length, 1);
    assert.strictEqual(reported[0].code, 'JA2015');
    assert.strictEqual(reported[0].cause?.message, 'validator boom');

    const relevant = observed.map(({ action, status }) => ({ action, status }));
    assert.strictEqual(relevant[0].action, 'start');
    assert.strictEqual(relevant[0].status, 'applied');
    assert.strictEqual(relevant[1].action, 'bad');
    assert.strictEqual(relevant[1].status, 'failed');
    assert.strictEqual(relevant[2].action, 'good');
    assert.strictEqual(relevant[2].status, 'applied');

    app.destroy();
  });
});

describe('boot ownership edges (APP-FORMAT §8.2)', function () {
  it('validates the initial state with the boot context; a rejection aborts boot as JA0007(JA2005)', function () {
    const contexts = [];
    assert.throws(() => createApp({
      state: { n: -1 },
      view: [{ match: '$', body: ['p', {}, 'x'] }],
    }, {
      schedule: sync,
      validateState: (next, context) => {
        contexts.push(context);
        return next.n >= 0;
      },
    }), (error) => error?.code === 'JA0007' && error.cause?.code === 'JA2005');
    assert.deepStrictEqual(contexts, [
      { previous: null, action: null, payload: null, changes: null },
    ]);
  });

  it('a throwing validator at boot aborts as JA0007(JA2015); a swallowing sink boots on', function () {
    const doc = { state: {}, view: [{ match: '$', body: ['p', {}, 'x'] }] };
    const boom = () => { throw new Error('boot validator boom'); };
    assert.throws(() => createApp(doc, { schedule: sync, validateState: boom }),
      (error) => error?.code === 'JA0007' && error.cause?.code === 'JA2015');

    const swallowed = [];
    const app = createApp(doc, {
      schedule: sync,
      validateState: boom,
      onError: (error) => swallowed.push(error.code),
    });
    assert.deepStrictEqual(swallowed, ['JA2015']);
    app.destroy();
  });

  it('a renderer-construction failure is JA0007 and disposes effect handlers', function () {
    const disposed = [];
    const handler = () => {};
    handler.dispose = () => disposed.push('effect');
    // a node without ownerDocument and no options.document: the
    // renderer cannot create nodes — construction-time host failure
    const badNode = Object.freeze({});
    assert.throws(() => createApp({
      state: {},
      view: [{ match: '$', body: ['p', {}, 'x'] }],
    }, {
      node: badNode,
      schedule: sync,
      effects: { fetch: handler },
    }), (error) => error?.code === 'JA0007');
    assert.deepStrictEqual(disposed, ['effect']);
  });
});

describe('event and option edges (APP-FORMAT §4/§8.1)', function () {
  it('an unknown action applies no native modifiers; a registered-but-failing action keeps them', function () {
    const { document, container } = createStubHost();
    const reported = [];
    const view = [{
      match: '$',
      body: ['main', {},
        ['a', {
          on: { click: { action: 'nope', preventDefault: true, stopPropagation: true } },
        }, 'x'],
        ['b', {
          on: { click: { action: 'boom', preventDefault: true } },
        }, 'y'],
      ],
    }];
    createApp({
      state: {},
      view,
      // registered, compiles, fails at runtime: the patch path is absent
      actions: { boom: { patch: [{ op: 'replace', path: '/no/such/member', value: 1 }] } },
    }, {
      node: container,
      document,
      schedule: sync,
      onError: (error) => reported.push(error.code),
    });

    const main = container.childNodes[0];
    let prevented = 0;
    let stopped = 0;
    fire(main.childNodes[0], 'click', {
      preventDefault: () => prevented++,
      stopPropagation: () => stopped++,
    });
    assert.strictEqual(prevented, 0, 'an unknown action owns no native behavior');
    assert.strictEqual(stopped, 0);
    assert.ok(reported.includes('JA2001'));

    fire(main.childNodes[1], 'click', {
      preventDefault: () => prevented++,
    });
    assert.strictEqual(prevented, 1,
      'a registered action keeps its already-applied modifiers even though it later failed');
    assert.ok(reported.includes('JA2004'));
  });

  it('a throwing eventFields extractor is JA2002 through onError; the dispatch still runs with null', function () {
    const reported = [];
    const seen = [];
    const app = createApp({
      state: { got: null },
      view: [{ match: '$', body: ['p', {}, 'x'] }],
      actions: {
        pick: { state: { got: '$event.tokens' } },
      },
    }, {
      schedule: sync,
      onError: (error) => reported.push(error),
      eventFields: {
        tokens: () => { throw new Error('registry unavailable'); },
      },
    });
    app.subscribe((state) => seen.push(state.got));
    app.dispatch('pick', null, { type: 'change' }, ['tokens']);

    assert.strictEqual(reported.length, 1);
    assert.strictEqual(reported[0].code, 'JA2002');
    assert.strictEqual(reported[0].cause?.message, 'registry unavailable');
    assert.deepStrictEqual(seen, [null], 'the member bound null; the dispatch was not dropped');
    app.destroy();
  });

  it('rejects a maxTurns that is not a positive finite integer', function () {
    const doc = { state: {}, view: [{ match: '$', body: ['p', {}, 'x'] }] };
    for (const bad of [NaN, '50', 2.5, 0, -1, Infinity]) {
      assert.throws(() => createApp(doc, { maxTurns: /** @type {any} */ (bad) }),
        TypeError, `maxTurns ${String(bad)} must be rejected`);
    }
    createApp(doc, { schedule: sync, maxTurns: 1 }).destroy();
  });

  it('a deferred (async-scheduler) render failure reaches onError instead of escaping raw', async function () {
    const { document, container } = createStubHost();
    const reported = [];
    const app = createApp({
      state: { n: 0 },
      view: [{ match: '$', body: ['jaren-widget', { name: 'probe', props: { n: '$.n' } }] }],
      actions: { bump: { patch: [{ op: 'replace', path: '/n', value: '$payload' }] } },
    }, {
      node: container,
      document,
      onError: (error) => reported.push(error),
      widgets: {
        probe: {
          mount: () => ({}),
          update: () => { throw new Error('update boom'); },
        },
      },
    });
    await drain(); // the boot frame committed through the default scheduler
    app.dispatch('bump', 1);
    await drain().catch(() => {});
    assert.strictEqual(reported.length, 1);
    assert.strictEqual(reported[0].message, 'update boom');
    app.destroy();
  });
});

describe('widget failure policy (VIEW-FORMAT §7.3)', function () {
  it('a throwing mount poisons the widget: siblings mount, the error surfaces, the next render replaces it', function () {
    const { document, container } = createStubHost();
    const log = [];
    let failFirstMount = true;
    const render = createDomRenderer(container, {
      document,
      widgets: {
        probe: {
          mount(node, props) {
            if (failFirstMount && props.n === 0) {
              failFirstMount = false;
              throw new Error('mount boom');
            }
            log.push(['mount', props.n]);
            return { n: props.n };
          },
          update(handle, props) { log.push(['update', props.n]); },
          unmount(handle) { log.push(['unmount', handle.n]); },
        },
      },
    });
    const tree = (n) => ['div', {},
      ['jaren-widget', { name: 'probe', key: 'a', props: { n } }],
      ['jaren-widget', { name: 'probe', key: 'b', props: { n: 100 } }],
    ];
    assert.throws(() => render(tree(0)), /mount boom/);
    assert.deepStrictEqual(log, [['mount', 100]], 'the sibling still mounted');

    render(tree(1));
    assert.deepStrictEqual(log, [['mount', 100], ['update', 100], ['mount', 1]],
      'the poisoned widget was replaced with a fresh mount — no unmount of a never-mounted instance, no update on an undefined handle');
    render.destroy();
    assert.deepStrictEqual(log.slice(-2), [['unmount', 1], ['unmount', 100]]);
  });

  it('a throwing update poisons the widget: the old instance unmounts on replacement', function () {
    const { document, container } = createStubHost();
    const log = [];
    const render = createDomRenderer(container, {
      document,
      widgets: {
        probe: {
          mount(node, props) { log.push(['mount', props.n]); return { n: props.n }; },
          update(handle, props) {
            if (props.n === 1) throw new Error('update boom');
            log.push(['update', props.n]);
            handle.n = props.n;
          },
          unmount(handle) { log.push(['unmount', handle.n]); },
        },
      },
    });
    render(widgetVnode(0));
    assert.throws(() => render(widgetVnode(1)), /update boom/);
    render(widgetVnode(2));
    assert.deepStrictEqual(log, [
      ['mount', 0],
      ['unmount', 0], // the successfully-mounted old instance ends its lifecycle
      ['mount', 2],   // the fresh lifecycle takes over
    ]);
    render.destroy();
  });

  it('destroy() called from inside a widget hook is terminal and unmounts once', function () {
    const { document, container } = createStubHost();
    const log = [];
    let render;
    render = createDomRenderer(container, {
      document,
      widgets: {
        probe: {
          mount(node, props) { return { n: props.n }; },
          update(handle, props) {
            log.push(['update', props.n]);
            render.destroy();
          },
          unmount(handle) { log.push(['unmount', handle.n]); },
        },
      },
    });
    render(widgetVnode(0));
    render(widgetVnode(1));
    assert.deepStrictEqual(log, [['update', 1], ['unmount', 0]]);
    assert.strictEqual(serialize(container), '<div></div>');
    render(widgetVnode(2)); // exact no-op after destroy
    assert.deepStrictEqual(log, [['update', 1], ['unmount', 0]]);
  });
});

describe('focus sink isolation (APP-FORMAT §8.4)', function () {
  it('a throwing custom sink never starves sibling intents; its first error surfaces after the flush', function () {
    const { document, container } = createStubHost();
    const input = document.createElement('input');
    input.setAttribute('data-ref', 'ok');
    container.appendChild(input);

    const focus = createFocusEffect({
      container,
      onError: () => { throw new Error('sink boom'); },
    });
    const dispatch = () => {};
    focus({ ref: 'missing-a' }, dispatch);
    focus({ ref: 'ok' }, dispatch);
    focus({ ref: 'missing-b' }, dispatch);

    assert.throws(() => focus.flush(), /sink boom/);
    assert.strictEqual(document.activeElement, input,
      'the sibling intent between two throwing reports still resolved');
    focus.dispose();
  });
});
