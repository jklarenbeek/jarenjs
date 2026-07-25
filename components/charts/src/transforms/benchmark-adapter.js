//@ts-check
/**
 * @file Benchmark interop: pure functions from the published benchmark
 * data shapes (the jaren website's generated `benchmarks/*.json`) to
 * `compileChart`-shaped `{config, data}` pairs. No formatting, no
 * vnodes, no fetching — data in, chart definition out, so every
 * function is unit-testable against a vendored slice of the real data.
 *
 * The suite-wide ratio convention holds: ratio > 1 means "Jaren is N×
 * faster", and the win/loss semantic tones follow it.
 */

/**
 * @typedef {{config: Record<string, any>, data: Record<string, any>}} ChartPair
 */

/**
 * The ratio-distribution bar chart: success-only tests bucketed by
 * ratio. Buckets carry their own predicate and tone.
 * @param {{ratio: number|null, isSuccessTest?: boolean}[]} results
 * @param {{label: string, test: (r: number) => boolean, tone: 'win'|'loss'}[]} buckets
 * @param {string} [title]
 * @returns {ChartPair}
 */
export function ratioDistributionBars(results, buckets, title) {
  const success = results.filter((r) => r.ratio !== null && r.isSuccessTest !== false);
  const counts = buckets.map(() => 0);
  for (const r of success) {
    const index = buckets.findIndex((b) => b.test(/** @type {number} */(r.ratio)));
    if (index >= 0) counts[index] += 1;
  }
  return {
    config: { type: 'bar', title: title ?? null, orient: 'h', valLabel: 'tests' },
    data: {
      categories: buckets.map((b) => b.label),
      series: [{ name: 'tests', values: counts, tones: buckets.map((b) => b.tone) }],
    },
  };
}

/**
 * The ratio scatter: every success-only test as one point, ranked
 * fastest-ratio first, log-scale y, reference line at parity.
 * @param {{ratio: number|null, isSuccessTest?: boolean}[]} results
 * @param {string} [title]
 * @returns {ChartPair}
 */
export function ratioScatter(results, title) {
  const success = results
    .filter((r) => r.ratio !== null && r.isSuccessTest !== false)
    .map((r) => /** @type {number} */(r.ratio))
    .sort((a, b) => b - a);
  return {
    config: {
      type: 'scatter',
      title: title ?? null,
      yLog: true,
      refY: 1,
      refLabel: '1× (parity)',
      xLabel: 'tests, fastest ratio first',
      yLabel: 'ratio (log)',
    },
    data: {
      points: success.map((ratio, i) => ({
        x: i + 1,
        y: ratio,
        tone: ratio >= 1 ? 'win' : 'loss',
      })),
    },
  };
}

/**
 * Per-draft conformance: grouped bars of passed tests per engine.
 * @param {Record<string, Record<string, {passed: number}>>} engineStats
 *   engine → draft → {passed, failed, errors}
 * @param {string} [title]
 * @returns {ChartPair}
 */
export function conformanceBars(engineStats, title) {
  const engines = Object.keys(engineStats);
  const drafts = Object.keys(engineStats[engines[0]] ?? {});
  return {
    config: { type: 'bar', title: title ?? null, valLabel: 'tests passed' },
    data: {
      categories: drafts,
      series: engines.map((engine) => ({
        name: engine,
        values: drafts.map((draft) => engineStats[engine]?.[draft]?.passed ?? null),
      })),
    },
  };
}

/**
 * Generic engine-comparison bars over `{name, results: {engine: value}}`
 * profile rows (the toml/markdown/mermaid profile shape).
 * @param {{name: string, results: Record<string, number>}[]} rows
 * @param {string[]} engines series order (first = jaren)
 * @param {{title?: string, log?: boolean, valLabel?: string}} [options]
 * @returns {ChartPair}
 */
export function profileBars(rows, engines, options = {}) {
  return {
    config: {
      type: 'bar',
      title: options.title ?? null,
      log: options.log === true,
      valLabel: options.valLabel ?? null,
    },
    data: {
      categories: rows.map((r) => r.name),
      series: engines.map((engine) => ({
        name: engine,
        values: rows.map((r) => r.results?.[engine] ?? null),
      })),
    },
  };
}

/**
 * Scenario-matrix bars over `{scenario|title, engines: {key: nsPerOp}}`
 * rows (the jsonquery/jslt shape). Log axis — rival engines span orders
 * of magnitude.
 * @param {{scenario?: string, title?: string, engines: Record<string, number>}[]} rows
 * @param {{title?: string, valLabel?: string}} [options]
 * @returns {ChartPair}
 */
export function matrixBars(rows, options = {}) {
  const keys = [];
  for (const row of rows) {
    for (const key of Object.keys(row.engines ?? {})) {
      if (!keys.includes(key)) keys.push(key);
    }
  }
  keys.sort((a, b) => (a === 'jaren' ? -1 : b === 'jaren' ? 1 : 0));
  return {
    config: {
      type: 'bar',
      title: options.title ?? null,
      log: true,
      valLabel: options.valLabel ?? 'ns/op (log)',
    },
    data: {
      categories: rows.map((r) => r.scenario ?? r.title ?? ''),
      series: keys.map((key) => ({
        name: key,
        values: rows.map((r) => r.engines?.[key] ?? null),
      })),
    },
  };
}

