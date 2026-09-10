import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createDomRenderer } from '@jarenjs/view';
import { createStubHost, fire, serialize } from './dom.stub.js';

it('adopts existing fragments, removes stale attributes and repairs mismatches locally', () => {
  const { container, document } = createStubHost();
  const kept = document.createElement('p'); kept.setAttribute('data-stale', 'old');
  kept.appendChild(document.createTextNode('server'));
  container.appendChild(kept); container.appendChild(document.createElement('em'));
  container.appendChild(document.createElement('aside'));
  const render = createDomRenderer(container, { hydrate: true });
  render([['p', { key: 'p' }, 'client'], ['input', { value: 'ready' }]]);
  assert.equal(container.childNodes[0], kept);
  assert.equal(kept.getAttribute('data-stale'), null);
  assert.equal(container.childNodes.length, 2);
  assert.equal(container.childNodes[1].value, 'ready');
  render([['input', { key: 'new', value: 'next' }], ['p', { key: 'p' }, 'moved']]);
  assert.equal(container.childNodes[1], kept);
  assert.match(serialize(container), /moved/);
  render.destroy();
  assert.equal(container.childNodes.length, 0);
});

it('defers composition settlement past a microtask and releases it during teardown', async () => {
  const { container } = createStubHost();
  const render = createDomRenderer(container);
  render(['textarea', { value: 'start' }]);
  const input = container.childNodes[0];
  fire(input, 'compositionstart'); input.value = 'composing';
  render(['textarea', { value: 'pending' }]);
  assert.equal(input.value, 'composing');
  fire(input, 'compositionend');
  await Promise.resolve();
  assert.equal(input.value, 'composing', 'a final input may still be arriving');
  render(['textarea', { value: 'final input' }]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(input.value, 'final input');
  fire(input, 'compositionstart'); fire(input, 'compositionend');
  render.destroy();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(input.listeners.get('compositionend')?.size ?? 0, 0);
});

it('ending composition alone does not synthesize an authoritative render before a blur commit', async () => {
  const { container } = createStubHost();
  const render = createDomRenderer(container);
  const vnode = ['textarea', { value: 'committed' }];
  render(vnode);
  const input = container.childNodes[0];
  fire(input, 'compositionstart'); input.value = 'pending blur'; fire(input, 'compositionend');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(input.value, 'pending blur');
  render(vnode);
  assert.equal(input.value, 'committed', 'a real render still owns the value');
  render.destroy();
});
