//@ts-check
/** One writer and bounded read-only WAL workers behind a Connection. */
import { finishConnection, DEFAULT_QUEUE_TIMEOUT } from '../driver.js';
import { DbCompileError, DbRuntimeError } from '../errors.js';
import { sqliteDialect } from '../dialects/sqlite.js';
import { positiveOption } from './worker-protocol.js';
import { workerQueue } from './worker-queue.js';
import { createAsyncContext } from './async-context.js';

/**
 * Reads explicitly classified by their compiled operation may use a read worker.
 * All other work uses the writer; an open transaction keeps one worker.
 *
 * A PARALLEL read (`parallelRead`, what a Store opened with `reads:
 * 'parallel'` takes for its classified root reads) holds one read worker
 * for its whole extent, inside one read transaction: every statement it
 * issues runs there, on one committed WAL snapshot, even while the writer
 * holds an open transaction — it never sees that transaction's rows and
 * never joins it. The async context that marks it reaches every statement
 * the read awaits, and nothing outside it.
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
      // how long a cursor outside any read or transaction waits for its
      // lane: the connection's own queueTimeout, as a parallel read's wait
      const queueTimeout = options.queueTimeout ?? DEFAULT_QUEUE_TIMEOUT;
      // the parallel read in progress on this async context, if any: its
      // reader lease and the iterators it opened (Node and Bun ship it;
      // loaded at open, as every binding loads its runtime builtin)
      /** @type {import('node:async_hooks').AsyncLocalStorage<{ lease: any, iterators: Set<any>, ended: boolean }>} */
      const parallel = await createAsyncContext();
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
      /** The parallel read the calling context belongs to, while it runs.
       * A statement issued from its context after it ended — work it set
       * going and did not await — is refused by name: its reader has
       * been given back, and the writer's open transaction is no place
       * for it either. */
      const currentRead = () => {
        const read = parallel.getStore();
        if (read?.ended === true) {
          throw Object.assign(new DbRuntimeError('JD2090',
            'a statement reached a parallel read that had ended; its reader was given back'), { retryable: false });
        }
        return read;
      };
      const withLease = async (readOnly, fn, borrow = false) => {
        if (closed) throw new DbRuntimeError('JD2063', 'the worker pool is closed');
        const read = currentRead();
        if (read !== undefined) return execute(read.lease, fn);
        if (transaction !== null) return execute(transaction, fn);
        // bounded as a cursor's wait is: on a pool without readers an open
        // root cursor holds the writer, and a root write waiting for it
        // unbounded would hold the store's gate against that cursor's next pull
        const lease = await queue.acquire(readLane(readOnly), { borrow, timeoutMs: queueTimeout });
        try { return await execute(lease, fn); }
        finally { lease.release(); await replace(lease.slot); }
      };
      const raw = {
        closeDrainsIterators: true,
        exec: async (sql) => {
          // a parallel read runs on its own reader and opens no transaction of the writer's
          const read = currentRead();
          if (read !== undefined) return execute(read.lease, (slot) => slot.connection.exec(sql));
          const begin = /^(?:SAVEPOINT|BEGIN)\b/.test(sql);
          const release = /^RELEASE\b/.test(sql);
          const end = /^(?:COMMIT|ROLLBACK(?! TO))\b/.test(sql);
          const rollback = /^ROLLBACK\b/.test(sql);
          if (begin && transaction === null) transaction = await queue.acquire(options.readOnly === true, { timeoutMs: queueTimeout });
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
          // a classified call that is over when it answers may borrow the
          // writer while every reader is held; a cursor never does — it
          // would keep the writer for its whole life
          const call = (method, params) => withLease(metadata.readOnly === true,
            async (slot) => (await statementFor(slot))[method](params), metadata.readOnly === true);
          return {
            run: (params = []) => call('run', params),
            get: (params = []) => call('get', params),
            all: (params = []) => call('all', params),
            // every slot that prepared the statement keeps it: release each
            finalize: async () => {
              for (const slot of slots) {
                const kept = slot.statements.get(id);
                if (kept === undefined) continue;
                slot.statements.delete(id);
                await kept.finalize?.();
              }
            },
            iterate: async (params = []) => {
              const read = currentRead();
              if (read !== undefined) {
                // inside a parallel read: on its reader, closed when it ends
                const iterator = await execute(read.lease, async (slot) => (await statementFor(slot)).iterate(params));
                read.iterators.add(iterator);
                const forget = () => read.iterators.delete(iterator);
                return {
                  next: async () => {
                    const step = await execute(read.lease, () => iterator.next());
                    if (step.done) forget();
                    return step;
                  },
                  return: async () => { forget(); await iterator.return(); return { done: true, value: undefined }; },
                };
              }
              // a cursor holds its lease across pulls, so it never borrows the
              // writer, and its wait is bounded: a root cursor's first pull
              // runs inside the store's gate, and an unbounded wait for a read
              // worker another open cursor holds would keep every call out
              // (that cursor's next pull included) until one was returned
              const pinned = transaction;
              const lease = pinned ?? await queue.acquire(readLane(metadata.readOnly === true), { timeoutMs: queueTimeout });
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
        /**
         * Run `fn` as one parallel read: a reader lease for its whole
         * extent, one read transaction around it (its snapshot), the
         * lease and anything it left open released when it settles.
         * `fn` runs inside the read and receives `enter`, which runs a
         * later function inside it too — what a cursor that holds the
         * read across its pulls re-enters it with. A read that is over
         * when `fn` settles may borrow the writer while every reader is
         * held (`borrow`); the read is the same read there, in a read
         * transaction of its own, and a write waits only for its end.
         * @param {(enter: (next: () => any) => any) => any} fn
         * @param {{ signal?: AbortSignal, timeoutMs?: number, borrow?: boolean }} [readOptions]
         */
        parallelRead: async (fn, readOptions = {}) => {
          if (closed) throw new DbRuntimeError('JD2063', 'the worker pool is closed');
          const lease = await queue.acquire(true, readOptions);
          const read = { lease, iterators: new Set(), ended: false };
          const enter = (/** @type {() => any} */ next) => parallel.run(read, next);
          // BEGIN is pipelined, not awaited first: a worker serves its
          // frames one at a time in arrival order, so every statement the
          // read issues lands after it. The read answers only once BEGIN is
          // known to have taken.
          let begun = false;
          const begin = execute(lease, (slot) => slot.connection.exec('BEGIN')).then(() => { begun = true; });
          begin.catch(() => {});
          try {
            const value = await enter(() => fn(enter));
            await begin;
            return value;
          }
          finally {
            await begin.catch(() => {});
            for (const iterator of read.iterators) await iterator.return?.().catch(() => {});
            read.ended = true;
            // a read transaction left open would refuse the next read's
            // BEGIN on this worker: roll it back, or retire the worker
            if (begun) {
              await execute(lease, (slot) => slot.connection.exec('COMMIT')).catch(() =>
                execute(lease, (slot) => slot.connection.exec('ROLLBACK')).catch(() => { lease.slot.healthy = false; }));
            }
            lease.release();
            await replace(lease.slot);
          }
        },
        /** Whether the calling async context is inside a parallel read. */
        inParallelRead: () => parallel.getStore() !== undefined,
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
