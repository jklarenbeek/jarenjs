//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { compileJsltStylesheet } from '@jarenjs/json/jslt';

/** COW-style update: fresh spine, shared siblings. */
function replaceItem(doc, index, item) {
  const items = doc.items.slice();
  items[index] = item;
  return { ...doc, items };
}

const DOC = {
  title: 'list',
  items: [
    { id: 1, label: 'alpha', done: false },
    { id: 2, label: 'beta', done: true },
    { id: 3, label: 'gamma', done: false },
  ],
};

const VIEW = [
  {
    match: '$', body:
      ['main', {}, ['h1', {}, '$.title'], ['ul', {}, [{ $apply: '$.items[*]' }]]],
  },
  {
    match: '$.items[*]', body:
      ['li', { 'data-id': '$.id' }, '$.label'],
  },
];

describe('JSLT memo option', function () {
  it('an unchanged document returns the ENTIRE previous output by reference', function () {
    const transform = compileJsltStylesheet(VIEW, { memo: true });
    const first = transform(DOC);
    const second = transform(DOC);
    assert.strictEqual(second, first, 'same root ref at the same location: O(1) frame');
  });

  it('recomputes exactly the changed subtree after a COW update', function () {
    const transform = compileJsltStylesheet(VIEW, { memo: true });
    const first = transform(DOC);
    const next = replaceItem(DOC, 1, { id: 2, label: 'BETA', done: true });
    const second = transform(next);
    assert.notStrictEqual(second, first, 'root recomputed (its ref changed)');
    const ul1 = first[3];
    const ul2 = second[3];
    assert.strictEqual(ul2[2][0], ul1[2][0], 'item 0 vnode shared');
    assert.notStrictEqual(ul2[2][1], ul1[2][1], 'item 1 recomputed');
    assert.strictEqual(ul2[2][1][2], 'BETA');
    assert.strictEqual(ul2[2][2], ul1[2][2], 'item 2 vnode shared');
  });

  it('off by default: no cross-call sharing', function () {
    const transform = compileJsltStylesheet(VIEW);
    const first = transform(DOC);
    const second = transform(DOC);
    assert.notStrictEqual(first[3][2][0], second[3][2][0]);
    assert.deepStrictEqual(first, second);
  });

  it('stays correct when a shared reference MOVES to another location', function () {
    const transform = compileJsltStylesheet([
      { match: '$', body: [{ $apply: '$.items[*]' }] },
      { match: '$.items[*]', body: { at: '$path', id: '$.id' } },
    ], { memo: true });
    const first = transform(DOC);
    assert.strictEqual(first[0].at, "$['items'][0]");
    // swap items 0 and 2: same refs, new locations
    const swapped = { ...DOC, items: [DOC.items[2], DOC.items[1], DOC.items[0]] };
    const second = transform(swapped);
    assert.strictEqual(second[0].at, "$['items'][0]", '$path reflects the NEW location');
    assert.strictEqual(second[0].id, 3);
    assert.strictEqual(second[2].id, 1);
  });

  it('rules reading $root or user externals are never cached', function () {
    const transform = compileJsltStylesheet([
      { match: '$', body: [{ $apply: '$.items[*]' }] },
      { match: '$.items[*]', body: { label: '$.label', title: '$root.title', rate: '$rate' } },
    ], { memo: true });
    const first = transform(DOC, { rate: 1 });
    const retitled = { ...DOC, title: 'renamed' };
    const second = transform(retitled, { rate: 2 });
    assert.strictEqual(second[0].title, 'renamed', '$root stays live');
    assert.strictEqual(second[0].rate, 2, 'externals stay live');
    assert.strictEqual(first[0].rate, 1);
  });

  it('a root-referencing filter in a REACHABLE match disables caching of the applier', function () {
    const doc = { max: 10, items: [{ price: 5 }, { price: 20 }] };
    const transform = compileJsltStylesheet({
      $jslt: '0.1',
      modes: { pick: { unmatched: 'share' } },
      rules: [
        { match: '$', body: ['wrap', [{ $apply: ['$.items[*]', 'pick'] }]] },
        { match: '$.items[?@.price < $.max]', mode: 'pick', body: { cheap: '$.price' } },
      ],
    }, { memo: true });
    const first = transform(doc);
    assert.deepStrictEqual(first[1], [{ cheap: 5 }, { price: 20 }]);
    // raise the threshold WITHOUT touching the items: selection changes
    const second = transform({ ...doc, max: 30 });
    assert.deepStrictEqual(second[1], [{ cheap: 5 }, { cheap: 20 }],
      'selection re-evaluates even though item refs are unchanged');
  });

  it('cached outputs retire after one unused generation', function () {
    const transform = compileJsltStylesheet(VIEW, { memo: true });
    const first = transform(DOC);
    const other = { title: 'other', items: [] };
    transform(other);            // generation without DOC's item locations
    transform(other);            // DOC's item entries fully retired
    const third = transform(DOC);
    assert.notStrictEqual(third[3][2][0], first[3][2][0], 'cache does not grow unboundedly');
    assert.deepStrictEqual(third, first);
  });

  it('identity and shared-subtree guarantees are unaffected', function () {
    const transform = compileJsltStylesheet([], { memo: true });
    assert.strictEqual(transform(DOC), DOC);
    const surgical = compileJsltStylesheet([
      { match: '$.items[1].label', body: { $upper: '$' } },
    ], { memo: true });
    const out = surgical(DOC);
    assert.strictEqual(out.items[1].label, 'BETA');
    assert.strictEqual(out.items[0], DOC.items[0], 'off-spine sharing intact');
  });
});
