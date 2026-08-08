//@ts-check
/**
 * @file The JSLT operator/aggregator registry (Ring 1): the
 * builder's immutability and collision rule, the three entry kinds
 * (op scalar, agg sequence-fold, fn via $call), the fold contract, the
 * closed-vocabulary opt-in (a pack operator is unknown without the
 * registry), query-engine parity (compileQuery == linq-over-memory),
 * and that $apply and plain stylesheets are unaffected.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import {
  createJsltRegistry, mathPack, financePack, statsPack, allPacks,
  compileJsltStylesheet,
} from '@jarenjs/json/jslt';
import { compileJsonQuery, analyzeQuery, annotateTypes } from '@jarenjs/json/query';
import { npv, sma } from '@jarenjs/core/finance';

const jslt = () => createJsltRegistry().use(mathPack).use(financePack).use(statsPack);
const run = (registry, body, doc) =>
  registry.compile({ $jslt: '0.1', rules: [{ match: '$', body }] })(doc);

describe('the registry builder', () => {
  it('is immutable-by-copy: .use returns a new registry, the old one is unchanged', () => {
    const empty = createJsltRegistry();
    const withMath = empty.use(mathPack);
    assert.strictEqual(empty.names().length, 0, 'the base registry gained nothing');
    assert.ok(withMath.names().includes('$sqrt'));
    assert.ok(!empty.names().includes('$sqrt'));
  });

  it('enumerates every registered name', () => {
    const names = jslt().names();
    for (const n of ['$sqrt', '$pow', '$npv', '$irr', '$sma', '$mean', '$percentile']) {
      assert.ok(names.includes(n), `missing ${n}`);
    }
    assert.strictEqual(new Set(names).size, names.length, 'no duplicate names');
  });

  it('rejects a collision with the core vocabulary at .use() (TypeError, never JQ)', () => {
    const clash = { name: 'clash', entries: {
      $sum: { kind: 'op', signature: ['number'], result: 'number', fn: (x) => x } } };
    assert.throws(() => createJsltRegistry().use(clash), (e) => {
      assert.ok(e instanceof TypeError);
      assert.match(e.message, /collides with the core vocabulary/);
      return true;
    });
  });

  it('rejects a duplicate name across packs at .use()', () => {
    const a = { name: 'a', entries: { $twice: { kind: 'op', signature: ['number'], result: 'number', fn: (x) => x } } };
    assert.throws(() => createJsltRegistry().use(a).use(a), /already registered/);
  });

  it('rejects a malformed pack (no fn / bad shape)', () => {
    assert.throws(() => createJsltRegistry().use({ name: 'x', entries: { $y: { kind: 'op', signature: ['number'] } } }),
      /must carry a function/);
    assert.throws(() => createJsltRegistry().use(/** @type {any} */ ({ entries: {} })), /must be \{ name/);
  });

  it('allPacks registers everything', () => {
    const all = allPacks.reduce((r, p) => r.use(p), createJsltRegistry());
    assert.ok(all.names().length >= 40);
  });
});

describe('op — scalar operators', () => {
  it('computes a unary and a binary scalar op', () => {
    assert.deepStrictEqual(run(jslt(), { v: { $sqrt: '$.x' } }, { x: 0.25 }), { v: 0.5 });
    assert.deepStrictEqual(run(jslt(), { v: { $pow: ['$.b', '$.e'] } }, { b: 2, e: 10 }), { v: 1024 });
  });

  it('an empty scalar operand propagates to an empty result (the member is absent)', () => {
    assert.deepStrictEqual(run(jslt(), { keep: '$.x', v: { $sqrt: '$.missing' } }, { x: 1 }), { keep: 1 });
  });
});

describe('agg — the sequence fold', () => {
  it('folds a seq operand to an array before the call ($npv over a filtered series)', () => {
    const doc = { rate: 0.1, cashflows: [-1000, 300, 400, 500, 300] };
    const got = run(jslt(), { value: { $npv: ['$.rate', '$.cashflows[*]'] } }, doc);
    assert.strictEqual(got.value, npv(0.1, doc.cashflows), 'equals the direct core call');
  });

  it('a scalar + seq mixed signature ($mirr) and a bare-seq agg ($irr)', () => {
    const doc = { cf: [-1000, 500, 500, 500] };
    const got = run(jslt(), { m: { $mirr: ['$.cf[*]', 0.1, 0.12] } }, doc);
    assert.strictEqual(typeof got.m, 'number');
  });

  it('a seq<number> result is a SEQUENCE — it packs into an array with [...]', () => {
    const doc = { v: [1, 2, 3, 4, 5, 6] };
    const got = run(jslt(), { series: [{ $sma: ['$.v[*]', 3] }] }, doc);
    assert.deepStrictEqual(got.series, sma(doc.v, 3), 'the moving-average series, warm-up nulls included');
  });

  it('stats aggregators over a JSONPath-filtered subset', () => {
    const doc = { people: [
      { class: 'upper', probability: 0.9 }, { class: 'lower', probability: 0.5 },
      { class: 'upper', probability: 0.6 }, { class: 'upper', probability: 0.3 } ] };
    const got = run(jslt(), {
      mean: { $mean: '$.people[?(@.class == "upper")].probability' },
      p50: { $percentile: ['$.people[?(@.class == "upper")].probability', 50] },
    }, doc);
    assert.strictEqual(got.mean, (0.9 + 0.6 + 0.3) / 3);
    assert.strictEqual(got.p50, 0.6);
  });

  it('variance, stddev and median over a series', () => {
    const doc = { v: [2, 4, 4, 4, 5, 5, 7, 9] };
    const got = run(jslt(), {
      variance: { $variance: '$.v[*]' },
      stddev: { $stddev: '$.v[*]' },
      median: { $median: '$.v[*]' },
    }, doc);
    assert.ok(Math.abs(got.variance - 4.571428) < 1e-4);
    assert.ok(Math.abs(got.stddev - 2.13809) < 1e-4);
    assert.strictEqual(got.median, 4.5);
  });

  it('a throwing pack function surfaces as a coded runtime error, not a crash', () => {
    const boom = { name: 'boom', entries: {
      $boom: { kind: 'agg', signature: ['seq<number>'], result: 'number',
        fn: () => { throw new Error('kaboom'); } } } };
    const reg = createJsltRegistry().use(boom);
    assert.throws(() => run(reg, { r: { $boom: '$.v[*]' } }, { v: [1, 2] }), (e) => {
      // JT wraps the JQ2010 from the registered-operator failure
      assert.match(String(e.message), /kaboom/);
      return true;
    });
  });
});

