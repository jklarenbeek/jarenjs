//@ts-check
/**
 * @file `createApp`'s `operators` option: the view, the actions and the
 * subscription queries compile with the registry's operators and `$call`
 * functions; without it a pack operator is refused at compile. Under
 * `safe` or `capabilities` the operators stay mounted and the `$call`
 * functions are the ones `capabilities.functions` grants: an ungranted one
 * is refused as an unregistered function is.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createApp, AppCompileError } from '@jarenjs/app';
import { createJsltRegistry, mathPack } from '@jarenjs/json/jslt';
import { createStubHost, serialize } from '../view/dom.stub.js';

const math = createJsltRegistry().use(mathPack);
const host = createJsltRegistry().use({ name: 'host', entries: { twice: { kind: 'fn', fn: (/** @type {number} */ x) => x * 2 } } });
const fns = createJsltRegistry().use(mathPack).use({ name: 'host', entries: {
  twice: { kind: 'fn', fn: (/** @type {number} */ x) => x * 2 },
  secret: { kind: 'fn', fn: () => 'host' },
} });
const sync = { schedule: (/** @type {() => void} */ f) => f() };
/**
 * The markup an app renders into a stub host.
 * @param {any} doc
 * @param {Record<string, any>} extra - more createApp options
 */
const renderedText = (doc, extra) => {
  const { document, container } = createStubHost();
  const app = createApp(doc, { ...sync, node: container, document, ...extra });
  const markup = serialize(container);
  app.destroy();
  return markup;
};
/** @param {string} name - the function an action's patch calls with `$.n` */
const callAction = (name) => ({ state: { n: 16 }, view: [{ match: '$', body: ['p', {}, 'x'] }],
  actions: { root: { patch: [{ op: 'replace', path: '/n', value: { $call: [name, '$.n'] } }] } } });

const view = { state: { n: 16 }, view: [{ match: '$', body: ['p', {}, { $string: { $sqrt: '$.n' } }] }] };
const action = {
  state: { n: 16 }, view: [{ match: '$', body: ['p', {}, { $string: '$.n' }] }],
  actions: { root: { patch: [{ op: 'replace', path: '/n', value: { $sqrt: '$.n' } }] } },
};
const sub = { state: { n: 16 }, view: [{ match: '$', body: ['p', {}, 'x'] }], subs: [{ run: 'tick', when: { $gt: [{ $sqrt: '$.n' }, 3] } }] };

