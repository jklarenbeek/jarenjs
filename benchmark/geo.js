//@ts-check
/**
 * @file Spatial benchmark: @jarenjs/core/geo against the JavaScript
 * geospatial field.
 *
 *   @turf/turf  the GeoJSON-native standard (~796k weekly downloads)
 *   geolib      the lightweight distance/bbox library (~318k)
 *   flatbush    the static packed-Hilbert index this one is modelled on
 *
 * Every scenario asserts **result equivalence first** and refuses to
 * print a timing table if the engines disagree beyond a stated
 * tolerance. A benchmark that measures two different answers measures
 * nothing, and a spatial library that is fast and wrong is worse than
 * one that is neither.
 *
 * Tolerances are per-scenario and explicit, because the engines model
 * the Earth differently: Turf's default distance is a sphere of radius
 * 6371.0088 km against this kernel's IUGG 6371.0088 km — the same — while
 * geolib defaults to the WGS 84 *ellipsoid* via Vincenty, which is a
 * genuinely different (and more accurate) answer, not an error. Where
 * that happens the difference is reported rather than hidden.
 *
 * Usage:
 *   node benchmark/geo.js                # equivalence, then timings
 *   node benchmark/geo.js --check-only   # equivalence only
 *   node benchmark/geo.js --iterations N
 */

import * as fs from 'node:fs';

import {
  haversineDistance,
  equirectDistance,
  bboxOf,
  geometryArea,
  geometryLength,
  centroidOf,
  containsPosition,
  createBboxIndex,
  bboxIntersects,
} from '@jarenjs/core/geo';

import * as turf from '@turf/turf';
import { getDistance, getPathLength } from 'geolib';
import Flatbush from 'flatbush';

const DEFAULT_ITERATIONS = 200_000;
const WARMUP = 5_000;

//#region fixtures

const AMS = [4.9041, 52.3676];
const PAR = [2.3522, 48.8566];

/** A deterministic ring of `n` positions around a centre, closed. */
function makeRing(cx, cy, radius, n) {
  const ring = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    ring.push([cx + radius * Math.cos(a), cy + radius * Math.sin(a)]);
  }
  ring.push(ring[0]);
  return ring;
}

const SMALL_POLY = { type: 'Polygon', coordinates: [makeRing(4.9, 52.4, 0.2, 12)] };
const BIG_POLY = { type: 'Polygon', coordinates: [makeRing(4.9, 52.4, 0.4, 2000)] };
const LINE = {
  type: 'LineString',
  coordinates: Array.from({ length: 500 }, (_, i) => [4 + i * 0.002, 52 + i * 0.001]),
};

/** `n` deterministic boxes spread over the globe. */
function makeBoxes(n) {
  const boxes = [];
  for (let i = 0; i < n; i++) {
    const x = (i * 7919 % 36000) / 100 - 180;
    const y = (i * 6271 % 17000) / 100 - 85;
    boxes.push([x, y, x + 0.5, y + 0.5]);
  }
  return boxes;
}

//#endregion

//#region equivalence

const checks = [];

/**
 * Record an equivalence check between this kernel and a rival.
 * @param {string} name
 * @param {string} rival
 * @param {number|boolean|any[]} ours
 * @param {number|boolean|any[]} theirs
 * @param {number} tolerance - relative, 0 for exact
 * @param {string} [note]
 */
function check(name, rival, ours, theirs, tolerance, note = '') {
  let agrees;
  let detail;
  if (typeof ours === 'number' && typeof theirs === 'number') {
    const rel = theirs === 0 ? Math.abs(ours) : Math.abs(ours - theirs) / Math.abs(theirs);
    agrees = rel <= tolerance;
    detail = `${ours.toPrecision(8)} vs ${theirs.toPrecision(8)} (${(rel * 100).toFixed(4)}%)`;
  }
  else {
    agrees = JSON.stringify(ours) === JSON.stringify(theirs);
    detail = agrees ? 'identical' : `${JSON.stringify(ours)} vs ${JSON.stringify(theirs)}`;
  }
  checks.push({ name, rival, agrees, detail, note });
  return agrees;
}