/**
 * Suite pass-count bars over an `{engine: {pass, total}}` map (the
 * toml-compliance / markdown-scorecard shape); the highlighted engine
 * (ours) carries the win tone.
 * @param {Record<string, {pass: number, total: number}>} scorecard
 * @param {{title?: string, highlight?: string, valLabel?: string}} [options]
 * @returns {ChartPair}
 */
export function passCountBars(scorecard, options = {}) {
  const engines = Object.keys(scorecard);
  return {
    config: {
      type: 'bar',
      title: options.title ?? null,
      orient: 'h',
      valLabel: options.valLabel ?? 'tests passed',
    },
    data: {
      categories: engines,
      series: [{
        name: 'passing',
        values: engines.map((engine) => scorecard[engine]?.pass ?? null),
        tones: engines.map((engine) => engine === options.highlight ? 'win' : null),
      }],
    },
  };
}

/**
 * The jsonpath per-query profile: horizontal grouped bars for the
 * top-N queries by jaren-vs-rival spread (the rest stay in the table).
 * @param {{name: string, engines: Record<string, number>}[]} rows
 * @param {string} rival the comparison engine key (e.g. 'json-p3')
 * @param {number} topN
 * @param {string} [title]
 * @returns {ChartPair}
 */
export function querySpreadBars(rows, rival, topN, title) {
  const ranked = rows
    .filter((r) => r.engines?.jaren > 0 && r.engines?.[rival] > 0)
    .map((r) => ({ ...r, spread: r.engines[rival] / r.engines.jaren }))
    .sort((a, b) => b.spread - a.spread)
    .slice(0, topN);
  return {
    config: {
      type: 'bar',
      title: title ?? null,
      orient: 'h',
      log: true,
      valLabel: 'ns/op (log)',
    },
    data: {
      categories: ranked.map((r) => r.name),
      series: [
        { name: 'jaren', values: ranked.map((r) => r.engines.jaren) },
        { name: rival, values: ranked.map((r) => r.engines[rival]) },
      ],
    },
  };
}

/**
 * Bars over a pointer/patch-style result table:
 * `{columns, rows: [{name, results: number[]}]}`.
 * @param {{title?: string, columns: string[], rows: {name: string, results: number[]}[]}} table
 * @param {{title?: string, log?: boolean, valLabel?: string}} [options]
 * @returns {ChartPair}
 */
export function resultTableBars(table, options = {}) {
  return {
    config: {
      type: 'bar',
      title: options.title ?? table.title ?? null,
      log: options.log === true,
      valLabel: options.valLabel ?? 'ns/op',
    },
    data: {
      categories: table.rows.map((r) => r.name),
      series: table.columns.map((column, i) => ({
        name: column,
        values: table.rows.map((r) => r.results?.[i] ?? null),
      })),
    },
  };
}

/**
 * Horizontal bars over `{label, ns}` timing rows (the view/charts
 * benchmark shape). One series in one color: the bars are *nominal*
 * categories — engines or scenarios — so their identity comes from the
 * axis label, not from a hue, and the length is the whole message.
 * Semantic win/loss tones are deliberately not used: on a timing chart
 * "ours" is not automatically good, and DESIGN.md reserves those tokens
 * for genuine status.
 * @param {{label: string, ns: number}[]} rows
 * @param {{title?: string, log?: boolean, valLabel?: string}} [options]
 * @returns {ChartPair}
 */
export function timingBars(rows, options = {}) {
  return {
    config: {
      type: 'bar',
      title: options.title ?? null,
      orient: 'h',
      log: options.log === true,
      valLabel: options.valLabel ?? 'ns/op',
    },
    data: {
      categories: rows.map((r) => r.label),
      series: [{
        name: options.valLabel ?? 'ns/op',
        values: rows.map((r) => (Number.isFinite(r.ns) ? r.ns : null)),
      }],
    },
  };
}

/**
 * Cross-suite ratio bars for the benchmarks overview: one bar per suite
 * headline, tone by which side of parity it lands on — here the tones
 * ARE semantic (a ratio below 1 is a genuine loss, reported as one).
 * @param {{key: string, label: string, ratio: number|null}[]} headlines
 * @param {{title?: string}} [options]
 * @returns {ChartPair}
 */
export function headlineRatioBars(headlines, options = {}) {
  const usable = headlines.filter((h) => Number.isFinite(h.ratio) && h.ratio > 0);
  return {
    config: {
      type: 'bar',
      title: options.title ?? null,
      orient: 'h',
      log: true,
      valLabel: '× vs the fastest rival (log)',
    },
    data: {
      categories: usable.map((h) => h.label),
      series: [{
        name: 'ratio',
        values: usable.map((h) => h.ratio),
        tones: usable.map((h) => (h.ratio >= 1 ? 'win' : 'loss')),
      }],
    },
  };
}
