//@ts-check
/**
 * @file The PostgreSQL membership figures are derived from their committed
 * measurement, and the derivation refuses a measurement whose pinned sources
 * have moved. Nothing here measures anything: the fixtures are a synthetic
 * result and files that stand for the sources it pins, in a temporary root
 * that holds the real generator beside them.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { NS, runDerivation } from '../../scripts/lib/derive.js';

const KEY = 'postgres.membership';
const RESULT = 'benchmark/postgres-membership-result.json';
const DOCUMENT = 'packages/db/docs/POSTGRESQL.md';
const PINNED = ['benchmark/postgres-membership.js', 'packages/db/src/plan.js', 'packages/db/src/emit.js',
  'packages/db/src/query.js', 'packages/db/src/dialects/postgres.js'];
/** The bytes a fixture source holds. @param {string} file */
const sourceOf = (file) => `fixture of ${file}\n`;
const hashOf = (/** @type {string} */ text) => createHash('sha256').update(text).digest('hex');

/** The server view of one native statement. @param {number} cost @param {number} planningMs @param {number} executionMs */
const view = (cost, planningMs, executionMs) => ({ cost, planningMs, executionMs, jit: false });
/** A chain row: native rows carry the engine's time and the server's view. @param {any} row */
const chain = (row) => ({ reason: null, boundValues: row.leaves, statementChars: null, runs: [], engineRuns: null, ...row });

/** @returns {any} */
const report = () => ({
  format: 'jaren-postgres-membership/1', measuredAt: '2026-10-09T10:00:00.000Z',
  runtime: { node: '24.0.0', pg: '8.0.0', platform: 'test', arch: 'test', cpu: 'test', cpus: 8,
    loadavg: { before: [0.5, 0.4, 0.3], after: [0.25, 0.4, 0.3] } },
  sourceHashes: Object.fromEntries(PINNED.map((file) => [file, hashOf(sourceOf(file))])),
  postgres: { version: '17.0 (fixture)', fsync: 'on', synchronous_commit: 'on', full_page_writes: 'on', jit: 'on',
    jit_above_cost: '100000', jit_inline_above_cost: '500000', jit_optimize_above_cost: '500000', plan_cache_mode: 'auto' },
  documents: 2000, statementTimeoutMs: 30000, warmup: 6, iterations: 31, bound: 128,
  chains: [
    chain({ terms: 50, leaves: 50, mode: 'native', rows: 25, ms: 2.5, engineMs: 10, server: view(147.29, 0.2, 0.1) }),
    chain({ terms: 200, leaves: 200, mode: 'set', reason: 'predicate.termBound', rows: 100, ms: 20, engineMs: null, server: null }),
  ],
  folded: chain({ terms: 400, leaves: 2, mode: 'native', rows: 200, ms: 4, engineMs: 40, server: view(266.27, 0.1, 1.5) }),
  estimates: [
    { label: 'collection `people`: `$eq` on an indexed member', form: 'collection',
      estimatedRows: { rows: 200, source: 'postgresql-planner' }, actualRows: 200 },
    { label: 'collection `items`: 8 unregrouped terms', form: 'collection',
      estimatedRows: { rows: 1, source: 'postgresql-planner' }, actualRows: 4 },
    { label: 'collection `items`: 400 regrouped terms', form: 'collection',
      estimatedRows: { rows: 1332, source: 'postgresql-planner' }, actualRows: 200 },
    { label: 'collection `people`: an external the call leaves unbound', form: 'collection',
      estimatedRows: 'unavailable', actualRows: 200 },
    { label: 'collection `people`: an external bound to the value', form: 'collection',
      estimatedRows: { rows: 1, source: 'postgresql-planner' }, actualRows: 200 },
  ],
  scope: 'Synthetic fixture; no benchmark is run by this test.',
});

