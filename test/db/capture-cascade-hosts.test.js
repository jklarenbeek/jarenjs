//@ts-check
/**
 * @file Journal capture of the database's foreign-key actions on every
 * journal host. On sqlite-wasm (journal and session), the Node worker host and
 * a bun:sqlite-shaped binding, the corpus workload commits the records session
 * capture commits on `node:sqlite`, and every record of a seeded random
 * workload, folded over the complete logical state before its transaction,
 * gives the state after it — the records `node:sqlite` session capture
 * commits for the same seed. Then real bun:sqlite: when a `bun` binary is on
 * PATH the fixture runs the same workloads under it; without one the case is
 * skipped by name.
 */
import { before, describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import init from '@sqlite.org/sqlite-wasm';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { wasmDriver, sqlite3Handle } from '@jarenjs/db/wasm';
import { nodeWorkerDriver } from '@jarenjs/db/node-worker';
import { fromBunModule } from '@jarenjs/db/bun';
import { cascadeModel, seedCascade, cascadeWorkload, canonicalPatch, CASCADE_RECORDS, trialModel, randomWorkload }
  from './oracle/cascade.js';
import { BunShapedDatabase, tempDbPath } from './helpers.js';

const SEEDS = [1, 2, 3, 4, 5];
const OPERATIONS = 20;

/** @type {any} */
let sqlite3;
before(async () => { sqlite3 = await init({ print: () => {}, printErr: () => {} }); });

/** @type {Map<number, Promise<string[][]>>} */
const expected = new Map();
/** The records `node:sqlite` session capture commits for a seed. @param {number} seed */
const sessionRecords = (seed) => {
  let records = expected.get(seed);
  if (records === undefined) {
    records = (async () => {
      const store = await openStore(trialModel(), { driver: nodeDriver(), capture: { mode: 'session' } });
      try { return (await randomWorkload(store, seed, OPERATIONS)).records; }
      finally { await store.close(); }
    })();
    expected.set(seed, records);
  }
  return records;
};

/** A bun:sqlite-shaped binding over a temporary `node:sqlite` file. */
const bunShaped = () => {
  const { dbPath, cleanup } = tempDbPath();
  return { driver: { name: 'bun-shaped', dialect: nodeDriver().dialect,
    open: () => fromBunModule({ Database: BunShapedDatabase }, dbPath, {}) }, cleanup };
};

/** @typedef {() => { driver: any, cleanup?: () => void }} Host */
/** @type {[string, string, Host, boolean][]} name, capture mode, driver, whether `store.sync` exists */
const HOSTS = [
  ['sqlite-wasm', 'journal', () => ({ driver: wasmDriver(sqlite3Handle(sqlite3)) }), true],
  ['sqlite-wasm', 'session', () => ({ driver: wasmDriver(sqlite3Handle(sqlite3)) }), true],
  ['the Node worker host', 'journal', () => ({ driver: nodeWorkerDriver() }), false],
  ['a bun:sqlite-shaped binding', 'journal', bunShaped, true],
];

/**
 * Run `fn` on a fresh store of `host` that captures in `mode`.
 * @template T
 * @param {Host} host @param {string} mode @param {any} model @param {(store: any) => Promise<T>} fn
 * @returns {Promise<T>}
 */
const onHost = async (host, mode, model, fn) => {
  const { driver, cleanup } = host();
  try {
    const store = await openStore(model, { driver, capture: { mode } });
    try {
      assert.equal(store.capabilities.capture, mode);
      return await fn(store);
    }
    finally { await store.close(); }
  }
  finally { cleanup?.(); }
};

describe('journal capture of foreign-key actions on every journal host', () => {
  for (const [name, mode, host, sync] of HOSTS) {
    it(`${name} ${mode}: the corpus workload records what session capture records`, async () => {
      const records = await onHost(host, mode, cascadeModel(), async (store) => {
        await seedCascade(store);
        /** @type {any[]} */
        const seen = [];
        store.observe((/** @type {any} */ record) => { seen.push(record); });
        await cascadeWorkload(store);
        assert.equal(await store.entity('Parent').delete('r'), true);
        return seen.map((record) => canonicalPatch(record.patch));
      });
      assert.deepEqual(records, CASCADE_RECORDS);
    });

    it(`${name} ${mode}: every record of seeds 1-5 yields the next state, as session capture records it`, async () => {
      for (const seed of SEEDS) {
        const { records } = await onHost(host, mode, trialModel(),
          (store) => randomWorkload(store, seed, OPERATIONS, { sync }));
        assert.deepEqual(records, await sessionRecords(seed), `seed ${seed}`);
      }
    });
  }

  it('real bun:sqlite: the corpus and seeded workloads record what session capture records', async (t) => {
    const which = spawnSync('bun', ['--version'], { encoding: 'utf8' });
    if (which.error !== undefined || which.status !== 0) {
      t.skip('no bun binary on PATH');
      return;
    }
    const fixture = fileURLToPath(new URL('./fixtures/cascade-capture-bun.mjs', import.meta.url));
    const run = spawnSync('bun', ['run', fixture], { encoding: 'utf8', cwd: fileURLToPath(new URL('../..', import.meta.url)) });
    assert.equal(run.status, 0, run.stderr);
    const [header, corpus, ...seeds] = run.stdout.trim().split('\n').map((line) => JSON.parse(line));
    assert.match(header.runtime, /^bun \d/);
    assert.equal(header.capture, 'journal');
    assert.deepEqual(corpus.records, CASCADE_RECORDS);
    assert.deepEqual(seeds.map((trial) => trial.seed), [1, 2, 3]);
    for (const { seed, records } of seeds) assert.deepEqual(records, await sessionRecords(seed), `seed ${seed}`);
  });
});
