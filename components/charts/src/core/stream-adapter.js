//@ts-check
/**
 * @file The streaming adapter: unified reader events in, chart data
 * out. Source-agnostic by design — it consumes the `pair` event shape
 * that the JOSL reader (`createStreamReader`) and the JSONX/strict-JSON
 * reader (`createJsonxStreamReader`) both emit, so one adapter serves
 * every syntax and this package never depends on a parser (it sees
 * events, never a reader; pair it with `@jarenjs/josl` at the call
 * site).
 *
 * Two record-boundary modes cover the two streaming shapes:
 *
 * - `recordBoundary: 'path'` — one large document arriving in chunks;
 *   a record is the subtree at `recordPath + [index]` (a JOSL `[[run]]`
 *   array-of-tables and a JSON `{"run": […]}` array produce the same
 *   pair paths — that is the point of the unified events), and closes
 *   when the event path leaves it.
 * - `recordBoundary: 'document'` — many small complete documents over
 *   time (e.g. one WebSocket message each); every document IS one
 *   record — the fields directly under `recordPath` (default: the
 *   document root) — closed by an `endDocument()` call after the
 *   reader's `end()`. A message that fails mid-parse is discarded with
 *   `abortDocument()`, leaving the accumulated snapshot untouched.
 *
 * Accumulators: `line` (records → per-series points, ring-buffer
 * eviction), `bar` (live category counts or sums), and `candlestick`
 * (records keyed by open time; a re-delivered key REPLACES its candle,
 * which is exactly how exchange kline updates behave).
 *
 * A record is emitted into the snapshot only when its required fields
 * are present; `getData()` returns a FRESH object shaped for
 * `compileChart(config, adapter.getData())`, so identity-keyed memos
 * re-render per snapshot.
 */

/**
 * @typedef {object} StreamAdapterConfig
 * @property {(string|number)[]} [recordPath] path prefix owning the
 *  records: in path mode, e.g. `['run']` for `{"run": […]}` / `[[run]]`;
 *  in document mode, the object whose direct fields form the record
 *  (e.g. `['data', 'k']` for a combined-stream kline payload)
 * @property {'path'|'document'} [recordBoundary] default 'path'
 * @property {string} [xField] record field for x (line/candlestick) or
 *  the category (bar)
 * @property {string} [yField] record field for y (line) or the summed
 *  value (bar; omitted = count records)
 * @property {string} [seriesField] record field naming the series (line)
 * @property {string} [openField] candlestick fields (defaults
 *  'open'/'high'/'low'/'close')
 * @property {string} [highField]
 * @property {string} [lowField]
 * @property {string} [closeField]
 * @property {number} [maxPoints] ring-buffer size (line: per series;
 *  candlestick: total candles)
 */

/**
 * @typedef {object} StreamAdapter
 * @property {(event: any) => void} onEvent the reader event sink
 * @property {() => void} endDocument close the current record
 *  (document mode: call once per completed document; path mode: call
 *  once at end of stream)
 * @property {() => void} abortDocument discard the record in progress
 *  (a message that failed to parse)
 * @property {() => any} getData a fresh chart-data snapshot
 * @property {() => void} reset drop all accumulated state
 */

/**
 * Create a streaming accumulator for a chart type.
 * @param {'line'|'bar'|'candlestick'} chartType
 * @param {StreamAdapterConfig} [config]
 * @returns {StreamAdapter}
 */
export function createStreamAdapter(chartType, config = {}) {
  if (chartType !== 'line' && chartType !== 'bar' && chartType !== 'candlestick')
    throw new TypeError(`unknown stream chart type '${chartType}'`);
  const recordPath = config.recordPath ?? [];
  const documentMode = config.recordBoundary === 'document';
  const xField = config.xField ?? 'x';
  const yField = config.yField;
  const seriesField = config.seriesField;
  const openField = config.openField ?? 'open';
  const highField = config.highField ?? 'high';
  const lowField = config.lowField ?? 'low';
  const closeField = config.closeField ?? 'close';
  const maxPoints = config.maxPoints ?? 500;

  /** @type {Map<string, {buf: any[], head: number}>} line series */
  let series = new Map();
  /** @type {Map<string, number>} bar counts */
  let counts = new Map();
  /** @type {Map<number|string, any>} candles keyed by open time */
  let candles = new Map();
  /** @type {Record<string, any>|null} the record being assembled */
  let record = null;
  /** @type {string|number|null} current record index (path mode) */
  let index = null;

  function flush() {
    if (record === null) return;
    const done = record;
    record = null;
    index = null;
    const x = done[xField];
    if (x === undefined) return;
    if (chartType === 'bar') {
      const key = String(x);
      const add = yField === undefined ? 1 : Number(done[yField]);
      if (yField !== undefined && !Number.isFinite(add)) return;
      counts.set(key, (counts.get(key) ?? 0) + add);
      return;
    }
    if (chartType === 'candlestick') {
      const open = numish(done[openField]);
      const high = numish(done[highField]);
      const low = numish(done[lowField]);
      const close = numish(done[closeField]);
      if (![open, high, low, close].every(Number.isFinite)) return;
      const key = numish(x);
      candles.set(key, { t: key, open, high, low, close });
      if (candles.size > maxPoints)
        candles.delete(candles.keys().next().value);
      return;
    }
    if (yField === undefined || done[yField] === undefined) return;
    const name = seriesField !== undefined ? String(done[seriesField] ?? '') : 'value';
    let s = series.get(name);
    if (s === undefined) {
      s = { buf: [], head: 0 };
      series.set(name, s);
    }
    s.buf.push({ x: numish(x), y: numish(done[yField]) });
    if (s.buf.length - s.head > maxPoints) s.head++;
    // amortized compaction keeps the buffer bounded without O(n) shifts
    if (s.head > maxPoints) {
      s.buf = s.buf.slice(s.head);
      s.head = 0;
    }
  }

  function onEvent(event) {
    const path = event.path;
    if (path === undefined) return;
    if (documentMode) {
      if (event.type === 'pair' && path.length === recordPath.length + 1
        && startsWith(path, recordPath)) {
        if (record === null) record = {};
        record[event.key] = event.value;
      }
      return;
    }
    // path mode: does this event live inside recordPath + [index]?
    if (path.length > recordPath.length && startsWith(path, recordPath)) {
      const at = path[recordPath.length];
      if (at !== index) {
        flush();
        index = at;
        record = {};
      }
      if (event.type === 'pair' && path.length === recordPath.length + 2) {
        record[event.key] = event.value;
      }
      return;
    }
    flush(); // the path left the record prefix
  }

  function getData() {
    if (chartType === 'bar') {
      const categories = [...counts.keys()];
      return {
        categories,
        series: [{ name: yField ?? 'count', values: categories.map((c) => counts.get(c)) }],
      };
    }
    if (chartType === 'candlestick') {
      return { candles: [...candles.values()] };
    }
    return {
      series: [...series.entries()].map(([name, s]) => ({
        name,
        points: s.buf.slice(s.head),
      })),
    };
  }

  return {
    onEvent,
    endDocument: flush,
    abortDocument() {
      record = null;
      index = null;
    },
    getData,
    reset() {
      series = new Map();
      counts = new Map();
      candles = new Map();
      record = null;
      index = null;
    },
  };
}

function startsWith(path, prefix) {
  for (let i = 0; i < prefix.length; ++i) {
    if (path[i] !== prefix[i]) return false;
  }
  return true;
}

function numish(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  }
  return v;
}
