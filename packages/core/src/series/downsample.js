//@ts-check

//#region Downsampling
// A hundred thousand points on a line eight hundred pixels wide is a
// hundred and twenty five points per pixel. Something has to choose, and
// the only question is whether the choosing is visible.
//
// Two strategies, both established, both deterministic:
//
//   **lttb** — largest-triangle-three-buckets. The interior is divided
//   into as many buckets as there is budget, and each contributes the
//   one point making the largest triangle with the point already kept
//   and the next bucket's centre of mass. It keeps the shape a reader
//   recognizes: peaks stay peaks, and a slow drift does not become a
//   staircase.
//
//   **minmax** — each bucket contributes its lowest and highest point,
//   in the order they occurred. It keeps the *envelope* exactly, which
//   is what a reader watching for an excursion is actually looking at,
//   at the cost of the shape between the extremes.
//
// Three rules stop either from lying:
//
//   **A gap is never bridged.** A `null` reading is a measured absence,
//   and a line drawn straight through it claims data that was never
//   collected. So the series is cut at every run of nulls, each run
//   keeps a marker in the output, and every segment is sampled on its
//   own — a peak in a short segment is not competing for budget against
//   a long one's noise.
//
//   **The ends stay.** Every segment's first and last point survive, so
//   the rendered line starts and ends where the data does — and a
//   series that ends in a run of gaps keeps its LAST instant as that
//   run's marker, so the rendered domain still reaches the end of the
//   data rather than stopping at the final reading.
//
//   **An impossible target is refused.** Those markers and endpoints are
//   the minimum a faithful picture needs. Asking for fewer points than
//   that has no honest answer, and returning a prettier lie is worse
//   than a refusal naming the number.
//
// The result reports `sourceCount` and `renderedCount` beside the
// points, so a consumer can always say how much of the data it is
// looking at.

import { canonicalSeries } from './normalize.js';

/** @typedef {import('./normalize.js').Sample} Sample */

/**
 * @typedef {Object} Downsampled
 * @property {(Sample & Record<string, any>)[]} points - the kept
 *   samples, ascending, with every gap still a gap
 * @property {number} sourceCount - how many samples went in
 * @property {number} renderedCount - how many came out; never more than
 *   `target`, and less when a bucket's two extremes were one point
 * @property {string} method - which strategy chose them
 */

const METHODS = Object.freeze(['lttb', 'minmax']);

/**
 * Reduce a series to at most `target` points without bridging a gap or
 * moving an end.
 *
 * @param {any[]} rows - the samples, in any order
 * @param {Object} spec
 * @param {number} spec.target - the most points to return, at least the
 *   mandatory endpoints and gap markers
 * @param {'lttb'|'minmax'} [spec.method] default `'lttb'`
 * @param {string | ((item: any, index: number) => any)} [spec.at]
 * @param {string | ((item: any, index: number) => any)} [spec.value]
 * @returns {Downsampled}
 * @throws {TypeError} for an unknown method, a target that is not a
 *   positive whole number, or a row that is not a canonical sample
 * @throws {RangeError} when `target` cannot hold the segment endpoints
 *   and gap markers the data requires
 * @example
 * const { points, sourceCount, renderedCount } =
 *   downsampleSeries(readings, { target: 800 });
 */
