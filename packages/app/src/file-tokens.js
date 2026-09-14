//@ts-check
/** Finite ownership of native Files; only opaque identifiers cross the app boundary. */
import { resolveRuntime } from '@jarenjs/core/runtime';
import { AppRuntimeError, APP_CODES } from './errors.js';

/**
 * @typedef {Object} FileTokenOptions
 * @property {Partial<import('@jarenjs/core/runtime').Runtime>} [runtime]
 * @property {() => number} [now] - Overrides runtime.now; epoch milliseconds.
 * @property {() => string} [mintToken] - Overrides runtime.uuid for each token's suffix.
 * @property {number} [ttlMs=300000]
 * @property {number} [maxFiles=32] - 1–4096 retained files.
 * @property {number} [maxBytes=67108864] - Sum of retained File sizes.
 */
/**
 * @typedef {{files: number, bytes: number, maxFiles: number, maxBytes: number, disposed: boolean}} FileTokenStats
 * @typedef {Object} FileTokenRegistry
 * @property {(files: ArrayLike<File>) => readonly string[]} register
 * @property {(event: any) => readonly string[]} extract
 * @property {(token: string) => File | null} take
 * @property {(tokens: readonly string[]) => number} release
 * @property {() => Readonly<FileTokenStats>} stats
 * @property {() => void} dispose
 */

const MAX_FILES = 4096;
const MAX_TOKEN = 320;
const refusals = new WeakSet();
function refuse(code) {
  const error = new AppRuntimeError(code, APP_CODES[code]);
  refusals.add(error);
  throw error;
}
function attempt(body) {
  try { return body(); }
  catch (error) { if (refusals.has(error)) throw error; return refuse('JA2018'); }
}
function identifier(value) {
  if (typeof value !== 'string' || !value.length || value.length > 128 || /[^A-Za-z0-9_-]/.test(value)) refuse('JA2021');
  return value;
}
const positive = value => Number.isSafeInteger(value) && value > 0;

/**
 * Own a selection until take, release, expiry or disposal. Each registry gets a
 * fresh namespace from runtime.uuid; that provider must honor its fresh-id
 * contract. A monotonically increasing serial prevents rebinding stale tokens
 * even when a custom suffix minter repeats. Expiry sweeps on operations, without
 * a background timer; the host must dispose on owner teardown.
 * @param {FileTokenOptions} [options]
 * @returns {Readonly<FileTokenRegistry>}
 */
export function createFileTokenRegistry(options = {}) {
  return attempt(() => {
    if (options === null || typeof options !== 'object') refuse('JA2018');
    const runtime = resolveRuntime(options.runtime);
    const now = options.now === undefined ? runtime.now : options.now;
    const mint = options.mintToken === undefined ? runtime.uuid : options.mintToken;
    const { ttlMs = 300000, maxFiles = 32, maxBytes = 67108864 } = options;
    if (typeof now !== 'function' || typeof mint !== 'function' || !positive(ttlMs)
      || !positive(maxFiles) || maxFiles > MAX_FILES || !positive(maxBytes)) refuse('JA2018');
    const namespace = identifier(runtime.uuid());
    /** @type {Map<string, {file: File, bytes: number, expiresAt: number}>} */
    const entries = new Map();
    let bytes = 0, serial = 0, disposed = false, busy = false;

    function run(body) {
      if (busy) refuse('JA2021');
      busy = true;
      try { return attempt(body); }
      finally { busy = false; }
    }
    function drop(token, entry) {
      if (entries.delete(token)) { bytes -= entry.bytes; return 1; }
      return 0;
    }
    function sweep() {
      const time = now();
      if (!Number.isSafeInteger(time) || time < 0) refuse('JA2018');
      for (const [token, entry] of entries) if (time >= entry.expiresAt) drop(token, entry);
      return time;
    }
    function selection(value, limit) {
      if (value === null || typeof value !== 'object') refuse('JA2018');
      const count = value.length;
      if (!Number.isSafeInteger(count) || count < 0) refuse('JA2018');
      if (count > limit) refuse('JA2019');
      return count;
    }
    const registry = {
      /** Register all or none, in selection order; existing active tokens are never evicted.
       * @param {ArrayLike<File>} files @returns {readonly string[]} */
      register(files) {
        if (disposed) return refuse('JA2020');
        return run(() => {
          const time = sweep();
          if (disposed) refuse('JA2020');
          const count = selection(files, maxFiles);
          if (entries.size + count > maxFiles || serial > Number.MAX_SAFE_INTEGER - count
            || !Number.isSafeInteger(time + ttlMs)) refuse('JA2019');
          const pending = [];
          let addedBytes = 0;
          for (let i = 0; i < count; i++) {
            const file = files[i];
            // Native getters validate the File brand across realms and ignore
            // an overridden size/name property on a File subclass.
            Object.getOwnPropertyDescriptor(File.prototype, 'name').get.call(file);
            const size = Object.getOwnPropertyDescriptor(Blob.prototype, 'size').get.call(file);
            if (!Number.isSafeInteger(size) || size < 0) refuse('JA2018');
            addedBytes += size;
            if (!Number.isSafeInteger(addedBytes) || addedBytes > maxBytes - bytes) refuse('JA2019');
            pending.push({ file, bytes: size, expiresAt: time + ttlMs });
          }
          const tokens = [];
          for (let i = 0; i < count; i++) {
            const token = `file:${namespace}:${++serial}:${identifier(mint())}`;
            if (disposed) refuse('JA2020');
            tokens.push(token);
          }
          if (disposed) refuse('JA2020');
          for (let i = 0; i < count; i++) entries.set(tokens[i], pending[i]);
          bytes += addedBytes;
          return Object.freeze(tokens);
        });
      },
      /** Event-field-compatible extractor; the returned value contains no Files.
       * @param {any} event @returns {readonly string[]} */
      extract(event) { return registry.register(event?.target?.files ?? []); },
      /** Consume once. The caller now owns the File, including any upload retry.
       * @param {string} token @returns {File | null} */
      take(token) {
        if (disposed) return null;
        return run(() => {
          sweep();
          if (typeof token !== 'string' || token.length > MAX_TOKEN) return null;
          const entry = entries.get(token);
          if (!entry) return null;
          drop(token, entry);
          return entry.file;
        });
      },
      /** Release remaining references; works even if the injected clock has failed.
       * @param {readonly string[]} tokens @returns {number} */
      release(tokens) {
        if (disposed) return 0;
        return run(() => {
          const count = selection(tokens, MAX_FILES);
          let released = 0;
          for (let i = 0; i < count; i++) {
            const token = tokens[i];
            if (typeof token !== 'string' || token.length > MAX_TOKEN) continue;
            const entry = entries.get(token);
            if (entry) released += drop(token, entry);
          }
          return released;
        });
      },
      /** Snapshot retained references and logical File bytes, after expiry cleanup. */
      stats() {
        if (!disposed) run(sweep);
        return Object.freeze({ files: entries.size, bytes, maxFiles, maxBytes, disposed });
      },
      /** Idempotently stop admission and release every remaining registry reference. */
      dispose() { disposed = true; entries.clear(); bytes = 0; },
    };
    return Object.freeze(registry);
  });
}
