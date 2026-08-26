//@ts-check
/**
 * The temporal-series corpus: one deterministic generator, and the
 * plain references every executor of that corpus is measured and
 * checked against.
 *
 * Both consumers read this file and nothing else. The fixture writer
 * (`scripts/generate-series-corpus.js`) records what these references
 * answer over a small canonical corpus, so a second executor — a query
 * document, a database plan, a browser tab — can be held to a value
 * rather than to another implementation. The benchmark
 * (`benchmark/series.js`) generates a large corpus from the same
 * function and times these same references as the incumbents a faster
 * path has to beat. A second copy of either half would be a corpus that
 * can disagree with itself while every runner stays green.
 *
 * Nothing here reads a clock, and nothing here allocates a `Date`: a
 * sample's instant is Unix epoch milliseconds, which is what a chart
 * plots, what an indexed column stores and what arithmetic wants.
 *
 * Values are rounded to a binary fraction on purpose, and it buys two
 * things. `Math.sin` is implementation-defined in ECMAScript, so an
 * unrounded corpus would be exact only on the engine that generated it,
 * and the fixture's whole job is to be the same numbers everywhere. And
 * a value that is an exact multiple of 1/4096 keeps every partial sum of
 * a hundred thousand of them an exact integer over 4096, so a running
 * sum that adds and subtracts is bit-for-bit the answer a fresh sum
 * gives. That is what lets a fast kernel be checked against its oracle
 * by equality rather than by a tolerance — and a tolerance is where a
 * real disagreement hides.
 */

/** The instant the corpus starts at — `2026-01-01T00:00:00Z`. */
export const SERIES_ORIGIN = 1767225600000;

/** The spacing between consecutive samples, in milliseconds. */
export const SERIES_STEP_MS = 1000;

/** The seed the probe instants are drawn from. */
export const SERIES_SEED = 20260826;

/**
 * The denominator every generated value is an exact multiple of. A power
 * of two, so sums stay exact; small enough that the values still read as
 * numbers in a diff.
 */
export const VALUE_SCALE = 4096;

/** The fixture's repo-relative home, as messages and artifacts name it. */
export const SERIES_CORPUS_PATH = 'test/json/fixtures/series-corpus.json';

/** The value law, as the corpus documents it to a reader. */
export const VALUE_LAW = `round((sin(i / 31) + (i % 7)) * ${VALUE_SCALE}) / ${VALUE_SCALE}`;

/**
 * A deterministic PRNG (mulberry32) — the generator the other seeded
 * corpora in this repository use.
 * @param {number} seed
 * @returns {() => number} uniform in [0, 1)
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @typedef {Object} Sample
 * @property {number} at - Unix epoch milliseconds
 * @property {number} value
 */

/**
 * `n` samples at a fixed spacing, sorted and gap-free.
 * @param {number} n - how many samples
 * @param {number} [origin] - the first sample's instant
 * @param {number} [step] - the spacing between samples
 * @returns {Sample[]}
 */
export function generateSeries(n, origin = SERIES_ORIGIN, step = SERIES_STEP_MS) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = {
      at: origin + i * step,
      value: Math.round((Math.sin(i / 31) + (i % 7)) * VALUE_SCALE) / VALUE_SCALE,
    };
  }
  return out;
}

/**
 * The same samples as a document collection, with the instant spelled
 * as the RFC 3339 string a JSON document actually carries. This is what
 * the query and the stored-document paths read, and it is generated from
 * the same samples so the two can never describe different data.
 * @param {Sample[]} series
 * @param {string} name - the series key every row carries
 * @returns {{ series: string, on: string, value: number }[]}
 */
export function asDocuments(series, name) {
  return series.map((s) => ({ series: name, on: new Date(s.at).toISOString(), value: s.value }));
}

//#region range

/**
 * Every sample inside the half-open interval `[start, end)`, found by
 * looking at all of them. The incumbent a sorted cut has to beat.
 * @param {Sample[]} series
 * @param {number} start
 * @param {number} end
 * @returns {Sample[]}
 */
export function filterRange(series, start, end) {
  const out = [];
  for (let i = 0; i < series.length; i++) {
    const at = series[i].at;
    if (at >= start && at < end)
      out.push(series[i]);
  }
  return out;
}

/**
 * The index of the first sample at or after `at` in a sorted series.
 * @param {Sample[]} series
 * @param {number} at
 * @returns {number} an index in `[0, series.length]`
 */
