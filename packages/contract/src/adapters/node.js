//@ts-check
/**
 * @file The Node adapter: `toNodeHandler(dispatcher)` puts the dispatcher
 * behind `(req, res)` — `http.createServer`'s listener, and what Express
 * mounts with `app.use`. Dependency-free and STRUCTURALLY typed: nothing
 * here imports `node:http`; the request is anything with `method`, `url`,
 * `headersDistinct` (or `headers`) and a readable-stream event surface,
 * the response anything with `writeHead`/`end`.
 *
 * The body reaches the dispatcher as a PULL SOURCE over the request's
 * own chunks — nothing is collected here: a JSON operation drains it
 * under `policy.limits.maxBodyBytes` in the dispatcher (its strict
 * UTF-8 decode decides `JC2005`), an opaque handler pulls it one chunk
 * at a time through a source that never yields past the limit. When an
 * upload was pulled and left unread (a limit crossing, a response
 * before EOF) the answer carries `connection: close`, and once it has
 * flushed the socket lingers — draining and discarding the rest of the
 * upload (bounded by a grace timer) before it is destroyed, so the
 * close is a FIN the peer can read the 413 through, not an RST that
 * discards it. A declared `content-length` above the limit is never
 * read at all; an unmatched request's body is never read (the
 * dispatcher answers 404/405 without it and the platform discards the
 * rest). A streamed response body is written chunk by chunk behind the
 * socket's `drain`. Repeated
 * header lines reach the dispatcher as arrays (`headersDistinct`), which
 * is how a repeated scalar header member becomes `JC2015`. `ctx.signal`
 * aborts when the client goes away before the response finished. A
 * streaming (SSE) response writes each event only after the previous
 * one drained: a `res.write()` that answers `false` parks the pump
 * until `drain`, so a slow reader never grows the process's buffers.
 */

import { discard } from '../http/body.js';
import { createAwaitedSink } from '@jarenjs/core/async';

/**
 * @typedef {import('../http/serve.js').HttpDispatcher} HttpDispatcher
 */

/**
 * The request surface the adapter reads — `http.IncomingMessage` fits.
 * @typedef {Object} NodeRequestLike
 * @property {string} [method]
 * @property {string} [url]
 * @property {Record<string, string[] | undefined>} [headersDistinct]
 * @property {Record<string, string | string[] | undefined>} headers
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} on
 * @property {() => unknown} [pause]
 * @property {() => unknown} [resume]
 * @property {(error?: Error) => unknown} [destroy]
 * @property {boolean} [readableEnded]
 * @property {boolean} [destroyed]
 */

/** How long a closing response waits for the peer's upload to end before
 * destroying the socket anyway. Long enough for a client that finishes
 * writing once it sees the response; short enough that a peer that never
 * stops cannot hold the socket. The timer is unref'd. */
const LINGER_MS = 1000;

/**
 * The response surface the adapter writes — `http.ServerResponse` fits.
 * `write`, `flushHeaders`, `once`/`removeListener` (or `off`),
 * `destroy`, `destroyed` and `writableEnded` are read only for a
 * streaming (SSE) response: `write`'s `false` is waited out on `drain`
 * (settled on `close`/`error` too, with the listeners removed), and a
 * response already ended or destroyed refuses the write instead of
 * emitting `write after end`.
 * @typedef {Object} NodeResponseLike
 * @property {(status: number, headers?: Record<string, string | readonly string[]>) => unknown} writeHead
 * @property {(body?: string | Uint8Array, callback?: () => void) => unknown} end
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} on
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} [once]
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} [removeListener]
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} [off]
 * @property {(chunk: string | Uint8Array) => unknown} [write]
 * @property {() => unknown} [flushHeaders]
 * @property {(error?: Error) => unknown} [destroy]
 * @property {boolean} [writableFinished]
 * @property {boolean} [writableEnded]
 * @property {boolean} [destroyed]
 * @property {boolean} [headersSent]
 */

/**
 * The streaming sink over a platform response: `write` hands the chunk
 * to `res.write` and answers nothing when the platform took it (`true`),
 * or a promise that resolves on the next `drain` when it answered
 * `false` — so the pump behind it writes the next event only once the
 * socket has room — and rejects when the response closes or errors
 * first. Every listener the wait registered is removed at settlement.
 * `end` ends the response; `abort` destroys it.
 * @param {NodeResponseLike} res
 * @returns {import('@jarenjs/core/async').SinkLike<string>}
 */
