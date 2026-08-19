//@ts-check
/**
 * @file The WHATWG adapter: `toFetchHandler(dispatcher)` puts the
 * dispatcher behind `(Request) => Promise<Response>` — the lingua franca
 * of Bun.serve, Deno, service workers and Cloudflare-style hosts.
 * Dependency-free and structurally typed: it needs only the platform's
 * `Request`, `Response` and `Headers`.
 *
 * The adapter reads the body only when the matched operation can carry
 * one (`text()` for a JSON operation, `arrayBuffer()` for an opaque one),
 * refuses a declared `content-length` above the operation's limit
 * BEFORE reading (the dispatcher answers the 413 from the header), never
 * reads an unmatched request's body, and hands everything else to
 * `dispatch`. `Headers` combines repeated field lines with `, `, so a
 * repeated scalar header member is invisible here (the node adapter sees
 * distinct lines); `text()` decodes with replacement, so invalid UTF-8
 * reaches the JSON parser as U+FFFD (the node adapter hands bytes over
 * and the dispatcher's strict decode answers `JC2005`).
 */

/**
 * @typedef {import('../http/serve.js').HttpDispatcher} HttpDispatcher
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
          body = hit.op.http.opaque ? new Uint8Array(await request.arrayBuffer()) : await request.text();
        }
      }
    }

    const response = await dispatcher.dispatch({
      method, url: url.pathname + url.search, headers, body, signal: request.signal,
    });
    return new Response(/** @type {BodyInit | null} */ (response.body), { status: response.status, headers: response.headers });
  };
}
