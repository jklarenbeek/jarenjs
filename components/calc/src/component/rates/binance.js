//@ts-check
/**
 * @file The Binance rate adapter (alternative provider). Reads
 * `/api/v3/ticker/price` (crypto USDT pairs), no key. Same one-way rule:
 * fetch + normalize only; conversion is core's `convertCurrency`.
 */

const DEFAULT_ENDPOINT = 'https://api.binance.com/api/v3/ticker/price';

/**
 * Normalize a Binance ticker list into `{ base, rates, at }`. Only
 * `*USDT` pairs are used; the base is USDT (≈ USD, also mapped to USD 1).
 * @param {Array<{symbol:string, price:string|number}>} data @param {number} at
 * @returns {{ base: string, rates: Record<string, number>, at: number }}
 */
export function normalizeBinance(data, at = 0) {
  /** @type {Record<string, number>} */
  const rates = { USDT: 1, USD: 1 };
  if (Array.isArray(data)) {
    for (const t of data) {
      if (typeof t.symbol === 'string' && t.symbol.endsWith('USDT')) {
        const sym = t.symbol.slice(0, -4);
        const price = Number(t.price);
        if (Number.isFinite(price)) rates[sym] = price;
      }
    }
  }
  return { base: 'USDT', rates, at };
}

/**
 * Fetch and normalize Binance rates.
 * @param {string[]} codes
 * @param {{ fetch?: typeof globalThis.fetch, endpoint?: string, at?: number }} [opts]
 * @returns {Promise<{ base: string, rates: Record<string, number>, at: number }>}
 */
export async function fetchBinance(codes, opts = {}) {
  const f = opts.fetch ?? globalThis.fetch;
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  const res = await f(endpoint);
  if (!res.ok) throw new Error(`Binance HTTP ${res.status}`);
  const data = await res.json();
  return normalizeBinance(data, opts.at ?? 0);
}
