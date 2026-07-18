//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createDomRenderer } from '@jarenjs/view';
import { createStubHost, fire, serialize } from './dom.stub.js';

/** Render helper: fresh host + renderer per test. */
function host(options = {}) {
  const { document, container } = createStubHost();
  const render = createDomRenderer(container, { document, ...options });
  return { document, container, render, root: () => container.childNodes[0] };
}

describe('createDomRenderer', function () {
  it('mounts a tree and patches text in place', function () {
    const { render, container, root } = host();
    render(['main', {}, ['h1', { id: 't' }, 'Hello'], 'world']);
    assert.strictEqual(serialize(container), '<div><main><h1 id="t">Hello</h1>world</main></div>');

    const mounted = root();
    render(['main', {}, ['h1', { id: 't' }, 'Goodbye'], 'world']);
    assert.strictEqual(root(), mounted, 'same tag patches in place');
    assert.strictEqual(serialize(container), '<div><main><h1 id="t">Goodbye</h1>world</main></div>');
  });

  it('adds, updates and removes attributes', function () {
    const { render, root } = host();
    render(['p', { class: 'a', title: 'x' }, 'text']);
    render(['p', { class: 'b', hidden: true }, 'text']);
    const attrs = root().attributes;
    assert.strictEqual(attrs.get('class'), 'b');
    assert.strictEqual(attrs.get('hidden'), '');
    assert.strictEqual(attrs.has('title'), false);
  });

  it('replaces the node when the tag changes', function () {
    const { render, container, root } = host();
    render(['p', {}, 'x']);
    const before = root();
    render(['section', {}, 'x']);
    assert.notStrictEqual(root(), before);
    assert.strictEqual(serialize(container), '<div><section>x</section></div>');
  });

  it('skips identical vnode references in O(1)', function () {
    const { render, root } = host();
    const child = ['p', { id: 'shared' }, 'unchanged'];
    render(['div', {}, child]);
    const node = root().childNodes[0];
    // sabotage: if patching descends, the attribute diff would restore it
    node.setAttribute('id', 'sabotaged');
    render(['div', { class: 'next' }, child]);
    assert.strictEqual(node.attributes.get('id'), 'sabotaged',
      'reference-equal subtree must not be descended into');
  });

  it('fires on bindings through the onEvent hook, rebinding by data', function () {
    const events = [];
    const { render, root } = host({ onEvent: (binding, event) => events.push([binding, event.type]) });
    render(['button', { on: { click: 'inc' } }, '+']);
    const button = root();
    fire(button, 'click');
    assert.deepStrictEqual(events, [['inc', 'click']]);

    render(['button', { on: { click: { action: 'add', with: 5 } } }, '+']);
    fire(button, 'click');
    assert.deepStrictEqual(events[1], [{ action: 'add', with: 5 }, 'click']);
    assert.strictEqual(button.listeners.get('click').size, 1,
      'rebinding must not stack listeners');

    render(['button', {}, '+']);
    fire(button, 'click');
    assert.strictEqual(events.length, 2, 'removed binding no longer fires');
  });

  it('patches unkeyed children positionally, appending and removing', function () {
    const { render, container } = host();
    render(['ul', {}, ['li', {}, 'a'], ['li', {}, 'b']]);
    render(['ul', {}, ['li', {}, 'A'], ['li', {}, 'B'], ['li', {}, 'C']]);
    assert.strictEqual(serialize(container), '<div><ul><li>A</li><li>B</li><li>C</li></ul></div>');
    render(['ul', {}, ['li', {}, 'A']]);
    assert.strictEqual(serialize(container), '<div><ul><li>A</li></ul></div>');
  });

  it('reorders keyed children by moving DOM nodes, not recreating them', function () {
    const item = (k) => ['li', { key: k }, k];
    const { render, root, container } = host();
    render(['ul', {}, item('a'), item('b'), item('c'), item('d')]);
    const ul = root();
    const [a, b, c, d] = [...ul.childNodes];

    render(['ul', {}, item('d'), item('b'), item('a'), item('c')]);
    assert.deepStrictEqual([...ul.childNodes], [d, b, a, c], 'nodes moved, identity kept');
    assert.strictEqual(serialize(container), '<div><ul><li>d</li><li>b</li><li>a</li><li>c</li></ul></div>');
  });

  it('keyed insert and remove in the middle', function () {
    const item = (k, text) => ['li', { key: k }, text ?? k];
    const { render, root, container } = host();
    render(['ul', {}, item('a'), item('b'), item('c')]);
    const ul = root();
    const [a, , c] = [...ul.childNodes];

    render(['ul', {}, item('a'), item('x'), item('c', 'C!')]);
    assert.strictEqual(ul.childNodes[0], a, 'head kept');
    assert.strictEqual(ul.childNodes[2], c, 'tail kept and patched');
    assert.strictEqual(serialize(container), '<div><ul><li>a</li><li>x</li><li>C!</li></ul></div>');
  });

  it('renders svg subtrees with the SVG namespace', function () {
    const { render, root } = host();
    render(['svg', { viewBox: '0 0 1 1' }, ['circle', { r: '0.5' }]]);
    const svg = root();
    assert.strictEqual(svg.namespaceURI, 'http://www.w3.org/2000/svg');
    assert.strictEqual(svg.childNodes[0].namespaceURI, 'http://www.w3.org/2000/svg');
    assert.strictEqual(svg.attributes.get('viewBox'), '0 0 1 1');
  });

  it('serializes style objects onto the style attribute', function () {
    const { render, root } = host();
    render(['p', { style: { fontSize: '10px', color: 'red' } }, 'x']);
    assert.strictEqual(root().attributes.get('style'), 'font-size:10px;color:red');
  });
});
