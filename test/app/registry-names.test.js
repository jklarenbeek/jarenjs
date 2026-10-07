//@ts-check
/**
 * A registry name is one the host registered: an own member of the
 * registry. A document that names a member every object inherits —
 * `toString`, `constructor`, `__proto__`, `hasOwnProperty`, `valueOf`,
 * `__defineGetter__` — meets the refusal a name nobody registered meets,
 * in every registry and whether or not the app is safe; the builtin
 * never runs as a handler.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { createApp } from '@jarenjs/app';
import { createStubHost } from '../view/dom.stub.js';

const sync = (/** @type {() => void} */ flush) => flush();
const view = [{ match: '$', body: ['p', {}, 'x'] }];
const INHERITED = ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf', '__defineGetter__'];
/**
 * Unrestricted, safe with nothing granted, and granted only the one name the registry holds.
 * @param {string} kind @param {string} name
 */
const modes = (kind, name) => [{}, { safe: true, capabilities: {} }, { capabilities: { [kind]: [name] } }];

describe('createApp — an inherited name is not a registered one', function () {
  it('an inherited effect name is an unregistered effect (JA2006)', function () {
    for (const mode of modes('effects', 'log')) {
      for (const name of [...INHERITED, 'nope']) {
        /** @type {any[]} */
        const seen = [];
        const app = createApp({ state: {}, view, actions: { go: { effects: [{ run: name }] } } }, {
          schedule: sync, onError: (error) => seen.push(error), effects: { log: () => {} }, ...mode,
        });
        app.dispatch('go');
        app.destroy();
        assert.deepEqual(seen.map((error) => [error.code, error.message]),
          [['JA2006', `JA2006: action 'go' invoked unregistered effect '${name}'`]], `${name} ${JSON.stringify(mode)}`);
      }
    }
  });

  it('an inherited subscription name is an unregistered subscription (JA2008)', function () {
    for (const mode of modes('subs', 'tick')) {
      for (const name of [...INHERITED, 'nope']) {
        /** @type {any[]} */
        const seen = [];
        const app = createApp({ state: {}, view, subs: [{ run: name }] }, {
          schedule: sync, onError: (error) => seen.push(error), subs: { tick: () => {} }, ...mode,
        });
        app.destroy();
        assert.deepEqual(seen.map((error) => [error.code, error.message]),
          [['JA2008', `JA2008: subscription '${name}' has no registered handler`]], `${name} ${JSON.stringify(mode)}`);
      }
    }
  });

  it('an inherited event-field name is an unknown field (JA2009), bound null', function () {
    for (const name of [...INHERITED, 'nope']) {
      /** @type {any[]} */
      const seen = [];
      const app = createApp({
        state: { last: null }, view,
        actions: { capture: { patch: [{ op: 'add', path: '/last', value: '$event' }] } },
      }, { schedule: sync, onError: (error) => seen.push(error), eventFields: { custom: () => 1 } });
      app.dispatch('capture', null, { type: 'click', target: { value: 'v' } }, [name]);
      assert.deepEqual(seen.map((error) => error.code), ['JA2009'], name);
      assert.equal(Object.getOwnPropertyDescriptor(app.getState().last, name)?.value, null, name);
      app.destroy();
    }
  });

  it('an inherited widget name is an unregistered widget', function () {
    for (const name of [...INHERITED, 'nope']) {
      const { document, container } = createStubHost();
      assert.throws(() => createApp({ state: {}, view: [{ match: '$', body: ['jaren-widget', { name }] }] }, {
        node: container, document, schedule: sync, widgets: { w: { mount: () => ({}) } },
      }), (/** @type {any} */ error) => error.code === 'JA0007' && error.message.includes(`unregistered widget '${name}'`), name);
    }
  });

  it('a method a class instance inherits is not registered either, as a grant already read it', function () {
    /** @type {string[]} */
    const ran = [];
    class Effects { log() { ran.push('inherited'); } }
    const effects = Object.assign(new Effects(), { own: () => ran.push('own') });
    /** @type {any[]} */
    const seen = [];
    const app = createApp({ state: {}, view, actions: { go: { effects: [{ run: 'log' }, { run: 'own' }] } } }, {
      schedule: sync, onError: (error) => seen.push(error), effects,
    });
    app.dispatch('go');
    app.destroy();
    assert.deepEqual(ran, ['own']);
    assert.deepEqual(seen.map((error) => error.code), ['JA2006']);
    assert.throws(() => createApp({ state: {}, view }, { effects, capabilities: { effects: ['log'] } }),
      /^TypeError: createApp: unknown effects capability 'log'/);
  });
});
