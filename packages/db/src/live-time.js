//@ts-check
/**
 * @file Event-time live views (LIVE-FORMAT §13): a `$resample` or
 * `$rolling` document over a collection, maintained against an
 * explicit watermark.
 *
 * There is no clock in this file, and there is none anywhere under it.
 * A live view over time needs to know what "now" is — which bucket is
 * still open, which reading counts as late — and the only honest
 * source of that is the host, because the machine's clock is a
 * different quantity from the instant a reading carries. So the
 * watermark ARRIVES: it is a finite epoch supplied at registration and
 * moved forward by `advance()`, it never goes backwards, and a test can
 * put it wherever the story needs it without waiting for a timer.
 *
 * What the maintenance actually does:
 *
 *  - **A bucket view keeps its rows by bucket.** A write touches one
 *   bucket (two, when it moves a reading across a boundary), and only
 *   those are folded again — through `resampleSeries` itself, over that
 *   bucket's own rows, so the aggregate is the kernel's and cannot
 *   drift from what a fresh query would answer.
 *  - **A rolling view keeps its rows in instant order.** A write at `t`
 *   can only change the windows ending in `[t, t + width)`, so exactly
 *   that stretch is recomputed — again by the kernel, over the slice
 *   that stretch can see.
 *
 * And what it refuses. A calendar ladder walks a wall clock, a named
 * zone needs host code, `locf`/`linear` couple every bucket to its
 * neighbours, and `first`/`last` name a row by a position a maintained
 * map does not preserve. Each of those re-runs with its own reason
 * rather than being approximated. So does a reading older than the
 * declared lateness: the view re-runs, the emission carries a
 * `lateData` record naming the instant and the boundary, and the row is
 * never quietly folded into a bucket its reader already believed
 * closed.
 *
 * `retention` is the horizon this view claims to work over. It is
 * checked, not assumed: it must cover a whole window plus the lateness
 * the caller allows, which is the span a single repair can read. It is
 * NOT a compaction policy — the maintained state is bounded by
 * `live.maxMaintained` exactly as every other strategy's is, and this
 * file drops nothing that an answer still depends on.
 */

import { compileJsonQuery } from '@jarenjs/json/query';
import { isJsonObject } from '@jarenjs/core/object';
import { compileBuckets, resampleSeries, rollingSeries, toEpoch } from '@jarenjs/core/series';

import { DbCompileError } from './errors.js';
import { chain } from './driver.js';
import { singularSelector } from './series.js';

/** The closed `eventTime` member set (§13.1). */
const EVENT_TIME_MEMBERS = Object.freeze(['path', 'watermark', 'allowedLateness', 'retention']);

/** The aggregates a maintained state answers exactly. `first`/`last`
 * are absent for the planner's own reason: they name a row by its
 * position in the series, and a per-key map does not keep one. */
const MAINTAINED_AGGREGATES = Object.freeze(['sum', 'mean', 'min', 'max', 'count']);

/** The fill policies an EMPTY bucket can answer on its own. `locf` and
 * `linear` read their neighbours, so one late reading moves buckets it
 * never belonged to — that is a re-run, not a repair. */
const MAINTAINED_FILLS = Object.freeze(['omit', 'null', 'zero']);

/**
 * Validate the `eventTime` option into the record the classifier and
 * the strategies read, or `null` when the caller declared none.
 * @param {any} options - the live options
 * @param {string} collection - for the error's `collection` property
 * @returns {null | { member: string, watermark: number,
 *   allowedLateness: number, retention: number }}
 * @throws {DbCompileError} `JD0053` for any member this does not admit
 */
