//@ts-check
/** Deterministic host scheduling: no timers and no implicit retries. */
import { DatabaseSync } from 'node:sqlite';
import { adaptNodeDatabase } from '../../packages/db/src/drivers/node.js';
import { finishConnection } from '../../packages/db/src/driver.js';
import { DbRuntimeError } from '../../packages/db/src/errors.js';

/** A connection oracle with inspectable credits and generation identities. */
export function faultHost() {
  const events = [];
  const pending = [];
  const cursors = new Map();
  let generation = 0;
  let sequence = 0;
  let paused = false;
  let current;
  let transaction = false;
  const stale = () => Object.assign(new DbRuntimeError('JD2090', 'the driver generation was lost'),
    { retryable: !transaction, generation });
  const check = (epoch) => { if (epoch !== generation) throw stale(); };
  const schedule = (epoch, event, fn) => {
    check(epoch);
    events.push({ event, generation: epoch });
    if (!paused) { check(epoch); return fn(); }
    return new Promise((resolve, reject) => pending.push({ epoch, fn, resolve, reject }));
  };
  const driver = {
    name: 'fault-host',
    open() {
      const epoch = ++generation;
      const connection = adaptNodeDatabase(new DatabaseSync(':memory:'));
      let closed = false;
      const raw = {
        exec: (sql) => schedule(epoch, 'exec', () => {
          const result = connection.exec(sql);
          if (/^(?:SAVEPOINT|BEGIN)/.test(sql)) transaction = true;
          if (/^(?:RELEASE|COMMIT|ROLLBACK)/.test(sql)) transaction = false;
          return result;
        }),
        prepare: (sql) => schedule(epoch, 'prepare', () => {
          const statement = connection.prepare(sql);
          const id = ++sequence;
          const call = (member, params) => schedule(epoch, member, () => statement[member](params));
          return {
            run: (params) => call('run', params),
            get: (params) => call('get', params),
            all: (params) => call('all', params),
            iterate: (params) => {
              check(epoch);
              const iterator = statement.iterate(params);
              const cursor = ++sequence;
              let done = false;
              const release = () => {
                if (done) return;
                done = true;
                iterator.return();
                cursors.delete(cursor);
                events.push({ event: 'finalize', id, cursor, generation: epoch });
              };
              cursors.set(cursor, release);
              return {
                next: () => schedule(epoch, 'next', () => {
                  if (done) return { done: true, value: undefined };
                  const step = iterator.next();
                  if (step.done) release();
                  return step;
                }),
                return: () => { release(); return { done: true, value: undefined }; },
              };
            },
          };
        }),
        close() {
          if (closed) return;
          closed = true;
          for (const release of cursors.values()) release();
          connection.close();
          events.push({ event: 'close', generation: epoch });
        },
      };
      current = raw;
      events.push({ event: 'open', generation: epoch });
      return finishConnection(raw, connection.dialect, false, connection.capabilities, 5000);
    },
  };
  return {
    driver, events,
    get credits() { return pending.length; },
    get generation() { return generation; },
    pause() { paused = true; },
    resume() { paused = false; },
    step() {
      const task = pending.shift();
      if (task === undefined) throw new Error('no scheduled host operation');
      try { check(task.epoch); task.resolve(task.fn()); }
      catch (error) { task.reject(error); }
    },
    crash() {
      generation++;
      current?.close();
      for (const task of pending.splice(0)) task.reject(stale());
      events.push({ event: 'crash', generation });
    },
  };
}
