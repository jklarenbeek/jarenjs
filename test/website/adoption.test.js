//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nodeDriver } from '@jarenjs/db/node';
import { mountAdoptionDemo } from '../../packages/website/src/boundaries/adoption.js';
import { collectionHost } from '../collection/dom-host.js';

it('the combined browser host disposes widgets and reopens the same file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jaren-browser-adoption-'));
  const values = new Map();
  const env = collectionHost(), options = { driver: nodeDriver(), path: join(directory, 'catalog.sqlite'),
    storage: { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) },
    interrupt: () => { throw new Error('synthetic lost reply'); } };
  try {
    const host = mountAdoptionDemo(env.host, options); await host.ready;
    assert.ok(env.host.querySelector('[data-rule-draft]'));
    const status = () => env.host.querySelector('[data-journey-status]').childNodes.map((node) => node.nodeValue).join('');
    const click = async (name) => {
      const target = env.host.querySelectorAll('[data-journey-action]').find((node) => node.getAttribute('data-journey-action') === name);
      for (const fn of env.host.listeners.get('click')) await fn({ target });
    };
    await click('save'); assert.match(status(), /0 writes/);
    await click('ingest'); assert.match(status(), /256 changes/);
    await click('ingest'); assert.match(status(), /0 changes/);
    await click('send'); assert.match(status(), /Commit two/);
    const editor = env.host.querySelector('[data-journey-editor]');
    const fire = (type, target) => { target.hasAttribute = (name) => target.getAttribute(name) !== null; editor.fire(type, { target }); };
    fire('click', env.host.querySelector('[data-rule-preview]'));
    const wait = async (predicate) => {
      const deadline = performance.now() + 10000;
      while (!predicate() && performance.now() < deadline) { env.flush(); await new Promise((resolve) => setTimeout(resolve, 5)); }
      assert.ok(predicate());
    };
    await wait(() => env.host.querySelectorAll('[data-rule-change]').length > 2);
    const choices = env.host.querySelectorAll('[data-rule-change]').filter((target) => /catalog-(1|101) \/amount/.test(target.parentNode.childNodes.map((node) => node.nodeValue).join('')));
    assert.equal(choices.length, 2);
    for (const target of choices) { target.checked = true; fire('change', target); }
    fire('click', env.host.querySelector('[data-rule-commit]'));
    await wait(() => env.host.querySelector('[data-rule-status]').childNodes.map((node) => node.nodeValue).join('').includes('committed'));
    await click('search'); env.flush();
    await click('send');
    await click('recover'); assert.match(status(), /No remote resend/);
    await click('restart'); assert.match(status(), /later writes preserved/);
    await host.dispose(); await host.dispose(); assert.equal(env.observers.size, 0);
    const reopened = mountAdoptionDemo(env.host, options); await reopened.ready;
    assert.ok(env.host.querySelector('[data-rule-draft]')); await reopened.dispose();
    const early = mountAdoptionDemo(env.host, options); await early.dispose(); assert.equal(env.observers.size, 0);
  }
  finally { rmSync(directory, { recursive: true, force: true }); }
});
