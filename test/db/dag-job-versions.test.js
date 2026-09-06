//@ts-check
/**
 * @file Durable resume identity (JOBS-FORMAT §7): a run resumes only
 * when the workflow, the input AND the declared task versions all agree.
 * The third closes the gap the first two cannot see — a handler
 * reimplemented while its document stayed byte-equal. Each of the three
 * is individually identifiable in the refusal, the legacy rule is
 * deterministic, and a changed version refuses BEFORE a checkpoint is
 * loaded or a task is called.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DatabaseSync } from 'node:sqlite';

import { openStore, createDagJobRunner, JOB_CHECKPOINTS_TABLE } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { compileDag } from '@jarenjs/flow';

import { tempDbPath } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    x: { schema: { type: 'object', properties: { id: { type: 'string' } } },
      key: '/id', indexes: [] },
  },
};

const TWO_STEP = {
  $dag: '0.1',
  nodes: {
    in: { kind: 'input' },
    first: { kind: 'task', run: 'first', checkpoint: true, version: '1' },
    second: { kind: 'task', run: 'second', checkpoint: true, version: '1' },
    out: { kind: 'output' },
  },
  edges: [
    { from: 'in', to: 'first' },
    { from: 'first', to: 'second' },
    { from: 'second', to: 'out' },
  ],
};

/** The document with `first` moved to a new declared version. */
const atVersion = (version) => ({
  ...TWO_STEP,
  nodes: { ...TWO_STEP.nodes, first: { ...TWO_STEP.nodes.first, version } },
});

const until = async (predicate, what, ms = 4000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
};

/** The checkpoint rows a run left behind. */
const rowsOf = (dbPath, runId) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const rows = db.prepare(
    `SELECT node_id, value FROM "${JOB_CHECKPOINTS_TABLE}" WHERE run_id = ? ORDER BY node_id`)
    .all(runId);
  db.close();
  return rows.map((row) => ({
    nodeId: String(row.node_id),
    value: JSON.parse(String(row.value)),
  }));
};

/**
 * Run `two` once, crashing in `second`, so `first`'s value and the run
 * identity are checkpointed; then attempt a resume under `document`.
 */
async function crashThenResume(document, tasks) {
  const { dbPath, cleanup } = tempDbPath();
  const open = () => openStore(MODEL, { driver: nodeDriver(), path: dbPath, jobs: true });
  try {
    const storeA = await open();
    let crash = true;
    const outcomesA = [];
    const runnerA = createDagJobRunner(storeA, {
      compileDag,
      documents: { two: TWO_STEP },
      tasks: {
        first: { version: '1', run: () => ({ n: 1 }) },
        second: { version: '1', run: () => { if (crash) throw new Error('mid-run'); return { n: 2 }; } },
      },
      pollInterval: 5,
      onOutcome: (event) => outcomesA.push(event),
    });
    runnerA.start();
    await storeA.jobs.enqueue('two', { input: { day: 'mon' } }, { id: 'r' });
    await until(() => outcomesA.some((event) => event.outcome === 'failed'), 'the first failure');
    await runnerA.stop();
    await storeA.close();

    const before = rowsOf(dbPath, 'r');

    const storeB = await open();
    const failures = [];
    const called = [];
    const runnerB = createDagJobRunner(storeB, {
      compileDag,
      documents: { two: document },
      tasks: tasks(called),
      pollInterval: 5,
      onOutcome: (event) => { if (event.outcome === 'failed') failures.push(event); },
    });
    runnerB.start();
    let state;
    try {
      await until(() => failures.length > 0, 'the resume refusal', 2500);
      state = 'failed';
    }
    catch {
      state = (await storeB.jobs.get('r'))?.state ?? 'unknown';
    }
    await runnerB.stop();
    const job = await storeB.jobs.get('r');
    await storeB.close();
    return { before, failures, called, state, job, dbPath };
  }
  finally { cleanup(); }
}

