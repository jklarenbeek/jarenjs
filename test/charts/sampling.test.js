//@ts-check
/**
 * Line sampling (`core/sampling.js`): the policy that decides how many
 * of a time line's points are drawn.
 *
 * The claims under test are the reversible ones. A small line and a
 * category line are byte-identical to what they were before sampling
 * existed; a long time line samples by default and SAYS so; the method,
 * the budget and the opt-out all work; and the sampled line still
 * starts where the data starts, ends where it ends, keeps its holes and
 * never carries an instant no reading had. Retention is measured
 * separately, in `stream-adapter.test.js` — this file never asserts
 * anything about what the adapter keeps.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import {
  buildLineAST, compileChart, createStreamAdapter, createChartSession,
  normalizeSampling, SAMPLING_THRESHOLD, SAMPLING_WIDTH,
  SAMPLING_TARGET_MIN, SAMPLING_TARGET_MAX,
} from '@jarenjs/charts';
import { createJsonxStreamReader } from '@jarenjs/josl';

const T0 = 1_767_225_600_000;

/** A deterministic series: exact binary fractions, so equality is the
 * check everywhere (the SERIES corpus rule). */
const ramp = (n, shape = (i) => Math.round(4096 * Math.sin(i / 31)) / 4096 + (i % 7)) =>
  Array.from({ length: n }, (_, i) => ({ x: T0 + i * 1000, y: shape(i) }));

const line = (points, config = {}) =>
  buildLineAST({ series: [{ name: 'a', points }] }, { type: 'line', x: 'time', ...config });

const drawn = (ast) => ast.series[0].points.filter((p) => p !== null);

describe('sampling policy', function () {
  it('resolves the four spellings, and false means never', function () {
    assert.equal(normalizeSampling(false), null);
    assert.deepEqual(normalizeSampling(undefined),
      { method: 'lttb', target: SAMPLING_WIDTH, auto: true });
    assert.deepEqual(normalizeSampling('minmax'),
      { method: 'minmax', target: SAMPLING_WIDTH, auto: false });
    assert.deepEqual(normalizeSampling({ method: 'minmax', target: 100 }),
      { method: 'minmax', target: 100, auto: false });
  });

  it('derives the budget from width × pixelRatio, and clamps both ends', function () {
    assert.equal(normalizeSampling({ width: 1200 }).target, 1200);
    assert.equal(normalizeSampling({ width: 800, pixelRatio: 2 }).target, 1600);
    assert.equal(normalizeSampling({ width: 10 }).target, SAMPLING_TARGET_MIN);
    assert.equal(normalizeSampling({ width: 99_999 }).target, SAMPLING_TARGET_MAX);
    assert.equal(normalizeSampling({ target: 99_999 }).target, SAMPLING_TARGET_MAX);
  });

  it('falls back to the default rather than throwing on a misspelling', function () {
    assert.deepEqual(normalizeSampling({ method: 'lttp', target: 1.5 }),
      { method: 'lttb', target: SAMPLING_WIDTH, auto: false });
  });
});

describe('the default: a time line above two thousand points', function () {
  it('samples through LTTB and reports what it did', function () {
    const ast = line(ramp(20_000));
    assert.deepEqual(ast.sampling, {
      method: 'lttb', target: SAMPLING_WIDTH, sourceCount: 20_000, renderedCount: SAMPLING_WIDTH,
    });
    assert.equal(ast.series[0].points.length, SAMPLING_WIDTH);
  });

  it('leaves a line at the threshold alone, point for point', function () {
    const points = ramp(SAMPLING_THRESHOLD);
    const ast = line(points);
    assert.equal(ast.sampling, null);
    assert.equal(ast.series[0].points.length, SAMPLING_THRESHOLD);
    assert.deepEqual(ast, line(points, { sampling: false }));
  });

  it('leaves a NON-time line alone whatever its length', function () {
    const points = ramp(20_000);
    const ast = buildLineAST({ series: [{ name: 'a', points }] }, { type: 'line' });
    assert.equal(ast.sampling, null);
    assert.equal(ast.series[0].points.length, 20_000);
  });

  it('is reversible: false draws every point back', function () {
    const points = ramp(20_000);
    assert.equal(line(points, { sampling: false }).series[0].points.length, 20_000);
    assert.equal(line(points, { sampling: false }).sampling, null);
  });

  it('never moves the domain: the axis reports the data, not the drawing', function () {
    const points = ramp(20_000);
    assert.deepEqual(line(points).domain, line(points, { sampling: false }).domain);
    assert.deepEqual(line(points).x.ticks, line(points, { sampling: false }).x.ticks);
  });
});

