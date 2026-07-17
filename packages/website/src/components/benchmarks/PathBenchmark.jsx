import { useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { Card, CardContent, CardHeader, CardTitle } from '@components/ui/card';
import { useBenchmarkFile } from '@hooks/useBenchmarkData';
import { formatNs, formatRatio } from '@lib/utils';
import {
  StatCard,
  RatioBadge,
  DivergingBar,
  RatioHistogram,
  MethodologyCard,
  BenchmarkFallback,
  SearchInput,
  useShowMore,
} from './shared';

const SORTERS = {
  jarenWin: { label: 'Biggest Jaren win first', fn: (a, b) => (b.ratio ?? 0) - (a.ratio ?? 0) },
  p3Win: { label: 'Biggest json-p3 win first', fn: (a, b) => (a.ratio ?? Infinity) - (b.ratio ?? Infinity) },
  jarenSlowest: { label: 'Slowest for Jaren first', fn: (a, b) => (b.jaren ?? 0) - (a.jaren ?? 0) },
  name: { label: 'Test name (A→Z)', fn: (a, b) => a.name.localeCompare(b.name) },
};

function PathBenchmark() {
  const { data, loading } = useBenchmarkFile('jsonpath');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('jarenWin');

  const rivalName = data?.engines?.find((e) => e !== 'Jaren') ?? 'json-p3';

  const rows = useMemo(() => {
    if (!data) return [];
    return data.profile.rows
      .map((row) => ({
        name: row.name,
        selector: row.selector,
        jaren: row.engines.jaren,
        rival: row.engines['json-p3'],
        ratio: row.engines.jaren != null && row.engines['json-p3'] != null
          ? row.engines['json-p3'] / row.engines.jaren
          : null,
      }));
  }, [data]);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return rows
      .filter((r) => !term || r.name.toLowerCase().includes(term) || r.selector.toLowerCase().includes(term))
      .sort(SORTERS[sortBy]?.fn ?? SORTERS.jarenWin.fn);
  }, [rows, search, sortBy]);

  const totals = useMemo(() => {
    const both = rows.filter((r) => r.jaren != null && r.rival != null);
    const jaren = both.reduce((s, r) => s + r.jaren, 0);
    const rival = both.reduce((s, r) => s + r.rival, 0);
    const wins = both.filter((r) => r.ratio > 1).length;
    return { count: both.length, jaren, rival, wins, mean: rival / jaren };
  }, [rows]);

  if (!data) return <BenchmarkFallback loading={loading} name="jsonpath" />;

  const compliancePass = (engine) => data.compliance.groups
    .reduce((sum, [, entry]) => sum + (entry.pass[engine] ?? 0), 0);

  const compileRatio = data.profile.compileRow.engines['json-p3'] / data.profile.compileRow.engines.jaren;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="RFC 9535 compliance"
          value={`${compliancePass('jaren')}/${data.compliance.total}`}
          sub={`Jaren — ${rivalName}: ${compliancePass('json-p3')}/${data.compliance.total}`}
          tone="good"
        />
        <StatCard
          label="Mean per CTS query"
          value={formatNs(totals.jaren / totals.count)}
          sub={`${rivalName}: ${formatNs(totals.rival / totals.count)} — ${formatRatio(totals.mean)} faster overall`}
          tone="good"
        />
        <StatCard
          label="Jaren faster on"
          value={`${totals.wins} of ${totals.count}`}
          sub="valid CTS query cases"
          tone={totals.wins * 2 >= totals.count ? 'good' : 'bad'}
        />
        <StatCard
          label="Compile all selectors"
          value={formatNs(data.profile.compileRow.engines.jaren)}
          sub={`${rivalName}: ${formatNs(data.profile.compileRow.engines['json-p3'])} (${formatRatio(compileRatio)})`}
          tone={compileRatio >= 1 ? 'good' : 'bad'}
        />
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Compliance by test group</CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="text-left py-1.5 font-medium">Group</th>
                  <th className="text-right py-1.5 font-medium">Jaren</th>
                  <th className="text-right py-1.5 font-medium">{rivalName}</th>
                </tr>
              </thead>
              <tbody>
                {data.compliance.groups.map(([group, entry]) => (
                  <tr key={group} className="border-b last:border-0">
                    <td className="py-1.5 font-mono text-xs">{group}</td>
                    <td className="py-1.5 text-right font-mono tabular-nums">{entry.pass.jaren}/{entry.total}</td>
                    <td className="py-1.5 text-right font-mono tabular-nums text-muted-foreground">{entry.pass['json-p3']}/{entry.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-muted-foreground mt-2">
              All {data.compliance.total} tests of the official JSONPath Compliance Test Suite, normalized-path assertions included.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Per-query ratio distribution</CardTitle>
          </CardHeader>
          <CardContent>
            <RatioHistogram ratios={rows.map((r) => r.ratio).filter((r) => r != null)} rival={rivalName} />
          </CardContent>
        </Card>
      </div>

      {/* Synthetic scale scenarios */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Synthetic 1,000-item document scenarios</CardTitle>
        </CardHeader>
        <CardContent>
          <ScenarioTable rows={data.profile.scaleRows} rivalName={rivalName} />
        </CardContent>
      </Card>

      {/* Per-CTS-query drill-down */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Every CTS query, head to head</CardTitle>
          <div className="flex flex-wrap gap-2 pt-1">
            <SearchInput value={search} onChange={setSearch} placeholder="Search queries… (e.g. slice, filter, descendant)" />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value)}
              className="text-sm px-3 py-1.5 rounded-md bg-background border border-input"
              aria-label="Sort queries"
            >
              {Object.entries(SORTERS).map(([key, s]) => (
                <option key={key} value={key}>{s.label}</option>
              ))}
            </select>
            <span className="text-sm text-muted-foreground self-center ml-auto">
              {filtered.length} of {rows.length} queries
            </span>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <QueryTable rows={filtered} rivalName={rivalName} />
        </CardContent>
      </Card>

      <MethodologyCard>
        <p>
          Every valid selector of the{' '}
          <a className="underline" href="https://github.com/jsonpath-standard/jsonpath-compliance-test-suite" target="_blank" rel="noopener noreferrer">JSONPath Compliance Test Suite</a>{' '}
          is compiled once per engine and then run against its CTS document for {data.profile.iterations.toLocaleString()} iterations
          (ns per query, result equivalence asserted by the compliance run first).
          {' '}<a className="underline" href="https://www.npmjs.com/package/json-p3" target="_blank" rel="noopener noreferrer">json-p3</a>{' '}
          is the reference competitor because it also passes the full suite — this is a fair fight between two fully compliant engines.
        </p>
        <p>
          CTS documents are tiny, so this measures per-query overhead; the synthetic scenarios above show behavior on a
          1,000-item document (wildcards, slices, filters, regex filters and descendant scans).
        </p>
        <p>
          Reproduce: <code className="bg-muted px-1 rounded">npm run benchmark:jsonpath</code> and{' '}
          <code className="bg-muted px-1 rounded">node benchmark/jsonpath.js --profile --scale</code>
        </p>
      </MethodologyCard>
    </div>
  );
}

function ScenarioTable({ rows, rivalName }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-xs text-muted-foreground">
            <th className="text-left py-2 pr-2 font-medium">Selector</th>
            <th className="text-right py-2 px-2 font-medium">Jaren</th>
            <th className="text-right py-2 px-2 font-medium">{rivalName}</th>
            <th className="text-left py-2 pl-4 font-medium w-56">Ratio</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const ratio = row.engines.jaren != null && row.engines['json-p3'] != null
              ? row.engines['json-p3'] / row.engines.jaren : null;
            return (
              <tr key={row.selector} className="border-b last:border-0 hover:bg-muted/40">
                <td className="py-2 pr-2 font-mono text-xs">{row.selector}</td>
                <td className="py-2 px-2 text-right font-mono tabular-nums whitespace-nowrap">{formatNs(row.engines.jaren)}</td>
                <td className="py-2 px-2 text-right font-mono tabular-nums whitespace-nowrap text-muted-foreground">{formatNs(row.engines['json-p3'])}</td>
                <td className="py-2 pl-4">
                  <div className="flex items-center gap-2">
                    <DivergingBar ratio={ratio} maxLog={7} className="flex-1 min-w-24" />
                    <RatioBadge ratio={ratio} rival={rivalName} compact />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

ScenarioTable.propTypes = {
  rows: PropTypes.array.isRequired,
  rivalName: PropTypes.string.isRequired,
};

function QueryTable({ rows, rivalName }) {
  const { visible, remaining, showMore } = useShowMore(rows, 100);

  if (rows.length === 0) {
    return <p className="py-8 text-center text-muted-foreground text-sm">No queries match the search.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-xs text-muted-foreground">
            <th className="text-left py-2 pr-2 font-medium">CTS test</th>
            <th className="text-right py-2 px-2 font-medium">Jaren</th>
            <th className="text-right py-2 px-2 font-medium">{rivalName}</th>
            <th className="text-left py-2 pl-4 font-medium w-56">Ratio (log scale, 1× at center)</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((row) => (
            <tr key={row.name} className="border-b last:border-0 hover:bg-muted/40">
              <td className="py-2 pr-2">
                <div className="text-[13px]">{row.name}</div>
                <code className="text-xs text-muted-foreground">{row.selector}</code>
              </td>
              <td className="py-2 px-2 text-right font-mono tabular-nums whitespace-nowrap">{formatNs(row.jaren)}</td>
              <td className="py-2 px-2 text-right font-mono tabular-nums whitespace-nowrap text-muted-foreground">{formatNs(row.rival)}</td>
              <td className="py-2 pl-4">
                <div className="flex items-center gap-2">
                  <DivergingBar ratio={row.ratio} maxLog={7} className="flex-1 min-w-24" />
                  <RatioBadge ratio={row.ratio} rival={rivalName} compact />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {remaining > 0 && (
        <button
          onClick={showMore}
          className="mt-3 w-full text-sm py-2 rounded-md border bg-muted/30 hover:bg-muted transition-colors"
        >
          Show 100 more ({remaining} remaining)
        </button>
      )}
    </div>
  );
}

QueryTable.propTypes = {
  rows: PropTypes.array.isRequired,
  rivalName: PropTypes.string.isRequired,
};

export { PathBenchmark };
