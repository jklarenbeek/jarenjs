//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  h,
  isTextNode,
  isElementNode,
  isSkippedNode,
  isSameNode,
  propsOf,
  keyOf,
  childrenOf,
  EMPTY_PROPS,
} from '@jarenjs/view';

describe('vnode contract', function () {
  it('classifies text, element, list and skipped values', function () {
    assert.strictEqual(isTextNode('hello'), true);
    assert.strictEqual(isTextNode(42), true);
    assert.strictEqual(isTextNode(['div']), false);
    assert.strictEqual(isElementNode(['div', {}, 'x']), true);
    assert.strictEqual(isElementNode([['div'], ['span']]), false);
    assert.strictEqual(isElementNode('div'), false);
    assert.strictEqual(isSkippedNode(null), true);
    assert.strictEqual(isSkippedNode(undefined), true);
    assert.strictEqual(isSkippedNode(true), true);
    assert.strictEqual(isSkippedNode(false), true);
    assert.strictEqual(isSkippedNode(0), false);
    assert.strictEqual(isSkippedNode(''), false);
  });

  it('reads props only when the second item is a plain object', function () {
    assert.deepStrictEqual(propsOf(['div', { id: 'a' }, 'x']), { id: 'a' });
    assert.strictEqual(propsOf(['div', 'x']), EMPTY_PROPS);
    assert.strictEqual(propsOf(['div', ['span']]), EMPTY_PROPS);
    assert.strictEqual(propsOf(['div']), EMPTY_PROPS);
  });

  it('reads keys off element props', function () {
    assert.strictEqual(keyOf(['li', { key: 7 }, 'x']), 7);
    assert.strictEqual(keyOf(['li', {}, 'x']), undefined);
    assert.strictEqual(keyOf('text'), undefined);
  });

  it('flattens children: lists spliced, skipped values dropped', function () {
    const vnode = ['ul', { id: 'l' },
      null,
      ['li', {}, 'a'],
      [['li', {}, 'b'], false, ['li', {}, 'c']],
      undefined,
      'tail',
    ];
    const children = childrenOf(vnode);
    assert.strictEqual(children.length, 4);
    assert.deepStrictEqual(children[0], ['li', {}, 'a']);
    assert.deepStrictEqual(children[2], ['li', {}, 'c']);
    assert.strictEqual(children[3], 'tail');
  });

  it('treats the second item as a child when it is not a props object', function () {
    assert.deepStrictEqual(childrenOf(['div', 'x', 'y']), ['x', 'y']);
    assert.deepStrictEqual(childrenOf(['div', { id: 'a' }, 'x']), ['x']);
  });

  it('flattens nested lists recursively', function () {
    const children = childrenOf(['div', {}, [[[1, 2], 3], [4]]]);
    assert.deepStrictEqual(children, [1, 2, 3, 4]);
  });

  it('h() produces the JSON form', function () {
    assert.deepStrictEqual(h('p', { class: 'x' }, 'a', 'b'), ['p', { class: 'x' }, 'a', 'b']);
    assert.deepStrictEqual(h('br'), ['br', EMPTY_PROPS]);
  });

  it('isSameNode: tag and key decide patchability', function () {
    assert.strictEqual(isSameNode('a', 'b'), true);
    assert.strictEqual(isSameNode('a', ['div']), false);
    assert.strictEqual(isSameNode(['div', {}], ['div', { id: 'x' }]), true);
    assert.strictEqual(isSameNode(['div', {}], ['span', {}]), false);
    assert.strictEqual(isSameNode(['li', { key: 1 }], ['li', { key: 2 }]), false);
    assert.strictEqual(isSameNode(['li', { key: 1 }], ['li', { key: 1 }]), true);
  });
});