export function normalizeEventTime(options, collection) {
  const declared = options?.eventTime;
  if (declared === undefined || declared === null) return null;
  const refuse = (reason) => {
    throw new DbCompileError('JD0053', reason, { collection });
  };
  if (!isJsonObject(declared))
    refuse('live eventTime is an object with a path, a watermark and a retention');
  for (const name of Object.keys(declared)) {
    if (!EVENT_TIME_MEMBERS.includes(name)) {
      refuse(`live eventTime has no member '${name}' — it admits ${
        EVENT_TIME_MEMBERS.map((m) => `'${m}'`).join(', ')}`);
    }
  }
  const member = singularSelector(declared.path);
  if (member === null)
    refuse("live eventTime.path is a singular row selector naming the instant member, like '$.at'");
  const finite = (value, name) => {
    if (typeof value !== 'number' || !Number.isFinite(value))
      refuse(`live eventTime.${name} is a finite epoch in milliseconds, not ${JSON.stringify(value)}`);
    return value;
  };
  const watermark = finite(declared.watermark, 'watermark');
  const retention = finite(declared.retention ?? NaN, 'retention');
  if (retention <= 0)
    refuse(`live eventTime.retention is a positive span, not ${retention}`);
  const allowedLateness = declared.allowedLateness === undefined
    ? 0 : finite(declared.allowedLateness, 'allowedLateness');
  if (allowedLateness < 0)
    refuse(`live eventTime.allowedLateness is not negative, unlike ${allowedLateness}`);
  return { member: /** @type {string} */ (member), watermark, allowedLateness, retention };
}

/**
 * The rows behind a series operand, as one document: the bare
 * collection, or the collection under the operand's own `$where`.
 * Anything else — a projection, a second binding, an ordering — is not
 * a shape whose rows a key can be tracked through.
 * @param {any} operand - the operator's first (or right) argument
 * @returns {{ source: any } | null}
 */
function operandSource(operand) {
  if (operand === '$[*]') return { source: { $for: { it: '$[*]' }, $return: '$it' } };
  if (!isJsonObject(operand) || !isJsonObject(operand.$for)) return null;
  const names = Object.keys(operand.$for);
  if (names.length !== 1 || operand.$for[names[0]] !== '$[*]') return null;
  const binding = names[0];
  const allowed = new Set(['$for', '$where', '$return']);
  if (!Object.keys(operand).every((key) => allowed.has(key))) return null;
  if (operand.$return !== `$${binding}`) return null;
  return {
    source: {
      $for: { [binding]: '$[*]' },
      ...(operand.$where !== undefined ? { $where: operand.$where } : {}),
      $return: `$${binding}`,
    },
  };
}

/**
 * Classify a document as an event-time view, or say why it is not one.
 *
 * Returns `null` when the document does not name `$resample` or
 * `$rolling` over this collection at all — the caller then goes on to
 * §7's ordinary table. Every other outcome is a decision: a maintained
 * description, or `{ strategy: 'rerun', reason }`.
 * @param {any} inner - the unwrapped document
 * @param {boolean} windowed - whether a `$subsequence` wrapped it
 * @param {boolean} keyed
 * @param {null | { member: string, watermark: number,
 *   allowedLateness: number, retention: number }} eventTime
 * @returns {any}
 */
