//@ts-check
/**
 * Lighting as a first-class system, drawn the way the figures are: flat.
 * There are no gradients to compute — a face takes one of a few cel
 * bands of its own colour, picked by how squarely it faces the sun, the
 * way a poster printer would separate it — and the light is felt more
 * than modelled: long hard shadows that swing with the hour, warm dawns,
 * white noons, orange dusks, and at night a blue room where spotlights
 * pick out whoever is performing.
 *
 * A lighting rig is plain data (`createLighting`), so the hour, the
 * spots and the band count are things the Settings app, a game level or
 * a language model can set; `shade` and `shadowPolygon` are pure.
 */

import { lerpColor } from '@jarenjs/core/color';

/**
 * @typedef {[number, number, number]} V3
 * @typedef {{ x: number, z: number, radius: number, color: string, power: number }} Spot
 * @typedef {{ hour: number, sun: V3, sunColor: string, power: number, ambient: number, sky: string,
 *   night: boolean, bands: number, spots: Spot[], shadows: boolean }} Lighting
 */

/** Light through the day: the colour the sun casts and what the sky wears. */
const DAY = Object.freeze([
  { hour: 0, sun: '#93c5fd', sky: '#0b1324', power: 0.32 },
  { hour: 5.5, sun: '#fdba74', sky: '#1e293b', power: 0.42 },
  { hour: 7, sun: '#fed7aa', sky: '#fff1d6', power: 0.75 },
  { hour: 12, sun: '#fffbeb', sky: '#fff7e6', power: 1 },
  { hour: 17, sun: '#fde68a', sky: '#fff0cf', power: 0.85 },
  { hour: 19, sun: '#fb923c', sky: '#3b2a1a', power: 0.55 },
  { hour: 21, sun: '#93c5fd', sky: '#0b1324', power: 0.32 },
  { hour: 24, sun: '#93c5fd', sky: '#0b1324', power: 0.32 },
]);

/**
 * Where the light comes from at an hour (0–24): the sun rises in the
 * east (+x), stands high at noon and sets in the west; at night the moon
 * takes the opposite arc, lower and paler.
 * @param {number} hour
 * @returns {{ sun: V3, sunColor: string, sky: string, power: number, night: boolean }}
 */
export function sunAt(hour) {
  const h = ((hour % 24) + 24) % 24;
  const day = h >= 6 && h <= 18;
  const arc = day ? ((h - 6) / 12) * Math.PI : (((h + 6) % 24) / 12) * Math.PI;
  const height = day ? 0.25 + 0.75 * Math.sin(arc) : 0.2 + 0.35 * Math.sin(arc);
  const across = Math.cos(arc);
  const sun = normalize([across, height, -0.35]);
  let i = 0;
  while (i < DAY.length - 2 && DAY[i + 1].hour <= h) i++;
  const a = DAY[i];
  const b = DAY[i + 1];
  const t = (h - a.hour) / Math.max(1e-9, b.hour - a.hour);
  return {
    sun,
    sunColor: lerpColor(a.sun, b.sun, t),
    sky: lerpColor(a.sky, b.sky, t),
    power: a.power + (b.power - a.power) * t,
    night: !day,
  };
}

/** @param {V3} v @returns {V3} */
function normalize(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/**
 * A lighting rig for an hour.
 * @param {{ hour?: number, bands?: number, spots?: Spot[], shadows?: boolean }} [options]
 * @returns {Lighting}
 */
export function createLighting(options = {}) {
  const hour = options.hour ?? 10;
  const at = sunAt(hour);
  return {
    hour,
    sun: at.sun,
    sunColor: at.sunColor,
    power: at.power,
    ambient: at.night ? 0.42 : 0.55,
    sky: at.sky,
    night: at.night,
    bands: Math.max(1, Math.min(6, Math.round(options.bands ?? 3))),
    spots: options.spots ?? [],
    shadows: options.shadows ?? true,
  };
}

/**
 * The colour a face of `color` shows under a rig: its lambert term,
 * cut into the rig's cel bands, between the colour in shadow and the
 * colour warmed (or cooled) by the light.
 * @param {string} color @param {V3} normal - unit, world space @param {Lighting} light @param {string} [shadowInk]
 * @returns {string}
 */
export function shade(color, normal, light, shadowInk = '#11131c') {
  const lambert = Math.max(0, normal[0] * light.sun[0] + normal[1] * light.sun[1] + normal[2] * light.sun[2]);
  const band = Math.min(light.bands, Math.floor(lambert * light.bands + 0.5)) / light.bands;
  const lit = light.ambient + (1 - light.ambient) * band * light.power;
  const tinted = lerpColor(color, light.sunColor, 0.18 * light.power);
  return lerpColor(lerpColor(color, shadowInk, 0.55), tinted, Math.max(0, Math.min(1, lit)));
}

/**
 * The shadow an axis-aligned block casts on the floor (y = 0): its
 * footprint joined to its top corners carried down along the light, as
 * one convex polygon of [x, z] points. Empty when the light is under the
 * horizon or the block is flat.
 * @param {{ x0: number, x1: number, z0: number, z1: number, h: number }} block
 * @param {V3} sun
 * @returns {number[]} flat [x0, z0, x1, z1, …]
 */
export function shadowPolygon(block, sun, reach = 6) {
  if (sun[1] <= 0.05 || block.h <= 0.01) return [];
  const along = Math.min(reach, block.h / sun[1]);
  const dx = -sun[0] * along;
  const dz = -sun[2] * along;
  const corners = [[block.x0, block.z0], [block.x1, block.z0], [block.x1, block.z1], [block.x0, block.z1]];
  const points = [...corners, ...corners.map(([x, z]) => [x + dx, z + dz])];
  return convexHull(points).flat();
}

/**
 * Andrew's monotone chain: the convex hull of 2D points, counter-clockwise.
 * @param {number[][]} points @returns {number[][]}
 */
export function convexHull(points) {
  const pts = points.map((p) => [p[0], p[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const turn = (/** @type {number[]} */ o, /** @type {number[]} */ a, /** @type {number[]} */ b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  /** @type {number[][]} */
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && turn(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  /** @type {number[][]} */
  const upper = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && turn(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/**
 * Follow spots for the night: one on each performer, the lead brighter.
 * @param {Array<{ x: number, z: number, lead?: boolean }>} performers
 * @param {readonly string[]} colors
 * @returns {Spot[]}
 */
export function followSpots(performers, colors) {
  return performers.map((p, i) => ({
    x: p.x, z: p.z,
    radius: p.lead ? 1.6 : 1.15,
    color: colors[i % Math.max(1, colors.length)] ?? '#fde68a',
    power: p.lead ? 0.85 : 0.55,
  }));
}

/**
 * The hour a theme starts at: the day for paper, late night for the subway.
 * @param {'light' | 'dark'} theme
 */
export function hourForTheme(theme) {
  return theme === 'dark' ? 23 : 10;
}
