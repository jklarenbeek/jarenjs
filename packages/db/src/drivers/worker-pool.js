//@ts-check
/** One writer and bounded read-only WAL workers behind a Connection. */
import { finishConnection } from '../driver.js';
import { DbCompileError, DbRuntimeError } from '../errors.js';
import { sqliteDialect } from '../dialects/sqlite.js';
import { positiveOption } from './worker-protocol.js';
import { workerQueue } from './worker-queue.js';

/**
 * Reads explicitly classified by their compiled operation may use a read worker.
 * All other work uses the writer; an open transaction keeps one worker.
 * @param {{ readers?: number, queueCapacity?: number, graceMs?: number,
 *   worker?: any }} [configuration]
 * @returns {any} a Driver
 */
export function workerPoolDriver(configuration, driverFactory) {
  const readers = configuration.readers ?? 2;
  const capacity = configuration.queueCapacity ?? 64;
  if (!Number.isSafeInteger(readers) || readers < 0 || readers > 32) throw new TypeError('readers must be an integer from 0 through 32');
  if (!Number.isSafeInteger(capacity) || capacity < 0) throw new TypeError('queueCapacity must be a nonnegative safe integer');
  const graceMs = positiveOption('graceMs', configuration.graceMs, 5000);
  return Object.freeze({
    name: 'node-worker-pool-sqlite', dialect: sqliteDialect,
    open: async (path = ':memory:', options = {}) => {
      const driver = driverFactory(configuration.worker);
      const slots = [];
      let closed = false;
      let transaction = null;
      let depth = 0;
      let committing = null;
      let sequence = 0;
      const memory = path === ':memory:' || path === '';
      const makeSlot = async (readOnly) => {
        const connection = await driver.open(path, { ...options, readOnly });
        return { connection, readOnly, active: false, healthy: true, generation: connection.generation,
          statements: new Map(), executions: 0 };
      };
      try {
        slots.push(await makeSlot(options.readOnly === true));
        if (!memory) {
          const writer = slots[0].connection;
          const statement = await writer.prepare(options.readOnly === true ? sqliteDialect.introspect.pragma('journal_mode') : sqliteDialect.pragma.set('journal_mode', 'WAL'));
          const mode = await statement.get();
          if (String(Object.values(mode)[0]).toLowerCase() !== 'wal')
            throw new DbCompileError('JD0008', 'a worker pool requires a file in WAL mode');
          for (let i = 0; i < readers; i++) slots.push(await makeSlot(true));
        }
      }
      catch (error) { await Promise.allSettled(slots.map((slot) => slot.connection.close())); throw error; }
      const queue = workerQueue(slots, capacity, () => performance.now());
      const readLane = (readOnly) => options.readOnly === true || (readOnly && slots.length > 1);
      const replace = async (slot) => {
        if (closed || slot.healthy) return;
        await slot.connection.close().catch(() => {});
        try {
          const fresh = await makeSlot(slot.readOnly);
          Object.assign(slot, fresh);
          queue.wake();
        }
        catch (error) { queue.stop(error); }
      };
      const execute = async (lease, fn) => {
        try { lease.slot.executions++; return await fn(lease.slot); }
        catch (error) { if (error?.code === 'JD2090') lease.slot.healthy = false; throw error; }
      };
      const withLease = async (readOnly, fn) => {
        if (closed) throw new DbRuntimeError('JD2063', 'the worker pool is closed');
        if (transaction !== null) return execute(transaction, fn);
        const lease = await queue.acquire(readLane(readOnly));
        try { return await execute(lease, fn); }
        finally { lease.release(); await replace(lease.slot); }
      };
      const raw = {
        closeDrainsIterators: true,
        exec: async (sql) => {
          const begin = /^(?:SAVEPOINT|BEGIN)\b/.test(sql);
          const release = /^RELEASE\b/.test(sql);
          const end = /^(?:COMMIT|ROLLBACK(?! TO))\b/.test(sql);
          const rollback = /^ROLLBACK\b/.test(sql);
          if (begin && transaction === null) transaction = await queue.acquire(options.readOnly === true);
          if (begin) depth++;
          const operation = withLease(false, (slot) => slot.connection.exec(sql));
          if (end || (release && depth === 1)) committing = operation;
          let succeeded = false;
          try { const value = await operation; succeeded = true; return value; }
          catch (error) {
            // A failed begin owns no new savepoint. A lost generation
            // cannot acknowledge rollback or the following release; unwind
            // exactly this scope, leaving any outer owner pinned until its
            // own rollback settles. A failed COMMIT keeps its lease for
            // the normal rollback path.
            if (begin || (rollback && error?.code === 'JD2090'))
              depth = end ? 0 : Math.max(0, depth - 1);
            throw error;
          }
          finally {
            if (succeeded && release) depth = Math.max(0, depth - 1);
            if (succeeded && end) depth = 0;
            if (transaction !== null && depth === 0) {
              const lease = transaction;
              transaction = null;
              lease.release();
              await replace(lease.slot);
            }
            if (committing === operation) committing = null;
          }
        },
        prepare: (sql, metadata = {}) => {
          const id = ++sequence;
          const statementFor = async (slot) => {
            if (!slot.statements.has(id) || metadata.ephemeral) {
              const statement = await slot.connection.prepare(sql, metadata);
              if (metadata.ephemeral) return statement;
              slot.statements.set(id, statement);
            }
            return slot.statements.get(id);
          };
          const call = (method, params) => withLease(metadata.readOnly === true,
            async (slot) => (await statementFor(slot))[method](params));
          return {
            run: (params = []) => call('run', params),
            get: (params = []) => call('get', params),
            all: (params = []) => call('all', params),
            iterate: async (params = []) => {
              const pinned = transaction;
              const lease = pinned ?? await queue.acquire(readLane(metadata.readOnly === true));
              let iterator;
              try { iterator = await execute(lease, async (slot) => (await statementFor(slot)).iterate(params)); }
              catch (error) { if (pinned === null) { lease.release(); await replace(lease.slot); } throw error; }
              let done = false;
              const finish = async () => {
                if (done) return;
                done = true;
                try { await iterator.return(); }
                finally { if (pinned === null) { lease.release(); await replace(lease.slot); } }
              };
              return {
                next: async () => {
                  if (done) return { done: true, value: undefined };
                  try {
                    const step = await execute(lease, () => iterator.next());
                    if (step.done) await finish();
                    return step;
                  }
                  catch (error) { await finish().catch(() => {}); throw error; }
                },
                return: async () => { await finish(); return { done: true, value: undefined }; },
              };
            },
          };
        },
        close: async () => {
          if (closed) return;
          closed = true;
          queue.stop();
          let timer;
          await Promise.race([queue.drain(), new Promise((resolve) => { timer = setTimeout(resolve, graceMs); })]);
          clearTimeout(timer);
          // A commit already sent to SQLite owns its settlement. Closing
          // never terminates that writer while its outcome is pending.
          if (committing !== null) await committing.catch(() => {});
          try { await Promise.all(slots.map((slot) => slot.connection.close())); }
          finally {
            for (const slot of slots) {
              slot.healthy = false;
              slot.active = false;
              slot.statements.clear();
            }
          }
        },
      };
      const capabilities = Object.freeze({ ...slots[0].connection.capabilities,
        pooling: true, poolReaders: slots.filter((slot) => slot.readOnly).length,
        poolWriters: slots.filter((slot) => !slot.readOnly).length });
      const connection = finishConnection(raw, sqliteDialect, false, capabilities, options.queueTimeout);
      return Object.freeze({ ...connection, get mustQueue() { return connection.mustQueue; },
        metrics: () => Object.freeze({ ...queue.metrics(), workers: Object.freeze(slots.map((slot) =>
          Object.freeze({ readOnly: slot.readOnly, healthy: slot.healthy, active: slot.active,
            generation: slot.generation, executions: slot.executions }))) }),
      });
    },
  });
}
