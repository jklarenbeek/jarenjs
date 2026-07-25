//@ts-check
/**
 * @file The x·y·z surface plotter. Samples
 * `z = f(x, y)` on an N×N grid into `Vec3f64` model points, rotates them
 * (yaw/pitch) and projects them with the `core` `mat4`/`project.js`
 * kernel, builds quad faces, **depth-sorts back-to-front (painter's
 * algorithm)**, shades each quad by height and emits `<polygon>`s with an
 * optional wireframe. Deterministic and headless → golden-geometry tests.
 */

import { Float64, Vec3f64, Mat4, project3dTo2d, remap } from '@jarenjs/core/math';
import { lerpColor } from '@jarenjs/core/color';
import { svgRoot, polygon } from '@jarenjs/view/helpers';
import { parseExpression } from '../parser/index.js';
import { compileExpr } from '../compile.js';
import { defaultEnv } from '../env.js';
import { createTheme } from '../theme.js';
import { hashContent } from '../utils.js';

const DEFAULTS = {
  width: 420,
  height: 360,
  grid: 24,
  domainX: [-3, 3],
  domainY: [-3, 3],
  yaw: 0.6,
  pitch: 0.5,
  variables: ['x', 'y'],
  distance: 3.2,
};

/**
 * @typedef {object} Plot3dConfig
 * @property {string} [expr] the z = f(x,y) source
 * @property {[number,number]} [domainX] @property {[number,number]} [domainY]
 * @property {number} [grid] samples per axis
 * @property {number} [yaw] @property {number} [pitch] rotation, radians
 * @property {number} [width] @property {number} [height]
 * @property {[string,string]} [variables] independent variable names
 * @property {any} [scope] @property {any} [env]
 * @property {any} [theme] @property {boolean} [wireframe]
 */

/**
 * Build the projected, depth-sorted scene (geometry as plain JSON).
 * @param {string|Plot3dConfig} exprOrConfig
 * @param {Plot3dConfig} [options]
 * @returns {any}
 */
export function buildScene3d(exprOrConfig, options = {}) {
  /** @type {Plot3dConfig} */
  const cfg = typeof exprOrConfig === 'string'
    ? { ...options, expr: exprOrConfig }
    : { ...options, ...exprOrConfig };

  const width = cfg.width ?? DEFAULTS.width;
  const height = cfg.height ?? DEFAULTS.height;
  const N = Math.max(2, cfg.grid ?? DEFAULTS.grid);
  const [xmin, xmax] = cfg.domainX ?? DEFAULTS.domainX;
  const [ymin, ymax] = cfg.domainY ?? DEFAULTS.domainY;
  const yaw = cfg.yaw ?? DEFAULTS.yaw;
  const pitch = cfg.pitch ?? DEFAULTS.pitch;
  const [vx, vy] = cfg.variables ?? DEFAULTS.variables;
  const env = cfg.env ?? defaultEnv();

  let fn;
  try {
    fn = compileExpr(parseExpression(String(cfg.expr ?? '0')), { env });
  }
  catch {
    return { kind: '3d', width, height, quads: [], error: true };
  }

  // sample z on the grid, tracking z-range for normalization/shading
  const zs = [];
  let zmin = Infinity;
  let zmax = -Infinity;
  const scope = { ...(cfg.scope ?? {}) };
  for (let i = 0; i <= N; i++) {
    const row = [];
    for (let j = 0; j <= N; j++) {
      scope[vx] = remap(i, 0, N, xmin, xmax);
      scope[vy] = remap(j, 0, N, ymin, ymax);
      const z = +fn(scope);
      row.push(z);
      if (Number.isFinite(z)) { if (z < zmin) zmin = z; if (z > zmax) zmax = z; }
    }
    zs.push(row);
  }
  if (!(zmax > zmin)) { zmin = -1; zmax = 1; }

  // model → view → projection
  const model = Mat4.multiply(Mat4.rotationX(pitch), Mat4.rotationY(yaw));
  const view = Mat4.translation(0, 0, -(cfg.distance ?? DEFAULTS.distance));
  const proj = Mat4.perspective(Math.PI / 3.2, width / height, 0.1, 100);
  const mvp = Mat4.multiply(proj, Mat4.multiply(view, model));
  const viewport = { x: 0, y: 0, width, height };

  const toModel = (i, j) => {
    const nx = remap(i, 0, N, -1.2, 1.2);
    const ny = remap(j, 0, N, -1.2, 1.2);
    const nz = Number.isFinite(zs[i][j]) ? remap(zs[i][j], zmin, zmax, -0.7, 0.7) : NaN;
    return new Vec3f64(nx, nz, ny); // z-height becomes the vertical (world Y)
  };

  // project every grid vertex once
  const proj2d = [];
  for (let i = 0; i <= N; i++) {
    const row = [];
    for (let j = 0; j <= N; j++) {
      const m = toModel(i, j);
      row.push(Number.isFinite(m.y) ? project3dTo2d(m, mvp, viewport) : null);
    }
    proj2d.push(row);
  }

  // build quads with average depth + height shade
  const quads = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const a = proj2d[i][j], b = proj2d[i + 1][j], c = proj2d[i + 1][j + 1], d = proj2d[i][j + 1];
      if (a === null || b === null || c === null || d === null) continue;
      const depth = (a.z + b.z + c.z + d.z) / 4;
      const avgZ = (zs[i][j] + zs[i + 1][j] + zs[i + 1][j + 1] + zs[i][j + 1]) / 4;
      const shade = Float64.clamp(remap(avgZ, zmin, zmax, 0, 1), 0, 1);
      quads.push({
        points: [round(a), round(b), round(c), round(d)],
        depth: Float64.roundTo(depth, 4),
        shade: Float64.roundTo(shade, 3),
      });
    }
  }
  // painter's algorithm: farthest first (larger NDC z = farther)
  quads.sort((p, q) => q.depth - p.depth);

  return {
    kind: '3d', width, height,
    zrange: [zmin, zmax],
    wireframe: cfg.wireframe ?? true,
    quads,
  };
}

/** @param {{x:number,y:number}} p */
function round(p) {
  return { x: Float64.roundTo(p.x, 2), y: Float64.roundTo(p.y, 2) };
}

/**
 * Render a 3D scene into pure-vnode SVG.
 * @param {any} scene @param {{ theme?: any }} [options]
 * @returns {any}
 */
export function scene3dToVnode(scene, options = {}) {
  const theme = createTheme(options.theme ?? 'default');
  const t = theme.tokens;
  const children = scene.quads.map((quad) => polygon(quad.points, {
    fill: lerpColor(t.surfaceLo, t.surfaceHi, quad.shade),
    stroke: scene.wireframe ? t.wire : 'none',
    'stroke-width': scene.wireframe ? 0.4 : 0,
    'stroke-linejoin': 'round',
    class: 'calc-face',
  }));
  const key = 'p3:' + hashContent(JSON.stringify({ z: scene.zrange, n: scene.quads.length, q0: scene.quads[0] }));
  return svgRoot('calc-plot', scene.width, scene.height, theme, children, key);
}

/**
 * Compile → sample → project → SVG vnode in one call.
 * @param {string|Plot3dConfig} exprOrConfig
 * @param {Plot3dConfig} [options]
 * @returns {any}
 */
export function plot3d(exprOrConfig, options = {}) {
  const scene = buildScene3d(exprOrConfig, options);
  return scene3dToVnode(scene, { theme: options.theme });
}
