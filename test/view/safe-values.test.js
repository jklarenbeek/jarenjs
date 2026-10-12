//@ts-check
/**
 * @file The safe profile judges prop VALUES by kind, as its schema does: a
 * string, a number, a boolean or null. A value of another kind (an object, an
 * array) is not an attribute value, and `String()` of one is either a way
 * around the style and URL checks (an array holding the string the check
 * would have refused) or a TypeError out of the render pass (`{"toString": 1}`).
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createDomRenderer, renderToString } from '@jarenjs/view';
import { createStubHost, serialize } from './dom.stub.js';

/** The markup the safe DOM renderer leaves for `vnode`, and what it reported. */
function domSafe(vnode) {
  const { document, container } = createStubHost();
  const reports = [];
  createDomRenderer(container, { document, safe: true, onUnsafe: (r) => reports.push(`${r.kind}:${r.name}`) })(vnode);
  return { markup: serialize(container), reports };
}

describe('view safe profile — prop values of another kind', () => {
  const BOMB = { toString: 1 };

  it('a style value that is a list holding a script URL is dropped like the string it holds', () => {
    const vnode = ['div', { style: { background: ['url(javascript:alert(1))'] } }];
    assert.strictEqual(renderToString(vnode, { safe: true }), '<div></div>');
    assert.strictEqual(domSafe(vnode).markup, '<div><div></div></div>');
    assert.strictEqual(renderToString(['div', { style: { width: ['expression(alert(1))'] } }], { safe: true }), '<div></div>');
  });

  it('a style value that is an object is dropped, whether or not it can be turned into text', () => {
    for (const value of [BOMB, { a: 'url(javascript:x)' }, {}]) {
      const vnode = ['div', { style: { color: value } }];
      assert.strictEqual(renderToString(vnode, { safe: true }), '<div></div>');
      assert.strictEqual(domSafe(vnode).markup, '<div><div></div></div>');
    }
  });

  it('an attribute value that cannot be turned into text renders as the attribute dropped, in both renderers', () => {
    for (const name of ['title', 'data-x', 'class', 'href', 'srcset', 'width']) {
      const vnode = ['div', { [name]: BOMB, id: 'k' }];
      assert.strictEqual(renderToString(vnode, { safe: true }), '<div id="k"></div>', name);
      const seen = domSafe(vnode);
      assert.strictEqual(seen.markup, '<div><div id="k"></div></div>', name);
      assert.deepStrictEqual(seen.reports, [`prop:${name}`], name);
    }
  });

  it('a list or an object is not an attribute value, and a list of strings keeps its answer on the value of a select', () => {
    assert.strictEqual(renderToString(['div', { title: ['a', 'b'], 'data-o': { a: 1 }, id: 'k' }], { safe: true }), '<div id="k"></div>');
    const multiple = ['select', { multiple: true, value: ['b', 'c'] },
      ['option', { value: 'a' }, 'A'], ['option', { value: 'b' }, 'B'], ['option', { value: 'c' }, 'C']];
    assert.strictEqual(renderToString(multiple, { safe: true }),
      '<select multiple value="b,c"><option value="a">A</option><option value="b">B</option><option value="c">C</option></select>');
    assert.strictEqual(renderToString(['select', { value: [BOMB] }], { safe: true }), '<select></select>');
  });

  it('strings, numbers, booleans and null keep their answers', () => {
    const vnode = ['p', { title: 'a', tabindex: 3, hidden: true, lang: null, 'data-n': 0, 'data-f': false, style: { color: 'red', width: 10, margin: null } }, 'x'];
    assert.strictEqual(renderToString(vnode, { safe: true }), renderToString(vnode));
  });

  it('a prop the author left empty is not reported as stripped, in either renderer', () => {
    const vnode = ['a', { href: null, title: null, srcset: null, style: null, id: 'x' }, 'x'];
    const seen = [];
    assert.strictEqual(renderToString(vnode, { safe: true, onUnsafe: (r) => seen.push(`${r.kind}:${r.name}`) }), '<a id="x">x</a>');
    assert.deepStrictEqual(seen, []);
    assert.deepStrictEqual(domSafe(vnode).reports, []);
  });

  it('a prop a frame drops is not reported, and one that was stripped still is', () => {
    const { document, container } = createStubHost();
    const seen = [];
    const render = createDomRenderer(container, { document, safe: true, onUnsafe: (r) => seen.push(`${r.kind}:${r.name}`) });
    render(['a', { href: 'https://x.test/' }, 'x']);
    render(['a', {}, 'x']);
    assert.deepStrictEqual(seen, []);
    render(['a', { href: 'javascript:alert(1)', onclick: 'x' }, 'x']);
    assert.deepStrictEqual(seen, ['prop:href', 'prop:onclick']);
  });

  it('a rejected prop is reported when it is given and not again when a frame drops it', () => {
    const { document, container } = createStubHost();
    const seen = [];
    const render = createDomRenderer(container, { document, safe: true, onUnsafe: (r) => seen.push(`${r.kind}:${r.name}`) });
    render(['div', { onclick: 'x', innerHTML: 'y', id: 'a' }]);
    assert.deepStrictEqual(seen, ['prop:onclick', 'prop:innerHTML']);
    seen.length = 0;
    render(['div', { id: 'a' }]);
    assert.deepStrictEqual(seen, []);
    assert.strictEqual(renderToString(['div', { onclick: null, innerHTML: null }], { safe: true, onUnsafe: (r) => seen.push(r.name) }), '<div></div>');
    assert.deepStrictEqual(seen, []);
  });
});