describe('the explicit spellings', function () {
  it('a method name samples whatever the count and whatever the axis', function () {
    const ast = line(ramp(1000), { sampling: { method: 'minmax', target: 50 } });
    assert.equal(ast.sampling.method, 'minmax');
    assert.ok(ast.sampling.renderedCount <= 50);
    const linear = buildLineAST({ series: [{ name: 'a', points: ramp(1000) }] },
      { type: 'line', sampling: { target: 50 } });
    assert.ok(linear.sampling.renderedCount <= 50);
  });

  it('an explicit target makes the drawn line independent of any width', function () {
    const points = ramp(20_000);
    const a = line(points, { sampling: { target: 300, width: 400 } });
    const b = line(points, { sampling: { target: 300, width: 3000, pixelRatio: 3 } });
    assert.deepEqual(a.series[0].points, b.series[0].points);
    assert.equal(a.sampling.target, 300);
  });

  it('a declared width sizes the budget', function () {
    assert.equal(line(ramp(20_000), { sampling: { width: 1200 } }).sampling.renderedCount, 1200);
  });

  it('a target the data cannot honestly fit draws every point instead', function () {
    // three gap runs and four segments need eleven mandatory points; a
    // budget of four cannot hold them, and the kernel refuses rather
    // than drawing a line through data that is not there
    const points = ramp(3000).map((p, i) => (i % 700 < 3 && i > 0 ? { ...p, y: null } : p));
    const ast = line(points, { sampling: { target: 4 } });
    assert.equal(ast.sampling, null);
    assert.equal(ast.series[0].points.length, 3000);
  });
});

describe('what a sampled line still promises', function () {
  it('keeps the first and the last reading exactly where they were', function () {
    const points = ramp(50_000);
    const whole = line(points, { sampling: false }).series[0].points;
    const sampled = line(points).series[0].points;
    assert.deepEqual(sampled[0], whole[0]);
    assert.deepEqual(sampled[sampled.length - 1], whole[whole.length - 1]);
  });

  it('never fabricates an instant: every vertex is a reading that happened', function () {
    const points = ramp(20_000);
    const whole = new Set(line(points, { sampling: false }).series[0].points
      .map((p) => `${p.u}|${p.v}`));
    for (const p of drawn(line(points)))
      assert.ok(whole.has(`${p.u}|${p.v}`), `${p.u} was not a source point`);
  });

  it('keeps a hole a hole and never bridges it', function () {
    const points = ramp(20_000).map((p, i) => (i >= 8000 && i < 9000 ? { ...p, y: null } : p));
    const ast = line(points);
    const nulls = ast.series[0].points.filter((p) => p === null);
    assert.equal(nulls.length, 1);
    // the gap marker sits between the two drawn segments, in order
    const at = ast.series[0].points.indexOf(null);
    assert.ok(at > 0 && at < ast.series[0].points.length - 1);
  });

  it("minmax keeps the envelope: a one-sample spike survives", function () {
    const points = ramp(20_000, (i) => (i === 12_345 ? 1000 : i % 3));
    const ast = line(points, { sampling: 'minmax' });
    const top = Math.max(...drawn(ast).map((p) => p.v));
    assert.equal(top, 1);
    assert.equal(ast.sampling.method, 'minmax');
  });

  it('reports source and rendered counts across every series', function () {
    const ast = buildLineAST({ series: [
      { name: 'a', points: ramp(20_000) },
      { name: 'b', points: ramp(10) },
    ] }, { type: 'line', x: 'time' });
    assert.equal(ast.sampling.sourceCount, 20_010);
    assert.equal(ast.sampling.renderedCount, SAMPLING_WIDTH + 10);
    assert.equal(ast.series[1].points.length, 10); // the short one is untouched
  });

  it('leaves a series whose x goes backwards alone', function () {
    const points = ramp(20_000);
    [points[9000], points[9001]] = [points[9001], points[9000]];
    const ast = line(points);
    assert.equal(ast.sampling, null);
    assert.equal(ast.series[0].points.length, 20_000);
  });
});

