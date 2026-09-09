//@ts-check
/**
 * @file The lazy URL loader (docs/LOADER.md): cache, abort, streaming.
 *
 * `loadMarkdown` resolves any URL the platform `fetch` accepts into a
 * compiled document. The shared LRU cache keys on normalized URL +
 * compile options, remembers `ETag`/`Last-Modified` validators, shares
 * in-flight fetches, and revalidates stale entries in the background.
 * When the response body is a `ReadableStream` the parser runs
 * block-by-block as chunks arrive — `streamMarkdown` exposes that as
 * an async iterator of completed top-level blocks.
 */

import { createBoundedCache } from '@jarenjs/core/cache';

import { createIncrementalParser } from './parser.js';
import { compileMarkdown } from './compiler.js';

/**
 * @typedef {import('./ast.js').MdNode} MdNode
 * @typedef {import('./ast.js').MdDocument} MdDocument
 * @typedef {import('./compiler.js').CompiledMd} CompiledMd
 * @typedef {import('./compiler.js').MdCompileOptions} MdCompileOptions
 */
/**
 * @typedef {MdCompileOptions & {
 *   base?: string | URL,
 *   signal?: AbortSignal,
 *   cache?: MdCache | false,
 *   fetch?: typeof globalThis.fetch,
 * }} MdLoadOptions
 */
/**
 * @typedef {object} MdCache
 * @property {(key: string) => any} get
 * @property {(key: string, entry: any) => void} set
 * @property {(key: string) => boolean} delete
 * @property {() => void} clear
 */

/**
 * The shared core LRU with Markdown's numeric-capacity policy: fractions
 * round down, values below one retain nothing, and Infinity or NaN
 * disable capacity eviction.
 * @param {number} [limit]
 * @returns {MdCache}
 */
export function createMdCache(limit = 64) {
  const cache = createBoundedCache(Math.floor(limit));
  return {
    get: cache.get,
    set: limit < 1 ? () => {} : cache.set,
    delete: cache.delete,
    clear: cache.clear,
  };
}

/** The shared default cache instance. */
export const defaultMdCache = createMdCache(64);

/**
 * Normalize a URL against an optional base. Unresolvable inputs pass
 * through as-is (the injected fetch may still know them).
 * @param {string | URL} url
 * @param {string | URL | undefined} base
 * @returns {string}
 */
function resolveUrl(url, base) {
  try {
    return new URL(url, base).href;
  }
  catch {
    return String(url);
  }
}

/** Plugin and callback identities outlive a cache entry only with their owner. */
const compileReferences = new WeakMap();
let nextCompileReference = 0;

/** @param {object | undefined} value @returns {number | null} */
function referenceKey(value) {
  if (value == null) return null;
  let key = compileReferences.get(value);
  if (key === undefined) {
    key = ++nextCompileReference;
    compileReferences.set(value, key);
  }
  return key;
}

/**
 * Every option the parser or compiled projections read. Plugins and
 * callbacks are identity-keyed: equal names say nothing about their
 * closures. Like the compiled bundle, these inputs are immutable.
 * @param {MdLoadOptions} options
 * @returns {string}
 */
function compileKey(options) {
  return JSON.stringify([
    options.gfm !== false,
    options.frontmatter !== false,
    options.retainSource !== false,
    options.html ?? 'skip',
    options.headingIds === true,
    // Absent uses the footnote namespace; an explicit empty prefix does not.
    options.slugPrefix ?? null,
    options.headingAnchors === true,
    options.footnotesLabel ?? 'Footnotes',
    options.keyed !== false,
    referenceKey(options.toml),
    referenceKey(options.sanitizeUrl),
    (options.plugins ?? []).map(referenceKey),
  ]);
}

const DEFAULT_COMPILE_KEY = compileKey({});

/**
 * Preserve the plain URL key for default compilation, so a default load
 * can still be invalidated with `cache.delete(url)`.
 * @param {string} url
 * @param {MdLoadOptions} options
 * @returns {string}
 */
function cacheKey(url, options) {
  const compiled = compileKey(options);
  return compiled === DEFAULT_COMPILE_KEY ? url : url + '\0' + compiled;
}

/**
 * @param {AbortSignal | undefined} signal
 */
function throwIfAborted(signal) {
  if (signal !== undefined && signal.aborted) {
    throw signal.reason ?? new Error('md load: aborted');
  }
}

/**
 * Fetch + parse one URL (progressively when the body streams).
 * @param {string} url
 * @param {MdLoadOptions} options
 * @param {Record<string, string> | undefined} headers revalidation headers
 * @returns {Promise<{ compiled: CompiledMd, etag: string|null,
 *   lastModified: string|null, status: number }>}
 */
async function fetchAndCompile(url, options, headers) {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const response = await fetchFn(url, {
    signal: options.signal,
    headers,
  });
  if (response.status === 304) {
    return { compiled: /** @type {any} */ (null), etag: null, lastModified: null, status: 304 };
  }
  if (!response.ok) {
    throw new Error(`md load: ${response.status} ${response.statusText} for ${url}`);
  }
  const inc = createIncrementalParser({ ...options, sourceUrl: url });
  let source = '';
  const retain = options.retainSource !== false;
  if (response.body !== null && response.body !== undefined
    && typeof response.body[Symbol.asyncIterator] === 'function') {
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      throwIfAborted(options.signal);
      const piece = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      if (retain) source += piece;
      inc.feed(piece);
    }
    const tail = decoder.decode();
    if (tail !== '') {
      if (retain) source += tail;
      inc.feed(tail);
    }
  }
  else {
    const full = await response.text();
    throwIfAborted(options.signal);
    if (retain) source = full;
    inc.feed(full);
  }
  const doc = inc.end();
  const compiled = compileMarkdown(doc, options);
  if (retain) compiled.source = source;
  const responseHeaders = response.headers;
  return {
    compiled,
    etag: responseHeaders !== undefined ? responseHeaders.get('etag') : null,
    lastModified: responseHeaders !== undefined ? responseHeaders.get('last-modified') : null,
    status: response.status,
  };
}

