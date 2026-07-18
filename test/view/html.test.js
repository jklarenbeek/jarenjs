//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { renderToString, styleToString } from '@jarenjs/view';

describe('renderToString', function () {
  it('renders text with escaping', function () {
    assert.strictEqual(renderToString('a < b & c > d'), 'a &lt; b &amp; c &gt; d');
    assert.strictEqual(renderToString(3.14), '3.14');
  });

  it('renders elements with attributes, escaping values', function () {
    assert.strictEqual(
      renderToString(['p', { class: 'note', title: 'say "hi" & bye' }, 'x']),
      '<p class="note" title="say &quot;hi&quot; &amp; bye">x</p>');
  });

  it('renders nothing for skipped values and empty lists', function () {
    assert.strictEqual(renderToString(null), '');
    assert.strictEqual(renderToString(false), '');
    assert.strictEqual(renderToString(['div', {}, null, false, [[]]]), '<div></div>');
  });

  it('handles boolean attributes: true bare, false omitted', function () {
    assert.strictEqual(
      renderToString(['input', { type: 'checkbox', checked: true, disabled: false }]),
      '<input type="checkbox" checked>');
  });

  it('never renders key and on props', function () {
    assert.strictEqual(
      renderToString(['li', { key: 3, on: { click: 'select' } }, 'x']),
      '<li>x</li>');
  });

  it('renders void elements without end tags', function () {
    assert.strictEqual(
      renderToString(['div', {}, ['br'], ['img', { src: 'x.png' }]]),
      '<div><br><img src="x.png"></div>');
  });

  it('serializes style objects, camelCase to kebab-case', function () {
    assert.strictEqual(
      styleToString({ fontSize: '12px', '--gap': '1rem', color: 'red', display: null }),
      'font-size:12px;--gap:1rem;color:red');
    assert.strictEqual(
      renderToString(['p', { style: { fontSize: '12px' } }, 'x']),
      '<p style="font-size:12px">x</p>');
    assert.strictEqual(renderToString(['p', { style: {} }, 'x']), '<p>x</p>');
  });

  it('splices list children in place', function () {
    const items = [['li', {}, 'a'], ['li', {}, 'b']];
    assert.strictEqual(
      renderToString(['ul', {}, items, ['li', {}, 'c']]),
      '<ul><li>a</li><li>b</li><li>c</li></ul>');
  });
});
