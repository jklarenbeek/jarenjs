//@ts-check
/**
 * The Binance live-market boundary: real streaming market data through
 * OUR strict-JSON streaming reader, end to end. Every WebSocket message
 * and the REST seed response are parsed by `createJsonxStreamReader`
 * (`mode: 'json'`) — the built-in JSON parser appears nowhere in this
 * file (a test greps for it) — and accumulate through
 * `createStreamAdapter`'s document-boundary mode into a live price line
 * and a 1m-kline candlestick chart.
 *
 * Verified endpoints (binance-spot-api-docs, checked 2026-07-21):
 *  - WebSocket (market data only): wss://data-stream.binance.vision
 *    combined streams: /stream?streams=<a>/<b> wrapping payloads as
 *    {"stream": name, "data": payload}
 *    sample miniTicker payload: {"e":"24hrMiniTicker","E":1721556000000,
 *      "s":"BTCUSDT","c":"64123.45","o":"63321.00","h":"64800.10",
 *      "l":"62950.00","v":"18234.51","q":"1167034521.11"}
 *    sample kline payload: {"e":"kline","E":1721556001000,"s":"BTCUSDT",
 *      "k":{"t":1721555940000,"T":1721555999999,"o":"64100.0",
 *           "h":"64150.2","l":"64080.1","c":"64123.4","v":"12.5",
 *           "n":480,"x":false, …}}
 *  - REST seed (no API key): https://data-api.binance.vision
 *    GET /api/v3/klines?symbol=BTCUSDT&interval=1m&limit=60
 *    each row: [openTime, "open", "high", "low", "close", "volume",
 *               closeTime, "quoteVolume", trades, …]
 *
 * Ground rules: the connection is opt-in per user gesture (the
 * "Go live" button dispatches `binance/toggle`; nothing connects on
 * page load), one automatic reconnect on a transient close (then stop
 * and say so), rAF-batched re-renders (never per message), ring-buffer
 * bounded memory, and every failure renders a readable status — the
 * page never depends on the feed.
 */

import { createJsonxStreamReader } from '@jarenjs/josl';
import { compileChart } from '@jarenjs/charts';
import { createStreamAdapter } from '@jarenjs/charts/stream-adapter';

import { cards, error, callout, chart, more } from '../lib/nodes.js';

const WS_BASE = 'wss://data-stream.binance.vision';
const REST_BASE = 'https://data-api.binance.vision';
const SYMBOLS = ['BTCUSDT', 'ETHUSDT'];
const KLINE_SYMBOL = 'BTCUSDT';
const STREAMS = [
  ...SYMBOLS.map((s) => `${s.toLowerCase()}@miniTicker`),
  `${KLINE_SYMBOL.toLowerCase()}@kline_1m`,
];

/**
 * The socket-free feed core: message text in, chart data out. Testable
 * offline with vendored payloads.
 */
export function createBinanceFeed() {
  // combined-stream envelopes nest the payload under `data`; kline
  // fields nest one deeper under `data.k`
  const price = createStreamAdapter('line', {
    recordBoundary: 'document',
    recordPath: ['data'],
    xField: 'E',
    yField: 'c',
    seriesField: 's',
    maxPoints: 240,
  });
  const klines = createStreamAdapter('candlestick', {
    recordBoundary: 'document',
    recordPath: ['data', 'k'],
    xField: 't',
    openField: 'o',
    highField: 'h',
    lowField: 'l',
    closeField: 'c',
    maxPoints: 60,
  });
  let messages = 0;
  let drops = 0;

  const sink = (event) => {
    price.onEvent(event);
    klines.onEvent(event);
  };

  return {
    /** One complete WebSocket message (or synthetic seed message). */
    handleMessage(text) {
      messages++;
      try {
        const reader = createJsonxStreamReader({ mode: 'json', onEvent: sink });
        reader.feed(String(text));
        reader.end();
        price.endDocument();
        klines.endDocument();
      }
      catch {
        drops++;
        price.abortDocument();
        klines.abortDocument();
      }
    },

    /**
     * Seed the candlestick from a REST klines response BODY (text!).
     * Each row becomes a synthetic kline message through the exact
     * message path — no special cases.
     * @param {string} bodyText
     */
    seedKlines(bodyText) {
      const reader = createJsonxStreamReader({ mode: 'json' });
      reader.feed(String(bodyText));
      const rows = reader.end();
      if (!Array.isArray(rows)) return;
      for (const row of rows) {
        if (!Array.isArray(row) || row.length < 5) continue;
        this.handleMessage(`{"stream":"seed","data":{"k":{"t":${Number(row[0])},"o":"${row[1]}","h":"${row[2]}","l":"${row[3]}","c":"${row[4]}"}}}`);
      }
    },

    priceData: () => price.getData(),
    klineData: () => klines.getData(),
    stats: () => ({ messages, drops }),
  };
}

