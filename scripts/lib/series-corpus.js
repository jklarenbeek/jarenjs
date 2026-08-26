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

//#region the operator vocabulary
// The plain references the five query operators are held to. Each one
// is the obvious implementation — a map keyed by bucket, a fresh sum
// per window, a linear scan for each match — written here rather than
// in a runner, so the fixture records an answer that no kernel under
// test produced. A reference that called `@jarenjs/core/series` would
// make the oracle a mirror.
//
// Everything is fixed-width integer arithmetic except
// {@link calendarBucketStart}, which walks UTC months through the
// ordinary `Date.UTC` parts every engine agrees on.

/** How often {@link gappedSeries} starts a run of gaps, in samples. */
export const GAP_PERIOD = 17;

/** How many consecutive samples one of those runs covers. */
export const GAP_RUN = 5;

/** How many samples a query case reads, so a fixture stays readable. */
export const QUERY_SIZE = 90;

/** How many months {@link calendarSeries} covers, at three readings each. */
export const CALENDAR_MONTHS = 14;

/**
 * The rows a case names, and the difference between the last two is the
 * whole of what `fill` is for. A **gap** is a `null` at an instant that
 * still exists — a sensor that reported nothing — and every bucket still
 * has rows in it. A **sparse** series is missing the instants entirely,
 * which is the only way a bucket comes out EMPTY and the only shape a
 * fill policy has anything to say about.
 * @param {Sample[]} samples
 * @param {string} source - `'samples'`, `'gapped'` or `'sparse'`
 * @param {number} [size]
 * @returns {any[]}
 */
export function caseRows(samples, source, size = QUERY_SIZE) {
  if (source === 'samples')
    return samples.slice(0, size);
  const gapped = gappedSeries(samples, GAP_PERIOD, GAP_RUN).slice(0, size);
  return source === 'sparse' ? gapped.filter((row) => row.value !== null) : gapped;
}

/**
 * A coarse series that spans real calendar months, so a monthly ladder
 * has something to walk. Three readings per month — the 1st, the 15th
 * and the 28th, which every month has — from the corpus origin's month
 * onward, with values that stay exact multiples of 1/`VALUE_SCALE`.
 *
 * Built from `Date.UTC` parts rather than by multiplying a millisecond
 * count, because a month is not a fixed width and a corpus that pretended
 * otherwise would agree with a wrong ladder.
 *
 * @param {number} [months] - how many months to cover
 * @param {number} [origin] - an instant in the first month
 * @returns {Sample[]}
 */
export function calendarSeries(months = CALENDAR_MONTHS, origin = SERIES_ORIGIN) {
  const from = new Date(origin);
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();
  const out = [];
  for (let m = 0; m < months; m++) {
    for (const day of [1, 15, 28]) {
      out.push({
        at: Date.UTC(year, month + m, day, 12),
        value: Math.round((out.length + 1) * (VALUE_SCALE / 8)) / VALUE_SCALE,
      });
    }
  }
  return out;
}

/**
 * The start of the calendar bucket `at` falls in, `months` wide, on UTC.
 * A month is not a fixed number of milliseconds, so this counts months
 * from the epoch and rebuilds the instant — the obvious answer, and the
 * one a ladder has to agree with.
 * @param {number} at
 * @param {number} months - the bucket width in whole months
 * @param {number} [originMonths] - months from 1970-01 the ladder is anchored at
 * @returns {number}
 */
export function calendarBucketStart(at, months, originMonths = 0) {
  const d = new Date(at);
  const index = (d.getUTCFullYear() - 1970) * 12 + d.getUTCMonth();
  const floored = originMonths + Math.floor((index - originMonths) / months) * months;
  return Date.UTC(1970 + Math.floor(floored / 12), floored % 12, 1);
}

/**
 * One bucket's rows reduced, by the D5 rule the whole family shares: the
 * six value aggregates skip a `null` reading, so `value` is `null`
 * exactly when nothing in the window carried a number, and `count` is
 * every source row — duplicates and gaps included.
 * @param {any[]} rows
 * @param {string} aggregate
 * @returns {{ value: number | null, count: number }}
 */
