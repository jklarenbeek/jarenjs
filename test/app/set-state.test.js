//@ts-check
/**
 * @file `app.setState(next)` — the host-driven whole-state replacement
 * used for external state sync: SSR hydration, or a studio hot-swapping
 * an edited `state` block into a running nested app WITHOUT a reboot. It
 * runs no reducer and no effects — it replaces state, notifies listeners
 * with `null` changed-paths, refreshes `when`-gated subscriptions and
 * re-renders. The re-render is a DIFF, so an uncontrolled input the user
 * typed into survives; a reboot (remount) would destroy it. That
 * property is exactly what the project IDE's hot-update path relies on.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { createApp } from '@jarenjs/app';

import { createStubHost, serialize } from '../view/dom.stub.js';

const sync = (flush) => flush();

function hotApp() {
  const { document, container } = createStubHost();
  const app = createApp({
    state: { title: 'A', n: 1 },
    view: [{ match: '$', body: ['div', {},
      ['h1', {}, '$.title'],
      ['input', { type: 'text', class: 'scratch' }],
      ['p', { class: 'n' }, ['text', '$.n']],
    ] }],
  }, { node: container, document, schedule: sync });
  const root = () => container.childNodes[0];
  return { app, root, input: () => root().childNodes[1] };
}

describe('app.setState — host-driven whole-state replacement', () => {
  it('replaces state, re-renders, and notifies listeners with null changed-paths', () => {
    const seen = [];
    const { app, root } = hotApp();
    app.subscribe((s, changes) => seen.push(changes));
    assert.match(serialize(root()), /<h1>A<\/h1>/);
    app.setState({ title: 'B', n: 2 });
    assert.strictEqual(app.getState().title, 'B');
    assert.match(serialize(root()), /<h1>B<\/h1>/, 'the view re-rendered from the new state');
    assert.deepStrictEqual(seen, [null], 'a whole-state replace reports null changed-paths');
  });

  it('preserves an uncontrolled input across the re-render (the hot-update guarantee)', () => {
    const { app, input } = hotApp();
    input().value = 'draft-the-user-typed';   // uncontrolled: no value binding
    app.setState({ title: 'B', n: 9 });
    assert.strictEqual(input().value, 'draft-the-user-typed',
      'the diff re-render kept the input node — a reboot would have destroyed it');
  });

  it('is a no-op when the next state is reference-identical', () => {
    const seen = [];
    const { app } = hotApp();
    app.subscribe((s, changes) => seen.push(changes));
    app.setState(app.getState());
    assert.deepStrictEqual(seen, [], 'no notify, no render for an identical state');
  });

  it('is ignored after the loop is stopped', () => {
    const { app, root } = hotApp();
    app.stop();
    app.setState({ title: 'Z', n: 0 });
    assert.strictEqual(app.getState().title, 'A', 'a stopped loop ignores setState');
    assert.doesNotMatch(serialize(root()), /Z/);
  });
});
