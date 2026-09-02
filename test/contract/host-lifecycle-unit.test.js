//@ts-check
/**
 * @file The host lifecycle coordinator on its own (docs/CONTRACT-FORMAT.md
 * §7.7): hook validation at construction, the exact defaults, lease
 * validation for every malformed shape, the branded declared failure
 * against shape-compatible impostors, sync and async hooks, `enter`
 * called never/once/twice, a hook that resolves before `enter` settled,
 * the rollback carrier through a host transaction, and once-guarded
 * releases whose failures are observed and swallowed.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { ContractFailure } from '@jarenjs/contract';
import {
  resolveLifecycle, leaseOf, once, classifyAnswer, identify, acquire, HostLifecycleError, RollbackCarrier,
} from '../../packages/contract/src/host.js';

const host = (/** @type {string} */ reason) => new Error(`refused: ${reason}`);
const META = /** @type {any} */ ({ op: { id: 'x' }, trace: 't', signal: null, carrier: 'http', method: 'GET', path: '/x', headers: {}, fail: ContractFailure });

describe('host lifecycle — hooks and defaults', () => {
  it('validates the hooks at construction and defaults both', () => {
    assert.throws(() => resolveLifecycle({ identify: /** @type {any} */ (5) }, host), /options.identify must be a function/);
    assert.throws(() => resolveLifecycle({ acquire: /** @type {any} */ ('x') }, host), /options.acquire must be a function/);
    const l = resolveLifecycle({}, host);
    assert.deepStrictEqual(Object.keys(l), ['identify', 'acquire'], 'exactly the two hooks, nothing half-wired beside them');
    assert.deepStrictEqual(l.identify(META), { host: null });
    assert.strictEqual(Object.isFrozen(l), true);
  });

  it('the default acquire enters with the identity host, and only that', async () => {
    const l = resolveLifecycle({ identify: () => ({ host: 'id' }) }, host);
    const seen = [];
    const out = await acquire(l, { in: 1 }, { host: 'id' }, (lease) => { seen.push(lease); return 'result'; });
    assert.deepStrictEqual(seen, [{ host: 'id', release: undefined, settlement: null }]);
    assert.deepStrictEqual(out, { kind: 'entered', lease: { host: 'id', release: undefined, settlement: null }, result: 'result', rolledBack: null });
  });
});

describe('host lifecycle — leases', () => {
  it('a lease is an object with an own host; release optional and a function; a settlement only on acquire', () => {
    assert.deepStrictEqual(leaseOf({ host: 1 }, 'identify'), { host: 1, release: undefined, settlement: null });
    const release = () => {};
    assert.deepStrictEqual(leaseOf({ host: null, release }, 'acquire'), { host: null, release, settlement: null });
    const ledger = { commit() {}, fail() {} };
    assert.deepStrictEqual(leaseOf({ host: 2, settlement: { ledger, required: true } }, 'acquire'), { host: 2, release: undefined, settlement: { ledger, required: true } });
    for (const bad of [null, undefined, 5, 'host', {}, Object.create({ host: 1 }), { host: 1, release: 5 }]) {
      assert.throws(() => leaseOf(bad, 'identify'), HostLifecycleError, JSON.stringify(bad));
    }
    for (const settlement of [{ ledger, required: false }, { ledger: {}, required: true }, { required: true }, 'x', 5]) {
      assert.throws(() => leaseOf({ host: 1, settlement }, 'acquire'), HostLifecycleError);
    }
    assert.throws(() => leaseOf({ host: 1, settlement: { ledger, required: true } }, 'identify'), /belongs to the acquired lease/);
  });

  it('a declared failure is recognized by brand, never by shape', () => {
    const real = ContractFailure('gone', { a: 1 });
    assert.deepStrictEqual(classifyAnswer(real, 'identify'), { kind: 'failure', failure: real });
    const impostor = { code: 'gone', params: {}, details: undefined, retryable: null };
    const answer = classifyAnswer(impostor, 'identify');
    assert.strictEqual(answer.kind, 'fault', 'a shape-compatible object is a malformed lease, not a failure');
    const hostile = { get host() { throw new Error('hostile'); } };
    assert.strictEqual(classifyAnswer(hostile, 'acquire').kind, 'fault', 'a host accessor that throws is a malformed lease, read once here and never again');
  });
});

describe('host lifecycle — identify', () => {
  it('sync and async answers classify alike; a throw or rejection is a fault', async () => {
    assert.deepStrictEqual(identify(resolveLifecycle({ identify: () => ({ host: 'a' }) }, host), META), { kind: 'lease', lease: { host: 'a', release: undefined, settlement: null } });
    assert.deepStrictEqual(await identify(resolveLifecycle({ identify: async () => ({ host: 'b' }) }, host), META), { kind: 'lease', lease: { host: 'b', release: undefined, settlement: null } });
    const thrown = identify(resolveLifecycle({ identify: () => { throw new Error('boom'); } }, host), META);
    assert.strictEqual(thrown.kind, 'fault');
    const rejected = await identify(resolveLifecycle({ identify: async () => { throw new Error('boom'); } }, host), META);
    assert.strictEqual(rejected.kind, 'fault');
    const failed = identify(resolveLifecycle({ identify: (meta) => meta.fail('gone') }, host), META);
    assert.strictEqual(failed.kind, 'failure');
  });
});

