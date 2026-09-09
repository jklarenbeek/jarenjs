//@ts-check
/** Shared live setup and provenance for both relevance instruments. */
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createEmbeddingClient } from '@jarenjs/ai';
import { readAiEnv } from './env.js';
import { createRelevanceCache, meteredFetch } from './relevance-cache.js';
import { sha256 } from './relevance.js';

/** Configure explicit live embedding calls, preserving the repository request ceiling.
 * @param {{datasetHash: string, directory: string, dims: number, batch?: number, textPolicy?: string}} config */
export function configureLiveEmbeddings({ datasetHash, directory, dims, batch = 64, textPolicy }) {
  const env = readAiEnv();
  const model = process.env.EMBEDDING_MODEL?.trim() || env.embedModel;
  if (!model || (!env.apiKey && !['ollama', 'lmstudio'].includes(env.provider)))
    throw new Error('live embeddings need provider credentials and EMBEDDING_MODEL or JAREN_AI_EMBED_MODEL');
  if (!Number.isSafeInteger(dims) || dims < 1) throw new Error('--dims must pin the live model width');
  const meter = meteredFetch();
  const wire = createEmbeddingClient({ provider: env.provider, baseUrl: env.baseUrl, model, apiKey: env.apiKey,
    dims, retry: { attempts: 1 }, timeoutMs: 60000, fetch: meter.fetch });
  const cache = createRelevanceCache({ directory, embedder: wire, batch, maxCalls: env.maxCalls,
    usage: () => meter.usage,
    identity: { provider: env.provider, model, dims, datasetHash,
      ...(textPolicy ? { textPolicy } : {}), endpointHash: sha256(env.baseUrl ?? `provider:${env.provider}`) } });
  const runId = randomUUID(), start = performance.now();
  return { embedder: cache,
    report: () => {
      const path = join(directory, 'usage.json');
      const history = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
      if (meter.usage.requests) {
        const row = { runId, date: new Date().toISOString(), ...meter.usage };
        const index = history.findIndex((entry) => entry.runId === runId);
        if (index < 0) history.push(row); else history[index] = row;
        writeFileSync(path, JSON.stringify(history, null, 2) + '\n');
      }
      const batches = cache.history();
      return { identity: cache.identity, batch, maxBatchChars: 100000, maxCalls: env.maxCalls,
        cache: cache.stats, batches, usage: history, wallMs: performance.now() - start,
        unmeteredHistoricalRequests: Math.max(0, batches.length - history.reduce((sum, row) => sum + row.requests, 0)),
        costNote: 'Reported tokens/cost only; missing reports and unmetered historical requests have unknown cost.' };
    },
  };
}
