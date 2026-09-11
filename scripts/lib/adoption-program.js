//@ts-check
/** Compare the frozen budgets without confusing focused and combined workloads. */
import { assessBudget, replacementReady } from '../../test/adoption/evidence.js';

/** Final evidence is derived from committed measurements, never from a successful unrelated gate.
 * @param {any} manifest @param {Record<string, any>} reports */
export function summarizeAdoption(manifest, reports) {
  for (const [name, report] of Object.entries(reports)) {
    if (report.freezeHash !== manifest.freezeHash) throw new Error(`${name}: fixture freeze mismatch`);
  }
  const consumer = (name, id) => {
    const row = reports[name]?.consumers?.find((row) => row.consumer === id);
    if (!row) throw new Error(`${name}: missing consumer ${id}`);
    return row;
  };
  const combined = reports['adoption-journey'];
  const budgets = manifest.consumers.flatMap((definition) => {
    const id = definition.id, reference = consumer('adoption', id);
    const focused = {
      relational: { source: 'relational', values: consumer('relational', id).final },
      search: { source: 'lexical', values: consumer('lexical', id).native.metrics.search },
      grid: { source: 'collection', values: consumer('collection', id).metrics.grid },
      formulas: { source: 'formula', values: { ...consumer('formula', id), originalByteChanges: reports.formula.sources.originalByteChanges } },
      providers: { source: 'providers', values: { ...consumer('providers', id).native, pages: consumer('providers', id).native.requests } },
    };
    const hosts = ['node', 'bun'].map((label) => {
      const host = combined.hosts.find((host) => host.label === label);
      const row = host?.results.find((row) => row.consumer === id && row.phase === 'all');
      if (!row || row.rows !== definition.rows) throw new Error(`${label}: missing consumer workload ${id}`);
      return { host: label, values: {
        search: { startupMs: row.searchMs },
        providers: { unresolvedResends: host.recoverySends },
        resources: { sampledHeapBytes: row.heapBytes, peakRssBytes: row.peakRssBytes, teardownMs: row.teardownMs },
      } };
    });
    return Object.entries(definition.budgets).flatMap(([stage, limits]) => Object.entries(limits).map(([metric, limit]) => ({
      consumer: id, stage, metric, limit,
      reference: assessBudget({ [metric]: limit }, reference.metrics[stage] ?? {})[0],
      focused: { source: focused[stage]?.source ?? null, ...assessBudget({ [metric]: limit }, focused[stage]?.values ?? {})[0] },
      combined: hosts.map(({ host, values }) => ({ host, ...assessBudget({ [metric]: limit }, values[stage] ?? {})[0] })),
    })));
  });
  // Synthetic runs cannot supply real downstream or manual acceptance. The
  // executable report qualifies Linux only; liveHost is the whole required set.
  const evidence = { library: combined.evidence.library, portableConsumer: combined.evidence.portable,
    liveHost: 'pending', manualOperator: 'pending' };
  const replacements = ['Domain SQL/private driver bridge', 'Virtualizer', 'Lexical search', 'Trusted formulas/rules', 'Provider adapters/domain ledgers']
    .map((mechanism) => ({ mechanism, ...evidence, retirement: replacementReady(evidence) ? 'ready' : 'pending' }));
  return { format: 'jaren-adoption-program/1', freezeHash: manifest.freezeHash,
    program: evidence.library === 'pass' ? 'library-ready; adoption-pending' : 'library-pending; adoption-pending',
    replacements, budgets };
}
