//@ts-check
/** Structural conformance kit. Real adapters inject isolated sources into the same cases. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

/** A half-open request; the AbortSignal travels separately from this JSON value.
 * @param {any} [overrides] */
export function rangeRequest(overrides = {}) {
  return {
    generation: 1, requestId: 'request-1', query: 'filter-sort-schema-v1', snapshot: 'source-v1',
    range: { start: 0, end: 3 }, credits: { pages: 1, rows: 3, bytes: 4096, work: 3 },
    ...overrides,
  };
}

/** Validate a reply before publication; request generations never stand in for snapshots.
 * @param {any} request @param {any} response */
export function assertRangeResponse(request, response) {
  for (const key of ['generation', 'requestId', 'query', 'snapshot'])
    assert.equal(response[key], request[key], `${key} identity`);
  assert.ok(['ready', 'loading', 'error', 'invalidated', 'budget-exhausted'].includes(response.state));
  if (response.state !== 'ready') return;
  assert.ok(['known', 'unknown'].includes(response.total.kind));
  if (response.total.kind === 'known') {
    assert.ok(Number.isSafeInteger(response.total.value) && response.total.value >= response.rows.length);
  }
  else assert.equal(Object.hasOwn(response.total, 'value'), false);
  assert.equal(response.keys.length, response.rows.length);
  assert.equal(new Set(response.keys).size, response.keys.length);
  assert.ok(response.keys.every((key) => typeof key === 'string'));
  for (const key of ['pages', 'rows', 'bytes', 'work']) {
    assert.ok(Number.isSafeInteger(response.used[key]) && response.used[key] >= 0, key);
    assert.ok(response.used[key] <= request.credits[key], `${key} credit`);
  }
  assert.equal(response.used.rows, response.rows.length);
  assert.equal(response.used.bytes, new TextEncoder().encode(JSON.stringify(response.rows)).byteLength);
}

/**
 * Every factory seeds ten rows with keys row-0..row-9 in source-v1, honors
 * seekIndex/exactTotal options, and returns { provider, invalidate, resources }.
 * invalidate changes the source snapshot; resources reports pending handles.
 * Adapters may translate the fixture setup, never the requests or assertions.
 * @param {string} name @param {(options?: any) => Promise<any> | any} factory
 */
export function rangeProviderContract(name, factory) {
  const withHost = (options, run) => async () => {
    const host = await factory(options);
    try { await run(host); }
    finally { await host.provider.dispose(); }
    assert.equal(host.resources(), 0);
  };
  describe(`range-provider: ${name}`, () => {
    it('echoes all identities and uses half-open ranges', withHost({}, async ({ provider }) => {
      const request = rangeRequest({ range: { start: 2, end: 5 } });
      const response = await provider.request(request);
      assertRangeResponse(request, response);
      assert.equal(response.state, 'ready');
      assert.deepEqual(response.keys, ['row-2', 'row-3', 'row-4']);
      assert.deepEqual(response.total, { kind: 'known', value: 10 });
      const empty = await provider.request(rangeRequest({ range: { start: 5, end: 5 } }));
      assert.deepEqual(empty.keys, []);
    }));
    it('unknown totals use an opaque continuation, not loaded count', withHost({ exactTotal: false }, async ({ provider }) => {
      assert.equal(provider.capabilities.exactTotal, false);
      const first = await provider.request(rangeRequest());
      assertRangeResponse(rangeRequest(), first);
      assert.deepEqual(first.total, { kind: 'unknown' });
      assert.ok(first.continuation);
      const request = rangeRequest({ range: undefined, continuation: first.continuation, requestId: 'next' });
      const next = await provider.request(request);
      assertRangeResponse(request, next);
      assert.deepEqual(next.keys, ['row-3', 'row-4', 'row-5']);
      const stale = await provider.request({ ...request, query: 'different-sort' });
      assert.equal(stale.state, 'invalidated');
    }));
    it('refuses unavailable index seeks without scanning', withHost({ seekIndex: false }, async ({ provider }) => {
      assert.equal(provider.capabilities.seekIndex, false);
      const response = await provider.request(rangeRequest({ range: { start: 8, end: 9 } }));
      assert.equal(response.state, 'error');
      assert.equal(response.reason, 'unsupported-seek');
      assert.equal(response.used.work, 0);
    }));
    it('fences changed snapshots and stale generations or superseded requests', withHost({}, async (host) => {
      const request = rangeRequest();
      const old = await host.provider.request(request);
      for (const change of [{ generation: 2 }, { requestId: 'new' }, { query: 'new-sort' }, { snapshot: 'source-v2' }])
        assert.throws(() => assertRangeResponse({ ...request, ...change }, old), /identity/);
      host.invalidate('source-v2');
      const invalid = await host.provider.request(request);
      assertRangeResponse(request, invalid);
      assert.equal(invalid.state, 'invalidated');
      const current = rangeRequest({ snapshot: 'source-v2', generation: 2 });
      assertRangeResponse(current, await host.provider.request(current));
    }));
    it('refuses malformed ranges and insufficient page/row/byte/work credits', withHost({}, async ({ provider }) => {
      for (const range of [{ start: -1, end: 1 }, { start: 4, end: 2 }, { start: 0.5, end: 1 }]) {
        const response = await provider.request(rangeRequest({ range }));
        assert.equal(response.state, 'error');
        assert.equal(response.reason, 'invalid-range');
      }
      for (const key of ['pages', 'rows', 'bytes', 'work']) {
        const request = rangeRequest(); request.credits[key] = 0;
        const response = await provider.request(request);
        assertRangeResponse(request, response);
        assert.equal(response.state, 'budget-exhausted', key);
        assert.equal(response.used.work, 0);
      }
    }));
    it('cancels before and during requests, drains dispose, refuses later admission', withHost({}, async ({ provider, resources }) => {
      const before = new AbortController(); before.abort();
      assert.equal((await provider.request(rangeRequest(), before.signal)).reason, 'cancelled');
      const during = new AbortController();
      const pending = provider.request(rangeRequest(), during.signal); during.abort();
      assert.equal((await pending).reason, 'cancelled');
      const abandoned = provider.request(rangeRequest());
      await provider.dispose(); await provider.dispose();
      assert.equal((await abandoned).reason, 'disposed');
      assert.equal(resources(), 0);
      assert.equal((await provider.request(rangeRequest())).reason, 'disposed');
    }));
  });
}
