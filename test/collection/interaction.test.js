//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCollectionInteraction } from '@jarenjs/collection';
const options = { count: 100, columnCount: 4, keyAt: (i) => `row-${i}`, indexOf: (key) => Number(key.slice(4)), query: 'q', snapshot: 's' };
describe('collection keyed interaction', () => {
  it('navigates rows, columns, home/end/page and key-scoped selection', () => {
    const c = createCollectionInteraction(options); c.focusIndex(10, 1);
    assert.equal(c.key({ key: 'ArrowDown', shiftKey: true }).key, 'row-11');
    c.key({ key: 'ArrowDown', shiftKey: true }); assert.equal(c.selected('row-11'), true);
    assert.deepEqual(c.state().selection.ranges, [{ fromKey: 'row-10', toKey: 'row-12' }]);
    assert.equal(c.key({ key: 'ArrowRight' }).column, 2);
    assert.equal(c.key({ key: 'ArrowLeft' }).column, 1);
    assert.equal(c.key({ key: 'PageDown' }).index, 22);
    assert.equal(c.key({ key: 'PageUp' }).index, 12);
    assert.equal(c.key({ key: 'Home', ctrlKey: true }).index, 0);
    assert.equal(c.key({ key: 'End', ctrlKey: true }).index, 99);
    assert.equal(c.key({ key: 'ArrowUp' }).index, 98);
    assert.equal(c.key({ key: 'Enter' }).state, 'activate');
    assert.equal(c.key({ key: 'Escape' }).state, 'return-focus');
    c.clear(); c.key({ key: ' ' }); assert.equal(c.selected('row-98'), true);
    c.update({ query: 'new' }); assert.equal(c.selected('row-98'), true);
    c.selectAll(); assert.equal(c.selected('not-loaded'), true);
    c.toggle('not-loaded'); assert.equal(c.selected('not-loaded'), false);
    c.toggle('not-loaded'); assert.equal(c.selected('not-loaded'), true);
    const intent = c.state().selection; c.clear(); c.restore(intent); assert.equal(c.selected('x'), true);
  });
  it('keeps valid focus during pending realization and ignores editing/composition', () => {
    const c = createCollectionInteraction(options); c.focusIndex(1);
    c.update({ keyAt: (i) => i < 2 ? `row-${i}` : null });
    assert.equal(c.key({ key: 'ArrowDown' }).state, 'loading');
    assert.equal(c.state().focus.key, 'row-1');
    c.update({ keyAt: options.keyAt }); assert.equal(c.state().focus.key, 'row-2');
    for (const event of [{ key: 'ArrowDown', editing: true }, { key: ' ', isComposing: true }, {key: 'x'}])
      assert.equal(c.key(event).state, 'ignored');
    c.update({ keyAt: (i) => `new-${i}`, indexOf: () => -1, removedKeys: ['row-2'] });
    assert.equal(c.state().focus.key, 'new-2');
    c.update({ count: 0 }); assert.equal(c.state().focus, null);
    assert.equal(c.key({ key: 'ArrowDown' }).state, 'ignored');
  });
  it('bounds selection intent and fences scoped selection across snapshots', () => {
    const c = createCollectionInteraction({ ...options, maxSelectedKeys: 1 });
    c.toggle('a'); assert.equal(c.toggle('b').state, 'budget-exhausted'); c.toggle('a');
    c.selectAll(); c.toggle('a'); assert.equal(c.toggle('b').state, 'budget-exhausted');
    c.update({ snapshot: 'changed' }); assert.equal(c.selected('c'), false);
    assert.equal(c.restore({ mode: 'keys', keys: ['a', 'b'], exclusions: [], ranges: [] }).reason, 'invalid-selection');
    const rtl = createCollectionInteraction({ ...options, direction: 'rtl', role: 'listbox' });
    rtl.focusIndex(5, 2); assert.equal(rtl.key({ key: 'ArrowRight' }).column, 1);
    assert.equal(rtl.key({ key: 'Home' }).index, 0); assert.equal(rtl.key({ key: 'End' }).index, 99);
  });
});

it('keeps shift range intent while the endpoint is being realized',()=>{
  const c=createCollectionInteraction(options);c.focusIndex(1);c.update({keyAt:i=>i<2?`row-${i}`:null});
  assert.equal(c.key({key:'ArrowDown',shiftKey:true}).state,'loading');
  c.update({keyAt:options.keyAt});assert.deepEqual(c.state().selection.ranges,[{fromKey:'row-1',toKey:'row-2'}]);
  c.update({keyAt:()=>null});c.key({key:'ArrowDown',shiftKey:true});c.update({query:'changed'});
  assert.equal(c.state().pending,null);c.cancelPending();
});
