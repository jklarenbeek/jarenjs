//@ts-check
/**
 * @file The collection speaks the reader's language. A pseudo-locale
 * (every collection message id rendered as `⟦id⟧`) drives the grid's
 * accessible name, a row still loading, and a keyboard and a pointer drag
 * through each announcement and the overlay: none of it may show the
 * English catalog's text, and every id must be reached. Without a
 * catalog every word is the English it was, and an explicit `label` /
 * `loadingLabel` still wins over the catalog.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { compileMessageCatalog } from '@jarenjs/core/message';
import { createCollection, collectionMessagesEn, collectionText } from '@jarenjs/collection';
import { mountCollection, mountCollectionDrag } from '@jarenjs/collection/component';
import { collectionHost } from './dom-host.js';

const IDS = Object.keys(collectionMessagesEn);
const reached = new Set();
const PSEUDO = compileMessageCatalog(Object.fromEntries(IDS.map((id) => [id, () => { reached.add(id); return `⟦${id}⟧`; }])));

/** Every text of a vnode or stub subtree. @returns {string[]} */
function texts(/** @type {any} */ node, /** @type {string[]} */ out = []) {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const child of typeof node[0] === 'string' ? node.slice(2) : node) texts(child, out);
  else if (node?.nodeType === 3) out.push(node.nodeValue);
  else for (const child of node?.childNodes ?? []) texts(child, out);
  return out;
}
const flat = (/** @type {any} */ node) => texts(node).join('');

/** A mounted grid with one drag handle (row `a`, column `x`), a stub window, and the drag over it. */
function dragged(/** @type {any} */ messages) {
  const h = collectionHost();
  const { document, host } = h;
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();
  Object.assign(document.defaultView, {
    addEventListener: (/** @type {string} */ type, /** @type {Function} */ fn) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(fn);
    },
    removeEventListener: (/** @type {string} */ type, /** @type {Function} */ fn) => listeners.get(type)?.delete(fn),
    getComputedStyle: () => ({ visibility: 'visible', overflowX: 'hidden', overflowY: 'hidden', touchAction: 'none' }),
  });
  const fire = (/** @type {string} */ type, /** @type {any} */ event) => { for (const fn of listeners.get(type) ?? []) fn(event); };
  /** @type {any} */ (document).elementsFromPoint = () => [];
  const create = document.createElement;
  document.createElement = (/** @type {string} */ name) => {
    const el = create(name);
    Object.defineProperty(el, 'isConnected', { get: () => host.contains(el) });
    el.getClientRects = () => [{}];
    el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 10, bottom: 10, width: 10, height: 28 });
    el.setPointerCapture = () => {}; el.hasPointerCapture = () => false; el.releasePointerCapture = () => {};
    // the drag locates a cell by `[data-row="R"] [data-column="C"]`
    const one = el.querySelector;
    el.querySelector = (/** @type {string} */ selector) => {
      const m = /^\[data-row="(\d+)"\] \[data-column="(\d+)"\]$/.exec(selector);
      if (m === null) return one(selector);
      const row = el.querySelectorAll('[data-row]').find((/** @type {any} */ r) => String(r.getAttribute('data-row')) === m[1]);
      return row?.querySelectorAll('[data-column]').find((/** @type {any} */ c) => String(c.getAttribute('data-column')) === m[2]) ?? null;
    };
    return el;
  };
  const keys = ['a', 'b', 'c'], columns = ['x', 'y'];
  const node = document.createElement('section'); host.appendChild(node);
  const mounted = mountCollection(node, { count: 3, keyAt: (/** @type {number} */ i) => keys[i], indexOf: (/** @type {string} */ k) => keys.indexOf(k),
    getItem: (/** @type {number} */ i) => ({ key: keys[i] }), columnCount: 2, messages,
    renderCell: (/** @type {any} */ row, /** @type {number} */ c) => (row.key === 'a' && c === 0 ? ['button', { 'data-jc-drag': 'a' }, 'drag'] : row.key),
    requestFrame: h.requestFrame, cancelFrame: h.cancelFrame, observe: h.observe });
  h.flush();
  const drag = mountCollectionDrag([{ id: 'l', mounted, columnKey: (i) => columns[i], indexOfColumn: (k) => columns.indexOf(k) }], {
    resolveSource: (key) => ({ key, revision: 1 }), locateSource: () => ({ container: 'l', key: 'a', column: 'x' }),
    commit: () => true, portal: host, requestFrame: h.requestFrame, cancelFrame: h.cancelFrame, messages });
  const handle = node.querySelectorAll('[data-jc-drag]')[0];
  const status = host.childNodes.find((/** @type {any} */ n) => n.getAttribute?.('role') === 'status');
  const overlay = () => host.childNodes.find((/** @type {any} */ n) => n.getAttribute?.('data-jc-overlay') === '');
  const key = (/** @type {string} */ k, alt = false) => ({ key: k, altKey: alt, target: handle, preventDefault() {}, stopImmediatePropagation() {} });
  const pointer = (/** @type {number} */ x, alt = false) => ({ button: 0, isPrimary: true, pointerId: 1, pointerType: 'mouse', clientX: x, clientY: 0,
    altKey: alt, target: handle, preventDefault() {} });
  return { mounted, drag, fire, key, pointer, h, status, overlay, viewport: mounted.element };
}

