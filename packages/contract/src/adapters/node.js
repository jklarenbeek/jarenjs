//@ts-check
/**
 * @file The Node adapter: `toNodeHandler(dispatcher)` puts the dispatcher
 * behind `(req, res)` — `http.createServer`'s listener, and what Express
 * mounts with `app.use`. Dependency-free and STRUCTURALLY typed: nothing
 * here imports `node:http`; the request is anything with `method`, `url`,
 * `headersDistinct` (or `headers`) and a readable-stream event surface,
 * the response anything with `writeHead`/`end`.
 *
 * The body is collected chunk by chunk up to the matched operation's
 * `policy.limits.maxBodyBytes`; on overflow the read stops, the 413 is
 * answered with `connection: close`, and once the response has flushed
 * the socket lingers — draining and discarding the rest of the upload
 * (bounded by a grace timer) before it is destroyed, so the close is a
 * FIN the peer can read the 413 through, not an RST that discards it. A declared `content-length` above the limit
 * is never read at all; an unmatched request's body is never read (the
 * dispatcher answers 404/405 without it and the platform discards the
 * rest). Bytes are handed to the dispatcher as received — for a JSON
 * operation too, so its strict UTF-8 decode decides `JC2005`. Repeated
 * header lines reach the dispatcher as arrays (`headersDistinct`), which
 * is how a repeated scalar header member becomes `JC2015`. `ctx.signal`
 * aborts when the client goes away before the response finished.
 */

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
 * `write` and `flushHeaders` are read only for a streaming (SSE)
 * response.
 * @typedef {Object} NodeResponseLike
 * @property {(status: number, headers?: Record<string, string>) => unknown} writeHead
 * @property {(body?: string | Uint8Array, callback?: () => void) => unknown} end
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} on
 * @property {(chunk: string | Uint8Array) => unknown} [write]
 * @property {() => unknown} [flushHeaders]
 * @property {boolean} [writableFinished]
 * @property {boolean} [headersSent]
 */

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
 * Concatenate collected chunks into one Uint8Array.
 * @param {Uint8Array[]} chunks
 * @param {number} total
 * @returns {Uint8Array}
 */
function concat(chunks, total) {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < chunks.length; i++) {
    out.set(chunks[i], offset);
    offset += chunks[i].byteLength;
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
  /** @type {Record<string, string>} */
  const headers = { ...response.headers };
  if (typeof response.stream === 'function') {
    // an SSE response: headers out immediately, then the pump writes
    // events until the stream ends (the pump ends the response itself);
    // the peer-gone path runs through the request's abort signal
    res.writeHead(response.status, headers);
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    response.stream({
      write: (chunk) => {
        if (typeof res.write === 'function') res.write(chunk);
      },
      end: () => {
        try {
          res.end();
        }
        catch {
          // the socket may already be gone
        }
      },
    });
    return;
  }
  const body = response.body;
  if (body !== null && headers['content-length'] === undefined) {
    headers['content-length'] = String(typeof body === 'string' ? new TextEncoder().encode(body).byteLength : body.byteLength);
  }
  if (close) headers.connection = 'close';
  res.writeHead(response.status, headers);
  if (body === null) res.end(undefined, done);
  else res.end(body, done);
}

/**
 * Put a dispatcher behind Node's `(req, res)` listener.
 * @param {HttpDispatcher} dispatcher
 * @param {{ lingerMs?: number }} [options] - `lingerMs` bounds how long a
 *   closing response waits, draining the peer's unfinished upload, before
 *   the socket is destroyed (default 1000 ms; see the linger comment
 *   below — it is what keeps an overflow 413 readable through the close).
 * @returns {(req: NodeRequestLike, res: NodeResponseLike) => void}
 * @example
 * http.createServer(toNodeHandler(serveHttp(contract, handlers))).listen(8080);
 */
export function toNodeHandler(dispatcher, options = {}) {
  if (dispatcher === null || typeof dispatcher !== 'object' || typeof dispatcher.dispatch !== 'function') {
    throw new TypeError('toNodeHandler: the argument must be a dispatcher from serveHttp');
  }
  const lingerMs = typeof options.lingerMs === 'number' && options.lingerMs >= 0
    ? options.lingerMs : LINGER_MS;
  const contract = dispatcher.contract;
  const head = dispatcher.capabilities.head;

  return function nodeHandler(req, res) {
    const method = req.method === undefined ? 'GET' : req.method;
    const url = req.url === undefined ? '/' : req.url;
    const q = url.indexOf('?');
    const path = q === -1 ? url : url.slice(0, q);
    const headers = headersOf(req);

    const controller = new AbortController();
    res.on('close', () => {
      if (res.writableFinished !== true) controller.abort();
    });

    // Closing a socket with unread data in its receive buffer sends RST,
    // and winsock discards buffered receive data on RST — the flushed 413
    // would never reach a Windows client. So the close lingers: resume the
    // paused request so what is still arriving drains and discards (the
    // settled guard below already ignores it), and destroy only after a
    // grace window, which closes with FIN and leaves the response
    // readable. No request event can drive this — once the response has
    // finished, a paused, unconsumed request emits nothing further — so
    // the window is a plain unref'd timer.
    const lingerThenDestroy = () => {
      if (typeof req.destroy !== 'function' || req.destroyed === true) return;
      if (req.readableEnded === true) {
        req.destroy();
        return;
      }
      if (typeof req.resume === 'function') req.resume();
      const timer = setTimeout(() => {
        if (req.destroyed !== true) req.destroy();
      }, lingerMs);
      if (typeof timer.unref === 'function') timer.unref();
    };
    /** @param {import('../http/wire.js').HttpResponse} response @param {boolean} close */
    const finish = (response, close) => {
      send(res, response, close, close ? lingerThenDestroy : undefined);
    };
    /** @param {string | Uint8Array | null} body @param {boolean} close */
    const answer = (body, close) => {
      dispatcher.dispatch({ method, url, headers, body, signal: controller.signal })
        .then((response) => finish(response, close), (err) => {
          // only JC1004 can arrive here, and this adapter builds a
          // well-formed request; still, a rejection must not hang the socket
          const message = err instanceof Error ? err.message : String(err);
          send(res, { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: message }, true, undefined);
        });
    };

    let hit = null;
    if (mayCarryBody(method)) {
      hit = contract.match(method, path);
      if (hit === null && method === 'HEAD' && head) hit = contract.match('GET', path);
    }
    if (hit === null) {
      answer(null, false);
      return;
    }
    const op = hit.op;
    const limit = op.policy.limits.maxBodyBytes;
    const declared = Number(headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      // the dispatcher answers the 413 from the header; the body is never read
      answer(null, false);
      return;
    }

    /** @type {Uint8Array[]} */
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on('data', (chunk) => {
      if (settled) return;
      const bytes = /** @type {Uint8Array} */ (chunk);
      total += bytes.byteLength;
      if (total > limit) {
        settled = true;
        if (typeof req.pause === 'function') req.pause();
        // an oversize stream: the bytes read so far already exceed the
        // limit, so the dispatcher answers the 413 from that length
        // without a body; the request is destroyed after the response
        // has flushed
        headers['content-length'] = String(total);
        answer(null, true);
        return;
      }
      chunks.push(bytes);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      answer(total === 0 ? null : concat(chunks, total), false);
    });
    req.on('error', () => {
      settled = true;
    });
  };
}
