//@ts-check
/** One dedicated PostgreSQL listener: a coalesced wake token, never durable data. */
import { backoffDelay, sleep } from '@jarenjs/core/retry';
import { DbCompileError, DbRuntimeError, wrapDriverError } from '../errors.js';
import { postgresChannel } from './postgres-options.js';

/**
 * Use the driver's existing bounded acquisition/settlement owner for each
 * listener generation. The factory is injected to keep module dependencies
 * one way. A reconnect always emits a wake token after LISTEN commits.
 * @param {Function} driverFactory
 * @param {{ connect: Function }} source
 * @param {any} options
 * @returns {any}
 */
export function createPostgresNotifications(driverFactory, source, options) {
  const channel = postgresChannel(options?.channel);
  if (!source || typeof source.connect !== 'function')
    throw new DbCompileError('JD0003', 'notifications need an injected connection source');
  const maxReconnects = options.maxReconnects ?? 5;
  const retryBaseMs = options.retryBaseMs ?? 100;
  const retryMaxMs = options.retryMaxMs ?? 2000;
  if (!Number.isSafeInteger(maxReconnects) || maxReconnects < 0
    || !Number.isSafeInteger(retryBaseMs) || retryBaseMs < 1
    || !Number.isSafeInteger(retryMaxMs) || retryMaxMs < retryBaseMs || retryMaxMs > 2147483647)
    throw new DbCompileError('JD0003', 'notification retries need finite integer bounds');
  const stop = new AbortController();
  const readiness = Promise.withResolvers();
  let closed = false, finished = false, dirty = false, connecting = true;
  let failure, waiter, connection, generation, closing, closeFailure;
  let attempts = 0;
  const settle = () => {
    if (!waiter || !(closed || failure || dirty || finished)) return;
    const pending = waiter; waiter = undefined;
    if (closed) pending.resolve({ done: true, value: undefined });
    else if (failure) pending.reject(failure);
    else if (dirty) { dirty = false; pending.resolve({ done: false, value: null }); }
    else pending.resolve({ done: true, value: undefined });
  };
  const wake = () => { if (!closed) { dirty = true; settle(); } };
  const driver = driverFactory({ connect: async () => {
    const current = generation;
    const client = await source.connect();
    if (typeof client.on !== 'function' || typeof client.off !== 'function' || typeof client.release !== 'function') {
      await client.release?.(new Error('unsupported notification client'));
      throw new DbCompileError('JD0003', 'notification clients require on, off and release methods');
    }
    let live = true;
    const lost = (error) => {
      if (!live) return;
      current.error = error ?? new DbRuntimeError('JD2087', 'the PostgreSQL listener disconnected');
      current.disconnected.resolve();
    };
    const notify = (event) => {
      if (live && current === generation && event?.channel === channel) wake();
    };
    client.on('error', lost); client.on('end', lost); client.on('notification', notify);
    return {
      query: (...args) => client.query(...args),
      ...(typeof client.getTransactionStatus !== 'function' ? {} : { getTransactionStatus: () => client.getTransactionStatus() }),
      release: async (error) => {
        if (!live) return;
        live = false;
        client.off('notification', notify); client.off('end', lost); client.off('error', lost);
        await client.release(error ?? current.error ?? (current.listening
          ? new DbRuntimeError('JD2090', 'the listener closed before UNLISTEN settled') : undefined));
      },
    };
  } }, { ...options, schema: undefined, notifyChannel: undefined,
    maxConnections: 1, queueCapacity: 1, prepared: 'unnamed' });

  const run = (async () => {
    while (!closed) {
      generation = { disconnected: Promise.withResolvers(), error: undefined, listening: false };
      connecting = true;
      let error;
      attempts++;
      try {
        connection = await driver.open(undefined, { signal: stop.signal });
        if (closed) return;
        const channels = await (await connection.prepare('SELECT pg_catalog.pg_listening_channels() AS channel')).all();
        if (channels.some((row) => row.channel === channel))
          throw new DbCompileError('JD0003', 'the acquired session already listens on this channel');
        generation.listening = true;
        await connection.exec(`LISTEN "${channel}"`);
        if (generation.error) throw generation.error;
        if (closed) return;
        connecting = false;
        readiness.resolve();
        wake();
        await generation.disconnected.promise;
        if (!closed) throw generation.error;
      }
      catch (caught) { error = caught; }
      finally {
        if (connection) {
          try {
            if (generation.listening && !generation.error) {
              await connection.exec(`UNLISTEN "${channel}"`);
              generation.listening = false;
            }
          }
          catch (cleanup) {
            error ??= cleanup;
            if (closed && !connecting) closeFailure ??= cleanup;
          }
          try { await connection.close(); }
          catch (cleanup) { error ??= cleanup; if (closed) closeFailure ??= cleanup; }
          connection = undefined;
        }
      }
      if (closed) return;
      // A source that cannot settle release retains its driver's credit.
      // Never manufacture a fresh owner to get around that quarantine.
      if (attempts > maxReconnects || driver.metrics().active > 0 || error instanceof DbCompileError) throw error;
      await sleep(backoffDelay({ baseMs: retryBaseMs, maxMs: retryMaxMs }, attempts), stop.signal);
    }
  })().catch((error) => {
    if (!closed) failure = wrapDriverError(error);
    readiness.reject(failure ?? new DbRuntimeError('JD2063', 'the PostgreSQL listener is closed'));
  }).finally(() => { finished = true; settle(); });
  // An owner may close before ever awaiting readiness; retain the rejection
  // for its caller without creating an unhandled background rejection.
  readiness.promise.catch(() => {});

  const close = () => {
    if (closing) return closing;
    closed = true; dirty = false; stop.abort(); settle();
    generation?.disconnected.resolve();
    const interrupt = connecting ? connection?.close() : undefined;
    closing = Promise.allSettled([run, interrupt]).then((results) => {
      readiness.reject(new DbRuntimeError('JD2063', 'the PostgreSQL listener is closed'));
      const rejected = results.find((result) => result.status === 'rejected');
      if (rejected?.status === 'rejected') throw rejected.reason;
      if (closeFailure) throw closeFailure;
    });
    return closing;
  };
  const iterator = {
    ready: readiness.promise,
    metrics: () => Object.freeze({ attempts, pending: waiter ? 1 : 0, coalesced: dirty ? 1 : 0,
      closed, connected: !connecting && !finished && !closed, ...driver.metrics() }),
    next: () => {
      if (waiter) return Promise.reject(new DbRuntimeError('JD2091', 'a notification pull is already pending'));
      waiter = Promise.withResolvers();
      const promise = waiter.promise;
      settle();
      return promise;
    },
    close,
    return: async () => { await close(); return { done: true, value: undefined }; },
    [Symbol.asyncIterator]: () => iterator,
  };
  return Object.freeze(iterator);
}
