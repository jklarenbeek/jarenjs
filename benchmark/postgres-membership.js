#!/usr/bin/env node

/**
 * What a long chain of membership terms costs against a PostgreSQL
 * collection, and how close the planner's row estimate comes to the rows a
 * statement returns.
 *
 * A chain of `t` terms is an `$or` of t / 2 pairs, each an equality on an
 * indexed member and a range on an unindexed one. Nothing regroups it, so
 * every term is a leaf predicate the statement carries, and the server
 * prices every leaf per row. The PostgreSQL dialect bounds the leaves one
 * statement carries: a chain within the bound is ONE native statement, a
 * longer one is answered by the engine over the documents it fetches, and
 * `explain()` names the reason (`predicate.termBound`). Each size is reported
 * with the plan it got and the milliseconds `execute()` takes; where the plan
 * is native the same chain is also run through the engine alone
 * (`pushdown: false`), which is what the bound costs a chain it refuses.
 *
 * The same number of terms written as equalities on one member and ranges on
 * another regroups to one membership list and one bound; it is measured
 * beside the chains. The estimates are `explain().budget.estimatedRows`
 * against the rows the statement returns, for a small corpus of collection
 * statements, entity statements and loads, with the tables analyzed first. An
 * estimate is the planner's own and never a count; the table shows how far off
 * it is, including the cases where it is not offered.
 *
 * The server's JIT settings decide whether a statement is compiled. They are
 * read and recorded and NEVER changed: a compile forced by lowered thresholds
 * is a configuration no application runs, so its numbers are not a figure this
 * program publishes. Each native statement is also run under
 * `EXPLAIN (ANALYZE)` so the result says what the server charged for it and
 * whether it compiled it. No statement this program sends carries more than
 * 400 terms that nothing regroups; every statement runs under a
 * `statement_timeout`; the measurement lives in a schema of its own that is
 * dropped when the run ends, on one pooled connection beside one
 * administrative connection.
 *
 * Usage:
 *   JAREN_PG_URL=postgres://jaren:jaren@127.0.0.1:55433/jaren node benchmark/postgres-membership.js [--write | --smoke]
 *
 * `--write` records the figures in `postgres-membership-result.json`, with the
 * SHA-256 of every source that determines them, for `npm run docs:derive`.
 * `--smoke` runs two sizes with three calls each, writes nothing and finishes
 * in seconds: it checks that the program still runs against a server.
 */

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { cpus } from 'node:os';

import { openStore, reasonId } from '@jarenjs/db';
import { postgresDriver } from '@jarenjs/db/postgres';

const args = process.argv.slice(2);
for (const arg of args) assert.ok(arg === '--write' || arg === '--smoke', 'unknown argument');
const write = args.includes('--write');
const smoke = args.includes('--smoke');
assert.ok(!(write && smoke), 'a smoke run writes nothing: pass --smoke or --write, not both');
const endpoint = process.env.JAREN_PG_URL;
if (!endpoint) throw new Error('the membership profile needs a PostgreSQL endpoint: set JAREN_PG_URL');
const sourceFiles = ['benchmark/postgres-membership.js', 'packages/db/src/plan.js', 'packages/db/src/emit.js',
  'packages/db/src/query.js', 'packages/db/src/dialects/postgres.js'];
const sourceHashes = Object.fromEntries(sourceFiles.map((file) => [file,
  createHash('sha256').update(readFileSync(new URL(`../${file}`, import.meta.url))).digest('hex')]));

const DOCUMENTS = 2000;
/** No statement this program sends carries more terms than this that nothing regroups. */
const MAX_TERMS = 400;
const SIZES = smoke ? [50, 200] : [50, 100, 200, 400];
const FOLDED_TERMS = 400;
/** After five executions the server may switch a prepared statement to a generic plan: measure after that. */
const WARMUP = 6;
const ITERATIONS = smoke ? 3 : 31;
const STATEMENT_TIMEOUT_MS = 30000;
assert.ok([...SIZES, FOLDED_TERMS].every((terms) => terms % 2 === 0 && terms <= MAX_TERMS),
  `a chain has an even number of terms, at most ${MAX_TERMS}`);