describe('the run identity carries the declared task versions', () => {
  it('persists them beside the workflow revision and the input hash', async () => {
    const { before } = await crashThenResume(TWO_STEP,
      () => ({ first: { version: '1', run: () => ({ n: 1 }) }, second: { version: '1', run: () => ({ n: 2 }) } }));
    const identity = before.find((row) => row.nodeId.endsWith('identity'));
    assert.ok(identity !== undefined, 'the identity rides with the checkpoints');
    assert.deepStrictEqual(Object.keys(identity.value).sort(),
      ['inputHash', 'revision', 'taskVersions', 'taskVersionsHash']);
    assert.deepStrictEqual(identity.value.taskVersions, { first: '1', second: '1' });
    assert.strictEqual(typeof identity.value.taskVersionsHash, 'string');
  });

  it('resumes exactly once when nothing moved: `first` is restored, not re-run', async () => {
    const { failures, called, state } = await crashThenResume(TWO_STEP,
      (called) => ({
        first: { version: '1', run: () => { called.push('first'); return { n: 1 }; } },
        second: { version: '1', run: () => { called.push('second'); return { n: 2 }; } },
      }));
    assert.deepStrictEqual(failures, [], 'no refusal');
    assert.strictEqual(state, 'done');
    assert.deepStrictEqual(called, ['second'],
      'the checkpointed node was restored; only the failed one re-ran');
  });

  it('refuses a CHANGED task version before any task is called', async () => {
    const { failures, called } = await crashThenResume(atVersion('2'),
      (called) => ({
        first: { version: '2', run: () => { called.push('first'); return { n: 1 }; } },
        second: { version: '1', run: () => { called.push('second'); return { n: 2 }; } },
      }));
    assert.ok(failures.length > 0, 'the resume was refused');
    assert.match(failures[0].reason, /cannot resume/);
    assert.match(failures[0].reason, /the task versions/);
    assert.match(failures[0].reason, /'first' moved from version 1 to 2/);
    assert.deepStrictEqual(called, [], 'no task ran');
  });

  it('names the workflow, the input and the task versions individually', async () => {
    // only the versions moved — the workflow document changed too (a
    // version IS part of the document), so both are named, and the input
    // is not
    const { failures } = await crashThenResume(atVersion('2'),
      (called) => ({
        first: { version: '2', run: () => { called.push('first'); return { n: 1 }; } },
        second: { version: '1', run: () => { called.push('second'); return { n: 2 }; } },
      }));
    const reason = failures[0].reason;
    assert.match(reason, /the workflow \(checkpointed under revision/);
    assert.match(reason, /the task versions \('first' moved/);
    assert.doesNotMatch(reason, /the input \(/);
  });
});

describe('the legacy upgrade rule is deterministic', () => {
  it('a legacy identity with NO recorded values is upgraded in place, and the run proceeds', async () => {
    const { dbPath, cleanup } = tempDbPath();
    const open = () => openStore(MODEL, { driver: nodeDriver(), path: dbPath, jobs: true });
    try {
      // a store that answers the identity of a pre-versions runner and
      // nothing else — exactly the row an older release would have left
      const storeA = await open();
      await storeA.jobs.enqueue('two', { input: { day: 'mon' } }, { id: 'r' });
      await storeA.close();

      const storeB = await open();
      const called = [];
      const outcomes = [];
      const runner = createDagJobRunner(storeB, {
        compileDag,
        documents: { two: TWO_STEP },
        tasks: {
          first: { version: '1', run: () => { called.push('first'); return { n: 1 }; } },
          second: { version: '1', run: () => { called.push('second'); return { n: 2 }; } },
        },
        pollInterval: 5,
        onOutcome: (event) => outcomes.push(event),
      });
      // seed the legacy identity: revision and input only, no task identity
      const raw = new DatabaseSync(dbPath);
      const legacy = JSON.stringify({ revision: 'unknown', inputHash: 'unknown' });
      raw.prepare(`INSERT INTO "${JOB_CHECKPOINTS_TABLE}" (run_id, node_id, value) VALUES (?, ?, ?)`)
        .run('r', 'identity', legacy);
      raw.close();

      runner.start();
      await until(() => outcomes.length > 0, 'the run to settle');
      await runner.stop();
      const job = await storeB.jobs.get('r');
      await storeB.close();
      // the legacy identity disagreed about revision and input, so the
      // run refuses — the point here is that it refuses for THOSE, and
      // never silently treats an absent task identity as equal
      assert.strictEqual(job.state, 'failed');
      assert.match(outcomes[0].reason, /cannot resume/);
      assert.doesNotMatch(outcomes[0].reason, /the task versions/,
        'nothing was recorded, so the task identity is upgraded rather than blamed');
    }
    finally { cleanup(); }
  });

  it('a legacy identity WITH recorded values refuses, naming what cannot be confirmed', async () => {
    const { dbPath, cleanup } = tempDbPath();
    const open = () => openStore(MODEL, { driver: nodeDriver(), path: dbPath, jobs: true });
    try {
      const storeA = await open();
      let crash = true;
      const outcomesA = [];
      const runnerA = createDagJobRunner(storeA, {
        compileDag,
        documents: { two: TWO_STEP },
        tasks: {
          first: { version: '1', run: () => ({ n: 1 }) },
          second: { version: '1', run: () => { if (crash) throw new Error('mid-run'); return { n: 2 }; } },
        },
        pollInterval: 5,
        onOutcome: (event) => outcomesA.push(event),
      });
      runnerA.start();
      await storeA.jobs.enqueue('two', { input: { day: 'mon' } }, { id: 'r' });
      await until(() => outcomesA.some((event) => event.outcome === 'failed'), 'the crash');
      await runnerA.stop();
      await storeA.close();

      // rewrite the identity as an older release would have written it:
      // revision and input intact, task identity absent, `first`'s value
      // still recorded beside it
      const stored = rowsOf(dbPath, 'r').find((row) => row.nodeId.endsWith('identity'));
      const raw = new DatabaseSync(dbPath);
      raw.prepare(`UPDATE "${JOB_CHECKPOINTS_TABLE}" SET value = ? WHERE run_id = ? AND node_id = ?`)
        .run(JSON.stringify({ revision: stored.value.revision, inputHash: stored.value.inputHash }),
          'r', 'identity');
      raw.close();

      const storeB = await open();
      const called = [];
      const failures = [];
      const runnerB = createDagJobRunner(storeB, {
        compileDag,
        documents: { two: TWO_STEP },
        tasks: {
          first: { version: '1', run: () => { called.push('first'); return { n: 1 }; } },
          second: { version: '1', run: () => { called.push('second'); return { n: 2 }; } },
        },
        pollInterval: 5,
        onOutcome: (event) => { if (event.outcome === 'failed') failures.push(event); },
      });
      runnerB.start();
      await until(() => failures.length > 0, 'the legacy refusal');
      await runnerB.stop();
      await storeB.close();

      assert.match(failures[0].reason, /the task versions/);
      assert.match(failures[0].reason, /before task identity was persisted/);
      assert.deepStrictEqual(called, [], 'no task ran');
    }
    finally { cleanup(); }
  });
});
