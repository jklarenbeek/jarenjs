//@ts-check
/**
 * The incremental chart session. The load-bearing test is byte
 * equality: after EVERY tick — incremental, rebuilt or unchanged — the
 * session's vnode serializes identically to a wholesale
 * compileChart() of the adapter's current data. Everything else
 * (modes, reference reuse) is an efficiency claim on top of that.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { compileChart, createChartSession } from '@jarenjs/charts';
import { createChartComponent } from '@jarenjs/charts/component';
import { createStreamAdapter } from '@jarenjs/charts/stream-adapter';
import { createJsonxStreamReader } from '@jarenjs/josl';
import { renderToString } from '@jarenjs/view';

/** Deterministic PRNG (mulberry32) — property tests must replay. */
function prng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function feedDoc(adapter, message) {
  const reader = createJsonxStreamReader({ mode: 'json', onEvent: adapter.onEvent });
  reader.feed(JSON.stringify(message));
  reader.end();
  adapter.endDocument();
}

const ADAPTER_SPEC = {
  recordBoundary: 'document', xField: 'x', yField: 'y', seriesField: 's', changes: true,
};

/**
 * Run `frames` random frames through a session and assert byte
 * equality against the wholesale compile after every tick.
 * @returns {{unchanged: number, incremental: number, rebuilt: number, evictIncremental: number}}
 */
function runProperty(config, adapterSpec, frames, seed) {
  const rand = prng(seed);
  const adapter = createStreamAdapter('line', adapterSpec);
  const session = createChartSession(config, adapter);
  const names = ['alpha', 'beta', 'gamma'];
  const counters = { unchanged: 0, incremental: 0, rebuilt: 0, evictIncremental: 0 };
  let x = 0;
  for (let frame = 0; frame < frames; frame++) {
    const roll = rand();
    let sawMessages = 0;
    if (roll < 0.08) {
      // quiet frame — nothing arrives
    }
    else {
      if (roll > 0.97) names.push(`late${names.length}`); // a brand-new series
      const burst = 1 + Math.floor(rand() * 3);
      for (let b = 0; b < burst; b++) {
        const s = names[Math.floor(rand() * names.length)];
        const y = rand() < 0.06 ? null : Math.round((40 + 40 * Math.sin(x / 7) + rand() * 20) * 100) / 100;
        feedDoc(adapter, { x: x++, s, y });
        sawMessages++;
      }
    }
    const { vnode, mode } = session.tick();
    counters[mode]++;
    if (mode === 'incremental' && sawMessages !== 0
      && adapterSpec.maxPoints !== undefined && x > adapterSpec.maxPoints) {
      counters.evictIncremental++;
    }
    const wholesale = compileChart(config, adapter.getData()).toVnode();
    assert.equal(renderToString(vnode), renderToString(wholesale),
      `frame ${frame} (${mode}) diverged from the wholesale render`);
  }
  return counters;
}

describe('chart session — byte-equality property', function () {
  it('policy config: every frame byte-equal, most frames incremental', function () {
    const config = {
      type: 'line', title: 'Stream', markers: true,
      domain: { y: { min: 0, max: 120 }, x: { window: 80, slide: 20 } },
    };
    const counters = runProperty(config, { ...ADAPTER_SPEC, maxPoints: 200 }, 220, 0xC0FFEE);
    assert.ok(counters.incremental > counters.rebuilt,
      `expected mostly incremental frames, got ${JSON.stringify(counters)}`);
    assert.ok(counters.unchanged > 0);
  });

  it('no-policy config: still byte-equal on every frame (rebuild fallback)', function () {
    const counters = runProperty({ type: 'line', markers: true },
      { ...ADAPTER_SPEC, maxPoints: 200 }, 120, 0xBADA55);
    assert.ok(counters.rebuilt > 0);
  });

  it('eviction under a still domain stays incremental and byte-equal', function () {
    const config = {
      type: 'line', title: 'Evicting',
      domain: { y: { min: -10, max: 130 }, x: { window: 80, slide: 20 } },
    };
    const counters = runProperty(config, { ...ADAPTER_SPEC, maxPoints: 24 }, 200, 0x5EED);
    assert.ok(counters.evictIncremental > 0,
      `expected incremental frames past the ring buffer, got ${JSON.stringify(counters)}`);
  });

  it('log y with a step domain: byte-equal across decades and null samples', function () {
    const config = {
      type: 'line', log: true,
      domain: { y: 'step', x: { window: 80, slide: 20 } },
    };
    const counters = runProperty(config, { ...ADAPTER_SPEC, maxPoints: 200 }, 120, 0x10C0);
    assert.ok(counters.incremental > 0);
  });
});

