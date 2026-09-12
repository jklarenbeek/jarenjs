//@ts-check
/** Browser registration of plain operations, with an owned asynchronous lifecycle. */

/** An injected adapter may return this only when an operation had no side effects. */
export const WEBMCP_UNSUPPORTED = Symbol('WebMCP operation unsupported before registration');

/**
 * @typedef {{ name: string, description: string, inputSchema: object,
 *   execute: (input: any, options?: { signal?: AbortSignal }) => any,
 *   annotations?: Record<string, boolean> }} WebMcpTool
 * @typedef {{ code: string, root?: string, error?: unknown }} WebMcpDiagnostic
 * @typedef {{ status: 'pending'|'registered'|'unavailable'|'failed'|'disposed',
 *   registered: number, root: string|null, method: string|null,
 *   error?: unknown, diagnostics: WebMcpDiagnostic[], cleanupErrors: unknown[],
 *   nativeRemoval: 'none'|'unregister'|'abort'|'handle'|'legacy-clear'|'unverified' }} WebMcpResult
 * @typedef {{ context?: unknown, realm?: object,
 *   onError?: (error: unknown) => void, signal?: AbortSignal,
 *   lifecycle?: 'abort'|'callback-only', exclusiveLegacyContext?: boolean }} WebMcpOptions
 */

/** Only an explicitly exclusive legacy binding may clear its whole catalog. */
const legacyOwners = new WeakMap();

/**
 * Register plain, already validated operations. Explicit context overrides are
 * authoritative. Otherwise a usable document context precedes navigator.
 * `ready` resolves after completion; dispose deactivates callbacks immediately
 * and waits for pending registration and owned native cleanup. Neither promise
 * rejects on browser failures. Each explicit call discovers capabilities again.
 *
 * `lifecycle: 'abort'` qualifies a host known to support registration signals.
 * Without an unregister method, cleanup handle or that qualification, callbacks
 * are deactivated and native removal is reported as unverified. A legacy clear
 * requires the host's explicit exclusive-catalog guarantee.
 * @param {WebMcpTool[]} definitions
 * @param {WebMcpOptions} [options]
 */
