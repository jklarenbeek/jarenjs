//@ts-check
/**
 * @file The line sampling policy: how many points a time line draws,
 * and which ones.
 *
 * A hundred thousand readings on a line five hundred pixels wide is two
 * hundred readings per column. Something has to choose, and the choice
 * belongs in one place — `downsampleSeries` from `@jarenjs/core/series`,
 * the same kernel a query and a database call — so a chart cannot
 * disagree with the rest of the suite about what a gap is or where a
 * series ends.
 *
 * What lives HERE is only the policy: when the sampler runs, how big
 * its budget is, and which series it may touch at all.
 *
 * - **Above two thousand points, a time line samples by default.**
 *   Below it nothing changes: the AST is the one the previous version
 *   built, point for point.
 * - **`sampling: false` is the opt-out**, and `'lttb'` / `'minmax'` /
 *   `{ method, target }` are the explicit spellings. An explicit
 *   spelling asks for the sampler whatever the count is, and on a
 *   linear x axis as well as a time one.
 * - **The default budget is a function of the declared width**, never
 *   of a measured element: `width × pixelRatio`, clamped. Nothing in
 *   this package reads a layout, so an SSR render and a browser render
 *   of the same definition are the same bytes. A host that wants the
 *   viewport's budget passes it (`sampling: { width, pixelRatio }`);
 *   an explicit `target` fixes it outright.
 *
 * Two guards keep the sampler off a series it would misread. Its input
 * must be ASCENDING in x — the kernel sorts, and a line whose points
 * arrive out of order is drawn in the order it was given, so sampling
 * an unsorted series would redraw it — and every x must be a finite
 * instant, because a point with no place on the axis is a break in the
 * line rather than a sample. A series failing either is mapped whole,
 * exactly as before.
 *
 * This is not retention. `createStreamAdapter`'s `maxPoints` decides
 * what EXISTS; sampling decides what is DRAWN, over whatever exists,
 * and changing one leaves the other alone.
 */

import { downsampleSeries } from '@jarenjs/core/series';
import { clamp01 } from '@jarenjs/core/math';
import { numOf } from './stream-adapter.js';

/** Source points above which an omitted `sampling` starts sampling a
 * time line. Below it the previous AST is reproduced exactly. */
export const SAMPLING_THRESHOLD = 2000;

/** The width a derived budget assumes when the caller declares none —
 * `cartesianFrame`'s own default, so the default budget is about one
 * point per rendered column. */
export const SAMPLING_WIDTH = 560;

/** The budget clamp. Under `MIN` a line has no shape left to read;
 * over `MAX` there are more points than a display can separate, so the
 * sampler would be cost without a picture. */
export const SAMPLING_TARGET_MIN = 64;
export const SAMPLING_TARGET_MAX = 8192;

const METHODS = Object.freeze(['lttb', 'minmax']);

/**
 * @typedef {object} SamplingPolicy
 * @property {'lttb'|'minmax'} method
 * @property {number} target the most points one series may draw
 * @property {boolean} auto true when `sampling` was omitted, so the
 *  policy only applies to a time line above {@link SAMPLING_THRESHOLD}
 */

/**
 * Resolve `config.sampling` into a policy, or `null` for "never
 * sample". Invalid spellings resolve to the default rather than
 * throwing: a chart definition is validated against the schema when it
 * is untrusted, and a build that threw would take a whole dashboard
 * down for a misspelled member.
 * @param {any} sampling the config member
 * @returns {SamplingPolicy|null}
 */
export function normalizeSampling(sampling) {
  if (sampling === false) return null;
  const auto = sampling === undefined || sampling === null;
  const spec = typeof sampling === 'string' ? { method: sampling }
    : (sampling !== null && typeof sampling === 'object' ? sampling : {});
  const method = METHODS.includes(spec.method) ? spec.method : 'lttb';
  return { method, target: targetOf(spec), auto };
}

/**
 * The budget: the declared `target`, else one point per rendered
 * column at the declared width and pixel ratio, clamped.
 * @param {any} spec
 * @returns {number}
 */
