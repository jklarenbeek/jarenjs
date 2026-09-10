//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, identity } from '../durable/fixtures.js';
import { tempDbPath } from './helpers.js';
const result = async () => ({ outcome: { kind: 'value', value: 5 }, references: ['event-1'] });

it('lease takeover fences stale workers and sweep/failure cannot reopen committed receipts', async () => {
  const f = await fixture();
  try {
    const id = identity();
    assert.equal((await f.receipts.lookup(id)).state, 'absent');
    const first = await f.receipts.claim(id, { leaseMs: 10 });
    assert.equal((await f.receipts.claim(id, { leaseMs: 10 })).state, 'in-progress');
    assert.equal((await f.receipts.claim({ ...id, hash: 'collision' }, { leaseMs: 10 })).reason, 'identity-mismatch');
    f.advance(11);
    const next = await f.receipts.claim(id, { leaseMs: 10 });
    assert.equal(next.lease.generation, 2);
    await assert.rejects(f.receipts.execute(id, result, { lease: first.lease }), { code: 'JL2009' });
    await assert.rejects(f.receipts.release(id, first.lease), { code: 'JL2009' });
    await f.receipts.release(id, next.lease);
    const last = await f.receipts.claim(id, { leaseMs: 10 });
    await f.receipts.execute(id, result, { lease: last.lease });
    f.advance(10000);
    assert.equal((await f.receipts.claim(id, { leaseMs: 10 })).state, 'replay');
    assert.deepEqual(await f.receipts.sweep([id]), { changes: 0, writes: 0, revisions: 0 });
    const abandoned = { ...id, key: 'abandoned' };
    await f.receipts.claim(abandoned, { leaseMs: 10 });
    f.advance(11);
    assert.equal((await f.receipts.sweep([abandoned])).changes, 1);
    assert.equal((await f.receipts.sweep([abandoned])).writes, 0);
    assert.equal((await f.receipts.lookup({ ...id, hashVersion: 'new' })).reason, 'identity-mismatch');
  }
  finally { await f.client.close(); }
});

it('migration, compaction and repeated forward repair preserve outcomes, references and later writes across restart', async () => {
  const { dbPath, cleanup } = tempDbPath();
  const history = [{ identity: identity(), ...(await result()), createdAt: 1, auxiliary: { old: true } }];
  const policy = { retainReplay: true, retainReferences: true, actor: 'operator', reason: 'archive auxiliary' };
  let f = await fixture({ path: dbPath });
  try {
    assert.equal((await f.receipts.migrate(history)).writes, 1);
    assert.deepEqual(await f.receipts.migrate(history), { changes: 0, writes: 0, revisions: 0 });
    assert.throws(() => f.receipts.compact(identity(), { acknowledged: true }), { code: 'JL2009' });
    assert.equal((await f.receipts.compact(identity(), policy)).writes, 1);
    assert.equal((await f.receipts.compact(identity(), policy)).writes, 0);
    await f.receipts.execute({ ...identity(), key: 'later' }, result);
    await f.client.close();
    f = await fixture({ path: dbPath });
    assert.deepEqual(await f.receipts.migrate(history), { changes: 0, writes: 0, revisions: 0 });
    assert.equal((await f.receipts.lookup({ ...identity(), key: 'later' })).state, 'replay');
    const stored = (await f.receipts.lookup(identity())).receipt;
    assert.equal(stored.auxiliary, undefined);
    assert.deepEqual(stored.references, ['event-1']);
    assert.deepEqual(stored.outcome, history[0].outcome);
    await assert.rejects(f.receipts.migrate([{ ...history[0], outcome: 99 }]), { code: 'JL2009' });
    assert.throws(() => f.receipts.migrate([{ identity: identity(), expiresAt: 0 }]), { code: 'JL2009' });
  }
  finally { await f.client.close(); cleanup(); }
});

it('a leased command cannot bypass its token or bind a different payload under that token', async () => {
  const f = await fixture();
  try {
    const claimed = await f.receipts.claim(identity(), { leaseMs: 10 });
    assert.equal((await f.receipts.execute(identity(), result)).reason, 'lease-required');
    await assert.rejects(f.receipts.execute({ ...identity(), hash: 'changed' }, result, { lease: claimed.lease }), /identity mismatch/);
    assert.equal((await f.receipts.lookup(identity())).state, 'absent');
  }
  finally { await f.client.close(); }
});
