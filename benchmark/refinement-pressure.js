#!/usr/bin/env node
//@ts-check
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHashEmbedder, createChatClient } from '@jarenjs/ai';
import { configureLiveEmbeddings } from './lib/relevance-live.js';
import { readAiEnv } from './lib/env.js';
import { pressureFixture, runPressure } from './lib/refinement-pressure.js';
import { sha256 } from './lib/relevance.js';

/** Optional pressure runner: live embeddings and unlabelled live generation are separate.
 * @param {string[]} [argv] */
export async function main(argv = process.argv.slice(2)) {
  const { values: flags } = parseArgs({ args: argv, options: {
    live: { type: 'boolean', default: false }, 'live-proposals': { type: 'boolean', default: false },
    directory: { type: 'string' }, cache: { type: 'string', default: 'benchmark/cache/recall-quality/pressure-vectors' },
    filepath: { type: 'string' }, dims: { type: 'string' }, policies: { type: 'string' },
  } });
  if (!flags.directory) throw new Error('--directory must name a new run directory');
  mkdirSync(flags.directory, { recursive: true });
  const fixture = pressureFixture();
  const live = flags.live ? configureLiveEmbeddings({ datasetHash: sha256(JSON.stringify(fixture)),
    directory: flags.cache, dims: Number(flags.dims), textPolicy: 'pressure-text-and-lossless-merges-v1' }) : null;
  const embedder = live?.embedder ?? createHashEmbedder({ dims: Number(flags.dims ?? 64) });
  let liveClient;
  const env = readAiEnv();
  let generationCalls = 0;
  if (flags['live-proposals']) {
    if (!env.live || env.maxCalls < fixture.waves.length) throw new Error('live proposals need configured chat and a sufficient request ceiling');
    const client = createChatClient({ provider: env.provider, baseUrl: env.baseUrl, model: env.model, apiKey: env.apiKey,
      retry: { attempts: 1 }, timeoutMs: 60000 });
    liveClient = { endpoint: client.endpoint, complete: (request) => {
      if (generationCalls >= env.maxCalls) throw new Error('generation request ceiling reached');
      generationCalls++;
      return client.complete(request);
    } };
  }
  let result;
  try { result = await runPressure({ fixture, embedder, directory: flags.directory,
    policies: liveClient ? ['none'] : flags.policies?.split(','), liveClient, embeddingClass: flags.live ? 'live' : 'hash' }); }
  catch (error) {
    if (flags.filepath) writeFileSync(flags.filepath, JSON.stringify({ schemaVersion: 1, status: 'failed',
      instrument: 'refinement-pressure', live: live?.report(),
      ...(liveClient ? { generation: { provider: env.provider, model: env.model, calls: generationCalls, labelled: false } } : {}),
      error: 'pressure run failed; previous batches retained' }, null, 2) + '\n');
    throw error;
  }
  if (live) result.live = live.report();
  if (liveClient) result.generation = { ...result.generation, calls: generationCalls, maxCalls: env.maxCalls,
    retryAttempts: 1, timeoutMs: 60000 };
  if (flags.filepath) writeFileSync(flags.filepath, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result.results.map((r) => ({ policy: r.policy, pass: r.decision?.pass,
    records: r.waves.at(-1).records, recall10: r.waves.at(-1).recall?.[10], checks: r.decision?.checks }))));
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