/** The render nodes for a feed snapshot + connection status. */
export function binanceNodes(feed, status, note) {
  const { messages, drops } = feed.stats();
  const nodes = [
    cards([
      { title: 'Binance feed', value: status, note: note ?? `${SYMBOLS.join(' + ')} · miniTicker + kline_1m` },
      { title: 'Messages', value: String(messages), note: `${drops} dropped (malformed)` },
    ]),
  ];
  const priceData = feed.priceData();
  if (priceData.series.length > 0) {
    nodes.push(chart(null, compileChart({
      type: 'line',
      title: 'Live price (miniTicker)',
      x: 'time',
      yLabel: 'USDT',
    }, priceData, { theme: 'host' }).toVnode(),
    'Each point is one WebSocket message, parsed by createJsonxStreamReader in strict-JSON mode.'));
  }
  const klineData = feed.klineData();
  if (klineData.candles.length > 0) {
    nodes.push(chart(null, compileChart({
      type: 'candlestick',
      title: `${KLINE_SYMBOL} — 1m candles`,
      yLabel: 'USDT',
    }, klineData, { theme: 'host' }).toVnode(),
    'Seeded from one REST klines call, updated live; the open candle re-renders as it moves.'));
  }
  return nodes;
}

/**
 * The opt-in invitation (nothing has connected yet). The toggle action
 * differs per surface: the playground engine and the /charts page each
 * own a target (see TARGETS below).
 * @param {'playground'|'page'} [target]
 */
export function binanceInvitation(target = 'playground') {
  return [
    callout('Live market data — opt in',
      'This demo connects your browser to Binance (data-stream.binance.vision) and streams real ticker + kline messages through the strict-JSON streaming reader. Connecting sends your IP address to Binance; some regions block these endpoints — if so, the page stays fully usable.'),
    more(TARGETS[target].action, 'Go live — stream from Binance'),
  ];
}

//#region connection controller (browser-native WebSocket + fetch)

/** Where a session's render nodes go: the playground charts engine's
 * results, or the /charts page's live slot. One socket exists at a
 * time regardless of surface. */
const TARGETS = {
  playground: {
    action: 'binance/toggle',
    sink: (dispatch, nodes) => dispatch('eng/result', { engine: 'charts', result: nodes }),
  },
  page: {
    action: 'charts-live/toggle',
    sink: (dispatch, nodes) => dispatch('charts-live/set', nodes),
  },
};

/** @type {{ws: any, feed: any, dispatch: any, target: 'playground'|'page', raf: boolean, closed: boolean, retried: boolean}|null} */
let session = null;

const scheduleFrame = (cb) =>
  (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : setTimeout(cb, 100));

/** Whether the live connection is open (test hook). */
export function binanceLiveActive() {
  return session !== null;
}

function paint(status, note) {
  if (session === null) return;
  TARGETS[session.target].sink(session.dispatch, binanceNodes(session.feed, status, note));
}

function requestPaint() {
  if (session === null || session.raf) return;
  session.raf = true;
  scheduleFrame(() => {
    if (session === null) return;
    session.raf = false;
    paint('live');
  });
}

