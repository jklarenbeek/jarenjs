//@ts-check
/**
 * @file JOBS-FORMAT §12's long-computation recipe, executed: the
 * section's fence is RUN as written (written into `node_modules` so its
 * bare `@jarenjs/*` specifiers resolve as a consumer's do) and the value
 * its `// →` line prints is asserted from the run. Then its handler is
 * driven through an interruption: a worker stopped after its third
 * slice, a second attempt resuming from the saved incumbent, and the
 * final answer's canonical bytes compared with an uninterrupted run's —
 * on SQLite and, where JAREN_PG_URL names a server, on PostgreSQL.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { postgresDriver } from '@jarenjs/db/postgres';
import { canonicalizeJson } from '@jarenjs/json/canonical';

const url = process.env.JAREN_PG_URL;
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DOC = fs.readFileSync(path.join(ROOT, 'packages/db/docs/JOBS-FORMAT.md'), 'utf8');
const HEADING = '## 12. Long computations';

/** The section's first `js` fence, and the section up to its end. */
function example() {
  const from = DOC.indexOf(HEADING);
  assert.ok(from >= 0, `JOBS-FORMAT.md no longer carries "${HEADING}"`);
  const fence = /```js\n([\s\S]*?)```/.exec(DOC.slice(from));
  assert.ok(fence !== null, 'the section no longer carries its example');
  return { code: fence[1], section: DOC.slice(from, from + fence.index + fence[0].length) };
}

/**
 * Run the fence as a module and answer its named bindings.
 * @param {string} code @param {string[]} names
 * @returns {Promise<any>}
 */
async function run(code, names) {
  const dir = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.cache-jobs-long-solve-'));
  try {
    const file = path.join(dir, 'example.mjs');
    fs.writeFileSync(file, `${code}\nexport { ${names.join(', ')} };\n`);
    return await import(pathToFileURL(file).href);
  }
  finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** @type {any} */
let ran = null;
/** @type {any} */
let pool = null;
let serial = 0;
before(async () => {
  ran = await run(example().code, ['solved', 'solveInSlices', 'problem', 'rules']);
  if (url) pool = new (await import('pg')).default.Pool({ connectionString: url, max: 3 });
});
after(async () => { await pool?.end(); });

const model = { $model: '0.1', collections: { rosters: { key: '/id', schema: { type: 'object' } } } };

/** Wait, bounded, until a condition holds. @param {() => any} done @param {string} what */
async function until(done, what) {
  const deadline = Date.now() + 60_000;
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/**
 * Solve the fence's problem as one job on a fresh database, the worker
 * stopped after `stopAfter` slices (never, when null) and a second worker
 * started on a second store over the same database: the final answer's
 * canonical bytes, and what each attempt did.
 * @param {'sqlite' | 'postgres'} engine @param {number | null} stopAfter
 */
async function solveJob(engine, stopAfter) {
  const schema = `jaren_longsolve_${process.pid}_${serial++}`;
  const dir = engine === 'sqlite' ? fs.mkdtempSync(path.join(ROOT, 'node_modules', '.cache-jobs-long-solve-db-')) : null;
  if (engine === 'postgres') await pool.query(`CREATE SCHEMA "${schema}"`);
  const clock = { at: Date.UTC(2026, 2, 20, 12) };
  const now = () => clock.at;
  /** @type {any[]} */
  const stores = [];
  const open = async () => {
    const store = await openStore(model, { driver: engine === 'sqlite' ? nodeDriver() : postgresDriver(pool, { schema }),
      ...(dir === null ? {} : { path: path.join(dir, 'store.db') }), jobs: { now, random: () => 0 } });
    stores.push(store);
    return store;
  };
  try {
    const first = await open();
    const id = await first.jobs.enqueue('solve', { problem: ran.problem, seed: 7, maxMoves: 40 });
    const inner = ran.solveInSlices(ran.rules);
    /** The slices each attempt saved, and the incumbent each attempt began from. */
    const attempts = /** @type {{ began: any, saved: any[] }[]} */ ([]);
    /** @type {() => void} */
    let reached = () => {};
    const enough = new Promise((resolve) => { reached = () => resolve(undefined); });
    const handler = async (/** @type {any} */ payload, /** @type {any} */ context) => {
      const record = { began: await context.checkpoints.load(context.job.id), saved: /** @type {any[]} */ ([]) };
      attempts.push(record);
      const checkpoints = { ...context.checkpoints, save: async (/** @type {string} */ runId, /** @type {string} */ node, /** @type {any} */ value) => {
        await context.checkpoints.save(runId, node, value);
        record.saved.push(value);
        if (attempts.length === 1 && record.saved.length === stopAfter) reached();
      } };
      return inner(payload, { ...context, checkpoints });
    };
    const worker = first.jobs.createWorker({ handlers: { solve: handler }, pollInterval: 5 }).start();
    if (stopAfter !== null) {
      await enough;
      await worker.stop();
      // the stopped attempt's job is claimable again once its backoff or its lease has passed
      clock.at += 120_000;
      const second = await open();
      const resumed = second.jobs.createWorker({ handlers: { solve: handler }, pollInterval: 5 }).start();
      await until(async () => (await second.jobs.get(id)).state === 'done', 'the resumed job');
      await resumed.stop();
    }
    else {
      await until(async () => (await first.jobs.get(id)).state === 'done', 'the job');
      await worker.stop();
    }
    const job = await first.jobs.get(id);
    return { bytes: canonicalizeJson(job.result), attempts, job };
  }
  finally {
    for (const store of stores) await store.close();
    if (engine === 'postgres') await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    if (dir !== null) fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('JOBS-FORMAT §12: a long solve as a job', () => {
  it('the example runs as written and answers what it prints', () => {
    const { section } = example();
    assert.deepEqual(ran.solved, { status: 'feasible', hard: 0, service: 0, soft: -3 });
    assert.ok(section.includes(`// → ${util.inspect(ran.solved)}`), `the example no longer prints ${util.inspect(ran.solved)}`);
  });

  /** The uninterrupted answer each engine must reproduce. @type {Map<string, string>} */
  const whole = new Map();
  for (const engine of /** @type {const} */ (['sqlite', 'postgres'])) {
    it(`an interrupted and resumed solve answers the uninterrupted run's bytes on ${engine}`,
      { skip: engine === 'postgres' && !url && 'JAREN_PG_URL is not set' }, async () => {
        const straight = await solveJob(engine, null);
        const cut = await solveJob(engine, 3);
        assert.equal(straight.attempts.length, 1);
        const slices = straight.attempts[0].saved.length;
        assert.ok(slices > 3, `${slices} slices: the interruption falls inside the run`);
        assert.equal(cut.bytes, straight.bytes);
        assert.equal(cut.job.attempts, 2);
        // the second attempt began from the first one's last saved incumbent, and saved only the slices left
        const [stopped, resumed] = cut.attempts;
        assert.deepEqual(stopped.saved, straight.attempts[0].saved.slice(0, stopped.saved.length));
        assert.ok(stopped.saved.length >= 3);
        assert.deepEqual(resumed.began, { values: { incumbent: stopped.saved.at(-1) } });
        assert.deepEqual([...stopped.saved, ...resumed.saved], straight.attempts[0].saved);
        assert.equal(JSON.parse(cut.bytes).status, 'feasible');
        if (engine === 'sqlite') whole.set('bytes', straight.bytes);
        else if (whole.has('bytes')) assert.equal(straight.bytes, whole.get('bytes'), 'the same answer as SQLite');
      });
  }
});
