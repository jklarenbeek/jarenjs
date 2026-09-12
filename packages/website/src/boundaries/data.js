//@ts-check
/** Private browser worker/identity wiring for the public Data editor. */
import { createTransport as transport, createDataRuntime as runtime, dataViewModel as viewModel } from '@jarenjs/studio/data';
import { dataContract as contract, resolveBootBudgets } from '@jarenjs/studio/data/host';
import { openPortClient } from '@jarenjs/contract/port';
import { DATA_EXAMPLE } from '../content/dataExample.js';
export * from '../content/dataExample.js';
export { oracleSummary } from '@jarenjs/studio/data';
const CHANNEL = 'jaren-data-studio';
/** The key a page may set to shorten the boot budgets (a JSON record of
 * stage → milliseconds) — how the browser proof makes a hung stage fail
 * in seconds rather than the production half-minute. */
export const BOOT_BUDGETS_KEY = 'jaren-data-boot-budgets';

/** The platform deps: the real worker, the real port client, the real
 * channel, and budgets the page's session may shorten. */
function platformDeps() {
  /** @type {unknown} */
  let overrides = null;
  try {
    const stored = globalThis.sessionStorage?.getItem(BOOT_BUDGETS_KEY);
    overrides = stored === null || stored === undefined ? null : JSON.parse(stored);
  }
  catch {
    overrides = null;
  }
  return {
    spawnWorker: () => new Worker(new URL('../db-worker.js', import.meta.url), { type: 'module' }),
    // the wasm build + first store open is real work and is bounded by
    // the boot stages; the per-request window stays for everything after
    openClient: (/** @type {any} */ channel) => openPortClient(contract, { channel, timeoutMs: 30_000 }),
    openChannel: () => new BroadcastChannel(CHANNEL),
    budgets: resolveBootBudgets(overrides),
  };
}


export const createTransport = (deps = platformDeps()) => transport(deps);
export const createDataRuntime = (env = {}) => runtime({ ...DATA_EXAMPLE, transport: () => createTransport(),
  corpus: env.site ? () => env.site.request('site.corpus') : undefined, ...env });
export const dataViewModel = state => viewModel(state, DATA_EXAMPLE);
