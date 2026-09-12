//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerWebMcp, WEBMCP_UNSUPPORTED } from '@jarenjs/contract/webmcp';
import { JarenValidator } from '@jarenjs/validate';

function operation(name = 'add') {
  const inputSchema = { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'] };
  const check = new JarenValidator({ skipErrors: false, collectErrors: true }).compile(inputSchema);
  return { name, description: 'Add one.', inputSchema,
    execute: input => check(input).valid ? { value: input.value + 1 } : { error: 'invalid input' } };
}
function host(method = 'registerTool', asynchronous = false) {
  const owned = new Map(), removed = [], calls = [];
  const context = {
    [method](value) {
      assert.equal(this, context);
      calls.push(value);
      const accept = () => { for (const tool of method === 'registerTool' ? [value] : value.tools) owned.set(tool.name, tool); };
      if (asynchronous) return Promise.resolve().then(accept);
      accept();
    },
    unregisterTool(name) { assert.equal(this, context); removed.push(name); owned.delete(name); },
  };
  return { context, owned, removed, calls };
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

describe('plain WebMCP operations on both browser roots', () => {
  for (const root of ['document', 'navigator']) for (const method of ['registerTool', 'provideContext'])
    for (const asynchronous of [false, true]) {
      it(`${root}: ${method}, ${asynchronous ? 'async' : 'sync'} completion and validated execution`, async () => {
        const h = host(method, asynchronous);
        const binding = registerWebMcp([operation()], { realm: { [root]: { modelContext: h.context } } });
        assert.equal(binding.status, 'pending');
        const result = await binding.ready;
        assert.equal(result.status, 'registered');
        assert.equal(result.registered, 1);
        assert.equal(result.root, root);
        assert.equal(result.method, method);
        const tool = h.owned.get('add');
        assert.deepEqual(await tool.execute({ value: 2 }), { value: 3 });
        assert.deepEqual(await tool.execute({ value: 'x' }), { error: 'invalid input' });
        await binding.dispose(); await binding.dispose();
        assert.deepEqual(tool.execute({ value: 4 }), { error: 'WebMCP registration is inactive' });
        if (method === 'registerTool') { assert.deepEqual(h.removed, ['add']); assert.equal(h.owned.size, 0); }
        else { assert.equal(result.nativeRemoval, 'unverified'); assert.equal(h.removed.length, 0); }
      });
    }

  it('prefers one document context and registerTool, deduplicating aliases', async () => {
    for (const aliases of [false, true]) {
      const d = host(), n = aliases ? d : host();
      d.context.provideContext = () => assert.fail('registerTool must be preferred');
      const binding = registerWebMcp([operation()], { realm: { document: { modelContext: d.context }, navigator: { modelContext: n.context } } });
      assert.equal((await binding.ready).root, 'document');
      assert.equal(d.calls.length, 1);
      if (!aliases) assert.equal(n.calls.length, 0);
      await binding.dispose();
      assert.deepEqual(d.removed, ['add']);
    }
  });

  it('falls back before registration for missing, null, inaccessible and non-callable preferred roots', async () => {
    const blocked = Object.defineProperty({}, 'modelContext', { get() { throw new Error('denied accessor'); } });
    for (const document of [undefined, null, {}, { modelContext: null }, { modelContext: { registerTool: 7 } }, blocked]) {
      const n = host();
      const binding = registerWebMcp([operation()], { realm: { document, navigator: { modelContext: n.context } } });
      const result = await binding.ready;
      assert.equal(result.root, 'navigator'); assert.equal(n.calls.length, 1);
      if (document === blocked) assert.ok(result.diagnostics.some(d => d.code === 'inaccessible'));
      await binding.dispose();
    }
  });

  it('guards root and method getters and reaches the next usable root', async () => {
    const n = host();
    for (const realm of [
      Object.defineProperty({ navigator: { modelContext: n.context } }, 'document', { get() { throw new Error('root'); } }),
      { document: { modelContext: Object.defineProperty({}, 'registerTool', { get() { throw new Error('method'); } }) }, navigator: { modelContext: n.context } },
    ]) {
      const binding = registerWebMcp([operation()], { realm });
      assert.equal((await binding.ready).root, 'navigator');
      assert.ok((await binding.ready).diagnostics.some(d => d.code === 'inaccessible'));
      await binding.dispose();
    }
  });

  it('treats explicit overrides as authoritative, including invalid/refused overrides', async () => {
    const ambient = host(); const realm = { document: { modelContext: ambient.context } };
    for (const context of [null, undefined, {}, { registerTool() { throw new Error('permission denied'); } }]) {
      const binding = registerWebMcp([operation()], { context, realm });
      assert.notEqual((await binding.ready).status, 'registered');
      assert.equal(ambient.calls.length, 0);
    }
    const explicit = host();
    const binding = registerWebMcp([operation()], { context: explicit.context, realm });
    assert.equal((await binding.ready).root, 'explicit');
    assert.equal(explicit.calls.length, 1); assert.equal(ambient.calls.length, 0);
    await binding.dispose();
  });

  it('allows only explicit unsupported-before-mutation fallback, without probing execution', async () => {
    const fallback = host('provideContext'); let execute = 0;
    fallback.context.registerTool = () => WEBMCP_UNSUPPORTED;
    const binding = registerWebMcp([{ ...operation(), execute() { execute++; } }], { context: fallback.context });
    assert.equal((await binding.ready).method, 'provideContext'); assert.equal(execute, 0);
    await binding.dispose();
    const n = host();
    const next = registerWebMcp([operation()], { realm: {
      document: { modelContext: { registerTool: () => WEBMCP_UNSUPPORTED } }, navigator: { modelContext: n.context },
    } });
    assert.equal((await next.ready).root, 'navigator');
    await next.dispose();
  });

  for (const asynchronous of [false, true]) it(`rolls back partial ${asynchronous ? 'async rejection' : 'sync failure'} without retrying or deleting foreign tools`, async () => {
    const primary = new Error('second registration refused'), secondary = new Error('cleanup failed');
    const n = host(); const registered = []; const removed = []; const reports = [];
    const context = {
      registerTool(tool) {
        if (tool.name === 'second') { if (asynchronous) return Promise.reject(primary); throw primary; }
        registered.push(tool);
        return asynchronous ? Promise.resolve() : undefined;
      },
      unregisterTool(name) { removed.push(name); throw secondary; },
      provideContext() { assert.fail('must not retry'); },
    };
    const binding = registerWebMcp([operation(), operation('second')], { realm: {
      document: { modelContext: context }, navigator: { modelContext: n.context },
    }, onError: error => reports.push(error) });
    const result = await binding.ready;
    assert.equal(result.status, 'failed'); assert.equal(result.error, primary);
    assert.deepEqual(result.cleanupErrors, [secondary]); assert.deepEqual(reports, [primary, secondary]);
    assert.deepEqual(removed, ['add']); assert.equal(n.calls.length, 0);
    assert.match(registered[0].execute({ value: 1 }).error, /inactive/);
    await binding.dispose(); assert.deepEqual(removed, ['add']);
  });

  it('deactivates callbacks immediately while disposal waits for pending registration', async () => {
    const pending = deferred(); const removed = []; let tool;
    const context = { registerTool(value) { tool = value; return pending.promise; }, unregisterTool(name) { removed.push(name); } };
    const binding = registerWebMcp([operation(), operation('later')], { context });
    const disposal = binding.dispose();
    assert.match(tool.execute({ value: 1 }).error, /inactive/);
    pending.resolve();
    assert.equal((await binding.ready).status, 'disposed'); await disposal; await binding.dispose();
    assert.deepEqual(removed, ['add']);
  });

  it('uses qualified abort cleanup and forwards execution cancellation', async () => {
    let registrationSignal, tool;
    const context = { registerTool(value, { signal }) { registrationSignal = signal; tool = value; return Promise.resolve(); } };
    const binding = registerWebMcp([{ ...operation(), execute: (_, options) => options.signal.aborted }], { context, lifecycle: 'abort' });
    assert.equal((await binding.ready).nativeRemoval, 'abort');
    const execution = new AbortController(); execution.abort();
    assert.equal(tool.execute({}, { signal: execution.signal }), true);
    await binding.dispose(); assert.equal(registrationSignal.aborted, true);
  });

  it('keeps foreign legacy catalogs intact and clears only the current exclusive owner', async () => {
    let clears = 0;
    const context = { provideContext() {}, clearContext() { assert.equal(this, context); clears++; } };
    const first = registerWebMcp([operation()], { context, exclusiveLegacyContext: true }); await first.ready;
    const second = registerWebMcp([operation('other')], { context, exclusiveLegacyContext: true }); await second.ready;
    await first.dispose(); assert.equal(clears, 0);
    await second.dispose(); assert.equal(clears, 1);
    const shared = registerWebMcp([operation()], { context }); await shared.ready;
    await shared.dispose(); assert.equal(clears, 1);
  });

  it('uses returned cleanup handles exactly once with their receiver', async () => {
    let removed = 0;
    const handle = { dispose() { assert.equal(this, handle); removed++; } };
    for (const result of [handle, () => { removed++; }]) {
      const binding = registerWebMcp([operation()], { context: { registerTool: () => result } });
      await binding.ready; await binding.dispose(); await binding.dispose();
    }
    assert.equal(removed, 2);
  });

  it('handles headless absence, later explicit mounts, root changes and external abort', async () => {
    const realm = {};
    const absent = registerWebMcp([operation()], { realm });
    assert.equal((await absent.ready).status, 'unavailable');
    const h = host(); realm.document = { modelContext: h.context };
    const signal = new AbortController();
    const later = registerWebMcp([operation()], { realm, signal: signal.signal });
    assert.equal((await later.ready).status, 'registered');
    realm.document.modelContext = host().context;
    signal.abort(); await later.dispose(); assert.deepEqual(h.removed, ['add']);
    const canceled = registerWebMcp([operation()], { context: h.context, signal: signal.signal });
    assert.equal((await canceled.ready).status, 'disposed'); assert.equal(h.calls.length, 1);
  });

  it('refuses duplicate definitions before browser calls and preserves hook failure diagnostics', async () => {
    assert.throws(() => registerWebMcp([operation(), operation()]), TypeError);
    const primary = new Error('browser');
    const binding = registerWebMcp([operation()], { context: { registerTool() { throw primary; } }, onError() { throw new Error('hook'); } });
    const result = await binding.ready;
    assert.equal(result.error, primary); assert.ok(result.diagnostics.some(d => d.code === 'error-handler-failed'));
  });
});
