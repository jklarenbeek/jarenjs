//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  sanitizeHref,
  num,
  svgRoot,
  group,
  rect,
  circle,
  line,
  path,
  polyline,
  polygon,
  textAt,
  textLines,
  polylinePath,
} from '@jarenjs/view/helpers';
import { renderToString } from '@jarenjs/view';

describe('view/helpers — num', () => {
  it('passes finite numbers through', () => {
    assert.equal(num(3.5), 3.5);
    assert.equal(num(0), 0);
    assert.equal(num(-2), -2);
  });
  it('falls back on NaN/±Inf (default 0)', () => {
    assert.equal(num(NaN), 0);
    assert.equal(num(Infinity), 0);
    assert.equal(num(-Infinity), 0);
  });
  it('honours a custom fallback', () => {
    assert.equal(num(NaN, 1), 1);
    assert.equal(num(Infinity, 42), 42);
  });
});

describe('view/helpers — sanitizeHref', () => {
  it('permits safe schemes', () => {
    assert.equal(sanitizeHref('https://ok.test'), 'https://ok.test');
    assert.equal(sanitizeHref('http://ok.test'), 'http://ok.test');
    assert.equal(sanitizeHref('mailto:a@b.c'), 'mailto:a@b.c');
    assert.equal(sanitizeHref('#anchor'), '#anchor');
    assert.equal(sanitizeHref('/path'), '/path');
    assert.equal(sanitizeHref('./rel'), './rel');
  });
  it('rejects dangerous or non-string input', () => {
    assert.equal(sanitizeHref('javascript:alert(1)'), null);
    assert.equal(sanitizeHref('data:text/html,x'), null);
    assert.equal(sanitizeHref(42), null);
    assert.equal(sanitizeHref(null), null);
  });
  it('trims before testing', () => {
    assert.equal(sanitizeHref('  https://ok.test  '), 'https://ok.test');
  });
});

describe('view/helpers — svgRoot', () => {
  const theme = { cssVars: { '--calc-axis': '#000' }, tokens: { fontFamily: 'Arial' } };

  it('builds a namespaced root with the caller class and cssVars', () => {
    const v = svgRoot('calc-plot', 100, 50, theme, ['x'], 'k1');
    assert.deepEqual(v, ['svg', {
      class: 'calc-plot',
      role: 'img',
      xmlns: 'http://www.w3.org/2000/svg',
      viewBox: '0 0 100 50',
      width: 100,
      height: 50,
      style: { '--calc-axis': '#000', 'font-family': 'Arial', 'max-width': '100%' },
      key: 'k1',
    }, 'x']);
  });

  it('omits key when not provided and defends non-finite size', () => {
    const v = svgRoot('mermaid mm-svg', NaN, NaN, theme, []);
    assert.equal(v[1].class, 'mermaid mm-svg');
    assert.equal(v[1].viewBox, '0 0 1 1');
    assert.equal(v[1].width, 1);
    assert.equal('key' in v[1], false);
  });
});

describe('view/helpers — element builders', () => {
  it('group returns a tagged <g>', () => {
    assert.deepEqual(group({ class: 'g' }, ['a', 'b']), ['g', { class: 'g' }, 'a', 'b']);
  });
  it('rect/circle/line/path/polygon/polyline defend coordinates', () => {
    assert.deepEqual(rect(NaN, 2, 3, 4, { fill: 'red' }), ['rect', { x: 0, y: 2, width: 3, height: 4, fill: 'red' }]);
    assert.deepEqual(circle(1, 2, 3, {}), ['circle', { cx: 1, cy: 2, r: 3 }]);
    assert.deepEqual(line(1, 2, 3, 4), ['line', { x1: 1, y1: 2, x2: 3, y2: 4 }]);
    assert.deepEqual(path('M0 0 L1 1', { stroke: 'k' }), ['path', { d: 'M0 0 L1 1', stroke: 'k' }]);
    assert.deepEqual(polygon([{ x: 0, y: 0 }, { x: 1, y: 1 }], { fill: 'g' }), ['polygon', { points: '0,0 1,1', fill: 'g' }]);
    assert.deepEqual(polyline([{ x: 0, y: 0 }, { x: 2, y: 3 }], {}), ['polyline', { points: '0,0 2,3', fill: 'none' }]);
  });
  it('textAt coerces the label with String()', () => {
    assert.deepEqual(textAt(1, 2, 42, 10, { fill: 'k' }), ['text', { x: 1, y: 2, 'font-size': 10, fill: 'k' }, '42']);
  });
  it('textLines centers one <tspan> per line', () => {
    const v = textLines(10, 20, ['a', 'b'], 10);
    assert.equal(v[0], 'text');
    const tspans = v.slice(2);
    assert.equal(tspans.length, 2);
    assert.equal(tspans[0][0], 'tspan');
    assert.equal(tspans[0][2], 'a');
    assert.equal(tspans[1][2], 'b');
  });
});

describe('view/helpers — polylinePath', () => {
  it('breaks the path on null / non-finite points', () => {
    const d = polylinePath([{ x: 0, y: 0 }, { x: 1, y: 1 }, null, { x: 2, y: 2 }]);
    assert.equal(d, 'M0 0 L1 1 M2 2');
  });
  it('returns empty string when nothing is drawable', () => {
    assert.equal(polylinePath([null, { x: NaN, y: 1 }]), '');
  });
});

describe('view/helpers — SSR round-trip', () => {
  it('renders to a valid SVG string', () => {
    const theme = { cssVars: {}, tokens: { fontFamily: 'Arial' } };
    const v = svgRoot('calc-plot', 10, 10, theme, [rect(0, 0, 10, 10, { fill: 'red' })], 'k');
    const s = renderToString(v);
    assert.match(s, /^<svg /);
    assert.match(s, /<rect/);
  });
});
