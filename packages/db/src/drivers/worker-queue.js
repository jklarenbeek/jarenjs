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
    acquire: (readOnly) => new Promise((resolve, reject) => {
      if (stopped !== null) { reject(stopped); return; }
      const entry = { readOnly, resolve, reject, at: now() };
      const slot = waiting.length === 0 ? choose(readOnly) : undefined;
      if (slot !== undefined) { grant(slot, entry); return; }
      if (waiting.length >= capacity) { reject(queueFailure(`worker pool queue capacity ${capacity} exceeded`, waiting.length)); return; }
      waiting.push(entry);
    }),
    stop(error = new DbRuntimeError('JD2063', 'the worker pool closed before the queued work ran')) {
      stopped = error;
      for (const entry of waiting.splice(0)) entry.reject(error);
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