const key = { 'x-entity': { key: true } };
const MODEL = {
  $model: '0.1',
  collections: {
    people: {
      key: '/id',
      schema: { type: 'object', properties: { id: { type: 'string' }, city: { type: 'string' }, age: { type: 'integer' } } },
      indexes: [{ name: 'by_city', path: '$.city' }],
    },
    items: {
      key: '/id',
      schema: { type: 'object', properties: { id: { type: 'string' }, sku: { type: 'string' }, n: { type: 'integer' } } },
      indexes: [{ name: 'sku', path: '$.sku' }],
    },
  },
  entities: {
    Item: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string', ...key },
          sku: { type: 'string', 'x-entity': { index: true } },
          n: { type: 'integer', 'x-entity': { index: true } },
        },
      },
    },
  },
};

// document i of `items` and `Item` has sku `s<i>` and n = i, so the chain's first
// t / 2 skus select exactly the documents `i0`, `i2`, ...
const IDS = Array.from({ length: MAX_TERMS / 2 }, (_, i) => `s${i * 2}`);
/** The ids the first `terms` terms of either chain select, sorted. @param {number} terms */
const expectedIds = (terms) => IDS.slice(0, terms / 2).map((id) => `i${id.slice(1)}`).sort();
/** `terms / 2` pairs of an equality on `sku` and a range on `n`: nothing regroups it, so every term is a leaf. @param {number} terms */
const pairs = (terms) => ({ $or: IDS.slice(0, terms / 2).map((id, i) =>
  ({ $and: [{ $eq: ['$it.sku', id] }, { $ge: ['$it.n', i] }] })) });
/** `terms` terms of equalities on `sku` and rays on `n`: the planner regroups them to one list and one bound. @param {number} terms */
const mixedChain = (terms) => ({ $or: IDS.slice(0, terms / 2).flatMap((id, i) =>
  [{ $eq: ['$it.sku', id] }, { $gt: ['$it.n', 100000 + i] }]) });
/** @param {any} where */
const overItems = (where) => ({ $for: { it: '$[*]' }, $where: where, $return: '$it.id' });
/** @param {any} where */
const overItem = (where) => ({ $for: { it: '$.Item[*]' }, $where: where, $orderby: ['$it.id'], $return: '$it.id' });
const byCity = { $for: { it: '$[*]' }, $where: { $eq: ['$it.city', 'berlin'] }, $return: '$it.id' };
const byExternalCity = { $for: { it: '$[*]' }, $where: { $eq: ['$it.city', '$c'] }, $return: '$it.id' };

/** @param {number[]} values */
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = (/** @type {number} */ value) => Math.round(value * 1000) / 1000;
/** The host's load when the figures were taken, where the platform reports it. */
const loadAverage = () => {
  try { return readFileSync('/proc/loadavg', 'utf8').trim().split(' ').slice(0, 3).map(Number); }
  catch { return null; }
};
/** What `execute()` answered, as a list: one row answers as itself and none as nothing. @param {any} answer */
const rowsOf = (answer) => (Array.isArray(answer) ? [...answer] : answer === undefined ? [] : [answer]);
/** @param {any} answer */
const sortedRows = (answer) => rowsOf(answer).sort();
/** The id of the first reason a plan runs in the engine, or null for a native plan. @param {any} plan */
const reasonOf = (plan) => (plan.residual?.reasons?.length ? reasonId(plan.residual.reasons[0].reason) : null);
/** One timed call, in milliseconds. @param {() => Promise<any>} call */
async function timed(call) {
  const started = performance.now();
  const answer = await call();
  return { ms: performance.now() - started, answer };
}

