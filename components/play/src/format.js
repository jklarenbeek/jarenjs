//@ts-check
/**
 * @file Display formatting shared by the engine layer (the deep "how it
 * ran" stat cards) and the component layer (the stage's timing line).
 */

/**
 * A measured duration as a stage label. Anything that is not a number —
 * including the `null` an engine reports for a phase it does not have, or
 * one the host never measured — is an em dash rather than a fabricated
 * `0`, which would read as "ran in no time" instead of "not measured".
 * Sub-hundredth-millisecond work prints as a floor: two decimals is the
 * resolution the cards claim, and `0.00 ms` would over-claim it.
 * @param {unknown} ms
 * @returns {string}
 */
export function formatMs(ms) {
  if (typeof ms !== 'number') return '—';
  return ms < 0.01 ? '<0.01 ms' : `${ms.toFixed(2)} ms`;
}