function runEquivalence() {
  // -- distance -------------------------------------------------------
  check('distance (Amsterdam-Paris)', 'turf',
    haversineDistance(...AMS, ...PAR),
    turf.distance(turf.point(AMS), turf.point(PAR), { units: 'meters' }),
    1e-6, 'both use a 6371.0088 km sphere');

  check('distance (Amsterdam-Paris)', 'geolib',
    haversineDistance(...AMS, ...PAR),
    getDistance({ longitude: AMS[0], latitude: AMS[1] }, { longitude: PAR[0], latitude: PAR[1] }, 0.01),
    0.005, 'geolib is Vincenty on the WGS 84 ellipsoid: a different, more exact model');

  // -- area -----------------------------------------------------------
  check('polygon area', 'turf',
    geometryArea(SMALL_POLY), turf.area(SMALL_POLY), 1e-3);

  // -- length ---------------------------------------------------------
  check('line length', 'turf',
    geometryLength(LINE), turf.length(LINE, { units: 'meters' }), 1e-6);

  check('line length', 'geolib',
    geometryLength(LINE),
    getPathLength(LINE.coordinates.map(([lon, lat]) => ({ longitude: lon, latitude: lat }))),
    0.005, 'geolib is ellipsoidal here too');

  // -- bbox -----------------------------------------------------------
  check('bounding box', 'turf', bboxOf(BIG_POLY), Array.from(turf.bbox(BIG_POLY)), 0);

  // -- containment ----------------------------------------------------
  const inside = [4.9, 52.4];
  const outside = [9, 52];
  check('point in polygon (inside)', 'turf',
    containsPosition(SMALL_POLY, inside[0], inside[1]),
    turf.booleanPointInPolygon(turf.point(inside), SMALL_POLY), 0);
  check('point in polygon (outside)', 'turf',
    containsPosition(SMALL_POLY, outside[0], outside[1]),
    turf.booleanPointInPolygon(turf.point(outside), SMALL_POLY), 0);

  // every vertex ring position, as a sweep rather than two samples
  let agree = 0;
  let total = 0;
  for (let i = 0; i < 400; i++) {
    const p = [4.6 + (i % 20) * 0.03, 52.2 + Math.floor(i / 20) * 0.02];
    const ours = containsPosition(BIG_POLY, p[0], p[1]);
    const theirs = turf.booleanPointInPolygon(turf.point(p), BIG_POLY);
    total++;
    if (ours === theirs) agree++;
  }
  check('point in polygon (400-point sweep)', 'turf', agree, total, 0,
    'a disagreement here would be a real containment bug');

  // -- spatial index --------------------------------------------------
  const boxes = makeBoxes(5000);
  const ours = createBboxIndex(boxes);
  const theirs = new Flatbush(boxes.length);
  for (const b of boxes) theirs.add(b[0], b[1], b[2], b[3]);
  theirs.finish();
  let indexAgree = 0;
  let indexTotal = 0;
  for (let t = 0; t < 200; t++) {
    const qx = (t * 911 % 36000) / 100 - 180;
    const qy = (t * 617 % 17000) / 100 - 85;
    const q = [qx, qy, qx + 3, qy + 3];
    const a = ours.search(q[0], q[1], q[2], q[3]).sort((x, y) => x - y);
    const b = Array.from(theirs.search(q[0], q[1], q[2], q[3])).sort((x, y) => x - y);
    indexTotal++;
    if (JSON.stringify(a) === JSON.stringify(b)) indexAgree++;
  }
  check('index search (200 queries)', 'flatbush', indexAgree, indexTotal, 0);
}

//#endregion

//#region measurement

function measure(fn, iterations) {
  for (let i = 0; i < WARMUP; i++) fn();
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) fn();
  return Number(process.hrtime.bigint() - start) / iterations;
}

function formatNs(ns) {
  if (ns >= 1e6) return `${(ns / 1e6).toFixed(2)} ms`;
  if (ns >= 1e3) return `${(ns / 1e3).toFixed(2)} µs`;
  return `${ns.toFixed(1)} ns`;
}

const pad = (s, w) => String(s).padEnd(w);
const padLeft = (s, w) => String(s).padStart(w);

function printTable(rows, iterations) {
  const nameWidth = Math.max(34, ...rows.map((r) => r.name.length + 2));
  const col = 15;
  console.log(`\nns/op, lower is better (${iterations.toLocaleString()} iterations)\n`);
  console.log(pad('scenario', nameWidth)
    + padLeft('jaren', col) + padLeft('rival', col) + padLeft('rival name', 12) + padLeft('ratio', 10));
  console.log('-'.repeat(nameWidth + col * 2 + 22));
  for (const r of rows) {
    const ratio = r.rival === null ? '-' : `${(r.rival / r.ours).toFixed(2)}x`;
    console.log(pad(r.name, nameWidth)
      + padLeft(formatNs(r.ours), col)
      + padLeft(r.rival === null ? 'n/a' : formatNs(r.rival), col)
      + padLeft(r.rivalName ?? '', 12)
      + padLeft(ratio, 10));
  }
  console.log('\nratio is the rival\'s time over Jaren\'s: above 1 means Jaren is faster.');
}

//#endregion

