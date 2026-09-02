//@ts-check
/**
 * @file The WHATWG adapter: `toFetchHandler(dispatcher)` puts the
 * dispatcher behind `(Request) => Promise<Response>` — the lingua franca
 * of Bun.serve, Deno, service workers and Cloudflare-style hosts.
 * Dependency-free and structurally typed: it needs only the platform's
 * `Request`, `Response` and `Headers`.
 *
 * The adapter hands the request's body stream to the dispatcher as a
 * pull source only when the matched operation can carry one — a JSON
 * operation drains it under its limit there (the strict UTF-8 decode
 * decides `JC2005`, as through the node adapter), an opaque handler
 * pulls it chunk by chunk — refuses a declared `content-length` above
 * the operation's limit BEFORE reading (the dispatcher answers the 413
 * from the header), never reads an unmatched request's body, and hands
 * everything else to `dispatch`. A streamed response body becomes a
 * `ReadableStream` that pulls one chunk per demand. `Headers` combines
 * repeated field lines with `, `, so a repeated scalar header member is
 * invisible here (the node adapter sees distinct lines).
 */

/**
 * @typedef {import('../http/serve.js').HttpDispatcher} HttpDispatcher
 */

/**
 * A Web `ReadableStream` over an async byte source: one `pull` awaits
 * one `next()`, `cancel()` runs the source's `return()` once, and a
 * source that throws errors the stream.
 * @param {AsyncIterable<Uint8Array>} source
 * @returns {ReadableStream<Uint8Array>}
 */
function bodyStream(source) {
  const iterator = source[Symbol.asyncIterator]();
  let cancelled = false;
  return new ReadableStream({
    async pull(controller) {
      let r;
      try {
        r = await iterator.next();
      }
      catch (err) {
        controller.error(err);
        return;
      }
      if (r.done) {
        controller.close();
        return;
      }
      controller.enqueue(r.value);
    },
    async cancel() {
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
    },
  }, { highWaterMark: 0 });
}

/**
 * Whether the request could carry a body the operation reads.
 * @param {string} method
 * @returns {boolean}
 */
function mayCarryBody(method) {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

/**
 * Put a dispatcher behind the WHATWG request/response pair.
 * @param {HttpDispatcher} dispatcher
 * @returns {(request: Request) => Promise<Response>}
 * @example
 * Bun.serve({ fetch: toFetchHandler(serveHttp(contract, handlers)) });
 */
export function toFetchHandler(dispatcher) {
  if (dispatcher === null || typeof dispatcher !== 'object' || typeof dispatcher.dispatch !== 'function') {
    throw new TypeError('toFetchHandler: the argument must be a dispatcher from serveHttp');
  }
  const contract = dispatcher.contract;
  const head = dispatcher.capabilities.head;

  return async function fetchHandler(request) {
    const method = request.method;
    const url = new URL(request.url);
    /** @type {Record<string, string>} */
    const headers = {};
    request.headers.forEach((value, name) => { headers[name] = value; });

    let body = null;
    if (mayCarryBody(method) && request.body !== null) {
      // the matched operation decides how the body is read and how big it
      // may be; a declared content-length over the limit is never read
      const hit = contract.match(method, url.pathname)
        ?? (method === 'HEAD' && head ? contract.match('GET', url.pathname) : null);
      if (hit !== null) {
        const declared = Number(headers['content-length']);
        if (!(Number.isFinite(declared) && declared > hit.op.policy.limits.maxBodyBytes)) {
          // the platform's stream reaches the dispatcher as a pull
          // source: a JSON operation drains it under its limit there,
          // an opaque handler pulls it chunk by chunk
          body = request.body;
        }
      }
    }

    const response = await dispatcher.dispatch({
      method, url: url.pathname + url.search, headers, body, signal: request.signal,
    });
    if (typeof response.stream === 'function') {
      // an SSE response: the pump writes into a ReadableStream that
      // produces on DEMAND — a write settles only when the consumer's
      // pull takes the chunk, so the pump never runs ahead of the
      // reader; a consumer cancel rejects the write waiting for demand
      // and stops the subscription exactly once (the request signal
      // covers the disconnect path too)
      const pump = response.stream;
      const encoder = new TextEncoder();
      /** @type {ReturnType<typeof pump> | null} */
      let runner = null;
      let stopped = false;
      const stopOnce = () => {
        if (stopped) return;
        stopped = true;
        if (runner !== null) runner.stop();
      };
      /** @type {ReadableStreamDefaultController<Uint8Array> | null} */
      let controllerRef = null;
      /** the write waiting for the consumer's demand */
      /** @type {{ chunk: string, resolve: () => void, reject: (reason: unknown) => void } | null} */
      let waiting = null;
      /** the pull no write has answered yet */
      /** @type {(() => void) | null} */
      let demand = null;
      let cancelled = false;
      /** @type {unknown} */
      let cancelReason;
      /** One chunk crosses when a write and a pull are both present. */
      const serve = () => {
        if (waiting === null || demand === null || controllerRef === null) return;
        const w = waiting;
        const d = demand;
        waiting = null;
        demand = null;
        try {
          controllerRef.enqueue(encoder.encode(w.chunk));
        }
        catch (err) {
          w.reject(err);
          d();
          return;
        }
        w.resolve();
        d();
      };
      const streamBody = new ReadableStream({
        start(controller) {
          controllerRef = controller;
          runner = pump({
            write: (chunk) => new Promise((resolve, reject) => {
              if (cancelled) {
                reject(cancelReason);
                return;
              }
              waiting = { chunk, resolve, reject };
              serve();
            }),
            end: () => {
              try {
                controller.close();
              }
              catch {
                // already closed or cancelled
              }
            },
            abort: (reason) => {
              // the carrier is torn down: the consumer's pending read
              // rejects with the reason, and the subscription is
              // released as a destroyed node socket releases it
              try {
                controller.error(reason);
              }
              catch {
                // already closed or cancelled
              }
              stopOnce();
            },
          });
        },
        pull() {
          return new Promise((resolve) => {
            demand = () => resolve(undefined);
            serve();
          });
        },
        cancel(reason) {
          cancelled = true;
          cancelReason = reason === undefined ? new Error('the stream was cancelled') : reason;
          if (waiting !== null) {
            const w = waiting;
            waiting = null;
            w.reject(cancelReason);
          }
          if (demand !== null) {
            const d = demand;
            demand = null;
            d();
          }
          stopOnce();
        },
      }, { highWaterMark: 0 });
      return new Response(streamBody, { status: response.status, headers: response.headers });
    }
    const out = response.body;
    if (out !== null && typeof out === 'object' && !(out instanceof Uint8Array)) {
      // a streamed body: one pull per chunk, cancelled once by the consumer
      return new Response(bodyStream(out), { status: response.status, headers: response.headers });
    }
    return new Response(/** @type {BodyInit | null} */ (out), { status: response.status, headers: response.headers });
  };
}
