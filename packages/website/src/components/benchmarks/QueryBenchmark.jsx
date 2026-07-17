import { useMemo } from 'react';
import { useBenchmarkFile } from '@hooks/useBenchmarkData';
import { formatRatio } from '@lib/utils';
import { StatCard, MethodologyCard, BenchmarkFallback } from './shared';
import { ScenarioMatrix, CompileCard } from './ScenarioMatrix';

function QueryBenchmark() {
  const { data, loading } = useBenchmarkFile('jsonquery');

  const engineMeta = useMemo(() => {
    if (!data) return [];
    const label = (key, fallback) => data.engines.find((n) => n.toLowerCase().includes(key)) ?? fallback;
    return [
      { key: 'jaren', label: 'Jaren JSON Query', sourceLabel: 'Jaren query document (JSON)', sourceLanguage: 'json' },
      { key: 'fontoxpath', label: label('fontoxpath', 'fontoxpath'), sourceLabel: 'fontoxpath (XQuery 3.1 text)' },
      { key: 'jsonata', label: label('jsonata', 'jsonata'), sourceLabel: 'JSONata expression' },
    ];
  }, [data]);

  const headline = useMemo(() => {
    if (!data) return null;
    const ranges = { fontoxpath: [], jsonata: [] };
    for (const row of data.rows) {
      const jaren = row.engines.jaren;
      if (jaren == null) continue;
      for (const key of ['fontoxpath', 'jsonata']) {
        const ns = row.engines[key];
        if (ns != null) ranges[key].push(ns / jaren);
      }
    }
    const span = (list) => list.length === 0 ? null : [Math.min(...list), Math.max(...list)];
    return { fontoxpath: span(ranges.fontoxpath), jsonata: span(ranges.jsonata) };
  }, [data]);

  if (!data) return <BenchmarkFallback loading={loading} name="jsonquery" />;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="vs fontoxpath (XQuery 3.1)"
          value={headline.fontoxpath ? `${formatRatio(headline.fontoxpath[0])}–${formatRatio(headline.fontoxpath[1])}` : '—'}
          sub="faster, across all scenarios & sizes"
          tone="good"
        />
        <StatCard
          label="vs JSONata"
          value={headline.jsonata ? `${formatRatio(headline.jsonata[0])}–${formatRatio(headline.jsonata[1])}` : '—'}
          sub="faster, across all scenarios & sizes"
          tone="good"
        />
        <StatCard
          label="Semantics"
          value="XQuery 3.1"
          sub="FLWOR, joins, grouping, quantifiers — as JSON documents"
        />
        <StatCard
          label="Result equivalence"
          value="asserted"
          sub="every engine must produce the same result before timing"
        />
      </div>

      <ScenarioMatrix
        data={data}
        engineMeta={engineMeta}
        naNote={{ fontoxpath: 'fontoxpath does not implement the XQuery group by clause' }}
      />

      <CompileCard
        compile={data.compile}
        engineMeta={engineMeta}
        note="Jaren compiles from JSON text (JSON.parse included, since the competitors parse text). fontoxpath has no compile-only API — its number is fresh-source evaluation minus a fully-cached second pass on a tiny document; JSONata's is jsonata(source)."
      />

      <MethodologyCard>
        <p>
          The same bookstore family at 4 / 1,000 / 10,000 books, expressed idiomatically per engine: Jaren runs the
          query documents from the QUERY-FORMAT spec (appendix A where one exists), fontoxpath the equivalent XQuery 3.1
          text, JSONata its own expression language. Open <em>“the programs”</em> on any scenario to read all three.
        </p>
        <p>
          Fairness: fontoxpath gets its document <strong>pre-converted to XDM once</strong> outside the timed loop
          (~12 ms/call at 10k books otherwise — the gap would be absurd with it included); JSONata&apos;s async{' '}
          <code className="bg-muted px-1 rounded">evaluate()</code> is awaited in the timed loop (its API&apos;s own cost);
          the join is capped at 1,000 books because it is a naive O(n·m) nested loop in <em>all three</em> engines.
          Iterations adapt per cell (~50 ms floor, ~0.5 s budget).
        </p>
        <p>
          Reproduce: <code className="bg-muted px-1 rounded">npm run benchmark:jsonquery:profile</code>
        </p>
      </MethodologyCard>
    </div>
  );
}

export { QueryBenchmark };
