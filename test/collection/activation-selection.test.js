//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCollectionInteraction } from '@jarenjs/collection';
import { mountCollection } from '@jarenjs/collection/component';
import { collectionHost } from './dom-host.js';

const keys = ['a', 'b', 'c', 'd'];
const base = { count: 4, columnCount: 3, keyAt: (i) => keys[i], indexOf: (k) => keys.indexOf(k), query: 'q', snapshot: 's' };
const sel = (over = {}) => ({ mode: 'keys', keys: [], ranges: [], exclusions: [], query: 'q', snapshot: 's', ...over });

describe('collection interaction: an interaction-owned selection (the default)', () => {
  it('ignores a selection passed to update, as it always has', () => {
    const ix = createCollectionInteraction(base);
    ix.focusIndex(1); ix.key({ key: ' ' });
    ix.update({ selection: sel({ keys: ['c', 'd'] }) });
    assert.deepEqual(ix.state().selection.keys, ['b']);
  });

  it('reports each change to onSelectionChange when one is given, and keeps it', () => {
    const seen = [];
    const ix = createCollectionInteraction({ ...base, onSelectionChange: (next) => seen.push(next) });
    ix.focusIndex(0); ix.key({ key: ' ' }); ix.key({ key: 'ArrowDown', shiftKey: true });
    ix.selectAll(); ix.clear();
    assert.deepEqual(seen.map((s) => [s.mode, s.keys, s.ranges]), [
      ['keys', ['a'], []], ['keys', [], [{ fromKey: 'a', toKey: 'b' }]], ['all', [], []], ['keys', [], []]]);
    assert.deepEqual(ix.state().selection, sel());
  });
});

describe('collection interaction: a host-owned selection', () => {
  it('shows the host\'s selection and turns Space, toggle, shift ranges, selectAll, clear and restore into requests', () => {
    const requests = [];
    const ix = createCollectionInteraction({ ...base, selection: sel({ keys: ['c'] }), onSelectionChange: (next) => requests.push(next) });
    assert.equal(ix.selected('c'), true);
    ix.focusIndex(0);
    assert.deepEqual(ix.key({ key: ' ' }), { state: 'ready' });
    assert.deepEqual(ix.toggle('c'), { state: 'ready' });
    ix.key({ key: 'ArrowDown', shiftKey: true });
    ix.selectAll(); ix.clear();
    assert.deepEqual(ix.restore(sel({ keys: ['d'] })), { state: 'ready' });
    assert.deepEqual(requests, [sel({ keys: ['c', 'a'] }), sel(), sel({ ranges: [{ fromKey: 'a', toKey: 'b' }] }),
      sel({ mode: 'all' }), sel(), sel({ keys: ['d'] })]);
    assert.deepEqual(ix.state().selection, sel({ keys: ['c'] }), 'unchanged until the host passes the next one');
    assert.equal(ix.selected('a'), false);
  });

  it('adopts the next selection the host passes, and a host may pass it from inside the request', () => {
    let ix, calls = 0;
    ix = createCollectionInteraction({ ...base, selection: sel(), onSelectionChange: (next) => { calls++; ix.update({ selection: next }); } });
    ix.focusIndex(1); ix.key({ key: ' ' });
    assert.deepEqual(ix.state().selection.keys, ['b']);
    ix.key({ key: 'ArrowDown', shiftKey: true }); ix.key({ key: 'ArrowDown', shiftKey: true });
    assert.deepEqual(ix.state().selection.ranges, [{ fromKey: 'b', toKey: 'd' }]);
    assert.equal(ix.selected('c'), true);
    assert.equal(calls, 3);
  });

  it('requests a shift range whose endpoint realizes later', () => {
    const loaded = new Set(['a', 'b']);
    const requests = [];
    const lookup = { keyAt: (i) => (loaded.has(keys[i]) ? keys[i] : undefined) };
    const ix = createCollectionInteraction({ ...base, ...lookup, selection: sel(), onSelectionChange: (next) => requests.push(next) });
    ix.focusIndex(1);
    assert.equal(ix.key({ key: 'ArrowDown', shiftKey: true }).state, 'loading');
    loaded.add('c');
    assert.equal(ix.update({}).state, 'ready');
    assert.deepEqual(requests, [sel({ ranges: [{ fromKey: 'b', toKey: 'c' }] })]);
    assert.deepEqual(ix.state().selection, sel());
  });

  it('refuses a malformed or over-budget selection at creation and on update, keeping the one it holds', () => {
    for (const bad of [null, 'a', sel({ mode: 'some' }), sel({ keys: [1] }), sel({ query: undefined }), sel({ ranges: [null] }),
      sel({ ranges: [{ fromKey: 'a', toKey: 'b' }, { fromKey: 'c', toKey: 'd' }] }), sel({ keys: ['a', 'b', 'c'] })])
      assert.throws(() => createCollectionInteraction({ ...base, maxSelectedKeys: 2, selection: bad }), RangeError, JSON.stringify(bad));
    const ix = createCollectionInteraction({ ...base, maxSelectedKeys: 2, selection: sel({ keys: ['a'] }) });
    assert.throws(() => ix.update({ selection: sel({ keys: ['a', 'b', 'c'] }), count: 1 }), RangeError);
    assert.deepEqual(ix.state().selection.keys, ['a']);
    assert.equal(ix.focusIndex(3).key, 'd', 'the refused update changed no other option either');
    ix.update({ selection: sel({ keys: ['a', 'b', 'c'] }), maxSelectedKeys: 3 });
    assert.deepEqual(ix.state().selection.keys, ['a', 'b', 'c']);
  });

  it('keeps key selection across a query change, as an owned selection does', () => {
    const ix = createCollectionInteraction({ ...base, selection: sel({ keys: ['b'], query: 'old' }) });
    assert.equal(ix.selected('b'), true);
    const all = createCollectionInteraction({ ...base, selection: sel({ mode: 'all', query: 'old' }) });
    assert.equal(all.selected('b'), false, 'a scoped all-selection does not reach another query');
  });

  it('re-reads the selection only when the host passes a different object', () => {
    const held = sel({ keys: ['a'] });
    const ix = createCollectionInteraction({ ...base, selection: held });
    held.keys.push('b');
    ix.update({ selection: held });
    assert.deepEqual(ix.state().selection.keys, ['a']);
    ix.update({ selection: { ...held } });
    assert.deepEqual(ix.state().selection.keys, ['a', 'b']);
  });
});