describe('createApp: the operators option', () => {
  it('an action computes with a registry operator', () => {
    const app = createApp(action, { ...sync, operators: math });
    app.dispatch('root');
    assert.deepEqual(app.getState(), { n: 4 });
    app.destroy();
  });

  it('a subscription\'s when computes with a registry operator', () => {
    /** @type {number[]} */
    const started = [];
    const app = createApp(sub, { ...sync, operators: math, subs: { tick: () => { started.push(1); return () => {}; } } });
    assert.deepEqual(started, [1]);
    app.destroy();
  });

  it('the view and a `$call` function compile with the registry', () => {
    assert.doesNotThrow(() => createApp(view, { ...sync, operators: math }).destroy());
    const called = { state: {}, view: [{ match: '$', body: ['p', {}, { $string: { $call: ['twice', 21] } }] }] };
    assert.doesNotThrow(() => createApp(called, { ...sync, operators: host }).destroy());
    assert.throws(() => createApp(called, sync), (err) => err instanceof AppCompileError && err.code === 'JA0002');
  });

  it('without a registry a pack operator is refused at compile, as before', () => {
    const refused = (/** @type {any} */ doc, /** @type {string} */ code, /** @type {string} */ docPath) =>
      assert.throws(() => createApp(doc, { ...sync, subs: { tick: () => () => {} } }),
        (err) => err instanceof AppCompileError && err.code === code && err.docPath === docPath && /unknown operator '\$sqrt'/.test(err.message));
    refused(view, 'JA0002', '/view');
    refused(action, 'JA0004', '/actions/root');
    refused(sub, 'JA0006', '/subs/0/when');
    assert.throws(() => createApp(view, { ...sync, operators: null }), (err) => err instanceof AppCompileError && err.code === 'JA0002');
  });

  it('under safe or explicit grants the pack operators stay mounted', () => {
    // the shapes that were a TypeError: each now computes with the operator
    for (const extra of [{ safe: true }, { safe: 'interactive' }, { capabilities: {} }, { capabilities: { effects: [] } }, { safe: true, capabilities: {} }]) {
      const app = createApp(action, { ...sync, ...extra, operators: math });
      app.dispatch('root');
      assert.deepEqual(app.getState(), { n: 4 }, JSON.stringify(extra));
      app.destroy();
    }
    // the view and a subscription's when too
    assert.equal(renderedText(view, { safe: true, operators: math }), '<div><p>4</p></div>');
    /** @type {number[]} */
    const started = [];
    const app = createApp(sub, { ...sync, safe: true, operators: math, subs: { tick: () => { started.push(1); return () => {}; } }, capabilities: { subs: ['tick'] } });
    assert.deepEqual(started, [1]);
    app.destroy();
  });

  it('capabilities.functions grants the `$call` functions a safe app reaches', () => {
    const app = createApp(callAction('twice'), { ...sync, safe: true, operators: fns, capabilities: { functions: ['twice'] } });
    app.dispatch('root');
    assert.deepEqual(app.getState(), { n: 32 });
    app.destroy();
    // explicit grants without safe read the same list
    const trustedGrants = createApp(callAction('twice'), { ...sync, operators: fns, capabilities: { functions: ['twice', 'secret'] } });
    trustedGrants.dispatch('root');
    assert.deepEqual(trustedGrants.getState(), { n: 32 });
    trustedGrants.destroy();
  });

  it('a `$call` to a function not granted is refused as an unregistered one is', () => {
    const unregistered = (/** @type {string} */ name) => (/** @type {any} */ err) => err instanceof AppCompileError
      && err.code === 'JA0004' && err.docPath === '/actions/root' && err.cause?.code === 'JQ0010'
      && err.message === `JA0004: action 'root' failed to compile: JQ0010: '$call' names no registered function '${name}' at /patch/0/value/$call at /actions/root`;
    // granted another name
    assert.throws(() => createApp(callAction('secret'), { ...sync, safe: true, operators: fns, capabilities: { functions: ['twice'] } }), unregistered('secret'));
    // no list: the safe app reaches no function, and computes with the operators
    for (const extra of [{ safe: true }, { safe: 'interactive' }, { capabilities: {} }, { capabilities: { effects: [] } }]) {
      assert.throws(() => createApp(callAction('twice'), { ...sync, ...extra, operators: fns }), unregistered('twice'), JSON.stringify(extra));
    }
    // the same refusal a registry without the function answers
    assert.throws(() => createApp(callAction('twice'), { ...sync, operators: math }), unregistered('twice'));
    // a name every object inherits is no function, granted or not
    for (const name of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      assert.throws(() => createApp(callAction(name), { ...sync, safe: true, operators: fns }), unregistered(name), name);
      assert.throws(() => createApp(callAction(name), { ...sync, safe: true, operators: fns, capabilities: { functions: ['twice'] } }), unregistered(name), name);
    }
    // the view and a subscription meet it with their own codes
    const called = { state: {}, view: [{ match: '$', body: ['p', {}, { $string: { $call: ['twice', 21] } }] }] };
    assert.throws(() => createApp(called, { ...sync, safe: true, operators: fns }),
      (/** @type {any} */ err) => err instanceof AppCompileError && err.code === 'JA0002' && err.docPath === '/view' && /no registered function 'twice'/.test(err.message));
    const subCall = { state: { n: 1 }, view: [{ match: '$', body: ['p', {}, 'x'] }], subs: [{ run: 'tick', when: { $call: ['twice', '$.n'] } }] };
    assert.throws(() => createApp(subCall, { ...sync, safe: true, operators: fns, subs: { tick: () => () => {} }, capabilities: { subs: ['tick'] } }),
      (/** @type {any} */ err) => err instanceof AppCompileError && err.code === 'JA0006' && err.docPath === '/subs/0/when' && /no registered function 'twice'/.test(err.message));
  });

  it('a trusted app with a registry reaches every function, as before', () => {
    for (const name of ['twice', 'secret']) {
      const app = createApp(callAction(name), { ...sync, operators: fns });
      app.dispatch('root');
      assert.deepEqual(app.getState(), { n: name === 'twice' ? 32 : 'host' }, name);
      app.destroy();
    }
    const off = createApp(callAction('secret'), { ...sync, safe: false, operators: fns });
    off.dispatch('root');
    assert.deepEqual(off.getState(), { n: 'host' });
    off.destroy();
  });

  it('refuses a functions grant that names nothing registered, or is no list', () => {
    assert.throws(() => createApp(action, { ...sync, safe: true, operators: fns, capabilities: { functions: ['twise'] } }),
      { name: 'TypeError', message: "createApp: unknown functions capability 'twise' — did you mean 'twice'?" });
    assert.throws(() => createApp(action, { ...sync, capabilities: { functions: ['twice'] } }),
      { name: 'TypeError', message: "createApp: unknown functions capability 'twice'" });
    assert.throws(() => createApp(action, { ...sync, safe: true, operators: math, capabilities: { functions: ['twice'] } }),
      { name: 'TypeError', message: "createApp: unknown functions capability 'twice'" });
    assert.throws(() => createApp(action, { ...sync, safe: true, operators: fns, capabilities: { functions: 'twice' } }),
      { name: 'TypeError', message: 'createApp: capabilities.functions must be a list of names' });
    assert.throws(() => createApp(action, { ...sync, safe: true, operators: fns, capabilities: { function: ['twice'] } }),
      { name: 'TypeError', message: "createApp: unknown capabilities member 'function' — did you mean 'functions'?" });
    // an empty list with no registry grants nothing and boots
    const core = { state: {}, view: [{ match: '$', body: ['p', {}, 'x'] }] };
    assert.doesNotThrow(() => createApp(core, { ...sync, capabilities: { functions: [] } }).destroy());
  });

  it('without a registry, safe and explicit grants boot as they do', () => {
    const core = { state: {}, view: [{ match: '$', body: ['p', {}, 'x'] }] };
    for (const extra of [{ safe: true }, { capabilities: {} }, { safe: true, operators: null }, { safe: false, operators: math }]) {
      assert.doesNotThrow(() => createApp(core, { ...sync, ...extra }).destroy(), JSON.stringify(extra));
    }
  });

  it('refuses an operators value that is no registry', () => {
    for (const [value, given] of [[{}, 'an object'], [mathPack, 'an object'], ['math', '"math"']]) {
      assert.throws(() => createApp(view, { operators: value }), {
        name: 'TypeError',
        message: `createApp: options.operators must be an operator registry (an object with a toOptions function), got ${given}`,
      });
    }
  });
});
