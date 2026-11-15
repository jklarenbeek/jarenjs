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
  const rail = { getBoundingClientRect: () => ({ right: railRight, top: 100, bottom: 900 }) };
  const styleSet = {};
  const grid = {
    style: { setProperty: (k, v) => { styleSet[k] = v; } },
    querySelector: (sel) => (sel === '.jplay-rail' ? rail : null),
    getBoundingClientRect: () => ({ left: gridLeft, right: gridRight, top: 0, bottom: 900 }),
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
  it('resizes a stacked layout along its vertical content span', () => {
    const w = createSplitterWidget(opts);
    const { host, doc, attrs, styleSet } = fakeEnv();
    const emitted = [];
    w.mount(host, { ratio: 0.5, axis: 'y' }, (e) => emitted.push(e));
    assert.strictEqual(attrs['aria-orientation'], 'horizontal');
    host.dispatch('pointerdown', { button: 0 });
    doc.dispatch('pointermove', { clientX: 600, clientY: 740 });
    doc.dispatch('pointerup', {});
    assert.strictEqual(emitted.at(-1).with, 0.8);
    assert.strictEqual(styleSet['--jplay-ratio-first'], '80fr');
    assert.strictEqual(styleSet['--jplay-ratio-rest'], '20fr');
    host.dispatch('keydown', { key: 'ArrowUp' });
    assert.strictEqual(emitted.at(-1).with, 0.75);
    host.dispatch('keydown', { key: 'ArrowDown' });
    assert.strictEqual(emitted.at(-1).with, 0.8);
  });

  it('cancels a pointer drag without a commit and removes document listeners', () => {
    const w = createSplitterWidget(opts);
    const { host, doc, styleSet } = fakeEnv();
    const emitted = [];
    const handle = w.mount(host, { ratio: 0.5 }, (e) => emitted.push(e));
    host.dispatch('pointerdown', { button: 0 });
    doc.dispatch('pointermove', { clientX: 840 });
    doc.dispatch('pointercancel', {});
    assert.strictEqual(handle.dragging, false);
    assert.strictEqual(styleSet['--jplay-ratio'], '0.5');
    assert.strictEqual(doc.count('pointermove'), 0);
    assert.strictEqual(doc.count('pointerup'), 0);
    assert.strictEqual(doc.count('pointercancel'), 0);
    assert.deepStrictEqual(emitted, []);
  });
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

describe('@jarenjs/app — the splitter writes its fractional tracks in hundredths', () => {
  // A grid track whose floor holds it at its minimum leaves the other track
  // the whole remaining space only when that track's factor is at least 1;
  // factors below 1 (0.8fr / 0.2fr) leave part of it empty.
  it('writes each share as a factor of 100, rounded to two decimals, the two summing to 100', () => {
    // 0.07 and 0.55 have no exact hundredfold (7.000000000000001, 55.00000000000001);
    // 0.12345 sits halfway, where rounding each share alone would sum to 100.01
    for (const [ratio, first, rest] of [[0.1, '10fr', '90fr'], [0.55, '55fr', '45fr'], [0.07, '7fr', '93fr'],
      [0.9, '90fr', '10fr'], [0.123456, '12.35fr', '87.65fr'], [0.12345, '12.35fr', '87.65fr']]) {
      const w = createSplitterWidget({ ...opts, min: 0.01, max: 0.99 });
      const { host, styleSet } = fakeEnv();
      w.mount(host, { ratio }, () => {});
      assert.strictEqual(styleSet['--jplay-ratio'], String(ratio), 'the raw ratio stays unrounded');
      assert.strictEqual(styleSet['--jplay-ratio-first'], first, String(ratio));
      assert.strictEqual(styleSet['--jplay-ratio-rest'], rest, String(ratio));
    }
  });

  it('keeps every factor at least 1 across the default clamp, arrow steps included', () => {
    const w = createSplitterWidget(opts);
    const { host, styleSet } = fakeEnv();
    const emitted = [];
    w.mount(host, { ratio: 0.5 }, (e) => emitted.push(e));
    for (const key of ['Home', 'ArrowRight', 'ArrowRight', 'End', 'ArrowLeft']) {
      host.dispatch('keydown', { key, shiftKey: key === 'ArrowLeft' });
      const first = parseFloat(styleSet['--jplay-ratio-first']), rest = parseFloat(styleSet['--jplay-ratio-rest']);
      assert.ok(first >= 1 && rest >= 1, `${key}: ${first} / ${rest}`);
      assert.strictEqual(Math.round((first + rest) * 100), 10000, key);
    }
    assert.strictEqual(styleSet['--jplay-ratio-first'], '89fr', 'End then a fine step');
  });
});

describe('@jarenjs/app — a splitter whose state holds a ratio that is not a number', () => {
  it('opens at the midpoint instead of writing NaN into the layout', () => {
    for (const ratio of ['abc', {}, [1, 2], Infinity, NaN]) {
      const w = createSplitterWidget(opts);
      const { host, attrs, styleSet } = fakeEnv();
      w.mount(host, { ratio }, () => {});
      assert.strictEqual(attrs['aria-valuenow'], '50', String(ratio));
      assert.strictEqual(styleSet['--jplay-ratio'], '0.5', String(ratio));
      assert.strictEqual(styleSet['--jplay-ratio-first'], '50fr', String(ratio));
      assert.strictEqual(styleSet['--jplay-ratio-rest'], '50fr', String(ratio));
    }
  });

  it('returns to the midpoint when an update brings a ratio that is not a number', () => {
    const w = createSplitterWidget(opts);
    const { host, attrs } = fakeEnv();
    const handle = w.mount(host, { ratio: 0.3 }, () => {});
    assert.strictEqual(attrs['aria-valuenow'], '30');
    w.update(handle, { ratio: 'abc' });
    assert.strictEqual(attrs['aria-valuenow'], '50');
    w.update(handle, { ratio: 0.7 });
    assert.strictEqual(attrs['aria-valuenow'], '70');
  });

  it('a number or numeric text still sets the split, clamped', () => {
    const w = createSplitterWidget(opts);
    const { host, attrs } = fakeEnv();
    const handle = w.mount(host, { ratio: '0.25' }, () => {});
    assert.strictEqual(attrs['aria-valuenow'], '25');
    w.update(handle, { ratio: 7 });
    assert.strictEqual(attrs['aria-valuenow'], '90');
    w.update(handle, { ratio: -1 });
    assert.strictEqual(attrs['aria-valuenow'], '10');
  });
});
