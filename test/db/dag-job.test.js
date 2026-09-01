//@ts-check
/**
 * @file The composition (JOBS-FORMAT §7): `createDagJobRunner` wires
 * checkpointed DAG runs to queue jobs with the flow engine INJECTED —
 * the manifest and the import graph of `@jarenjs/db` name
 * `@jarenjs/flow` nowhere, asserted here file by file. Completion is
 * transactional: the DAG result and the job's `done` land together or
 * not at all; a mid-run failure leaves the job leased with its
 * checkpoint rows intact for the resume.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { compileDag } from '@jarenjs/flow';
import { openStore, createDagJobRunner, JOBS_TABLE } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { DatabaseSync } from 'node:sqlite';
import { tempDbPath } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    x: { schema: { type: 'object', properties: { id: { type: 'string' } } },
      key: '/id', indexes: [] },
  },
};

const REPORT_DAG = {
  $dag: '0.1',
  nodes: {
    in: { kind: 'input' },
    gather: { kind: 'task', run: 'gather', checkpoint: true },
    render: { kind: 'jslt',
      stylesheet: [{ match: '$', body: { report: '$.rows' } }] },
    out: { kind: 'output' },
  },
  edges: [
    { from: 'in', to: 'gather' },
    { from: 'gather', to: 'render' },
    { from: 'render', to: 'out' },
  ],
};

describe('the injection boundary', () => {
  it('@jarenjs/db names @jarenjs/flow nowhere — manifest and import graph', () => {
    const manifest = JSON.parse(fs.readFileSync(
      new URL('../../packages/db/package.json', import.meta.url), 'utf8'));
    for (const section of ['dependencies', 'peerDependencies', 'devDependencies']) {
      assert.strictEqual(manifest[section]?.['@jarenjs/flow'], undefined, section);
    }
    const srcDir = new URL('../../packages/db/src/', import.meta.url);
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) walk(new URL(`${entry.name}/`, dir));
        else if (entry.name.endsWith('.js')) {
          // a file URL's `pathname` is not a filesystem path — on Windows
          // it carries a leading slash before the drive letter, which
          // `path.join` turns into `C:\C:\…`
          const text = fs.readFileSync(fileURLToPath(new URL(entry.name, dir)), 'utf8');
          assert.ok(!/(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]@jarenjs\/flow/.test(text),
            `${entry.name} must not import @jarenjs/flow`);
        }
      }
    };
    walk(srcDir);
  });

  it('misuse refuses loudly: no jobs, no engine, no documents', async () => {
    const plain = await openStore(MODEL, { driver: nodeDriver() });
    assert.throws(() => createDagJobRunner(plain,
      { compileDag, documents: { k: REPORT_DAG } }), /without \{ jobs \}/);
    await plain.close();
    const store = await openStore(MODEL, { driver: nodeDriver(), jobs: true });
    assert.throws(() => createDagJobRunner(store,
      /** @type {any} */ ({ documents: { k: REPORT_DAG } })), /compileDag/);
    assert.throws(() => createDagJobRunner(store,
      /** @type {any} */ ({ compileDag, documents: {} })), /documents/);
    await store.close();
  });
});

