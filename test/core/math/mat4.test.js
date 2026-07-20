import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Mat4, project3dTo2d, surfaceNormal, Vec3f64 } from '@jarenjs/core/math';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !~= ${b}`);

describe('#Mat4 + projection (A4)', function () {
  it('identity', () => {
    const m = Mat4.identity();
    assert.equal(m.length, 16);
    const p = Mat4.transformPoint(m, 3, 4, 5);
    close(p.x, 3); close(p.y, 4); close(p.z, 5);
  });

  it('rotation composition: rotateZ(90°) maps +X to +Y', () => {
    const m = Mat4.rotationZ(Math.PI / 2);
    const p = Mat4.transformPoint(m, 1, 0, 0);
    close(p.x, 0); close(p.y, 1);
  });

  it('multiply composes transforms (translate then rotate)', () => {
    const t = Mat4.translation(1, 0, 0);
    const r = Mat4.rotationZ(Math.PI / 2);
    // apply translate first, then rotate: multiply(r, t)
    const m = Mat4.multiply(r, t);
    const p = Mat4.transformPoint(m, 0, 0, 0);
    close(p.x, 0); close(p.y, 1);
  });

  it('scaling', () => {
    const p = Mat4.transformPoint(Mat4.scaling(2, 3, 4), 1, 1, 1);
    close(p.x, 2); close(p.y, 3); close(p.z, 4);
  });

  it('ortho maps the cube corners into NDC', () => {
    const m = Mat4.ortho(-1, 1, -1, 1, -1, 1);
    const p = Mat4.transformPoint(m, 1, 1, 0);
    close(p.x, 1); close(p.y, 1);
  });

  it('perspective divides by w', () => {
    const m = Mat4.perspective(Math.PI / 2, 1, 0.1, 100);
    const near = Mat4.transformPoint(m, 0, 0, -1);
    const far = Mat4.transformPoint(m, 0, 0, -10);
    // farther points have larger NDC depth
    assert.ok(far.z > near.z);
  });

  it('project3dTo2d maps a unit cube face and flips Y for SVG', () => {
    const m = Mat4.identity();
    const vp = { x: 0, y: 0, width: 200, height: 100 };
    const center = project3dTo2d({ x: 0, y: 0, z: 0 }, m, vp);
    close(center.x, 100); close(center.y, 50);
    const top = project3dTo2d({ x: 0, y: 1, z: 0 }, m, vp);
    assert.ok(top.y < center.y, 'world +Y projects upward (smaller screen y)');
  });

  it('surfaceNormal of a known triangle points +Z', () => {
    const n = surfaceNormal(
      new Vec3f64(0, 0, 0),
      new Vec3f64(1, 0, 0),
      new Vec3f64(0, 1, 0),
    );
    close(n.x, 0); close(n.y, 0); assert.ok(n.z > 0);
  });
});