export function reduceRows(rows, aggregate) {
  const count = rows.length;
  const values = rows.map((r) => r.value).filter((v) => v !== null);
  if (aggregate === 'count')
    return { value: count, count };
  if (values.length === 0)
    return { value: null, count };
  let value;
  switch (aggregate) {
    case 'sum': value = values.reduce((a, b) => a + b, 0); break;
    case 'min': value = Math.min(...values); break;
    case 'max': value = Math.max(...values); break;
    case 'first': value = values[0]; break;
    case 'last': value = values[values.length - 1]; break;
    default: value = values.reduce((a, b) => a + b, 0) / values.length; break;
  }
  return { value, count };
}

/**
 * Fixed-width resampling with every fill policy, the obvious way: put
 * each row in the bucket its instant names, then walk the ladder from
 * the first boundary to the last and say what each bucket holds.
 *
 * Fill decides what an EMPTY bucket says and nothing else. A bucket that
 * held rows and no numbers is a measurement, not an absence, so it is
 * never an anchor for `locf` or `linear`; and neither policy
 * extrapolates past the outermost measured bucket.
 *
 * @param {any[]} rows
 * @param {Object} spec
 * @param {number} spec.every - the bucket width in milliseconds
 * @param {number} [spec.origin] - where a boundary falls
 * @param {number} [spec.start] - the half-open window's start
 * @param {number} [spec.end] - the half-open window's end
 * @param {string} [spec.aggregate] default `'mean'`
 * @param {string} [spec.fill] default `'omit'`
 * @returns {{ at: number, value: number | null, count: number }[]}
 */
export function resampleNaive(rows, spec) {
  const every = spec.every;
  const origin = spec.origin ?? 0;
  const aggregate = spec.aggregate ?? 'mean';
  const fill = spec.fill ?? 'omit';
  const months = calendarMonths(every);
  const inside = rows.filter((r) => (spec.start === undefined || r.at >= spec.start)
    && (spec.end === undefined || r.at < spec.end));
  if (inside.length === 0 && (spec.start === undefined || spec.end === undefined))
    return [];
  const from = spec.start ?? inside[0].at;
  const limit = spec.end ?? inside[inside.length - 1].at + 1;
  const out = [];
  let at = months === null ? bucketStart(from, every, origin) : calendarBucketStart(from, months);
  while (at < limit) {
    const next = months === null ? at + every : addMonthsUTC(at, months);
    const held = inside.filter((r) => r.at >= at && r.at < next);
    if (held.length !== 0)
      out.push({ at, ...reduceRows(held, aggregate) });
    else if (fill !== 'omit')
      out.push({ at, value: aggregate === 'count' ? 0 : (fill === 'zero' ? 0 : null), count: 0 });
    at = next;
  }
  if (fill === 'locf' || fill === 'linear')
    fillEmpties(out, fill);
  return out;
}

/**
 * How many whole months a calendar `every` names, or `null` when it is a
 * fixed width. Only the two calendar spellings the fixture uses are
 * recognized; anything else that is not a number is refused rather than
 * quietly answered with no buckets at all.
 * @param {number | string} every
 * @returns {number | null}
 */
function calendarMonths(every) {
  if (typeof every === 'number')
    return null;
  const match = /^P(\d+)([MY])$/.exec(every);
  if (match === null)
    throw new TypeError(`the reference does not walk a '${every}' ladder`);
  return Number(match[1]) * (match[2] === 'Y' ? 12 : 1);
}

/**
 * `months` after `at`, on the UTC calendar. Not a multiplication: a
 * month is not a fixed number of milliseconds, which is the whole reason
 * the calendar ladder exists.
 * @param {number} at
 * @param {number} months
 * @returns {number}
 */
