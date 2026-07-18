//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createApp, AppCompileError, AppRuntimeError } from '@jarenjs/app';
import { renderToString } from '@jarenjs/view';
import { createStubHost, fire, serialize } from '../view/dom.stub.js';

/** Synchronous render scheduler for deterministic assertions. */
const sync = (flush) => flush();

/** A complete counter app document — state, view, actions, all JSON. */
function counterDoc() {
  return {
    $app: '0.1',
    state: { count: 0 },
    view: [
      {
        match: '$',
        body: ['main', {},
          ['span', { id: 'count' }, 'Count: ', '$.count'],
          ['button', { on: { click: 'inc' } }, '+'],
        ],
      },
    ],
    actions: {
      inc: { patch: [{ op: 'replace', path: '/count', value: { $add: ['$.count', 1] } }] },
      set: { patch: [{ op: 'replace', path: '/count', value: '$payload' }] },
      reset: { state: { count: 0 } },
    },
  };
}

function mount(doc, options = {}) {
  const { document, container } = createStubHost();
  const app = createApp(doc, { node: container, document, schedule: sync, ...options });
  return { app, container };
}

describe('createApp', function () {
  it('mounts the initial state through the view stylesheet', function () {
    const { container } = mount(counterDoc());
    assert.strictEqual(serialize(container),
      '<div><main><span id="count">Count: 0</span><button>+</button></main></div>');
  });

  it('dispatch runs the action document and re-renders', function () {
    const { app, container } = mount(counterDoc());
    app.dispatch('inc');
    app.dispatch('inc');
    assert.strictEqual(app.getState().count, 2);
    assert.match(serialize(container), /Count: 2/);
  });

  it('binds $payload from the dispatch call', function () {
    const { app } = mount(counterDoc());
    app.dispatch('set', 41);
    assert.strictEqual(app.getState().count, 41);
  });

  it('DOM events fire bindings through to actions', function () {
    const { app, container } = mount(counterDoc());
    const button = container.childNodes[0].childNodes[1];
    fire(button, 'click');
    fire(button, 'click');
    assert.strictEqual(app.getState().count, 2);
    assert.match(serialize(container), /Count: 2/);
  });

  it('binds $event data from the DOM event', function () {
    const doc = {
      state: { name: '' },
      view: [{
        match: '$',
        body: ['input', { value: '$.name', on: { input: 'type' } }],
      }],
      actions: {
        type: { patch: [{ op: 'replace', path: '/name', value: '$event.value' }] },
      },
    };
    const { app, container } = mount(doc);
    const input = container.childNodes[0];
    fire(input, 'input', { target: { value: 'Joham' } });
    assert.strictEqual(app.getState().name, 'Joham');
  });

  it('a "state" transition replaces the whole state', function () {
    const { app } = mount(counterDoc());
    app.dispatch('set', 9);
    app.dispatch('reset');
    assert.deepStrictEqual(app.getState(), { count: 0 });
  });

  it('object bindings carry a "with" payload', function () {
    const doc = counterDoc();
    doc.view = [{
      match: '$',
      body: ['button', { on: { click: { action: 'set', with: 7 } } }, 'seven'],
    }];
    const { app, container } = mount(doc);
    fire(container.childNodes[0], 'click');
    assert.strictEqual(app.getState().count, 7);
  });

  it('runs effects through registered handlers, without re-rendering', function () {
    const calls = [];
    const doc = counterDoc();
    doc.actions.save = { effects: [{ run: 'log', with: { n: '$.count' } }] };
    const { app } = mount(doc, {
      effects: { log: (props, dispatch) => calls.push([props, typeof dispatch]) },
    });
    app.dispatch('set', 3);
    app.dispatch('save');
    assert.deepStrictEqual(calls, [[{ n: 3 }, 'function']]);
    assert.strictEqual(app.getState().count, 3);
  });

  it('effects can dispatch back into the loop', function () {
    const doc = counterDoc();
    doc.actions.fetch = { effects: [{ run: 'fakeHttp' }] };
    const { app } = mount(doc, {
      effects: { fakeHttp: (props, dispatch) => dispatch('set', 99) },
    });
    app.dispatch('fetch');
    assert.strictEqual(app.getState().count, 99);
  });

  it('starts and stops subscriptions by their "when" query', function () {
    const log = [];
    const doc = counterDoc();
    doc.subs = [{ run: 'ticker', with: { ms: 50 }, when: { $gt: ['$.count', 0] } }];
    const { app } = mount(doc, {
      subs: {
        ticker: (props) => {
          log.push(['start', props.ms]);
          return () => log.push(['stop', props.ms]);
        },
      },
    });
    assert.deepStrictEqual(log, [], 'not live at count 0');
    app.dispatch('inc');
    app.dispatch('inc');
    assert.deepStrictEqual(log, [['start', 50]], 'started once');
    app.dispatch('reset');
    assert.deepStrictEqual(log, [['start', 50], ['stop', 50]]);
    app.dispatch('inc');
    app.stop();
    assert.deepStrictEqual(log.at(-1), ['stop', 50], 'stop() cleans up');
  });

  it('validateState rejects the transition, fail closed', function () {
    const errors = [];
    const { app } = mount(counterDoc(), {
      validateState: (state) => state.count <= 5,
      onError: (err) => errors.push(err),
    });
    app.dispatch('set', 3);
    app.dispatch('set', 10);
    assert.strictEqual(app.getState().count, 3, 'invalid transition not applied');
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(/** @type {any} */ (errors[0]).code, 'JA2005');
    assert.ok(errors[0] instanceof AppRuntimeError);
  });

  it('reports unknown actions as JA2001', function () {
    const errors = [];
    const { app } = mount(counterDoc(), { onError: (err) => errors.push(err) });
    app.dispatch('nope');
    assert.strictEqual(/** @type {any} */ (errors[0]).code, 'JA2001');
  });

  it('rejects malformed app documents at compile time', function () {
    assert.throws(() => createApp({}), (err) => err.code === 'JA0002');
    assert.throws(() => createApp(null), (err) => err.code === 'JA0001');
    assert.throws(
      () => createApp({ view: [], actions: { bad: { $bogus: [1] } } }),
      (err) => err instanceof AppCompileError
        && err.code === 'JA0004'
        && err.docPath === '/actions/bad');
    assert.throws(
      () => createApp({ view: [], subs: [{ with: {} }] }),
      (err) => err.code === 'JA0006' && err.docPath === '/subs/0');
  });

  it('runs headless: getVnode composes with renderToString for SSR', function () {
    const app = createApp(counterDoc(), { schedule: sync });
    app.dispatch('set', 12);
    assert.strictEqual(renderToString(app.getVnode()),
      '<main><span id="count">Count: 12</span><button>+</button></main>');
  });

  it('stop() ignores further dispatches', function () {
    const { app } = mount(counterDoc());
    app.dispatch('inc');
    app.stop();
    app.dispatch('inc');
    assert.strictEqual(app.getState().count, 1);
  });
});
