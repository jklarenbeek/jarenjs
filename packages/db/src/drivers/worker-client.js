//@ts-check
/** Shared bounded RPC Connection client for owned SQLite execution hosts. */
import { finishConnection } from '../driver.js';
import { sqliteDialect } from '../dialects/sqlite.js';
import { DbRuntimeError } from '../errors.js';
import { generationFailure, queueFailure, rowBytes, validResponse, validResult } from './worker-protocol.js';

/** @param {any} worker @param {any} settings @returns {Promise<any>} */
export async function createWorkerConnection(worker, settings) {
  const { epoch, options, limits, maxPending, allRows, allBytes, closeMs, startupMs, reopen, hooks = {} } = settings;
  const pending = new Map();
  let sequence = 0;
  let failed = null;
  let closing = false;
  let closed = false;
  let transactionDepth = 0;
  let closePromise;
  const metrics = { frames: 0, rows: 0, maxFrameRows: 0, maxFrameBytes: 0, maxPending: 0 };
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const lose = (cause) => {
    if (failed !== null || closed) return;
    failed = generationFailure(epoch, transactionDepth > 0, cause);
    hooks.lost?.(failed, [...pending.values()]);
    readyReject(failed);
    for (const request of pending.values()) request.reject(failed);
    pending.clear();
  };
  hooks.control?.({ lose });
  worker.on('error', lose);
  worker.on('exit', (code) => { if (!closed) lose(new Error(`worker exited (${code})`)); });
  worker.on('message', (message) => {
    if (!validResponse(message, epoch)) { lose(new Error('invalid worker response')); return; }
    if (message.kind === 'ready') { readyResolve(message.capabilities); return; }
    if (message.kind === 'failure' && message.id === 0) {
      readyReject(Object.assign(new Error(message.error.message), message.error)); return;
    }
    const request = pending.get(message.id);
    if (request === undefined) return;
    pending.delete(message.id);
    if (message.kind === 'failure') {
      hooks.failure?.(request.op, request.data, message.transaction);
      const error = message.error;
      request.reject(Object.assign(error.code?.startsWith('JD')
        ? new DbRuntimeError(error.code, error.message) : new Error(error.message), error));
    }
    else if (message.kind === 'result' && validResult(request.op, message.value, limits)) {
      hooks.result?.(request.op, request.data, message.value, message.transaction); request.resolve(message.value);
    }
    else { request.reject(generationFailure(epoch, transactionDepth > 0)); lose(new Error('invalid worker response')); }
  });
  const timer = setTimeout(() => { lose(new Error('worker startup timed out')); worker.terminate(); }, startupMs);
  let capabilities;
  try { capabilities = await ready; }
  catch (error) {
    const termination = worker.terminate();
    if (settings.awaitStartupExit !== false) await termination;
    else termination.catch(() => {});
    throw error;
  }
  finally { clearTimeout(timer); }
  const request = (op, data = {}, cleanup = false) => {
    if (failed !== null) return Promise.reject(failed);
    if (closed || (closing && !cleanup)) return Promise.reject(new DbRuntimeError('JD2063', 'the worker connection is closing or closed'));
    if (!cleanup && pending.size >= maxPending)
      return Promise.reject(queueFailure(`worker request capacity ${maxPending} exceeded`, pending.size));
    // One return per live cursor and one close have reserved capacity.
    if (cleanup && pending.size >= maxPending + limits.cursors + 1)
      return Promise.reject(queueFailure('worker cleanup capacity exceeded', pending.size));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, op, data });
      metrics.maxPending = Math.max(metrics.maxPending, pending.size);
      try { hooks.request?.(op, data); worker.postMessage({ v: 1, generation: epoch, kind: 'request', id, op, ...data }); }
      catch (error) { pending.delete(id); reject(error); }
    });
  };
  const raw = {
    closeDrainsIterators: true,
    exec: (sql) => {
      if (/^(?:SAVEPOINT|BEGIN)\b/.test(sql)) transactionDepth++;
      return request('exec', { sql }).then((value) => {
        if (/^RELEASE\b/.test(sql)) transactionDepth = Math.max(0, transactionDepth - 1);
        if (/^(?:COMMIT|ROLLBACK(?! TO))\b/.test(sql)) transactionDepth = 0;
        return value;
      });
    },
    prepare: async (sql, metadata = {}) => {
      const id = await request('prepare', { sql, ephemeral: metadata.ephemeral === true });
      const iterate = async (params = []) => {
        const cursor = await request('iterate', { statement: id, params });
        let rows = [];
        let at = 0;
        let done = false;
        let returned = false;
        let pulling = Promise.resolve();
        const next = async () => {
          if (failed !== null) throw failed;
          if (returned) return { done: true, value: undefined };
          if (at < rows.length) return { done: false, value: rows[at++] };
          if (done) return { done: true, value: undefined };
          const batch = await request('next', { cursor, rows: limits.rows, bytes: limits.bytes });
          metrics.frames++;
          metrics.rows += batch.rows.length;
          metrics.maxFrameRows = Math.max(metrics.maxFrameRows, batch.rows.length);
          metrics.maxFrameBytes = Math.max(metrics.maxFrameBytes, batch.bytes);
          if (returned) return { done: true, value: undefined };
          rows = batch.rows;
          at = 0;
          done = batch.done;
          return at < rows.length ? { done: false, value: rows[at++] } : { done: true, value: undefined };
        };
        return {
          next: () => {
            const result = pulling.then(next);
            pulling = result.then(() => undefined, () => undefined);
            return result;
          },
          return: async () => {
            if (returned) return { done: true, value: undefined };
            returned = true;
            rows = [];
            if (!done) await request('return', { cursor }, true);
            return { done: true, value: undefined };
          },
        };
      };
      return {
        run: (params = []) => request('run', { statement: id, params }),
        get: (params = []) => request('get', { statement: id, params }),
        iterate,
        all: async (params = []) => {
          const iterator = await iterate(params);
          const rows = [];
          let bytes = 0;
          try {
            for (;;) {
              const step = await iterator.next();
              if (step.done) return rows;
              bytes += rowBytes(step.value);
              if (rows.length >= allRows || bytes > allBytes)
                throw new DbRuntimeError('JD2092', `worker all() exceeds its ${allRows} row / ${allBytes} byte bound; use a cursor`);
              rows.push(step.value);
            }
          }
          finally { await iterator.return(); }
        },
      };
    },
    close: () => {
      if (closePromise !== undefined) return closePromise;
      closing = true;
      closePromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          lose(new Error('worker close timed out'));
          // V8 termination cannot preempt a synchronous native SQLite
          // call. Fence and detach now; never hold the caller's deadline
          // hostage to that native call or claim it was rolled back.
          worker.unref();
          worker.terminate().catch(() => {});
          reject(failed);
        }, closeMs);
        request('close', {}, true).then(() => {
          closed = true;
          clearTimeout(timeout);
          worker.terminate().then(() => resolve(undefined), reject);
        }, (error) => {
          clearTimeout(timeout);
          worker.unref();
          worker.terminate().catch(() => {});
          reject(error);
        });
      });
      return closePromise;
    },
  };
  const connection = finishConnection(raw, sqliteDialect, false, Object.freeze(capabilities), options.queueTimeout);
  return Object.freeze({ ...connection,
    get mustQueue() { return connection.mustQueue; },
    generation: epoch,
    metrics: () => Object.freeze({ ...metrics, pending: pending.size, generation: epoch, healthy: failed === null && !closed }),
    restart: async () => { lose(new Error('worker restarted')); await worker.terminate(); return reopen(); },
  });
}