export function downsampleSeries(rows, spec) {
  if (spec === null || typeof spec !== 'object')
    throw new TypeError('a downsample spec is an object with a \'target\'');
  const method = spec.method ?? 'lttb';
  if (typeof method !== 'string' || !METHODS.includes(method)) {
    throw new TypeError(`method is ${METHODS.map((m) => `'${m}'`).join(', ')}, not ${
      JSON.stringify(method)}`);
  }
  const { target } = spec;
  if (!Number.isInteger(target) || target < 1)
    throw new TypeError(`target is a positive whole number of points, not ${target}`);
  const samples = canonicalSeries(rows, spec);
  const sourceCount = samples.length;
  if (sourceCount === 0)
    return { points: [], sourceCount: 0, renderedCount: 0, method };

  const blocks = blocksOf(samples);
  const mandatory = blocks.reduce((n, b) => n + b.mandatory, 0);
  if (target < mandatory) {
    throw new RangeError(`a target of ${target} cannot hold the ${mandatory} points this series`
      + ` requires — ${blocks.filter((b) => !b.gap).length} segment end(s) and`
      + ` ${blocks.filter((b) => b.gap).length} gap marker(s) — and dropping one of them would`
      + ' draw a line through data that is not there');
  }
  if (sourceCount <= target)
    return { points: samples.slice(), sourceCount, renderedCount: sourceCount, method };

  allocate(blocks, target - mandatory);

  /** @type {(Sample & Record<string, any>)[]} */
  const points = [];
  for (const block of blocks) {
    if (block.gap) {
      // the run's first instant, except where the run ends the series:
      // then its last, so the rendered domain still reaches the end of
      // the data rather than stopping at the last reading
      points.push(samples[block.last ? block.to : block.from]);
      continue;
    }
    const length = block.to - block.from + 1;
    const budget = block.mandatory + block.extra;
    if (budget >= length) {
      for (let i = block.from; i <= block.to; i++)
        points.push(samples[i]);
    }
    else if (method === 'lttb')
      lttb(samples, block.from, block.to, budget, points);
    else
      minmax(samples, block.from, block.to, budget, points);
  }
  return { points, sourceCount, renderedCount: points.length, method };
}

/**
 * The series cut into alternating runs of readings and runs of gaps.
 *
 * A reading run must keep both its ends (or its single point); a gap run
 * must keep one marker, which is what leaves a hole in the rendered
 * line. Those are the mandatory points, and their total is the smallest
 * target this series has an honest answer for.
 * @param {Sample[]} samples
 * @returns {{ gap: boolean, from: number, to: number, last: boolean, mandatory: number, extra: number }[]}
 */
function blocksOf(samples) {
  const out = [];
  let from = 0;
  for (let i = 1; i <= samples.length; i++) {
    const same = i < samples.length
      && (samples[i].value === null) === (samples[from].value === null);
    if (same)
      continue;
    const gap = samples[from].value === null;
    out.push({ gap, from, to: i - 1, last: i === samples.length, mandatory: gap ? 1 : Math.min(2, i - from), extra: 0 });
    from = i;
  }
  return out;
}

/**
 * Hand the budget left over after the mandatory points to the segments,
 * in proportion to how much of each is still unrepresented.
 *
 * Largest remainder, ties to the earlier segment, then a redistribution
 * pass for whatever a segment could not use — so the allocation is a
 * function of the data alone and two runs over the same series produce
 * the same picture.
 * @param {{ gap: boolean, from: number, to: number, last: boolean, mandatory: number, extra: number }[]} blocks
 * @param {number} budget
 * @returns {void}
 */
function allocate(blocks, budget) {
  const segments = blocks.filter((b) => !b.gap);
  /** How many points of each segment the mandatory ends do not cover. */
  const room = segments.map((s) => (s.to - s.from + 1) - s.mandatory);
  const total = room.reduce((n, r) => n + r, 0);
  if (total === 0 || budget <= 0)
    return;

  let left = budget;
  const share = new Array(segments.length).fill(0);
  const remainders = [];
  for (let i = 0; i < segments.length; i++) {
    const exact = (budget * room[i]) / total;
    share[i] = Math.min(room[i], Math.floor(exact));
    left -= share[i];
    remainders.push({ i, fraction: exact - Math.floor(exact) });
  }
  remainders.sort((a, b) => (b.fraction - a.fraction) || (a.i - b.i));
  for (const { i } of remainders) {
    if (left <= 0) break;
    if (share[i] < room[i]) {
      share[i]++;
      left--;
    }
  }
  // whatever the caps refused, offered again to whoever still has room
  while (left > 0) {
    let placed = 0;
    for (let i = 0; i < segments.length && left > 0; i++) {
      if (share[i] < room[i]) {
        share[i]++;
        left--;
        placed++;
      }
    }
    if (placed === 0) break;
  }
  for (let i = 0; i < segments.length; i++)
    segments[i].extra = share[i];
}

