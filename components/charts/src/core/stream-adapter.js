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
 * eviction), `bar` (live category counts or sums), `heatmap` (the same
 * counts or sums under TWO grouping keys — the column is `xField`, the
 * row `seriesField`), `gauge` (the latest reading, nothing kept),
 * `candlestick` (records keyed by open time; a re-delivered key
 * REPLACES its candle, which is exactly how exchange kline updates
 * behave), and `map` (whole GeoJSON Features, projected and simplified
 * on arrival — see below).
 *
 * The `map` accumulator is the odd one out in two ways. Its record is
 * not flat pair fields but a complete Feature, so it consumes the
 * reader's `object-end` events at `recordPath + [index]` (default
 * `['features']`) — pair the reader with `detach: ['features', '*']` so
 * the document root keeps nothing and the accumulator is the only
 * retention. And what it keeps is *reduced*: each feature's geometry is
 * simplified on arrival to the vertices a drawing of the current extent
 * could distinguish, so memory is bounded by the drawn detail, not the
 * source detail. The projection cannot be fitted before the last
 * feature has been seen, so the design is refit-on-growth: the running
 * bbox sets the simplification tolerance, and when it grows enough to
 * double the tolerance, the kept features are re-simplified against the
 * new extent (a coarsening of already-kept vertices — never a re-read
 * of dropped ones, which is why early features can only ever be finer
 * than needed, not wrong).
 *
 * A record is emitted into the snapshot only when its required fields
 * are present; `getData()` returns a FRESH object shaped for
 * `compileChart(config, adapter.getData())`, so identity-keyed memos
 * re-render per snapshot.
 *
 * Change reporting (`{ changes: true }`): every snapshot mutation is
 * also buffered as an RFC 6902 operation against the `getData()`
 * shape, collected with `takeChanges()` — the feed the incremental
 * chart session consumes. The contract is replay equivalence: applying
 * a `takeChanges()` batch to the previous snapshot yields exactly the
 * next one (`reset()` buffers a whole-document replace). The ops are
 * plain data; this module never imports a patch applier.
 */

import { parseRFC3339Parts, epochOfRFC3339Parts } from '@jarenjs/core/dates';
import {
  bboxOf, bboxUnion, projectMercator, simplifyLine, simplifyRing,
} from '@jarenjs/core/geo';
import { MAP_SIMPLIFY } from '../types/map.js';

/**
 * @typedef {object} StreamAdapterConfig
 * @property {(string|number)[]} [recordPath] path prefix owning the
 *  records: in path mode, e.g. `['run']` for `{"run": […]}` / `[[run]]`;
 *  in document mode, the object whose direct fields form the record
 *  (e.g. `['data', 'k']` for a combined-stream kline payload)
 * @property {'path'|'document'} [recordBoundary] default 'path'
 * @property {string} [xField] record field for x (line/candlestick) or
 *  the category (bar) / column (heatmap)
 * @property {string} [yField] record field for y (line), the summed
 *  value (bar/heatmap; omitted = count records), or the reading (gauge)
 * @property {string} [seriesField] record field naming the series
 *  (line) or the row (heatmap)
 * @property {string} [openField] candlestick fields (defaults
 *  'open'/'high'/'low'/'close')
 * @property {string} [highField]
 * @property {string} [lowField]
 * @property {string} [closeField]
 * @property {number} [maxPoints] ring-buffer size (line: per series;
 *  candlestick: total candles)
 * @property {boolean} [changes] buffer RFC 6902 ops per snapshot
 *  mutation for {@link StreamAdapter#takeChanges}
 * @property {string} [labelField] map: the feature property naming a
 *  feature (default 'name')
 * @property {string} [valueField] map: the feature property to shade by
 * @property {number|false} [simplify] map: simplification tolerance as a
 *  fraction of the frame's width (default the map chart's own; `false`
 *  keeps every vertex, which unbounds memory)
 * @property {number} [aspect] map: frame width:height ratio the drawing
 *  will use (default 1.6, the map chart's own)
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
 * @property {() => {op: string, path: string, value?: any}[]} takeChanges
 *  drain the buffered ops since the last call (requires
 *  `{ changes: true }`; throws a TypeError otherwise)
 * @property {() => void} reset drop all accumulated state
 */

