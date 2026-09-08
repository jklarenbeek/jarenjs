//@ts-check
/**
 * @file The data studio's boot as a closed protocol (lib/boot-stages.js
 * and the boundary's transport): every one of the five stages can be
 * forced to reject and to hang, and both outcomes reach the one stable
 * shape `{ code: 'DATA_BOOT', stage, message }` under a millisecond
 * budget; a genuine OPFS absence still reports the memory topology while
 * a hung pool install never masquerades as one; a failed boot performs no
 * open, seed or live subscription and leaves no worker, client, channel,
 * listener or timer behind; cleanup is idempotent under late settlement;
 * and a retry after a failure reaches ready once, owning one transport
 * and one live subscription.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  BOOT_STAGES, BOOT_ERROR_CODE, DEFAULT_BOOT_BUDGETS, DataBootError, bootFailure,
  resolveBootBudgets, createStageRunner,
} from '../../packages/website/src/lib/boot-stages.js';
import { createTransport, createDataRuntime } from '../../packages/website/src/boundaries/data.js';

/** A tiny budget for every stage: a hang fails in milliseconds. */
const TINY = Object.freeze(Object.fromEntries(BOOT_STAGES.map((stage) => [stage, 20])));

/** A promise that never settles. */
const hang = () => new Promise(() => {});
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = (p) => Promise.resolve(p).then((value) => ({ value }), (error) => ({ error }));

describe('the stage runner', () => {
  it('names the five stages once, and the code every failure carries', () => {
    assert.deepStrictEqual([...BOOT_STAGES], ['worker-start', 'sqlite-init', 'vfs-acquire', 'topology', 'store-open']);
    assert.strictEqual(BOOT_ERROR_CODE, 'DATA_BOOT');
    for (const stage of BOOT_STAGES) assert.ok(DEFAULT_BOOT_BUDGETS[stage] >= 1000, `${stage} has a production budget`);
    const error = new DataBootError('topology', 'no lock manager answered');
    assert.deepStrictEqual(error.toJSON(), { code: 'DATA_BOOT', stage: 'topology', message: 'no lock manager answered' });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(bootFailure('store-open', new Error('JD0002')))),
      { code: 'DATA_BOOT', stage: 'store-open', message: 'JD0002' });
    assert.strictEqual(bootFailure('sqlite-init', error), error, 'a boot failure keeps the stage it names');
    assert.strictEqual(bootFailure('sqlite-init', 'a string').message, 'a string');
  });

  it('resolves budgets from the defaults, taking only positive finite overrides', () => {
    assert.deepStrictEqual(resolveBootBudgets(undefined), DEFAULT_BOOT_BUDGETS);
    const shortened = resolveBootBudgets({ 'sqlite-init': 1500, 'vfs-acquire': 0, topology: 'soon', nope: 5 });
    assert.strictEqual(shortened['sqlite-init'], 1500);
    assert.strictEqual(shortened['vfs-acquire'], DEFAULT_BOOT_BUDGETS['vfs-acquire'], 'a zero budget is ignored');
    assert.strictEqual(shortened.topology, DEFAULT_BOOT_BUDGETS.topology);
    assert.strictEqual('nope' in shortened, false);
  });

  it('resolves, rejects under the stage name, times out under the stage name, and clears its timer on every outcome', async () => {
    /** @type {{ armed: number, cleared: number }} */
    const timers = { armed: 0, cleared: 0 };
    const runner = createStageRunner({
      budgets: TINY,
      setTimer: (fn, ms) => { timers.armed++; return setTimeout(fn, ms); },
      clearTimer: (handle) => { timers.cleared++; clearTimeout(handle); },
    });
    assert.strictEqual(await runner.run('worker-start', () => 'started'), 'started');
    assert.deepStrictEqual(timers, { armed: 1, cleared: 1 });
    const rejected = await settle(runner.run('sqlite-init', () => Promise.reject(new Error('no wasm'))));
    assert.deepStrictEqual(rejected.error.toJSON(), { code: 'DATA_BOOT', stage: 'sqlite-init', message: 'no wasm' });
    const thrown = await settle(runner.run('vfs-acquire', () => { throw new Error('sync'); }));
    assert.deepStrictEqual(thrown.error.toJSON(), { code: 'DATA_BOOT', stage: 'vfs-acquire', message: 'sync' });
    const hung = await settle(runner.run('topology', () => hang()));
    assert.deepStrictEqual(hung.error.toJSON(), { code: 'DATA_BOOT', stage: 'topology', message: 'topology did not finish within 20 ms' });
    assert.strictEqual(timers.armed, 4);
    assert.strictEqual(timers.cleared, 3, 'a fired timer needs no clearing; every settled one was cleared');
    await assert.rejects(runner.run('warm-up', () => 1), TypeError);
  });

  it('a late settlement after a timeout changes nothing, and advance() moves the budget to the next stage', async () => {
    const runner = createStageRunner({ budgets: { ...TINY, 'vfs-acquire': 200 } });
    /** @type {(value: any) => void} */
    let late = () => {};
    const timedOut = await settle(runner.run('sqlite-init', () => new Promise((resolve) => { late = resolve; })));
    assert.strictEqual(timedOut.error.stage, 'sqlite-init');
    late('too late');
    await tick();
    assert.strictEqual(timedOut.error.stage, 'sqlite-init', 'the failure a consumer saw is the failure it keeps');
    // advancing: the first stage's 20 ms budget would fire, but the run moved on to a 200 ms stage
    const advanced = await runner.run('sqlite-init', (advance) => {
      advance('vfs-acquire');
      return new Promise((resolve) => setTimeout(() => resolve('pool'), 60));
    });
    assert.strictEqual(advanced, 'pool');
    // and a stage that overruns after an advance fails under the NEW name
    const overrun = await settle(runner.run('sqlite-init', (advance) => {
      advance('topology');
      return hang();
    }));
    assert.strictEqual(overrun.error.stage, 'topology');
    // an unknown stage is ignored rather than trusted
    const kept = await settle(runner.run('sqlite-init', (advance) => {
      advance('warp');
      return hang();
    }));
    assert.strictEqual(kept.error.stage, 'sqlite-init');
  });
});

