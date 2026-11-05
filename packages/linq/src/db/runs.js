//@ts-check
/** Existing domain run identities and bounded event pages over mapped application tables. */
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { mappedRecords, recordTransaction, copyRecord, refuseRecord } from './records.js';
import { closedOptions } from './options.js';

const zero = Object.freeze({ changes: 0, writes: 0, revisions: 0 });
const OPTIONS = Object.freeze(['runs', 'events', 'statuses', 'summary', 'canReset', 'maxPage', 'maxBytes']);
/** What `finish` reads from its options: the final observation's record fields. */
const FINISH_OPTIONS = Object.freeze(['summary', 'checkpoint']);
/** What `page` reads from its options: the cursor and the page size. */
const PAGE_OPTIONS = Object.freeze(['after', 'limit']);
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
  closedOptions(options, OPTIONS, 'createDbRunStore()');
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
  /** Refuse a checkpoint the run cannot take next: another run's, not the
   * generation after the record's, or a status outside the vocabulary. */
  const requireNext = (record, checkpoint) => {
    if (checkpoint === null || typeof checkpoint !== 'object' || checkpoint.runId !== record.id
      || checkpoint.generation !== (record.checkpoint?.generation ?? 0) + 1 || !Object.hasOwn(statuses, checkpoint.status))
      throw refuseRecord('checkpoint run, generation or status mismatch');
  };
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
        requireNext(record, checkpoint);
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
     * @param {string} id @param {{ after?: number, limit?: number }} [pageOptions] */
    page(id, pageOptions) {
      // `null` is no options, as `finish` reads it
      closedOptions(pageOptions ?? undefined, PAGE_OPTIONS, 'page()');
      const { after = 0, limit = maxPage } = pageOptions ?? {};
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
    /** Called after workers drain and before resources close. The final
     * observation may carry the host's public `summary` and the workflow's
     * last `checkpoint`: the wind-up, written under the same lease even
     * after `requestCancel`, which stops admitting new work, not recording
     * how the run ended. The status is always `state`'s.
     * @param {string} id @param {'cancelled' | 'failed'} state @param {any} lease
     * @param {{ summary?: Record<string, any>, checkpoint?: any }} [finishOptions] */
    finish(id, state, lease, finishOptions) {
      if (!['cancelled', 'failed'].includes(state)) throw new TypeError('finish state must be cancelled or failed');
      // `null` is no options, as a fourth argument has always been read
      closedOptions(finishOptions ?? undefined, FINISH_OPTIONS, 'finish()');
      const final = finishOptions?.summary === undefined ? { status: state } : copyRecord(finishOptions.summary);
      if (final === null || typeof final !== 'object' || Array.isArray(final)) throw new TypeError('finish summary must be a JSON object');
      // the summary may say how the run ended, never that it ended otherwise
      if (!Object.hasOwn(final, 'status')) final.status = state;
      else if (final.status !== state) throw refuseRecord('final run summary states another status');
      const checkpoint = finishOptions?.checkpoint === undefined ? undefined : copyRecord(finishOptions.checkpoint);
      return inside(async (tx) => {
        const record = await requireRun(tx, id);
        await guard(tx, record, lease);
        // a completed run is final: its status is the one thing `requestCancel` also refuses to rewrite
        if (record.status === statuses[state] || record.status === statuses.done) return { record, ...zero };
        if (checkpoint !== undefined) {
          requireNext(record, checkpoint);
          // a workflow that reached done is saved, and then it is not finished
          if (checkpoint.status === 'done') throw refuseRecord('a done checkpoint cannot finish a run as cancelled or failed');
          record.checkpoint = checkpoint;
        }
        record.status = statuses[state]; record.summary = final;
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
