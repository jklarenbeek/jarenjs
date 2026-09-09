//@ts-check
/** Identity-bound, text-free vector cache. A failed batch never invalidates paid rows. */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from './relevance.js';

/** Validate the actual Float32 representation, including overflow and zero norms.
 * @param {any} value @param {number} dims */
export function verifiedVector(value, dims) {
  if ((!Array.isArray(value) && !(value instanceof Float32Array)) || value.length !== dims
    || !Array.from(value).every((x) => typeof x === 'number' && Number.isFinite(x)))
    throw new Error('invalid cached or returned vector');
  const out = Array.from(new Float32Array(value));
  if (!out.every(Number.isFinite) || !out.some((v) => v !== 0)) throw new Error('invalid Float32 vector');
  return out;
}

/** Open one cache directory for exactly one dataset/provider/model/options identity.
 * @param {{directory: string, identity: any, embedder: any, batch?: number, maxCalls?: number, maxBatchChars?: number, usage?: () => any}} options */
export function createRelevanceCache({ directory, identity, embedder, batch = 64, maxCalls = 200, maxBatchChars = 100000, usage }) {
  if (!identity || !/^[a-f0-9]{64}$/.test(identity.datasetHash) || !identity.provider
    || !identity.model || !Number.isSafeInteger(identity.dims) || identity.dims < 1
    || identity.model !== embedder.model || identity.dims !== embedder.dims)
    throw new Error('cache requires a complete matching embedding identity');
  for (const n of [batch, maxCalls, maxBatchChars])
    if (!Number.isSafeInteger(n) || n < 1) throw new Error('invalid embedding budget');
  // Only allow declared provenance fields, never a spread of provider options/keys.
  const bound = { datasetHash: identity.datasetHash, provider: identity.provider,
    model: identity.model, dims: identity.dims, endpointHash: identity.endpointHash ?? null,
    textPolicy: identity.textPolicy ?? 'title-newline-text-v1' };
  mkdirSync(directory, { recursive: true });
  const manifestPath = join(directory, 'identity.json');
  if (existsSync(manifestPath)) {
    if (JSON.stringify(JSON.parse(readFileSync(manifestPath, 'utf8'))) !== JSON.stringify(bound))
      throw new Error('cache identity mismatch: use a different directory');
  }
  else writeFileSync(manifestPath, JSON.stringify(bound), { flag: 'wx' });
  const identityHash = sha256(JSON.stringify(bound));
  const stats = { cacheHits: 0, embedded: 0, calls: 0, wallMs: 0, failures: [] };
  const journalPath = join(directory, 'batches.jsonl');
  const journal = (row) => writeFileSync(journalPath, JSON.stringify(row) + '\n', { flag: 'a' });
  /** @param {string[]} texts */
  async function embed(texts) {
    if (!Array.isArray(texts) || texts.length === 0) throw new Error('cache embed needs a nonempty text array');
    if (embedder.model !== bound.model || embedder.dims !== bound.dims)
      throw new Error('embedder identity changed after cache initialization');
    const out = new Array(texts.length), missing = new Map();
    for (let i = 0; i < texts.length; i++) {
      if (typeof texts[i] !== 'string' || !texts[i].trim()) throw new Error('embedding text must be nonempty');
      const textHash = sha256(texts[i]);
      const path = join(directory, `${textHash}.json`);
      if (existsSync(path)) {
        const row = JSON.parse(readFileSync(path, 'utf8'));
        if (row.identityHash !== identityHash || row.textHash !== textHash
          || row.vectorHash !== sha256(JSON.stringify(row.vector))) throw new Error('cache row checksum or identity mismatch');
        out[i] = new Float32Array(verifiedVector(row.vector, bound.dims));
        stats.cacheHits++;
      }
      else {
        if (!missing.has(textHash)) missing.set(textHash, { textHash, text: texts[i], indices: [] });
        missing.get(textHash).indices.push(i);
      }
    }
    const pending = [...missing.values()];
    while (pending.length) {
      const part = [];
      let chars = 0;
      while (pending.length && part.length < batch && (chars + pending[0].text.length <= maxBatchChars)) {
        const entry = pending.shift();
        chars += entry.text.length;
        part.push(entry);
      }
      if (!part.length) throw new Error('one input exceeds maxBatchChars; refusing silent truncation');
      if (stats.calls >= maxCalls) throw new Error('embedding request ceiling reached; resume from cache');
      const start = performance.now();
      stats.calls++;
      const row = { date: new Date().toISOString(), identityHash, textHashes: part.map((e) => e.textHash) };
      const beforeUsage = { ...usage?.() };
      const batchUsage = () => usage ? Object.fromEntries([
        'requests', 'failures', 'reportedTokens', 'tokenReports', 'reportedCost', 'costReports',
      ].map((key) => [key, (usage()[key] ?? 0) - (beforeUsage[key] ?? 0)])) : null;
      try {
        const vectors = await embedder.embed(part.map((e) => e.text));
        if (embedder.model !== bound.model || embedder.dims !== bound.dims) throw new Error('embedder identity changed during batch');
        if (!Array.isArray(vectors) || vectors.length !== part.length) throw new Error('embedding count mismatch');
        // Validate the entire batch before committing any row.
        const verified = vectors.map((v) => verifiedVector(v, bound.dims));
        for (let j = 0; j < part.length; j++) {
          const entry = part[j], vector = verified[j];
          const data = { identityHash, textHash: entry.textHash, vectorHash: sha256(JSON.stringify(vector)), vector };
          const path = join(directory, `${entry.textHash}.json`), temp = `${path}.${process.pid}.tmp`;
          writeFileSync(temp, JSON.stringify(data));
          renameSync(temp, path);
          for (const i of entry.indices) out[i] = new Float32Array(vector);
          stats.embedded++;
        }
        journal({ ...row, outcome: 'ok', ms: performance.now() - start, usage: batchUsage() });
      }
      catch (error) {
        // Provider messages may contain keys, URLs, prompts or response text.
        const failure = { ...row, outcome: 'failed', code: typeof error?.code === 'string' && /^AI\d{4}$/.test(error.code) ? error.code : 'EMBED_FAILED',
          status: Number.isInteger(error?.status) ? error.status : null, ms: performance.now() - start, usage: batchUsage() };
        stats.failures.push(failure);
        journal(failure);
        throw new Error(`embedding batch failed (${failure.code}); verified earlier batches retained`);
      }
      finally { stats.wallMs += performance.now() - start; }
    }
    return out;
  }
  return { embed, model: bound.model, dims: bound.dims, identity: bound, stats,
    history: () => existsSync(journalPath) ? readFileSync(journalPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [] };
}

/** Observe reported usage without recording request bodies, endpoints or errors.
 * @param {typeof fetch} [fetchFn] */
export function meteredFetch(fetchFn = globalThis.fetch) {
  const usage = { requests: 0, failures: 0, reportedTokens: 0, tokenReports: 0, reportedCost: 0, costReports: 0 };
  return { usage, fetch: async (url, init) => {
    usage.requests++;
    try {
      const response = await fetchFn(url, init);
      if (!response.ok) usage.failures++;
      try {
        const payload = await response.clone().json();
        const tokens = payload.usage?.total_tokens ?? payload.usage?.prompt_tokens;
        const cost = payload.usage?.cost;
        if (Number.isFinite(tokens) && tokens >= 0) { usage.reportedTokens += tokens; usage.tokenReports++; }
        if (Number.isFinite(cost) && cost >= 0) { usage.reportedCost += cost; usage.costReports++; }
      }
      catch { /* A malformed body is diagnosed by the production client. */ }
      return response;
    }
    catch (error) { usage.failures++; throw error; }
  } };
}
