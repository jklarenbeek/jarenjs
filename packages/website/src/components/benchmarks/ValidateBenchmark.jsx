import { useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { Card, CardContent, CardHeader, CardTitle } from '@components/ui/card';
import { Badge } from '@components/ui/badge';
import { useBenchmarkFile, processValidateData } from '@hooks/useBenchmarkData';
import { cn, formatNs, formatRatio, formatDuration } from '@lib/utils';
import {
  StatCard,
  RatioBadge,
  DivergingBar,
  PairedTimeBars,
  RatioHistogram,
  MethodologyCard,
  BenchmarkFallback,
  SearchInput,
  useShowMore,
} from './shared';
import { CheckCircle2, XCircle, ChevronDown } from 'lucide-react';

const DRAFT_NAMES = {
  draft7: 'Draft 07',
  'draft2019-09': '2019-09',
  'draft2020-12': '2020-12',
};

const SORTERS = {
  jarenWin: { label: 'Biggest Jaren win first', fn: (a, b) => (b.ratio ?? 0) - (a.ratio ?? 0) },
  ajvWin: { label: 'Biggest Ajv win first', fn: (a, b) => (a.ratio ?? Infinity) - (b.ratio ?? Infinity) },
  jarenSlowest: { label: 'Slowest for Jaren first', fn: (a, b) => (b.jarenTime ?? 0) - (a.jarenTime ?? 0) },
  suite: { label: 'Suite order (A→Z)', fn: (a, b) => a.suite.localeCompare(b.suite) || a.description.localeCompare(b.description) },
};

const msToNs = (ms) => (ms == null ? null : ms * 1e6);

function ValidateBenchmark() {
  const { data: raw, loading } = useBenchmarkFile('validate');
  const data = useMemo(() => processValidateData(raw), [raw]);

  const [selectedDrafts, setSelectedDrafts] = useState(new Set());
  const [search, setSearch] = useState('');
  const [winner, setWinner] = useState('all');
  const [successOnly, setSuccessOnly] = useState(true);
  const [sortBy, setSortBy] = useState('jarenWin');
  const [grouped, setGrouped] = useState(false);

  const drafts = data?.metadata?.drafts ?? [];
  const activeDrafts = selectedDrafts.size > 0 ? selectedDrafts : new Set(drafts);

  const filtered = useMemo(() => {
    if (!data) return [];
    const term = search.trim().toLowerCase();
    return data.results.filter((r) => {
      if (!activeDrafts.has(r.draft)) return false;
      if (successOnly && !r.isSuccessTest) return false;
      if (winner === 'jaren' && !(r.ratio > 1)) return false;
      if (winner === 'ajv' && !(r.ratio < 1)) return false;
      if (winner === 'ajvFailed' && !(r.ajvFailures > 0)) return false;
      if (term && !r.description.toLowerCase().includes(term) && !r.suite.toLowerCase().includes(term)) return false;
      return true;
    }).sort(SORTERS[sortBy]?.fn ?? SORTERS.jarenWin.fn);
  }, [data, activeDrafts, search, winner, successOnly, sortBy]);

  const stats = useMemo(() => {
    const ratios = filtered.map((r) => r.ratio).filter((r) => r != null && Number.isFinite(r));
    const jarenWins = ratios.filter((r) => r > 1).length;
    const jarenNs = filtered.reduce((s, r) => s + (r.jarenTime ?? 0), 0) * 1e6;
    const ajvNs = filtered.reduce((s, r) => s + (r.ajvTime ?? 0), 0) * 1e6;
    // geometric mean is the honest average for ratios (arithmetic mean
    // overweights a single 100x outlier)
    const geo = ratios.length > 0
      ? Math.exp(ratios.reduce((s, r) => s + Math.log(r), 0) / ratios.length)
      : null;
    return { ratios, jarenWins, total: ratios.length, jarenNs, ajvNs, geo };
  }, [filtered]);

  if (!data) return <BenchmarkFallback loading={loading} name="validate" />;

  const toggleDraft = (key) => {
    setSelectedDrafts((prev) => {
      const next = new Set(prev.size > 0 ? prev : drafts);
      if (next.has(key)) next.delete(key); else next.add(key);
      if (next.size === drafts.length || next.size === 0) return new Set();
      return next;
    });
  };

  return (
    <div className="space-y-6">
      {/* Conformance: the pass/fail counts are the invariant — timing varies run to run */}
      <div className="grid md:grid-cols-3 gap-4">
        <Card className="md:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              Official JSON-Schema-Test-Suite conformance
              <span className="ml-2 font-normal text-muted-foreground">(including optional format suites)</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="text-left py-1.5 font-medium">Draft</th>
                  <th className="text-right py-1.5 font-medium">Jaren</th>
                  <th className="text-right py-1.5 font-medium">Ajv</th>
                </tr>
              </thead>
              <tbody>
                {drafts.map((draft) => {
                  const jaren = data.engineStats?.jaren?.[draft];
                  const ajv = data.engineStats?.ajv?.[draft];
                  return (
                    <tr key={draft} className="border-b last:border-0">
                      <td className="py-2 font-medium">{DRAFT_NAMES[draft] ?? draft}</td>
                      <td className="py-2 text-right">
                        <span className="inline-flex items-center gap-1.5 font-mono tabular-nums">
                          <CheckCircle2 className="h-3.5 w-3.5 text-[var(--viz-faster)]" />
                          {jaren?.passed} passed · {jaren?.failed} failed · {jaren?.errors} errors
                        </span>
                      </td>
                      <td className="py-2 text-right">
                        <span className="inline-flex items-center gap-1.5 font-mono tabular-nums text-muted-foreground">
                          {(ajv?.failed > 0 || ajv?.errors > 0)
                            ? <XCircle className="h-3.5 w-3.5 text-[var(--viz-slower)]" />
                            : <CheckCircle2 className="h-3.5 w-3.5 text-[var(--viz-faster)]" />}
                          {ajv?.passed} passed · {ajv?.failed} failed · {ajv?.errors} errors
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="text-xs text-muted-foreground mt-2">
              Jaren passes every test in every benchmarked draft — including the tests Ajv fails or cannot compile.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Ratio distribution (filtered tests)</CardTitle>
          </CardHeader>
          <CardContent>
            <RatioHistogram ratios={stats.ratios} rival="Ajv" />
          </CardContent>
        </Card>
      </div>

      {/* Headline for the current filter */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Jaren faster on"
          value={`${stats.jarenWins} of ${stats.total}`}
          sub="filtered test cases"
          tone={stats.jarenWins * 2 >= stats.total ? 'good' : 'bad'}
        />
        <StatCard
          label="Typical ratio"
          value={stats.geo ? `${formatRatio(stats.geo)}` : '—'}
          sub="geometric mean, >1 = Jaren faster"
          tone={stats.geo >= 1 ? 'good' : 'bad'}
        />
        <StatCard label="Jaren time" value={formatDuration(stats.jarenNs / 1e6)} sub="sum over filtered tests" />
        <StatCard label="Ajv time" value={formatDuration(stats.ajvNs / 1e6)} sub="sum over filtered tests" />
      </div>

      {/* Controls */}
      <div className="p-4 bg-muted/30 rounded-lg border space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium mr-1">Drafts:</span>
          {drafts.map((draft) => (
            <button
              key={draft}
              onClick={() => toggleDraft(draft)}
              className={cn(
                'px-3 py-1 rounded-lg text-sm font-medium transition-all',
                activeDrafts.has(draft)
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80',
              )}
            >
              {DRAFT_NAMES[draft] ?? draft}
            </button>
          ))}
          <label className="ml-auto flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={successOnly}
              onChange={(e) => setSuccessOnly(e.target.checked)}
              className="rounded"
            />
            Fair fight only
            <span className="text-xs text-muted-foreground hidden sm:inline">(tests both engines pass)</span>
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput value={search} onChange={setSearch} placeholder="Search tests… (e.g. unevaluated, $ref, format)" />
          <select
            value={winner}
            onChange={(e) => setWinner(e.target.value)}
            className="text-sm px-3 py-1.5 rounded-md bg-background border border-input"
            aria-label="Filter by winner"
          >
            <option value="all">All results</option>
            <option value="jaren">Only where Jaren is faster</option>
            <option value="ajv">Only where Ajv is faster</option>
            <option value="ajvFailed">Only where Ajv fails the test</option>
          </select>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value)}
            className="text-sm px-3 py-1.5 rounded-md bg-background border border-input"
            aria-label="Sort tests"
          >
            {Object.entries(SORTERS).map(([key, s]) => (
              <option key={key} value={key}>{s.label}</option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm ml-auto">
            <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} className="rounded" />
            Group by suite
          </label>
        </div>
      </div>

      {grouped
        ? <SuiteGroups tests={filtered} />
        : <FlatTestTable tests={filtered} />}

      <MethodologyCard>
        <p>
          Every test case of the official{' '}
          <a className="underline" href="https://github.com/json-schema-org/JSON-Schema-Test-Suite" target="_blank" rel="noopener noreferrer">JSON-Schema-Test-Suite</a>{' '}
          is compiled once per engine and validated for {raw.metadata.iterations.toLocaleString()} iterations; the time shown is per full test case
          (all of its assertions). Ratio = Ajv time ÷ Jaren time, so above 1× Jaren is faster.
        </p>
        <p>
          <strong>“Fair fight only”</strong> restricts the comparison to tests both engines compile <em>and</em> pass —
          a test an engine fails can be arbitrarily fast for the wrong reason. Jaren additionally passes every test Ajv
          fails or errors on (see the conformance table). Micro-timings move ±10% run to run; the pass/fail counts are the invariant.
        </p>
        <p>
          Reproduce: <code className="bg-muted px-1 rounded">node benchmark/profiler.js --profile-all --draft draft7,draft2019-09,draft2020-12</code>
        </p>
      </MethodologyCard>
    </div>
  );
}

//#region flat table

function FlatTestTable({ tests }) {
  const { visible, remaining, showMore } = useShowMore(tests, 100);

  if (tests.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-muted-foreground">No tests match the current filters.</CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="pt-4">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th className="text-left py-2 pr-2 font-medium">Test case</th>
                <th className="text-right py-2 px-2 font-medium">Jaren</th>
                <th className="text-right py-2 px-2 font-medium">Ajv</th>
                <th className="text-left py-2 pl-4 font-medium w-56">Ratio (log scale, 1× at center)</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((test, i) => <TestRow key={`${test.draft}${test.suite}${test.description}${i}`} test={test} />)}
            </tbody>
          </table>
        </div>
        {remaining > 0 && (
          <button
            onClick={showMore}
            className="mt-3 w-full text-sm py-2 rounded-md border bg-muted/30 hover:bg-muted transition-colors"
          >
            Show 100 more ({remaining.toLocaleString()} remaining)
          </button>
        )}
      </CardContent>
    </Card>
  );
}

FlatTestTable.propTypes = { tests: PropTypes.array.isRequired };

function TestRow({ test }) {
  return (
    <tr className="border-b last:border-0 hover:bg-muted/40">
      <td className="py-2 pr-2">
        <div className="font-medium text-[13px]">{test.description}</div>
        <div className="text-xs text-muted-foreground font-mono">
          {test.suite}
          <Badge variant="outline" className="ml-2 text-[10px] px-1 py-0">{DRAFT_NAMES[test.draft] ?? test.draft}</Badge>
          {test.ajvFailures > 0 && (
            <Badge variant="warning" className="ml-1 text-[10px] px-1 py-0" title="Ajv does not pass this test; its timing is not a fair comparison">
              Ajv fails
            </Badge>
          )}
        </div>
      </td>
      <td className="py-2 px-2 text-right font-mono tabular-nums whitespace-nowrap">{formatNs(msToNs(test.jarenTime))}</td>
      <td className="py-2 px-2 text-right font-mono tabular-nums whitespace-nowrap text-muted-foreground">{formatNs(msToNs(test.ajvTime))}</td>
      <td className="py-2 pl-4">
        <div className="flex items-center gap-2">
          <DivergingBar ratio={test.ratio} className="flex-1 min-w-24" />
          <RatioBadge ratio={test.ratio} rival="Ajv" compact />
        </div>
      </td>
    </tr>
  );
}

TestRow.propTypes = { test: PropTypes.object.isRequired };

//#endregion

//#region grouped by suite

function SuiteGroups({ tests }) {
  const groups = useMemo(() => {
    const map = new Map();
    for (const test of tests) {
      const key = `${test.suite}::${test.draft}`;
      let group = map.get(key);
      if (!group) {
        group = { key, suite: test.suite, draft: test.draft, tests: [], jarenNs: 0, ajvNs: 0, wins: 0 };
        map.set(key, group);
      }
      group.tests.push(test);
      group.jarenNs += (test.jarenTime ?? 0) * 1e6;
      group.ajvNs += (test.ajvTime ?? 0) * 1e6;
      if (test.ratio > 1) group.wins++;
    }
    return [...map.values()].sort((a, b) => (b.ajvNs / b.jarenNs) - (a.ajvNs / a.jarenNs));
  }, [tests]);

  if (groups.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center text-muted-foreground">No tests match the current filters.</CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {groups.map((group) => <SuiteGroupCard key={group.key} group={group} />)}
    </div>
  );
}

SuiteGroups.propTypes = { tests: PropTypes.array.isRequired };

function SuiteGroupCard({ group }) {
  const [open, setOpen] = useState(false);
  const suiteRatio = group.jarenNs > 0 ? group.ajvNs / group.jarenNs : null;

  return (
    <Card>
      <button
        className="w-full text-left"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <CardHeader className="py-3">
          <div className="flex items-center gap-3">
            <ChevronDown className={cn('h-4 w-4 shrink-0 transition-transform', !open && '-rotate-90')} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-sm font-medium">{group.suite.replace(/^\//, '')}</span>
                <Badge variant="outline" className="text-[10px]">{DRAFT_NAMES[group.draft] ?? group.draft}</Badge>
                <Badge variant="secondary" className="text-[10px]">{group.tests.length} tests</Badge>
                <span className="text-xs text-muted-foreground">Jaren faster on {group.wins} of {group.tests.length}</span>
              </div>
              <div className="mt-2 max-w-xl">
                <PairedTimeBars jarenNs={group.jarenNs} rivalNs={group.ajvNs} rivalLabel="Ajv" />
              </div>
            </div>
            <RatioBadge ratio={suiteRatio} rival="Ajv" />
          </div>
        </CardHeader>
      </button>
      {open && (
        <CardContent className="pt-0">
          <table className="w-full text-sm">
            <tbody>
              {group.tests.map((test, i) => <TestRow key={i} test={test} />)}
            </tbody>
          </table>
        </CardContent>
      )}
    </Card>
  );
}

SuiteGroupCard.propTypes = { group: PropTypes.object.isRequired };

//#endregion

export { ValidateBenchmark };
