//@ts-check
/**
 * The async context a host binding carries a caller's state in across its
 * awaits: Node's and Bun's `AsyncLocalStorage`, loaded when a binding first
 * asks for one, as every binding loads its runtime builtin — the one place a
 * driver reaches for it.
 * @returns {Promise<import('node:async_hooks').AsyncLocalStorage<any>>}
 */
export function createAsyncContext() {
  return import('node:async_hooks').then(({ AsyncLocalStorage }) => new AsyncLocalStorage());
}
