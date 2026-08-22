//@ts-check
/**
 * Shared derivations over the generated benchmark payloads.
 *
 * A figure published in more than one place is computed here ONCE. The
 * website's overview headline and the figure baked into committed
 * markdown read the same rows, and the moment each carried its own
 * formula the same 456 JSONPath rows were published as both 23.1x (the
 * ratio of arithmetic means) and 8.8x (the geometric mean of the
 * per-row ratios). The geometric mean is the honest cross-row summary:
 * an arithmetic mean over per-query timings is dominated by the few
 * slowest queries, so it reports the widest spread rather than the
 * typical one, and a 10x win and a 10x loss average to parity here
 * instead of to 5x.
 *
 * Every builder takes the `{ engines: { name: ns } }` row shape the
 * per-query profiles emit, and returns `null` rather than a number when
 * no row can answer — an unknown is labeled, never guessed.
 */

import { geoMean } from '@jarenjs/core/math';

/**
 * @typedef {{ engines: Record<string, number> }} ProfileRow
 * @typedef {{ rows: number, mine: number|null, rival: number|null, ratio: number|null }} RatioSummary
 */

/**
 * Two engines summarized over ONE row set: the geometric mean of each
 * engine's own timings and the geometric mean of the per-row ratios.
 * Rows where either engine has no usable timing are dropped from all
 * three, so a published "N ns vs M µs" can never disagree with the
 * published ratio beside it.
 *
 * @param {ProfileRow[]} rows
 * @param {string} mine - the engine the ratio is expressed FOR
 * @param {string} rival
 * @returns {RatioSummary}
 */
export function ratioSummary(rows, mine, rival) {
  const usable = (rows ?? []).filter((r) => {
    const a = r?.engines?.[mine];
    const b = r?.engines?.[rival];
    return Number.isFinite(a) && a > 0 && Number.isFinite(b) && b > 0;
  });
  return {
    rows: usable.length,
    mine: geoMean(usable.map((r) => r.engines[mine])),
    rival: geoMean(usable.map((r) => r.engines[rival])),
    ratio: geoMean(usable.map((r) => r.engines[rival] / r.engines[mine])),
  };
}

/**
 * The canonical cross-row speed summary: the geometric mean of the
 * per-row `rival / mine` ratios, so > 1 reads "mine is N x faster".
 *
 * @param {ProfileRow[]} rows
 * @param {string} mine
 * @param {string} rival
 * @returns {number|null}
 */
export function geoMeanRatio(rows, mine, rival) {
  return ratioSummary(rows, mine, rival).ratio;
}
