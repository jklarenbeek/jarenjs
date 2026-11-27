//@ts-check
/**
 * @file `createApp`'s `operators` option: the view, the actions and the
 * subscription queries compile with the registry's operators and `$call`
 * functions; without it a pack operator is refused at compile. It is not
 * combined with `safe` or `capabilities`: no grant list covers a
 * registry's functions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createApp, AppCompileError } from '@jarenjs/app';
import { createJsltRegistry, mathPack } from '@jarenjs/json/jslt';

const math = createJsltRegistry().use(mathPack);
const host = createJsltRegistry().use({ name: 'host', entries: { twice: { kind: 'fn', fn: (/** @type {number} */ x) => x * 2 } } });
const sync = { schedule: (/** @type {() => void} */ f) => f() };

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

  it('is not combined with a safe profile or explicit grants; without a registry those boot as they do', () => {
    const message = 'createApp: options.operators cannot be combined with safe or capabilities';
    for (const extra of [{ safe: true }, { safe: 'interactive' }, { capabilities: {} }, { capabilities: { effects: [] } }, { safe: true, capabilities: {} }]) {
      assert.throws(() => createApp(view, { ...sync, ...extra, operators: math }), { name: 'TypeError', message }, JSON.stringify(extra));
    }
    // right answers beside it: no registry under either option, and a registry with safe: false
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
