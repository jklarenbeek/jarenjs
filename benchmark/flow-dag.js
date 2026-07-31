#!/usr/bin/env node

/**
 * @jarenjs/flow DAG performance vs a hand-written JS baseline.
 *
 * No npm library executes schema-validated JSON dataflow, so — like the
 * view suite's hand-written tagged-array rows — the honest rival is the
 * SAME pipeline written straight in JavaScript. The graph buys
 * something the hand-written function does not: it is one
 * schema-validated, serializable JSON value a constrained decoder can
 * author and the validator can check. The ratio here is the measured
 * price of that, and it ships beside what it buys.
 *
 * The pipeline (filter → join → project) at 100 and 10 000 rows, run two
 * ways:
 *  - sync: query/jslt/const nodes only — the dispatcher tax, no I/O.
 *  - mixed-async: one `task` node with a resolved promise in the middle,
 *    the shape a real graph has (an enrichment call), where the
 *    per-node await is the same on both sides.
 *
 * Usage:
 *   node benchmark/flow-dag.js
 *   node benchmark/flow-dag.js --output json --filepath out.json
 */

import { writeFileSync } from 'node:fs';

import { compileDag } from '@jarenjs/flow';

import { formatNs } from './lib/fmt.js';

//#region options
const args = process.argv.slice(2);
const OUTPUT = args.includes('--output') ? args[args.indexOf('--output') + 1] : null;
const FILEPATH = args.includes('--filepath') ? args[args.indexOf('--filepath') + 1] : null;
const SIZES = [100, 10000];
//#endregion

/** N people, half adult, each tagged with a region key for the join. */
function rows(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ name: `p${i}`, age: i % 2 === 0 ? 30 : 10, region: i % 3 === 0 ? 'eu' : 'us' });
  }
  return out;
}
const REGIONS = { eu: 'Europe', us: 'United States' };

//#region the dataflow, both ways
/**
 * The jaren-dag: input → filter adults (query) → join region name
 * (jslt) → project (jslt) → output. `withTask` inserts a task node
 * (a resolved-promise enrichment) for the mixed-async variant.
 */
function dagDoc(withTask) {
  const nodes = {
    src: { kind: 'input' },
    adults: { kind: 'query', query: { $for: { r: '$[*]' }, $where: { $ge: ['$r.age', 18] }, $return: '$r' } },
    regions: { kind: 'const', value: REGIONS },
    joined: {
      kind: 'jslt',
      stylesheet: [{
        match: '$',
        body: [{
          $for: { r: '$.people[*]' },
          $return: { name: '$r.name', region: { $get: ['$.regions', '$r.region'] } },
        }],
      }],
    },
    out: { kind: 'output' },
  };
  const edges = [{ from: 'src', to: 'adults' }];
  if (withTask) {
    // adults → enrich (single input, portless) → joined (port people)
    nodes.enrich = { kind: 'task', run: 'passthrough' };
    edges.push({ from: 'adults', to: 'enrich' });
    edges.push({ from: 'enrich', to: 'joined', port: 'people' });
  }
  else {
    edges.push({ from: 'adults', to: 'joined', port: 'people' });
  }
  edges.push({ from: 'regions', to: 'joined', port: 'regions' });
  edges.push({ from: 'joined', to: 'out' });
  return { $dag: '0.1', nodes, edges };
}

/** The same pipeline, hand-written — the honest baseline. */
function handWritten(data) {
  const adults = data.filter((r) => r.age >= 18);
  return adults.map((r) => ({ name: r.name, region: REGIONS[r.region] }));
}
async function handWrittenAsync(data) {
  const adults = data.filter((r) => r.age >= 18);
  const enriched = await Promise.resolve(adults);
  return enriched.map((r) => ({ name: r.name, region: REGIONS[r.region] }));
}
//#endregion

const TASKS = { passthrough: async ({ input }) => input };