/** The chart types with a streaming accumulator. */
const STREAM_TYPES = new Set(['line', 'bar', 'heatmap', 'gauge', 'candlestick', 'map']);

/**
 * Create a streaming accumulator for a chart type.
 * @param {'line'|'bar'|'heatmap'|'gauge'|'candlestick'|'map'} chartType
 * @param {StreamAdapterConfig} [config]
 * @returns {StreamAdapter}
 */
export function createStreamAdapter(chartType, config = {}) {
  if (!STREAM_TYPES.has(chartType))
    throw new TypeError(`unknown stream chart type '${chartType}'`);
  if (chartType === 'map' && config.recordBoundary === 'document')
    throw new TypeError("createStreamAdapter: the map accumulator reads whole features from one stream ('path' mode only)");
  const recordPath = config.recordPath ?? (chartType === 'map' ? ['features'] : []);
  const documentMode = config.recordBoundary === 'document';
  const xField = config.xField ?? 'x';
  const yField = config.yField;
  const seriesField = config.seriesField;
  const openField = config.openField ?? 'open';
  const highField = config.highField ?? 'high';
  const lowField = config.lowField ?? 'low';
  const closeField = config.closeField ?? 'close';
  const maxPoints = config.maxPoints ?? 500;
  const track = config.changes === true;
  const labelField = typeof config.labelField === 'string' && config.labelField !== ''
    ? config.labelField : 'name';
  const valueField = typeof config.valueField === 'string' ? config.valueField : null;
  const simplifyFrac = config.simplify === false ? 0
    : (typeof config.simplify === 'number' && config.simplify >= 0 ? config.simplify : MAP_SIMPLIFY);
  const aspect = typeof config.aspect === 'number' && Number.isFinite(config.aspect) && config.aspect > 0
    ? config.aspect : 1.6;

  /** @type {Map<string, {buf: any[], head: number, index: number}>} line series */
  let series = new Map();
  /** @type {Map<string, number>} bar counts */
  let counts = new Map();
  /** @type {{xLabels: string[], yLabels: string[], rows: (number|null)[][],
   *   xAt: Map<string, number>, yAt: Map<string, number>}} heatmap matrix */
  let matrix = emptyMatrix();
  /** @type {number|null} gauge reading */
  let reading = null;
  /** @type {Map<number|string, any>} candles keyed by open time */
  let candles = new Map();
  /** @type {Record<string, any>|null} the record being assembled */
  let record = null;
  /** @type {string|number|null} current record index (path mode) */
  let index = null;
  /** @type {{op: string, path: string, value?: any}[]} buffered snapshot ops */
  let ops = [];
  /** @type {any[]} map: kept (reduced) Feature objects */
  let mapFeatures = [];
  /** @type {number[]|null} map: running geographic extent */
  let mapBbox = null;
  /** @type {number} map: plane tolerance the kept set was simplified at */
  let mapTolerance = 0;

  /**
   * The Douglas-Peucker tolerance in Mercator-plane units that equals
   * `simplifyFrac` of the frame's width once the running bbox is fitted:
   * frac x max(planeWidth, planeHeight x aspect). Growing the bbox can
   * only raise it, which is what makes simplify-on-arrival safe — an
   * early feature was simplified at least as finely as the final fit
   * would have.
   */
  function mapPlaneTolerance() {
    if (simplifyFrac <= 0 || mapBbox === null)
      return 0;
    const [x0, y1] = projectMercator(mapBbox[0], mapBbox[1]);
    const [x1, y0] = projectMercator(mapBbox[2], mapBbox[3]);
    return simplifyFrac * Math.max(x1 - x0, (y1 - y0) * aspect);
  }

  /** Project a run of positions, carrying lon/lat along as p[2]/p[3]. */
  function projectCarrying(positions) {
    if (!Array.isArray(positions))
      return [];
    const out = [];
    for (const position of positions) {
      if (!Array.isArray(position))
        continue;
      const lon = position[0];
      const lat = position[1];
      if (typeof lon !== 'number' || typeof lat !== 'number'
        || !Number.isFinite(lon) || !Number.isFinite(lat))
        continue;
      const [px, py] = projectMercator(lon, lat);
      out.push([px, py, lon, lat]);
    }
    return out;
  }

  const unproject = (p) => [p[2], p[3]];

  function reduceLine(positions, tolerance) {
    const run = projectCarrying(positions);
    if (run.length < 2)
      return null;
    return (tolerance > 0 ? simplifyLine(run, tolerance) : run).map(unproject);
  }

  function reduceRing(positions, tolerance) {
    const run = projectCarrying(positions);
    if (run.length < 4)
      return null;
    return (tolerance > 0 ? simplifyRing(run, tolerance) : run).map(unproject);
  }

  function reduceParts(list, reduceOne, tolerance) {
    if (!Array.isArray(list))
      return null;
    const out = [];
    for (const part of list) {
      const reduced = reduceOne(part, tolerance);
      if (reduced !== null)
        out.push(reduced);
    }
    return out.length === 0 ? null : out;
  }

  /**
   * A geometry with the vertices a drawing at the current extent could
   * not distinguish removed, as plain lon/lat GeoJSON — a subset of the
   * source vertices, so re-reducing at a coarser tolerance later is
   * exact. Null when nothing drawable remains.
   */
  function reduceGeometry(geometry, tolerance) {
    if (geometry === null || typeof geometry !== 'object')
      return null;
    const { type, coordinates } = geometry;
    if (type === 'Point') {
      const run = projectCarrying([coordinates]);
      return run.length === 0 ? null : { type, coordinates: unproject(run[0]) };
    }
    if (type === 'MultiPoint') {
      const run = projectCarrying(coordinates);
      return run.length === 0 ? null : { type, coordinates: run.map(unproject) };
    }
    if (type === 'LineString') {
      const line = reduceLine(coordinates, tolerance);
      return line === null ? null : { type, coordinates: line };
    }
    if (type === 'MultiLineString') {
      const lines = reduceParts(coordinates, reduceLine, tolerance);
      return lines === null ? null : { type, coordinates: lines };
    }
    if (type === 'Polygon') {
      const rings = reduceParts(coordinates, reduceRing, tolerance);
      return rings === null ? null : { type, coordinates: rings };
    }
    if (type === 'MultiPolygon') {
      const polys = reduceParts(coordinates,
        (rings, t) => reduceParts(rings, reduceRing, t), tolerance);
      return polys === null ? null : { type, coordinates: polys };
    }
    if (type === 'GeometryCollection') {
      const inner = reduceParts(geometry.geometries,
        (g, t) => reduceGeometry(g, t), tolerance);
      return inner === null ? null : { type, geometries: inner };
    }
    return null;
  }

  /** One complete Feature (or bare geometry) off the stream. */
  function acceptMapFeature(item) {
    if (item === null || typeof item !== 'object')
      return;
    const properties = item.type === 'Feature' ? (item.properties ?? {}) : item;
    const geometry = item.type === 'Feature' ? item.geometry : item;
    if (geometry === null || typeof geometry !== 'object')
      return;
    const box = bboxOf(geometry);
    if (box !== null)
      mapBbox = mapBbox === null ? box : bboxUnion(mapBbox, box);
    const tolerance = mapPlaneTolerance();
    const reduced = reduceGeometry(geometry, tolerance);
    if (reduced === null)
      return;
    // only what the drawing reads survives: the label, the shading
    // value, and the reduced geometry — the rest of the feature goes
    // with the feature
    const props = {};
    const named = properties?.[labelField] ?? properties?.label;
    if (named !== null && named !== undefined)
      props[labelField] = String(named);
    if (valueField !== null && typeof properties?.[valueField] === 'number'
      && Number.isFinite(properties[valueField]))
      props[valueField] = properties[valueField];
    mapFeatures.push({ type: 'Feature', properties: props, geometry: reduced });
    if (track)
      ops.push({ op: 'add', path: '/features/-', value: mapFeatures[mapFeatures.length - 1] });
    // refit-on-growth: a bbox that has doubled the tolerance since the
    // kept set was last simplified means earlier features now carry
    // detail the drawing cannot show — coarsen them once, amortized
    if (mapTolerance === 0) {
      mapTolerance = tolerance;
    }
    else if (tolerance > mapTolerance * 2) {
      for (let i = 0; i < mapFeatures.length - 1; i++) {
        const again = reduceGeometry(mapFeatures[i].geometry, tolerance);
        if (again !== null) {
          mapFeatures[i] = { ...mapFeatures[i], geometry: again };
          if (track)
            ops.push({ op: 'replace', path: `/features/${i}`, value: mapFeatures[i] });
        }
      }
      mapTolerance = tolerance;
    }
  }

  /** Position of a candle key in snapshot order (bounded by maxPoints). */
  function candlePosition(key) {
    let at = 0;
    for (const k of candles.keys()) {
      if (k === key) return at;
      at++;
    }
    return -1;
  }

  function flush() {
    if (record === null) return;
    const done = record;
    record = null;
    index = null;
    if (chartType === 'gauge') {
      // A gauge keeps no history: the newest reading IS the state, so
      // there is nothing to key a record by and no x to require.
      if (yField === undefined) return;
      const v = numish(done[yField]);
      if (typeof v !== 'number' || !Number.isFinite(v)) return;
      reading = v;
      if (track) ops.push({ op: 'replace', path: '/value', value: v });
      return;
    }
    const x = done[xField];
    if (x === undefined) return;
    if (chartType === 'heatmap') {
      const column = String(x);
      const row = String(done[seriesField] ?? '');
      const add = yField === undefined ? 1 : Number(done[yField]);
      if (yField !== undefined && !Number.isFinite(add)) return;
      // The matrix stays rectangular: a new column widens every row,
      // a new row arrives at the current width. Unmeasured cells are
      // null, which the heatmap build reads as "no measurement" and
      // leaves the surface showing through.
      if (!matrix.xAt.has(column)) {
        matrix.xAt.set(column, matrix.xLabels.length);
        matrix.xLabels.push(column);
        if (track) {
          ops.push({ op: 'add', path: '/xLabels/-', value: column });
          for (let r = 0; r < matrix.rows.length; r++)
            ops.push({ op: 'add', path: `/values/${r}/-`, value: null });
        }
        for (const cells of matrix.rows) cells.push(null);
      }
      if (!matrix.yAt.has(row)) {
        matrix.yAt.set(row, matrix.rows.length);
        matrix.yLabels.push(row);
        matrix.rows.push(new Array(matrix.xLabels.length).fill(null));
        if (track) {
          ops.push({ op: 'add', path: '/yLabels/-', value: row });
          ops.push({ op: 'add', path: '/values/-', value: matrix.rows[matrix.rows.length - 1].slice() });
        }
      }
      const ri = matrix.yAt.get(row);
      const ci = matrix.xAt.get(column);
      const cells = matrix.rows[ri];
      cells[ci] = (cells[ci] ?? 0) + add;
      if (track) ops.push({ op: 'replace', path: `/values/${ri}/${ci}`, value: cells[ci] });
      return;
    }
    if (chartType === 'bar') {
      const key = String(x);
      const add = yField === undefined ? 1 : Number(done[yField]);
      if (yField !== undefined && !Number.isFinite(add)) return;
      const known = counts.has(key);
      const at = known ? [...counts.keys()].indexOf(key) : counts.size;
      counts.set(key, (counts.get(key) ?? 0) + add);
      if (track) {
        if (known) {
          ops.push({ op: 'replace', path: `/series/0/values/${at}`, value: counts.get(key) });
        }
        else {
          ops.push({ op: 'add', path: '/categories/-', value: key });
          ops.push({ op: 'add', path: '/series/0/values/-', value: counts.get(key) });
        }
      }
      return;
    }
    if (chartType === 'candlestick') {
      const open = numish(done[openField]);
      const high = numish(done[highField]);
      const low = numish(done[lowField]);
      const close = numish(done[closeField]);
      if (![open, high, low, close].every(Number.isFinite)) return;
      const key = numish(x);
      const known = candles.has(key);
      const at = track && known ? candlePosition(key) : -1;
      const candle = { t: key, open, high, low, close };
      candles.set(key, candle);
      if (track) {
        if (known) ops.push({ op: 'replace', path: `/candles/${at}`, value: candle });
        else ops.push({ op: 'add', path: '/candles/-', value: candle });
      }
      if (candles.size > maxPoints) {
        candles.delete(candles.keys().next().value);
        if (track) ops.push({ op: 'remove', path: '/candles/0' });
      }
      return;
    }
    if (yField === undefined || done[yField] === undefined) return;
    const name = seriesField !== undefined ? String(done[seriesField] ?? '') : 'value';
    let s = series.get(name);
    if (s === undefined) {
      s = { buf: [], head: 0, index: series.size };
      series.set(name, s);
      if (track) ops.push({ op: 'add', path: '/series/-', value: { name, points: [] } });
    }
    const point = { x: numish(x), y: numish(done[yField]) };
    s.buf.push(point);
    if (track) ops.push({ op: 'add', path: `/series/${s.index}/points/-`, value: point });
    if (s.buf.length - s.head > maxPoints) {
      s.head++;
      if (track) ops.push({ op: 'remove', path: `/series/${s.index}/points/0` });
    }
    // amortized compaction keeps the buffer bounded without O(n) shifts
    if (s.head > maxPoints) {
      s.buf = s.buf.slice(s.head);
      s.head = 0;
    }
  }

  function onEvent(event) {
    const path = event.path;
    if (path === undefined) return;
    if (chartType === 'map') {
      // the record is a complete Feature, delivered whole by the
      // reader's object-end (pair events carry only its scalar leaves)
      if (event.type === 'object-end' && path.length === recordPath.length + 1
        && startsWith(path, recordPath))
        acceptMapFeature(event.value);
      return;
    }
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
    if (chartType === 'map') {
      return { features: mapFeatures.slice() };
    }
    if (chartType === 'gauge') {
      return { value: reading };
    }
    if (chartType === 'heatmap') {
      return {
        xLabels: matrix.xLabels.slice(),
        yLabels: matrix.yLabels.slice(),
        values: matrix.rows.map((cells) => cells.slice()),
      };
    }
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

  /** The empty snapshot shape for this chart type (the replay base). */
  function emptyData() {
    if (chartType === 'bar')
      return { categories: [], series: [{ name: yField ?? 'count', values: [] }] };
    if (chartType === 'heatmap') return { xLabels: [], yLabels: [], values: [] };
    // null, not 0: no reading yet is not a reading of zero (both draw
    // an empty dial, but only one of them is a claim)
    if (chartType === 'gauge') return { value: null };
    if (chartType === 'candlestick') return { candles: [] };
    if (chartType === 'map') return { features: [] };
    return { series: [] };
  }

  return {
    onEvent,
    endDocument: flush,
    abortDocument() {
      record = null;
      index = null;
    },
    getData,
    takeChanges() {
      if (!track)
        throw new TypeError("createStreamAdapter: takeChanges() requires '{ changes: true }'");
      const out = ops;
      ops = [];
      return out;
    },
    reset() {
      series = new Map();
      counts = new Map();
      matrix = emptyMatrix();
      reading = null;
      candles = new Map();
      record = null;
      index = null;
      mapFeatures = [];
      mapBbox = null;
      mapTolerance = 0;
      // one whole-document replace supersedes any uncollected ops
      if (track) ops = [{ op: 'replace', path: '', value: emptyData() }];
    },
  };
}

/** A heatmap matrix with no rows, columns or cells yet. */
function emptyMatrix() {
  return { xLabels: [], yLabels: [], rows: [], xAt: new Map(), yAt: new Map() };
}

function startsWith(path, prefix) {
  for (let i = 0; i < prefix.length; ++i) {
    if (path[i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * Lift a temporal coordinate to its epoch-millisecond number, passing every
 * other value through untouched so a downstream `Number.isFinite` still
 * decides what is plottable.
 *
 * A `Date` and an **RFC 3339 string** both lift, because both say
 * unambiguously that they are an instant — which is what a time axis asked
 * for, and JSON has no other way to spell one. A *numeric* string still does
 * not: unlike `numish`, this refuses to accept `"5"` where the config asked
 * for a number, because that is a type confusion rather than a date.
 *
 * A date with no time (`2026-07-27`) reads as UTC midnight, and a value
 * carrying an offset is shifted to its instant, so points spelled in
 * different zones land in the right order on one axis.
 *
 * @param {any} v
 * @returns {any}
 */
export function numOf(v) {
  if (v instanceof Date)
    return v.getTime();
  if (typeof v === 'string') {
    const parts = parseRFC3339Parts(v);
    if (parts === null)
      return v;
    const ms = epochOfRFC3339Parts(parts);
    return ms === ms ? ms : v; // a full-time has no instant to plot
  }
  return v;
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
