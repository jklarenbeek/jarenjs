//@ts-check
/** Optional host routing for model-only calls. No tools execute inside this boundary. */
export const MODEL_PURPOSES = Object.freeze(['author', 'subcall', 'embedding', 'stylesheet']);

/** @typedef {{ deadlineMs?: number, outputTokens?: number, reasoningTokens?: number }} ModelLimits */
/** @typedef {{ purpose: 'author'|'subcall'|'embedding'|'stylesheet', grammar?: string, depth?: number, limits?: ModelLimits }} ModelContext */

/** A selector returns a route or ordered fallback routes: `{client, identity}`.
 * A route identity is host data; it never controls provider policy. Embedding callers
 * use their embedding API directly: this chat wrapper refuses that purpose so a
 * fallback cannot silently change an index's embedding identity.
 * @param {{ client: any, selectModel?: (context: ModelContext) => any,
 *   limits?: ModelLimits, onRoute?: (event: any) => void, account?: any }} options
 * @param {ModelContext} context */
export function createRoutedClient(options, context) {
  if (!MODEL_PURPOSES.includes(context.purpose) || context.purpose === 'embedding')
    throw new TypeError('chat routing requires author, stylesheet or subcall purpose');
  const limits = { ...options.limits, ...context.limits };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  }
  return {
    endpoint: options.client.endpoint,
    async complete(request) {
      if (request.tools?.length || request.toolChoice !== undefined)
        throw new TypeError('model routing does not retry tool-bearing requests');
      const choice = options.selectModel ? await options.selectModel({ ...context, limits }) : null;
      const routes = choice === null ? [{ client: options.client, identity: 'default' }]
        : Array.isArray(choice) ? choice : [choice];
      if (routes.length === 0) throw new TypeError('selectModel returned no routes');
      let last;
      for (const [index, route] of routes.entries()) {
        if (!route?.client?.complete || typeof route.identity !== 'string' || !route.identity)
          throw new TypeError('a model route needs client and identity');
        request.signal?.throwIfAborted();
        const stopped = options.account?.stop();
        if (stopped) throw new Error(stopped);
        const controller = new AbortController();
        const remaining = options.account?.remaining?.().ms;
        const deadline = Math.min(limits.deadlineMs ?? Infinity, remaining ?? Infinity);
        const signal = request.signal
          ? Number.isFinite(deadline) ? AbortSignal.any([request.signal, controller.signal]) : request.signal
          : controller.signal;
        let timer;
        const started = performance.now();
        const event = { ...context, identity: route.identity, fallback: index, limits, outcome: 'provider', ms: 0, usage: null,
          schemaBytes: request.responseFormat?.schema ? new TextEncoder().encode(JSON.stringify(request.responseFormat.schema)).length : 0,
          finishReason: null, errorCode: null };
        try {
          options.account?.reserve();
          const bounded = { ...request, signal,
            ...(limits.outputTokens ? { maxTokens: Math.min(request.maxTokens ?? Infinity, limits.outputTokens) } : {}),
            ...(limits.reasoningTokens ? { reasoning: { ...request.reasoning,
              max_tokens: Math.min(request.reasoning?.max_tokens ?? Infinity, limits.reasoningTokens) } } : {}),
          };
          const pending = Promise.resolve().then(() => route.client.complete(bounded));
          const reply = await Promise.race([pending, new Promise((_, reject) => {
            const abort = () => reject(signal.reason ?? new Error('aborted'));
            signal.addEventListener('abort', abort, { once: true });
            // Remove the listener when even an abort-ignoring client eventually settles.
            pending.then(() => signal.removeEventListener('abort', abort), () => signal.removeEventListener('abort', abort));
            if (Number.isFinite(deadline)) timer = setTimeout(() => controller.abort(new Error('model deadline')), deadline);
          })]);
          event.usage = reply.usage ?? null;
          event.finishReason = reply.finishReason ?? null;
          options.account?.settle(reply.usage, JSON.stringify(request.messages) + String(reply.message?.content ?? ''));
          const usage = reply.usage;
          if ((limits.outputTokens && usage?.completion_tokens > limits.outputTokens)
            || (limits.reasoningTokens && usage?.completion_tokens_details?.reasoning_tokens > limits.reasoningTokens)) {
            event.outcome = 'token-limit';
            throw new Error('provider exceeded model token ceiling');
          }
          event.outcome = 'complete';
          return reply;
        }
        catch (error) {
          last = error;
          event.errorCode = error?.code ?? error?.name ?? 'Error';
          if (controller.signal.aborted) event.outcome = 'timeout';
          if (request.signal?.aborted) { event.outcome = 'aborted'; throw error; }
        }
        finally { clearTimeout(timer); event.ms = performance.now() - started; options.onRoute?.(event); }
      }
      throw last;
    },
  };
}
