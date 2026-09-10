import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '@jarenjs/app';
import { createStubHost, serialize } from '../view/dom.stub.js';

it('forwards the safe renderer and grants no host capabilities by default', () => {
  const host = createStubHost();
  const called = [], stripped = [], errors = [];
  const app = createApp({ state: {}, view: [{ match: '$', body: ['div', { innerHTML: 'attack' },
    ['script', {}, 'attack'], ['jaren-widget', { name: 'danger' }]] }],
  actions: { run: { effects: [{ run: 'network' }] } },
  subs: [{ run: 'network', when: true }],
  }, { ...host, node: host.container, safe: true, onUnsafe: (x) => stripped.push(x), onError: (e) => errors.push(e),
    effects: { network: () => called.push('effect') }, subs: { network: () => called.push('sub') },
    widgets: { danger: { mount: () => called.push('widget') } },
  });
  app.dispatch('run'); app.destroy();
  assert.deepEqual(called, []);
  assert.ok(stripped.length > 0);
  assert.doesNotMatch(serialize(host.container), /attack/);
});

it('a capability list grants only named handlers, including disposal ownership', () => {
  const calls = [];
  const yes = Object.assign(() => calls.push('yes'), { dispose: () => calls.push('disposed') });
  const no = Object.assign(() => calls.push('no'), { dispose: () => calls.push('forbidden disposal') });
  const app = createApp({ state: {}, view: [{ match: '$', body: ['p', {}, 'ok'] }],
    actions: { run: { effects: [{ run: 'yes' }] } } }, {
    capabilities: { effects: ['yes'] }, effects: { yes, no },
  });
  app.dispatch('run'); app.destroy();
  assert.deepEqual(calls, ['yes', 'disposed']);
  assert.throws(() => createApp({ view: [] }, { capabilities: { effects: ['missing'] } }), /unknown effects capability/);
});