describe('fn — the $call escape hatch', () => {
  it('routes a bare function into options.functions, reached via $call', () => {
    const pack = { name: 'util', entries: {
      clamp: { kind: 'fn', fn: (x, lo, hi) => Math.max(lo, Math.min(hi, x)) } } };
    const reg = createJsltRegistry().use(pack);
    assert.ok(reg.names().includes('clamp'));
    assert.deepStrictEqual(
      run(reg, { v: { $call: ['clamp', '$.x', 0, 10] } }, { x: 42 }), { v: 10 });
    // describe() exposes the registration metadata (Rings 2-3 / tooling)
    assert.strictEqual(reg.describe().clamp.kind, 'fn');
  });
});

describe('closed vocabulary + query-engine parity', () => {
  it('a pack operator is UNKNOWN without the registry (the published format is unchanged)', () => {
    assert.throws(() => compileJsltStylesheet({ $jslt: '0.1', rules: [{ match: '$', body: { v: { $npv: ['$.r', '$.cf[*]'] } } }] }),
      (e) => { assert.match(String(e.message), /JQ0002/); return true; });
    // and the JQ0002 hint from the plain compiler still points at core help
    assert.throws(() => compileJsonQuery({ $sqrt: '$' }),
      (e) => { assert.match(String(e.message), /no operator does this|\$/); return true; });
  });

  it('compileQuery runs a bare query document with a registered operator (linq-over-memory)', () => {
    const q = jslt().compileQuery({ $npv: ['$.rate', '$.cashflows[*]'] });
    assert.strictEqual(q({ rate: 0.1, cashflows: [-1000, 600, 600] }),
      npv(0.1, [-1000, 600, 600]));
  });

  it('toOptions() returns the raw { extensions, functions } for a manual compile', () => {
    const opts = jslt().toOptions();
    assert.ok(opts.extensions.$sqrt && typeof opts.extensions.$sqrt.compile === 'function');
    assert.deepStrictEqual(Object.keys(opts).sort(), ['extensions', 'functions']);
  });

  it('annotateTypes reads a registered operator\'s declared result type (number)', () => {
    const analysis = analyzeQuery({ $sqrt: '$.x' }, jslt().toOptions());
    const typed = annotateTypes(analysis);
    assert.strictEqual(typed.root.type.type, 'number',
      'the pack op\'s resultType flows through the analyzer');
  });

  it('the same registry hits the transform cache (stable options identity) — no throw on reuse', () => {
    const reg = jslt();
    const t = reg.compile({ $jslt: '0.1', rules: [{ match: '$', body: { v: { $sqrt: '$.x' } } }] });
    assert.deepStrictEqual(t({ x: 4 }), { v: 2 });
    assert.deepStrictEqual(t({ x: 9 }), { v: 3 });
  });
});

describe('$apply and plain stylesheets are unaffected', () => {
  it('a plain (no-registry) reshape stylesheet still works', () => {
    const reshape = compileJsltStylesheet({ $jslt: '0.1', rules: [
      { match: '$', body: { items: [{ $apply: ['$.book[*]', 'one'] }] } },
      { mode: 'one', match: '$.book[*]', body: { t: '$.title' } } ] });
    assert.deepStrictEqual(reshape({ book: [{ title: 'A' }, { title: 'B' }] }),
      { items: [{ t: 'A' }, { t: 'B' }] });
  });

  it('a registry stylesheet may still use $apply — the internal operator always wins', () => {
    const got = run(jslt(), { squared: [{ $apply: ['$.n[*]', 'sq'] }] }, { n: [2, 3, 4] });
    // $apply dispatches to a 'sq' mode rule; register it via a two-rule sheet instead:
    const sheet = jslt().compile({ $jslt: '0.1', rules: [
      { match: '$', body: { roots: [{ $apply: ['$.n[*]', 'sq'] }] } },
      { mode: 'sq', match: '$.n[*]', body: { r: { $sqrt: '$' } } } ] });
    assert.deepStrictEqual(sheet({ n: [4, 9, 16] }), { roots: [{ r: 2 }, { r: 3 }, { r: 4 }] });
    void got;
  });
});

describe('forSql — the pushable subset (Rings 2–3 consume it)', () => {
  it('exposes scalar-pushable math and excludes residual-only finance', () => {
    const sql = jslt().forSql();
    assert.strictEqual(sql.$sqrt?.pushable, 'scalar');
    assert.strictEqual(sql.$npv, undefined, 'whole-series npv is residual-only (pushable:false)');
  });
});
