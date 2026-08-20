//@ts-check
/**
 * @file The `./sse` subpath of @jarenjs/ai: the data-only Server-Sent-
 * Events decoder the streaming client consumes — the one SSE codec of
 * the suite, which lives in `@jarenjs/core/text/sse` and is re-exported
 * here so this package's public surface is unchanged. Feed it network
 * chunks in any split (mid-line, mid-event, CR/LF/CRLF); it yields the
 * complete `data:` payloads in order; non-data fields and comments are
 * ignored, multi-line data joins with a newline per the specification.
 */

export { createSseDecoder } from '@jarenjs/core/text/sse';
