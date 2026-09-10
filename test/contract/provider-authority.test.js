import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withProviderRun } from '@jarenjs/contract/provider';
import { tick } from './fixtures/provider-clock.js';

const evidence = { runId: 'run-1', actor: 'actor-1', environment: 'test', destination: 'inventory/test', revision: 'r1', lease: 'lease-1' };
const request = { url: 'https://inventory.example/items', safety: 'safe-read' };

function fixture() {
  const events = [];
  let current = { ...evidence };
  const host = {
    identify: () => ({ host: { identity: 'private-identity' }, release: () => events.push('identity-release') }),
    acquire: (_input, _identity, enter) => enter({ host: { token: 'private-token', headers: { authorization: 'private-header' } },
      release: () => events.push('account-restored') }),
    current: () => current,
    transport: async (_request, context) => {
      events.push('dispatch');
      assert.equal(context.host.token, 'private-token');
      return new Response('{"items":[]}');
    },
  };
  return { host, events, update: (value) => { current = value; } };
}

describe('private provider run authority', () => {
  it('rechecks destination, membership, lease and configuration immediately before sending', async () => {
    for (const change of [null, { ...evidence, destination: 'inventory/other' }, { ...evidence, revision: 'r2' }, { ...evidence, lease: 'lost' }, { ...evidence, actor: 'other' }]) {
      const f = fixture();
      await withProviderRun(evidence, f.host, async (run) => {
        f.update(change);
        const result = await run.execute(request);
        assert.notEqual(result.state, 'ok');
        return result;
      });
      assert.deepEqual(f.events, ['account-restored', 'identity-release']);
    }
  });

  it('keeps resources out of serialized state, results and thrown error text', async () => {
    const f = fixture();
    const result = await withProviderRun(evidence, f.host, async (run) => {
      assert.deepEqual(JSON.parse(JSON.stringify(run)), { evidence });
      const result = await run.execute(request);
      return { result, checkpoint: JSON.parse(JSON.stringify(run)) };
    });
    assert.equal(result.state, 'complete');
    assert.ok(!/private-|authorization|AbortController/.test(JSON.stringify(result)));
    assert.deepEqual(f.events, ['dispatch', 'account-restored', 'identity-release']);
    const failed = await withProviderRun(evidence, f.host, () => { throw new Error('private-secret'); });
    assert.equal(failed.reason, 'run-failed');
    assert.ok(!JSON.stringify(failed).includes('private'));
  });

  it('drains ignored aborts and prevents late replies or callbacks publishing after failure', async () => {
    const f = fixture();
    let release, captured, send;
    f.host.transport = async () => {
      f.events.push('dispatch');
      await new Promise((resolve) => { release = resolve; });
      f.events.push('settled');
      return new Response('{}');
    };
    const pending = withProviderRun(evidence, f.host, async (run) => {
      captured = run;
      send = run.execute(request);
      await tick();
      throw new Error('failure');
    });
    await tick();
    await tick();
    assert.deepEqual(f.events, ['dispatch']);
    release();
    assert.equal((await pending).reason, 'run-failed');
    assert.equal((await send).state, 'cancelled');
    assert.deepEqual(f.events, ['dispatch', 'settled', 'account-restored', 'identity-release']);
    await captured.execute(request);
    await captured.publish({ progress: 1 }, () => assert.fail('late publication'));
    assert.deepEqual(f.events, ['dispatch', 'settled', 'account-restored', 'identity-release']);
  });

  it('cannot dispatch after cancellation during credential refresh', async () => {
    const f = fixture();
    let refresh;
    let checks = 0;
    f.host.current = async () => {
      if (++checks === 2) await new Promise((resolve) => { refresh = resolve; });
      return evidence;
    };
    const controller = new AbortController();
    const pending = withProviderRun(evidence, f.host, (run) => run.execute(request), { signal: controller.signal });
    await tick();
    controller.abort();
    refresh();
    assert.equal((await pending).state, 'refused');
    assert.deepEqual(f.events, ['account-restored', 'identity-release']);
  });

  it('isolates concurrent privileged clients and refuses a host that reuses a leased client', async () => {
    const f = fixture();
    const shared = { token: 'private-token' };
    f.host.acquire = (_input, _identity, enter) => enter({ host: shared });
    let release;
    const first = withProviderRun(evidence, f.host, async () => { await new Promise((r) => { release = r; }); return {}; });
    await tick();
    const second = await withProviderRun({ ...evidence, runId: 'run-2' }, f.host, () => assert.fail('shared client used'));
    assert.equal(second.reason, 'resource-in-use');
    release();
    assert.equal((await first).state, 'complete');
  });

  it('checks current authority for publication and tolerates only opaque authority fields', async () => {
    const f = fixture();
    const result = await withProviderRun(evidence, f.host, (run) => run.publish({ count: 2 }, (value, proof) => ({ ...value, proof })));
    assert.deepEqual(result.value, { count: 2, proof: evidence });
    await assert.rejects(withProviderRun({ ...evidence, token: 'private' }, f.host, () => {}), { code: 'JC1012' });
    const aborted = new AbortController(); aborted.abort();
    assert.equal((await withProviderRun(evidence, f.host, () => assert.fail(), { signal: aborted.signal })).reason, 'cancelled');
  });

  it('cleans up failed acquisition and surfaces release faults without host secrets', async () => {
    const f = fixture();
    f.host.acquire = () => null;
    assert.equal((await withProviderRun(evidence, f.host, () => assert.fail())).reason, 'host-fault');
    assert.deepEqual(f.events, ['identity-release']);
    f.host.acquire = (_input, _identity, enter) => enter({ host: {}, release: () => { throw new Error('private-release'); } });
    await assert.rejects(withProviderRun(evidence, f.host, () => ({})), (error) => {
      assert.equal(error.code, 'JC1012');
      assert.ok(!error.message.includes('private-release'));
      return true;
    });
  });
});