/**
 * Largest-triangle-three-buckets over one segment, appended in place.
 *
 * The classic formulation: the first point is kept, the interior is cut
 * into `budget - 2` buckets of equal width, and each bucket gives up the
 * point whose triangle with the previously kept point and the next
 * bucket's average has the largest area. Buckets are disjoint and
 * ascending, so the selection is in temporal order by construction.
 * @param {Sample[]} samples
 * @param {number} from
 * @param {number} to
 * @param {number} budget - at least 2, strictly less than the length
 * @param {(Sample & Record<string, any>)[]} out
 * @returns {void}
 */
function lttb(samples, from, to, budget, out) {
  const length = to - from + 1;
  out.push(samples[from]);
  if (budget > 2) {
    const every = (length - 2) / (budget - 2);
    let kept = from;
    for (let i = 0; i < budget - 2; i++) {
      // the next bucket's centre of mass — the triangle's third corner
      const nextStart = from + Math.floor((i + 1) * every) + 1;
      const nextEnd = Math.min(from + Math.floor((i + 2) * every) + 1, to);
      let avgAt = samples[to].at;
      let avgValue = /** @type {number} */ (samples[to].value);
      if (nextEnd > nextStart) {
        avgAt = 0;
        avgValue = 0;
        for (let j = nextStart; j < nextEnd; j++) {
          avgAt += samples[j].at;
          avgValue += /** @type {number} */ (samples[j].value);
        }
        avgAt /= nextEnd - nextStart;
        avgValue /= nextEnd - nextStart;
      }
      const anchorAt = samples[kept].at;
      const anchorValue = /** @type {number} */ (samples[kept].value);
      const start = from + Math.floor(i * every) + 1;
      const end = Math.min(from + Math.floor((i + 1) * every) + 1, to);
      let best = start;
      let bestArea = -1;
      for (let j = start; j < end; j++) {
        const area = Math.abs((anchorAt - avgAt) * (/** @type {number} */(samples[j].value) - anchorValue)
          - (anchorAt - samples[j].at) * (avgValue - anchorValue));
        if (area > bestArea) {
          bestArea = area;
          best = j;
        }
      }
      out.push(samples[best]);
      kept = best;
    }
  }
  out.push(samples[to]);
}

/**
 * Min/max over one segment, appended in place.
 *
 * The ends are kept, the interior is cut into `floor(slots / 2)` buckets,
 * and each gives up its lowest and highest point in the order they
 * occurred. When a bucket's two extremes are the same point it
 * contributes once, which is why `renderedCount` can be under the
 * target: the envelope is exact, and padding it with a point that is
 * neither extreme would not make it more so.
 * @param {Sample[]} samples
 * @param {number} from
 * @param {number} to
 * @param {number} budget - at least 2, strictly less than the length
 * @param {(Sample & Record<string, any>)[]} out
 * @returns {void}
 */
function minmax(samples, from, to, budget, out) {
  out.push(samples[from]);
  let slots = budget - 2;
  if (slots > 0) {
    const first = from + 1;
    const length = to - first;
    const buckets = Math.max(1, Math.floor(slots / 2));
    // the value the odd slot's tie-break measures deviation from
    const middle = (/** @type {number} */(samples[from].value)
      + /** @type {number} */(samples[to].value)) / 2;
    for (let b = 0; b < buckets && slots > 0; b++) {
      const start = first + Math.floor((b * length) / buckets);
      const end = first + Math.floor(((b + 1) * length) / buckets);
      if (end <= start)
        continue;
      let low = start;
      let high = start;
      for (let j = start + 1; j < end; j++) {
        const value = /** @type {number} */ (samples[j].value);
        if (value < /** @type {number} */ (samples[low].value)) low = j;
        if (value > /** @type {number} */ (samples[high].value)) high = j;
      }
      if (low === high) {
        out.push(samples[low]);
        slots--;
        continue;
      }
      if (slots === 1) {
        // room for one of the two: the one further from the segment's
        // own midpoint, which is the one an eye would miss
        const lowGap = Math.abs(/** @type {number} */(samples[low].value) - middle);
        const highGap = Math.abs(/** @type {number} */(samples[high].value) - middle);
        out.push(lowGap >= highGap ? samples[low] : samples[high]);
        slots--;
        continue;
      }
      const earlier = Math.min(low, high);
      const later = Math.max(low, high);
      out.push(samples[earlier]);
      out.push(samples[later]);
      slots -= 2;
    }
  }
  out.push(samples[to]);
}

//#endregion