describe('chart session — modes and reference reuse', function () {
  function seeded() {
    const adapter = createStreamAdapter('line', { ...ADAPTER_SPEC, maxPoints: 100 });
    const config = {
      type: 'line', title: 'Reuse', markers: true,
      domain: { y: { min: 0, max: 100 }, x: { window: 50, slide: 50 } },
    };
    const session = createChartSession(config, adapter);
    for (const s of ['a', 'b', 'c']) {
      for (let i = 0; i < 4; i++) feedDoc(adapter, { x: i, s, y: 10 + i });
    }
    const first = session.tick();
    assert.equal(first.mode, 'rebuilt');
    return { adapter, session, config, first };
  }

  it('a quiet tick returns the same vnode reference, mode unchanged', function () {
    const { session, first } = seeded();
    const again = session.tick();
    assert.equal(again.mode, 'unchanged');
    assert.equal(again.vnode, first.vnode);
  });

  it('an append to one series reuses every other child by reference', function () {
    const { adapter, session, first } = seeded();
    feedDoc(adapter, { x: 5, s: 'b', y: 42 });
    const next = session.tick();
    assert.equal(next.mode, 'incremental');
    assert.notEqual(next.vnode, first.vnode);
    const prevChildren = first.vnode.slice(2);
    const nextChildren = next.vnode.slice(2);
    assert.equal(prevChildren.length, nextChildren.length);
    let reused = 0;
    let fresh = 0;
    for (let i = 0; i < prevChildren.length; i++) {
      if (prevChildren[i] === nextChildren[i]) reused++;
      else fresh++;
    }
    assert.equal(fresh, 1, 'exactly the touched series group is fresh');
    assert.equal(reused, prevChildren.length - 1);
    // and the fresh group is series b: its path gained the new point
    const bGroup = nextChildren.find((c, i) => prevChildren[i] !== c);
    assert.equal(bGroup[1].key, 'ls1');
  });

  it('a domain-moving append reports rebuilt', function () {
    const { adapter, session } = seeded();
    feedDoc(adapter, { x: 5, s: 'a', y: 400 }); // beyond the pinned max? clamped — still fine
    assert.equal(session.tick().mode, 'incremental'); // pinned domain absorbs it
    feedDoc(adapter, { x: 51, s: 'a', y: 10 }); // crosses the window slide quantum
    assert.equal(session.tick().mode, 'rebuilt');
  });

  it('a new series and a reset both rebuild and stay byte-equal', function () {
    const { adapter, session, config } = seeded();
    feedDoc(adapter, { x: 6, s: 'newcomer', y: 30 });
    const grown = session.tick();
    assert.equal(grown.mode, 'rebuilt');
    assert.equal(renderToString(grown.vnode),
      renderToString(compileChart(config, adapter.getData()).toVnode()));
    adapter.reset();
    const cleared = session.tick();
    assert.equal(cleared.mode, 'rebuilt');
    assert.equal(renderToString(cleared.vnode),
      renderToString(compileChart(config, adapter.getData()).toVnode()));
  });

  it('appended markers become appended dots inside the touched group', function () {
    const { adapter, session, first } = seeded();
    const before = first.vnode.slice(2).find((c) => c[1]?.key === 'ls2');
    feedDoc(adapter, { x: 5, s: 'c', y: 77 });
    const next = session.tick();
    const after = next.vnode.slice(2).find((c) => c[1]?.key === 'ls2');
    assert.equal(after.length, before.length + 1); // one more dot child
    assert.equal(after[1], before[1]); // group props object reused
  });

  it('rejects unsupported chart types at construction', function () {
    assert.throws(() => createChartSession({ type: 'pie' }, { takeChanges: () => [], getData: () => ({}) }),
      /does not support type 'pie'/);
  });

  it('the component wrapper threads its theme into the session', function () {
    const adapter = createStreamAdapter('line', ADAPTER_SPEC);
    feedDoc(adapter, { x: 0, s: 'a', y: 1 });
    const charts = createChartComponent({ theme: 'host' });
    const session = charts.createSession({ type: 'line' }, adapter);
    const { vnode } = session.tick();
    assert.equal(vnode[1].style['--chart-text'], 'var(--fg, #1f2020)');
  });
});