const EXPECTED = '\n\nMeasured 2026-10-09T10:00:00.000Z: PostgreSQL 17.0 (fixture) (jit=on, jit_above_cost=100000, '
  + 'jit_inline_above_cost=500000, jit_optimize_above_cost=500000), Node 24.0.0, pg 8.0.0; 2000 documents in each table, '
  + 'analyzed first; the median of 31 calls after 6 warm-up calls; host load (one-minute average) 0.50 before and 0.25 after, on 8 cores.\n\n'
  + 'One statement carries at most 128 leaf predicates. A chain of `$and` pairs (pairs) is not regrouped, so every term is a leaf; '
  + 'the same number of terms written as equalities on one member and ranges on another (regrouped) becomes one membership list and one bound.\n\n'
  + '| Chain | Terms | Leaf predicates | Plan | `execute()` ms | The engine alone, ms | Rows |\n'
  + '|---|---:|---:|---|---:|---:|---:|\n'
  + '| pairs | 50 | 50 | native | 2.50 | 10.00 | 25 |\n'
  + '| pairs | 200 | 200 | engine, `predicate.termBound` | 20.00 | same route | 100 |\n'
  + '| regrouped | 400 | 2 | native | 4.00 | 40.00 | 200 |\n\n'
  + 'The native statements under `EXPLAIN (ANALYZE)`: the planner priced them at 147.29 to 266.27 against jit_above_cost=100000, '
  + 'the server planned them in 0.10 to 0.20 ms and ran them in 0.10 to 1.50 ms, and its JIT compiled 0 of the 2.\n\n'
  + 'The planner\'s own estimate, `explain().budget.estimatedRows`, against the rows each statement returns:\n\n'
  + '| Statement | Estimated rows | Actual rows | Estimate / actual |\n'
  + '|---|---:|---:|---:|\n'
  + '| collection `people`: `$eq` on an indexed member | 200 | 200 | 1.00× |\n'
  + '| collection `items`: 8 unregrouped terms | 1 | 4 | 0.25× |\n'
  + '| collection `items`: 400 regrouped terms | 1332 | 200 | 6.66× |\n'
  + '| collection `people`: an external the call leaves unbound | unavailable | 200 | n/a |\n'
  + '| collection `people`: an external bound to the value | 1 | 200 | 0.005× |\n\n'
  + 'Synthetic fixture; no benchmark is run by this test.\n\n';

/**
 * A temporary root that holds the real generator and its helper beside the
 * files the result pins and a result, so the real file-reading entry point
 * runs without reading or changing any measured artifact.
 * @param {import('node:test').TestContext} t
 */
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'jaren-membership-facts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts/lib'), { recursive: true });
  mkdirSync(join(root, 'benchmark'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  for (const file of ['generate-postgres-facts.js', 'lib/measurement.js'])
    writeFileSync(join(root, 'scripts', file), readFileSync(new URL(`../../scripts/${file}`, import.meta.url)));
  for (const file of PINNED) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), sourceOf(file));
  }
  const write = (/** @type {any} */ value) => writeFileSync(join(root, RESULT), JSON.stringify(value));
  write(report());
  const { postgresFacts } = await import(pathToFileURL(join(root, 'scripts/generate-postgres-facts.js')).href);
  const facts = postgresFacts.facts();
  return {
    root, write, facts,
    render: () => facts[KEY](),
    /** A registry over one document that carries only this fact. */
    registry: { name: 'membership fixture', docs: () => [DOCUMENT], facts: () => ({ [KEY]: facts[KEY] }) },
    document: () => readFileSync(join(root, DOCUMENT), 'utf8'),
  };
}

