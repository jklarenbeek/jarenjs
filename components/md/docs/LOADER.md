# The Jaren Markdown Loader

**Version 0.1 — Specification**

`loadMarkdown` turns any URL into a compiled Markdown document, with
caching, cancellation and streaming as first-class citizens.

## 1. API

```js
const compiled = await loadMarkdown(url, {
  plugins: [],            // compiled into the parser, §PLUGINS.md
  base: undefined,        // base URL for relative url arguments
  signal: undefined,      // AbortSignal — rejects with the abort reason
  cache: defaultMdCache,  // a cache instance, or false to bypass
  fetch: globalThis.fetch,// injectable transport (tests, custom auth)
  retainSource: true,     // false drops the source string after parsing
  toml: undefined,        // injectable TOML frontmatter parser
});
```

Accepted URL schemes are whatever the platform `fetch` accepts:
`http(s):`, `data:`, `blob:`, and relative paths resolved against
`options.base` (or as-is when already absolute). The resolved compiled
document is the same closure bundle `compileMarkdown` returns, with
`doc.meta.sourceUrl` set to the normalized URL.

## 2. Caching

The shared in-memory cache is keyed by **normalized URL**. Each entry
remembers the response's `ETag` and `Last-Modified`; a cache hit
resolves immediately with the cached compiled document, and a
revalidating fetch (`If-None-Match`/`If-Modified-Since`) only replaces
the entry when the origin answers with new content (`200` with a
different validator). Entries also key on every compile-relevant option:
GFM and frontmatter parsing, source retention, HTML handling, heading and
footnote policies, and vnode keys. Plugins and the injected TOML/URL
callbacks key by identity, so equally named plugins with different
implementations never alias. Treat plugin objects and callbacks as
immutable for the lifetime of a compiled document.

- `createMdCache(limit = 64)` — an LRU cache instance; the default
  shared instance is exported as `defaultMdCache`.
- `cache: false` — bypass entirely.
- `cache.delete(url)` — invalidate the normalized URL's default-options
  entry; `cache.clear()` invalidates every entry, including option variants.

Invalidation also revokes a pending load or background revalidation's
right to update that entry. Its original caller still receives its
response, but an older completion cannot restore a cleared entry,
overwrite a newer document, or evict a newer load on failure.

Concurrent `loadMarkdown` calls for the same key share one in-flight
fetch (the promise itself is cached), so a burst of loads costs one
request.

## 3. Cancellation

`options.signal` is passed through to `fetch` and checked between
parse steps; aborting rejects the promise with the signal's reason and
leaves the cache untouched (an aborted in-flight entry is evicted so
the next call retries).

## 4. Streaming

When the response body is a `ReadableStream`, the loader parses
**block-by-block as chunks arrive** instead of buffering the full body:

```js
for await (const block of streamMarkdown(url, options)) {
  render(block);            // top-level AST block nodes, in order
}
```

`streamMarkdown(urlOrStream, options)` accepts a URL, a `Response`, a
`ReadableStream`, or any async iterable of string/Uint8Array chunks,
and yields completed top-level block nodes as soon as their end is
certain (a construct boundary that no later chunk can reopen: a blank
line at container depth zero outside an open fence). The generator's
**return value** is the finished `MdDocument`; `loadMarkdown` itself is
implemented over the same incremental core.

The incremental core is exported for non-URL sources:

```js
const inc = createIncrementalParser(options);
inc.feed(chunk);      // → MdNode[] — blocks completed by this chunk
inc.end();            // → MdDocument — flushes the tail
```

Frontmatter is resolved as soon as its closing fence arrives, so
`inc.frontmatter` (and the first yielded value's document) is available
before the body finishes downloading.

## 5. In an app document (non-normative)

`loadMarkdown` fits `@jarenjs/app`'s effect registry as an ordinary
async effect: an action dispatches `{ effect: 'md.load', with: url }`,
the effect resolves the compiled document and dispatches a completion
action whose payload is the plain `MdDocument` — from there the app's
JSLT view stylesheet takes over (see the README's end-to-end example).