/**
 * A fake owner worker: an EventTarget with `postMessage`/`terminate`,
 * whose `data.init` the test scripts. `script.init` returns the status
 * or a promise; `script.stages` names the boot frames the worker announces
 * before answering; `script.start` decides whether the module posts
 * `ready`, fires `error`, or never starts.
 */
function fakeWorld(script = {}) {
  /** @type {any} */
  const counts = { spawned: 0, terminated: 0, clientsOpened: 0, clientsClosed: 0, channelsOpened: 0, channelsClosed: 0, invokes: [], subscriptions: 0, stops: 0 };
  const makeTarget = () => {
    /** @type {Map<string, Set<any>>} */
    const listeners = new Map();
    return {
      listeners,
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
      emit(type, data) { for (const fn of listeners.get(type) ?? []) fn({ data, message: data?.message }); },
      count() { let n = 0; for (const set of listeners.values()) n += set.size; return n; },
    };
  };
  /** @type {any[]} */
  const workers = [];
  /** @type {any[]} */
  const channels = [];
  const deps = {
    budgets: TINY,
    spawnWorker: () => {
      counts.spawned++;
      const target = makeTarget();
      const worker = { ...target, terminate: () => { counts.terminated++; } };
      workers.push(worker);
      queueMicrotask(() => {
        if (script.start === 'error') worker.emit('error', { message: 'the module failed to load' });
        else if (script.start !== 'never') worker.emit('message', { ready: true });
      });
      return worker;
    },
    openChannel: () => {
      counts.channelsOpened++;
      const channel = { ...makeTarget(), close: () => { counts.channelsClosed++; } };
      channels.push(channel);
      return channel;
    },
    openClient: (channel) => {
      counts.clientsOpened++;
      return {
        invoke: async (op) => {
          counts.invokes.push(op);
          if (op === 'data.init') {
            for (const stage of script.stages ?? ['sqlite-init', 'vfs-acquire']) channel.emit('message', { boot: stage });
            const answer = typeof script.init === 'function' ? script.init() : script.init;
            if (answer instanceof Promise) {
              try { return { ok: true, value: await answer }; }
              catch (error) { return { ok: false, error: { code: 'db', message: 'init failed', details: { code: null, message: error.message } } }; }
            }
            return { ok: true, value: answer };
          }
          if (op === 'data.open') {
            const answer = typeof script.open === 'function' ? script.open() : script.open;
            if (answer instanceof Promise) {
              try { return { ok: true, value: await answer }; }
              catch (error) { return { ok: false, error: { code: 'db', message: 'open failed', details: { code: 'JD0002', message: error.message } } }; }
            }
            return { ok: true, value: answer ?? { collection: 'notes', keyPointer: '/id', capabilities: { capture: 'journal', version: '3', operators: [], pushableOperators: [] } } };
          }
          if (op === 'data.rows') return { ok: true, value: [] };
          if (op === 'data.lives') return { ok: true, value: { count: 1 } };
          return { ok: true, value: null };
        },
        subscribe: () => { counts.subscriptions++; return { stop: () => { counts.stops++; } }; },
        close: () => { counts.clientsClosed++; },
      };
    },
  };
  const live = () => workers.reduce((n, worker) => n + worker.count(), 0) + channels.reduce((n, channel) => n + channel.count(), 0);
  return { deps, counts, workers, channels, live };
}