/** Assert the graph and the hand-written function produce identical output. */
async function assertAgrees(n) {
  const data = rows(n);
  const sync = await compileDag(dagDoc(false), { tasks: TASKS }).run(data);
  const hand = handWritten(data);
  if (JSON.stringify(sync) !== JSON.stringify(hand)) {
    throw new Error(`dag and hand-written disagree at ${n} rows`);
  }
  const async2 = await compileDag(dagDoc(true), { tasks: TASKS }).run(data);
  if (JSON.stringify(async2) !== JSON.stringify(hand)) {
    throw new Error(`async dag and hand-written disagree at ${n} rows`);
  }
}

//#region timing
/** @type {Record<string, any>} */
const collected = { sync: [], async: [] };

for (const n of SIZES) {
  await assertAgrees(n);
  const data = rows(n);
  const iters = n >= 10000 ? 200 : 2000;

  // no-task variant: query/jslt/const only. `run` is async by design
  // (it drives a wavefront), so it is awaited even here — the
  // hand-written baseline is wrapped in Promise.resolve for the same
  // per-iteration await, so the comparison is not an await-vs-no-await
  // artifact. The dag is compiled ONCE, as a consumer would.
  const syncDag = compileDag(dagDoc(false), { tasks: TASKS });
  const dagSyncMs = await timeItAsync(() => syncDag.run(data), iters);
  const handSyncMs = await timeItAsync(() => Promise.resolve(handWritten(data)), iters);
  collected.sync.push({ rows: n, dagMs: dagSyncMs, handMs: handSyncMs });
  console.log(`\nno-task pipeline — ${n} rows (${iters} iterations)`);
  console.log(`  jaren-dag           ${formatNs(dagSyncMs * 1e6)}`);
  console.log(`  hand-written JS     ${formatNs(handSyncMs * 1e6)}  (${(dagSyncMs / handSyncMs).toFixed(1)}× the hand-written cost)`);

  // mixed-async: a task node in the middle; both sides await once
  const asyncDag = compileDag(dagDoc(true), { tasks: TASKS });
  const dagAsyncMs = await timeItAsync(() => asyncDag.run(data), iters);
  const handAsyncMs = await timeItAsync(() => handWrittenAsync(data), iters);
  collected.async.push({ rows: n, dagMs: dagAsyncMs, handMs: handAsyncMs });
  console.log(`mixed-async pipeline — ${n} rows`);
  console.log(`  jaren-dag           ${formatNs(dagAsyncMs * 1e6)}`);
  console.log(`  hand-written JS     ${formatNs(handAsyncMs * 1e6)}  (${(dagAsyncMs / handAsyncMs).toFixed(1)}× the hand-written cost)`);
}

/** ms/op for an async fn over `iterations` runs, after two warmups. */
async function timeItAsync(fn, iterations) {
  await fn(); await fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) await fn();
  return Number(process.hrtime.bigint() - t0) / 1e6 / iterations;
}
//#endregion

if (OUTPUT === 'json') {
  const data = {
    date: new Date().toISOString(),
    node: process.version,
    sizes: SIZES,
    sync: collected.sync.map((r) => ({ rows: r.rows, dagMs: Number(r.dagMs.toPrecision(4)), handMs: Number(r.handMs.toPrecision(4)) })),
    async: collected.async.map((r) => ({ rows: r.rows, dagMs: Number(r.dagMs.toPrecision(4)), handMs: Number(r.handMs.toPrecision(4)) })),
  };
  const json = JSON.stringify(data, null, 2);
  if (FILEPATH !== null) { writeFileSync(FILEPATH, json); console.log(`\nwrote ${FILEPATH}`); }
  else console.log(json);
}

console.log('\nMethodology: the dag and the hand-written function produce byte-identical output (asserted');
console.log('before timing). The dag is compiled once, as a consumer would, then run per iteration. The');
console.log('ratio is the price of dataflow as a schema-validated, serializable, constrained-decodable');
console.log('JSON value — the same honesty as the view suite\'s hand-written-vs-stylesheet rows. There is');
console.log('no npm rival because no library executes JSON dataflow; the hand-written JS is the floor.');
