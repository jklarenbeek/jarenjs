import { useMemo } from 'react';
import PropTypes from 'prop-types';
import { Card, CardContent, CardHeader, CardTitle } from '@components/ui/card';
import { Badge } from '@components/ui/badge';
import { useBenchmarkFile } from '@hooks/useBenchmarkData';
import { formatNs, formatRatio } from '@lib/utils';
import { BenchmarkFallback } from './shared';
import { ArrowRight, CheckCircle2, ShieldCheck, XCircle } from 'lucide-react';

const DRAFT_NAMES = {
  draft7: 'Draft 07',
  'draft2019-09': 'Draft 2019-09',
  'draft2020-12': 'Draft 2020-12',
};

/**
 * The whole toolchain at a glance: conformance first (the invariant),
 * then one headline speed number per engine, each linking to its
 * drill-down tab.
 */
function OverviewTab({ onSelect }) {
  const { data: meta, loading } = useBenchmarkFile('meta');
  const { data: validate } = useBenchmarkFile('validate');
  const { data: jsonpath } = useBenchmarkFile('jsonpath');
  const { data: jsonquery } = useBenchmarkFile('jsonquery');
  const { data: jslt } = useBenchmarkFile('jslt');
  const { data: jsonpointer } = useBenchmarkFile('jsonpointer');
  const { data: jsonpatch } = useBenchmarkFile('jsonpatch');
  const { data: toml } = useBenchmarkFile('toml');

  const suiteCards = useMemo(() => {
    const cards = [];

    if (validate) {
      const success = validate.results.filter((r) => r.isSuccessTest && r.ratio != null);
      const wins = success.filter((r) => r.ratio > 1).length;
      cards.push({
        key: 'validate',
        title: 'JSON Schema validation',
        rival: 'vs Ajv',
        headline: `faster on ${wins} of ${success.length}`,
        sub: 'test cases both engines pass, across all three drafts',
      });
    }
    if (jsonpath) {
      const rows = jsonpath.profile.rows.filter((r) => r.engines.jaren != null && r.engines['json-p3'] != null);
      const mean = rows.reduce((s, r) => s + r.engines['json-p3'], 0) / rows.reduce((s, r) => s + r.engines.jaren, 0);
      cards.push({
        key: 'jsonpath',
        title: 'JSONPath (RFC 9535)',
        rival: 'vs json-p3',
        headline: `${formatRatio(mean)} faster`,
        sub: `mean over ${rows.length} compliance-suite queries`,
      });
    }
    if (jsonquery) {
      const ratios = [];
      for (const row of jsonquery.rows) {
        if (row.engines.jaren == null) continue;
        for (const key of ['fontoxpath', 'jsonata']) {
          if (row.engines[key] != null) ratios.push(row.engines[key] / row.engines.jaren);
        }
      }
      cards.push({
        key: 'jsonquery',
        title: 'Jaren JSON Query (XQuery 3.1 semantics)',
        rival: 'vs fontoxpath & JSONata',
        headline: `${formatRatio(Math.min(...ratios))}–${formatRatio(Math.max(...ratios))} faster`,
        sub: 'filter, join, group, reshape at 4 → 10,000 books',
      });
    }
    if (jslt) {
      const identity = jslt.rows.filter((r) => r.scenario === 'identity' && r.engines.jaren != null);
      const max = identity[identity.length - 1];
      cards.push({
        key: 'jslt',
        title: 'JSLT stylesheets',
        rival: 'vs native JS & JSONata',
        headline: `identity in ${formatNs(max?.engines.jaren)}`,
        sub: 'returns the input reference at any size; rivals deep-copy in milliseconds',
      });
    }
    if (jsonpointer) {
      const speedups = jsonpointer.tables.flatMap((t) => t.rows
        .filter((r) => r.results[0] != null && r.results[1] != null)
        .map((r) => r.results[1] / r.results[0]));
      cards.push({
        key: 'jsonpointer',
        title: 'JSON Pointer (RFC 6901)',
        rival: 'vs interpretive resolver & jsonpointer npm',
        headline: `${formatRatio(Math.min(...speedups))}–${formatRatio(Math.max(...speedups))} faster`,
        sub: 'compiled getters on the $data hot path',
      });
    }
    if (jsonpatch) {
      const speedups = jsonpatch.tables
        .filter((t) => t.columns.length > 1)
        .flatMap((t) => t.rows
          .filter((r) => r.results[0] != null && r.results[r.results.length - 1] != null)
          .map((r) => r.results[r.results.length - 1] / r.results[0]));
      cards.push({
        key: 'jsonpatch',
        title: 'JSON Patch & Merge Patch (RFC 6902/7396)',
        rival: 'vs naive clone-and-interpret',
        headline: `${formatRatio(Math.min(...speedups))}–${formatRatio(Math.max(...speedups))} faster`,
        sub: 'copy-on-write appliers: clone the written spine once, share the rest',
      });
    }
    if (toml?.compliance?.jaren) {
      cards.push({
        key: 'toml',
        title: 'JOSL / strict TOML (research)',
        rival: 'vs smol-toml, @iarna/toml & toml',
        headline: `${toml.compliance.jaren.pass}/${toml.compliance.jaren.total} compliant`,
        sub: 'the only engine passing all of toml-test 1.0.0 — and the only streaming one',
      });
    }
    return cards;
  }, [validate, jsonpath, jsonquery, jslt, jsonpointer, jsonpatch, toml]);

  if (!meta) return <BenchmarkFallback loading={loading} name="meta" />;

  const stats = meta.conformance?.jsonSchema?.engineStats;
  const cts = meta.conformance?.jsonpath;
  const patchConformance = meta.conformance?.jsonPatch;

  return (
    <div className="space-y-6">
      {/* Conformance first — correctness is the precondition for any speed claim */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck className="h-5 w-5 text-[var(--viz-faster)]" />
            Conformance — checked before a single nanosecond is measured
          </CardTitle>
        </CardHeader>
        <CardContent className={`grid md:grid-cols-2 gap-4 ${patchConformance ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}>
          <div className="rounded-lg border p-4">
            <p className="text-sm font-semibold mb-2">Official JSON-Schema-Test-Suite</p>
            {stats && Object.entries(stats.jaren).map(([draft, s]) => (
              <div key={draft} className="flex items-center justify-between text-sm py-0.5">
                <span className="text-muted-foreground">{DRAFT_NAMES[draft] ?? draft}</span>
                <span className="font-mono tabular-nums inline-flex items-center gap-1">
                  <CheckCircle2 className="h-3.5 w-3.5 text-[var(--viz-faster)]" />
                  {s.passed}/{s.passed + s.failed + s.errors}
                </span>
              </div>
            ))}
            {stats && (
              <p className="text-xs text-muted-foreground mt-2 flex items-start gap-1">
                <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0 text-[var(--viz-slower)]" />
                Ajv on the same runs: {Object.values(stats.ajv).map((s) => `${s.failed + s.errors}`).join(' / ')} failed or errored per draft
              </p>
            )}
          </div>

          <div className="rounded-lg border p-4">
            <p className="text-sm font-semibold mb-2">JSONPath Compliance Test Suite</p>
            {cts && (
              <p className="text-3xl font-bold font-mono">{cts.pass?.jaren}/{cts.total}</p>
            )}
            <p className="text-xs text-muted-foreground mt-2">
              RFC 9535, normalized paths included. json-p3 passes {cts?.pass?.['json-p3']}/{cts?.total} too — the speed
              comparison is between two fully compliant engines.
            </p>
          </div>

          {patchConformance && (
            <div className="rounded-lg border p-4">
              <p className="text-sm font-semibold mb-2">json-patch-tests (RFC 6902)</p>
              <p className="text-3xl font-bold font-mono">{patchConformance.pass}/{patchConformance.total}</p>
              <p className="text-xs text-muted-foreground mt-2">
                The official JSON Patch vectors — spec examples and community edge cases — replayed through the
                copy-on-write applier before it is timed.
              </p>
            </div>
          )}

          <div className="rounded-lg border p-4">
            <p className="text-sm font-semibold mb-2">W3C QT3 (XQuery/XPath 3.1)</p>
            {meta.qt3 ? (
              <>
                <p className="text-3xl font-bold font-mono">{meta.qt3.regressions === 0 ? '0' : meta.qt3.regressions}</p>
                <p className="text-xs text-muted-foreground">unattributed failures across {meta.qt3.total.toLocaleString()} cases</p>
                <p className="text-xs text-muted-foreground mt-2">
                  {meta.qt3.pass.toLocaleString()} pass through the XQuery text front-end · {meta.qt3.unsupportedSyntax.toLocaleString()} honestly
                  classified outside the text subset · {meta.qt3.failByDesign} attributed to documented deviations
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Scorecard not generated in this run.</p>
            )}
          </div>
        </CardContent>
      </Card>

      {/* One headline per engine */}
      <div className="grid sm:grid-cols-2 gap-4">
        {suiteCards.map((card) => (
          <button
            key={card.key}
            onClick={() => onSelect(card.key)}
            className="text-left rounded-xl border bg-card p-5 hover:border-primary/50 hover:shadow-sm transition-all group"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="font-semibold">{card.title}</p>
              <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-primary group-hover:translate-x-0.5 transition-all" />
            </div>
            <p className="text-2xl font-bold text-[var(--viz-faster)] mt-2">{card.headline}</p>
            <p className="text-sm text-muted-foreground mt-1">{card.sub}</p>
            <Badge variant="outline" className="mt-3 text-xs">{card.rival}</Badge>
          </button>
        ))}
      </div>

      <p className="text-sm text-muted-foreground">
        Every number on these pages is reproducible from the repository&apos;s{' '}
        <a
          className="underline"
          href="https://github.com/jklarenbeek/jarenjs/tree/main/benchmark"
          target="_blank"
          rel="noopener noreferrer"
        >
          benchmark workspace
        </a>
        , which documents each tool, suite and fairness decision. Micro-timings vary roughly ±10% run to run; conformance
        counts are the invariant. Click a card — or a tab above — to drill into every individual test.
      </p>
    </div>
  );
}

OverviewTab.propTypes = {
  onSelect: PropTypes.func.isRequired,
};

export { OverviewTab };
