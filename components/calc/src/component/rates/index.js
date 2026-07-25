//@ts-check
/**
 * @file The rates layer — the component's impure
 * half. It owns the `rates-fetch` effect and the `rates-poll`
 * subscription, choosing a provider adapter, debouncing to a min refresh
 * interval, and routing success/failure to app actions. It normalizes a
 * rate table into `$.calc.rates`; the **conversion itself** is
 * `@jarenjs/core/convert`'s pure `convertCurrency`, never here.
 *
 * Resilience is the point: a static `FALLBACK_RATES` table keeps the
 * converter, SSR and offline tests working with no network; live rates
 * layer on top only when a fetch succeeds; failures route to an error
 * action.
 */

import { fetchCoinGecko } from './coingecko.js';
import { fetchBinance } from './binance.js';

export { fetchCoinGecko, normalizeCoinGecko, COINGECKO_IDS } from './coingecko.js';
export { fetchBinance, normalizeBinance } from './binance.js';

/** The currency codes the converter offers (fiat + crypto). */
export const CURRENCY_CODES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'BTC', 'ETH', 'USDT', 'BNB', 'SOL'];

/**
 * The static last-resort table (value of one unit in USD). Deterministic,
 * so tests / SSR / offline all render a real conversion with no network.
 * @type {{ base: string, rates: Record<string, number>, at: number, stale: boolean, status: string }}
 */
export const FALLBACK_RATES = {
  base: 'USD',
  rates: {
    USD: 1, EUR: 1.08, GBP: 1.27, JPY: 0.0067, CHF: 1.12, CAD: 0.73, AUD: 0.66,
    BTC: 64000, ETH: 3200, USDT: 1, BNB: 580, SOL: 145,
  },
  at: 0,
  stale: true,
  status: 'fallback',
};

/** Resolve a provider name (or a custom fetcher) to an adapter fn. */
function resolveAdapter(provider) {
  if (typeof provider === 'function') return provider;
  if (provider === 'binance') return fetchBinance;
  return fetchCoinGecko;
}

/**
 * @typedef {object} RatesLayerOptions
 * @property {'coingecko'|'binance'|((codes:string[],o:any)=>Promise<any>)} [provider]
 * @property {number} [refreshMs] minimum interval between live fetches (debounce)
 * @property {typeof globalThis.fetch} [fetch]
 * @property {string} [endpoint]
 * @property {string[]} [codes]
 * @property {() => number} [now] clock (injectable for tests)
 * @property {any} [fallbackRates]
 */

/**
 * Build the rates layer: the `rates-fetch` effect handler, the
 * `rates-poll` subscription handler, the subscription entry and the
 * fallback table.
 * @param {RatesLayerOptions} [options]
 */
export function createRatesLayer(options = {}) {
  const adapter = resolveAdapter(options.provider ?? 'coingecko');
  const refreshMs = options.refreshMs ?? 60000;
  const codes = options.codes ?? CURRENCY_CODES;
  const now = options.now ?? (() => Date.now());
  const fallbackRates = options.fallbackRates ?? FALLBACK_RATES;
  let lastAt = -Infinity;
  let inflight = false;

  /**
   * Fetch once (debounced), dispatching `calc/rates-ok` or
   * `calc/rates-err`. `props.force` bypasses the debounce.
   */
  function fetchOnce(props, dispatch) {
    const t = now();
    if (!props?.force && (inflight || t - lastAt < refreshMs)) return;
    inflight = true;
    lastAt = t;
    Promise.resolve(adapter(codes, { fetch: options.fetch, endpoint: options.endpoint, at: t }))
      .then(
        (table) => { inflight = false; dispatch('calc/rates-ok', { ...table, at: t }); },
        (err) => { inflight = false; dispatch('calc/rates-err', { message: String(err?.message ?? err) }); },
      );
  }

  const effects = {
    /** `{ run: 'rates-fetch', with?: { force?: boolean } }`. */
    'rates-fetch': (props, dispatch) => fetchOnce(props ?? {}, dispatch),
  };

  const subs = {
    /**
     * `rates-poll`: kicks an immediate fetch and repeats every
     * `refreshMs`; the cleanup stops the timer. The app only starts it
     * while the `when` gate holds (converter + currency).
     */
    'rates-poll': (props, dispatch) => {
      fetchOnce({ force: false }, dispatch);
      const id = setInterval(() => fetchOnce({ force: true }, dispatch), refreshMs);
      if (typeof id === 'object' && id && typeof id.unref === 'function') id.unref();
      return () => clearInterval(id);
    },
  };

  /** The subscription entry for the app document (gated to when it matters). */
  const subEntry = {
    run: 'rates-poll',
    when: { $and: [{ $eq: ['$.calc.mode', 'converter'] }, { $eq: ['$.calc.conv.dimension', 'currency'] }] },
  };

  return { effects, subs, subEntry, fallbackRates, codes };
}
