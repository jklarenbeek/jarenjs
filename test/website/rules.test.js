//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { nodeDriver } from '@jarenjs/db/node';
import { mountRulesDemo } from '../../packages/website/src/boundaries/rules.js';
import { collectionHost } from '../collection/dom-host.js';

it('the formula example composes public editor/collection lifecycles and closes its database', async () => {
  const env = collectionHost();
  const handle = mountRulesDemo(env.host, { driver: nodeDriver() }); await handle.ready;
  assert.ok(env.host.querySelector('[data-rule-draft]')); assert.ok(env.host.querySelector('.jc-viewport'));
  const editorHost = env.host.querySelector('[data-rules-editor]');
  const fire = (type, selector) => { const target = env.host.querySelector(selector); target.hasAttribute = (name) => target.getAttribute(name) !== null; editorHost.fire(type, { target }); };
  fire('click', '[data-rule-preview]');
  const deadline = performance.now() + 10000;
  while (!env.host.querySelector('[data-rule-change]') && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  const change = env.host.querySelector('[data-rule-change]'); assert.ok(change); change.checked = true; fire('change', '[data-rule-change]');
  fire('click', '[data-rule-commit]');
  const committed = () => env.host.querySelector('[data-rule-status]').childNodes.map((node) => node.nodeValue).join('');
  while (!committed().includes('committed') && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(env.host.querySelector('[data-rule-status]').childNodes.map((node) => node.nodeValue).join(''), /committed/);
  await handle.dispose(); await handle.dispose(); assert.equal(env.observers.size, 0);
  const early = mountRulesDemo(env.host, { driver: nodeDriver() }); await early.dispose(); assert.equal(env.observers.size, 0);
});
