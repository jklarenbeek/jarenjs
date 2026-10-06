//@ts-check
/** Live bounds shared by construction preflight and the optional resnapshot host. */
export const LIVE_DEFAULTS = Object.freeze({ maxQueries: 64, maxMaintained: 10_000, maxBytes: 4194304 });
export const ASYNC_LIVE_DEFAULTS = Object.freeze({ ...LIVE_DEFAULTS,
  maxInputRows: 10000, maxInputBytes: 4194304, maxObservers: 8,
  pollMs: 1000, pageRows: 32, maxAttempts: 3 });