function responseSink(res) {
  const listen = typeof res.once === 'function' ? res.once.bind(res) : res.on.bind(res);
  const unlisten = typeof res.removeListener === 'function'
    ? res.removeListener.bind(res)
    : typeof res.off === 'function' ? res.off.bind(res) : null;
  return {
    write: (chunk) => {
      if (typeof res.write !== 'function') return undefined;
      if (res.writableEnded === true || res.destroyed === true) {
        return Promise.reject(new Error('the response is closed'));
      }
      let taken;
      try {
        taken = res.write(chunk);
      }
      catch (err) {
        return Promise.reject(err);
      }
      if (taken !== false) return undefined;
      return new Promise((resolve, reject) => {
        let settled = false;
        /** @type {() => void} */
        const off = () => {
          settled = true;
          if (unlisten === null) return;
          unlisten('drain', onDrain);
          unlisten('close', onClose);
          unlisten('error', onError);
        };
        const onDrain = () => {
          if (settled) return;
          off();
          resolve();
        };
        const onClose = () => {
          if (settled) return;
          off();
          reject(new Error('the response closed before it drained'));
        };
        /** @param {unknown} err */
        const onError = (err) => {
          if (settled) return;
          off();
          reject(err);
        };
        listen('drain', onDrain);
        listen('close', onClose);
        listen('error', onError);
      });
    },
    end: () => {
      try {
        res.end();
      }
      catch {
        // the socket may already be gone
      }
    },
    abort: () => {
      if (typeof res.destroy === 'function' && res.destroyed !== true) res.destroy();
    },
  };
}

/**
 * The request as a pull source of its body chunks — what a body-carrying
 * matched request hands the dispatcher. Chunks come from the platform's
 * own async iterator (paused between pulls, so an unpulled upload never
 * fills memory); `return()` does NOT destroy the request — a mid-upload
 * cancel (a limit crossing, a response before EOF) must answer through
 * a readable close, so the source only records that it was cancelled
 * and `send` lingers and destroys after the response flushed. `state`
 * says whether the request was pulled at all and whether it reached
 * EOF, which decides `connection: close`.
 * @param {NodeRequestLike} req
 * @returns {AsyncIterable<Uint8Array> & { state: { started: boolean, ended: boolean, cancelled: boolean } }}
 */
function requestSource(req) {
  const state = { started: false, ended: false, cancelled: false };
  /** @type {AsyncIterator<Uint8Array> | null} */
  let inner = null;
  return {
    state,
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (state.ended || state.cancelled) return { done: true, value: undefined };
          state.started = true;
          if (inner === null) {
            const iterable = /** @type {any} */ (req);
            if (typeof iterable[Symbol.asyncIterator] !== 'function') {
              state.ended = true;
              return { done: true, value: undefined };
            }
            inner = iterable[Symbol.asyncIterator]();
          }
          let r;
          try {
            r = await inner.next();
          }
          catch (err) {
            state.cancelled = true;
            throw err;
          }
          if (r.done) {
            state.ended = true;
            return { done: true, value: undefined };
          }
          return { done: false, value: r.value };
        },
        async return(value) {
          // no destroy here: the response decides how the socket closes
          state.cancelled = true;
          if (typeof req.pause === 'function') req.pause();
          return { done: true, value };
        },
      };
    },
  };
}

/**
 * Write a streamed response body: chunk by chunk through the
 * drain-aware sink, then end; the peer going away — or a sink failure —
 * cancels the source exactly once, and a source that throws destroys
 * the response (its status is already on the wire; the body is cut).
 * @param {NodeResponseLike} res
 * @param {AsyncIterable<Uint8Array>} body
 * @param {(() => void) | undefined} done
 */
