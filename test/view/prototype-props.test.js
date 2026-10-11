//@ts-check
/**
 * @file A prop named like a member every object inherits (`constructor`,
 * `toString`, `valueOf`, `hasOwnProperty`) is an ordinary prop. The
 * serializer wrote it as an attribute; the DOM renderer took it for a
 * renderer instruction and dropped it, in the trusted and the safe profile
 * alike, and a later frame that removed it left the attribute standing.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createDomRenderer, renderToString } from '@jarenjs/view';
import { createStubHost, serialize } from './dom.stub.js';

const NAMES = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf'];

/** Render the frames into a fresh stub container; the markup after each. */
function frames(vnodes, options = {}) {
  const { document, container } = createStubHost();
  const render = createDomRenderer(container, { document, ...options });
  return vnodes.map((vnode) => {
    render(vnode);
    return serialize(container);
  });
}

for (const safe of [false, true]) {
  describe(`view — props named like Object.prototype members (${safe ? 'safe' : 'trusted'})`, () => {
    it('are written as attributes, exactly as the serializer writes them', () => {
      const props = Object.fromEntries(NAMES.map((name, i) => [name, `v${i}`]));
      const vnode = ['div', { ...props, title: 't' }];
      const markup = renderToString(vnode, { safe });
      assert.strictEqual(markup,
        '<div constructor="v0" toString="v1" valueOf="v2" hasOwnProperty="v3" isPrototypeOf="v4" title="t"></div>');
      assert.strictEqual(frames([vnode], { safe })[0], `<div>${markup}</div>`);
    });

    it('are removed again when a frame drops them', () => {
      const [first, second] = frames([
        ['div', { 'data-x': '1', toString: 'q', hasOwnProperty: 'r' }],
        ['div', { 'data-x': '1' }],
      ], { safe });
      assert.strictEqual(first, '<div><div data-x="1" toString="q" hasOwnProperty="r"></div></div>');
      assert.strictEqual(second, '<div><div data-x="1"></div></div>');
    });

    it('change in place', () => {
      const [, second] = frames([['div', { valueOf: 'a' }], ['div', { valueOf: 'b' }]], { safe });
      assert.strictEqual(second, '<div><div valueOf="b"></div></div>');
    });
  });
}

describe('view — a prop named toString does not replace the method', () => {
  it('the node keeps the toString it inherits', () => {
    const { document, container } = createStubHost();
    createDomRenderer(container, { document })(['div', { toString: 'q', constructor: 'c' }]);
    const node = container.childNodes[0];
    assert.strictEqual(node.toString, Object.prototype.toString);
    assert.strictEqual(node.constructor.name, 'StubElement');
    assert.strictEqual(node.attributes.get('toString'), 'q');
  });

  it('a widget host takes such a prop as an attribute too, and renderer instructions stay out', () => {
    const { document, container } = createStubHost();
    const widgets = { w: { mount() { return null; }, update() {} } };
    const render = createDomRenderer(container, { document, widgets });
    render(['jaren-widget', { name: 'w', props: {}, toString: 'q' }]);
    assert.strictEqual(serialize(container), '<div><div toString="q"></div></div>');
    render(['jaren-widget', { name: 'w', props: {}, toString: 'r', hasOwnProperty: 's' }]);
    assert.strictEqual(serialize(container), '<div><div toString="r" hasOwnProperty="s"></div></div>');
    render(['jaren-widget', { name: 'w', props: {} }]);
    assert.strictEqual(serialize(container), '<div><div></div></div>');
  });
});
