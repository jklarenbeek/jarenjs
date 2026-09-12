//@ts-check
import { openPortClient } from '@jarenjs/contract/port';
import { dataContract } from './contract.js';
import { createStageRunner, bootFailure, BOOT_STAGES } from './boot-stages.js';

/**
 * The browser-shaped dependencies of a transport: how a worker is
 * spawned, how a port client is opened over a channel, how the shared
 * channel is opened, and the stage budgets. The page supplies the
 * platform's; a Node test supplies fakes and millisecond budgets.
 * @typedef {Object} TransportDeps
 * @property {() => any} spawnWorker - a fresh owner worker
 * @property {(channel: any) => any} [openClient] - a port client over a channel
 * @property {() => any} openChannel - the shared tab channel
 * @property {Readonly<Record<string, number>>} [budgets] - per-stage budgets
 * @property {(fn: () => void, ms: number) => any} [setTimer]
 * @property {(handle: any) => void} [clearTimer]
 */

/**
 * The transport: a contract PORT client over the own worker (owner) or
 * the shared channel (client). `request` unwraps the binding's D6
 * outcome into the value-or-throw shape the effects consume — a
 * declared `db` failure surfaces the store's own code and message from
 * its details; `subscribe` is the client's stream half, passed through.
 *
 * `boot()` is the closed protocol of `lib/boot-stages.js`: the worker
 * starting (its `ready` frame, or its `error` event), then the worker's
 * own `data.init` under the three stages it announces as it passes them
 * (`sqlite-init`, `vfs-acquire`, `topology`) — each bounded from here,
 * so a stage the worker never finishes fails under its own name and
 * never masquerades as an OPFS absence. `bounded('store-open', …)` is
 * the fifth stage, run by the boot effect around the first open.
 * `close()` releases everything this transport created — the client,
 * the worker, the shared channel, the listeners — exactly once, so a
 * failed boot leaves nothing behind and a retry starts clean.
 * @param {TransportDeps} [deps]
 */
