//@ts-check
/** Existing domain run identities and bounded event pages over mapped application tables. */
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { mappedRecords, recordTransaction, copyRecord, refuseRecord } from './records.js';

const zero = Object.freeze({ changes: 0, writes: 0, revisions: 0 });
/**
 * Checkpoints remain the existing workflow's format. Status mapping and public
 * summaries are application policy; events never contain the checkpoint input,
 * provider credentials, live resources or raw exceptions.
 * @param {any} client
 * @param {{ runs: any, events: any, statuses?: Record<string, string>,
 * summary?: (snapshot: any) => any, canReset?: (tx: any, record: any) => any,
 * maxPage?: number, maxBytes?: number }} options
 */
export function createDbRunStore(client, options) {
  const runs = mappedRecords(client, options?.runs), events = mappedRecords(client, options?.events);
  if (runs.name === events.name) throw new TypeError('runs and events must be distinct collections');
  const { maxPage = 128, maxBytes = 262144 } = options;
  for (const limit of [maxPage, maxBytes]) if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('run observation limits must be positive finite integers');
  const statuses = { running: 'running', waiting: 'waiting', done: 'done', failed: 'failed', cancelled: 'cancelled', ...options.statuses };
  if (Object.values(statuses).some((value) => typeof value !== 'string' || !value)) throw new TypeError('status mapping values must be nonempty strings');
  const summary = options.summary ?? ((snapshot) => ({ status: snapshot.status, generation: snapshot.generation }));
  const inside = (fn) => recordTransaction(client, fn);
  const bytes = (value) => new TextEncoder().encode(canonicalizeJson(value)).byteLength;
  const bounded = (page) => {
    if (bytes(page) > maxBytes) throw refuseRecord('run page exceeds byte budget');
    return page;
  };
  const eventId = (id, revision) => canonicalizeJson([id, revision]);
  const requireRun = async (tx, id) => {
    const record = await runs.get(tx, id);
    if (!record || !Number.isSafeInteger(record.revision) || record.revision < 0) throw refuseRecord('unknown or malformed domain run');
    return record;
  };
  const guard = async (tx, record, lease) => {
    if (record.jobId !== lease?.jobId) throw refuseRecord('foreign run job');
    await tx.jobs.assertLease(lease);
  };
  const same = (record, identity) => record.workflow === identity.workflow && record.schemaVersion === identity.schemaVersion && record.jobId === identity.jobId;
  const write = async (tx, record) => {
    if (!Number.isSafeInteger(record.revision + 1)) throw refuseRecord('run revision exhausted');
    record.revision++;
    const event = { id: eventId(record.id, record.revision), runId: record.id, revision: record.revision,
      status: record.status, summary: record.summary, cancelRequested: record.cancelRequested };
    if (bytes({ state: 'page', events: [event], cursor: record.revision, revision: record.revision, more: false, status: record.status, summary: record.summary }) > maxBytes) throw refuseRecord('public run summary exceeds byte budget');
    await runs.put(tx, record);
    await events.put(tx, event, true);
    return { record, changes: 1, writes: 2, revisions: 1 };
  };
  return Object.freeze({
    /** Attach without renaming or re-enqueueing an existing domain run.
     * @param {{ id: string, jobId: string, workflow: string, schemaVersion: string }} identity @param {any} lease */
    attach(identity, lease) {
      const frozen = copyRecord(identity);
      if (['id', 'jobId', 'workflow', 'schemaVersion'].some((name) => typeof frozen[name] !== 'string' || !frozen[name])) throw new TypeError('run identity needs id/jobId/workflow/schemaVersion');
      return inside(async (tx) => {
        if (frozen.jobId !== lease?.jobId) throw refuseRecord('foreign run job');
        await tx.jobs.assertLease(lease);
        const prior = await runs.get(tx, frozen.id);
        if (prior) {
          if (!same(prior, frozen)) throw refuseRecord('incompatible run workflow or schema identity');
          return { record: prior, ...zero };
        }
        return write(tx, { ...frozen, revision: 0, status: statuses.running, summary: null, checkpoint: null, cancelRequested: false });
      });
    },
    /** Verify provenance before exposing any old checkpoint to the engine.
     * @param {string} id @param {any} identity @param {any} lease */
    load(id, identity, lease) {
      return inside(async (tx) => {
        const record = await requireRun(tx, id);
        await guard(tx, record, lease);
        if (!same(record, identity)) throw refuseRecord('incompatible run workflow or schema identity');
        if (record.cancelRequested) throw refuseRecord('run cancellation stops admission');
        return record.checkpoint;
      });
    },
    /** Existing workflow CAS, mapped status/event and checkpoint co-commit.
     * @param {string} id @param {any} snapshot @param {number} expectedGeneration @param {any} lease */
    save(id, snapshot, expectedGeneration, lease) {
      const checkpoint = copyRecord(snapshot);
      return inside(async (tx) => {
        const record = await requireRun(tx, id);
        await guard(tx, record, lease);
        if (record.cancelRequested) throw refuseRecord('run cancellation stops admission');
        if ((record.checkpoint?.generation ?? 0) !== expectedGeneration) return false;
        if (checkpoint.runId !== id || checkpoint.generation !== expectedGeneration + 1 || !Object.hasOwn(statuses, checkpoint.status))
          throw refuseRecord('checkpoint run, generation or status mismatch');
        record.checkpoint = checkpoint;
        record.status = statuses[checkpoint.status];
        record.summary = copyRecord(summary(checkpoint));
        await write(tx, record);
        return true;
      });
    },
    /** Trusted read: public authorization belongs to the contract handler.
     * @param {string} id */
    get: (id) => inside((tx) => requireRun(tx, id)),
    /** Bounded revision cursor. Missing history explicitly requires a fresh summary.
     * @param {string} id @param {{ after?: number, limit?: number }} [options] */
    page(id, { after = 0, limit = maxPage } = {}) {
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > maxPage) throw new TypeError('run page needs a revision cursor and bounded limit');
      return inside(async (tx) => {
        const record = await requireRun(tx, id);
        if (after > record.revision) throw refuseRecord('future run cursor');
        const page = [], end = Math.min(record.revision, after + limit);
        const envelope = { state: 'page', events: page, cursor: after, revision: record.revision, more: true, status: record.status, summary: record.summary };
        for (let revision = after + 1; revision <= end; revision++) {
          const event = await events.get(tx, eventId(id, revision));
          if (!event) return bounded({ state: 'reset-required', cursor: record.revision, revision: record.revision, events: [], summary: record.summary, status: record.status });
          if (event.runId !== id || event.revision !== revision) throw refuseRecord('run event identity mismatch');
          if (bytes({ ...envelope, cursor: revision, events: [...page, event] }) > maxBytes) break;
          page.push(event);
        }
        const cursor = page.at(-1)?.revision ?? after;
        if (cursor === after && cursor < record.revision) throw refuseRecord('run page exceeds byte budget');
        return bounded({ state: 'page', events: page, cursor, revision: record.revision, more: cursor < record.revision,
          status: record.status, summary: record.summary });
      });
    },
    /** Current authority is required in the caller's command; revision rejects stale intent.
     * @param {string} id @param {number} expectedRevision @param {{ actor: string, reason: string }} evidence */
    requestCancel(id, expectedRevision, evidence) {
      if (!evidence?.actor || !evidence.reason) throw refuseRecord('cancellation needs actor and reason');
      const proof = copyRecord(evidence);
      return inside(async (tx) => {
        const record = await requireRun(tx, id);
        if (record.cancelRequested) return { record, ...zero };
        if (record.revision !== expectedRevision) throw refuseRecord('stale cancellation revision');
        if (record.status === statuses.done) throw refuseRecord('completed run cannot be cancelled');
        record.cancelRequested = true; record.cancellation = proof;
        return write(tx, record);
      });
    },
    /** Called after workers drain and before resources close.
     * @param {string} id @param {'cancelled' | 'failed'} state @param {any} lease */
    finish(id, state, lease) {
      if (!['cancelled', 'failed'].includes(state)) throw new TypeError('finish state must be cancelled or failed');
      return inside(async (tx) => {
        const record = await requireRun(tx, id);
        await guard(tx, record, lease);
        if (record.status === statuses[state]) return { record, ...zero };
        record.status = statuses[state]; record.summary = { status: state };
        return write(tx, record);
      });
    },
    /** Reset touches only this run checkpoint, never receipts/effects. Host safety
     * must consult authoritative history in this transaction; default is refusal.
     * @param {string} id @param {number} expectedRevision @param {any} evidence @param {any} lease */
    reset(id, expectedRevision, evidence, lease) {
      if (!evidence?.actor || !evidence.reason || typeof options.canReset !== 'function') throw refuseRecord('reset needs explicit actor/reason and a transactional safety policy');
      return inside(async (tx) => {
        const record = await requireRun(tx, id);
        await guard(tx, record, lease);
        if (record.revision !== expectedRevision || ![statuses.cancelled, statuses.failed, statuses.waiting].includes(record.status)) throw refuseRecord('reset needs an inactive current revision');
        if (await options.canReset(tx, copyRecord(record)) !== true) throw refuseRecord('receipt or unresolved effect prevents reset');
        record.checkpoint = null; record.cancelRequested = false; record.status = statuses.running;
        record.summary = { status: 'reset' }; record.reset = copyRecord(evidence);
        return write(tx, record);
      });
    },
  });
}
