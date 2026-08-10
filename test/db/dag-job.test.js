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