function addMonthsUTC(at, months) {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate(),
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

/**
 * The two carrying policies, applied to the buckets that had no rows.
 * @param {{ at: number, value: number | null, count: number }[]} out
 * @param {string} fill
 * @returns {void}
 */
function fillEmpties(out, fill) {
  const measured = out.map((b, i) => (b.count !== 0 && b.value !== null ? i : -1))
    .filter((i) => i >= 0);
  if (measured.length === 0)
    return;
  for (let i = 0; i < out.length; i++) {
    if (out[i].count !== 0)
      continue;
    const before = measured.filter((m) => m < i).pop();
    const after = measured.find((m) => m > i);
    if (fill === 'locf') {
      if (before !== undefined)
        out[i].value = out[before].value;
      continue;
    }
    if (before === undefined || after === undefined)
      continue;
    const span = out[after].at - out[before].at;
    const lo = /** @type {number} */ (out[before].value);
    const hi = /** @type {number} */ (out[after].value);
    out[i].value = lo + (hi - lo) * ((out[i].at - out[before].at) / span);
  }
}

/**
 * Aggregates over a window measured in TIME, the obvious way: for every
 * instant the series has, take every row inside `(at - width, at]` and
 * reduce it from scratch.
 *
 * Rows sharing an instant share a window and share an answer — the
 * window is a function of the instant it ends at, never of arrival
 * order — which is why this walks distinct instants rather than rows.
 *
 * @param {any[]} rows
 * @param {Object} spec
 * @param {number} spec.width - the window's width in milliseconds
 * @param {string} [spec.aggregate] default `'mean'`
 * @param {number} [spec.minPeriods] default 1
 * @returns {{ at: number, value: number | null, count: number }[]}
 */
export function rollingNaive(rows, spec) {
  const width = spec.width;
  const aggregate = spec.aggregate ?? 'mean';
  const minPeriods = spec.minPeriods ?? 1;
  const sorted = [...rows].sort((a, b) => a.at - b.at);
  return sorted.map((row) => {
    const held = sorted.filter((r) => r.at > row.at - width && r.at <= row.at);
    const reduced = reduceRows(held, aggregate);
    return { at: row.at, value: held.length < minPeriods ? null : reduced.value, count: reduced.count };
  });
}

/**
 * The as-of join, the obvious way: for every left row, look at every
 * right row and keep the best one the direction admits.
 *
 * At an equal instant the LAST right row wins in every direction — "as
 * of" means the later reading — and `nearest` breaks a tie backward. A
 * left row with nothing to match keeps `right: null` and stays in the
 * answer, because no match is data.
 *
 * Both sides are canonicalized the way the kernel canonicalizes them —
 * a shallow copy with `at` and `value` written over — so a document that
 * spells its instant `on` keeps `on` too and the answer is comparable
 * whichever spelling it arrived in.
 *
 * @param {any[]} left
 * @param {any[]} right
 * @param {Object} [spec]
 * @param {string} [spec.direction] default `'backward'`
 * @param {number} [spec.tolerance] default unbounded
 * @param {string} [spec.by] - the member both sides join within
 * @param {string} [spec.leftAt] - where the left side keeps its instant
 * @param {string} [spec.rightAt] - and the right side
 * @returns {{ left: any, right: any, distance: number | null }[]}
 */
export function asOfNaive(left, right, spec = {}) {
  const direction = spec.direction ?? 'backward';
  const tolerance = spec.tolerance ?? Infinity;
  const by = spec.by ?? null;
  const canonical = (rows, key) =>
    rows.map((row) => ({ ...row, at: row[key ?? 'at'], value: row.value }));
  const rights = canonical(right, spec.rightAt);
  return canonical(left, spec.leftAt).sort((a, b) => a.at - b.at).map((row) => {
    let best = null;
    for (const candidate of rights) {
      if (by !== null && candidate[by] !== row[by])
        continue;
      const delta = row.at - candidate.at;
      if (direction === 'backward' && delta < 0) continue;
      if (direction === 'forward' && delta > 0) continue;
      const distance = Math.abs(delta);
      if (distance > tolerance)
        continue;
      // `<=` rather than `<`: an equal instant, and an equal distance
      // under `nearest`, both take the later right row
      // two rules, and they are not the same rule. At an EQUAL DISTANCE
      // `nearest` chooses backward, so the earlier candidate wins; at an
      // EQUAL INSTANT the later right row wins, because "as of" means
      // the later reading. `<=` is both at once.
      if (best === null || distance < best.distance
        || (distance === best.distance && candidate.at <= best.right.at))
        best = { right: candidate, distance };
    }
    return best === null
      ? { left: row, right: null, distance: null }
      : { left: row, right: best.right, distance: best.distance };
  });
}

/**
 * Do two half-open `[start, end)` intervals share an instant? Touching
 * spans do not: an interval holds its start and not its end.
 * @param {{ start: number, end: number }} a
 * @param {{ start: number, end: number }} b
 * @returns {boolean}
 */
export function overlapsNaive(a, b) {
  return a.start < b.end && b.start < a.end;
}

/** One hour in milliseconds — the only ISO width the fixture spells. */
const PT1H = 3600000;

/**
 * The instant labelling the bucket `at` falls in, by the obvious rule.
 * The ladder's own default origin is local `1970-01-01T00:00:00` on the
 * clock, which is `-offset` in epoch milliseconds.
 * @param {number} at
 * @param {number | string} every
 * @param {number | null} [origin]
 * @param {any} [context]
 * @returns {number}
 */
export function timeBucketNaive(at, every, origin = null, context = null) {
  const offset = (context?.offset ?? 0) * 60000;
  const width = typeof every === 'number' ? every : PT1H;
  const anchor = origin ?? -offset;
  return anchor + Math.floor((at - anchor) / width) * width;
}

/**
 * The reference's spelling of a spec the document wrote in paths. A
 * selector is a singular path rooted at the ROW in the query language;
 * the plain references read a member name, and this is the one place
 * the two spellings meet.
 * @param {any} spec
 * @returns {any}
 */
export function referenceSpec(spec) {
  const out = { ...spec };
  for (const member of ['by', 'leftAt', 'rightAt']) {
    if (typeof out[member] === 'string')
      out[member] = out[member].replace(/^\$\['?|'?\]$|^\$\./g, '');
  }
  return out;
}

/**
 * The rows one case reads. `source` names where they come from, and
 * every executor of the fixture resolves it here rather than each
 * carrying its own reading of the word.
 * @param {any} entry - a fixture case
 * @param {Sample[]} samples - the corpus the fixture carries
 * @returns {any[]}
 */
export function caseSeries(entry, samples) {
  if (entry.source === 'inline')
    return entry.rows;
  if (entry.source === 'calendar')
    return calendarSeries(entry.size / 3);
  return caseRows(samples, entry.source, entry.size);
}

/**
 * What the plain references answer for one case — the single dispatcher
 * the fixture WRITER, the benchmark and the query suite all read.
 *
 * This is the file's whole contract in one function. The generator calls
 * it to record an answer, and every executor calls it to check that the
 * committed answer is still the one the references give; a second
 * reading of `kind` or `source` anywhere else would be a corpus that can
 * disagree with itself.
 *
 * @param {any} entry - a fixture case
 * @param {Sample[]} samples
 * @returns {any} the answer, or `undefined` for a case with no plain
 *   reference (a refusal, which only a compiler can produce)
 */
export function referenceAnswer(entry, samples) {
  switch (entry.kind) {
    case 'range': {
      const rows = filterRange(samples, entry.start, entry.end);
      const cut = cutRange(samples, entry.start, entry.end);
      return {
        lo: cut.lo,
        hi: cut.hi,
        count: rows.length,
        firstAt: rows.length === 0 ? null : rows[0].at,
        lastAt: rows.length === 0 ? null : rows[rows.length - 1].at,
      };
    }
    case 'bucket':
      return bucketOnePass(samples, entry.every, entry.origin);
    case 'asof':
      return asOfBackward(samples, entry.at);
    case 'overlaps':
      return overlapsNaive(entry.a, entry.b);
    case 'time-bucket':
      return timeBucketNaive(entry.at, entry.every, entry.origin, entry.context);
    case 'resample':
      return resampleNaive(caseSeries(entry, samples), entry.spec);
    case 'rolling':
      // version 1's rolling case counts ROWS and carries no spec; version
      // 2's is measured in time. The spec is what tells them apart.
      return entry.spec === undefined
        ? rollingMeanOnePass(samples, entry.width)
        : rollingNaive(caseSeries(entry, samples), entry.spec);
    case 'asof-join':
      return asOfNaive(entry.input.left, entry.input.right, referenceSpec(entry.spec));
    default: // 'invalid': a refusal is a compiler's answer, not a reference's
      return undefined;
  }
}

//#endregion

//#region gaps

/**
 * The same corpus with runs of readings replaced by measured gaps —
 * `null` values at instants that still exist, which is what a sensor
 * that stopped reporting for five minutes actually leaves behind.
 *
 * The runs are deterministic in the corpus rather than random: every
 * `period` samples, `run` of them are gaps. A fill policy, a rolling
 * window and a downsampler all have to be measured against a series
 * that has holes in it, because the dense corpus never exercises the
 * branch that decides what a hole means.
 *
 * @param {Sample[]} series
 * @param {number} period - how often a run of gaps begins
 * @param {number} run - how many consecutive samples the run covers
 * @returns {Sample[]} a new array of new records
 */
export function gappedSeries(series, period, run) {
  return series.map((sample, i) => (
    (i % period) < run ? { at: sample.at, value: null } : { at: sample.at, value: sample.value }));
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
