import { useMemo } from 'react';
import { useBenchmarkFile } from '@hooks/useBenchmarkData';
import { formatNs, formatRatio } from '@lib/utils';
import { StatCard, MethodologyCard, BenchmarkFallback } from './shared';
import { ScenarioMatrix, CompileCard } from './ScenarioMatrix';

function JsltBenchmark() {
  const { data, loading } = useBenchmarkFile('jslt');

  const engineMeta = useMemo(() => {
    if (!data) return [];
    const label = (key, fallback) => data.engines.find((n) => n.toLowerCase().includes(key)) ?? fallback;
    return [
      { key: 'jaren', label: 'Jaren JSLT', sourceLabel: 'JSLT stylesheet (JSON)', sourceLanguage: 'json' },
      { key: 'native', label: label('native', 'hand-written JS'), sourceLabel: 'Hand-written JavaScript (per scenario)' },
      { key: 'jsonata', label: label('jsonata', 'jsonata'), sourceLabel: 'JSONata transform expression' },
    ];
  }, [data]);

  const headline = useMemo(() => {
    if (!data) return null;
    const identity = data.rows.filter((row) => row.scenario === 'identity');
    const identityNs = identity.map((row) => row.engines.jaren).filter((ns) => ns != null);
    const identityBiggest = identity[identity.length - 1];
    const jsonataRatios = [];
    for (const row of data.rows) {
      if (row.scenario === 'identity') continue;
      const jaren = row.engines.jaren;
      const jsonata = row.engines.jsonata;
      if (jaren != null && jsonata != null) jsonataRatios.push(jsonata / jaren);
    }
    return {
      identityRange: identityNs.length > 0 ? [Math.min(...identityNs), Math.max(...identityNs)] : null,
      identityBiggest,
      jsonataSpan: jsonataRatios.length > 0 ? [Math.min(...jsonataRatios), Math.max(...jsonataRatios)] : null,
    };
  }, [data]);

  if (!data) return <BenchmarkFallback loading={loading} name="jslt" />;

  const bigIdentity = headline.identityBiggest;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Identity transform"
          value={headline.identityRange ? `${formatNs(headline.identityRange[0])}–${formatNs(headline.identityRange[1])}` : '—'}
          sub="any document size — returns the input reference"
          tone="good"
        />
        <StatCard
          label="Identity at 10,000 books"
          value={bigIdentity ? formatNs(bigIdentity.engines.jaren) : '—'}
          sub={bigIdentity ? `native deep-copy: ${formatNs(bigIdentity.engines.native)} · JSONata: ${formatNs(bigIdentity.engines.jsonata)}` : ''}
          tone="good"
        />
        <StatCard
          label="vs JSONata transforms"
          value={headline.jsonataSpan ? `${formatRatio(headline.jsonataSpan[0])}–${formatRatio(headline.jsonataSpan[1])}` : '—'}
          sub="faster on every expressible transformation"
          tone="good"
        />
        <StatCard
          label="vs hand-written JS"
          value="slower"
          sub="bespoke code wins raw transforms — the honest abstraction cost (see notes)"
        />
      </div>

      <ScenarioMatrix
        data={data}
        engineMeta={engineMeta}
        naNote={{ jsonata: "JSONata's transform operator has no recursive ranked template modes" }}
      />

      <CompileCard
        compile={data.compile}
        engineMeta={engineMeta}
        note="Jaren compiles from JSON text (JSON.parse included) and, for the annotation scenario, compiles a real JSON Schema predicate; JSONata compiles its expression text. Hand-written JS has nothing to compile."
      />

      <MethodologyCard>
        <p>
          JSLT is the stylesheet layer: JSONPath matches <em>position</em>, JSON Schema matches <em>shape</em>, query
          documents produce output — XSLT&apos;s recursive template dispatch for JSON. The proof-of-no-change sharing is the
          headline: an identity transform <strong>returns the input reference</strong> instead of copying 10,000 objects,
          and a surgical update shares every subtree off the matched spine.
        </p>
        <p>
          The comparison is deliberately honest in both directions: hand-written per-scenario JavaScript{' '}
          <strong>wins every actual transformation</strong> (it knows the exact layout and pays for no matching,
          no mode tables, no schema predicates) — that gap is the measured price of the abstraction. Against JSONata&apos;s
          transform operator — a generic engine like Jaren — JSLT is faster on every expressible scenario.
        </p>
        <p>
          Reproduce: <code className="bg-muted px-1 rounded">npm run benchmark:jslt:profile</code>
        </p>
      </MethodologyCard>
    </div>
  );
}

export { JsltBenchmark };