/**
 * Load and compile a Markdown document from a URL (docs/LOADER.md §1).
 *
 * @example
 * const md = await loadMarkdown('/docs/intro.md', { base: location.href });
 * md.frontmatter; md.toVnode();
 *
 * @param {string | URL} url
 * @param {MdLoadOptions} [options]
 * @returns {Promise<CompiledMd>}
 */
export async function loadMarkdown(url, options = {}) {
  throwIfAborted(options.signal);
  const resolved = resolveUrl(url, options.base);
  const cache = options.cache === false ? null : options.cache ?? defaultMdCache;
  const key = cacheKey(resolved, options);

  if (cache !== null) {
    const entry = cache.get(key);
    if (entry !== undefined) {
      if (entry.promise !== undefined) return entry.promise; // share in-flight
      if (entry.compiled !== undefined) {
        // Serve immediately; revalidate in the background when the
        // origin gave us a validator.
        if ((entry.etag !== null || entry.lastModified !== null) && !entry.revalidating) {
          entry.revalidating = true;
          revalidate(cache, key, entry, resolved, options).catch(() => {
            entry.revalidating = false;
          });
        }
        return entry.compiled;
      }
    }
  }

  // Only this record owns the pending result. An invalidation, eviction
  // or newer load revokes its right to mutate the cache, not its caller's
  // right to receive the response it requested.
  const pending = { promise: /** @type {Promise<CompiledMd> | undefined} */ (undefined) };
  const promise = fetchAndCompile(resolved, options, undefined)
    .then((result) => {
      if (cache !== null && cache.get(key) === pending) {
        cache.set(key, {
          compiled: result.compiled,
          etag: result.etag,
          lastModified: result.lastModified,
          revalidating: false,
        });
      }
      return result.compiled;
    })
    .catch((err) => {
      if (cache !== null && cache.get(key) === pending) cache.delete(key);
      throw err;
    });
  pending.promise = promise;
  if (cache !== null) cache.set(key, pending);
  return promise;
}

/**
 * Conditional refetch of a cached entry (`If-None-Match` /
 * `If-Modified-Since`); a 304 keeps the entry, new content replaces it.
 * @param {MdCache} cache
 * @param {string} key
 * @param {any} entry
 * @param {string} url
 * @param {MdLoadOptions} options
 */
async function revalidate(cache, key, entry, url, options) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (entry.etag !== null) headers['if-none-match'] = entry.etag;
  if (entry.lastModified !== null) headers['if-modified-since'] = entry.lastModified;
  const result = await fetchAndCompile(url, { ...options, signal: undefined }, headers);
  if (cache.get(key) !== entry) return; // invalidated, evicted or replaced while fetching
  if (result.status === 304) {
    entry.revalidating = false;
    return;
  }
  cache.set(key, {
    compiled: result.compiled,
    etag: result.etag,
    lastModified: result.lastModified,
    revalidating: false,
  });
}

/**
 * Stream a Markdown source, yielding completed top-level block nodes
 * as their end becomes certain; the generator's return value is the
 * finished MdDocument (docs/LOADER.md §4).
 *
 * Accepts a URL, a `Response`, a `ReadableStream`, or any (async)
 * iterable of string/Uint8Array chunks.
 *
 * @example
 * for await (const block of streamMarkdown('/big.md')) render(block);
 *
 * @param {any} urlOrStream
 * @param {MdLoadOptions} [options]
 * @returns {AsyncGenerator<MdNode, MdDocument>}
 */
export async function* streamMarkdown(urlOrStream, options = {}) {
  throwIfAborted(options.signal);
  let stream = urlOrStream;
  let sourceUrl = options.sourceUrl ?? null;

  if (typeof urlOrStream === 'string' || urlOrStream instanceof URL) {
    const resolved = resolveUrl(urlOrStream, options.base);
    sourceUrl = resolved;
    const fetchFn = options.fetch ?? globalThis.fetch;
    const response = await fetchFn(resolved, { signal: options.signal });
    if (!response.ok) {
      throw new Error(`md load: ${response.status} ${response.statusText} for ${resolved}`);
    }
    stream = response.body ?? await response.text();
  }
  else if (typeof urlOrStream.body === 'object' && urlOrStream.body !== null
    && typeof urlOrStream.text === 'function') {
    stream = urlOrStream.body; // a Response
  }

  const inc = createIncrementalParser({ ...options, sourceUrl });
  let yielded = 0;
  const decoder = new TextDecoder();

  /** @param {any} chunk @returns {string} */
  const toText = (chunk) =>
    (typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));

  if (typeof stream === 'string') {
    inc.feed(stream);
  }
  else {
    for await (const chunk of stream) {
      throwIfAborted(options.signal);
      const blocks = inc.feed(toText(chunk));
      for (let i = 0; i < blocks.length; i++) {
        yielded++;
        yield blocks[i];
      }
    }
    const tail = decoder.decode();
    if (tail !== '') inc.feed(tail);
  }

  const doc = inc.end();
  for (; yielded < doc.ast.length; yielded++) {
    yield doc.ast[yielded];
  }
  return doc;
}
