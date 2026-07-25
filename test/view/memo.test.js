//@ts-check
/**
 * The `memo` marker (VIEW-FORMAT §5.5): a producer-owned
 * subtree-stability assertion that extends the §5.1 reference fast
 * path across allocation boundaries. The proof of a skip is
 * behavioral: the renderer must not even look at a memo-stable
 * subtree, so deliberately divergent children below an equal marker
 * stay untouched in the DOM (that stale output is the documented
 * consequence of a violated producer promise, exactly like a
 * duplicate key).
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createDomRenderer, renderToString } from '@jarenjs/view';
import { createStubHost, serialize } from './dom.stub.js';

function host(options = {}) {
  const { document, container } = createStubHost();
  const render = createDomRenderer(container, { document, ...options });
  return { document, container, render, root: () => container.childNodes[0] };
}

describe('the memo marker — skip semantics', function () {
  it('an equal memo skips the subtree without descending (fresh arrays, stale children untouched)', function () {
    const { render, container } = host();
    render(['div', {}, ['section', { memo: 7 }, ['p', {}, 'one']]]);
    assert.strictEqual(serialize(container), '<div><div><section><p>one</p></section></div></div>');
    // fresh vnode arrays, same marker, divergent children — the diff
    // must not look inside, so the DOM keeps the old content
    render(['div', {}, ['section', { memo: 7 }, ['p', {}, 'DIVERGED']]]);
    assert.strictEqual(serialize(container), '<div><div><section><p>one</p></section></div></div>');
  });

  it('a changed memo diffs normally', function () {
    const { render, container } = host();
    render(['div', {}, ['section', { memo: 1 }, ['p', {}, 'one']]]);
    render(['div', {}, ['section', { memo: 2 }, ['p', {}, 'two']]]);
    assert.strictEqual(serialize(container), '<div><div><section><p>two</p></section></div></div>');
  });

  it('memo on only one side never matches (undefined is absence)', function () {
    const { render, container } = host();
    render(['p', { memo: 3 }, 'a']);
    render(['p', {}, 'b']);
    assert.strictEqual(serialize(container), '<div><p>b</p></div>');
    render(['p', { memo: 3 }, 'c']);
    assert.strictEqual(serialize(container), '<div><p>c</p></div>');
  });

  it('Object.is semantics: NaN matches itself, +0/-0 differ, object identity counts', function () {
    const { render, container } = host();
    render(['p', { memo: NaN }, 'a']);
    render(['p', { memo: NaN }, 'STALE']);
    assert.strictEqual(serialize(container), '<div><p>a</p></div>');

    render(['p', { memo: 0 }, 'zero']);
    render(['p', { memo: -0 }, 'negative zero']);
    assert.strictEqual(serialize(container), '<div><p>negative zero</p></div>');

    const token = {};
    render(['p', { memo: token }, 'by identity']);
    render(['p', { memo: token }, 'STALE']);
    assert.strictEqual(serialize(container), '<div><p>by identity</p></div>');
    render(['p', { memo: {} }, 'fresh token']);
    assert.strictEqual(serialize(container), '<div><p>fresh token</p></div>');
  });

  it('identity gates the marker: a changed tag or key replaces despite equal memo', function () {
    const { render, container, root } = host();
    render(['div', {}, ['p', { key: 'a', memo: 9 }, 'x']]);
    const before = root().childNodes[0];
    render(['div', {}, ['p', { key: 'b', memo: 9 }, 'y']]);
    assert.notStrictEqual(root().childNodes[0], before, 'a new key is a new node');
    assert.strictEqual(serialize(container), '<div><div><p>y</p></div></div>');
    render(['div', {}, ['h2', { key: 'b', memo: 9 }, 'z']]);
    assert.strictEqual(serialize(container), '<div><div><h2>z</h2></div></div>');
  });

  it('a keyed move preserves the skip: the moved subtree is not re-diffed', function () {
    const { render, container, root } = host();
    render(['ul', {},
      ['li', { key: 'a', memo: 'va' }, 'alpha'],
      ['li', { key: 'b', memo: 'vb' }, 'beta']]);
    const [nodeA, nodeB] = [...root().childNodes];
    render(['ul', {},
      ['li', { key: 'b', memo: 'vb' }, 'STALE'],
      ['li', { key: 'a', memo: 'va' }, 'STALE']]);
    assert.strictEqual(root().childNodes[0], nodeB, 'keyed move reuses the node');
    assert.strictEqual(root().childNodes[1], nodeA);
    assert.strictEqual(serialize(container),
      '<div><ul><li>beta</li><li>alpha</li></ul></div>');
  });

  it('never reaches the DOM as an attribute and patches away cleanly', function () {
    const { render, root } = host();
    render(['p', { memo: 'v1', class: 'x' }, 'a']);
    assert.strictEqual(root().attributes.has('memo'), false);
    assert.strictEqual(root().memo, undefined);
  });

  it('never serializes', function () {
    assert.strictEqual(renderToString(['p', { memo: 42, class: 'x' }, 'a']),
      '<p class="x">a</p>');
    assert.strictEqual(renderToString(['jaren-widget', { name: 'w', memo: 1 }]),
      '<div></div>');
  });
});

describe('the memo marker — widget interplay', function () {
  it('the skip is suspended while a widget is poisoned, so recovery still happens', function () {
    let mounts = 0;
    const widgets = {
      bomb: {
        mount() {
          mounts++;
          if (mounts === 1) throw new Error('first mount fails');
          return { ok: true };
        },
      },
    };
    const { render, container } = host({ widgets });
    const tree = (label) => ['div', {},
      ['section', { memo: 'stable' }, ['p', {}, label]],
      ['jaren-widget', { name: 'bomb', key: 'w' }]];
    assert.throws(() => render(tree('one')), /first mount fails/);
    // the widget is poisoned: an equal memo must NOT skip — the next
    // render must reach and replace the poisoned widget
    render(tree('two'));
    assert.strictEqual(mounts, 2, 'the poisoned widget was replaced');
    // with poison active during that pass, the memo section was
    // legitimately re-diffed too — its content updated
    assert.match(serialize(container), /two/);
    // healthy again: the marker skips once more
    render(tree('three'));
    assert.match(serialize(container), /two/, 'skip resumed after recovery');
  });

  it('destroy() tears down widgets living under a memo-stable subtree', function () {
    let unmounted = 0;
    const widgets = {
      counter: {
        mount() { return {}; },
        unmount() { unmounted++; },
      },
    };
    const { render } = host({ widgets });
    render(['div', { memo: 'top' }, ['jaren-widget', { name: 'counter' }]]);
    render(['div', { memo: 'top' }, ['jaren-widget', { name: 'counter' }]]); // skipped frame
    render.destroy();
    assert.strictEqual(unmounted, 1, 'the destroy walk is DOM-owned, memo cannot hide a widget');
  });
});