/** The announcements and overlays of one scripted session: keyboard move,
 * copy, drop; a pointer drag with no target; escape. */
async function session(/** @type {any} */ messages) {
  const d = dragged(messages);
  const seen = [d.viewport.getAttribute('aria-label')];
  const note = () => { seen.push(flat(d.status)); const o = d.overlay(); if (o) seen.push(flat(o)); };
  d.fire('keydown', d.key('Enter')); note();
  d.fire('keydown', d.key('ArrowDown')); note();
  d.fire('keydown', d.key('Alt', true)); note();
  d.fire('keydown', d.key('Enter')); note();
  await new Promise((resolve) => setTimeout(resolve, 0)); note();
  d.fire('pointerdown', d.pointer(0)); d.fire('pointermove', d.pointer(40)); note();
  d.fire('keydown', d.key('Escape')); note();
  d.fire('pointerdown', d.pointer(0, true)); d.fire('pointermove', d.pointer(40, true)); note();
  d.fire('keydown', d.key('Escape')); note();
  d.drag.dispose(); d.mounted.dispose();
  return seen.filter((text) => text !== '');
}

describe('collection messages', () => {
  it('shows no English under a pseudo-locale, and reaches every id', async () => {
    const shown = await session(PSEUDO);
    const loading = createCollection({ count: 2, keyAt: () => null, getItem: () => null, renderCell: () => '', messages: PSEUDO });
    loading.viewport({ width: 320, height: 440 });
    shown.push(...texts(loading.view()));
    const english = new Set(Object.values(collectionMessagesEn).map((entry) => String(entry).split('{')[0].trim()));
    for (const text of shown) {
      assert.ok(text.includes('⟦'), `unmarked chrome "${text}"`);
      for (const word of english) assert.ok(!text.includes(word), `English "${word}" in "${text}"`);
    }
    assert.deepEqual(IDS.filter((id) => !reached.has(id)), []);
  });

  it('keeps the English without a catalog, and an explicit label wins', async () => {
    assert.deepEqual(await session(undefined), [
      'Collection',
      'Moving a to a, x. Enter to drop, Escape to cancel.', 'Move a',
      'Moving a to b, x. Enter to drop, Escape to cancel.', 'Move a',
      'Copying a to b, x. Enter to drop, Escape to cancel.', 'Copy a',
      'Checking drop.', 'Copy a',
      'Drop accepted.',
      'Moving a. Enter to drop, Escape to cancel.', 'Move a',
      'Drag cancelled: escape.',
      'Copying a. Enter to drop, Escape to cancel.', 'Copy a',
      'Drag cancelled: escape.',
    ]);
    const options = { count: 1, keyAt: () => null, getItem: () => null, renderCell: () => '' };
    const english = createCollection(options); english.viewport({ width: 320, height: 440 });
    assert.deepEqual(texts(english.view()), ['Loading…']);
    const own = createCollection({ ...options, loadingLabel: 'Wait', messages: PSEUDO }); own.viewport({ width: 320, height: 440 });
    assert.deepEqual(texts(own.view()), ['Wait']);
    const h = collectionHost();
    const mounted = mountCollection(h.host, { ...options, label: 'Mine', messages: PSEUDO, requestFrame: h.requestFrame, cancelFrame: h.cancelFrame, observe: h.observe });
    h.flush();
    assert.equal(mounted.element.getAttribute('aria-label'), 'Mine');
    mounted.dispose();
  });

  it('falls back to English per id, for a missing, throwing or non-string entry', () => {
    assert.equal(collectionText(compileMessageCatalog({ 'collection/label': () => { throw new Error('x'); } }))('collection/label'), 'Collection');
    assert.equal(collectionText(/** @type {any} */ ({ 'collection/loading': () => 1 }))('collection/loading'), 'Loading…');
    assert.equal(collectionText()('collection/unknown'), 'collection/unknown');
  });

  it('uses every id of its catalog in the source', () => {
    const source = ['collection.js', 'component/index.js', 'component/drag.js']
      .map((file) => readFileSync(new URL(`../../components/collection/src/${file}`, import.meta.url), 'utf8')).join('\n');
    for (const id of IDS) assert.ok(source.includes(`'${id}'`), `${id} is used`);
  });
});
