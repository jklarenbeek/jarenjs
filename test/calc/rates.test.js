import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchCoinGecko, normalizeCoinGecko,
  fetchBinance, normalizeBinance,
  createRatesLayer,
} from '../../components/calc/src/component/rates/index.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !~= ${b}`);

/** A fake fetch returning a fixed JSON body. */
function fakeFetch(body, ok = true, status = 200) {
  return async () => ({ ok, status, json: async () => body });
}

describe('#calc rates adapters (injected fetch)', function () {
  it('CoinGecko normalizes crypto (USD) + fiat (bitcoin pivot)', async () => {
    const body = {
      bitcoin: { usd: 60000, eur: 55000, gbp: 48000 },
      ethereum: { usd: 3000 },
    };
    const table = await fetchCoinGecko(['BTC', 'ETH', 'EUR', 'GBP'], { fetch: fakeFetch(body), at: 111 });
    assert.equal(table.base, 'USD');
    assert.equal(table.rates.USD, 1);
    close(table.rates.BTC, 60000);
    close(table.rates.ETH, 3000);
    close(table.rates.EUR, 60000 / 55000);  // value of 1 EUR in USD
    assert.equal(table.at, 111);
  });

  it('Binance normalizes USDT pairs', async () => {
    const body = [
      { symbol: 'BTCUSDT', price: '60000' },
      { symbol: 'ETHUSDT', price: '3000' },
      { symbol: 'ETHBTC', price: '0.05' },   // ignored (not *USDT)
    ];
    const table = await fetchBinance(['BTC', 'ETH'], { fetch: fakeFetch(body), at: 5 });
    assert.equal(table.base, 'USDT');
    close(table.rates.BTC, 60000);
    close(table.rates.ETH, 3000);
    assert.equal(table.rates.USD, 1);
  });

  it('normalizers are pure functions', () => {
    assert.equal(normalizeCoinGecko({ bitcoin: { usd: 50000 } }, ['BTC']).rates.BTC, 50000);
    assert.equal(normalizeBinance([{ symbol: 'BNBUSDT', price: '600' }]).rates.BNB, 600);
  });
});

describe('#calc rates layer (effect + debounce + fallback)', function () {
  it('dispatches calc/rates-ok on success', async () => {
    let clock = 1000;
    const layer = createRatesLayer({
      provider: 'coingecko',
      fetch: fakeFetch({ bitcoin: { usd: 60000 } }),
      refreshMs: 100,
      now: () => clock,
    });
    const events = [];
    layer.effects['rates-fetch']({ force: true }, (name, payload) => events.push([name, payload]));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(events.length, 1);
    assert.equal(events[0][0], 'calc/rates-ok');
    close(events[0][1].rates.BTC, 60000);
  });

  it('min-refresh debounce blocks a second fetch inside the window', async () => {
    let clock = 1000;
    let calls = 0;
    const layer = createRatesLayer({
      provider: async () => { calls++; return { base: 'USD', rates: { USD: 1 }, at: clock }; },
      refreshMs: 100,
      now: () => clock,
    });
    const dispatch = () => {};
    layer.effects['rates-fetch']({}, dispatch);
    await new Promise((r) => setTimeout(r, 5));
    clock = 1050; // still inside the 100ms window
    layer.effects['rates-fetch']({}, dispatch);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(calls, 1, 'the debounced second call is suppressed');
    clock = 1200; // past the window
    layer.effects['rates-fetch']({}, dispatch);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(calls, 2);
  });

  it('routes a failed fetch to calc/rates-err', async () => {
    const layer = createRatesLayer({
      provider: 'coingecko',
      fetch: fakeFetch(null, false, 503),
      refreshMs: 0,
      now: () => 1,
    });
    const events = [];
    layer.effects['rates-fetch']({ force: true }, (name, payload) => events.push([name, payload]));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(events[0][0], 'calc/rates-err');
    assert.ok(/HTTP 503/.test(events[0][1].message));
  });

  it('an older success or failure cannot replace the newest successful refresh', async () => {
    for (const staleFails of [false, true]) {
      const pending = [];
      const events = [];
      const layer = createRatesLayer({
        provider: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
        now: () => 100, // requests may start in the same clock tick
      });
      const dispatch = (name, payload) => events.push([name, payload]);
      layer.effects['rates-fetch']({}, dispatch);
      layer.effects['rates-fetch']({ force: true }, dispatch);
      pending[1].resolve({ base: 'USD', rates: { USD: 1, EUR: 2 } });
      await Promise.resolve();
      if (staleFails) pending[0].reject(new Error('old failure'));
      else pending[0].resolve({ base: 'USD', rates: { USD: 1, EUR: 1 } });
      await Promise.resolve();
      assert.deepEqual(events, [['calc/rates-ok', { base: 'USD', rates: { USD: 1, EUR: 2 }, at: 100 }]]);
    }
  });

  it('an older success cannot mask the newest refresh failure', async () => {
    const pending = [];
    const events = [];
    const layer = createRatesLayer({
      provider: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
      now: () => 100,
    });
    const dispatch = (name, payload) => events.push([name, payload]);
    layer.effects['rates-fetch']({}, dispatch);
    layer.effects['rates-fetch']({ force: true }, dispatch);
    pending[1].reject(new Error('latest failure'));
    await Promise.resolve();
    pending[0].resolve({ base: 'USD', rates: { USD: 1 } });
    await Promise.resolve();
    assert.deepEqual(events, [['calc/rates-err', { message: 'latest failure' }]]);
  });

  it('settling an older request keeps the newest request in flight', async () => {
    for (const staleFails of [false, true]) {
      const pending = [];
      const events = [];
      let clock = 100;
      const layer = createRatesLayer({
        provider: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
        now: () => clock,
        refreshMs: 100,
      });
      const dispatch = (name, payload) => events.push([name, payload]);
      layer.effects['rates-fetch']({}, dispatch);
      layer.effects['rates-fetch']({ force: true }, dispatch);
      if (staleFails) pending[0].reject(new Error('old failure'));
      else pending[0].resolve({ base: 'USD', rates: { USD: 1 } });
      await Promise.resolve();
      clock = 1000; // debounce window has expired, but the newer request has not settled
      layer.effects['rates-fetch']({}, dispatch);
      assert.equal(pending.length, 2);
      assert.deepEqual(events, []);
      pending[1].resolve({ base: 'USD', rates: { USD: 1, EUR: 2 } });
      await Promise.resolve();
      assert.deepEqual(events, [['calc/rates-ok', { base: 'USD', rates: { USD: 1, EUR: 2 }, at: 100 }]]);
    }
  });

  it('the static fallback table works offline (no network)', () => {
    const layer = createRatesLayer({});
    assert.equal(layer.fallbackRates.base, 'USD');
    assert.equal(layer.fallbackRates.stale, true);
    assert.ok(layer.fallbackRates.rates.BTC > 0);
    // the poll sub is gated to converter + currency
    assert.equal(layer.subEntry.run, 'rates-poll');
  });
});
