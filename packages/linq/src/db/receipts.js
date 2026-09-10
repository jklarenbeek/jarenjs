//@ts-check
/** Business receipts and independent fenced leases over application-owned tables. */
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { resolveRuntime } from '@jarenjs/core/runtime';
import { mappedRecords, recordTransaction, copyRecord, refuseRecord } from './records.js';

const fields = ['tenant', 'environment', 'aggregate', 'op', 'key', 'hashVersion', 'hash'];
/** @param {any} identity */
function identityOf(identity) {
  if (!identity || fields.some((name) => typeof identity[name] !== 'string' || !identity[name] || identity[name].length > 4096))
    throw new TypeError('command identity needs bounded tenant/environment/aggregate/op/key/hashVersion/hash strings');
  return Object.fromEntries(fields.map((name) => [name, identity[name]]));
}
const idOf = (identity) => canonicalizeJson(fields.slice(0, 5).map((name) => identity[name]));
const matches = (record, identity) => canonicalizeJson(record.identity) === canonicalizeJson(identity);
const zero = Object.freeze({ changes: 0, writes: 0, revisions: 0 });

/**
 * No TTL applies to business receipts. The optional lease table is recoverable
 * execution authority only. The callback receives the exact transaction client
 * so domain changes and outbox enqueues commit with the validated outcome.
 * @param {any} client
 * @param {{ receipts: any, leases?: any, runtime?: any }} options
 */
