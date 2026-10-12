//@ts-check
/**
 * @file The one timer clamp of the package.
 */

/**
 * A duration as a timer can wait it: a whole number of milliseconds no
 * longer than 2^31 - 1 (about 24.8 days). A longer delay runs at 1 ms, which
 * would make a long heartbeat a flood on the server, a missed one at once on
 * the client, and a long timeout an instant one; a fraction makes
 * `AbortSignal.timeout` throw. A bound that long waits as long as a timer can.
 * @param {number} ms
 * @returns {number}
 */
export function timerMs(ms) {
  return Math.min(Math.ceil(ms), 2 ** 31 - 1);
}