describe('the membership fact', () => {
  it('renders the bound, each chain\'s plan and time, the regrouped chain, the server\'s account and the estimates exactly', async (t) => {
    const f = await fixture(t);
    assert.equal(f.render(), EXPECTED);
  });

  it('renders the bound the result recorded and counts the statements the server compiled', async (t) => {
    const f = await fixture(t);
    const changed = report();
    changed.bound = 64;
    changed.chains[0].server.jit = true;
    f.write(changed);
    const text = f.render();
    assert.match(text, /^One statement carries at most 64 leaf predicates\./m);
    assert.match(text, /and its JIT compiled 1 of the 2\.$/m);
  });

  it('leaves the server\'s account out when no statement was native, and never divides by no rows', async (t) => {
    const f = await fixture(t);
    const changed = report();
    changed.chains = [changed.chains[1]];
    changed.folded = chain({ terms: 400, leaves: 2, mode: 'set', reason: 'predicate.termBound', rows: 200, ms: 4, engineMs: null, server: null });
    changed.estimates[0].actualRows = 0;
    f.write(changed);
    const text = f.render();
    assert.doesNotMatch(text, /EXPLAIN \(ANALYZE\)/);
    assert.match(text, /\| collection `people`: `\$eq` on an indexed member \| 200 \| 0 \| n\/a \|/);
  });

  it('renders host load that was not reported as such', async (t) => {
    const f = await fixture(t);
    const changed = report();
    changed.runtime.loadavg = { before: null, after: null };
    f.write(changed);
    assert.match(f.render(), /host load \(one-minute average\) not reported before and not reported after, on 8 cores\./);
  });

  it('refuses a result that moved from any source it pins, naming the source', async (t) => {
    const f = await fixture(t);
    for (const file of PINNED) {
      writeFileSync(join(f.root, file), 'different\n');
      assert.throws(f.render, { message: `PostgreSQL evidence drift in postgres-membership-result.json: ${file}; rerun its qualification command` });
      writeFileSync(join(f.root, file), sourceOf(file));
      assert.equal(f.render(), EXPECTED);
    }
  });

  it('fails on a missing result or a missing pinned source, and refuses another report format', async (t) => {
    const f = await fixture(t);
    rmSync(join(f.root, PINNED[1]));
    assert.throws(f.render, { code: 'ENOENT' });
    writeFileSync(join(f.root, PINNED[1]), sourceOf(PINNED[1]));
    for (const change of [(/** @type {any} */ value) => { value.format = 'jaren-postgres-sessions/1'; },
      (/** @type {any} */ value) => { delete value.format; }]) {
      const value = report();
      change(value);
      f.write(value);
      assert.throws(f.render, /is a (?:jaren-postgres-sessions\/1|undefined) report, expected jaren-postgres-membership\/1/);
    }
    rmSync(join(f.root, RESULT));
    assert.throws(f.render, { code: 'ENOENT' });
  });
});

describe('docs:check over the membership span', () => {
  const span = `<!--${NS}:${KEY}-->\n\n<!--/${NS}-->`;
  /** A root whose document carries the span with no derived text yet. @param {import('node:test').TestContext} t */
  async function withDocument(t) {
    const f = await fixture(t);
    mkdirSync(dirname(join(f.root, DOCUMENT)), { recursive: true });
    writeFileSync(join(f.root, DOCUMENT), `Before the figures.\n\n${span}\n\nAfter the figures.\n`);
    return f;
  }

  it('fails until the span is derived, derives it once, and then agrees', async (t) => {
    const f = await withDocument(t);
    const empty = f.document();
    const before = runDerivation({ root: f.root, registries: [f.registry], check: true });
    assert.equal(before.code, 1);
    assert.equal(before.drift.length, 1);
    assert.match(before.drift[0], new RegExp(`${KEY}.*no longer agrees`));
    assert.equal(f.document(), empty, 'a check rewrites nothing');
    const written = runDerivation({ root: f.root, registries: [f.registry] });
    assert.equal(written.code, 0);
    assert.deepEqual(written.rewritten, [DOCUMENT]);
    assert.deepEqual(written.seen, [KEY]);
    assert.equal(f.document(), `Before the figures.\n\n<!--${NS}:${KEY}-->${EXPECTED}<!--/${NS}-->\n\nAfter the figures.\n`);
    const after = runDerivation({ root: f.root, registries: [f.registry], check: true });
    assert.equal(after.code, 0);
    assert.deepEqual(after.drift, []);
  });

  it('fails, and rewrites nothing, once a source the result pins has changed', async (t) => {
    const f = await withDocument(t);
    assert.equal(runDerivation({ root: f.root, registries: [f.registry] }).code, 0);
    const baked = f.document();
    for (const file of PINNED) {
      writeFileSync(join(f.root, file), 'moved on\n');
      for (const check of [true, false]) {
        const report = runDerivation({ root: f.root, registries: [f.registry], check });
        assert.equal(report.code, 1, `${file} (check: ${check})`);
        assert.deepEqual(report.rewritten, []);
        assert.deepEqual(report.seen, []);
        assert.equal(report.unanswered.length, 1);
        assert.equal(report.unanswered[0], `${DOCUMENT}: ${KEY}: resolver threw — PostgreSQL evidence drift in postgres-membership-result.json: ${file}; rerun its qualification command`);
      }
      assert.equal(f.document(), baked);
      writeFileSync(join(f.root, file), sourceOf(file));
    }
    assert.equal(runDerivation({ root: f.root, registries: [f.registry], check: true }).code, 0);
  });
});