describe('candlestick session', function () {
  const CANDLE_SPEC = { recordBoundary: 'document', xField: 't', maxPoints: 50, changes: true };
  const k = (t, open, close, wick = 5) => ({
    t, open, close, high: Math.max(open, close) + wick, low: Math.min(open, close) - wick,
  });

  function seeded(config) {
    const adapter = createStreamAdapter('candlestick', CANDLE_SPEC);
    const session = createChartSession(config, adapter);
    for (let i = 0; i < 8; i++) feedDoc(adapter, k(i * 60_000, 100 + i, 102 + i));
    const first = session.tick();
    assert.equal(first.mode, 'rebuilt');
    return { adapter, session, first };
  }

  const PINNED = {
    type: 'candlestick', title: 'Klines',
    domain: { y: { min: 80, max: 130 } },
  };

  it('a kline upsert is incremental and rebuilds exactly one candle group (2 marks)', function () {
    const { adapter, session, first } = seeded(PINNED);
    feedDoc(adapter, k(7 * 60_000, 107, 104)); // the newest candle turns down
    const next = session.tick();
    assert.equal(next.mode, 'incremental');
    const prevChildren = first.vnode.slice(2);
    const nextChildren = next.vnode.slice(2);
    assert.equal(prevChildren.length, nextChildren.length);
    const freshAt = [];
    for (let i = 0; i < prevChildren.length; i++) {
      if (prevChildren[i] !== nextChildren[i]) freshAt.push(i);
    }
    assert.equal(freshAt.length, 1, 'exactly one child replaced');
    const group = nextChildren[freshAt[0]];
    assert.equal(group[1].key, `c${7 * 60_000}`);
    assert.equal(group.length - 2, 2); // wick + body — exactly two rebuilt marks
    assert.match(renderToString(group), /chart-candle-down/);
  });

  it('every upsert frame stays byte-equal to the wholesale compile', function () {
    const { adapter, session } = seeded(PINNED);
    const rand = prng(0xCAFE);
    for (let frame = 0; frame < 60; frame++) {
      const at = Math.floor(rand() * 8) * 60_000;
      feedDoc(adapter, k(at, 100 + rand() * 10, 100 + rand() * 10, 2 + rand() * 3));
      const { vnode, mode } = session.tick();
      assert.equal(renderToString(vnode),
        renderToString(compileChart(PINNED, adapter.getData()).toVnode()),
        `frame ${frame} (${mode}) diverged`);
    }
  });

  it('an upsert that would move an unpinned domain rebuilds instead', function () {
    const config = { type: 'candlestick' };
    const { adapter, session } = seeded(config);
    feedDoc(adapter, k(3 * 60_000, 100, 500)); // a new all-time high
    const next = session.tick();
    assert.equal(next.mode, 'rebuilt');
    assert.equal(renderToString(next.vnode),
      renderToString(compileChart(config, adapter.getData()).toVnode()));
  });

  it('a new candle (count change) rebuilds — band widths shift', function () {
    const { adapter, session } = seeded(PINNED);
    feedDoc(adapter, k(8 * 60_000, 108, 110));
    assert.equal(session.tick().mode, 'rebuilt');
  });

  it('an upsert behind the window patches nothing but stays byte-equal', function () {
    const config = {
      type: 'candlestick',
      domain: { y: { min: 80, max: 130 }, x: { window: 240_000, slide: 60_000 } },
    };
    const { adapter, session } = seeded(config);
    feedDoc(adapter, k(0, 90, 95)); // t=0 sits behind the 240s window
    const next = session.tick();
    assert.equal(next.mode, 'incremental');
    assert.equal(renderToString(next.vnode),
      renderToString(compileChart(config, adapter.getData()).toVnode()));
  });

  it('eviction past maxPoints rebuilds and stays byte-equal', function () {
    const spec = { ...CANDLE_SPEC, maxPoints: 5 };
    const adapter = createStreamAdapter('candlestick', spec);
    const session = createChartSession(PINNED, adapter);
    for (let i = 0; i < 9; i++) {
      feedDoc(adapter, k(i * 60_000, 100 + i, 102 + i));
      const { vnode } = session.tick();
      assert.equal(renderToString(vnode),
        renderToString(compileChart(PINNED, adapter.getData()).toVnode()));
    }
    assert.equal(adapter.getData().candles.length, 5);
  });
});