const rows = { count: 20, keyAt: (i) => `row-${i}`, indexOf: (key) => Number(key.slice(4)), getItem: (i) => ({ id: `row-${i}` }) };
// a cell holding a button: the shape whose click used to toggle the row
const withButton = { ...rows, columnCount: 2, renderCell: (row, column) => (column === 1 ? ['button', { type: 'button' }, 'Open'] : row.id) };
function mount(options) {
  const env = collectionHost();
  const activated = [];
  const c = mountCollection(env.host, { ...withButton, onActivate: (r) => activated.push(r), ...options });
  const cell = (row, column) => c.element.querySelectorAll('.jc-row')[row].querySelectorAll('.jc-cell')[column];
  const button = (row) => cell(row, 1).querySelectorAll('button')[0];
  const key = (k, extra = {}) => c.element.fire('keydown', { key: k, target: c.element, preventDefault() {}, ...extra });
  return { env, c, activated, cell, button, key };
}

describe('collection component: what a pointer click does', () => {
  it('toggles the row by default, on a plain cell and on a button in a cell', () => {
    const { c, activated, cell, button } = mount({});
    c.element.fire('click', { target: cell(0, 0) });
    assert.equal(c.interaction.selected('row-0'), true);
    assert.ok(button(1), 'the cell renders its button');
    c.element.fire('click', { target: button(1) });
    assert.equal(c.interaction.selected('row-1'), true);
    assert.deepEqual(activated, []);
    c.dispose();
  });

  it('under pointerActivation: activate, reports the row to onActivate as Enter does and leaves the selection', () => {
    const intents = [];
    const { c, activated, cell, button, key } = mount({ pointerActivation: 'activate', onIntent: (s) => intents.push(s) });
    c.element.fire('click', { target: cell(2, 0) });
    c.element.fire('click', { target: button(3) });
    assert.deepEqual(activated, [{ state: 'activate', key: 'row-2', column: 0 }, { state: 'activate', key: 'row-3', column: 1 }]);
    assert.equal(c.interaction.selected('row-2') || c.interaction.selected('row-3'), false);
    assert.equal(c.interaction.state().focus.key, 'row-3', 'the click still moves focus');
    assert.equal(intents.length, 2);
    key(' ');
    assert.equal(c.interaction.selected('row-3'), true, 'Space still toggles');
    key('Enter');
    assert.deepEqual(activated.at(-1), { state: 'activate', key: 'row-3', column: 1 }, 'Enter still activates');
    c.update({ pointerActivation: 'toggle' });
    c.element.fire('click', { target: cell(2, 0) });
    assert.equal(c.interaction.selected('row-2'), true);
    c.dispose();
  });

  it('leaves an editing target alone under both choices', () => {
    for (const pointerActivation of ['toggle', 'activate']) {
      const { c, activated } = mount({ pointerActivation, renderCell: (row, column) => (column === 1 ? ['input', { 'aria-label': row.id }] : row.id) });
      const input = c.element.querySelectorAll('.jc-row')[0].querySelectorAll('input')[0];
      c.element.fire('click', { target: input });
      assert.equal(c.interaction.selected('row-0'), false, pointerActivation);
      assert.deepEqual(activated, [], pointerActivation);
      c.dispose();
    }
  });

  it('refuses a choice it does not know, at mount and on update', () => {
    const env = collectionHost();
    for (const bad of ['select', true, 1, null])
      assert.throws(() => mountCollection(env.host, { ...withButton, pointerActivation: bad }), /Invalid pointerActivation/, String(bad));
    const c = mountCollection(env.host, withButton);
    assert.throws(() => c.update({ pointerActivation: 'select' }), /Invalid pointerActivation/);
    c.dispose();
  });
});

