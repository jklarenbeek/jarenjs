//@ts-check
/**
 * @file Tag names (VIEW-FORMAT §2): a tag outside the element-name grammar
 * is a producer error, and both trusted renderers refuse it with a
 * `TypeError` naming where the vnode sits — never `<Total:>3</Total:>`, never
 * `< >`, never the platform's own `InvalidCharacterError`. The safe profile
 * keeps dropping such a tag, through the same predicate.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createDomRenderer, renderToString } from '@jarenjs/view';

import { createStubHost, serialize } from './dom.stub.js';

/** @param {{ safe?: boolean, hydrate?: boolean, widgets?: any }} [options] */
function host(options = {}) {
  const { document, container } = createStubHost();
  return { container, render: createDomRenderer(container, { document, ...options }) };
}

/** A TypeError naming the tag and the place. @param {string} tag @param {string} where */
const refused = (tag, where) => (/** @type {any} */ error) => error instanceof TypeError
  && error.message.includes(`the tag ${JSON.stringify(tag)} ${where} is not an element name`);

describe('a tag outside the grammar is refused, naming its place', () => {
  const mistakes = [
    { vnode: ['p', {}, [' ', ['b', {}, 'x']]], tag: ' ', where: 'at /2' },
    { vnode: ['Total:', 3], tag: 'Total:', where: 'at the root' },
    { vnode: ['ul', {}, ['li', {}, 'a'], [['', 'b']]], tag: '', where: 'at /3/0' },
  ];

  for (const { vnode, tag, where } of mistakes) {
    it(`${JSON.stringify(vnode)}: the serializer and the DOM renderer both throw`, () => {
      assert.throws(() => renderToString(vnode), refused(tag, where));
      assert.throws(() => host().render(vnode), refused(tag, where));
    });
  }

  it('a patch that brings the tag in refuses it too, and so does hydration', () => {
    const h = host();
    h.render(['p', {}, 'ok']);
    assert.throws(() => h.render(['p', {}, ['bad tag', {}, 'x']]), refused('bad tag', 'at /2'));
    // adoption meets the tag before any node is built for it — even where
    // an HTML parser made an element of that name from server markup
    const hydrating = host({ hydrate: true });
    assert.throws(() => hydrating.render(['x y']), refused('x y', 'at the root'));
    const parsed = host({ hydrate: true });
    parsed.container.appendChild(parsed.container.ownerDocument.createElement('total:'));
    assert.throws(() => parsed.render(['total:', 3]), refused('total:', 'at the root'));
  });

  it('after a refused frame, the next frame renders its own vnode: the failed pass leaves no write behind', () => {
    /** @type {string[]} */
    const log = [];
    const widgets = { w: { mount: (/** @type {any} */ _h, /** @type {any} */ props) => { log.push(`mount ${props.n}`); return props.n; },
      unmount: (/** @type {any} */ n) => { log.push(`unmount ${n}`); } } };
    const h = host({ widgets });
    // one props object: the widget is never remounted by a props change, only by the teardown
    const props = { n: 1 };
    h.render(['div', {}, ['p', { class: 'x' }, 'one'], ['jaren-widget', { name: 'w', props }]]);
    // the first child is patched before the refused tag is met
    assert.throws(() => h.render(['div', {}, ['p', { class: 'y' }, 'two'], ['jaren-widget', { name: 'w', props }], ['Total:', 3]]),
      refused('Total:', 'at /4'));
    assert.strictEqual(serialize(h.container), '<div></div>', 'the half-written tree is gone (the container is the outer div)');
    assert.deepStrictEqual(log, ['mount 1', 'unmount 1'], 'and its widget unmounted');
    h.render(['div', {}, ['p', { class: 'x' }, 'one'], ['jaren-widget', { name: 'w', props }]]);
    assert.strictEqual(serialize(h.container), '<div><div><p class="x">one</p><div></div></div></div>');
    assert.deepStrictEqual(log, ['mount 1', 'unmount 1', 'mount 1']);
    h.render.destroy();
  });

  it('a first pass that fails leaves nothing, and a hydrating renderer then creates rather than adopts', () => {
    const h = host();
    assert.throws(() => h.render([['p', {}, 'a'], ['bad tag']]), refused('bad tag', 'at /1'));
    assert.strictEqual(serialize(h.container), '<div></div>');
    h.render(['p', {}, 'a']);
    assert.strictEqual(serialize(h.container), '<div><p>a</p></div>');
    const hydrating = host({ hydrate: true });
    const server = hydrating.container.ownerDocument.createElement('p');
    server.appendChild(hydrating.container.ownerDocument.createTextNode('server'));
    hydrating.container.appendChild(server);
    assert.throws(() => hydrating.render([['p', {}, 'server'], ['bad tag']]), refused('bad tag', 'at /1'));
    hydrating.render(['p', {}, 'client']);
    assert.strictEqual(serialize(hydrating.container), '<div><p>client</p></div>', 'built from the vnode, not adopted from the emptied container');
  });

  it("a widget's host tag is held to the same grammar", () => {
    const widgets = { w: { mount: () => null, ssr: () => 'ok' } };
    const vnode = ['div', {}, ['jaren-widget', { name: 'w', tag: 'not a tag' }]];
    assert.throws(() => renderToString(vnode, { widgets }), refused('not a tag', 'at /2'));
    assert.throws(() => host({ widgets }).render(vnode), refused('not a tag', 'at /2'));
  });

  it('custom elements, SVG camelCase tags and the widget tag render', () => {
    const vnode = ['div', {}, ['my-chart', { kind: 'pie' }],
      ['svg', {}, ['linearGradient', { id: 'g' }]], ['jaren-widget', { name: 'w' }]];
    const widgets = { w: { mount: () => null, ssr: () => ['span', {}, 'w'] } };
    assert.strictEqual(renderToString(vnode, { widgets }),
      '<div><my-chart kind="pie"></my-chart><svg><linearGradient id="g"></linearGradient></svg><div><span>w</span></div></div>');
    const h = host({ widgets });
    h.render(vnode);
    assert.strictEqual(serialize(h.container.childNodes[0]),
      '<div><my-chart kind="pie"></my-chart><svg><linearGradient id="g"></linearGradient></svg><div></div></div>');
  });

  it('the safe profile still drops such a tag, with no TypeError', () => {
    assert.strictEqual(renderToString(['p', {}, ['Total:', 3]], { safe: true }), '<p></p>');
    const h = host({ safe: true });
    h.render(['p', {}, ['Total:', 3]]);
    assert.strictEqual(serialize(h.container.childNodes[0]), '<p></p>');
  });

  it('the escape the message names: a list that starts with null splices text before an element', () => {
    assert.strictEqual(renderToString(['p', {}, [null, ' ', ['b', {}, 'x']]]), '<p> <b>x</b></p>');
  });
});