export function createDbReceipts(client, options) {
  const receipts = mappedRecords(client, options?.receipts);
  const leases = options.leases === undefined ? null : mappedRecords(client, options.leases);
  if (leases?.name === receipts.name) throw new TypeError('receipts and leases must use distinct collections');
  const runtime = resolveRuntime(options.runtime);
  const inside = (fn) => recordTransaction(client, fn);
  const replay = (record, identity) => {
    if (!matches(record, identity)) return { state: 'refused', reason: 'identity-mismatch', ...zero };
    return { state: 'replay', historic: true, receipt: copyRecord(record), ...zero };
  };
  const checkLease = async (tx, id, lease) => {
    const current = leases && await leases.get(tx, id);
    if (!current || current.token !== lease?.token || current.expiresAt <= runtime.now()) throw refuseRecord('stale command lease');
    return current;
  };
  return Object.freeze({
    /** Authorize before calling: this low-level repository is a trusted host capability.
     * @param {any} identity */
    lookup(identity) {
      const normalized = identityOf(identity);
      return inside(async (tx) => {
        const record = await receipts.get(tx, idOf(normalized));
        return record ? replay(record, normalized) : { state: 'absent', ...zero };
      });
    },
    /** @param {any} identity @param {(tx: any) => Promise<{ outcome: any, references?: any[] }>} work
     * @param {{ lease?: any }} [context] */
    execute(identity, work, context = {}) {
      const normalized = identityOf(identity), id = idOf(normalized);
      return inside(async (tx) => {
        const prior = await receipts.get(tx, id);
        if (prior) return replay(prior, normalized);
        if (context.lease !== undefined) {
          const claimed = await checkLease(tx, id, context.lease);
          if (!matches(claimed, normalized)) throw refuseRecord('command lease identity mismatch');
        }
        else if (leases && await leases.get(tx, id)) return { state: 'refused', reason: 'lease-required', ...zero };
        const result = copyRecord(await work(tx));
        const record = { id, identity: normalized, outcome: result.outcome, references: result.references ?? [],
          createdAt: runtime.now(), revision: 1, compacted: false };
        await receipts.put(tx, record, true);
        if (context.lease !== undefined) {
          await checkLease(tx, id, context.lease);
          await leases.delete(tx, id);
        }
        return { state: 'committed', historic: false, receipt: record, changes: 1, writes: 1, revisions: 1 };
      });
    },
    /** Claim/reclaim only absent receipts; lease expiry never overrides history.
     * @param {any} identity @param {{ leaseMs: number }} options */
    claim(identity, { leaseMs }) {
      if (!leases || !Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new TypeError('claim needs a lease collection and positive leaseMs');
      const normalized = identityOf(identity), id = idOf(normalized);
      return inside(async (tx) => {
        const receipt = await receipts.get(tx, id);
        if (receipt) return replay(receipt, normalized);
        const prior = await leases.get(tx, id);
        if (prior && !matches(prior, normalized)) return { state: 'refused', reason: 'identity-mismatch', ...zero };
        if (prior && prior.expiresAt > runtime.now()) return { state: 'in-progress', ...zero };
        const lease = { id, identity: normalized, token: runtime.uuid(), generation: (prior?.generation ?? 0) + 1,
          expiresAt: runtime.now() + leaseMs };
        await leases.put(tx, lease);
        return { state: 'claimed', lease };
      });
    },
    /** Release one failed attempt; a receipt is never removed.
     * @param {any} identity @param {any} lease */
    release(identity, lease) {
      const id = idOf(identityOf(identity));
      return inside(async (tx) => { await checkLease(tx, id, lease); await leases.delete(tx, id); return { changes: 1, writes: 1, revisions: 0 }; });
    },
    /** Sweep a bounded, caller-selected batch of lease identities, never receipts.
     * @param {any[]} identities */
    sweep(identities) {
      if (!leases || !Array.isArray(identities) || identities.length > 1000) throw new TypeError('sweep needs leases and at most 1000 identities');
      const ids = [...new Set(identities.map((identity) => idOf(identityOf(identity))))];
      return inside(async (tx) => {
        let changes = 0;
        for (const id of ids) {
          const lease = await leases.get(tx, id);
          if (lease && lease.expiresAt <= runtime.now()) { await leases.delete(tx, id); changes++; }
        }
        return { changes, writes: changes, revisions: 0 };
      });
    },
    /** Import explicit immutable outcomes; a preexisting receipt always wins.
     * No expiring claim is interpreted as a business outcome.
     * @param {any[]} records */
    migrate(records) {
      if (!Array.isArray(records) || records.length > 1000) throw new TypeError('migration is bounded to 1000 explicit receipts');
      const batch = records.map((record) => {
        const identity = identityOf(record.identity);
        if (!Object.hasOwn(record, 'outcome') || !Array.isArray(record.references)) throw refuseRecord('migration needs an outcome and stable references');
        return copyRecord({ ...record, id: idOf(identity), identity, revision: 1, compacted: false });
      });
      return inside(async (tx) => {
        let changes = 0;
        for (const record of batch) {
          const prior = await receipts.get(tx, record.id);
          if (prior) {
            if (!matches(prior, record.identity) || canonicalizeJson(prior.outcome) !== canonicalizeJson(record.outcome)
              || canonicalizeJson(prior.references) !== canonicalizeJson(record.references)) throw refuseRecord('receipt migration collision');
            continue;
          }
          await receipts.put(tx, record, true); changes++;
        }
        return { changes, writes: changes, revisions: changes };
      });
    },
    /** Compaction may remove only auxiliary data; identity/outcome/references stay.
     * @param {any} identity @param {{ retainReplay: true, retainReferences: true, actor: string, reason: string }} policy */
    compact(identity, policy) {
      if (policy?.retainReplay !== true || policy?.retainReferences !== true || !policy.actor || !policy.reason)
        throw refuseRecord('erasure refused: explicit retention and actor/reason are required');
      const normalized = identityOf(identity), id = idOf(normalized);
      return inside(async (tx) => {
        const record = await receipts.get(tx, id);
        if (!record || !matches(record, normalized)) throw refuseRecord('receipt compaction identity mismatch');
        if (record.compacted) return zero;
        const { auxiliary: _discarded, ...retained } = record;
        await receipts.put(tx, { ...retained, compacted: true, revision: record.revision + 1,
          retention: { actor: policy.actor, reason: policy.reason } });
        return { changes: 1, writes: 1, revisions: 1 };
      });
    },
  });
}
