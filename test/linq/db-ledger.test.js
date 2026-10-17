//@ts-check
/**
 * @file `createDbLedger` (DB-CLIENT.md §2.6): the contract ledger over a
 * declared collection through the client's own surface. The shared
 * ledger contract runs over a real store; construction refuses by name;
 * a root claim takes the write lock up front and a transaction-client
 * ledger nests in the transaction it was handed; two processes released
 * on one absent file see exactly one `new`; a reopened process replays
 * the stored response and honours the persisted generation fence; a
 * domain write and a settlement inside one transaction commit together
 * or not at all; a legacy-spelled record is matched by no claim; and
 * the module imports neither the contract package nor a driver.
 */
import { describe, it, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import { open, createDbLedger } from '@jarenjs/linq/db';
import * as sqlite from 'node:sqlite';
import { nodeDriver, fromNodeModule } from '@jarenjs/db/node';
import { idempotencyLedgerModel } from '@jarenjs/contract/ledger';
import { ledgerContract, CLAIM, RESPONSE } from '../contract/ledger-contract.js';
import { tempDbPath } from '../db/helpers.js';

/** The ledger model plus one domain collection, for the atomicity proof. */
const MODEL = {
  $model: '0.1',
  collections: {
    ...idempotencyLedgerModel.collections,
    notes: {
      schema: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id'] },
      key: '/id',
      indexes: [],
    },
  },
};

/** @type {(() => any)[]} */
const cleanups = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

/** @param {any} [options] */
async function memoryClient(options = {}) {
  const client = await open(idempotencyLedgerModel, { driver: nodeDriver(), validator: null, ...options });
  cleanups.push(() => client.close());
  return client;
}

ledgerContract('createDbLedger over a linq client (node driver, in memory)', async (options) => {
  const client = await open(idempotencyLedgerModel, { driver: nodeDriver(), validator: null });
  return { ledger: createDbLedger(client, options), staleCode: 'JL2007', close: () => client.close() };
});

describe('createDbLedger — construction', () => {
  it('refuses by name: not a client, an undeclared collection, a bad ttl, a bad clock', async () => {
    const client = await memoryClient();
    assert.throws(() => createDbLedger(/** @type {any} */ (null)), /must be a @jarenjs\/linq\/db client/);
    assert.throws(() => createDbLedger(/** @type {any} */ ({ collections: {} })), /must be a @jarenjs\/linq\/db client/);
    assert.throws(() => createDbLedger(client, { collection: 'nope' }), /declares no collection 'nope'/);
    assert.throws(() => createDbLedger(client, { collection: '' }), /non-empty collection name/);
    assert.throws(() => createDbLedger(client, { ttlMs: 0 }), /ttlMs must be a positive whole number of milliseconds/);
    assert.throws(() => createDbLedger(client, { now: /** @type {any} */ ('soon') }), /now must be a function/);
    assert.ok(Object.isFrozen(createDbLedger(client)));
  });

  it('the default collection is the model\'s `ledger`; a named collection is honoured', async () => {
    const client = await open({
      $model: '0.1',
      collections: { keys: idempotencyLedgerModel.collections.ledger },
    }, { driver: nodeDriver(), validator: null });
    cleanups.push(() => client.close());
    assert.throws(() => createDbLedger(client), /declares no collection 'ledger'/);
    const ledger = createDbLedger(client, { collection: 'keys' });
    const claimed = await ledger.claim({ ...CLAIM, now: 1000 });
    assert.strictEqual(claimed.state, 'new');
    assert.strictEqual((await client.collections.keys.get(claimed.ref.id))?.status, 'started');
  });

  it('the module imports neither the contract package nor a driver builtin, and no store', () => {
    const source = fs.readFileSync(new URL('../../packages/linq/src/db/ledger.js', import.meta.url), 'utf8');
    const imports = [...source.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
    assert.deepStrictEqual(imports, ['@jarenjs/core/runtime', '../errors.js']);
  });
});

describe('createDbLedger — the transaction it runs in', () => {
  /**
   * A client whose `transaction` records the options it was asked for —
   * the ledger is structural, so the spy IS a client to it.
   * @param {any} target
   */
  function spied(target) {
    /** @type {any[]} */
    const calls = [];
    const spy = { ...target, transaction: (/** @type {any} */ fn, /** @type {any} */ opts) => { calls.push(opts); return target.transaction(fn, opts); } };
    return { spy, calls };
  }

  it('a root client\'s claim, settlement, lookup and sweep each run in one transaction that takes the write lock up front', async () => {
    const client = await memoryClient();
    const { spy, calls } = spied(client);
    const ledger = createDbLedger(spy, { now: () => 1000 });
    const claimed = await ledger.claim(CLAIM);
    await ledger.commit(claimed.ref, RESPONSE);
    await ledger.lookup(CLAIM);
    await ledger.sweep();
    assert.deepStrictEqual(calls, [{ mode: 'immediate' }, { mode: 'immediate' }, { mode: 'immediate' }, { mode: 'immediate' }]);
  });

  it('a transaction-client ledger nests in the transaction it was handed and asks for no mode of its own', async () => {
    const client = await open(MODEL, { driver: nodeDriver(), validator: null });
    cleanups.push(() => client.close());
    /** @type {any[]} */
    let calls = [];
    await client.transaction(async (tx) => {
      const inner = spied(tx);
      calls = inner.calls;
      const ledger = createDbLedger(inner.spy, { now: () => 1000 });
      const claimed = await ledger.claim(CLAIM);
      assert.strictEqual(claimed.state, 'new');
      await ledger.commit(claimed.ref, RESPONSE);
    });
    assert.deepStrictEqual(calls, [undefined, undefined], 'a nested transaction is the host\'s savepoint');
    assert.deepStrictEqual(await createDbLedger(client).claim({ ...CLAIM, now: 1001 }), { state: 'replay', response: RESPONSE });
  });
});

describe('createDbLedger — durability and the fence across processes', () => {
  /** One child: open the store on `dbPath`, claim `key` with `hash`, print the state. */
  const CHILD = `
    import { open, createDbLedger } from '@jarenjs/linq/db';
    import { nodeDriver } from '@jarenjs/db/node';
    import { idempotencyLedgerModel } from '@jarenjs/contract/ledger';
    const [dbPath, who, key, hash] = process.argv.slice(1);
    const client = await open(idempotencyLedgerModel, { driver: nodeDriver(), path: dbPath, busyTimeout: 5000, validator: null });
    const ledger = createDbLedger(client, { now: () => 1000 });
    const claimed = await ledger.claim({ op: 'product.save', scope: '', key, hash });
    await client.close();
    process.stdout.write(who + ' ' + claimed.state + '\\n');
  `;

  /** @param {string[][]} argv */
  function release(argv) {
    // whichever runtime runs this file runs the children: Bun takes a
    // module from -e as it is, and knows neither of Node's two flags
    const flags = process.versions.bun ? ['-e'] : ['--no-warnings=ExperimentalWarning', '--input-type=module', '-e'];
    const children = argv.map((args) => spawn(process.execPath, [...flags, CHILD, ...args],
      { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] }));
    return Promise.all(children.map((child) => new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (status) => resolve({ status, stdout, stderr }));
    })));
  }

  it('two processes released on one absent file claim one key: exactly one new, the other in-progress; a third hash is a mismatch', async () => {
    const rounds = 6;
    for (let round = 0; round < rounds; round++) {
      const { dbPath, cleanup } = tempDbPath();
      try {
        const hash = 'a'.repeat(64);
        const outcomes = await release([[dbPath, 'p0', 'k', hash], [dbPath, 'p1', 'k', hash]]);
        for (const outcome of outcomes) {
          assert.strictEqual(outcome.status, 0, `round ${round}: ${outcome.stderr.slice(0, 400)}`);
          assert.doesNotMatch(outcome.stderr, /database is locked/);
        }
        const states = outcomes.map((o) => o.stdout.trim().split(' ')[1]).sort();
        assert.deepStrictEqual(states, ['in-progress', 'new'], `round ${round}`);
        const [other] = await release([[dbPath, 'p2', 'k', 'b'.repeat(64)]]);
        assert.strictEqual(other.stdout.trim(), 'p2 mismatch');
      }
      finally {
        cleanup();
      }
    }
  });

  it('a reopened process replays the stored response without a handler; an old ref cannot settle a reclaimed key, before or after reopen', async () => {
    const { dbPath, cleanup } = tempDbPath();
    try {
      let at = 1000;
      const first = await open(idempotencyLedgerModel, { driver: nodeDriver(), path: dbPath, validator: null });
      const ledger = createDbLedger(first, { ttlMs: 50, now: () => at });
      const a = await ledger.claim(CLAIM);
      await ledger.commit(a.ref, RESPONSE);
      const stale = await ledger.claim({ ...CLAIM, key: 'k2' });
      await first.close();

      const second = await open(idempotencyLedgerModel, { driver: nodeDriver(), path: dbPath, validator: null });
      const reopened = createDbLedger(second, { ttlMs: 50, now: () => at });
      assert.deepStrictEqual(await reopened.claim(CLAIM), { state: 'replay', response: RESPONSE }, 'the restart replays');
      // k2 expires; a fresh claim mints a new generation the old ref cannot touch
      at = 1100;
      const fresh = await reopened.claim({ ...CLAIM, key: 'k2' });
      assert.strictEqual(fresh.state, 'new');
      assert.notStrictEqual(fresh.ref.generation, stale.ref.generation);
      await assert.rejects(reopened.commit(stale.ref, RESPONSE), (/** @type {any} */ err) => err.code === 'JL2007');
      await assert.rejects(reopened.fail(stale.ref, true), (/** @type {any} */ err) => err.code === 'JL2007');
      const record = await reopened.lookup({ ...CLAIM, key: 'k2' });
      assert.strictEqual(record?.generation, fresh.ref.generation);
      assert.strictEqual(record?.status, 'started');
      await second.close();

      const third = await open(idempotencyLedgerModel, { driver: nodeDriver(), path: dbPath, validator: null });
      const again = createDbLedger(third, { ttlMs: 50, now: () => at });
      await assert.rejects(again.commit(stale.ref, RESPONSE), (/** @type {any} */ err) => err.code === 'JL2007', 'the fence is the persisted generation');
      await again.commit(fresh.ref, RESPONSE);
      assert.deepStrictEqual(await again.claim({ ...CLAIM, key: 'k2' }), { state: 'replay', response: RESPONSE });
      await third.close();
    }
    finally {
      cleanup();
    }
  });

  it('a record under the legacy "<op>|<scope>|<key>" spelling is matched by no claim and expires by its own clock', async () => {
    const client = await memoryClient();
    const legacy = {
      id: `${CLAIM.op}|${CLAIM.scope}|${CLAIM.key}`, generation: 'legacy', op: CLAIM.op, scope: CLAIM.scope, key: CLAIM.key, hash: CLAIM.hash,
      status: 'committed', response: RESPONSE, retryable: null, createdAt: 1, updatedAt: 1, expiresAt: 500,
    };
    await client.collections.ledger.insert(legacy);
    const ledger = createDbLedger(client, { now: () => 400 });
    const claimed = await ledger.claim(CLAIM);
    assert.strictEqual(claimed.state, 'new', 'the legacy record is not this key');
    assert.strictEqual(await ledger.sweep(600), 1, 'the legacy record expires by its expiresAt');
    assert.strictEqual(await client.collections.ledger.get(legacy.id), undefined);
    assert.strictEqual((await ledger.lookup(CLAIM))?.status, 'started');
  });
});

