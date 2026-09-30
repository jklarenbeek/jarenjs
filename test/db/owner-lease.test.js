//@ts-check
/**
 * @file The owner lease on SQLite (MODEL-FORMAT §5.1, HOSTS.md): a Store
 * opened with `owner` is the single writable owner of its database file,
 * so a second process that asks for ownership is refused by name
 * (`JD2061`, the owner's id and the lease's expiry) instead of writing
 * beside it. The lease is one row of an engine table, written in the
 * first-open immediate bracket, renewed on a timer, and deleted on
 * `close()`; a killed holder's lease simply expires. Read-only opens
 * neither take nor check it, and an open without `owner` does not either
 * — the lease is cooperative. An adopted store creates no table, so it
 * needs one the operator created (`JD0015` names the statement). A Store
 * whose lease another holder took refuses every later call. The
 * PostgreSQL half (a session advisory lock) is `postgres-owner.test.js`.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';

import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { tempDbPath } from './helpers.js';

const MODEL = {
  $model: '0.1',
  collections: {
    docs: {
      schema: { type: 'object', properties: { id: { type: 'string' }, n: { type: 'integer' } }, required: ['id'] },
      key: '/id',
      indexes: [],
    },
  },
};

/** A child that opens the store as `owner`, writes one document, says
 * `ready`, and holds the lease until it reads `close` (then closes and
 * says `closed`) or is killed. Its renewal timer does not keep it alive:
 * its open stdin does. It is a module file under `node_modules`, so its
 * bare specifiers resolve as a consumer's do, and whichever runtime runs
 * this file (Node or Bun) runs the child too. */
const CHILD = `
  import { openStore } from '@jarenjs/db';
  import { nodeDriver } from '@jarenjs/db/node';
  const [dbPath, id, leaseMs] = process.argv.slice(2);
  const store = await openStore(${JSON.stringify(MODEL)},
    { driver: nodeDriver(), path: dbPath, owner: { id, leaseMs: Number(leaseMs) } });
  await store.collection('docs').put({ id, n: 1 }, id);
  process.stdout.write('ready ' + store.capabilities.owner + '\\n');
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (text) => {
    if (!text.includes('close')) return;
    await store.close();
    process.stdout.write('closed\\n');
    process.exit(0);
  });
`;

/**
 * Start a lease-holding child and wait for its `ready`.
 * @param {string} dbPath @param {string} id @param {number} leaseMs
 */