export function classifyEventTime(inner, windowed, keyed, eventTime) {
  if (!isJsonObject(inner)) return null;
  const keys = Object.keys(inner);
  if (keys.length !== 1) return null;
  const name = keys[0];
  if (name !== '$resample' && name !== '$rolling') return null;
  const args = inner[name];
  if (!Array.isArray(args) || args.length !== 2) return null;
  const operand = operandSource(args[0]);
  if (operand === null) return null;

  const rerun = (reason) => ({ strategy: 'rerun', reason });
  const spec = args[1];
  if (!isJsonObject(spec)) return null;
  if (eventTime === null) {
    return rerun(`'${name}' — a temporal view maintains event time, and none was declared `
      + '(live options need an eventTime with a finite watermark)');
  }
  if (windowed) return rerun(`'${name}' — a windowed temporal view re-runs`);
  if (!keyed) return rerun('rows without a document key cannot be tracked');

  // the instant the state places a row by must be the instant the
  // kernel aggregates it by, or the two would disagree row for row
  const at = spec.at === undefined ? 'at' : singularSelector(spec.at);
  if (at === null || at !== eventTime.member) {
    return rerun(`'${name}' — eventTime.path names '${eventTime.member}' and the spec reads `
      + `${at === null ? 'a selector this view cannot follow' : `'${at}'`}`);
  }
  if (spec.zone !== undefined && spec.zone !== 'UTC') {
    return rerun(`'${name}' — a named zone resolves through the injected provider, which `
      + 'maintenance would have to consult per boundary');
  }
  const aggregate = spec.aggregate ?? 'mean';
  if (!MAINTAINED_AGGREGATES.includes(aggregate)) {
    return rerun(`'${name}' — '${aggregate}' names a row by its position in the series, `
      + 'which a per-key state does not preserve');
  }

  // the ladder (or the window) through the kernel's own compiler, so
  // 'PT1H', 3600000 and 'PT60M' are one width and the default anchor is
  // the kernel's rather than a second guess at it
  const span = (() => {
    try {
      return compileBuckets(name === '$resample' ? spec : spec.width, spec);
    }
    catch {
      return null;
    }
  })();
  if (span === null)
    return rerun(`'${name}' — the temporal kernel refuses this specification`);
  if (span.calendar) {
    return rerun(`'${name}' — a calendar ladder walks a wall clock and a month has no width, `
      + 'so its boundaries move with the data rather than with arithmetic');
  }
  const covered = span.width + eventTime.allowedLateness;
  if (eventTime.retention < covered) {
    return rerun(`'${name}' — a retention of ${eventTime.retention} ms does not cover `
      + `${covered} ms of window plus allowed lateness, so a repair could read outside `
      + 'the horizon this view claims');
  }

  if (name === '$rolling') {
    const minPeriods = spec.minPeriods ?? 1;
    if (!Number.isInteger(minPeriods) || minPeriods < 1)
      return rerun("'$rolling' — the temporal kernel refuses this specification");
    return {
      strategy: 'rolling',
      source: operand.source,
      spec,
      member: eventTime.member,
      width: span.width,
      eventTime,
      deps: { whole: true, members: new Set() },
    };
  }

  const fill = spec.fill ?? 'omit';
  if (!MAINTAINED_FILLS.includes(fill)) {
    return rerun(`'$resample' — '${fill}' fills an empty bucket from its neighbours, so one `
      + 'late reading moves buckets it never belonged to');
  }
  const ladder = span;
  const start = boundOf(spec.start);
  const end = boundOf(spec.end);
  if (start === false || end === false || (start !== null && end !== null && !(start < end)))
    return rerun("'$resample' — the temporal kernel refuses this specification");
  return {
    strategy: 'bucket',
    source: operand.source,
    spec,
    member: eventTime.member,
    ladder,
    fill,
    aggregate,
    start,
    end,
    eventTime,
    deps: { whole: true, members: new Set() },
  };
}

/**
 * A window bound as an epoch, `null` when absent, `false` when it names
 * no instant (the kernel's own refusal, asked before a plan exists).
 * @param {any} value
 * @returns {number | null | false}
 */
function boundOf(value) {
  if (value === undefined) return null;
  try {
    return toEpoch(value);
  }
  catch {
    return false;
  }
}

/**
 * The shared half of both event-time strategies: the watermark, the
 * lateness boundary, per-key row bookkeeping and the re-run a too-late
 * reading forces.
 * @param {any} description
 * @param {any} context
 */
function eventTimeBase(description, context) {
  const { member } = description;
  const evaluate = compileJsonQuery([description.source]);
  const stats = { lateData: 0, reruns: 0, recomputes: 0 };
  let watermark = description.eventTime.watermark;

  /** The instant a row is late BEFORE. */
  const boundary = () => watermark - description.eventTime.allowedLateness;

  /** The row this document contributes, or `undefined` for none. */
  const rowOf = (doc) => {
    if (doc === undefined) return undefined;
    const items = /** @type {any[]} */ (evaluate([doc], context.externals));
    return items.length === 0 ? undefined : items[0];
  };

  /** The instant a contributed row carries, through the kernel's own
   * reader so a live view refuses exactly where a query would. */
  const instantOf = (row) => toEpoch(row[member]);

  const advance = (next) => {
    if (typeof next !== 'number' || !Number.isFinite(next))
      throw new TypeError(`a watermark is a finite epoch in milliseconds, not ${next}`);
    if (next < watermark) {
      throw new TypeError(
        `a watermark only advances: ${next} is behind the current ${watermark}`);
    }
    watermark = next;
  };

  return {
    stats,
    rowOf,
    instantOf,
    advance,
    boundary,
    watermarkOf: () => watermark,
    /** The `lateData` record an emission carries when a reading landed
     * behind the boundary. */
    late: (at, key) => ({
      reason: 'late-data',
      at,
      key,
      watermark,
      allowedLateness: description.eventTime.allowedLateness,
      boundary: boundary(),
    }),
  };
}

/**
 * `$resample` over a fixed ladder: one maintained fold per bucket.
 * @param {any} description
 * @param {any} context
 */