/**
 * One settled record expiring at `expiresAt`.
 * @param {string} id
 * @param {number} expiresAt
 */
function settledRecord(id, expiresAt) {
  return {
    id, generation: 'g', op: 'o', scope: '', key: id, hash: 'h', status: 'committed', response: null, retryable: null,
    createdAt: 1, updatedAt: 1, expiresAt,
  };
}

/**
 * node:sqlite behind the driver contract, counting the rows every SELECT
 * hands back and keeping the query plan of each one over the ledger table.
 */
function countingDriver() {
  const counting = {
    read: 0,
    /** @type {string[]} */
    plans: [],
    reset() { counting.read = 0; counting.plans = []; },
    driver: /** @type {any} */ (null),
  };
  class Counting extends sqlite.DatabaseSync {
    /** @param {string} sql */
    prepare(sql) {
      const statement = super.prepare(sql);
      const select = /^\s*SELECT/i.test(sql);
      const planner = select && sql.includes('FROM "ledger"') ? super.prepare(`EXPLAIN QUERY PLAN ${sql}`) : null;
      return {
        run: (/** @type {any[]} */ ...args) => statement.run(...args),
        get: (/** @type {any[]} */ ...args) => statement.get(...args),
        all: (/** @type {any[]} */ ...args) => {
          const found = statement.all(...args);
          if (select) counting.read += found.length;
          if (planner !== null) counting.plans.push(planner.all(...args).map((/** @type {any} */ step) => step.detail).join('; '));
          return found;
        },
        iterate: function* (/** @type {any[]} */ ...args) { for (const row of statement.iterate(...args)) { if (select) counting.read++; yield row; } },
      };
    }
  }
  counting.driver = { ...nodeDriver(), open: (/** @type {string} */ path, /** @type {any} */ opts) => Promise.resolve(fromNodeModule({ DatabaseSync: Counting }, path, opts)) };
  return counting;
}

