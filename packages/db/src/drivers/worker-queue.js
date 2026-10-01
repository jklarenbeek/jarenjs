//@ts-check
/**
 * Bounded FIFO admission per lane, with a deterministic clock and
 * inspectable leases. Each lane (the writer, the readers) keeps its own
 * arrival order: a write waiting for the writer never waits behind reads
 * waiting for a reader, and a read never jumps an earlier read. A read
 * that is over when it answers may BORROW (`borrow: true`): it takes a
 * free writer when every reader is busy — never while a write waits for
 * it — so readers held by open cursors do not stall it, at the price that
 * a long read on the borrowed writer delays a write that arrives during it.
 */
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
  /** Whether a waiter of this lane is already queued (it goes first). @param {boolean} readOnly */
  const laneWaiting = (readOnly) => waiting.some((entry) => entry.readOnly === readOnly);
  /** A free writer a read may borrow: none while a write waits for one. */
  const borrowable = () => (laneWaiting(false) ? undefined : choose(false));
  const pump = () => {
    // the first waiter of each lane gets that lane's free slot
    for (let i = 0; i < waiting.length;) {
      const entry = waiting[i];
      const slot = choose(entry.readOnly) ?? (entry.borrow ? borrowable() : undefined);
      if (slot === undefined) { i++; continue; }
      grant(slot, waiting.splice(i, 1)[0]);
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
      const borrow = readOnly && options.borrow === true;
      const entry = { readOnly, borrow, resolve, reject, at: now(), cleanup: () => {
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
      const slot = (laneWaiting(readOnly) ? undefined : choose(readOnly)) ?? (borrow ? borrowable() : undefined);
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
