import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildScene2d, scene2dToVnode, buildScene3d, scene3dToVnode,
  calcToVnode, toSvgString, errorToVnode,
} from '@jarenjs/calc';

describe('#calc 2D plot geometry + render', function () {
  it('samples into a fixed-size buffer and maps to the viewport', () => {
    const scene = buildScene2d('sin(x)', { domain: [-Math.PI, Math.PI], samples: 64 });
    assert.equal(scene.kind, '2d');
    assert.equal(scene.series.length, 1);
    // points may include null breaks, but base sample count is honored
    assert.ok(scene.series[0].points.filter((p) => p !== null).length >= 60);
    // all screen points are inside the viewport
    for (const p of scene.series[0].points) {
      if (p === null) continue;
      assert.ok(p.x >= scene.plot.left - 1 && p.x <= scene.plot.right + 1);
      assert.ok(p.y >= scene.plot.top - 1 && p.y <= scene.plot.bottom + 1);
    }
  });

  it('breaks the path on discontinuities (tan asymptotes)', () => {
    const scene = buildScene2d('tan(x)', { domain: [-Math.PI, Math.PI], samples: 200, range: [-10, 10] });
    assert.ok(scene.series[0].points.some((p) => p === null), 'expected a break');
  });

  it('is deterministic (golden geometry)', () => {
    const a = buildScene2d('x^2', { domain: [-2, 2], samples: 5, range: [0, 4] });
    const b = buildScene2d('x^2', { domain: [-2, 2], samples: 5, range: [0, 4] });
    assert.deepEqual(a, b);
    // vertex at x=0 sits on the bottom (y = 0 → plot.bottom), at x=±2 on top
    const pts = a.series[0].points.filter((p) => p !== null);
    assert.ok(Math.abs(pts[2].y - a.plot.bottom) < 1);
  });

  it('renders to valid standalone SVG', () => {
    const svg = toSvgString(scene2dToVnode(buildScene2d(['sin(x)', 'cos(x)'], { domain: [-6, 6] })));
    assert.ok(svg.startsWith('<svg'));
    assert.ok(svg.includes('<path'));
    assert.ok(svg.includes('</svg>'));
  });
});

describe('#calc 3D plot geometry + render', function () {
  it('builds depth-sorted quads via the core matrix kernel', () => {
    const scene = buildScene3d('sin(x) * cos(y)', { grid: 8, yaw: 0.6, pitch: 0.5 });
    assert.equal(scene.kind, '3d');
    assert.equal(scene.quads.length, 64);
    // painter's algorithm: depth is monotonically non-increasing
    for (let i = 1; i < scene.quads.length; i++) {
      assert.ok(scene.quads[i - 1].depth >= scene.quads[i].depth - 1e-9);
    }
  });

  it('is deterministic (golden geometry)', () => {
    const a = buildScene3d('x^2 - y^2', { grid: 6 });
    const b = buildScene3d('x^2 - y^2', { grid: 6 });
    assert.deepEqual(a, b);
  });

  it('renders polygons to valid standalone SVG', () => {
    const svg = toSvgString(scene3dToVnode(buildScene3d('sin(x)*cos(y)', { grid: 8 })));
    assert.ok(svg.startsWith('<svg') && svg.includes('<polygon') && svg.includes('</svg>'));
  });
});

describe('#calc calcToVnode + error vnode', function () {
  it('chooses 2D vs 3D by variable usage', () => {
    assert.ok(toSvgString(calcToVnode('sin(x)')).includes('<path'));
    assert.ok(toSvgString(calcToVnode('sin(x)*cos(y)', { grid: 6 })).includes('<polygon'));
  });
  it('renders an error vnode instead of throwing', () => {
    const svg = toSvgString(calcToVnode('1 + *'));
    assert.ok(svg.includes('Expression error'));
  });
  it('errorToVnode is a small standalone SVG', () => {
    const svg = toSvgString(errorToVnode({ message: 'boom', line: 1, column: 2 }));
    assert.ok(svg.startsWith('<svg') && svg.includes('boom'));
  });
  it("theme 'host' stamps host-linked cssVars, keeps attributes concrete", () => {
    const v = calcToVnode('sin(x)', { theme: 'host' });
    assert.equal(v[1].style['--calc-series1'], 'var(--accent, #2563eb)');
    assert.equal(v[1].style['--calc-grid'], 'var(--border, #e2e8f0)');
    // the curve itself still carries the concrete stroke for standalone use
    assert.ok(toSvgString(v).includes('#2563eb'));
  });
});
