//@ts-check
/** Native SQL cursor ownership over one injected PostgreSQL session. */
import { DbRuntimeError } from '../errors.js';
import { rowBytes } from './worker-protocol.js';

/** @param {any} host @param {any} limits */
export function postgresCursors(host, limits) {
  const cursors = new Set();
  let sequence = 0;
  let automatic = false;
  let opening;
  let settling;
  let failed = false;
  let fetchedRows = 0;
  let fetchedBytes = 0;
  let peakRows = 0;
  let peakBytes = 0;
  const finishTransaction = async () => {
    if (!automatic || cursors.size !== 0) return;
    try { settling = host.query(failed ? 'ROLLBACK' : 'COMMIT'); await settling; }
    catch (error) { host.unhealthy(error); throw error; }
    finally { automatic = false; opening = undefined; settling = undefined; failed = false; }
  };
  return {
    async open(sql, params, windowRows = limits.windowRows) {
      if (cursors.size >= limits.maxCursors)
        throw new DbRuntimeError('JD2091', 'the PostgreSQL cursor capacity is exhausted');
      const name = `jaren_c${++sequence}`;
      let rows = [], offset = 0, done = false, declared = false, closing, timer, expired, tail = Promise.resolve();
      const finish = () => {
        if (closing !== undefined) return closing;
        done = true;
        clearTimeout(timer);
        rows = [];
        closing = (async () => {
          try {
            if (declared && host.status() !== 'E') await host.query(`CLOSE "${name}"`, undefined, name);
          }
          catch (error) {
            // Transaction settlement may already have removed its cursors.
            if (!['34000', '25P02'].includes(error?.code)) { host.unhealthy(error); throw error; }
          }
          finally { cursors.delete(cursor); await finishTransaction(); }
        })();
        return closing;
      };
      const cursor = {
        next: () => {
          const next = tail.then(async () => {
            if (expired) throw expired;
            if (done) return { done: true, value: undefined };
            try {
              if (offset >= rows.length) {
                const result = await host.query(`FETCH FORWARD ${windowRows} FROM "${name}"`, undefined, name);
                if (expired) throw expired;
                const batch = host.normalize(result);
                fetchedRows += batch.length;
                const bytes = batch.reduce((n, row) => n + rowBytes(row), 0);
                fetchedBytes += bytes;
                if (batch.length > windowRows || bytes > limits.windowBytes)
                  throw new DbRuntimeError('JD2092', 'the PostgreSQL fetch exceeds its row or byte credits');
                peakRows = Math.max(peakRows, batch.length);
                peakBytes = Math.max(peakBytes, bytes);
                rows = batch;
                offset = 0;
                if (rows.length === 0) { await finish(); return { done: true, value: undefined }; }
              }
              const value = rows[offset];
              rows[offset++] = undefined;
              return { done: false, value };
            }
            catch (error) { if (automatic) failed = true; await finish().catch(() => {}); throw error; }
          });
          tail = next.catch(() => {});
          return next;
        },
        return: async () => {
          if (done) { await closing; return { done: true, value: undefined }; }
          await host.cancel(name);
          await tail;
          await finish();
          return { done: true, value: undefined };
        },
        [Symbol.asyncIterator]: () => cursor,
      };
      cursors.add(cursor);
      try {
        await settling;
        if (done) { await closing; return cursor; }
        if (!automatic && host.status() === 'I') {
          automatic = true;
          opening = host.query('BEGIN');
        }
        await opening;
        if (done) { await closing; return cursor; }
        await host.query(`DECLARE "${name}" NO SCROLL CURSOR FOR ${sql}`, params, name);
        declared = true;
        if (done) { await closing; return cursor; }
        timer = setTimeout(() => {
          expired = new DbRuntimeError('JD2075', `PostgreSQL cursor lifetime exceeded ${limits.cursorLifetimeMs}ms`);
          cursor.return().catch((error) => host.unhealthy(error));
        }, limits.cursorLifetimeMs);
        return cursor;
      }
      catch (error) { if (automatic) failed = true; await finish().catch(() => {}); throw error; }
    },
    close: async () => {
      const outcomes = await Promise.allSettled([...cursors].map((cursor) => cursor.return()));
      const errors = outcomes.filter((outcome) => outcome.status === 'rejected').map((outcome) => outcome.reason);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'PostgreSQL cursor cleanup failed');
    },
    metrics: () => Object.freeze({ cursors: cursors.size, fetchedRows, fetchedBytes, peakRows, peakBytes }),
  };
}