export function lowerBound(series, at) {
  let lo = 0;
  let hi = series.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (series[mid].at < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * The half-open index span `[lo, hi)` of `[start, end)` in a sorted
 * series — the same rows `filterRange` returns, without reading the
 * ones outside.
 * @param {Sample[]} series
 * @param {number} start
 * @param {number} end
 * @returns {{ lo: number, hi: number }}
 */
export function cutRange(series, start, end) {
  return { lo: lowerBound(series, start), hi: lowerBound(series, end) };
}

//#endregion

//#region buckets

/**
 * The instant a bucket of width `every` starting from `origin` holds
 * `at` in. Integer arithmetic: a fixed width needs no calendar.
 * @param {number} at
 * @param {number} every
 * @param {number} origin
 * @returns {number}
 */
export function bucketStart(at, every, origin) {
  return origin + Math.floor((at - origin) / every) * every;
}

/**
 * Fixed-width buckets in one pass over a sorted series, labelled at
 * their start. Empty buckets are omitted — a gap is a fill policy, and
 * this reference does not fill.
 * @param {Sample[]} series
 * @param {number} every - bucket width in milliseconds
 * @param {number} [origin] - where the first boundary falls
 * @returns {{ at: number, value: number, count: number }[]}
 */
export function bucketOnePass(series, every, origin = SERIES_ORIGIN) {
  const out = [];
  let key = NaN;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < series.length; i++) {
    const at = bucketStart(series[i].at, every, origin);
    if (at !== key) {
      if (count !== 0)
        out.push({ at: key, value: sum / count, count });
      key = at;
      sum = 0;
      count = 0;
    }
    sum += series[i].value;
    count++;
  }
  if (count !== 0)
    out.push({ at: key, value: sum / count, count });
  return out;
}

/**
 * The same buckets, reached by asking every sample which bucket it is
 * in and keying a map — the obvious implementation, kept as the oracle
 * the one-pass loop is checked against before it is timed.
 * @param {Sample[]} series
 * @param {number} every
 * @param {number} [origin]
 * @returns {{ at: number, value: number, count: number }[]}
 */
export function bucketNaive(series, every, origin = SERIES_ORIGIN) {
  /** @type {Map<number, number[]>} */
  const groups = new Map();
  for (const sample of series) {
    const at = bucketStart(sample.at, every, origin);
    const bucket = groups.get(at);
    if (bucket === undefined) groups.set(at, [sample.value]);
    else bucket.push(sample.value);
  }
  return [...groups.keys()].sort((a, b) => a - b).map((at) => {
    const values = /** @type {number[]} */ (groups.get(at));
    let sum = 0;
    for (const v of values) sum += v;
    return { at, value: sum / values.length, count: values.length };
  });
}

//#endregion

//#region rolling

/**
 * The rolling mean of the last `width` samples, in one pass with a
 * running sum. Only full windows are emitted, so the answer is
 * `n - width + 1` values labelled at the window's last sample — the
 * same rule the count-based `$window` of a sliding query follows.
 *
 * The running sum is carried, never rebuilt: every value is an exact
 * multiple of 1/`VALUE_SCALE`, so adding the arriving sample and
 * subtracting the departing one is exact and the answer equals the one
 * a fresh sum gives.
 *
 * @param {Sample[]} series
 * @param {number} width - window size in samples
 * @returns {{ at: number, value: number }[]}
 */
export function rollingMeanOnePass(series, width) {
  const n = series.length;
  if (width <= 0 || n < width)
    return [];
  const out = new Array(n - width + 1);
  let sum = 0;
  for (let i = 0; i < width; i++) sum += series[i].value;
  out[0] = { at: series[width - 1].at, value: sum / width };
  for (let i = width; i < n; i++) {
    sum += series[i].value - series[i - width].value;
    out[i - width + 1] = { at: series[i].at, value: sum / width };
  }
  return out;
}

/**
 * The same rolling mean, summing each window from scratch — the oracle,
 * quadratic in the window and never timed as an incumbent.
 * @param {Sample[]} series
 * @param {number} width
 * @returns {{ at: number, value: number }[]}
 */
export function rollingMeanNaive(series, width) {
  const out = [];
  for (let i = width - 1; i < series.length; i++) {
    let sum = 0;
    for (let j = i - width + 1; j <= i; j++) sum += series[j].value;
    out.push({ at: series[i].at, value: sum / width });
  }
  return out;
}

//#endregion

//#region as-of

/**
 * The last sample at or before `at`, or null when the series starts
 * after it. Right-biased at an equal instant: the last of the ties is
 * the one an as-of join selects.
 * @param {Sample[]} series
 * @param {number} at
 * @returns {Sample | null}
 */
export function asOfBackward(series, at) {
  const i = lowerBound(series, at + 1) - 1;
  return i < 0 ? null : series[i];
}

//#endregion

//#region probes

/**
 * `count` instants drawn from `[min, max)`, deterministic in the seed.
 * A benchmark that probed one instant would measure that instant's
 * page, so every timed round asks a different one.
 * @param {number} count
 * @param {number} min
 * @param {number} max
 * @param {number} [seed]
 * @returns {number[]}
 */
export function probeInstants(count, min, max, seed = SERIES_SEED) {
  const random = mulberry32(seed);
  const span = max - min;
  const out = new Array(count);
  for (let i = 0; i < count; i++)
    out[i] = min + Math.floor(random() * span);
  return out;
}

//#endregion
