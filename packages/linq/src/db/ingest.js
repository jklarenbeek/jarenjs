//@ts-check
/** Atomic page/checkpoint staging and complete-generation publication. */
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { isThenable } from '@jarenjs/core/function';

const copy = (value) => JSON.parse(canonicalizeJson(value));
const key = (...parts) => canonicalizeJson(parts);

/**
 * Adapt application-declared collections under the client's transaction owner.
 * Reconcile is a synchronous pure policy; network I/O belongs outside this
 * adapter. No table, schema, credentials or provider field policy is inferred.
 * @param {any} client
 * @param {{ staging: string, checkpoints: string, publications: string, facts?: string,
 * reconcile?: (existing: any, incoming: any, evidence: any) => any }} options
 */
export function createDbIngestionStore(client, options) {
  if (!client || typeof client.transaction !== 'function' || !client.collections || !options)
    throw new TypeError('ingestion store needs a client and declared collection names');
  const names = ['staging', 'checkpoints', 'publications', ...(options.facts ? ['facts'] : [])];
  if (new Set(names.map((name) => options[name])).size !== names.length
    || names.some((name) => typeof options[name] !== 'string' || !Object.hasOwn(client.collections, options[name])))
    throw new TypeError('ingestion collections must be distinct declared collections');
  if (options.reconcile !== undefined && typeof options.reconcile !== 'function') throw new TypeError('reconcile must be a pure function');
  const reconcile = options.reconcile ?? ((_existing, incoming) => incoming);
  const inside = (fn) => typeof client.close === 'function' ? client.transaction(fn, { mode: 'immediate' }) : client.transaction(fn);
  const fingerprint = (plan) => key(plan.source, plan.version, plan.partitions, plan.input, plan.policyRevision, plan.consistency);
  const checkpointId = (plan) => key(plan.source, plan.generation);
  const publications = (tx) => tx.collections[options.publications];
  const checkpoints = (tx) => tx.collections[options.checkpoints];
  const zero = { changes: 0, writes: 0, revisions: 0 };
  const matching = async (tx, plan) => {
    const checkpoint = await checkpoints(tx).get(checkpointId(plan));
    if (!checkpoint || checkpoint.fingerprint !== fingerprint(plan)) throw new TypeError('ingestion checkpoint does not match the plan');
    return checkpoint;
  };
  return Object.freeze({
    /** @param {any} plan */
    begin(plan) {
      return inside(async (tx) => {
        const published = await publications(tx).get(plan.source);
        if (published?.fingerprint === fingerprint(plan)) return { state: 'unchanged', ...zero, manifest: published };
        const id = checkpointId(plan);
        const existing = await checkpoints(tx).get(id);
        if (existing) {
          if (existing.fingerprint !== fingerprint(plan)) return { state: 'refused', reason: 'generation-mismatch' };
          if (existing.status !== 'staging') return { state: 'refused', reason: existing.status };
          return { state: 'staging', checkpoint: existing, ...zero };
        }
        const checkpoint = { id, fingerprint: fingerprint(plan), source: plan.source, generation: plan.generation,
          version: plan.version, expectedPublication: published?.generation ?? null, status: 'staging',
          partitions: plan.partitions.map((partition) => ({ id: partition, cursor: null, complete: false, pages: [] })),
          pages: 0, rows: 0, bytes: 0 };
        await checkpoints(tx).insert(checkpoint);
        return { state: 'staging', checkpoint, ...zero };
      });
    },
    /** Page bytes and its continuation/completion evidence commit together.
     * @param {any} plan @param {string} partition @param {any} page */
    stage(plan, partition, page) {
      return inside(async (tx) => {
        const checkpoint = await matching(tx, plan);
        if (checkpoint.status !== 'staging') return { state: 'refused', reason: checkpoint.status };
        const part = checkpoint.partitions.find((p) => p.id === partition);
        if (!part) return { state: 'refused', reason: 'unknown-partition' };
        const id = key(plan.source, plan.generation, partition, page.cursor);
        const staging = tx.collections[options.staging];
        const existing = await staging.get(id);
        const record = copy({ id, partition, generation: plan.generation, source: plan.source, page });
        if (existing) {
          if (canonicalizeJson(existing) !== canonicalizeJson(record)) return { state: 'refused', reason: 'page-conflict' };
          return { state: 'staged', checkpoint, ...zero };
        }
        if (part.complete || canonicalizeJson(part.cursor) !== canonicalizeJson(page.cursor)) return { state: 'refused', reason: 'stale-cursor' };
        await staging.insert(record);
        part.pages.push(id);
        part.cursor = page.continuation;
        part.complete = page.complete === true && page.reason === null && page.version === plan.version;
        checkpoint.pages++;
        checkpoint.rows += page.rows.length;
        checkpoint.bytes += page.bytes;
        if (page.reason !== null) checkpoint.status = 'incomplete';
        if (page.version !== plan.version) checkpoint.status = 'source-changed';
        await checkpoints(tx).put(checkpoint, checkpoint.id);
        return { state: 'staged', checkpoint, ...zero };
      });
    },
    /** Preserve partial observations but fence the generation from publication.
     * @param {any} plan @param {string} reason */
    invalidate(plan, reason) {
      return inside(async (tx) => {
        const checkpoint = await matching(tx, plan);
        if (checkpoint.status === 'published' || checkpoint.status === reason) return;
        await checkpoints(tx).put({ ...checkpoint, status: reason }, checkpoint.id);
      });
    },
    /** Completion evidence, effective facts and the pointer share one commit.
     * @param {any} plan @param {any} evidence @param {{ signal?: AbortSignal }} [context] */
    publish(plan, evidence, context = {}) {
      return inside(async (tx) => {
        if (context.signal?.aborted) return { state: 'refused', reason: 'cancelled' };
        const checkpoint = await matching(tx, plan);
        const published = await publications(tx).get(plan.source);
        if (published?.fingerprint === fingerprint(plan)) return { state: 'unchanged', ...zero, manifest: published };
        if (checkpoint.status !== 'staging' || checkpoint.partitions.some((part) => !part.complete)) return { state: 'refused', reason: 'incomplete' };
        if ((published?.generation ?? null) !== checkpoint.expectedPublication) return { state: 'refused', reason: 'publication-conflict' };
        if (!evidence || evidence.version !== plan.version || evidence.consistency !== plan.consistency)
          return { state: 'refused', reason: 'source-changed' };
        let changes = 0;
        const seen = new Set();
        for (const part of checkpoint.partitions) for (const id of part.pages) {
          const record = await tx.collections[options.staging].get(id);
          if (!record || record.page.version !== plan.version || record.page.reason !== null) throw new TypeError('publication lacks page evidence');
          for (let i = 0; i < record.page.rows.length; i++) {
            const providerId = record.page.ids[i];
            const factId = key(plan.source, part.id, providerId);
            if (seen.has(factId)) throw new TypeError('publication has duplicate source identities');
            seen.add(factId);
            if (!options.facts) continue;
            const facts = tx.collections[options.facts];
            const prior = await facts.get(factId);
            const value = reconcile(prior?.value ?? null, copy(record.page.rows[i]), { source: plan.source, partition: part.id, providerId, version: plan.version });
            if (isThenable(value)) throw new TypeError('reconcile must be synchronous; network I/O cannot hold a page transaction');
            if (context.signal?.aborted) throw new TypeError('publication cancelled');
            if (prior && canonicalizeJson(prior.value) === canonicalizeJson(value)) continue;
            await facts.put({ id: factId, source: plan.source, partition: part.id, providerId,
              value: copy(value), revision: (prior?.revision ?? 0) + 1 }, factId);
            changes++;
          }
        }
        const manifest = { id: plan.source, source: plan.source, generation: plan.generation, version: plan.version,
          fingerprint: fingerprint(plan), partitions: copy(checkpoint.partitions), evidence: copy(evidence),
          pages: checkpoint.pages, rows: checkpoint.rows, bytes: checkpoint.bytes };
        if (context.signal?.aborted) throw new TypeError('publication cancelled');
        await publications(tx).put(manifest, plan.source);
        await checkpoints(tx).put({ ...checkpoint, status: 'published' }, checkpoint.id);
        if (context.signal?.aborted) throw new TypeError('publication cancelled');
        return { state: 'published', changes, writes: changes, revisions: changes, manifest };
      });
    },
    /** @param {string} source */
    current: (source) => client.collections[options.publications].get(source),
    /** @param {any} plan */
    inspect(plan) {
      return inside(async (tx) => {
        const checkpoint = await matching(tx, plan);
        const observations = [];
        for (const part of checkpoint.partitions) for (const id of part.pages) observations.push(await tx.collections[options.staging].get(id));
        return { checkpoint, observations };
      });
    },
  });
}
