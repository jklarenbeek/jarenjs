//@ts-check
/**
 * @file The reusable drag-splitter widget (`@jarenjs/app`), headless: ratio
 * math from a pointer x, the live-drag-then-commit protocol over document
 * listeners, keyboard resize as an ARIA separator, and clean teardown. A
 * hand-built fake host/grid gives exact control of the geometry the widget
 * reads (`getBoundingClientRect`), which a generic DOM stub cannot.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createSplitterWidget } from '@jarenjs/app';

/** A fake host + grid + owner-document with recordable listeners + geometry. */
function fakeEnv({ gridLeft = 0, gridRight = 1000, railRight = 200 } = {}) {
  const bag = () => new Map();
  const add = (m) => (type, fn) => { (m.get(type) ?? m.set(type, new Set()).get(type)).add(fn); };
  const del = (m) => (type, fn) => { m.get(type)?.delete(fn); };
  const emit = (m) => (type, e) => { for (const fn of [...(m.get(type) ?? [])]) fn(e); };

  const docL = bag();
  const doc = {
    addEventListener: add(docL), removeEventListener: del(docL),
    dispatch: emit(docL), count: (type) => (docL.get(type)?.size ?? 0),
  };
  const rail = { getBoundingClientRect: () => ({ right: railRight }) };
  const styleSet = {};
  const grid = {
    style: { setProperty: (k, v) => { styleSet[k] = v; } },
    querySelector: (sel) => (sel === '.jplay-rail' ? rail : null),
    getBoundingClientRect: () => ({ left: gridLeft, right: gridRight }),
  };
  const hostL = bag();
  const attrs = {};
  const host = {
    ownerDocument: doc,
    closest: (sel) => (sel === '.jplay' ? grid : null),
    setAttribute: (k, v) => { attrs[k] = v; },
    addEventListener: add(hostL), removeEventListener: del(hostL),
    dispatch: emit(hostL), count: (type) => (hostL.get(type)?.size ?? 0),
  };
  return { host, doc, grid, styleSet, attrs };
}

const opts = { grid: '.jplay', rail: '.jplay-rail', cssVar: '--jplay-ratio', action: 'play/layout-ratio' };

describe('@jarenjs/app — createSplitterWidget', () => {
  it('applies the initial ratio to the CSS variable and ARIA on mount', () => {
    const w = createSplitterWidget(opts);
    const { host, styleSet, attrs } = fakeEnv();
    w.mount(host, { ratio: 0.5 }, () => {});
    assert.strictEqual(styleSet['--jplay-ratio'], '0.5');
    assert.strictEqual(attrs['aria-valuenow'], '50');
  });

  it('a drag updates the CSS var live and commits the ratio only on pointer-up', () => {
    const w = createSplitterWidget(opts);
    const { host, doc, styleSet } = fakeEnv({ gridLeft: 0, gridRight: 1000, railRight: 200 });
    const emits = [];
    const handle = w.mount(host, { ratio: 0.5 }, (e) => emits.push(e));

    host.dispatch('pointerdown', { button: 0, preventDefault() {} });
    assert.strictEqual(doc.count('pointermove'), 1, 'move rides the document during a drag');
    assert.strictEqual(doc.count('pointerup'), 1);

    // x=600 over a [200..1000] span → (600-200)/800 = 0.5; x=840 → 0.8
    doc.dispatch('pointermove', { clientX: 840, preventDefault() {} });
    assert.strictEqual(styleSet['--jplay-ratio'], '0.8', 'the drag drives the var live');
    assert.strictEqual(emits.length, 0, 'no dispatch mid-drag (would flood undo)');

    doc.dispatch('pointerup', {});
    assert.deepStrictEqual(emits, [{ action: 'play/layout-ratio', with: 0.8 }], 'commit on up');
    assert.strictEqual(doc.count('pointermove'), 0, 'document listeners torn off on up');
    assert.strictEqual(handle.dragging, false);
  });

  it('clamps the pointer ratio to [min, max]', () => {
    const w = createSplitterWidget(opts);
    const { host, doc } = fakeEnv({ gridRight: 1000, railRight: 200 });
    const emits = [];
    w.mount(host, { ratio: 0.5 }, (e) => emits.push(e));
    host.dispatch('pointerdown', { button: 0, preventDefault() {} });
    doc.dispatch('pointermove', { clientX: 0, preventDefault() {} }); // left of the rail
    doc.dispatch('pointerup', {});
    assert.strictEqual(emits[0].with, 0.1, 'clamped to the min');
  });

  it('keyboard resizes as an ARIA separator (arrows, Shift, Home/End)', () => {
    const w = createSplitterWidget(opts);
    const { host } = fakeEnv();
    const emits = [];
    w.mount(host, { ratio: 0.5 }, (e) => emits.push(e));
    host.dispatch('keydown', { key: 'ArrowRight', preventDefault() {} });
    assert.strictEqual(emits.at(-1).with, 0.55, 'arrow = ±0.05');
    host.dispatch('keydown', { key: 'ArrowLeft', shiftKey: true, preventDefault() {} });
    assert.ok(Math.abs(emits.at(-1).with - 0.54) < 1e-9, 'Shift = ±0.01');
    host.dispatch('keydown', { key: 'Home', preventDefault() {} });
    assert.strictEqual(emits.at(-1).with, 0.1, 'Home → min');
    host.dispatch('keydown', { key: 'End', preventDefault() {} });
    assert.strictEqual(emits.at(-1).with, 0.9, 'End → max');
  });

  it('update() syncs an external ratio only when not dragging; unmount tears listeners off', () => {
    const w = createSplitterWidget(opts);
    const { host, doc, styleSet } = fakeEnv();
    const handle = w.mount(host, { ratio: 0.5 }, () => {});
    w.update(handle, { ratio: 0.3 });
    assert.strictEqual(styleSet['--jplay-ratio'], '0.3');
    // mid-drag, an external ratio must not yank the handle
    host.dispatch('pointerdown', { button: 0, preventDefault() {} });
    w.update(handle, { ratio: 0.7 });
    assert.strictEqual(styleSet['--jplay-ratio'], '0.3', 'ignored while dragging');
    doc.dispatch('pointerup', {});
    w.unmount(handle);
    assert.strictEqual(host.count('pointerdown'), 0, 'host listeners removed');
    assert.strictEqual(host.count('keydown'), 0);
  });
});