export function createTransport(deps) {
  const openClient = deps.openClient ?? (channel => openPortClient(dataContract, { channel, timeoutMs: 30_000 }));
  const runner = createStageRunner({ budgets: deps.budgets, setTimer: deps.setTimer, clearTimer: deps.clearTimer });
  /** @type {any} */
  let client = null;
  /** @type {any} */
  let worker = null;
  /** @type {any} */
  let shared = null;
  /** @type {{ target: any, type: string, fn: any }[]} */
  const listeners = [];
  let closed = false;
  /** The stage a boot is in, for a failure that arrives outside a run. */
  let stage = BOOT_STAGES[0];

  /** @param {any} outcome */
  const unwrap = (outcome) => {
    if (outcome.ok) return outcome.value;
    const details = outcome.error.details;
    const dbError = details !== null && typeof details === 'object' && typeof details.message === 'string';
    const error = new Error(dbError ? details.message : outcome.error.message);
    /** @type {any} */ (error).code = dbError ? details.code : outcome.error.code;
    throw error;
  };

  const request = async (op, args) => {
    if (client === null) throw new Error('the data transport is closed');
    return unwrap(await client.invoke(op, args));
  };

  /** @param {any} input @param {any} callbacks */
  const subscribe = (input, callbacks) => client.subscribe('data.live', input, callbacks);

  /** @type {((notice: any) => void) | null} */
  let onNotice = null;
  /** @type {((stage: string) => void) | null} */
  let onStage = null;
  /** @type {((fault: { message: string }) => void) | null} */
  let onFault = null;
  /** Whether the boot has settled: a worker `error` after that is a fault
   * of a running store, not of a boot stage, and is reported as one. */
  let booted = false;
  /** Attach a listener this transport will detach on close. */
  const on = (/** @type {any} */ target, /** @type {string} */ type, /** @type {any} */ fn) => {
    target.addEventListener(type, fn);
    listeners.push({ target, type, fn });
  };
  /** The owner's store-changed notices and the worker's boot-stage
   * announcements travel beside the contract frames on whichever
   * transport this tab ended up on, and are told apart by shape — the
   * same arrangement the owner-discovery frames use. */
  const listen = (/** @type {any} */ target) => {
    on(target, 'message', (/** @type {any} */ event) => {
      const message = event.data;
      if (message === null || typeof message !== 'object') return;
      if (typeof message.boot === 'string') {
        // only the five stages are stages: a foreign frame on the shared
        // channel cannot rename the failure this tab reports
        if (BOOT_STAGES.includes(message.boot)) {
          stage = message.boot;
          onStage?.(message.boot);
        }
        return;
      }
      if (message.store !== undefined) onNotice?.(message);
    });
  };

  /** Release everything created here, once; a second close is a no-op. */
  const close = () => {
    if (closed) return;
    closed = true;
    runner.dispose();
    for (const { target, type, fn } of listeners) {
      try {
        target.removeEventListener(type, fn);
      }
      catch { /* a terminated worker may refuse; nothing to release then */ }
    }
    listeners.length = 0;
    try {
      client?.close();
    }
    catch { /* already closed */ }
    client = null;
    try {
      worker?.terminate();
    }
    catch { /* already gone */ }
    worker = null;
    try {
      shared?.close();
    }
    catch { /* already closed */ }
    shared = null;
    onNotice = null;
    onStage = null;
    onFault = null;
  };

  /**
   * One bounded stage. A failure inside it — the work's, or its budget
   * running out — is the named boot failure, and never something else.
   * @param {string} name @param {(advance: (next: string) => void) => any} work
   */
  const bounded = (name, work) => {
    stage = name;
    return runner.run(name, work);
  };

  /** The worker has started when its module posts `{ ready: true }`; a
   * module that fails to load fires `error` instead. */
  const workerStart = () => new Promise((resolve, reject) => {
    on(worker, 'message', (/** @type {any} */ event) => {
      if (event.data !== null && typeof event.data === 'object' && event.data.ready === true) resolve(true);
    });
    on(worker, 'error', (/** @type {any} */ event) => {
      const message = typeof event?.message === 'string' && event.message.length > 0
        ? event.message : 'the data worker failed';
      if (booted) {
        // the store was up: the page must not go on reading `ready`
        onFault?.({ message: `the data worker stopped: ${message}` });
        return;
      }
      reject(bootFailure('worker-start', new Error(message)));
    });
  });

  const boot = async () => {
    if (closed) throw bootFailure('worker-start', new Error('the data transport is closed'));
    worker = deps.spawnWorker();
    client = openClient(worker);
    listen(worker);
    await bounded('worker-start', () => workerStart());
    // the worker's init announces its own stages as it passes them; each
    // announcement moves the budget to the next stage
    const status = await bounded('sqlite-init', (advance) => {
      onStage = advance;
      return request('data.init', null);
    });
    onStage = null;
    if (status.topology !== 'client') {
      // 'owner' (holds the OPFS pool) or 'memory' (OPFS absent — a
      // standalone in-memory store): either way this worker IS the
      // connection; an owner also serves the channel for client tabs.
      return status;
    }
    // another context owns the pool: downgrade to a CLIENT over the
    // channel; this direct worker has nothing to hold, so it dies.
    client.close();
    worker.terminate();
    client = null;
    worker = null;
    shared = deps.openChannel();
    listen(shared);
    client = openClient(shared);
    return status;
  };
  /** The boot settled: later worker faults are the running store's. */
  const settled = () => { booted = true; };

  return {
    boot,
    bounded,
    request,
    subscribe,
    close,
    /** The stage the last boot reached (for a failure outside a run). */
    stage: () => stage,
    /** @param {(notice: any) => void} cb */
    notices: (cb) => { onNotice = cb; },
    /** @param {(fault: { message: string }) => void} cb - a worker that
     * fails after the boot settled */
    faults: (cb) => { onFault = cb; },
    settled,
  };
}