describe('createDbLedger — sweep(now, { limit })', () => {
  /** @param {any} client @returns {Promise<string[]>} */
  const remaining = async (client) => (await client.collections.ledger.toArray()).map((/** @type {any} */ r) => r.id).sort();

  it('deletes at most `limit` records per call, the longest expired first, in one transaction each, and answers the count removed', async () => {
    const client = await memoryClient();
    // inserted out of order: the order of removal is the expiry's, not the insertion's
    for (const [id, at] of [['c', 30], ['a', 10], ['live', 5000], ['e', 50], ['b', 20], ['d', 40]]) {
      await client.collections.ledger.insert(settledRecord(String(id), Number(at)));
    }
    /** @type {any[]} */
    const calls = [];
    const spy = { ...client, transaction: (/** @type {any} */ fn, /** @type {any} */ opts) => { calls.push(opts); return client.transaction(fn, opts); } };
    const ledger = createDbLedger(spy, { now: () => 1000 });
    assert.strictEqual(await ledger.sweep(1000, { limit: 2 }), 2, 'a full batch: more may remain');
    assert.deepStrictEqual(await remaining(client), ['c', 'd', 'e', 'live']);
    assert.strictEqual(await ledger.sweep(undefined, { limit: 2 }), 2, 'the clock judges a call without an instant');
    assert.deepStrictEqual(await remaining(client), ['e', 'live']);
    assert.strictEqual(await ledger.sweep(1000, { limit: 2 }), 1, 'a short batch: none remain');
    assert.strictEqual(await ledger.sweep(1000, { limit: 2 }), 0);
    assert.deepStrictEqual(await remaining(client), ['live'], 'a record that has not expired is never swept');
    assert.strictEqual(calls.length, 4, 'one transaction per call');
  });

  it('equal expiries are all taken, each once, across the calls', async () => {
    const client = await memoryClient();
    for (const id of ['z', 'm', 'a', 'q']) await client.collections.ledger.insert(settledRecord(id, 10));
    const ledger = createDbLedger(client, { now: () => 1000 });
    assert.strictEqual(await ledger.sweep(1000, { limit: 3 }), 3);
    assert.strictEqual((await remaining(client)).length, 1);
    assert.strictEqual(await ledger.sweep(1000, { limit: 3 }), 1);
    assert.deepStrictEqual(await remaining(client), []);
  });

  it('without a limit (or with an empty options object) still removes every expired record', async () => {
    const client = await memoryClient();
    for (let i = 0; i < 7; i++) await client.collections.ledger.insert(settledRecord(`r${i}`, 10 + i));
    await client.collections.ledger.insert(settledRecord('live', 9999));
    const ledger = createDbLedger(client, { now: () => 1000 });
    assert.strictEqual(await ledger.sweep(1000, {}), 7);
    assert.deepStrictEqual(await remaining(client), ['live']);
    for (let i = 0; i < 3; i++) await client.collections.ledger.insert(settledRecord(`s${i}`, 10));
    assert.strictEqual(await ledger.sweep(), 3);
  });

  it('a limit larger than the backlog answers the backlog', async () => {
    const client = await memoryClient();
    for (let i = 0; i < 3; i++) await client.collections.ledger.insert(settledRecord(`r${i}`, 10));
    const ledger = createDbLedger(client, { now: () => 1000 });
    assert.strictEqual(await ledger.sweep(1000, { limit: 1_000_000 }), 3);
  });

  // The sweep reads the expiry index range in index order, behind a probe in
  // its own LIMIT that the column holds no integer past the safe range (the
  // expiry member declares no bounds): two seeks on the same index, no table
  // scan and no sort.
  const SWEEP_PLAN = 'SCALAR SUBQUERY 1; SEARCH ledger USING INDEX ledger_by_expires; SCALAR SUBQUERY 2; '
    + 'SEARCH ledger USING INDEX ledger_by_expires; SEARCH ledger USING INDEX ledger_by_expires (gx_expiresAt<?)';

  it('a bounded call reads only the rows it deletes, in index order: 50 rows read whether the table holds 1,000 or 8,000, and whether 100 or all of them are expired', async () => {
    const counting = countingDriver();
    for (const [table, expired] of [[1000, 100], [8000, 100], [8000, 8000]]) {
      const client = await memoryClient({ driver: counting.driver });
      await client.transaction(async (tx) => {
        for (let i = 0; i < table; i++) await tx.collections.ledger.insert(settledRecord(`r${i}`, i < expired ? 10 + i : 1e12 + i));
      });
      const ledger = createDbLedger(client, { now: () => 1e9 });
      counting.reset();
      assert.strictEqual(await ledger.sweep(1e9, { limit: 50 }), 50);
      assert.strictEqual(counting.read, 50, `${table} records, ${expired} expired`);
      assert.deepStrictEqual(counting.plans, [SWEEP_PLAN],
        'one statement: the expiry index range in index order, no table scan and no sort');
      assert.strictEqual((await client.collections.ledger.toArray()).length, table - 50);
    }
  });

  it('a limit past the largest safe integer is a bound past every record, read through the same statement as a small one, by sweep and inFlight', async () => {
    const counting = countingDriver();
    /** @param {number} limit */
    const run = async (limit) => {
      const client = await memoryClient({ driver: counting.driver });
      await client.transaction(async (tx) => {
        for (let i = 0; i < 1000; i++) await tx.collections.ledger.insert(settledRecord(`r${i}`, i < 3 ? 10 + i : 1e12 + i));
      });
      const ledger = createDbLedger(client, { ttlMs: 1e6, startedTtlMs: 100, now: () => 1e9 });
      for (const [key, at] of [['b', 1010], ['a', 1000]]) await ledger.claim({ op: 'o', scope: '', key, hash: 'h', now: at });
      counting.reset();
      const inFlight = (await ledger.inFlight({ limit, now: 1020 })).map((c) => c.key);
      const inFlightRead = { read: counting.read, plans: [...counting.plans] };
      counting.reset();
      const swept = await ledger.sweep(1e9, { limit });
      const sweepRead = { read: counting.read, plans: [...counting.plans] };
      return { inFlight, inFlightRead, swept, sweepRead, left: (await client.collections.ledger.toArray()).length };
    };
    const safe = await run(50);
    assert.deepStrictEqual(safe.inFlight, ['a', 'b']);
    // the three settled records past expiry and the two claims past their own expiry
    assert.strictEqual(safe.swept, 5);
    assert.strictEqual(safe.sweepRead.read, 5);
    assert.deepStrictEqual(safe.sweepRead.plans, [SWEEP_PLAN]);
    assert.strictEqual(safe.left, 997);
    for (const limit of [2 ** 53, Number.MAX_VALUE]) {
      assert.deepStrictEqual(await run(limit), safe, String(limit));
    }
  });

  it('refuses a malformed second argument by name and deletes nothing', async () => {
    const client = await memoryClient();
    await client.collections.ledger.insert(settledRecord('a', 10));
    const ledger = createDbLedger(client, { now: () => 1000 });
    for (const [options, message] of /** @type {[any, RegExp][]} */ ([
      [{ limit: 0 }, /ledger\.sweep: limit is a whole number from 1/],
      [{ limit: -3 }, /limit is a whole number from 1/],
      [{ limit: 1.5 }, /limit is a whole number from 1/],
      [{ limit: '2' }, /limit is a whole number from 1/],
      [{ limit: Infinity }, /limit is a whole number from 1/],
      [{ limit: null }, /limit is a whole number from 1/],
      [{ limt: 2 }, /ledger\.sweep: 'limt' is not a member it reads; it reads 'limit'/],
      [[], /the second argument is \{ limit\? \}/],
      [5, /the second argument is \{ limit\? \}/],
    ])) {
      await assert.rejects(() => ledger.sweep(1000, options), (/** @type {any} */ e) => e instanceof TypeError && message.test(e.message), JSON.stringify(options));
    }
    assert.deepStrictEqual(await remaining(client), ['a']);
  });
});