describe('the composition end to end', () => {
  it('enqueue → worker → checkpointed run → transactional done with the result', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), jobs: true });
    const gathered = [];
    const runner = createDagJobRunner(store, {
      compileDag,
      documents: { 'sync-report': REPORT_DAG },
      tasks: {
        gather: ({ input }) => {
          gathered.push(input.day);
          return { rows: [input.day, 'x'] };
        },
      },
      pollInterval: 10,
    });
    runner.start();
    const id = await store.jobs.enqueue('sync-report',
      { input: { day: 'mon' } }, { id: 'r1' });
    const deadline = Date.now() + 5_000;
    for (;;) {
      const job = await store.jobs.get(id);
      if (job.state === 'done') break;
      assert.ok(Date.now() < deadline, `stalled in ${job.state}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const job = await store.jobs.get(id);
    assert.deepStrictEqual(job.result, { report: ['mon', 'x'] },
      'the DAG output IS the job result');
    assert.deepStrictEqual(gathered, ['mon']);
    assert.strictEqual(runner.stats().completions, 1);
    await runner.stop();
    await store.close();
  });

  it('a failing run leaves NEITHER result nor done — and keeps the checkpoints', async () => {
    const clock = (() => {
      let at = 9_000_000;
      const fn = () => at;
      fn.advance = (ms) => { at += ms; };
      return fn;
    })();
    const store = await openStore(MODEL,
      { driver: nodeDriver(), jobs: { now: clock, random: () => 0.5 } });
    let crash = true;
    const runner = createDagJobRunner(store, {
      compileDag,
      documents: { r: {
        $dag: '0.1',
        nodes: {
          in: { kind: 'input' },
          a: { kind: 'task', run: 'a', checkpoint: true },
          b: { kind: 'task', run: 'b' },
          out: { kind: 'output' },
        },
        edges: [
          { from: 'in', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'out' }],
      } },
      tasks: {
        a: () => ({ step: 'a done' }),
        b: ({ input }) => {
          if (crash) throw new Error('downstream down');
          return input;
        },
      },
      pollInterval: 10,
    });
    runner.start();
    await store.jobs.enqueue('r', { input: {} }, { id: 'j' });
    const failedBy = Date.now() + 5_000;
    for (;;) {
      const job = await store.jobs.get('j');
      if (job.state === 'failed') break;
      assert.ok(Date.now() < failedBy, `stalled in ${job.state}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    let job = await store.jobs.get('j');
    assert.strictEqual(job.result, null, 'no result on failure');
    assert.match(String(job.lastError), /downstream down/);

    crash = false;
    clock.advance(10_000); // past the backoff
    const doneBy = Date.now() + 5_000;
    for (;;) {
      job = await store.jobs.get('j');
      if (job.state === 'done') break;
      assert.ok(Date.now() < doneBy, `stalled in ${job.state}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepStrictEqual(job.result, { step: 'a done' });
    assert.strictEqual(job.attempts, 2, 'the retry resumed from the checkpoint');
    await runner.stop();
    await store.close();
  });

  it('done-and-result are ONE write: the raw row agrees with both or neither', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const store = await openStore(MODEL,
        { driver: nodeDriver(), path: dbPath, jobs: true });
      await store.jobs.enqueue('r', { input: { n: 1 } }, { id: 'j' });
      const claimed = await store.jobs.claim({ kinds: ['r'], owner: 'w' });
      const dag = compileDag(REPORT_DAG, {
        checkpoint: store.jobs.checkpointsFor(claimed),
        tasks: { gather: ({ input }) => ({ rows: [input.n] }) },
      });
      await dag.run(claimed.payload.input, { runId: claimed.id });
      const raw = new DatabaseSync(dbPath);
      const row = /** @type {any} */ (raw.prepare(
        `SELECT state, result FROM "${JOBS_TABLE}" WHERE id='j'`).get());
      raw.close();
      assert.strictEqual(row.state, 'done');
      assert.deepStrictEqual(JSON.parse(row.result), { report: [1] });
      await store.close();
    }
    finally {
      cleanup();
    }
  });
});

// ————— the runner over the fence —————

/** Resolve once the predicate holds, or fail the test at the deadline. */
const until = async (predicate, what, deadlineMs = 5_000) => {
  const stop = Date.now() + deadlineMs;
  for (;;) {
    if (predicate()) return;
    assert.ok(Date.now() < stop, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/** A two-task DAG, both checkpointed, so a resume has something to
 * restore and something still to do. */
const TWO_STEP_DAG = {
  $dag: '0.1',
  nodes: {
    in: { kind: 'input' },
    first: { kind: 'task', run: 'first', checkpoint: true },
    second: { kind: 'task', run: 'second', checkpoint: true },
    out: { kind: 'output' },
  },
  edges: [
    { from: 'in', to: 'first' },
    { from: 'first', to: 'second' },
    { from: 'second', to: 'out' },
  ],
};

const rowsOf = (dbPath, jobId) => {
  const raw = new DatabaseSync(dbPath);
  const rows = raw.prepare(
    'SELECT node_id, value, generation FROM "_jaren_job_checkpoints" '
    + 'WHERE run_id = ? ORDER BY node_id').all(jobId);
  raw.close();
  return rows;
};

describe('the DAG runner over the fence', () => {
  it('shutdown_signal_and_grace_reach_every_task', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), jobs: true });
    const seen = [];
    let reached = () => {};
    const arrived = new Promise((resolve) => { reached = resolve; });
    const runner = createDagJobRunner(store, {
      compileDag,
      documents: { slow: REPORT_DAG },
      tasks: {
        // the DAG hands a task its signal as the second argument; it is
        // the run's, which is the handler's, which is the worker's
        // shutdown and this attempt's lease
        gather: async (props, signal) => {
          seen.push('started');
          reached();
          await new Promise((resolve) => {
            signal.addEventListener('abort', () => resolve(undefined), { once: true });
          });
          seen.push('aborted');
          throw new Error('wound up');
        },
      },
      pollInterval: 5,
    });
    runner.start();
    await store.jobs.enqueue('slow', { input: { day: 'mon' } }, { id: 'r' });
    await arrived;

    const stopped = await runner.stop({ graceMs: 2_000 });
    assert.deepStrictEqual(seen, ['started', 'aborted'],
      'every task saw the shutdown, inside the grace period');
    assert.strictEqual(stopped.drained, true, 'and the loop drained because of it');
    await store.close();
  });

  it('a resume whose workflow revision changed is a coded refusal naming it', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const open = () => openStore(MODEL,
        { driver: nodeDriver(), path: dbPath, jobs: true });
      // the first attempt checkpoints `first`, then fails in `second`
      const storeA = await open();
      let crash = true;
      const outcomesA = [];
      const runnerA = createDagJobRunner(storeA, {
        compileDag,
        documents: { two: TWO_STEP_DAG },
        tasks: {
          first: () => ({ n: 1 }),
          second: () => { if (crash) throw new Error('mid-run'); return { n: 2 }; },
        },
        pollInterval: 5,
        onOutcome: (event) => outcomesA.push(event),
      });
      runnerA.start();
      await storeA.jobs.enqueue('two', { input: { day: 'mon' } }, { id: 'r' });
      await until(() => outcomesA.some((event) => event.outcome === 'failed'),
        'the mid-run failure');
      await runnerA.stop();
      await storeA.close();
      assert.deepStrictEqual(rowsOf(dbPath, 'r').map((row) => row.node_id).sort(),
        ['identity', 'first'], 'the identity rides with the checkpoints');

      // a DIFFERENT workflow now claims the same run
      const storeB = await open();
      const failures = [];
      const edited = { ...TWO_STEP_DAG,
        nodes: { ...TWO_STEP_DAG.nodes, first: { kind: 'task', run: 'first' } } };
      const runnerB = createDagJobRunner(storeB, {
        compileDag,
        documents: { two: edited },
        tasks: { first: () => ({ n: 1 }), second: () => ({ n: 2 }) },
        pollInterval: 5,
        onOutcome: (event) => { if (event.outcome === 'failed') failures.push(event); },
      });
      runnerB.start();
      await until(() => failures.length > 0, 'the resume refusal');
      assert.match(failures[0].reason, /cannot resume/);
      assert.match(failures[0].reason, /the workflow/);
      await runnerB.stop();
      assert.strictEqual((await storeB.jobs.get('r')).state, 'failed',
        'refused, not silently answered from incompatible checkpoints');
      await storeB.close();
    }
    finally { cleanup(); }
  });

  it('a resume whose INPUT changed is refused, naming the input', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const open = () => openStore(MODEL,
        { driver: nodeDriver(), path: dbPath, jobs: true });
      const storeA = await open();
      let crash = true;
      const outcomes = [];
      const runner = (store, sink) => createDagJobRunner(store, {
        compileDag,
        documents: { two: TWO_STEP_DAG },
        tasks: {
          first: () => ({ n: 1 }),
          second: () => { if (crash) throw new Error('mid-run'); return { n: 2 }; },
        },
        pollInterval: 5,
        onOutcome: (event) => sink.push(event),
      });
      const runnerA = runner(storeA, outcomes);
      runnerA.start();
      await storeA.jobs.enqueue('two', { input: { day: 'mon' } }, { id: 'r' });
      await until(() => outcomes.some((event) => event.outcome === 'failed'), 'the failure');
      await runnerA.stop();
      // the same run id, a different input — the checkpoints describe a
      // computation over 'mon', and nobody asked for that answer here
      const raw = new DatabaseSync(dbPath);
      raw.prepare(`UPDATE "${JOBS_TABLE}" SET payload = ?, state = 'pending',
        run_at = 0, lease_until = NULL WHERE id = 'r'`)
        .run(JSON.stringify({ input: { day: 'tue' } }));
      raw.close();
      await storeA.close();

      const storeB = await open();
      crash = false;
      const later = [];
      const runnerB = runner(storeB, later);
      runnerB.start();
      await until(() => later.some((event) => event.outcome === 'failed'), 'the refusal');
      const refusal = later.find((event) => event.outcome === 'failed');
      assert.match(refusal.reason, /cannot resume/);
      assert.match(refusal.reason, /the input/);
      await runnerB.stop();
      await storeB.close();
    }
    finally { cleanup(); }
  });

  it('two-run check: an unchanged resume changes nothing, prunes nothing, reports zero', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const open = () => openStore(MODEL,
        { driver: nodeDriver(), path: dbPath, jobs: true });
      const ran = [];
      let crash = true;
      const build = (store, sink) => createDagJobRunner(store, {
        compileDag,
        documents: { two: TWO_STEP_DAG },
        tasks: {
          first: () => { ran.push('first'); return { n: 1 }; },
          second: () => {
            ran.push('second');
            if (crash) throw new Error('mid-run');
            return { n: 2 };
          },
        },
        pollInterval: 5,
        onOutcome: (event) => sink.push(event),
      });

      const storeA = await open();
      const outcomes = [];
      const runnerA = build(storeA, outcomes);
      runnerA.start();
      await storeA.jobs.enqueue('two', { input: { day: 'mon' } }, { id: 'r' });
      await until(() => outcomes.some((event) => event.outcome === 'failed'), 'the failure');
      await runnerA.stop();
      await storeA.close();
      assert.deepStrictEqual(ran, ['first', 'second']);
      const before = rowsOf(dbPath, 'r');
      assert.deepStrictEqual(before.map((row) => row.node_id).sort(),
        ['identity', 'first']);

      // the SAME workflow, the SAME input, resumed: `first` is restored
      // rather than run, nothing is written and nothing is pruned
      const storeB = await open();
      crash = true;
      ran.length = 0;
      const laterOutcomes = [];
      const runnerB = build(storeB, laterOutcomes);
      runnerB.start();
      await until(() => laterOutcomes.some((event) => event.outcome === 'failed'),
        'the second attempt');
      await runnerB.stop();
      await storeB.close();

      assert.deepStrictEqual(ran, ['second'],
        'the restored node ran zero times the second time round');
      assert.deepStrictEqual(rowsOf(dbPath, 'r'), before,
        'no row written, no row pruned, no generation moved');
    }
    finally { cleanup(); }
  });

  it('stale_dag_attempt_cannot_delete_a_newer_attempts_checkpoints', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      let at = 5_000_000;
      const clock = () => at;
      const store = await openStore(MODEL,
        { driver: nodeDriver(), path: dbPath, jobs: { now: clock } });
      await store.jobs.enqueue('two', { input: { day: 'mon' } }, { id: 'r' });

      // attempt 1 checkpoints, then its lease lapses under it
      const first = await store.jobs.claim({ kinds: ['two'], owner: 'w', leaseMs: 100 });
      store.jobs.checkpointsFor(first).save('r', 'first', { by: 1 });
      at += 10_000;
      const second = await store.jobs.claim({ kinds: ['two'], owner: 'w' });
      const live = store.jobs.checkpointsFor(second);
      live.save('r', 'second', { by: 2 });

      // the corpse tries to finish the run transactionally, which is the
      // one call that would prune
      assert.throws(() => store.jobs.checkpointsFor(first).complete('r', { done: 1 }),
        (e) => /** @type {any} */ (e).code === 'JD2066');
      assert.deepStrictEqual(live.load('r'),
        { values: { first: { by: 1 }, second: { by: 2 } } },
        "the live attempt's checkpoints are all still there");

      // and the live attempt's own completion does prune them
      live.complete('r', { done: 2 });
      assert.strictEqual((await store.jobs.get('r')).state, 'done');
      await store.close();
      assert.deepStrictEqual(rowsOf(dbPath, 'r'), []);
    }
    finally { cleanup(); }
  });

  it('no in-flight attempt map is keyed by owner', () => {
    for (const name of ['jobs.js', 'dag-job.js']) {
      const source = fs.readFileSync(fileURLToPath(
        new URL(`../../packages/db/src/${name}`, import.meta.url)), 'utf8');
      // a Map or Set of in-flight work whose key is the owner cannot
      // tell two attempts of one job apart — which is the whole defect
      assert.ok(!/\.set\(\s*owner\b/.test(source), `${name}: an owner-keyed set`);
      assert.ok(!/\.get\(\s*owner\b/.test(source), `${name}: an owner-keyed get`);
      assert.ok(!/\bowner\s*\]\s*=/.test(source), `${name}: an owner-keyed index`);
    }
    const jobs = fs.readFileSync(fileURLToPath(
      new URL('../../packages/db/src/jobs.js', import.meta.url)), 'utf8');
    assert.match(jobs, /attempts\.set\(job\.lease\.token,/,
      'the worker files an attempt under its fence token');
  });
});