function pumpBody(res, body, done) {
  const sink = createAwaitedSink(responseSink(res));
  const iterator = body[Symbol.asyncIterator]();
  let cancelled = false;
  const cancel = async () => {
    if (cancelled) return;
    cancelled = true;
    if (typeof iterator.return === 'function') {
      try {
        await iterator.return();
      }
      catch {
        // the source refused its cancel; it is released either way
      }
    }
  };
  const onClose = () => {
    if (res.writableFinished !== true) void cancel();
  };
  res.on('close', onClose);
  (async () => {
    try {
      for (;;) {
        const r = await iterator.next();
        if (r.done) break;
        if (cancelled) break;
        await sink.write(r.value);
      }
      if (cancelled) {
        await sink.abort(new Error('the response was cancelled'));
        return;
      }
      await sink.end();
      if (done !== undefined) done();
    }
    catch (err) {
      // a source that threw, or a sink that failed: the body is cut
      await cancel();
      await sink.abort(err).catch(() => undefined);
    }
  })();
}

/** The statuses that carry no content (RFC 9110 §15.3.5, §15.3.6, §15.4.5). */
const NO_CONTENT = new Set([204, 205, 304]);

/**
 * Whether the request could carry a body the operation reads.
 * @param {string} method
 * @returns {boolean}
 */