describe('host lifecycle — acquire', () => {
  const lifecycle = (/** @type {any} */ fn) => resolveLifecycle({ acquire: fn }, host);

  it('enter never called without a declared failure, called twice, or the hook resolving early are faults', async () => {
    const never = await acquire(lifecycle(() => 'nothing'), null, { host: null }, () => 'r');
    assert.strictEqual(never.kind, 'fault');
    assert.match(String(/** @type {any} */ (never).cause.message), /without calling enter/);
    const twice = await acquire(lifecycle(async (input, identity, enter) => { await enter({ host: 1 }); return enter({ host: 2 }); }), null, { host: null }, () => 'r');
    assert.strictEqual(twice.kind, 'fault');
    assert.match(String(/** @type {any} */ (twice).cause.message), /more than once/);
    const early = await acquire(lifecycle((input, identity, enter) => { enter({ host: 1 }); return 'early'; }), null, { host: null }, () => new Promise(() => {}));
    assert.strictEqual(early.kind, 'fault');
    assert.match(String(/** @type {any} */ (early).cause.message), /before enter settled/);
  });

  it('a declared failure instead of entering; a throw, a rejection and a malformed lease are faults', async () => {
    const failed = await acquire(lifecycle(() => ContractFailure('gone')), null, { host: null }, () => 'r');
    assert.strictEqual(failed.kind, 'failure');
    assert.strictEqual((await acquire(lifecycle(() => { throw new Error('x'); }), null, { host: null }, () => 'r')).kind, 'fault');
    assert.strictEqual((await acquire(lifecycle(async () => { throw new Error('x'); }), null, { host: null }, () => 'r')).kind, 'fault');
    const malformed = await acquire(lifecycle((input, identity, enter) => enter({ nohost: 1 })), null, { host: null }, () => 'r');
    assert.strictEqual(malformed.kind, 'fault');
  });

  it('the rollback carrier: enter rejects with the intended response, a host transaction rolls back, the result is that response', async () => {
    const log = [];
    const transaction = async (/** @type {() => Promise<unknown>} */ fn) => {
      log.push('begin');
      try {
        const out = await fn();
        log.push('commit');
        return out;
      }
      catch (err) {
        log.push('rollback');
        throw err;
      }
    };
    const l = lifecycle((input, identity, enter) => transaction(() => enter({ host: 'tx' })));
    const fault = { status: 500 };
    const out = await acquire(l, null, { host: null }, () => Promise.reject(new RollbackCarrier(fault, new Error('handler threw'))));
    assert.strictEqual(out.kind, 'entered');
    assert.strictEqual(/** @type {any} */ (out).result, fault);
    assert.ok(/** @type {any} */ (out).rolledBack instanceof RollbackCarrier);
    assert.deepStrictEqual(log, ['begin', 'rollback']);
    // a host that wraps the carrier in a rejection of its own still rolls back to the intended fault
    const wrapping = lifecycle((input, identity, enter) => transaction(() => enter({ host: 'tx' })).catch((err) => { throw new Error('wrapped', { cause: err }); }));
    const wrapped = await acquire(wrapping, null, { host: null }, () => Promise.reject(new RollbackCarrier(fault, new Error('x'))));
    assert.strictEqual(wrapped.kind, 'entered');
    assert.strictEqual(/** @type {any} */ (wrapped).result, fault);
    // a rejection of enter that is NOT our carrier is a fault of the continuation
    const other = await acquire(l, null, { host: null }, () => Promise.reject(new Error('continuation broke')));
    assert.strictEqual(other.kind, 'fault');
  });

  it('a hook that rejects after enter settled keeps the settled result and reports the rejection', async () => {
    const l = lifecycle(async (input, identity, enter) => { await enter({ host: 1 }); throw new Error('after'); });
    const out = await acquire(l, null, { host: null }, () => 'done');
    assert.strictEqual(out.kind, 'entered');
    assert.strictEqual(/** @type {any} */ (out).result, 'done');
    assert.match(String(/** @type {any} */ (out).afterFault.message), /after/);
  });
});

describe('host lifecycle — once', () => {
  it('runs a release once, sync or async; a throw or rejection is observed and swallowed; none is a no-op', async () => {
    let n = 0;
    const observed = [];
    const r = once(() => { n += 1; }, (e) => observed.push(e));
    assert.strictEqual(await r(), true);
    assert.strictEqual(await r(), true, 'a later call is clean and runs nothing');
    assert.strictEqual(n, 1);
    const a = once(async () => { n += 1; }, (e) => observed.push(e));
    assert.deepStrictEqual(await Promise.all([a(), a()]), [true, true]);
    assert.strictEqual(n, 2);
    assert.strictEqual(await once(() => { throw new Error('t'); }, (e) => observed.push(e))(), false);
    assert.strictEqual(await once(async () => { throw new Error('r'); }, (e) => observed.push(e))(), false);
    assert.deepStrictEqual(observed.map((e) => /** @type {any} */ (e).message), ['t', 'r']);
    assert.strictEqual(await once(undefined, (e) => observed.push(e))(), true);
    assert.strictEqual(observed.length, 2);
  });
});
