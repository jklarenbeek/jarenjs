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
