//@ts-check
/** Offline retrieval instrument. Hosts supply their corpus, vectors and judged queries. */
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { compileLexical, reciprocalRankFusion, weightedScoreFusion } from '@jarenjs/core/search';
import { cosineSimilarity } from '@jarenjs/core/vector';
import { pairedBootstrap, permutationTest } from '@jarenjs/core/stats';
import { compareCodePoints } from '@jarenjs/core/string';
import { createProviderExecutor } from '@jarenjs/contract/provider';

/** One unit is one judged query; fusion preserves each lane's evidence.
 * This evaluates a supplied workload, not a claim about an embedding model.
 * @param {{ documents: {id: string, text: string, vector: number[]}[],
 * queries: {text: string, vector: number[], relevant: string[]}[], take?: number }} input */
export async function measureHybridRetrieval(input) {
  const take = input.take ?? 10;
  if (!Number.isSafeInteger(take) || take < 1 || take > 1000 || !input.queries.length || input.queries.length > 10000
    || input.documents.length > 100000 || input.queries.some(query => !query.relevant.length)) throw new RangeError('bounded documents, judged queries and take required');
  const cache = new Map(); let transportCalls = 0;
  const provider = createProviderExecutor({ cache, cacheScope: 'hybrid-instrument/corpus-v1',
    maxBytes: 16 * 1024 * 1024, transport: async () => { transportCalls++; return new Response(JSON.stringify(input.documents)); } });
  const request = { url: 'https://fixture.invalid/corpus', safety: /** @type {const} */ ('safe-read') };
  const compiled = compileLexical({ version: 1, fields: ['text'], limits: { maxResults: 1000 } }), index = compiled.create();
  try {
    const captured = await provider.execute(request), replayed = await provider.execute(request);
    if (captured.state !== 'ok' || replayed.state !== 'ok' || !replayed.replayed || transportCalls !== 1) throw new Error('corpus capture/replay failed');
    const documents = JSON.parse(replayed.text), built = index.rebuild(documents);
    if (built.state !== 'complete') throw new Error(JSON.stringify(built));
    const queries = input.queries.map(query => {
      const answer = index.search(query.text);
      if (answer.state !== 'complete') throw new Error(JSON.stringify(answer));
      const lexical = answer.hits.slice(0, take);
      const vector = documents.map(row => ({ id: row.id, score: cosineSimilarity(query.vector, row.vector) }))
        .sort((a, b) => b.score - a.score || compareCodePoints(a.id, b.id)).slice(0, take);
      const lanes = [lexical, vector];
      const rrf = reciprocalRankFusion(lanes.map(lane => lane.map((row, i) => ({ id: row.id, rank: i + 1 })))).slice(0, take);
      const weighted = weightedScoreFusion(lanes, { weights: [0.5, 0.5], normalize: 'minmax' }).slice(0, take);
      const relevant = new Set(query.relevant), recall = hits => hits.filter(hit => relevant.has(hit.id)).length / relevant.size;
      return { query: query.text, lexical, vector, rrf, weighted,
        recall: { lexical: recall(lexical), vector: recall(vector), rrf: recall(rrf), weighted: recall(weighted) } };
    });
    const options = { seed: 20260916, resamples: 1000 };
    const comparisons = Object.fromEntries(['rrf', 'weighted'].map(lane => {
      const pairs = queries.map(query => [query.recall.lexical, query.recall[lane]]);
      return [lane, { interval: pairedBootstrap(pairs, options), permutation: permutationTest(pairs, options) }];
    }));
    return { format: 'hybrid-retrieval/1', unit: 'judged-query', metric: `recall@${take}`, difference: 'fusion minus lexical',
      replay: { transportCalls, replayed: true }, queries, comparisons };
  }
  finally { index.dispose(); await provider.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await measureHybridRetrieval(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  const output = JSON.stringify(report, null, 2) + '\n';
  if (process.argv[3]) writeFileSync(process.argv[3], output); else process.stdout.write(output);
}