/**
 * Start/stop from a "Go live" button.
 * @param {(action: string, payload: any) => void} dispatch
 * @param {'playground'|'page'} [target]
 */
export function binanceToggle(dispatch, target = 'playground') {
  if (session !== null) {
    const feed = session.feed;
    const sessionTarget = session.target;
    stopBinance();
    TARGETS[sessionTarget].sink(dispatch, [
      ...binanceNodes(feed, 'closed', 'stopped by you'),
      ...binanceInvitation(sessionTarget),
    ]);
    return;
  }
  startBinance(dispatch, target);
}

/**
 * Engine lifecycle hook: closes a playground-target socket whenever
 * the charts playground is left or the stream select moves off
 * 'live'. Never starts a connection — only the explicit toggle does.
 * @param {any} inputs
 * @param {(action: string, payload: any) => void} dispatch
 * @param {boolean} isActive
 */
export function binanceSync(inputs, dispatch, isActive) {
  if (session !== null && session.target === 'playground'
    && (!isActive || inputs.stream !== 'live')) {
    stopBinance();
  }
}

/**
 * Route hook for the /charts page: closes a page-target socket when
 * the page is left.
 * @param {boolean} isActive
 */
export function binancePageSync(isActive) {
  if (session !== null && session.target === 'page' && !isActive) {
    stopBinance();
  }
}

export function stopBinance() {
  if (session === null) return;
  const s = session;
  session = null; // clear first: the close handler must not re-enter
  s.closed = true;
  try {
    s.ws?.close();
  }
  catch {
    // already closed
  }
}

function startBinance(dispatch, target) {
  const WS = globalThis.WebSocket;
  if (typeof WS !== 'function') {
    TARGETS[target].sink(dispatch,
      [error({ message: 'WebSocket is not available in this environment.' }, 'Cannot connect')]);
    return;
  }
  const feed = createBinanceFeed();
  session = { ws: null, feed, dispatch, target, raf: false, closed: false, retried: false };
  paint('connecting', 'opening the WebSocket…');

  // REST seed so the candlestick starts populated; response BODY text
  // goes through the same strict-JSON reader. Failure is non-fatal.
  if (typeof globalThis.fetch === 'function') {
    globalThis.fetch(`${REST_BASE}/api/v3/klines?symbol=${KLINE_SYMBOL}&interval=1m&limit=60`)
      .then((res) => (res.ok ? res.text() : Promise.reject(new Error(String(res.status)))))
      .then((text) => {
        if (session?.feed === feed) {
          feed.seedKlines(text);
          requestPaint();
        }
      })
      .catch(() => { /* geo-blocked or offline: the live feed still works */ });
  }

  connect(feed);
}

function connect(feed) {
  if (session === null || session.feed !== feed) return;
  const ws = new (globalThis.WebSocket)(`${WS_BASE}/stream?streams=${STREAMS.join('/')}`);
  session.ws = ws;
  ws.onopen = () => {
    if (session?.ws === ws) paint('live', 'connected');
  };
  ws.onmessage = (event) => {
    if (session?.ws !== ws) return;
    feed.handleMessage(event.data);
    requestPaint();
  };
  ws.onerror = () => { /* the close handler reports */ };
  ws.onclose = () => {
    if (session === null || session.ws !== ws || session.closed) return;
    if (!session.retried) {
      session.retried = true;
      paint('reconnecting', 'the connection closed; retrying once…');
      connect(feed);
      return;
    }
    const dispatch = session.dispatch;
    const sessionTarget = session.target;
    stopBinance();
    TARGETS[sessionTarget].sink(dispatch, [
      ...binanceNodes(feed, 'closed', 'connection lost (already retried once)'),
      callout('Feed closed', 'The Binance connection closed twice — it may be geo-blocked or offline from here. The rest of the page is unaffected; press Go live to try again.'),
      more(TARGETS[sessionTarget].action, 'Go live — stream from Binance'),
    ]);
  };
}

//#endregion