export function bucketStrategy(description, context) {
  const { ladder, fill, aggregate, start, end, spec } = description;
  const base = eventTimeBase(description, context);

  /** @type {Map<string, { at: number, bucket: number, row: any }>} */
  const placed = new Map();
  /** @type {Map<number, Map<string, any>>} bucket start → its rows */
  const rows = new Map();
  /** @type {Map<number, { at: number, value: number|null, count: number }>} */
  const folded = new Map();

  /** Is this instant inside the view's own half-open window? */
  const inWindow = (at) => (start === null || at >= start) && (end === null || at < end);

  /** Re-fold one bucket through the kernel — the same call, over the
   * same rows, that a fresh query would make over this stretch. */
  const refold = (bucket) => {
    base.stats.recomputes += 1;
    const held = rows.get(bucket);
    if (held === undefined || held.size === 0) {
      rows.delete(bucket);
      folded.delete(bucket);
      return;
    }
    const out = resampleSeries([...held.values()],
      { ...spec, start: bucket, end: bucket + ladder.width, fill: 'null' });
    folded.set(bucket, out[0]);
  };

  /** Put a document's row where it belongs, reporting the buckets that
   * moved. `null` rows out of the window and rows with no contribution. */
  const place = (key, row, touched) => {
    const previous = placed.get(key);
    if (previous !== undefined) {
      rows.get(previous.bucket)?.delete(key);
      touched.add(previous.bucket);
      placed.delete(key);
    }
    if (row === undefined) return;
    const at = base.instantOf(row);
    if (!inWindow(at)) return;
    const bucket = ladder.startOf(ladder.indexOf(at));
    let held = rows.get(bucket);
    if (held === undefined) {
      held = new Map();
      rows.set(bucket, held);
    }
    held.set(key, row);
    placed.set(key, { at, bucket, row });
    touched.add(bucket);
  };

  /** The result rows: the maintained folds, and — under a fill policy —
   * the empty positions of the ladder between them. */
  const emit = () => {
    const starts = [...folded.keys()].sort((a, b) => a - b);
    if (fill === 'omit') return starts.map((at) => folded.get(at));
    if (starts.length === 0 && (start === null || end === null)) return [];
    const empty = aggregate === 'count' ? 0 : (fill === 'zero' ? 0 : null);
    const from = start === null ? starts[0] : start;
    const last = end === null ? starts[starts.length - 1] : null;
    const out = [];
    let index = ladder.indexOf(from);
    let at = ladder.startOf(index);
    while (end === null ? at <= /** @type {number} */ (last) : at < end) {
      out.push(folded.get(at) ?? { at, value: empty, count: 0 });
      index += 1;
      at = ladder.startOf(index);
    }
    return out;
  };

  return {
    advance: base.advance,
    stats: () => ({ ...base.stats, watermark: base.watermarkOf() }),
    entries: () => placed.size + folded.size,
    init: () => chain(context.execute([description.source], { externals: context.externals }),
      (docs) => {
        const touched = new Set();
        for (const doc of /** @type {any[]} */ (docs))
          place(context.keyOf(doc), base.rowOf(doc), touched);
        for (const bucket of touched) refold(bucket);
        return emit();
      }),
    apply(record) {
      const touched = context.touchedKeys(record, description.deps);
      if (touched === null) return null;
      /** @type {any} */
      let late = null;
      const moved = new Set();
      for (const [key, change] of touched) {
        const doc = change.kind === 'delete' ? undefined
          : change.kind === 'insert' ? change.doc : context.readRow(key);
        const row = base.rowOf(doc);
        const before = placed.get(key);
        const after = row === undefined ? null : base.instantOf(row);
        const boundary = base.boundary();
        const behind = [before?.at, after].find(
          (at) => typeof at === 'number' && inWindow(at) && at < boundary);
        if (behind !== undefined) {
          late = base.late(behind, key);
          break;
        }
        place(key, row, moved);
      }
      if (late !== null) return { rebuild: true, late };
      if (moved.size === 0) return null;
      for (const bucket of moved) refold(bucket);
      return { rows: emit() };
    },
    /** A re-run rebuilds the whole state from the store — the only
     * answer to a reading the maintained state cannot place. */
    rebuild() {
      base.stats.lateData += 1;
      base.stats.reruns += 1;
      placed.clear();
      rows.clear();
      folded.clear();
      return this.init();
    },
  };
}