describe('createDbLedger — atomicity with a domain write', () => {
  it('a domain write and a settlement in one transaction commit together; a throw after either half leaves neither', async () => {
    const client = await open(MODEL, { driver: nodeDriver(), validator: null });
    cleanups.push(() => client.close());
    const root = createDbLedger(client, { now: () => 1000 });
    const claimed = await root.claim(CLAIM);

    // the throw after the domain write: nothing lands
    await assert.rejects(client.transaction(async (tx) => {
      await tx.collections.notes.insert({ id: 'n1', text: 'first' });
      throw new Error('after the domain write');
    }), /after the domain write/);
    assert.strictEqual(await client.collections.notes.get('n1'), undefined);
    assert.strictEqual((await root.lookup(CLAIM))?.status, 'started');

    // the throw after the settlement: the note and the settlement both roll back
    await assert.rejects(client.transaction(async (tx) => {
      await tx.collections.notes.insert({ id: 'n1', text: 'first' });
      await createDbLedger(tx, { now: () => 1001 }).commit(claimed.ref, RESPONSE);
      throw new Error('after the settlement');
    }), /after the settlement/);
    assert.strictEqual(await client.collections.notes.get('n1'), undefined);
    assert.strictEqual((await root.lookup(CLAIM))?.status, 'started', 'the settlement rolled back with the note');

    // a stale settlement inside the transaction rejects it whole
    const stale = { id: claimed.ref.id, generation: 'not-this-one' };
    await assert.rejects(client.transaction(async (tx) => {
      await tx.collections.notes.insert({ id: 'n1', text: 'first' });
      await createDbLedger(tx, { now: () => 1001 }).commit(stale, RESPONSE);
    }), (/** @type {any} */ err) => err.code === 'JL2007');
    assert.strictEqual(await client.collections.notes.get('n1'), undefined);

    // the whole: both visible after the commit
    await client.transaction(async (tx) => {
      await tx.collections.notes.insert({ id: 'n1', text: 'first' });
      await createDbLedger(tx, { now: () => 1001 }).commit(claimed.ref, RESPONSE);
    });
    assert.strictEqual((await client.collections.notes.get('n1'))?.text, 'first');
    assert.deepStrictEqual(await root.claim({ ...CLAIM, now: 1002 }), { state: 'replay', response: RESPONSE });
  });
});

describe('the ledger record under a real validator', () => {
  it('stores and replays a response whose header REPEATS (set-cookie), so a credential survives a replay', async () => {
    // every other test here opens with `validator: null`; this one runs
    // the model's own schema, because a host settling through
    // createDbLedger with compileSchema on is where a header value the
    // schema does not admit would fail — in production, not here
    const client = await open(idempotencyLedgerModel, { driver: nodeDriver() });
    cleanups.push(() => client.close());
    const ledger = createDbLedger(client);
    const response = {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': ['session=s-1; HttpOnly; Path=/', 'refresh=r-1; HttpOnly; Path=/'],
      },
      body: '{"userId":"u1"}',
    };
    const claimed = await ledger.claim({ op: 'session.refresh', scope: 'anonymous', key: 'k', hash: 'a1'.repeat(32) });
    assert.strictEqual(claimed.state, 'new');
    await ledger.commit(claimed.ref, response);
    const replay = await ledger.claim({ op: 'session.refresh', scope: 'anonymous', key: 'k', hash: 'a1'.repeat(32) });
    assert.strictEqual(replay.state, 'replay');
    assert.deepStrictEqual(replay.response, response);
  });
});