function targetOf(spec) {
  const declared = spec.target;
  if (Number.isInteger(declared) && declared >= 2)
    return Math.min(SAMPLING_TARGET_MAX, declared);
  const width = Number.isFinite(spec.width) && spec.width > 0 ? spec.width : SAMPLING_WIDTH;
  const ratio = Number.isFinite(spec.pixelRatio) && spec.pixelRatio > 0 ? spec.pixelRatio : 1;
  return Math.min(SAMPLING_TARGET_MAX,
    Math.max(SAMPLING_TARGET_MIN, Math.round(width * ratio)));
}

/**
 * Could a series of this many source points be reduced under this
 * policy? An OVER-approximation by design: it counts source points
 * where {@link samplingInput} counts the ones a window still draws, so
 * it may say yes where the build then samples nothing.
 *
 * The incremental session asks it, and there the safe direction is
 * this one: a wholesale rebuild is always the right picture, while an
 * appended vertex on a line whose points the sampler chose would be a
 * vertex the wholesale build never selected.
 * @param {SamplingPolicy|null} policy
 * @param {boolean} time
 * @param {number} count
 * @returns {boolean}
 */
export function mightSample(policy, time, count) {
  if (policy === null) return false;
  if (policy.auto && (!time || count <= SAMPLING_THRESHOLD)) return false;
  return count > policy.target;
}

/**
 * The canonical samples one line series offers the sampler, or `null`
 * when it offers none: a point with no finite x, an x that goes
 * backwards, or nothing the policy applies to.
 *
 * The records are `{ at, value }` and nothing else, which is what lets
 * `downsampleSeries` hand this very array back without copying it. A
 * reading with no plottable y — absent, not a number, or non-positive
 * under a log scale — is a `null` value, which is the same measured
 * gap the kernel already refuses to draw through.
 * @param {any[]} points
 * @param {SamplingPolicy} policy
 * @param {boolean} time
 * @param {boolean} log
 * @param {number|null} xDrop window low bound (samples below it are not drawn)
 * @returns {{ at: number, value: number|null }[] | null}
 */
export function samplingInput(points, policy, time, log, xDrop) {
  if (policy.auto && !time) return null;
  // decide before allocating: a window can only REMOVE points, so the
  // source length bounds the sampler's input, and a series too short to
  // reduce must cost a line under two thousand points nothing at all
  if (policy.auto && points.length <= SAMPLING_THRESHOLD) return null;
  if (points.length <= policy.target) return null;
  /** @type {any[]} */
  const out = [];
  let previous = -Infinity;
  for (const p of points) {
    const px = numOf(p?.x);
    if (!Number.isFinite(px) || px < previous) return null;
    previous = px;
    if (xDrop !== null && px < xDrop) continue;
    const py = numOf(p?.y);
    const plottable = Number.isFinite(py) && (!log || py > 0);
    out.push({ at: px, value: plottable ? py : null });
  }
  if (policy.auto && out.length <= SAMPLING_THRESHOLD) return null;
  if (out.length <= policy.target) return null;
  return out;
}

/**
 * Sample one series' points into unit vertices, or `null` when the
 * policy leaves this series alone.
 *
 * The kernel keeps every segment's ends and one marker per run of gaps,
 * so the drawn line still starts and ends where the data does and every
 * hole stays a hole. Every vertex here carries a source point's own
 * instant and reading — the sampler chooses points, it never averages
 * them into new ones.
 * @param {any[]} points
 * @param {SamplingPolicy} policy
 * @param {boolean} time
 * @param {boolean} log
 * @param {number|null} xDrop
 * @param {(v:number)=>number} xScale
 * @param {(v:number)=>number} yScale
 * @returns {{ vertices: ({u:number,v:number}|null)[], sourceCount: number } | null}
 */
export function sampleLineSeries(points, policy, time, log, xDrop, xScale, yScale) {
  const input = samplingInput(points, policy, time, log, xDrop);
  if (input === null) return null;
  let kept;
  try {
    kept = downsampleSeries(input, { target: policy.target, method: policy.method });
  }
  catch {
    // the one refusal a policy can provoke: a target too small to hold
    // this series' segment ends and gap markers. Drawing every point is
    // the honest answer — the kernel would rather refuse than lie, and
    // the chart would rather be slow than wrong.
    return null;
  }
  const vertices = kept.points.map((sample) => {
    if (sample.value === null) return null;
    const v = yScale(sample.value);
    return Number.isFinite(v) ? { u: xScale(sample.at), v: clamp01(v) } : null;
  });
  return { vertices, sourceCount: points.length };
}