async function holder(dbPath, id, leaseMs) {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const dir = fs.mkdtempSync(path.join(root, 'node_modules', '.cache-owner-lease-'));
  const program = path.join(dir, 'holder.mjs');
  fs.writeFileSync(program, CHILD);
  const child = spawn(process.execPath, [program, dbPath, id, String(leaseMs)],
    { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.on('close', (status, signal) => resolve({ status, signal })))
    .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
  /** @param {string} word */
  const said = async (word) => {
    for (let i = 0; i < 1000 && !stdout.includes(word); i++) {
      if (child.exitCode !== null) throw new Error(`the child exited: ${stderr}`);
      await delay(10);
    }
    if (!stdout.includes(word)) throw new Error(`the child never said ${word}: ${stderr}`);
  };
  await said('ready');
  return {
    stdout: () => stdout,
    close: async () => { child.stdin.write('close\n'); await said('closed'); await exited; },
    kill: async () => { child.kill('SIGKILL'); await exited; },
  };
}

/** @param {string} dbPath @param {string} id @param {Record<string, any>} [more] */
const openOwner = (dbPath, id, more = {}) => openStore(MODEL,
  { driver: nodeDriver(), path: dbPath, owner: { id, leaseMs: 1000 }, ...more });

/** Whether a refusal is the owner refusal naming `owner`.
 * @param {string} owner @param {boolean} retryable */
const ownedBy = (owner, retryable = true) => (/** @type {any} */ error) => error.code === 'JD2061'
  && error.owner === owner && error.message.includes(`'${owner}'`)
  && error.class === 'busy' && error.retryable === retryable;

describe('the owner lease across processes', () => {
  it('a second owner is refused JD2061 by name while the first holds the lease; renewal keeps it; close() releases at once', async () => {
    const { dbPath, cleanup } = tempDbPath();
    const child = await holder(dbPath, 'child', 1000);
    try {
      assert.match(child.stdout(), /ready lease/);
      const before = Date.now();
      await assert.rejects(openOwner(dbPath, 'parent'), (/** @type {any} */ error) => {
        assert.ok(ownedBy('child')(error), error.message);
        assert.strictEqual(typeof error.expiresAt, 'number');
        assert.ok(error.expiresAt > before - 50 && error.expiresAt <= Date.now() + 1000 + 50,
          `the refusal says when the lease ends (${error.expiresAt - before} ms from the attempt)`);
        assert.ok(error.message.includes(new Date(error.expiresAt).toISOString()), 'and prints it');
        return true;
      });
      // two lease lengths later the child has renewed: still refused
      await delay(2500);
      await assert.rejects(openOwner(dbPath, 'parent'), ownedBy('child'));
      await child.close();
      const store = await openOwner(dbPath, 'parent');
      try {
        assert.strictEqual(store.capabilities.owner, 'lease');
        assert.strictEqual((await store.collection('docs').get('child'))?.n, 1);
      }
      finally { await store.close(); }
    }
    finally {
      await child.kill().catch(() => {});
      cleanup();
    }
  });

  it("a read-only open is never refused, and an open without owner neither takes nor checks the lease", async () => {
    const { dbPath, cleanup } = tempDbPath();
    const child = await holder(dbPath, 'child', 1000);
    try {
      const reader = await openStore(MODEL, { driver: nodeDriver(), path: dbPath, readOnly: true });
      try {
        assert.strictEqual(reader.capabilities.owner, 'none');
        assert.strictEqual((await reader.collection('docs').get('child'))?.n, 1);
      }
      finally { await reader.close(); }
      const plain = await openStore(MODEL, { driver: nodeDriver(), path: dbPath });
      try {
        assert.strictEqual(plain.capabilities.owner, 'none');
        await plain.collection('docs').put({ id: 'plain', n: 2 }, 'plain');
      }
      finally { await plain.close(); }
      // the plain store took nothing, and did not disturb the child's lease
      await assert.rejects(openOwner(dbPath, 'parent'), ownedBy('child'));
    }
    finally {
      await child.close().catch(() => {});
      await child.kill().catch(() => {});
      cleanup();
    }
  });

  it("a killed holder's lease expires, and the refusal said when", async () => {
    const { dbPath, cleanup } = tempDbPath();
    const child = await holder(dbPath, 'crashed', 1500);
    try {
      await child.kill();
      /** @type {number} */
      let expiresAt = 0;
      await assert.rejects(openOwner(dbPath, 'restarted'), (/** @type {any} */ error) => {
        assert.ok(ownedBy('crashed')(error), error.message);
        expiresAt = error.expiresAt;
        return true;
      });
      await delay(Math.max(0, expiresAt - Date.now()) + 50);
      const store = await openOwner(dbPath, 'restarted');
      try {
        assert.strictEqual((await store.collection('docs').get('crashed'))?.n, 1, 'the crashed owner committed what it wrote');
      }
      finally { await store.close(); }
    }
    finally { cleanup(); }
  });
});

describe('the owner lease in one process', () => {
  it('two stores are two owners, even under one id; a closed owner leaves no row behind', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const first = await openOwner(dbPath, 'service');
      await assert.rejects(openOwner(dbPath, 'service'), ownedBy('service'));
      await first.close();
      const probe = new DatabaseSync(dbPath);
      try {
        assert.strictEqual(probe.prepare('SELECT count(*) AS n FROM "_jaren_owner"').get()?.n, 0);
      }
      finally { probe.close(); }
      const second = await openOwner(dbPath, 'service');
      await second.close();
    }
    finally { cleanup(); }
  });

  it('the owner table belongs to the engine: introspection and the model never see it', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const owner = await openOwner(dbPath, 'service');
      const introspected = await owner.introspect();
      assert.deepStrictEqual(Object.keys(introspected.model.collections ?? {}), ['docs']);
      assert.ok(!JSON.stringify(introspected).includes('_jaren_owner'));
      await owner.close();
      // a later open of the same model, owner or not, sees no drift
      const plain = await openStore(MODEL, { driver: nodeDriver(), path: dbPath });
      await plain.close();
    }
    finally { cleanup(); }
  });

  it('a store whose lease another holder took refuses every later call JD2061, and still closes', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      const first = await openOwner(dbPath, 'first');
      await first.collection('docs').put({ id: 'a', n: 1 }, 'a');
      // a holder whose clock is an hour ahead sees the lease expired and takes it
      const hourAhead = { now: () => Date.now() + 3_600_000 };
      const second = await openOwner(dbPath, 'second', { runtime: hourAhead });
      try {
        // the first finds out at its next renewal (a third of the lease)
        await delay(600);
        await assert.rejects(first.collection('docs').get('a'), ownedBy('second', false));
        await assert.rejects(first.transaction(async () => {}), ownedBy('second', false));
        assert.throws(() => first.sync?.collection('docs').get('a'), ownedBy('second', false));
        assert.strictEqual((await second.collection('docs').get('a'))?.n, 1);
      }
      finally {
        await first.close();
        await second.close();
      }
    }
    finally { cleanup(); }
  });

  it('a lease that lapsed on its own clock is renewed before the next call runs, and refused while it cannot be', async () => {
    const { dbPath, cleanup } = tempDbPath();
    let offset = 0;
    const expiry = () => {
      const probe = new DatabaseSync(dbPath);
      try { return Number(probe.prepare('SELECT "expires_at" AS at FROM "_jaren_owner"').get()?.at); }
      finally { probe.close(); }
    };
    try {
      const store = await openOwner(dbPath, 'sleeper', { busyTimeout: 100, runtime: { now: () => Date.now() + offset } });
      try {
        await store.collection('docs').put({ id: 'a', n: 1 }, 'a');
        // as if the process had been suspended past its lease: the next call
        // confirms the lease is still this store's, extends it, and runs
        offset = 5000;
        const before = expiry();
        assert.strictEqual((await store.collection('docs').get('a'))?.n, 1);
        assert.ok(expiry() >= before + 4000, 'the renewal ran before the call');
        // lapsed again while another connection holds the write lock: the
        // renewal cannot confirm the lease, so nothing runs
        offset = 10_000;
        const writer = new DatabaseSync(dbPath);
        try {
          writer.exec('BEGIN IMMEDIATE');
          await assert.rejects(store.collection('docs').get('a'), (/** @type {any} */ error) =>
            error.code === 'JD2061' && error.retryable === true && error.owner === 'sleeper' && /lapsed/.test(error.message));
          assert.throws(() => store.sync?.collection('docs').get('a'), (/** @type {any} */ error) => error.code === 'JD2061');
          writer.exec('ROLLBACK');
        }
        finally { writer.close(); }
        // and once it can, the call runs again
        assert.strictEqual((await store.collection('docs').get('a'))?.n, 1);
      }
      finally { await store.close(); }
    }
    finally { cleanup(); }
  });
});

