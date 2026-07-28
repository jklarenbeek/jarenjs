//#region benchmark display formatting
// Console-output helpers shared by the suite runners. Display only:
// every payload a runner writes to disk carries raw numbers, so nothing
// here can leak into the tracked website benchmark JSONs.

/** Left-align a value in a column. */
export function pad(value, width) {
  return String(value).padEnd(width);
}

/** Right-align a value in a column. */
export function padLeft(value, width) {
  return String(value).padStart(width);
}

/**
 * A nanosecond reading as a human-scaled time. One formatter for every
 * runner (the suites used to carry four hand-rolled variants of this).
 * @param {number} ns
 * @returns {string}
 */
export function formatNs(ns) {
  if (ns >= 1e9) return `${(ns / 1e9).toFixed(2)} s`;
  if (ns >= 1e6) return `${(ns / 1e6).toFixed(2)} ms`;
  if (ns >= 1e3) return `${(ns / 1e3).toFixed(2)} µs`;
  return `${ns.toFixed(1)} ns`;
}

/**
 * A nanosecond reading as an operations-per-second rate.
 * @param {number} ns
 * @returns {string}
 */
export function formatRate(ns) {
  const ops = 1e9 / ns;
  if (ops >= 1e6) return `${(ops / 1e6).toFixed(1)}M/s`;
  if (ops >= 1e3) return `${(ops / 1e3).toFixed(1)}k/s`;
  return `${ops.toFixed(1)}/s`;
}

//#endregion