export function registerWebMcp(definitions, options = {}) {
  const names = new Set();
  for (const tool of definitions) {
    if (!tool || typeof tool.name !== 'string' || !tool.name || names.has(tool.name)
      || typeof tool.description !== 'string' || typeof tool.execute !== 'function'
      || !tool.inputSchema || typeof tool.inputSchema !== 'object')
      throw new TypeError('WebMCP needs uniquely named, invokable tool definitions');
    names.add(tool.name);
  }
  /** @type {WebMcpResult} */
  const result = { status: 'pending', registered: 0, root: null, method: null,
    diagnostics: [], cleanupErrors: [], nativeRemoval: 'none' };
  let active = true, disposed = false;
  const controller = new AbortController();
  /** @type {Promise<WebMcpResult>|undefined} */
  let disposal;
  /** @type {Array<() => unknown>} */
  const removals = [];
  const token = {};
  /** @type {object|undefined} */
  let selected;
  /** @param {unknown} error */
  function report(error) {
    try { options.onError?.(error); }
    catch (hookError) { result.diagnostics.push({ code: 'error-handler-failed', error: hookError }); }
  }
  /** Read accessors inside the failure boundary, including method accessors. */
  function member(object, key, root) {
    try { return object?.[key]; }
    catch (error) { result.diagnostics.push({ code: 'inaccessible', root, error }); return undefined; }
  }
  function candidates() {
    if (Object.hasOwn(options, 'context')) return [{ value: options.context, root: 'explicit' }];
    const realm = options.realm ?? globalThis;
    return ['document', 'navigator'].map(root => ({
      root, value: member(member(realm, root, root), 'modelContext', root),
    }));
  }
  /** @type {WebMcpTool[]} */
  const tools = definitions.map(tool => ({ ...tool, execute(input, execution) {
    if (!active) return { error: 'WebMCP registration is inactive' };
    return tool.execute(input, execution);
  } }));
  async function cleanup() {
    active = false;
    controller.abort();
    for (const remove of removals.splice(0).reverse()) {
      try { await remove(); }
      catch (error) { result.cleanupErrors.push(error); report(error); }
    }
    if (selected && legacyOwners.get(selected) === token) legacyOwners.delete(selected);
  }
  function removal(context, method, name, handle, root) {
    if (typeof handle === 'function') {
      result.nativeRemoval = 'handle';
      removals.push(handle);
      return;
    }
    const handleDispose = member(handle, 'dispose', root);
    if (typeof handleDispose === 'function') {
      result.nativeRemoval = 'handle';
      removals.push(() => handleDispose.call(handle));
      return;
    }
    const unregister = member(context, 'unregisterTool', root);
    if (method === 'registerTool' && typeof unregister === 'function') {
      result.nativeRemoval = 'unregister';
      removals.push(() => unregister.call(context, name));
      return;
    }
    const clear = member(context, 'clearContext', root);
    if (method === 'provideContext' && options.exclusiveLegacyContext && typeof clear === 'function') {
      result.nativeRemoval = 'legacy-clear';
      removals.push(() => legacyOwners.get(context) === token ? clear.call(context) : undefined);
      return;
    }
    result.nativeRemoval = options.lifecycle === 'abort' ? 'abort' : 'unverified';
    if (result.nativeRemoval === 'unverified' && !result.diagnostics.some(d => d.code === 'native-removal-unverified'))
      result.diagnostics.push({ code: 'native-removal-unverified', root });
  }
  async function register() {
    const seen = new Set();
    for (const { value: context, root } of candidates()) {
      if (disposed) break;
      if (context == null || (typeof context !== 'object' && typeof context !== 'function')) {
        result.diagnostics.push({ code: context == null ? 'absent' : 'incompatible', root });
        continue;
      }
      if (seen.has(context)) continue;
      seen.add(context);
      let usable = false;
      for (const method of ['registerTool', 'provideContext']) {
        const invoke = member(context, method, root);
        if (typeof invoke !== 'function') continue;
        usable = true;
        selected = context;
        result.root = root;
        result.method = method;
        const batch = method === 'registerTool' ? tools : [{ tools }];
        let unsupported = false;
        try {
          for (const item of batch) {
            if (disposed) break;
            const handle = await invoke.call(context, item, { signal: controller.signal });
            if (handle === WEBMCP_UNSUPPORTED) {
              if (result.registered) throw new Error('WebMCP became unsupported after partial registration');
              unsupported = true;
              result.diagnostics.push({ code: 'unsupported-before-registration', root });
              break;
            }
            result.registered += method === 'registerTool' ? 1 : tools.length;
            if (method === 'provideContext') legacyOwners.set(context, token);
            removal(context, method, 'name' in item ? item.name : undefined, handle, root);
          }
          if (unsupported) continue;
          result.status = disposed ? 'disposed' : 'registered';
          if (disposed) await cleanup();
          return result;
        }
        catch (error) {
          result.error = error;
          result.status = disposed ? 'disposed' : 'failed';
          report(error);
          await cleanup();
          return result;
        }
      }
      if (!usable) result.diagnostics.push({ code: 'incompatible', root });
    }
    active = false;
    result.status = disposed ? 'disposed' : 'unavailable';
    return result;
  }
  /** Stop callbacks now, including while the browser is still registering. */
  function dispose() {
    if (disposal) return disposal;
    disposed = true;
    active = false;
    controller.abort();
    options.signal?.removeEventListener('abort', onAbort);
    disposal = ready.then(async () => { await cleanup(); result.status = 'disposed'; return result; });
    return disposal;
  }
  function onAbort() { void dispose(); }
  /** @type {(value: WebMcpResult) => void} */
  let complete;
  /** @type {Promise<WebMcpResult>} */
  const ready = new Promise(resolve => { complete = resolve; });
  if (options.signal?.aborted) { disposed = true; active = false; controller.abort(); }
  else options.signal?.addEventListener('abort', onAbort, { once: true });
  void register().then(complete, error => {
    result.error = error; result.status = 'failed'; active = false; report(error);
    complete(result);
  });
  return { ready, dispose, get status() { return result.status; } };
}