describe('collection component: a host-owned selection', () => {
  const scope = { query: '', snapshot: '' };
  const empty = { mode: 'keys', keys: [], ranges: [], exclusions: [], ...scope };

  it('selects only through the host: click, Space and Shift+Arrow request, and a host that applies them sees them', () => {
    let c;
    const requests = [];
    ({ c } = mount({ selection: empty, onSelectionChange: (next) => { requests.push(next); c.update({ selection: next }); } }));
    const { cell } = { cell: (row, column) => c.element.querySelectorAll('.jc-row')[row].querySelectorAll('.jc-cell')[column] };
    c.element.fire('click', { target: cell(1, 0) });
    assert.equal(c.interaction.selected('row-1'), true);
    c.element.fire('keydown', { key: 'ArrowDown', shiftKey: true, target: c.element, preventDefault() {} });
    assert.deepEqual(c.interaction.state().selection.ranges, [{ fromKey: 'row-1', toKey: 'row-2' }]);
    c.element.fire('keydown', { key: ' ', target: c.element, preventDefault() {} });
    assert.equal(c.interaction.selected('row-2'), false, 'Space excludes the focused range member');
    assert.equal(requests.length, 3);
    const shown = (key) => c.element.querySelectorAll('.jc-row').find((row) => row.getAttribute('data-key') === key)
      .querySelectorAll('.jc-cell')[0].getAttribute('aria-selected');
    // ARIA states as keywords: an empty value would read as not selected
    assert.deepEqual([shown('row-1'), shown('row-2'), shown('row-3')], ['true', 'false', 'false'], 'the rendered cells show the host selection');
    c.dispose();
  });

  it('keeps a range the host applied from inside the update that realized its endpoint', () => {
    const loaded = new Set(Array.from({ length: 6 }, (_, i) => `row-${i}`));
    const keyAt = (i) => (loaded.has(`row-${i}`) ? `row-${i}` : undefined);
    const held = { ...empty };
    let c;
    ({ c } = mount({ keyAt, selection: held, onSelectionChange: (next) => c.update({ selection: next }) }));
    c.interaction.focusIndex(5);
    c.element.fire('keydown', { key: 'ArrowDown', shiftKey: true, target: c.element, preventDefault() {} });
    assert.equal(c.interaction.state().pending?.index, 6);
    loaded.add('row-6');
    // a host (or the widget) re-sending all its options carries the selection it held before the request
    c.update({ keyAt, selection: held });
    assert.deepEqual(c.interaction.state().selection.ranges, [{ fromKey: 'row-5', toKey: 'row-6' }]);
    c.refresh();
    assert.equal(c.interaction.selected('row-6'), true);
    c.dispose();
  });

  it('keeps the host\'s selection when the host declines a request, and restore requests too', () => {
    const requests = [];
    const { c, cell, key } = mount({ selection: { ...empty, keys: ['row-4'] }, onSelectionChange: (next) => requests.push(next) });
    c.element.fire('click', { target: cell(0, 0) });
    key(' ');
    c.restore({ selection: { ...empty, keys: ['row-9'] } });
    assert.deepEqual(requests.map((r) => r.keys), [['row-4', 'row-0'], ['row-4', 'row-0'], ['row-9']]);
    assert.deepEqual(c.snapshot().selection.keys, ['row-4']);
    assert.equal(c.interaction.selected('row-0'), false);
    c.dispose();
  });

  it('refuses a malformed selection on update before changing anything', () => {
    const { c } = mount({ selection: empty });
    assert.throws(() => c.update({ selection: { keys: ['row-1'] }, count: 3 }), RangeError);
    c.refresh();
    assert.equal(c.element.getAttribute('aria-rowcount'), '20');
    assert.throws(() => mountCollection(collectionHost().host, { ...withButton, selection: { mode: 'keys' } }), RangeError);
    c.dispose();
  });
});