const OWNER = { topology: 'owner', vfs: 'opfs-sahpool', version: '3.51' };
const MEMORY = { topology: 'memory', vfs: 'memory', version: '3.51', refusal: { code: 'JD2061', message: 'OPFS is unavailable in this context' } };

describe('the transport boots through named stages and tears down on failure', () => {
  it('boots an owner: worker-start, then the worker\'s announced stages, then the status', async () => {
    const world = fakeWorld({ init: OWNER });
    const transport = createTransport(world.deps);
    assert.deepStrictEqual(await transport.boot(), OWNER);
    assert.deepStrictEqual(world.counts.invokes, ['data.init']);
    assert.strictEqual(transport.stage(), 'vfs-acquire', 'the last stage the worker announced');
    transport.close();
    transport.close();
    assert.deepStrictEqual([world.counts.terminated, world.counts.clientsClosed, world.live()], [1, 1, 0], 'closed once, nothing listening');
  });

  it('a genuine OPFS absence still reports the memory topology', async () => {
    const world = fakeWorld({ init: MEMORY, stages: ['sqlite-init', 'vfs-acquire', 'topology'] });
    const transport = createTransport(world.deps);
    assert.deepStrictEqual(await transport.boot(), MEMORY);
    transport.close();
  });

  it('a client topology moves to the shared channel and releases the direct worker', async () => {
    const CLIENT = { topology: 'client', vfs: 'opfs-sahpool', version: '3.51', refusal: { code: 'JD2061', message: 'another context owns the database' } };
    const world = fakeWorld({ init: CLIENT, stages: ['sqlite-init', 'vfs-acquire', 'topology'] });
    const transport = createTransport(world.deps);
    assert.deepStrictEqual(await transport.boot(), CLIENT);
    assert.deepStrictEqual([world.counts.terminated, world.counts.channelsOpened, world.counts.clientsOpened], [1, 1, 2]);
    transport.close();
    assert.deepStrictEqual([world.counts.channelsClosed, world.counts.clientsClosed, world.live()], [1, 2, 0]);
  });

  it('every stage can be forced to reject and to hang, and both reach { code, stage, message } under the tiny budget', async () => {
    const cases = [
      ['worker-start', 'reject', { start: 'error' }],
      ['worker-start', 'hang', { start: 'never' }],
      ['sqlite-init', 'reject', { stages: ['sqlite-init'], init: () => Promise.reject(new Error('wasm fetch failed')) }],
      ['sqlite-init', 'hang', { stages: ['sqlite-init'], init: () => hang() }],
      ['vfs-acquire', 'reject', { stages: ['sqlite-init', 'vfs-acquire'], init: () => Promise.reject(new Error('pool install threw')) }],
      ['vfs-acquire', 'hang', { stages: ['sqlite-init', 'vfs-acquire'], init: () => hang() }],
      ['topology', 'reject', { stages: ['sqlite-init', 'vfs-acquire', 'topology'], init: () => Promise.reject(new Error('lock manager refused')) }],
      ['topology', 'hang', { stages: ['sqlite-init', 'vfs-acquire', 'topology'], init: () => hang() }],
    ];
    for (const [stage, how, script] of cases) {
      const world = fakeWorld(script);
      const transport = createTransport(world.deps);
      const failed = await settle(transport.boot());
      assert.ok(failed.error instanceof DataBootError, `${stage}/${how}: a boot failure`);
      assert.strictEqual(failed.error.code, 'DATA_BOOT');
      assert.strictEqual(failed.error.stage, stage, `${stage}/${how}: ${failed.error.message}`);
      assert.ok(how === 'hang' ? /did not finish within 20 ms/.test(failed.error.message) : failed.error.message.length > 0);
      transport.close();
      assert.strictEqual(world.live(), 0, `${stage}/${how}: no listener survives close`);
      assert.strictEqual(world.counts.terminated, world.counts.spawned, `${stage}/${how}: every worker terminated`);
    }
    // the fifth stage: the first store open, bounded by the boot effect
    for (const [how, script] of [['reject', { init: OWNER, open: () => Promise.reject(new Error('JD0002 read-only')) }], ['hang', { init: OWNER, open: () => hang() }]]) {
      const world = fakeWorld(script);
      const transport = createTransport(world.deps);
      await transport.boot();
      const failed = await settle(transport.bounded('store-open', () => transport.request('data.open', { model: {} })));
      assert.strictEqual(failed.error.stage, 'store-open', `store-open/${how}`);
      assert.strictEqual(failed.error.code, 'DATA_BOOT');
      transport.close();
      assert.strictEqual(world.live(), 0);
    }
  });

  it('a hung pool install fails as vfs-acquire, never as a memory fallback', async () => {
    const world = fakeWorld({ stages: ['sqlite-init', 'vfs-acquire'], init: () => hang() });
    const transport = createTransport(world.deps);
    const failed = await settle(transport.boot());
    assert.strictEqual(failed.error.stage, 'vfs-acquire');
    assert.strictEqual(failed.value, undefined, 'no status — in particular no memory topology — was answered');
    transport.close();
  });
});

