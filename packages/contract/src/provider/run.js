//@ts-check
/** Run lifetimes over the existing identify/acquire/release coordinator. */
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { deepFreeze } from '@jarenjs/core/object';
import { resolveLifecycle, identify, acquire, once } from '../host.js';
import { createProviderExecutor, providerHostError } from './execute.js';

/** Privileged host objects cannot belong to two concurrent runs.
 * @type {WeakSet<object>} */
const leased = new WeakSet();
const FIELDS = ['runId', 'actor', 'environment', 'destination', 'revision', 'lease'];

/**
 * @typedef {{ runId: string, actor: string, environment: string,
 * destination: string, revision: string, lease: string }} ProviderAuthority
 */

/**
 * Run a callback with private, isolated transport resources. current() must
 * re-read live authority and return the matching evidence, or null to revoke.
 * The host owns membership, destination resolution, OAuth and account locks.
 * Only opaque evidence and JSON callback results can leave this lifetime.
 * @param {ProviderAuthority} authority
 * @param {{ identify: Function, acquire: Function,
 * current: (evidence: ProviderAuthority, host: any, operation: any) => ProviderAuthority | null | Promise<ProviderAuthority | null>,
 * transport: (request: import('./execute.js').ProviderRequest, context: any) => Promise<Response> }} host
 * @param {(run: any) => any} work
 * @param {import('./execute.js').ProviderExecutorOptions & { signal?: AbortSignal }} [options]
 * @returns {Promise<any>}
 */
export async function withProviderRun(authority, host, work, options = {}) {
  if (!authority || Object.keys(authority).length !== FIELDS.length
    || FIELDS.some((key) => typeof authority[key] !== 'string' || !authority[key]))
    throw providerHostError('authority contains only runId, actor, environment, destination, revision and lease opaque strings');
  if (!host || ['identify', 'acquire', 'current', 'transport'].some((name) => typeof host[name] !== 'function') || typeof work !== 'function')
    throw providerHostError('run needs identify, acquire, current, transport and work capabilities');
  const evidence = deepFreeze(JSON.parse(canonicalizeJson(authority)));
  const lifecycle = resolveLifecycle(host, providerHostError);
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
  let live = true;
  let fault = false;
  const observe = () => { fault = true; };
  const refused = (reason) => ({ state: 'refused', reason, evidence });
  if (signal.aborted) return refused('cancelled');
  const identity = await identify(lifecycle, /** @type {any} */ ({ carrier: 'provider', trace: evidence.runId, signal, evidence }));
  if (identity.kind !== 'lease') return refused('host-fault');
  const releaseIdentity = once(identity.lease.release, observe);
  let releaseAcquired = async () => true;
  let executor;
  let enterPromise;
  let privileged;
  let owns = false;
  /** @type {Set<Promise<any>>} */
  const operations = new Set();
  const track = (promise) => {
    operations.add(promise);
    promise.then(() => operations.delete(promise), () => operations.delete(promise));
    return promise;
  };
  try {
    if (signal.aborted) return refused('cancelled');
    const entered = await acquire(lifecycle, evidence, { host: identity.lease.host }, (lease) => {
      releaseAcquired = once(lease.release, observe);
      enterPromise = (async () => {
        if (!live || signal.aborted) return refused('cancelled');
        privileged = lease.host;
        if (privileged === null || typeof privileged !== 'object') return refused('host-fault');
        if (leased.has(privileged)) {
          releaseAcquired = async () => true;
          return refused('resource-in-use');
        }
        leased.add(privileged);
        owns = true;
        const check = async (operation) => {
          if (!live || signal.aborted) return false;
          let current;
          try { current = await host.current(evidence, privileged, operation); }
          catch { current = null; }
          const allowed = current && FIELDS.every((key) => current[key] === evidence[key]);
          if (!allowed) controller.abort();
          return Boolean(allowed && live && !signal.aborted);
        };
        executor = createProviderExecutor({ ...options,
          transport: (request, context) => host.transport(request, { ...context, host: privileged }),
        });
        const run = Object.freeze(Object.defineProperties({ evidence }, {
          signal: { value: signal },
          execute: { value: (request, context = {}) => track(executor.execute(request, {
            ...context, signal: AbortSignal.any([signal, ...(context.signal ? [context.signal] : [])]),
            beforeDispatch: () => check({ phase: 'dispatch', url: request.url, method: request.method }),
          })) },
          check: { value: () => track(check({ phase: 'publish' })) },
          publish: { value: (value, commit) => track((async () => {
            if (!await check({ phase: 'publish' })) return refused('authority-changed');
            return commit(JSON.parse(canonicalizeJson(value)), evidence);
          })()) },
        }));
        if (!await check({ phase: 'start' })) return refused('authority-changed');
        try {
          const value = await work(run);
          if (signal.aborted || !live) return refused('cancelled');
          return { state: 'complete', evidence, value: JSON.parse(canonicalizeJson(value)) };
        }
        catch { return refused('run-failed'); }
        finally {
          live = false;
          controller.abort();
          await executor.close();
          await Promise.allSettled([...operations]);
        }
      })();
      return enterPromise;
    });
    if (entered.kind !== 'entered' || entered.afterFault) {
      live = false;
      controller.abort();
      await executor?.close();
      await enterPromise;
      return refused('host-fault');
    }
    return entered.result;
  }
  finally { await cleanup(); }

  async function cleanup() {
    live = false;
    controller.abort();
    await executor?.close();
    await Promise.allSettled([...operations]);
    // The host may restore a switched account in release. Every old request,
    // callback and publication has settled before either release begins.
    await releaseAcquired();
    if (owns) leased.delete(privileged);
    await releaseIdentity();
    if (fault) throw providerHostError('provider resource release failed');
  }
}
