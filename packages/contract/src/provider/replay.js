//@ts-check
/** Explicit, scoped recording of bounded successful safe reads. */
import { canonicalSha256 } from '@jarenjs/json/canonical';
import { createScheduler } from '@jarenjs/core/schedule';
import { utf8ByteLength } from '@jarenjs/core/string';

const credential = /authorization|cookie|token|secret|api[-_]?key/i;
const FORMAT = 'jaren-provider-replay/1';

/**
 * A credential-header-free identity. The host scope must identify the data
 * visibility and schema/provider version; hashes are not authorization.
 * URL parameters, body and public headers must already be public request data.
 * @param {import('./execute.js').ProviderRequest} request
 * @param {{ scope: string, maxBytes?: number }} options @returns {Promise<string>}
 */
export async function providerReplayKey(request, { scope, maxBytes = 262144 }) {
  if (typeof scope !== 'string' || !scope || scope.length > 4096) throw new TypeError('replay requires a bounded host scope');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 67108864) throw new RangeError('invalid replay key byte limit');
  const parts = [scope, request.url, request.method ?? 'GET', request.body ?? '', request.account ?? ''];
  const entries = Object.entries(request.headers ?? {});
  if (entries.length > 1024) throw new RangeError('replay key byte limit');
  for (const [name, value] of entries) parts.push(name, value);
  let bytes = 0;
  if (parts.some(value => typeof value !== 'string' || value.length > maxBytes
    || (bytes += utf8ByteLength(value)) > maxBytes)) throw new RangeError('replay key byte limit');
  const url = new URL(request.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || [...url.searchParams.keys()].some(name => credential.test(name))) throw new TypeError('replay URL must not carry credentials');
  const headers = [...new Headers(request.headers).entries()].filter(([name]) => !credential.test(name));
  return FORMAT + ':' + await canonicalSha256({ scope, url: url.href, method: (request.method ?? 'GET').toUpperCase(),
    headers, body: request.body ?? null, account: request.account ?? null });
}

/** Internal owner. Cache calls keep scheduler credit until actual settlement,
 * even if the caller already received a deadline/cancellation outcome. */
export function createProviderReplay(options, hostError) {
  if (options.cache === undefined) {
    if (options.replay !== undefined || options.cacheScope !== undefined) throw hostError('replay options require a cache');
    return null;
  }
  const { cache, cacheScope, replay = 'auto', now = Date.now } = options;
  if (!cache || typeof cache.get !== 'function' || typeof cache.set !== 'function'
    || typeof cacheScope !== 'string' || !cacheScope || cacheScope.length > 4096 || !['auto', 'record', 'replay'].includes(replay))
    throw hostError('cache requires get/set, an explicit cacheScope and a replay mode');
  const scheduler = createScheduler({ ...options, now });
  const closed = new AbortController();
  const refused = reason => ({ state: reason === 'cancelled' ? 'cancelled' : 'refused', reason, attempts: 0, bytes: 0 });

  async function bounded(task, context) {
    const abort = new AbortController();
    const signal = AbortSignal.any([context.signal, closed.signal, abort.signal]);
    if (signal.aborted) throw new Error('cancelled');
    if (now() >= context.deadline) throw new Error('deadline');
    let timer, listener;
    const stopped = new Promise((_resolve, reject) => {
      listener = () => reject(new Error(abort.signal.aborted ? 'deadline' : 'cancelled'));
      signal.addEventListener('abort', listener, { once: true });
      timer = setTimeout(() => abort.abort(), Math.min(2147483647, Math.max(0, context.deadline - now())));
    });
    try {
      return await Promise.race([scheduler.run(() => task(signal), { signal, deadline: context.deadline, scope: context.scope }), stopped]);
    }
    finally { clearTimeout(timer); signal.removeEventListener('abort', listener); }
  }

  async function run(request, context, perform) {
    if (request.safety !== 'safe-read') return refused('replay-unsafe');
    const scope = JSON.stringify([new URL(request.url).origin, request.account ?? '']);
    context = { ...context, scope };
    let performed;
    try {
      const key = await bounded(() => providerReplayKey(request, { scope: cacheScope, maxBytes: options.maxRequestBytes }), context);
      if (replay !== 'record') {
        const entry = await bounded(signal => cache.get(key, { signal }), context);
        if (entry !== undefined && entry !== null) {
          if (entry.format !== FORMAT || entry.key !== key || !Number.isInteger(entry.status) || entry.status < 200 || entry.status >= 300
            || typeof entry.text !== 'string') return refused('replay-entry-invalid');
          if (entry.text.length > context.maxBytes) return refused('replay-byte-limit');
          const bytes = utf8ByteLength(entry.text);
          if (bytes > context.maxBytes) return refused('replay-byte-limit');
          const status = entry.status, text = entry.text;
          if (context.beforeDispatch && await bounded(() => context.beforeDispatch(request), context) !== true)
            return refused('authority-changed');
          if (context.signal.aborted || closed.signal.aborted) return refused('cancelled');
          if (now() >= context.deadline) return refused('deadline');
          return { state: 'ok', reason: 'replay', attempts: 0, bytes, status, text,
            retryAfterMs: null, retryable: false, replayed: true };
        }
        if (replay === 'replay') return refused('replay-miss');
      }
      const result = await perform();
      performed = result;
      if (result.state === 'ok') {
        const entry = Object.freeze({ format: FORMAT, key, status: result.status, text: result.text });
        await bounded(signal => cache.set(key, entry, { signal }), context);
      }
      return { ...result, replayed: false };
    }
    catch (error) {
      const reason = error?.message;
      return { ...refused(['cancelled', 'deadline', 'queue-full', 'scope-limit', 'closed'].includes(reason) ? reason : 'replay-cache-fault'),
        ...(performed ? { attempts: performed.attempts, bytes: performed.bytes, replayed: false } : {}) };
    }
  }
  return { run, close: async () => { closed.abort(); await scheduler.close(); } };
}