describe('the boot effect is terminal', () => {
  /** The runtime over an injected transport factory, with a recording dispatch. */
  function harness(scripts) {
    let attempt = 0;
    /** @type {ReturnType<typeof fakeWorld>[]} */
    const worlds = [];
    const runtime = createDataRuntime({
      transport: () => {
        const world = fakeWorld(scripts[Math.min(attempt++, scripts.length - 1)]);
        worlds.push(world);
        return createTransport(world.deps);
      },
    });
    /** @type {{ name: string, payload: any }[]} */
    const calls = [];
    const dispatch = (name, payload) => calls.push({ name, payload });
    return { runtime, calls, dispatch, worlds, names: () => calls.map((call) => call.name) };
  }

  it('a failed stage dispatches data/boot-error with the exact record, performs no open, seed or subscription, and leaves zero resources', async () => {
    const { runtime, calls, dispatch, worlds, names } = harness([{ stages: ['sqlite-init'], init: () => Promise.reject(new Error('wasm fetch failed')) }]);
    await runtime.effects['data-boot']({}, dispatch);
    assert.deepStrictEqual(names(), ['data/seed', 'data/boot-error']);
    assert.deepStrictEqual(calls[1].payload, { code: 'DATA_BOOT', stage: 'sqlite-init', message: 'wasm fetch failed' });
    const [world] = worlds;
    assert.deepStrictEqual(world.counts.invokes, ['data.init'], 'no data.open, no seed insert, no rows read');
    assert.strictEqual(world.counts.subscriptions, 0);
    assert.deepStrictEqual([world.counts.terminated, world.counts.clientsClosed, world.live()], [1, 1, 0]);
  });

  it('a failed first open is the store-open stage, with the store\'s message', async () => {
    const { runtime, calls, dispatch, worlds, names } = harness([{ init: OWNER, open: () => Promise.reject(new Error('the database is read-only')) }]);
    await runtime.effects['data-boot']({}, dispatch);
    assert.deepStrictEqual(names(), ['data/seed', 'data/status', 'data/boot-error']);
    assert.deepStrictEqual(calls[2].payload, { code: 'DATA_BOOT', stage: 'store-open', message: 'the database is read-only' });
    assert.strictEqual(worlds[0].counts.subscriptions, 0);
    assert.strictEqual(worlds[0].live(), 0);
  });

  it('a successful owner boot reaches data/opened once, with one live subscription; a client attaches to the current model', async () => {
    const owner = harness([{ init: OWNER }]);
    await owner.runtime.effects['data-boot']({}, owner.dispatch);
    assert.deepStrictEqual(owner.names().slice(0, 3), ['data/seed', 'data/status', 'data/opened']);
    assert.strictEqual(owner.names().filter((name) => name === 'data/boot-error').length, 0);
    assert.strictEqual(owner.worlds[0].counts.subscriptions, 1);
    const CLIENT = { topology: 'client', vfs: 'opfs-sahpool', version: '3.51' };
    const client = harness([{ init: CLIENT, stages: ['sqlite-init', 'vfs-acquire', 'topology'] }]);
    await client.runtime.effects['data-boot']({}, client.dispatch);
    assert.deepStrictEqual(client.names().slice(0, 3), ['data/seed', 'data/status', 'data/opened']);
    assert.ok(client.worlds[0].counts.invokes.includes('data.open'), 'a client attaches through the non-reset channel handler');
    assert.ok(!client.worlds[0].counts.invokes.includes('data.insert'), 'a client never seeds the owner');
    assert.strictEqual(client.worlds[0].counts.subscriptions, 1);
  });

  it('a retry after a failure reaches ready once and owns exactly one transport and one live subscription', async () => {
    const { runtime, dispatch, worlds, names } = harness([
      { start: 'never' },
      { init: OWNER },
    ]);
    await runtime.effects['data-boot']({}, dispatch);
    assert.deepStrictEqual(names(), ['data/seed', 'data/boot-error']);
    await runtime.effects['data-retry']({}, dispatch);
    const after = names().slice(2);
    assert.deepStrictEqual(after.slice(0, 2), ['data/status', 'data/opened']);
    assert.strictEqual(after.filter((name) => name === 'data/opened').length, 1);
    assert.strictEqual(worlds.length, 2, 'one transport per attempt');
    assert.deepStrictEqual([worlds[0].live(), worlds[0].counts.terminated], [0, 1], 'the failed attempt left nothing');
    assert.strictEqual(worlds[1].counts.subscriptions, 1, 'the retry owns one live subscription');
    assert.strictEqual(worlds[1].counts.stops, 0);
    // a retry over a healthy boot closes the previous transport first: still one of everything
    await runtime.effects['data-retry']({}, dispatch);
    assert.strictEqual(worlds.length, 3);
    assert.deepStrictEqual([worlds[1].counts.terminated, worlds[1].counts.stops, worlds[1].live()], [1, 1, 0]);
    assert.strictEqual(worlds[2].counts.subscriptions, 1);
  });
});

