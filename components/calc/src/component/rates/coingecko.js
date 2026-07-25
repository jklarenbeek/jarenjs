//@ts-check
/**
 * @file The CoinGecko rate adapter. The **only**
 * network code path for the default provider — it fetches and normalizes,
 * nothing more. The pure conversion is `@jarenjs/core/convert`'s
 * `convertCurrency`, never here. No API key; fiat *and* crypto in one
 * call, everything priced through a USD base. `fetch` is injectable for
 * tests; `endpoint` is overridable.
 */

/** Known CoinGecko ids ↔ ticker symbols. */
export const COINGECKO_IDS = {
  bitcoin: 'BTC', ethereum: 'ETH', tether: 'USDT', binancecoin: 'BNB',
  solana: 'SOL', cardano: 'ADA', ripple: 'XRP', dogecoin: 'DOGE',
};
const ID_BY_SYMBOL = Object.fromEntries(Object.entries(COINGECKO_IDS).map(([id, sym]) => [sym, id]));

const DEFAULT_ENDPOINT = 'https://api.coingecko.com/api/v3/simple/price';

/**
 * Normalize a `/simple/price` response into the common
 * `{ base, rates, at }` shape. Crypto prices are USD directly; fiat rates
 * are derived through the bitcoin pivot (rate[FIAT] = btc_usd / btc_fiat
 * = value of one FIAT unit in USD).
 * @param {any} data @param {string[]} codes @param {number} at
 * @returns {{ base: string, rates: Record<string, number>, at: number }}
 */
export function normalizeCoinGecko(data, codes, at = 0) {
  /** @type {Record<string, number>} */
  const rates = { USD: 1 };
  for (const [id, sym] of Object.entries(COINGECKO_IDS)) {
    if (data[id] && typeof data[id].usd === 'number') rates[sym] = data[id].usd;
  }
  const btc = data.bitcoin;
  if (btc && typeof btc.usd === 'number') {
    for (const code of codes) {
      if (code === 'USD' || ID_BY_SYMBOL[code]) continue;
      const lc = code.toLowerCase();
      if (typeof btc[lc] === 'number' && btc[lc] !== 0) rates[code] = btc.usd / btc[lc];
    }
  }
  return { base: 'USD', rates, at };
}

/**
 * Fetch and normalize rates for `codes`.
 * @param {string[]} codes
 * @param {{ fetch?: typeof globalThis.fetch, endpoint?: string, at?: number }} [opts]
 * @returns {Promise<{ base: string, rates: Record<string, number>, at: number }>}
 */
export async function fetchCoinGecko(codes, opts = {}) {
  const f = opts.fetch ?? globalThis.fetch;
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  const cryptoIds = codes.filter((c) => ID_BY_SYMBOL[c]).map((c) => ID_BY_SYMBOL[c]);
  const fiats = codes.filter((c) => c !== 'USD' && !ID_BY_SYMBOL[c]).map((c) => c.toLowerCase());
  const ids = [...new Set([...cryptoIds, 'bitcoin'])].join(',');
  const vs = ['usd', ...fiats].join(',');
  const url = `${endpoint}?ids=${ids}&vs_currencies=${vs}`;
  const res = await f(url);
  if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
  const data = await res.json();
  return normalizeCoinGecko(data, codes, opts.at ?? 0);
}