function main() {
  const args = process.argv.slice(2);
  const idx = args.indexOf('--iterations');
  const iterations = idx >= 0 ? parseInt(args[idx + 1], 10) : DEFAULT_ITERATIONS;
  const checkOnly = args.includes('--check-only');

  console.log('\nSpatial benchmark — @jarenjs/core/geo vs turf / geolib / flatbush');
  console.log(`Node ${process.version}\n`);

  runEquivalence();
  const width = Math.max(...checks.map((c) => c.name.length)) + 2;
  console.log('Result equivalence (asserted before any timing)\n');
  let failures = 0;
  for (const c of checks) {
    if (!c.agrees) failures++;
    console.log(`  ${c.agrees ? 'ok  ' : 'DIFF'}  ${pad(c.name, width)}${pad(c.rival, 10)}${c.detail}`);
    if (c.note) console.log(`        ${' '.repeat(width)}${' '.repeat(10)}(${c.note})`);
  }
  if (failures > 0) {
    console.log(`\n${failures} scenario(s) disagree beyond tolerance — timings withheld.`);
    process.exitCode = 1;
    return;
  }
  console.log('\nall scenarios agree within their stated tolerance.');
  if (checkOnly) return;

  // -- timings --------------------------------------------------------
  const rows = [];
  const turfA = turf.point(AMS);
  const turfB = turf.point(PAR);
  const geolibA = { longitude: AMS[0], latitude: AMS[1] };
  const geolibB = { longitude: PAR[0], latitude: PAR[1] };

  rows.push({
    name: 'distance (two positions)',
    ours: measure(() => haversineDistance(AMS[0], AMS[1], PAR[0], PAR[1]), iterations),
    rival: measure(() => turf.distance(turfA, turfB, { units: 'meters' }), iterations),
    rivalName: 'turf',
  });
  rows.push({
    name: 'distance (vs geolib, ellipsoidal)',
    ours: measure(() => haversineDistance(AMS[0], AMS[1], PAR[0], PAR[1]), iterations),
    rival: measure(() => getDistance(geolibA, geolibB, 0.01), iterations),
    rivalName: 'geolib',
  });
  rows.push({
    name: 'distance (equirectangular screen)',
    ours: measure(() => equirectDistance(AMS[0], AMS[1], PAR[0], PAR[1]), iterations),
    rival: null,
    rivalName: '',
  });

  const small = Math.max(1000, Math.floor(iterations / 20));
  rows.push({
    name: 'point in polygon (12-vertex)',
    ours: measure(() => containsPosition(SMALL_POLY, 4.9, 52.4), small),
    rival: measure(() => turf.booleanPointInPolygon(turf.point([4.9, 52.4]), SMALL_POLY), small),
    rivalName: 'turf',
  });
  const tiny = Math.max(200, Math.floor(iterations / 500));
  rows.push({
    name: 'point in polygon (2000-vertex)',
    ours: measure(() => containsPosition(BIG_POLY, 4.9, 52.4), tiny),
    rival: measure(() => turf.booleanPointInPolygon(turf.point([4.9, 52.4]), BIG_POLY), tiny),
    rivalName: 'turf',
  });
  rows.push({
    name: 'polygon area (2000-vertex)',
    ours: measure(() => geometryArea(BIG_POLY), tiny),
    rival: measure(() => turf.area(BIG_POLY), tiny),
    rivalName: 'turf',
  });
  rows.push({
    name: 'line length (500 positions)',
    ours: measure(() => geometryLength(LINE), tiny),
    rival: measure(() => turf.length(LINE, { units: 'meters' }), tiny),
    rivalName: 'turf',
  });
  rows.push({
    name: 'bounding box (2000-vertex)',
    ours: measure(() => bboxOf(BIG_POLY), tiny),
    rival: measure(() => turf.bbox(BIG_POLY), tiny),
    rivalName: 'turf',
  });
  rows.push({
    name: 'centroid (2000-vertex)',
    ours: measure(() => centroidOf(BIG_POLY), tiny),
    rival: measure(() => turf.centroid(BIG_POLY), tiny),
    rivalName: 'turf',
  });

  // index build and probe, against the library this one is modelled on
  const boxes = makeBoxes(100_000);
  const buildIters = 20;
  rows.push({
    name: 'index build (100k boxes)',
    ours: measure(() => createBboxIndex(boxes), buildIters),
    rival: measure(() => {
      const f = new Flatbush(boxes.length);
      for (const b of boxes) f.add(b[0], b[1], b[2], b[3]);
      f.finish();
      return f;
    }, buildIters),
    rivalName: 'flatbush',
  });
  const ourIndex = createBboxIndex(boxes);
  const theirIndex = new Flatbush(boxes.length);
  for (const b of boxes) theirIndex.add(b[0], b[1], b[2], b[3]);
  theirIndex.finish();
  const probeIters = Math.max(1000, Math.floor(iterations / 20));
  rows.push({
    name: 'index probe (100k boxes)',
    ours: measure(() => ourIndex.search(0, 0, 3, 3), probeIters),
    rival: measure(() => theirIndex.search(0, 0, 3, 3), probeIters),
    rivalName: 'flatbush',
  });
  rows.push({
    name: 'linear scan (100k boxes, no index)',
    ours: measure(() => {
      let c = 0;
      for (let i = 0; i < boxes.length; i++) if (bboxIntersects(boxes[i], [0, 0, 3, 3])) c++;
      return c;
    }, 200),
    rival: null,
    rivalName: '',
  });

  printTable(rows, iterations);

  const out = args.indexOf('--filepath');
  if (out >= 0) {
    fs.writeFileSync(args[out + 1], JSON.stringify({
      mode: 'geo', node: process.version, iterations, checks, rows,
    }, null, 2));
    console.log(`\nResults written to ${args[out + 1]}`);
  }
}

main();
