//@ts-check
/**
 * The text of an HTML `<style>` or `<script>` is raw text: a browser never
 * decodes a character reference in it, so the server renderer writes it
 * verbatim — exactly the characters the DOM renderer puts in its text
 * node — and refuses the one thing raw text cannot carry, a sequence an
 * HTML parser would read as the element's end. Inside `<svg>` the two are
 * foreign elements whose text a parser decodes, so it stays escaped, as
 * it does in safe mode, which drops both.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { renderToString, createDomRenderer } from '@jarenjs/view';
import { createReflectingHost } from './dom.stub.js';

/**
 * The text of `vnode`'s single raw-text child as the DOM renderer builds it.
 * @param {any} vnode
 * @returns {string}
 */
function domText(vnode) {
  const { document, container } = createReflectingHost();
  createDomRenderer(container, { document })(vnode);
  const element = container.childNodes[0];
  return element.childNodes.map((/** @type {any} */ node) => node.nodeValue).join('');
}

/**
 * The text an HTML parser reads between `<tag ...>` and `</tag>` in raw-text
 * markup: everything up to the first end tag, verbatim.
 * @param {string} markup
 * @param {string} tag
 * @returns {string}
 */
function parsedRawText(markup, tag) {
  const open = markup.indexOf('>') + 1;
  const end = markup.slice(open).search(new RegExp(`</${tag}[\\t\\n\\f\\r />]`, 'i'));
  return markup.slice(open, open + end);
}

describe('view — style and script text is raw text on the server', function () {
  it('writes the text verbatim, as a browser reads it', function () {
    assert.equal(renderToString(['style', {}, '.a > .b { content: "x" }']),
      '<style>.a > .b { content: "x" }</style>');
    assert.equal(renderToString(['script', {}, 'if (a < b && c) go()']),
      '<script>if (a < b && c) go()</script>');
    assert.equal(renderToString(['script', { type: 'application/ld+json' }, JSON.stringify({ name: 'Tom & Jerry' })]),
      '<script type="application/ld+json">{"name":"Tom & Jerry"}</script>');
    assert.equal(renderToString(['SCRIPT', {}, 'a < b']), '<SCRIPT>a < b</SCRIPT>');
  });

  it('reads back exactly the text the DOM renderer writes', function () {
    for (const [tag, text] of [
      ['style', '.a > .b::after { content: "&amp; < &lt;" }'],
      ['script', 'const s = "<b>&copy;</b>"; if (x<y && y>z) {}'],
      ['script', 'a</script'],
      ['style', '/* <!-- not a comment here --> */ p { color: red }'],
    ]) {
      const vnode = [tag, {}, text];
      assert.equal(parsedRawText(renderToString(vnode), tag), domText(vnode), `${tag}: ${text}`);
    }
  });

  it('refuses text a parser would read as the end of the element, naming where it sits', function () {
    /** @type {[any, string, RegExp][]} */
    const CASES = [
      [['div', {}, ['script', {}, 'a</script>b']], '"</script>"', /at \/2/],
      [['script', {}, 'a</SCRIPT >b'], '"</SCRIPT "', /at the root/],
      [['script', {}, 'x</script/y'], '"</script/"', /at the root/],
      [['style', {}, 'p{}</style\n'], '"</style\\n"', /at the root/],
      [['script', {}, 'if (a <!-- b) {}'], '"<!--"', /at the root/],
      // a sequence split across two text children is one sequence in the markup
      [['script', {}, 'a</scr', 'ipt>'], '"</script>"', /at the root/],
    ];
    for (const [vnode, found, where] of CASES) {
      assert.throws(() => renderToString(vnode), (/** @type {any} */ err) => {
        assert.equal(err instanceof TypeError, true);
        assert.match(err.message, /^view: the text of the <(script|SCRIPT|style)> /);
        assert.ok(err.message.includes(found), `${err.message} names ${found}`);
        assert.match(err.message, where);
        return true;
      });
    }
  });

  it('keeps escaping inside svg, where style and script are foreign elements', function () {
    assert.equal(renderToString(['svg', {}, ['style', {}, '.a > .b {}']]),
      '<svg><style>.a &gt; .b {}</style></svg>');
    assert.equal(renderToString(['svg', {}, ['foreignObject', {}, ['style', {}, '.a > .b {}']]]),
      '<svg><foreignObject><style>.a > .b {}</style></foreignObject></svg>');
  });

  it('safe mode still drops both elements, text and all', function () {
    const seen = [];
    const onUnsafe = (/** @type {any} */ info) => seen.push(info.name);
    assert.equal(renderToString(['div', {}, ['style', {}, 'a > b'], ['script', {}, 'a</script>']],
      { safe: true, onUnsafe }), '<div></div>');
    assert.deepEqual(seen, ['style', 'script']);
  });
});
