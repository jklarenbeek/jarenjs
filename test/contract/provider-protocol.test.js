import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileProvider, createProviderExecutor } from '@jarenjs/contract/provider';
import { readProviderTranscript } from '../adoption/provider-oracle.js';
import { JarenValidator } from '@jarenjs/validate';

const fixture = JSON.parse(readFileSync(new URL('../adoption/fixtures/providers.json', import.meta.url)));
const descriptors = JSON.parse(readFileSync(new URL('./fixtures/provider-descriptors.json', import.meta.url)));
const callbacks = { archiveCursor: (raw) => raw.link ? new URL(raw.link.match(/<([^>]+)>/)[1], 'https://archive.example').searchParams.get('cursor') : null };

async function pull(doc, pages, context = {}, options = {}) {
  const requests = [];
  const executor = createProviderExecutor({ transport: async (request) => {
    requests.push(request);
    return new Response(JSON.stringify(pages[requests.length - 1]));
  } });
  try {
    const result = await compileProvider(doc, { callbacks, ...options }).pull({ environment: 'test' }, { executor, ...context });
    return { ...result, requests };
  }
  finally { await executor.close(); }
}

describe('compiled provider dialects', () => {
  for (const [i, dialect] of fixture.dialects.entries()) it(`${dialect.id} preserves the frozen transcript`, async () => {
    const oracle = readProviderTranscript(dialect);
    const result = await pull(descriptors[i], dialect.pages);
    assert.equal(result.state, oracle.state);
    assert.deepEqual(result.observations.flatMap((page) => page.ids), oracle.ids);
    assert.deepEqual(result.observations.map((page) => page.raw), oracle.pages);
    assert.deepEqual(result.observations.map((page) => JSON.parse(page.text)), oracle.pages);
    assert.equal(result.attempts, 2);
    if (dialect.id === 'inventory-rest') {
      assert.equal(result.requests[1].url, 'https://inventory.example/items?environment=test&cursor=c1');
      assert.equal(result.requests[0].headers['x-api-version'], '2026-01');
      assert.equal(result.observations[0].rows[0].quantity, null);
    }
    if (dialect.id === 'commerce-graphql') {
      assert.equal(JSON.parse(result.requests[1].body).variables.after, 'c1');
      assert.equal(result.observations[1].complete, false);
      assert.deepEqual(result.observations[1].errors, dialect.pages[1].errors);
    }
  });

  it('preserves partial GraphQL costs and does not label incomplete data complete', async () => {
    const pages = structuredClone(fixture.dialects[1].pages);
    pages[1].extensions = { cost: { requested: 7, actual: 5 } };
    const result = await pull(descriptors[1], pages);
    assert.equal(result.reason, 'partial-errors');
    assert.deepEqual(result.observations[1].cost, pages[1].extensions.cost);
  });

  it('detects repeated cursors, duplicate IDs, empty pages and each finite credit', async () => {
    const first = { items: [{ id: 'a' }], next: 'c1' };
    const cases = [
      [{}, [first, { items: [{ id: 'b' }], next: 'c1' }], 'no-progress'],
      [{}, [first, { items: [{ id: 'a' }], next: null }], 'no-progress'],
      [{}, [{ items: [], next: 'c1' }], 'empty-page'],
      [{ limits: { pages: 1 } }, [first], 'page-limit'],
      [{ limits: { rows: 1 } }, [{ items: [{ id: 'a' }, { id: 'b' }], next: null }], 'row-limit'],
      [{ limits: { bytes: 1 } }, [first], 'byte-limit'],
    ];
    for (const [overrides, pages, reason] of cases) {
      const result = await pull({ ...descriptors[0], ...overrides }, pages);
      assert.equal(result.reason, reason);
      assert.equal(result.state, 'incomplete');
    }
    assert.equal((await pull(descriptors[0], [{ items: [], next: null }])).state, 'complete');
  });

  it('refuses unsupported capabilities before dispatch and undeclared callbacks at compile time', async () => {
    for (const capability of ['upload', 'media', 'bulk', 'binary']) {
      const result = await pull({ ...descriptors[0], capability }, []);
      assert.equal(result.state, 'refused');
      assert.equal(result.requests.length, 0);
    }
    assert.throws(() => compileProvider(descriptors[2]), { code: 'JC0021' });
    assert.throws(() => compileProvider({ ...descriptors[0], headers: { authorization: 'private' } }), { code: 'JC0021' });
    assert.throws(() => compileProvider({ ...descriptors[0], limits: { pages: Infinity } }), { code: 'JC0021' });
  });

  it('uses existing query and JSLT transforms without exposing host capabilities', async () => {
    const doc = structuredClone(descriptors[0]);
    doc.response.transform = { kind: 'query', expression: { identifier: '$.id' } };
    const transformed = await pull(doc, [{ items: [{ id: '01' }], next: null }]);
    assert.deepEqual(transformed.observations[0].rows, [{ identifier: '01' }]);
    doc.response.transform = { kind: 'jslt', expression: [{ match: '$', body: { identifier: '$.id' } }] };
    assert.deepEqual((await pull(doc, [{ items: [{ id: '02' }], next: null }])).observations[0].rows, [{ identifier: '02' }]);
    doc.response.transform = { callback: 'declared' };
    const seen = [];
    await pull(doc, [{ items: [{ id: '03' }], next: null }], { host: { token: 'private' } }, {
      callbacks: { declared: (...args) => { seen.push(args); return args[0]; } },
    });
    assert.deepEqual(seen, [[{ id: '03' }]]);
  });

  it('pulls one page at a time and stops after cancellation or consumer return', async () => {
    let calls = 0;
    const executor = createProviderExecutor({ transport: async () => {
      calls++; return new Response(JSON.stringify(fixture.dialects[0].pages[calls - 1]));
    } });
    const controller = new AbortController();
    const iterator = compileProvider(descriptors[0]).pages({}, { executor, signal: controller.signal });
    assert.equal((await iterator.next()).value.state, 'page');
    assert.equal(calls, 1);
    controller.abort();
    assert.equal((await iterator.next()).value.reason, 'cancelled');
    assert.equal(calls, 1);
    await iterator.return();
    await executor.close();
  });

  it('validates declared schemas through the injected existing compiler', async () => {
    const doc = { ...descriptors[0], inputSchema: { type: 'object', required: ['tenant'] } };
    assert.throws(() => compileProvider(doc), { code: 'JC0021' });
    const validator = new JarenValidator();
    const result = await pull(doc, [], {}, { compileSchema: (schema) => validator.compile(schema) });
    assert.equal(result.reason, 'input-schema');
    assert.equal(result.requests.length, 0);
    const response = { ...descriptors[0].response, schema: { type: 'object', required: ['missing'] } };
    assert.equal((await pull({ ...descriptors[0], response }, [{ items: [], next: null }], {}, {
      compileSchema: (schema) => validator.compile(schema),
    })).reason, 'response-transform');
  });
});
