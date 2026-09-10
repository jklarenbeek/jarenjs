//@ts-check
/** Durable external intent/evidence in mapped tables, fenced by the existing job engine. */
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { mappedRecords, recordTransaction, copyRecord, refuseRecord } from './records.js';

const zero = Object.freeze({ changes: 0, writes: 0, revisions: 0 });
const terminal = (state) => state === 'confirmed' || state === 'rejected';
/**
 * Preparation/outbox and each settlement commit locally. Remote delivery never
 * runs inside this adapter. Intent is permanent until evidence resolves it.
 * @param {any} client @param {{ operations: any, maxLegs?: number, maxBytes?: number }} options
 */
export function createDbEffectStore(client, options) {
  const records = mappedRecords(client, options?.operations);
  const { maxLegs = 64, maxBytes = 262144 } = options;
  for (const limit of [maxLegs, maxBytes]) if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('effect limits must be finite positive integers');
  const inside = (fn) => recordTransaction(client, fn);
  const requireRecord = async (tx, id) => {
    const record = await records.get(tx, id);
    if (!record) throw refuseRecord('unknown external operation');
    return record;
  };
  const guard = async (tx, record, revision, lease) => {
    if (record.revision !== revision || lease?.jobId !== record.plan.jobId) throw refuseRecord('stale operation revision or foreign job');
    await tx.jobs.assertLease(lease);
  };
  const legOf = (record, id) => {
    const leg = record.legs.find((value) => value.id === id);
    if (!leg) throw refuseRecord('unknown operation leg');
    return leg;
  };
  const write = async (tx, record) => {
    record.revision++;
    await records.put(tx, record);
    return { record, changes: 1, writes: 1, revisions: 1 };
  };
  return Object.freeze({
    /** Caller authorization must establish review/compensation authority before preparation.
     * @param {any} plan @param {(tx: any) => any} [prepare] */
    prepare(plan, prepare) {
      const frozen = copyRecord(plan);
      if (['id', 'jobId', 'kind', 'actor', 'reason', 'hashVersion'].some((name) => typeof frozen[name] !== 'string' || !frozen[name])
        || !Array.isArray(frozen.legs) || !frozen.legs.length || frozen.legs.length > maxLegs
        || new Set(frozen.legs.map((leg) => leg.id)).size !== frozen.legs.length
        || frozen.legs.some((leg) => typeof leg.id !== 'string' || !leg.id
          || !['single-send', 'provider-idempotent'].includes(leg.request?.safety)
          || !Number.isSafeInteger(leg.maxAttempts) || leg.maxAttempts < 1 || leg.maxAttempts > 100
          || (leg.request.safety === 'single-send' && leg.maxAttempts !== 1)
          || (leg.request.safety === 'provider-idempotent' && !leg.request.idempotencyKey))
        || (frozen.compensationOf !== undefined && frozen.compensationAuthorized !== true)
        || new TextEncoder().encode(canonicalizeJson(frozen)).byteLength > maxBytes)
        throw new TypeError('effect preparation needs bounded reviewed legs, replay safety, attempt budgets and explicit compensation authority');
      const fingerprint = canonicalizeJson(frozen);
      return inside(async (tx) => {
        const prior = await records.get(tx, frozen.id);
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw refuseRecord('reviewed operation payload changed');
          return { record: prior, ...zero };
        }
        if (await tx.jobs.get(frozen.jobId) !== undefined) throw refuseRecord('operation job identity already belongs to another enqueue');
        if (prepare) await prepare(tx);
        const record = { id: frozen.id, plan: frozen, fingerprint, revision: 1,
          legs: frozen.legs.map((leg) => ({ id: leg.id, state: 'prepared', attempts: 0, evidence: null, intent: null })), decisions: [] };
        await records.put(tx, record, true);
        await tx.jobs.enqueue(frozen.kind, { operationId: frozen.id }, { id: frozen.jobId });
        return { record, changes: 1, writes: 1, revisions: 1 };
      });
    },
    /** @param {string} id */
    get: (id) => inside((tx) => requireRecord(tx, id)),
    /** Persist sending before dispatch. A stale worker cannot start another send.
     * @param {string} id @param {string} legId @param {number} revision @param {any} lease */
    begin(id, legId, revision, lease) {
      return inside(async (tx) => {
        const record = await requireRecord(tx, id);
        await guard(tx, record, revision, lease);
        const leg = legOf(record, legId), plan = record.plan.legs.find((value) => value.id === legId);
        if (leg.state !== 'prepared' && leg.state !== 'retry-approved') return { state: leg.state, record, ...zero };
        if (leg.attempts >= plan.maxAttempts) return { state: 'exhausted', record, ...zero };
        leg.state = 'sending';
        leg.attempts++;
        leg.intent = { generation: lease.generation, attempt: leg.attempts };
        return { state: 'sending', ...(await write(tx, record)) };
      });
    },
    /** Only the active attempt may persist transport evidence.
     * @param {string} id @param {string} legId @param {number} revision @param {any} lease @param {any} outcome */
    settle(id, legId, revision, lease, outcome) {
      const observation = copyRecord(outcome);
      if (!['confirmed', 'rejected', 'unresolved'].includes(observation.state)
        || !Object.hasOwn(observation, 'evidence') || new TextEncoder().encode(canonicalizeJson(observation)).byteLength > maxBytes)
        throw refuseRecord('external settlement needs bounded confirmed/rejected/unresolved evidence');
      return inside(async (tx) => {
        const record = await requireRecord(tx, id);
        await guard(tx, record, revision, lease);
        const leg = legOf(record, legId);
        if (leg.state !== 'sending' || leg.intent.generation !== lease.generation) throw refuseRecord('no sending intent for this attempt');
        leg.state = observation.state;
        leg.evidence = observation.evidence;
        return write(tx, record);
      });
    },
    /** Lost workers leave uncertainty, never proof of non-application.
     * @param {string} id @param {number} revision @param {any} lease */
    recover(id, revision, lease) {
      return inside(async (tx) => {
        const record = await requireRecord(tx, id);
        await guard(tx, record, revision, lease);
        let changed = false;
        for (const leg of record.legs) if (leg.state === 'sending') { leg.state = 'unresolved'; changed = true; }
        return changed ? write(tx, record) : { record, ...zero };
      });
    },
    /** Explicit read-back or operator decisions; absence is evidence only under
     * the declared authoritative non-application guarantee. Idempotent retries
     * retain the reviewed request/key and the original durable attempt budget.
     * @param {string} id @param {string} legId @param {number} revision @param {any} lease @param {any} decision */
    reconcile(id, legId, revision, lease, decision) {
      const proof = copyRecord(decision);
      if (['id', 'actor', 'reason'].some((key) => typeof proof[key] !== 'string' || !proof[key])
        || !['confirm', 'reject', 'retry'].includes(proof.action) || !Object.hasOwn(proof, 'evidence')) throw refuseRecord('reconciliation needs actor/reason and evidence');
      return inside(async (tx) => {
        const record = await requireRecord(tx, id);
        if (lease?.jobId !== record.plan.jobId) throw refuseRecord('foreign reconciliation job');
        await tx.jobs.assertLease(lease);
        const entry = { ...proof, legId };
        const prior = record.decisions.find((value) => value.id === proof.id);
        if (prior) {
          if (canonicalizeJson(prior) !== canonicalizeJson(entry)) throw refuseRecord('reconciliation decision collision');
          return { record, ...zero };
        }
        await guard(tx, record, revision, lease);
        const leg = legOf(record, legId), plan = record.plan.legs.find((value) => value.id === legId);
        if (terminal(leg.state) || !['sending', 'unresolved'].includes(leg.state)) throw refuseRecord('only unresolved intent can be reconciled');
        if (proof.action === 'retry' && (plan.request.safety !== 'provider-idempotent' && proof.guarantee !== 'authoritative-non-application'))
          throw refuseRecord('absence is not proof of non-application');
        // Single-send remains single-send: an authoritative negative result can
        // be recorded as rejected, followed by a separately reviewed operation.
        if (proof.action === 'retry' && leg.attempts >= plan.maxAttempts) throw refuseRecord('durable attempt budget exhausted');
        if (record.decisions.length >= 128 || new TextEncoder().encode(canonicalizeJson(entry)).byteLength > maxBytes) throw refuseRecord('reconciliation evidence limit');
        leg.state = proof.action === 'confirm' ? 'confirmed' : proof.action === 'reject' ? 'rejected' : 'retry-approved';
        leg.evidence = proof.evidence;
        record.decisions.push(entry);
        return write(tx, record);
      });
    },
  });
}
