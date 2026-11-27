//@ts-check
/**
 * @file `createDagJobRunner` reads a closed set of options, as the worker it
 * builds does: a misspelt member (`concurency`, `stopGracMs`, `task`) would
 * leave the default in force without a word, and `maxAttempts` -- which
 * belongs to the job -- would be ignored. `null` is as good as no options.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { compileDag } from '@jarenjs/flow';
import { openStore, createDagJobRunner } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { createJsltRegistry, mathPack } from '@jarenjs/json/jslt';
import { createTypeTestCompiler } from '@jarenjs/validate/query';

const MODEL = { $model: '0.1', collections: { x: { schema: { type: 'object' }, key: '/id' } } };
const DAG = { $dag: '0.1', nodes: { in: { kind: 'input' }, out: { kind: 'output' } }, edges: [{ from: 'in', to: 'out' }] };

describe('createDagJobRunner options', () => {
  it('refuses a member it does not read, naming the nearest one it does', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), jobs: true });
    try {
      /** @type {[object, RegExp][]} */
      const cases = [
        [{ concurency: 3 }, /^JD0013: createDagJobRunner option 'concurency' is not one it reads — did you mean 'concurrency'\?$/],
        [{ stopGracMs: 5 }, /^JD0013: createDagJobRunner option 'stopGracMs' is not one it reads — did you mean 'stopGraceMs'\?$/],
        [{ task: {} }, /^JD0013: createDagJobRunner option 'task' is not one it reads — did you mean 'tasks'\?$/],
        [{ pollIntervall: 5 }, /did you mean 'pollInterval'\?$/],
        [{ maxAttempts: 1 }, /^JD0013: createDagJobRunner option 'maxAttempts' is not one it reads; the options are compileDag, documents, tasks, /],
      ];
      for (const [extra, message] of cases) {
        assert.throws(() => createDagJobRunner(store, /** @type {any} */ ({ compileDag, documents: { k: DAG }, ...extra })),
          (error) => { assert.strictEqual(/** @type {any} */ (error).code, 'JD0013'); assert.match(/** @type {Error} */ (error).message, message); return true; });
      }
    }
    finally { await store.close(); }
  });

  it('still builds a runner from the members it reads, and reads null as none', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), jobs: true });
    try {
      const runner = createDagJobRunner(store, { compileDag, documents: { k: DAG }, tasks: {}, concurrency: 2,
        pollInterval: 50, leaseMs: 5000, owner: 'w', renew: true, onOutcome: () => undefined, backoffBase: 10,
        backoffCap: 1000, stopGraceMs: 100, effectSafety: undefined });
      assert.strictEqual(typeof runner.start, 'function');
      assert.throws(() => createDagJobRunner(store, /** @type {any} */ (null)), /compileDag/);
    }
    finally { await store.close(); }
  });
});

describe('createDagJobRunner: what the documents compile with', () => {
  const math = createJsltRegistry().use(mathPack);
  const compileTypeTest = createTypeTestCompiler();
  const COMPUTE = { $dag: '0.1', nodes: { in: { kind: 'input' },
    q: { kind: 'query', query: { root: { $sqrt: '$.n' }, number: { $valid: ['$.n', { type: 'number' }] } } }, out: { kind: 'output' } },
  edges: [{ from: 'in', to: 'q' }, { from: 'q', to: 'out' }] };

  it('hands operators and compileTypeTest to the injected compiler only when given', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), jobs: true });
    try {
      /** @type {any[]} */
      const seen = [];
      const spy = (/** @type {any} */ doc, /** @type {any} */ options) => { seen.push(options); return compileDag(doc, options); };
      createDagJobRunner(store, { compileDag: spy, documents: { k: DAG } });
      createDagJobRunner(store, { compileDag: spy, documents: { k: DAG }, operators: math, compileTypeTest });
      assert.deepStrictEqual(seen.map((options) => Object.keys(options)), [['tasks', 'checkpoint'], ['operators', 'compileTypeTest', 'tasks', 'checkpoint']]);
      assert.strictEqual(seen[1].operators, math);
      assert.strictEqual(seen[1].compileTypeTest, compileTypeTest);
    }
    finally { await store.close(); }
  });

  it('a job computes with the registry\'s operators and the schema operators', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), jobs: true });
    const runner = createDagJobRunner(store, { compileDag, documents: { k: COMPUTE }, operators: math, compileTypeTest, pollInterval: 10 });
    try {
      runner.start();
      const id = await store.jobs.enqueue('k', { input: { n: 16 } }, { id: 'j1' });
      const deadline = Date.now() + 5_000;
      for (;;) {
        const job = await store.jobs.get(id);
        if (job.state === 'done') break;
        assert.ok(Date.now() < deadline, `stalled in ${job.state}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.deepStrictEqual((await store.jobs.get(id)).result, { root: 4, number: true });
    }
    finally { await runner.stop(); await store.close(); }
  });

  it('without them a document using either is refused when the runner is built', async () => {
    const store = await openStore(MODEL, { driver: nodeDriver(), jobs: true });
    try {
      /** @type {Array<[any, string]>} */
      const cases = [[{}, 'JQ0002'], [{ operators: math }, 'JQ0008'], [{ compileTypeTest }, 'JQ0002']];
      for (const [extra, cause] of cases) {
        assert.throws(() => createDagJobRunner(store, { compileDag, documents: { k: COMPUTE }, ...extra }),
          (/** @type {any} */ error) => error.code === 'JF0014' && error.docPath === '/nodes/q/query' && error.cause?.code === cause, cause);
      }
    }
    finally { await store.close(); }
  });
});