function mayCarryBody(method) {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

/**
 * The lowercase header table: distinct lines when the platform exposes
 * them (a single line stays a string, repeats become an array), the
 * combined table otherwise.
 * @param {NodeRequestLike} req
 * @returns {Record<string, string | string[]>}
 */
function headersOf(req) {
  /** @type {Record<string, string | string[]>} */
  const out = {};
  const distinct = req.headersDistinct;
  if (distinct !== undefined && distinct !== null) {
    const names = Object.keys(distinct);
    for (let i = 0; i < names.length; i++) {
      const lines = distinct[names[i]];
      if (lines === undefined || lines.length === 0) continue;
      out[names[i].toLowerCase()] = lines.length === 1 ? lines[0] : lines.slice();
    }
    return out;
  }
  const names = Object.keys(req.headers);
  for (let i = 0; i < names.length; i++) {
    const v = req.headers[names[i]];
    if (v === undefined) continue;
    out[names[i].toLowerCase()] = Array.isArray(v) ? v.slice() : v;
  }
  return out;
}

/**
 * Write a dispatcher response to the platform response.
 * @param {NodeResponseLike} res
 * @param {import('../http/wire.js').HttpResponse} response
 * @param {boolean} close - add `connection: close` (an aborted upload)
 * @param {(() => void) | undefined} done
 */
function send(res, response, close, done) {
  // a list value stays a list: `writeHead` emits one field line per
  // item, which is how `set-cookie` repeats
  /** @type {Record<string, string | readonly string[]>} */
  const headers = { ...response.headers };
  if (typeof response.stream === 'function') {
    // an SSE response: headers out immediately, then the pump writes
    // events until the stream ends (the pump ends the response itself),
    // each event only once the previous one drained; the peer-gone path
    // runs through the request's abort signal
    res.writeHead(response.status, headers);
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    response.stream(responseSink(res));
    return;
  }
  const body = response.body;
  if (close) headers.connection = 'close';
  if (NO_CONTENT.has(response.status)) {
    // a status that carries no content sends none, whatever arrived: a
    // stream handed over anyway is released, never pumped
    if (body !== null && typeof body === 'object' && !(body instanceof Uint8Array)) void discard(body);
    delete headers['content-length'];
    res.writeHead(response.status, headers);
    res.end(undefined, done);
    return;
  }
  if (body !== null && typeof body === 'object' && !(body instanceof Uint8Array)) {
    // a streamed body: chunked, each chunk behind the previous one's
    // drain; the peer going away cancels the source once
    res.writeHead(response.status, headers);
    pumpBody(res, body, done);
    return;
  }
  if (body !== null && headers['content-length'] === undefined) {
    headers['content-length'] = String(typeof body === 'string' ? new TextEncoder().encode(body).byteLength : body.byteLength);
  }
  res.writeHead(response.status, headers);
  if (body === null) res.end(undefined, done);
  else res.end(body, done);
}

/**
 * The dispatch request of one Node request, with its body source and
 * the Node request it came from — what `writeNodeResponse` reads to
 * decide `connection: close` and the linger.
 * @typedef {import('../http/wire.js').HttpRequest & {
 *   body: (AsyncIterable<Uint8Array> & { state: { started: boolean, ended: boolean, cancelled: boolean } }) | null,
 *   signal: AbortSignal,
 * }} NodeDispatchRequest
 */

/** The Node request each `nodeRequest` result came from. */
const origins = new WeakMap();

/**
 * @param {unknown} dispatcher
 * @param {string} who
 */
function requireDispatcher(dispatcher, who) {
  if (dispatcher === null || typeof dispatcher !== 'object' || typeof (/** @type {any} */ (dispatcher)).dispatch !== 'function') {
    throw new TypeError(`${who}: the dispatcher must come from serveHttp`);
  }
}

/**
 * The dispatch request of a Node request, built exactly as
 * `toNodeHandler` builds it — for a framework-native route that runs its
 * own guards first and then calls `dispatcher.dispatch` itself:
 * - the lowercase header table (repeated lines as arrays);
 * - the body as a PULL SOURCE over the request's own chunks, read only
 *   for an operation that takes one, and never when a declared
 *   `content-length` already exceeds its limit (the dispatcher answers
 *   the 413 from the header);
 * - a `signal` that aborts when the client goes away before the response
 *   finished — what stops a stream and reaches `ctx.signal`.
 *
 * The request's body stream must be unread: a framework that parsed it
 * leaves nothing to pull, so register the contract's routes where their
 * body stays raw (the README's Fastify recipe).
 * @param {HttpDispatcher} dispatcher
 * @param {NodeRequestLike} req
 * @param {NodeResponseLike} res
 * @returns {NodeDispatchRequest}
 * @example
 * const incoming = nodeRequest(dispatcher, req.raw, reply.raw);
 * const response = await dispatcher.dispatch({ ...incoming, request: req.user });
 * reply.hijack();
 * writeNodeResponse(reply.raw, response, { from: incoming });
 */
export function nodeRequest(dispatcher, req, res) {
  requireDispatcher(dispatcher, 'nodeRequest');
  const method = req.method === undefined ? 'GET' : req.method;
  const url = req.url === undefined ? '/' : req.url;
  const q = url.indexOf('?');
  const path = q === -1 ? url : url.slice(0, q);
  const headers = headersOf(req);
  const controller = new AbortController();
  res.on('close', () => {
    if (res.writableFinished !== true) controller.abort();
  });
  let body = null;
  if (mayCarryBody(method)) {
    const hit = dispatcher.contract.match(method, path);
    if (hit !== null) {
      const declared = Number(headers['content-length']);
      if (!(Number.isFinite(declared) && declared > hit.op.policy.limits.maxBodyBytes)) body = requestSource(req);
    }
  }
  /** @type {NodeDispatchRequest} */
  const incoming = { method, url, headers, body, signal: controller.signal };
  origins.set(incoming, req);
  return incoming;
}

/**
 * Write a dispatcher response to a Node response — the writer
 * `toNodeHandler` uses, for a framework route that dispatched itself
 * (Fastify after `reply.hijack()`, say):
 * - a streamed body is pumped chunk by chunk behind the socket's `drain`,
 *   and the peer going away cancels it once;
 * - a subscribe answer (SSE) writes each event only after the previous one
 *   drained, so a slow reader parks the source instead of growing a buffer;
 * - a status without content sends none.
 *
 * With `from` (what `nodeRequest` built), an upload that was pulled and
 * left unread closes the connection. The socket then lingers, draining the
 * rest, before it is destroyed, so the peer can read the answer through
 * the close. An answer Node refuses to write never escapes as a throw:
 * before the head is out a plain 500 replaces it, after it the socket goes.
 * @param {NodeResponseLike} res
 * @param {import('../http/wire.js').HttpResponse} response
 * @param {{ from?: NodeDispatchRequest, lingerMs?: number }} [options]
 * @returns {void}
 */
export function writeNodeResponse(res, response, options = {}) {
  if (options === null || typeof options !== 'object') throw new TypeError('writeNodeResponse: options must be an object');
  const lingerMs = typeof options.lingerMs === 'number' && options.lingerMs >= 0 ? options.lingerMs : LINGER_MS;
  const source = options.from === undefined ? null : options.from.body;
  const close = source !== null && source.state.started && !source.state.ended;
  const req = options.from === undefined ? undefined : origins.get(options.from);
  write(res, response, close, close && req !== undefined ? () => lingerThenDestroy(req, lingerMs) : undefined);
}

/**
 * `send`, guarded: an answer Node refuses to write (a header value it
 * rejects) must neither crash the process nor hang the socket.
 * @param {NodeResponseLike} res
 * @param {import('../http/wire.js').HttpResponse} response
 * @param {boolean} close
 * @param {(() => void) | undefined} done
 */
function write(res, response, close, done) {
  try {
    send(res, response, close, done);
  }
  catch (err) {
    // a streamed body that will never be written is released, never left
    // open (its release runs the request's deferred leases)
    const body = response.body;
    if (body !== null && typeof body === 'object' && !(body instanceof Uint8Array)) void discard(body);
    if (res.headersSent) {
      if (typeof res.destroy === 'function') res.destroy(err instanceof Error ? err : undefined);
      return;
    }
    const names = typeof (/** @type {any} */ (res)).getHeaderNames === 'function' ? /** @type {any} */ (res).getHeaderNames() : [];
    for (const name of names) /** @type {any} */ (res).removeHeader(name);
    send(res, { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: 'the response could not be written' }, true, undefined);
  }
}

/**
 * Closing a socket with unread data in its receive buffer sends RST, and
 * winsock discards buffered receive data on RST — the flushed 413 would
 * never reach a Windows client. So the close lingers: resume the paused
 * request so what is still arriving drains and discards, and destroy only
 * after a grace window, which closes with FIN and leaves the response
 * readable. No request event can drive this — once the response has
 * finished, a paused, unconsumed request emits nothing further — so the
 * window is a plain unref'd timer.
 * @param {NodeRequestLike} req
 * @param {number} lingerMs
 */
function lingerThenDestroy(req, lingerMs) {
  if (typeof req.destroy !== 'function' || req.destroyed === true) return;
  if (req.readableEnded === true) {
    req.destroy();
    return;
  }
  if (typeof req.resume === 'function') req.resume();
  const timer = setTimeout(() => {
    if (req.destroyed !== true) /** @type {NonNullable<NodeRequestLike['destroy']>} */ (req.destroy)();
  }, lingerMs);
  if (typeof timer.unref === 'function') timer.unref();
}

/**
 * Put a dispatcher behind Node's `(req, res)` listener.
 * @param {HttpDispatcher} dispatcher
 * @param {{ lingerMs?: number, request?: (req: NodeRequestLike) => unknown }} [options] -
 *   `lingerMs` bounds how long a closing response waits, draining the peer's
 *   unfinished upload, before the socket is destroyed (default 1000 ms — it
 *   is what keeps an overflow 413 readable through the close); `request` is a
 *   per-request seed — its answer reaches `identify` as `meta.request`, so a
 *   principal a framework decorated onto the request (`req.user`) needs no
 *   side channel. A seed that throws answers a plain 500.
 * @returns {(req: NodeRequestLike, res: NodeResponseLike) => void}
 * @example
 * http.createServer(toNodeHandler(serveHttp(contract, handlers))).listen(8080);
 */
export function toNodeHandler(dispatcher, options = {}) {
  requireDispatcher(dispatcher, 'toNodeHandler');
  if (options === null || typeof options !== 'object') throw new TypeError('toNodeHandler: options must be an object');
  const lingerMs = typeof options.lingerMs === 'number' && options.lingerMs >= 0
    ? options.lingerMs : LINGER_MS;
  const seed = options.request;
  if (seed !== undefined && typeof seed !== 'function') throw new TypeError('toNodeHandler: options.request must be a function (req) => unknown');

  return function nodeHandler(req, res) {
    const incoming = nodeRequest(dispatcher, req, res);
    /** @type {import('../http/wire.js').HttpRequest} */
    let request = incoming;
    if (seed !== undefined) {
      try {
        request = { ...incoming, request: seed(req) };
      }
      catch {
        write(res, { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'the request seed failed' }, true, undefined);
        return;
      }
    }
    dispatcher.dispatch(request).then(
      (response) => writeNodeResponse(res, response, { from: incoming, lingerMs }),
      (err) => {
        // only JC1004 can arrive here, and this adapter builds a
        // well-formed request; still, a rejection must not hang the socket
        const message = err instanceof Error ? err.message : String(err);
        write(res, { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: message }, true, undefined);
      });
  };
}