describe('adoption and the closed option set', () => {
  it('an adopted store needs the owner table: JD0015 names the statement that creates it', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      await (await openStore(MODEL, { driver: nodeDriver(), path: dbPath })).close();
      /** @type {string} */
      let statement = '';
      await assert.rejects(openOwner(dbPath, 'adopter', { adopt: true }), (/** @type {any} */ error) => {
        assert.strictEqual(error.code, 'JD0015', error.message);
        statement = /(CREATE TABLE "_jaren_owner" .*STRICT)/.exec(error.message)?.[1] ?? '';
        return statement !== '';
      });
      const hosts = fs.readFileSync(new URL('../../packages/db/docs/HOSTS.md', import.meta.url), 'utf8');
      assert.ok(hosts.includes(statement), 'HOSTS.md gives the same statement');
      const operator = new DatabaseSync(dbPath);
      try { operator.exec(statement); }
      finally { operator.close(); }
      const adopted = await openOwner(dbPath, 'adopter', { adopt: true });
      try {
        assert.strictEqual(adopted.capabilities.owner, 'lease');
        await assert.rejects(openOwner(dbPath, 'other', { adopt: true }), ownedBy('adopter'));
      }
      finally { await adopted.close(); }
    }
    finally { cleanup(); }
  });

  it('a malformed owner is JD0009 before a file exists, and a read-only store cannot take a lease', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      for (const owner of ['me', null, {}, { id: '' }, { id: 7 }, { id: 'a', leaseMs: 999 }, { id: 'a', leaseMs: 1500.5 },
        { id: 'a', leaseMs: 2 ** 31 }, { id: 'a', lease: 1000 }, [{ id: 'a' }]]) {
        await assert.rejects(openStore(MODEL, { driver: nodeDriver(), path: dbPath, owner: /** @type {any} */ (owner) }),
          (/** @type {any} */ error) => error.code === 'JD0009' && /owner/.test(error.message), JSON.stringify(owner));
        assert.strictEqual(fs.existsSync(dbPath), false);
      }
      await assert.rejects(openStore(MODEL, { driver: nodeDriver(), path: dbPath, owner: /** @type {any} */ ({ id: 'a', lease: 1000 }) }),
        (/** @type {any} */ error) => /'leaseMs'/.test(error.message), 'the nearest member is named');
      await assert.rejects(openStore(MODEL, { driver: nodeDriver(), path: dbPath, readOnly: true, owner: { id: 'a' } }),
        (/** @type {any} */ error) => error.code === 'JD0009' && /read-only/.test(error.message));
      assert.strictEqual(fs.existsSync(dbPath), false);
      const store = await openStore(MODEL, { driver: nodeDriver(), path: dbPath, owner: { id: 'defaults' } });
      await store.close();
    }
    finally { cleanup(); }
  });
});
