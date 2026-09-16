//@ts-check
/** Bounded FIFO admission, with a deterministic clock and inspectable leases. */
import { DbRuntimeError } from '../errors.js';
import { queueFailure } from './worker-protocol.js';

/** @param {any[]} slots @param {number} capacity @param {() => number} now */
export function workerQueue(slots, capacity, now) {
  const waiting = [];
  const waits = [];
  const observers = new Set();
  let stopped = null;
  const idle = () => { if (slots.every((slot) => !slot.active)) for (const fn of observers) fn(); };
  const choose = (readOnly) => slots.find((slot) => !slot.active && slot.healthy
    && (readOnly ? slot.readOnly : !slot.readOnly));
  const grant = (slot, entry) => {
    entry.cleanup?.();
    slot.active = true;
    const wait = Math.max(0, now() - entry.at);
    if (waits.length === 1024) waits.shift();
    waits.push(wait);
    let released = false;
    entry.resolve({ slot, release: () => {
      if (released) return;
      released = true;
      slot.active = false;
      pump();
      idle();
    } });
  };
  const pump = () => {
    while (waiting.length > 0) {
      const slot = choose(waiting[0].readOnly);
      if (slot === undefined) break;
      grant(slot, waiting.shift());
    }
  };
  return {
    acquire: (readOnly, options = {}) => new Promise((resolve, reject) => {
      if (stopped !== null) { reject(stopped); return; }
      if (options.signal?.aborted) {
        reject(new DbRuntimeError('JD2064', 'the queued lease was aborted before acquisition'));
        return;
      }
      let timer;
      const entry = { readOnly, resolve, reject, at: now(), cleanup: () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
      } };
      const abandon = (error) => {
        const index = waiting.indexOf(entry);
        if (index < 0) return;
        waiting.splice(index, 1);
        entry.cleanup();
        reject(error);
        pump();
      };
      const abort = () => abandon(new DbRuntimeError('JD2064',
        'the queued lease was aborted before acquisition', { cause: options.signal?.reason }));
      const slot = waiting.length === 0 ? choose(readOnly) : undefined;
      if (slot !== undefined) { grant(slot, entry); return; }
      if (waiting.length >= capacity) { reject(queueFailure(`lease queue capacity ${capacity} exceeded`, waiting.length)); return; }
      waiting.push(entry);
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.timeoutMs !== undefined) timer = setTimeout(() =>
        abandon(queueFailure(`lease acquisition exceeded ${options.timeoutMs}ms`, waiting.length)), options.timeoutMs);
    }),
    stop(error = new DbRuntimeError('JD2063', 'the worker pool closed before the queued work ran')) {
      stopped = error;
      for (const entry of waiting.splice(0)) { entry.cleanup?.(); entry.reject(error); }
    },
    drain: () => slots.every((slot) => !slot.active) ? Promise.resolve()
      : new Promise((resolve) => { const done = () => { observers.delete(done); resolve(undefined); }; observers.add(done); }),
    wake: pump,
    metrics: () => {
      const values = [...waits].sort((a, b) => a - b);
      return Object.freeze({ active: slots.filter((s) => s.active).length,
        idle: slots.filter((s) => !s.active && s.healthy).length, queued: waiting.length,
        waitMs: Object.freeze({ p50: values[Math.floor(values.length * 0.5)] ?? 0,
          p95: values[Math.min(values.length - 1, Math.floor(values.length * 0.95))] ?? 0 }) });
    },
  };
}