describe('quirks pinned after the boot protocol landed', () => {
  const OWNER_STATUS = { topology: 'owner', vfs: 'opfs-sahpool', version: '3.51' };

  it('the durability verdict is withheld until the topology is known, and a client tab does not claim "none registered"', async () => {
    const { dataViewModel } = await import('../../packages/website/src/boundaries/data.js');
    const { createInitialState } = await import('../../packages/website/src/app/state.js');
    const booting = createInitialState();
    assert.strictEqual(booting.data.status, 'boot');
    assert.match(dataViewModel(booting).durability, /not decided yet/);
    assert.strictEqual(dataViewModel(booting).operatorSummary, '—');
    const memory = { ...booting, data: { ...booting.data, status: 'ready', topology: 'memory', vfs: 'memory' } };
    assert.match(dataViewModel(memory).durability, /in-memory/);
    assert.strictEqual(dataViewModel(memory).operatorSummary, 'none registered');
    const client = { ...booting, data: { ...booting.data, status: 'ready', topology: 'client', vfs: 'opfs-sahpool' } };
    assert.match(dataViewModel(client).durability, /persistent/);
    assert.match(dataViewModel(client).operatorSummary, /owner's/);
    client.data.capture = 'session';
    assert.strictEqual(dataViewModel(client).operatorSummary, 'none registered',
      'an attached client reports the capabilities it actually received');
    assert.strictEqual('booted' in booting.data, false, 'no dead state member');
  });

  it('only the five stages move the transport\'s stage: a foreign frame cannot rename a failure', async () => {
    const world = fakeWorld({ init: OWNER_STATUS, stages: ['sqlite-init', 'warp-core', 'vfs-acquire'] });
    const transport = createTransport(world.deps);
    await transport.boot();
    assert.strictEqual(transport.stage(), 'vfs-acquire');
    transport.close();
  });

  it('a worker fault after a settled boot is reported as an error, not swallowed', async () => {
    const world = fakeWorld({ init: OWNER_STATUS });
    const transport = createTransport(world.deps);
    await transport.boot();
    transport.settled();
    /** @type {any[]} */
    const faults = [];
    transport.faults((fault) => faults.push(fault));
    world.workers[0].emit('error', { message: 'died' });
    assert.deepStrictEqual(faults, [{ message: 'the data worker stopped: died' }]);
    transport.close();
  });

  it('two overlapping boots: the superseded attempt says nothing, and one transport with one subscription survives', async () => {
    /** @type {ReturnType<typeof fakeWorld>[]} */
    const worlds = [];
    const runtime = createDataRuntime({ transport: () => {
      const world = fakeWorld({ init: OWNER_STATUS, open: () => new Promise((resolve) => setTimeout(resolve, 15)) });
      worlds.push(world);
      return createTransport(world.deps);
    } });
    /** @type {string[]} */
    const names = [];
    const dispatch = (name) => names.push(name);
    await Promise.all([runtime.effects['data-boot']({}, dispatch), runtime.effects['data-retry']({}, dispatch)]);
    assert.ok(!names.includes('data/boot-error'), `no error over a working store: ${names.join(' · ')}`);
    assert.strictEqual(names.filter((name) => name === 'data/opened').length, 1, 'the surviving attempt opened once');
    assert.strictEqual(worlds.length, 2);
    assert.deepStrictEqual([worlds[0].counts.terminated, worlds[0].counts.subscriptions], [1, 0], 'the superseded attempt was closed and never subscribed');
    assert.strictEqual(worlds[1].counts.subscriptions, 1);
  });

  it('a store-bound effect with no booted store says so instead of doing nothing or throwing', async () => {
    const runtime = createDataRuntime({ transport: () => createTransport(fakeWorld({ init: OWNER_STATUS }).deps) });
    for (const [effect, props] of [['data-run', { text: '{"$for":{"it":"$[*]"},"$return":"$it"}' }], ['data-open', { text: '{}' }], ['data-insert', { title: 'x' }], ['data-delete', { key: 'k' }], ['data-migrate', {}]]) {
      /** @type {any[]} */
      const calls = [];
      await runtime.effects[effect](props, (name, payload) => calls.push([name, payload?.message]));
      assert.deepStrictEqual(calls, [['data/error', 'the store is not booted — retry the boot first']], effect);
    }
  });

  it('a boot works on the seed model\'s first collection, and dispatches it with the open', async () => {
    const runtime = createDataRuntime({ transport: () => createTransport(fakeWorld({ init: OWNER_STATUS }).deps) });
    /** @type {any[]} */
    const calls = [];
    await runtime.effects['data-boot']({}, (name, payload) => calls.push({ name, payload }));
    const opened = calls.find((call) => call.name === 'data/opened');
    assert.strictEqual(opened.payload.collection, 'notes');
    assert.strictEqual(opened.payload.keyPointer, '/id');
  });
});
