//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '@jarenjs/app';
import { createFileTokenRegistry } from '@jarenjs/app/file-tokens';
import { qualifyFileTokens } from '../consumer/file-tokens.js';

const file = (name = 'a.txt', text = 'abc') => new File([text], name, { type: 'text/plain', lastModified: 1 });
const refuses = (code, body) => assert.throws(body, { code });
function fixture(options = {}) {
  let time = 1000, id = 0;
  const registry = createFileTokenRegistry({ ttlMs: 100, maxFiles: 3, maxBytes: 12,
    runtime: { now: () => time, uuid: () => `id-${++id}` }, ...options });
  return { registry, advance: value => { time = value; } };
}

describe('owned file tokens', () => {
  it('composes a public byte upload, bounded retry, JSON commit and cancellation', qualifyFileTokens);
  it('preserves selection order and consumes the exact native File only once', async () => {
    const { registry } = fixture();
    const first = file('first.txt'), second = file('second.txt', 'defg');
    const tokens = registry.extract({ target: { files: [first, second] } });
    assert.ok(Object.isFrozen(tokens));
    assert.deepEqual(JSON.parse(JSON.stringify(tokens)), tokens);
    assert.equal(registry.stats().files, 2);
    assert.equal(registry.stats().bytes, 7);
    const taken = registry.take(tokens[0]);
    assert.equal(taken, first);
    assert.equal(await taken.text(), 'abc');
    assert.equal(registry.take(tokens[0]), null);
    assert.equal(registry.release([tokens[1], tokens[1], 'unknown']), 1);
    assert.equal(registry.take(tokens[1]), null);
    assert.equal(registry.stats().bytes, 0);
    assert.deepEqual(registry.extract({}), []);
    registry.dispose();
  });

  it('refuses a whole oversized or malformed selection while retaining prior active tokens', () => {
    let minted = 0;
    const { registry } = fixture({ maxFiles: 2, maxBytes: 6, mintToken: () => `t${++minted}` });
    const original = file();
    const [token] = registry.register([original]);
    for (const selection of [[file(), file()], [file('large', '1234')], [file(), {}],
      { length: 1_000_000 }, [new Blob(['x'])]]) {
      const before = registry.stats();
      assert.throws(() => registry.register(selection));
      assert.deepEqual(registry.stats(), before);
    }
    assert.equal(minted, 1, 'size/shape refusals do not mint partial identifiers');
    assert.equal(registry.take(token), original);
    class Misreported extends File { get size() { return 0; } }
    refuses('JA2019', () => registry.register([new Misreported(['1234567'], 'large')]));
    registry.dispose();
  });

  it('expires at the exact boundary and never rebinds a stale token when a minter repeats', () => {
    const { registry, advance } = fixture({ mintToken: () => 'same' });
    const [first] = registry.register([file()]);
    advance(1050);
    const [second] = registry.register([file()]);
    advance(1100);
    assert.equal(registry.take(first), null);
    assert.equal(registry.stats().files, 1);
    advance(1150);
    assert.equal(registry.take(second), null);
    const [third] = registry.register([file()]);
    assert.notEqual(first, third);
    assert.equal(registry.take(first), null);
    registry.dispose(); registry.dispose();
    assert.equal(registry.take(third), null);
    assert.equal(registry.release([third]), 0);
    assert.equal(registry.stats().files, 0);
    refuses('JA2020', () => registry.register([]));
  });

  it('isolates registries with fresh runtime namespaces even with a repeated custom suffix', () => {
    let id = 0;
    const runtime = { uuid: () => `namespace-${++id}`, now: () => 1000 };
    const a = createFileTokenRegistry({ runtime, mintToken: () => 'fixed' });
    const b = createFileTokenRegistry({ runtime, mintToken: () => 'fixed' });
    const [ta] = a.register([file()]), [tb] = b.register([file()]);
    assert.notEqual(ta, tb);
    assert.equal(a.take(tb), null); assert.equal(b.take(ta), null);
    assert.equal(a.take('x'.repeat(10000)), null);
    assert.equal(a.release([undefined, 'x'.repeat(10000)]), 0);
    a.dispose(); b.dispose();
  });

  it('bounds host options and operation input, with cleanup independent of clock failure', () => {
    for (const options of [null, { maxFiles: 0 }, { maxFiles: 4097 }, { maxBytes: 0 }, { ttlMs: Infinity },
      { now: 0 }, { mintToken: null }, { runtime: { uuid: 'bad' } }])
      refuses('JA2018', () => createFileTokenRegistry(options));
    refuses('JA2021', () => createFileTokenRegistry({ runtime: { uuid: () => '' } }));
    let failed = false;
    const { registry } = fixture({ now: () => failed ? NaN : 1000 });
    const [token] = registry.register([file()]);
    for (const selection of [null, 'files', { length: -1 }, { length: 0.5 }])
      refuses('JA2018', () => registry.register(selection));
    refuses('JA2019', () => registry.release(Array(4097).fill(token)));
    let reads = 0;
    registry.register({ get length() { return ++reads === 1 ? 0 : 1_000_000; } });
    assert.equal(reads, 1, 'snapshot the admission bound before iterating a host selection');
    failed = true;
    refuses('JA2018', () => registry.take(token));
    assert.equal(registry.release([token]), 1);
    registry.dispose();
    assert.equal(registry.stats().bytes, 0);
    const overflow = fixture({ now: () => Number.MAX_SAFE_INTEGER }).registry;
    refuses('JA2019', () => overflow.register([file()])); overflow.dispose();
  });

  it('rolls back failed minting, refuses reentry and honors disposal during a host callback', () => {
    let mode = 'fail', registry;
    registry = fixture({ mintToken: () => {
      if (mode === 'fail') throw null;
      if (mode === 'reenter') registry.register([]);
      if (mode === 'dispose') registry.dispose();
      return mode === 'invalid' ? 'bad:identifier' : 'ok';
    } }).registry;
    for (const [next, code] of [['fail', 'JA2018'], ['invalid', 'JA2021'], ['reenter', 'JA2021']]) {
      mode = next;
      refuses(code, () => registry.register([file()]));
      assert.equal(registry.stats().files, 0);
    }
    mode = 'good'; const [token] = registry.register([file()]);
    mode = 'dispose'; refuses('JA2020', () => registry.register([file()]));
    assert.equal(registry.take(token), null);
    assert.equal(registry.stats().bytes, 0);
    const disposed = fixture().registry;
    refuses('JA2020', () => disposed.register({ get length() { disposed.dispose(); return 0; } }));
  });

  it('composes the existing event-field and effect-disposal owners without Files in app state', () => {
    for (let i = 0; i < 3; i++) {
      const { registry } = fixture();
      const errors = [];
      const release = Object.assign(({ tokens }) => registry.release(tokens), { dispose: registry.dispose });
      const app = createApp({ state: { tokens: [] }, view: [{ match: '$', body: ['div'] }], actions: {
        pick: { patch: [{ op: 'replace', path: '/tokens', value: '$event.fileTokens' }] },
      } }, { schedule: flush => flush(), eventFields: { fileTokens: registry.extract }, effects: { release },
        onError: error => errors.push(error) });
      app.dispatch('pick', null, { target: { files: [file()] } }, ['fileTokens']);
      const state = app.getState();
      assert.equal(typeof state.tokens[0], 'string');
      assert.deepEqual(JSON.parse(JSON.stringify(state)), state);
      assert.equal(registry.stats().files, 1);
      app.dispatch('pick', null, { target: { files: [file('large', 'x'.repeat(13))] } }, ['fileTokens']);
      assert.equal(errors[0].code, 'JA2002');
      assert.equal(errors[0].cause.code, 'JA2019');
      app.destroy(); app.destroy();
      assert.equal(registry.stats().disposed, true);
      assert.equal(registry.stats().files, 0);
    }
  });
});
