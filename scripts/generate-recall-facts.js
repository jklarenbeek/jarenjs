//@ts-check
import { readFileSync } from 'node:fs';
const read = (name) => JSON.parse(readFileSync(new URL(`../benchmark/recall-quality-${name}.json`, import.meta.url), 'utf8'));
const fmt = (value) => value === null || value === undefined ? '—' : value.toFixed(3);
const table = (head, rows) => '\n\n' + [head, head.replace(/[^|]/g, '-'), ...rows].join('\n') + '\n\n';
/** Measured retrieval facts share the standard document derivation registry. */
export const recallFacts = {
  name: 'recall quality measurements',
  docs: () => ['packages/ai/README.md', 'packages/db/README.md', 'benchmark/README.md'],
  facts: () => ({
    'recall.quality': () => table('| documents | policy | recall@10 | MRR@10 | nDCG@10 | p95 ms |',
      read('scifact-live').rows.map((r) => `| ${r.size} | ${r.policy} | ${fmt(r.recall[10])} | ${fmt(r.mrr)} | ${fmt(r.ndcg10)} | ${fmt(r.latencyMs.p95)} |`)),
    'recall.reference': () => {
      const data = read('scifact-live'), row = data.rows.find((r) => r.size === data.dataset.documents && r.policy === 'exact');
      return `${data.embedding.model} (${data.embedding.dims} dimensions, ${data.live.identity.provider}, ${data.date.slice(0, 10)}): recall@10 ${fmt(row.recall[10])}, MRR@10 ${fmt(row.mrr)}, nDCG@10 ${fmt(row.ndcg10)} on ${data.dataset.documents} SciFact documents and ${data.dataset.queries} test queries.`;
    },
    'recall.ann': () => table('| documents | candidates | exact-top-10 recall | index bytes | build ms | update p95 ms | delete ms | clears all bars |',
      read('scifact-live').rows.filter((r) => r.oracle).map((r) => `| ${r.size} | ${r.policy} | ${fmt(r.oracle.recall[10])} | ${r.storage.indexBytes} | ${fmt(r.buildMs)} | ${fmt(r.lifecycle.updateP95Ms)} | ${fmt(r.lifecycle.deleteMs)} | ${r.decision.pass ? 'yes' : 'no'} |`)),
    'recall.annDecision': () => {
      const data = read('scifact-live'), rows = data.rows.filter((r) => r.oracle);
      return `${rows.filter((r) => r.decision.pass).length}/${rows.length} contender rows cleared all bars; retain exact. Required exact-top-10 recall ≥ ${data.bars.exactRecall10}, p95 speedup ≥ ${data.bars.p95Speedup}×, and a measured exact p95 ≥ ${data.bars.minimumExactP95Ms} ms. The largest reference corpus contains ${data.dataset.documents} documents; scale beyond it remains unmeasured.`;
    },
    'recall.pressure': () => table('| vectors | policy | records | duplicates | state bytes | recall@10 | MRR@10 | novel-evidence nDCG@10 | conflict / complement retained | passes every wave |',
      ['pressure-hash', 'pressure-live'].flatMap((file) => {
        const data = read(file);
        return data.results.map((r) => {
          const last = r.waves.at(-1);
          return `| ${data.embedding.model} | ${r.policy} | ${last.records} | ${last.duplicates} | ${last.bytes} | ${fmt(last.recall[10])} | ${fmt(last.mrr)} | ${fmt(last.ndcg10)} | ${fmt(last.conflictRetention)} / ${fmt(last.complementRetention)} | ${r.decision.pass ? 'yes' : 'no'} |`;
        });
      })),
    'recall.dedup': () => {
      const data = read('pressure-live'), baseline = data.results.find((r) => r.policy === 'none').waves.at(-1), runtime = data.results.find((r) => r.policy === 'runtime-exact-evidence').waves.at(-1);
      return `After ${data.config.waves} labelled waves, opt-in exact-evidence suppression stores ${runtime.records} records instead of ${baseline.records}; state bytes fall ${(100 * (1 - runtime.bytes / baseline.bytes)).toFixed(1)}%. Evidence recall@10 is ${fmt(runtime.recall[10])} versus ${fmt(baseline.recall[10])}, with all labelled conflict and complement units retained. Proposals are scripted; vectors are ${data.embedding.model}.`;
    },
    'recall.cost': () => {
      const rows = read('scifact-live').live.usage;
      const sum = (key) => rows.reduce((n, row) => n + row[key], 0);
      return `${sum('requests')} embedding requests, ${sum('failures')} failures, ${sum('reportedTokens').toLocaleString('en-US')} reported tokens, and $${sum('reportedCost').toFixed(8)} reported cost for the SciFact vector cache. Cache-only scoring makes no embedding requests.`;
    },
  }),
};