/**
 * `$rolling` over a fixed width: one output per input instant, with
 * only the stretch a write can reach recomputed.
 * @param {any} description
 * @param {any} context
 */
export function rollingStrategy(description, context) {
  const { spec, width } = description;
  const base = eventTimeBase(description, context);

  /** @type {Map<string, { at: number, row: any }>} */
  const placed = new Map();
  /** Rows in instant order; ties keep insertion order, which the seven
   * maintained aggregates cannot tell apart. @type {any[]} */
  let ordered = [];
  /** One output per row of `ordered`. @type {any[]} */
  let out = [];

  const compareAt = (a, b) => base.instantOf(a) - base.instantOf(b);

  /** The first position whose instant is at or after `at`. */
  const lowerBound = (at) => {
    let lo = 0;
    let hi = ordered.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (base.instantOf(ordered[mid]) < at) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  /** The first position whose instant is after `at`. */
  const upperBound = (at) => {
    let lo = 0;
    let hi = ordered.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (base.instantOf(ordered[mid]) <= at) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  /**
   * Recompute every window ending in `[from, to + width)` — the whole
   * reach of a write at any instant in `[from, to]` — over the slice
   * those windows can see. A window opens EXCLUSIVELY at `at - width`,
   * so the slice starts one position past `from - width` and the
   * kernel's answer for a row inside it is the answer it would give
   * over the entire series.
   */
  const repair = (from, to) => {
    base.stats.recomputes += 1;
    const lo = upperBound(from - width);
    const hi = lowerBound(to + width);
    const answers = rollingSeries(ordered.slice(lo, hi), spec);
    for (let i = lowerBound(from); i < hi; i++) out[i] = answers[i - lo];
  };

  const removeRow = (key) => {
    const previous = placed.get(key);
    if (previous === undefined) return null;
    const at = lowerBound(previous.at);
    for (let i = at; i < ordered.length; i++) {
      if (ordered[i] === previous.row) {
        ordered.splice(i, 1);
        out.splice(i, 1);
        break;
      }
    }
    placed.delete(key);
    return previous.at;
  };

  const insertRow = (key, row) => {
    const at = base.instantOf(row);
    const position = upperBound(at);
    ordered.splice(position, 0, row);
    out.splice(position, 0, null);
    placed.set(key, { at, row });
    return at;
  };

  return {
    advance: base.advance,
    stats: () => ({ ...base.stats, watermark: base.watermarkOf() }),
    entries: () => placed.size,
    init: () => chain(context.execute([description.source], { externals: context.externals }),
      (docs) => {
        ordered = [];
        for (const doc of /** @type {any[]} */ (docs)) {
          const row = base.rowOf(doc);
          if (row === undefined) continue;
          placed.set(context.keyOf(doc), { at: base.instantOf(row), row });
          ordered.push(row);
        }
        ordered.sort(compareAt);
        out = rollingSeries(ordered, spec);
        return out.slice();
      }),
    apply(record) {
      const touched = context.touchedKeys(record, description.deps);
      if (touched === null) return null;
      /** @type {any} */
      let late = null;
      let from = Infinity;
      let to = -Infinity;
      const moves = [];
      for (const [key, change] of touched) {
        const doc = change.kind === 'delete' ? undefined
          : change.kind === 'insert' ? change.doc : context.readRow(key);
        const row = base.rowOf(doc);
        const before = placed.get(key)?.at;
        const after = row === undefined ? undefined : base.instantOf(row);
        const boundary = base.boundary();
        const behind = [before, after].find(
          (at) => typeof at === 'number' && at < boundary);
        if (behind !== undefined) {
          late = base.late(behind, key);
          break;
        }
        moves.push({ key, row, before, after });
      }
      if (late !== null) return { rebuild: true, late };
      for (const move of moves) {
        for (const at of [move.before, move.after]) {
          if (typeof at !== 'number') continue;
          if (at < from) from = at;
          if (at > to) to = at;
        }
        removeRow(move.key);
        if (move.row !== undefined) insertRow(move.key, move.row);
      }
      if (from === Infinity) return null;
      repair(from, to);
      return { rows: out.slice() };
    },
    rebuild() {
      base.stats.lateData += 1;
      base.stats.reruns += 1;
      placed.clear();
      return this.init();
    },
  };
}
