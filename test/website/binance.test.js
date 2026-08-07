//@ts-check
/**
 * The Binance boundary, offline: vendored real-shaped payloads are the
 * contract (no live network in CI); the socket lifecycle runs against a
 * stub WebSocket. Live behavior (charts moving, socket closing on
 * navigation) is checked by hand in a browser session.
 */
import { describe, it, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { compileChart } from '@jarenjs/charts';
import { renderToString } from '@jarenjs/view';

import {
  createBinanceFeed, binanceNodes, binanceInvitation,
  binanceToggle, binancePageSync, binanceLiveActive, stopBinance,
} from '../../packages/website/src/boundaries/binance.js';

// Vendored payloads in the documented combined-stream shape
// (binance-spot-api-docs web-socket-streams.md, checked 2026-07-21).
const MINITICKER = (symbol, time, close) => JSON.stringify({
  stream: `${symbol.toLowerCase()}@miniTicker`,
  data: {
    e: '24hrMiniTicker', E: time, s: symbol,
    c: String(close), o: '63321.00000000',
    h: '64800.10000000', l: '62950.00000000',
    v: '18234.51230000', q: '1167034521.11220000',
  },
});

const KLINE = (time, t, o, h, l, c, closed) => JSON.stringify({
  stream: 'btcusdt@kline_1m',
  data: {
    e: 'kline', E: time, s: 'BTCUSDT',
    k: {
      t, T: t + 59_999, s: 'BTCUSDT', i: '1m', f: 1, L: 2,
      o: String(o), c: String(c), h: String(h), l: String(l),
      v: '12.5', n: 480, x: closed, q: '801234.5', V: '6.2', Q: '400617.2', B: '0',
    },
  },
});

// REST /api/v3/klines rows: [openTime, open, high, low, close, volume, …]
const REST_KLINES = JSON.stringify([
  [1721555880000, '64000.0', '64100.0', '63950.0', '64050.0', '10.1', 1721555939999, '1', 100, '1', '1', '0'],
  [1721555940000, '64050.0', '64150.2', '64020.1', '64123.4', '12.5', 1721555999999, '1', 120, '1', '1', '0'],
]);

describe('binance feed (offline, vendored payloads)', function () {
  it('miniTicker messages accumulate per-symbol price series', function () {
    const feed = createBinanceFeed();
    feed.handleMessage(MINITICKER('BTCUSDT', 1000, 64123.45));
    feed.handleMessage(MINITICKER('ETHUSDT', 1000, 3300.5));
    feed.handleMessage(MINITICKER('BTCUSDT', 2000, 64130.0));
    assert.deepStrictEqual(feed.priceData(), {
      series: [
        { name: 'BTCUSDT', points: [{ x: 1000, y: 64123.45 }, { x: 2000, y: 64130 }] },
        { name: 'ETHUSDT', points: [{ x: 1000, y: 3300.5 }] },
      ],
    });
    assert.deepStrictEqual(feed.stats(), { messages: 3, drops: 0 });
  });

  it('kline updates REPLACE the open candle, closed candles persist', function () {
    const feed = createBinanceFeed();
    feed.handleMessage(KLINE(1, 1721555940000, 64050, 64150.2, 64020.1, 64100.0, false));
    feed.handleMessage(KLINE(2, 1721555940000, 64050, 64160.0, 64020.1, 64123.4, true));
    feed.handleMessage(KLINE(3, 1721556000000, 64123.4, 64140.0, 64100.0, 64110.0, false));
    const { candles } = feed.klineData();
    assert.strictEqual(candles.length, 2);
    assert.deepStrictEqual(candles[0], {
      t: 1721555940000, open: 64050, high: 64160, low: 64020.1, close: 64123.4,
    });
  });

  it('the REST seed rows travel the same message path', function () {
    const feed = createBinanceFeed();
    feed.seedKlines(REST_KLINES);
    const { candles } = feed.klineData();
    assert.strictEqual(candles.length, 2);
    assert.deepStrictEqual(candles[1], {
      t: 1721555940000, open: 64050, high: 64150.2, low: 64020.1, close: 64123.4,
    });
  });

  it('a malformed message increments drops and never throws', function () {
    const feed = createBinanceFeed();
    feed.handleMessage(MINITICKER('BTCUSDT', 1000, 100));
    feed.handleMessage('{"stream": "x", "data": {"E": 2000, "s": "BTCUSDT", "c": ');
    feed.handleMessage('not json at all');
    feed.handleMessage(MINITICKER('BTCUSDT', 3000, 101));
    assert.deepStrictEqual(feed.stats(), { messages: 4, drops: 2 });
    const points = feed.priceData().series[0].points;
    assert.deepStrictEqual(points.map((p) => p.x), [1000, 3000]);
  });

  it('eviction bounds memory under sustained feed', function () {
    const feed = createBinanceFeed();
    for (let i = 0; i < 400; i++) {
      feed.handleMessage(MINITICKER('BTCUSDT', i, 100 + i));
    }
    const points = feed.priceData().series[0].points;
    assert.strictEqual(points.length, 240);
    assert.strictEqual(points[0].x, 160);
    assert.strictEqual(points[239].x, 399);
  });

  it('renders status cards plus live charts once data exists', function () {
    const feed = createBinanceFeed();
    const empty = binanceNodes(feed, 'connecting');
    assert.ok(empty.some((n) => n.kind === 'cards'));
    assert.ok(!empty.some((n) => n.kind === 'chart'), 'no charts before data');
    feed.handleMessage(MINITICKER('BTCUSDT', 1000, 64000));
    feed.seedKlines(REST_KLINES);
    const nodes = binanceNodes(feed, 'live');
    const charts = nodes.filter((n) => n.kind === 'chart');
    assert.strictEqual(charts.length, 2, 'price line + candlestick');
    assert.ok(charts.every((n) => n.vnode[0] === 'svg'));
  });

  it('the invitation never connects by itself', function () {
    const nodes = binanceInvitation();
    assert.match(JSON.stringify(nodes), /sends your IP address to Binance/);
    assert.ok(nodes.some((n) => n.kind === 'more' && n.action === 'charts-live/toggle'));
    assert.strictEqual(binanceLiveActive(), false);
  });

  it('JSON.parse is absent from the message path (dogfooding contract)', function () {
    const source = readFileSync(
      new URL('../../packages/website/src/boundaries/binance.js', import.meta.url), 'utf8');
    assert.ok(!source.includes('JSON.parse'), 'binance.js must not use JSON.parse');
    assert.match(source, /createJsonxStreamReader/);
  });
});

describe('binance connection lifecycle (stub socket)', function () {
  /** @type {any[]} */
  let sockets;
  class StubWebSocket {
    constructor(url) {
      this.url = url;
      this.closed = false;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      sockets.push(this);
    }

    close() {
      this.closed = true;
    }
  }
  const install = () => {
    sockets = [];
    globalThis.WebSocket = /** @type {any} */ (StubWebSocket);
  };

  afterEach(function () {
    stopBinance();
    delete globalThis.WebSocket;
  });

  it('toggle opens the market-data socket; leaving the page closes it', function () {
    install();
    const dispatched = [];
    const dispatch = (action, payload) => dispatched.push([action, payload]);
    binanceToggle(dispatch);
    assert.strictEqual(binanceLiveActive(), true);
    assert.strictEqual(sockets.length, 1);
    assert.match(sockets[0].url, /^wss:\/\/data-stream\.binance\.vision\/stream\?streams=/);
    assert.match(sockets[0].url, /btcusdt@miniTicker/);
    assert.match(sockets[0].url, /btcusdt@kline_1m/);
    sockets[0].onopen();
    sockets[0].onmessage({ data: MINITICKER('BTCUSDT', 1000, 64000) });
    // navigating away from #/charts closes the socket
    binancePageSync(false);
    assert.strictEqual(binanceLiveActive(), false);
    assert.strictEqual(sockets[0].closed, true);
  });

  it('toggle again stops an open session', function () {
    install();
    const dispatched = [];
    const dispatch = (action, payload) => dispatched.push([action, payload]);
    binanceToggle(dispatch);
    assert.strictEqual(binanceLiveActive(), true);
    binanceToggle(dispatch);
    assert.strictEqual(binanceLiveActive(), false);
    assert.strictEqual(sockets[0].closed, true);
    assert.match(JSON.stringify(dispatched.at(-1)), /stopped by you/);
  });

  it('reconnects once on a transient close, then stops with a message', function () {
    install();
    const dispatched = [];
    const dispatch = (action, payload) => dispatched.push([action, payload]);
    binanceToggle(dispatch);
    sockets[0].onclose(); // transient drop -> one retry
    assert.strictEqual(binanceLiveActive(), true);
    assert.strictEqual(sockets.length, 2, 'one reconnect attempt');
    sockets[1].onclose(); // second drop -> give up, explain
    assert.strictEqual(binanceLiveActive(), false);
    assert.match(JSON.stringify(dispatched.at(-1)), /closed twice|geo-blocked/);
  });

  it('a deliberate stop never triggers the reconnect path', function () {
    install();
    binanceToggle(() => {});
    const socket = sockets[0];
    stopBinance();
    socket.onclose?.(); // the browser fires close after our close()
    assert.strictEqual(binanceLiveActive(), false);
    assert.strictEqual(sockets.length, 1, 'no reconnect after deliberate close');
  });

  it('without WebSocket support it reports instead of crashing', function () {
    sockets = [];
    delete globalThis.WebSocket;
    const dispatched = [];
    binanceToggle((action, payload) => dispatched.push([action, payload]));
    assert.strictEqual(binanceLiveActive(), false);
    assert.match(JSON.stringify(dispatched), /WebSocket is not available/);
  });
});

describe('binance klines through the incremental session', function () {
  it('the rendered candlestick is byte-identical to a wholesale compile', function () {
    const feed = createBinanceFeed();
    feed.seedKlines(REST_KLINES);
    // the exact definition the boundary renders (step-quantized y)
    const config = {
      type: 'candlestick', title: 'BTCUSDT — 1m candles',
      yLabel: 'USDT', domain: { y: 'step' },
    };
    for (let i = 0; i < 12; i++) {
      // the open candle moves, then a new minute opens — the real feed shape
      const t = 1721556000000 + Math.floor(i / 4) * 60_000;
      feed.handleMessage(KLINE(i, t, 64123.4, 64140 + i, 64100 - i, 64110 + i, false));
      const sessionVnode = feed.klineVnode();
      const wholesale = compileChart(config, feed.klineData(), { theme: 'host' }).toVnode();
      assert.strictEqual(renderToString(sessionVnode), renderToString(wholesale),
        `kline frame ${i} diverged from the wholesale render`);
    }
  });

  it('open-candle updates patch incrementally under the step domain', function () {
    const feed = createBinanceFeed();
    feed.seedKlines(REST_KLINES);
    feed.handleMessage(KLINE(1, 1721556000000, 64123.4, 64140.0, 64100.0, 64110.0, false));
    feed.klineVnode(); // the frame that admits the new candle
    // the open candle ticks inside the quantized domain: no rebuild
    for (let i = 0; i < 6; i++) {
      feed.handleMessage(KLINE(10 + i, 1721556000000, 64123.4, 64140.0, 64100.0, 64112 + i * 0.5, false));
      feed.klineVnode();
    }
    const modes = feed.klineModes();
    assert.ok(modes.incremental >= 6,
      `expected the open candle to patch in place, got ${JSON.stringify(modes)}`);
  });

  it('the live caption reports the session mode counters', function () {
    const feed = createBinanceFeed();
    feed.seedKlines(REST_KLINES);
    feed.handleMessage(MINITICKER('BTCUSDT', 1000, 64000));
    const nodes = binanceNodes(feed, 'live');
    const candle = nodes.filter((n) => n.kind === 'chart')[1];
    assert.match(candle.note, /incremental session/);
    assert.match(candle.note, /\d+ incremental \/ \d+ rebuilt frames/);
  });
});