const pg = (await import('pg')).default;
const admin = new pg.Client({ connectionString: endpoint });
await admin.connect();
const schema = `jaren_membership_bench_${randomUUID().replaceAll('-', '')}`;
let pool;
let store;
let evidence;
const loadBefore = loadAverage();
try {
  await admin.query(`SET statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
  const server = (await admin.query(`SELECT current_setting('server_version') AS version, current_setting('fsync') AS fsync,
    current_setting('synchronous_commit') AS synchronous_commit, current_setting('full_page_writes') AS full_page_writes,
    current_setting('jit') AS jit, current_setting('jit_above_cost') AS jit_above_cost,
    current_setting('jit_inline_above_cost') AS jit_inline_above_cost,
    current_setting('jit_optimize_above_cost') AS jit_optimize_above_cost,
    current_setting('plan_cache_mode') AS plan_cache_mode`)).rows[0];
  await admin.query(`CREATE SCHEMA "${schema}"`);
  // the planned statements name their tables bare: the server view below reads them from this schema
  await admin.query(`SET search_path TO "${schema}"`);
  pool = new pg.Pool({ connectionString: endpoint, max: 1, connectionTimeoutMillis: 5000 });
  const driver = postgresDriver(pool, { schema, statementTimeoutMs: STATEMENT_TIMEOUT_MS });
  const bound = driver.dialect.maxPredicateTerms;
  assert.ok(Number.isSafeInteger(bound) && bound > 0, 'the PostgreSQL dialect bounds the leaf predicates of a statement');
  store = await openStore(MODEL, { driver });
  assert.equal(store.capabilities.rowEstimates, true, 'the PostgreSQL driver reports row estimates');
  await store.transaction(async (/** @type {any} */ tx) => {
    for (let i = 0; i < DOCUMENTS; i++) {
      await tx.collection('people').put({ id: `p${i}`, city: i % 10 === 0 ? 'berlin' : `c${i % 50}`, age: i % 90 });
      await tx.collection('items').put({ id: `i${i}`, sku: `s${i}`, n: i });
      await tx.entity('Item').create({ id: `i${i}`, sku: `s${i}`, n: i });
    }
  });
  for (const table of ['people', 'items', 'Item']) await admin.query(`ANALYZE "${schema}"."${table}"`);
  const items = store.collection('items');
  const people = store.collection('people');
  const item = store.entity('Item');

  /**
   * The server's own account of one native statement, `ITERATIONS` times:
   * what the planner priced it at, what planning and execution took, and
   * whether the server compiled it.
   * @param {any} plan @param {number} rows
   */
  async function serverView(plan, rows) {
    assert.ok(plan.params.every((/** @type {any} */ param) => 'literal' in param), 'a measured statement binds literals only');
    const values = plan.params.map((/** @type {any} */ param) => param.literal);
    const planning = [], execution = [];
    let cost = 0, jit = false;
    for (let call = 0; call < ITERATIONS; call++) {
      const result = await admin.query({ text: `EXPLAIN (ANALYZE, FORMAT JSON) ${plan.sql}`, values });
      const text = result.rows[0]['QUERY PLAN'];
      const document = (typeof text === 'string' ? JSON.parse(text) : text)[0];
      assert.equal(document.Plan['Actual Rows'], rows, 'the server returns the rows the engine expects');
      planning.push(document['Planning Time']);
      execution.push(document['Execution Time']);
      cost = document.Plan['Total Cost'];
      if (document.JIT !== undefined) jit = true;
    }
    return { cost, planningMs: round(median(planning)), executionMs: round(median(execution)), jit };
  }

  /**
   * One chain as the store answers it and, where the plan is native, as the
   * engine alone answers it, called alternately so a drifting host moves both
   * alike. Every answer must be the rows the chain selects.
   * @param {string} label @param {() => any} build @param {number} terms @param {number} leaves
   */
  async function measureChain(label, build, terms, leaves) {
    const expected = expectedIds(terms);
    const plan = await items.explain(overItems(build()));
    const reason = reasonOf(plan);
    const native = plan.mode === 'native';
    assert.equal(native, leaves <= bound, `${label}: the plan is native exactly when the leaves are within the bound`);
    assert.equal(reason, native ? null : 'predicate.termBound', `${label}: a plan in the engine names the term bound`);
    const planned = [], engine = [];
    for (let call = 0; call < WARMUP + ITERATIONS; call++) {
      // a new document for every call, built before the clock starts
      const document = overItems(build());
      const first = await timed(() => items.execute(document));
      assert.deepEqual(sortedRows(first.answer), expected, `${label}: the planned answer differs from the rows the chain selects`);
      if (call >= WARMUP) planned.push(first.ms);
      if (!native) continue;
      const other = overItems(build());
      const second = await timed(() => items.execute(other, { pushdown: false }));
      assert.deepEqual(sortedRows(second.answer), expected, `${label}: the engine's answer differs from the rows the chain selects`);
      if (call >= WARMUP) engine.push(second.ms);
    }
    return { terms, leaves, mode: plan.mode, reason, boundValues: plan.params.length,
      statementChars: native ? plan.sql.length : null,
      rows: expected.length,
      ms: round(median(planned)), runs: planned.map(round),
      engineMs: native ? round(median(engine)) : null, engineRuns: native ? engine.map(round) : null,
      server: native ? await serverView(plan, expected.length) : null };
  }

  const chains = [];
  for (const terms of SIZES) chains.push(await measureChain(`${terms} unregrouped terms`, () => pairs(terms), terms, terms));
  const folded = await measureChain(`${FOLDED_TERMS} regrouped terms`, () => mixedChain(FOLDED_TERMS), FOLDED_TERMS, 2);
  assert.equal(folded.mode, 'native', 'a chain the planner regroups stays native');
  assert.equal(folded.boundValues, 2, 'a regrouped chain binds one list and one bound');

  /**
   * The planner's estimate for one statement against the rows it returns.
   * @param {string} label @param {string} form @param {() => Promise<any>} explain
   * @param {() => Promise<any>} run @param {number} actual @param {boolean} offered
   */
  async function estimate(label, form, explain, run, actual, offered) {
    const explained = await explain();
    const estimated = explained.budget.estimatedRows;
    if (offered) {
      assert.equal(estimated?.source, 'postgresql-planner', `${label}: the estimate names the planner`);
      assert.ok(Number.isFinite(estimated.rows) && estimated.rows >= 0, `${label}: the estimate is a row count`);
    }
    else assert.equal(estimated, 'unavailable', `${label}: no estimate is offered`);
    const rows = rowsOf(await run()).length;
    assert.equal(rows, actual, `${label}: the statement returns the rows the corpus expects`);
    return { label, form, estimatedRows: estimated, actualRows: rows };
  }
  // a chain past the bound has no native statement to price
  assert.ok(64 <= bound, 'the estimate corpus stays within the dialect\'s bound');
  const estimates = [];
  const cases = [
    ['collection `people`: `$eq` on an indexed member', 'collection', () => people.explain(byCity), () => people.execute(byCity), DOCUMENTS / 10, true],
    ...[8, 64].map((terms) => [`collection \`items\`: ${terms} unregrouped terms`, 'collection',
      () => items.explain(overItems(pairs(terms))), () => items.execute(overItems(pairs(terms))), terms / 2, true]),
    [`collection \`items\`: ${FOLDED_TERMS} regrouped terms`, 'collection',
      () => items.explain(overItems(mixedChain(FOLDED_TERMS))), () => items.execute(overItems(mixedChain(FOLDED_TERMS))), FOLDED_TERMS / 2, true],
    ...[8, 64].map((terms) => [`entity \`Item\`: ${terms} unregrouped terms`, 'entity',
      () => store.explain(overItem(pairs(terms))), () => store.execute(overItem(pairs(terms))), terms / 2, true]),
    [`entity \`Item\`: ${FOLDED_TERMS} regrouped terms`, 'entity',
      () => store.explain(overItem(mixedChain(FOLDED_TERMS))), () => store.execute(overItem(mixedChain(FOLDED_TERMS))), FOLDED_TERMS / 2, true],
    ...[8, 64].map((terms) => [`\`explainLoad\` of \`Item\`: ${terms} unregrouped terms`, 'load',
      () => item.explainLoad({ where: pairs(terms) }), () => item.load({ where: pairs(terms) }), terms / 2, true]),
    [`\`explainLoad\` of \`Item\`: ${FOLDED_TERMS} regrouped terms`, 'load',
      () => item.explainLoad({ where: mixedChain(FOLDED_TERMS) }), () => item.load({ where: mixedChain(FOLDED_TERMS) }), FOLDED_TERMS / 2, true],
    ['collection `people`: an external the call leaves unbound', 'collection',
      () => people.explain(byExternalCity), () => people.execute(byExternalCity, { externals: { c: 'berlin' } }), DOCUMENTS / 10, false],
    ['collection `people`: an external bound to the value', 'collection',
      () => people.explain(byExternalCity, { externals: { c: 'berlin' } }), () => people.execute(byExternalCity, { externals: { c: 'berlin' } }), DOCUMENTS / 10, true],
  ];
  for (const [label, form, explain, run, actual, offered] of cases) estimates.push(await estimate(label, form, explain, run, actual, offered));

  await store.close();
  assert.equal(driver.metrics().active, 0, 'closing the store leaves no session running');
  evidence = {
    format: 'jaren-postgres-membership/1', measuredAt: new Date().toISOString(),
    runtime: { node: process.versions.node,
      pg: JSON.parse(readFileSync(new URL('../node_modules/pg/package.json', import.meta.url), 'utf8')).version,
      platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, cpus: cpus().length,
      loadavg: { before: loadBefore, after: loadAverage() } },
    sourceHashes, postgres: server, documents: DOCUMENTS, statementTimeoutMs: STATEMENT_TIMEOUT_MS,
    warmup: WARMUP, iterations: ITERATIONS, bound, chains, folded, estimates,
    scope: 'One host, client and server on one machine, one pooled connection beside one administrative one. Each table holds the documents above and was analyzed before the first call. Milliseconds are the median wall-clock time of the calls above, after the warm-up calls: the statement\'s construction, the round trip, the server\'s work and the decoding of the rows, with no commit. The engine column runs the same chain with pushdown: false, which fetches the collection and filters it in the engine. The server\'s JIT settings are its own and are never changed; the server view is EXPLAIN (ANALYZE) of each native statement. An estimate is the planner\'s own and never a count. No production latency claim.',
  };
}
finally {
  await store?.close().catch(() => {});
  await pool?.end().catch(() => {});
  try { await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
  finally { await admin.end(); }
}

const ms = (/** @type {number} */ value) => value.toFixed(2);
const facts = evidence.postgres;
const load = evidence.runtime.loadavg;
console.log(`\nMembership chains over ${DOCUMENTS} documents — PostgreSQL ${facts.version}, jit=${facts.jit} (jit_above_cost=${facts.jit_above_cost}), `
  + `the median of ${ITERATIONS} calls after ${WARMUP} warm-up calls${smoke ? ' (smoke run)' : ''}`);
console.log(`  one statement carries at most ${evidence.bound} leaf predicates; host load ${load.before?.join(' ') ?? 'not reported'} before, `
  + `${load.after?.join(' ') ?? 'not reported'} after, on ${evidence.runtime.cpus} cores`);
console.log(`  ${'chain'.padEnd(26)}${'leaves'.padStart(7)}  ${'plan'.padEnd(34)}${'execute ms'.padStart(11)}${'engine ms'.padStart(11)}${'rows'.padStart(6)}  server`);
for (const [name, row] of [...evidence.chains.map((chain) => [`${chain.terms} unregrouped terms`, chain]), [`${evidence.folded.terms} regrouped terms`, evidence.folded]]) {
  const plan = row.mode === 'native' ? 'native' : `engine (${row.reason})`;
  const view = row.server === null ? ''
    : `cost ${row.server.cost}, plan ${ms(row.server.planningMs)} ms, run ${ms(row.server.executionMs)} ms, ${row.server.jit ? 'JIT compiled' : 'no JIT'}`;
  console.log(`  ${name.padEnd(26)}${String(row.leaves).padStart(7)}  ${plan.padEnd(34)}${ms(row.ms).padStart(11)}`
    + `${(row.engineMs === null ? 'same route' : ms(row.engineMs)).padStart(11)}${String(row.rows).padStart(6)}  ${view}`.trimEnd());
}
console.log(`\nRow estimates against the rows returned (${evidence.estimates.length} statements)`);
for (const row of evidence.estimates) {
  const estimated = row.estimatedRows === 'unavailable' ? 'unavailable' : String(row.estimatedRows.rows);
  console.log(`  ${row.label.padEnd(62)}${estimated.padStart(12)} estimated${String(row.actualRows).padStart(7)} actual`);
}

if (write) {
  writeFileSync(new URL('./postgres-membership-result.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
  console.log('\nwrote benchmark/postgres-membership-result.json');
}
else console.log(smoke ? '\nsmoke run: nothing was written' : '\nnot written: pass --write to record the figures');