describe('sampling is not retention', function () {
  it("a change of method leaves the adapter's kept points identical", function () {
    const doc = JSON.stringify({ run: Array.from({ length: 300 }, (_, i) => ({
      t: T0 + i * 1000, v: i % 11 })) });
    const read = () => {
      const adapter = createStreamAdapter('line',
        { recordPath: ['run'], xField: 't', yField: 'v', maxPoints: 120 });
      const reader = createJsonxStreamReader({ mode: 'json', onEvent: adapter.onEvent });
      reader.feed(doc);
      reader.end();
      adapter.endDocument();
      return adapter;
    };
    const a = read();
    const b = read();
    assert.deepEqual(a.getData(), b.getData());
    assert.equal(a.getData().series[0].points.length, 120); // retention decided that

    // the same retained data, drawn two ways, and still the same data
    const before = JSON.stringify(a.getData());
    const off = compileChart({ type: 'line', x: 'time', sampling: false }, a.getData());
    const on = compileChart({ type: 'line', x: 'time', sampling: { target: 20 } }, b.getData());
    assert.equal(off.ast.series[0].points.length, 120);
    assert.ok(on.ast.series[0].points.length <= 20);
    assert.equal(JSON.stringify(a.getData()), before);
    assert.deepEqual(a.getData(), b.getData());
  });
});

describe('the incremental session under sampling', function () {
  /** A source the session drains, in the adapter's own op shape. */
  function feedSource(points) {
    let sent = 0;
    /** @type {any[]} */
    const ops = [];
    return {
      append() {
        ops.push({ op: 'add', path: '/series/0/points/-', value: points[sent] });
        sent++;
      },
      takeChanges() { return ops.splice(0, ops.length); },
      getData() { return { series: [{ name: 'a', points: points.slice(0, sent) }] }; },
    };
  }

  it('a sampled line rebuilds every tick and stays byte-equal to the wholesale build', function () {
    const points = ramp(2100);
    const source = feedSource(points);
    for (let i = 0; i < 2050; i++) source.append();
    const config = { type: 'line', x: 'time', sampling: { target: 40 } };
    const session = createChartSession(config, source);
    session.tick();
    const modes = [];
    for (let i = 0; i < 20; i++) {
      source.append();
      const frame = session.tick();
      modes.push(frame.mode);
      assert.equal(JSON.stringify(frame.vnode),
        JSON.stringify(compileChart(config, source.getData()).toVnode()));
    }
    assert.deepEqual([...new Set(modes)], ['rebuilt']);
  });

  it('an unsampled line keeps its O(change) frames', function () {
    const points = ramp(500);
    const source = feedSource(points);
    for (let i = 0; i < 400; i++) source.append();
    const config = { type: 'line', x: 'time', sampling: false, domain: { x: { window: 400_000 } } };
    const session = createChartSession(config, source);
    session.tick();
    const modes = [];
    for (let i = 0; i < 20; i++) {
      source.append();
      modes.push(session.tick().mode);
    }
    assert.ok(modes.includes('incremental'));
  });

  it('crossing the default threshold rebuilds instead of appending a vertex', function () {
    const points = ramp(SAMPLING_THRESHOLD + 10);
    const source = feedSource(points);
    for (let i = 0; i < SAMPLING_THRESHOLD - 1; i++) source.append();
    const config = { type: 'line', x: 'time',
      domain: { y: { min: 0, max: 8 }, x: { window: 8_000_000, slide: 8_000_000 } } };
    const session = createChartSession(config, source);
    session.tick();
    source.append(); // still at the threshold: incremental
    assert.equal(session.tick().mode, 'incremental');
    source.append(); // one over: the sampler takes it
    const frame = session.tick();
    assert.equal(frame.mode, 'rebuilt');
    assert.equal(JSON.stringify(frame.vnode),
      JSON.stringify(compileChart(config, source.getData()).toVnode()));
  });
});
