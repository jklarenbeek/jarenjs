import PropTypes from 'prop-types';
import { Card, CardContent, CardHeader, CardTitle } from '@components/ui/card';
import { useBenchmarkFile } from '@hooks/useBenchmarkData';
import { formatNs, formatRatio } from '@lib/utils';
import { StatCard, RatioBadge, MethodologyCard, BenchmarkFallback } from './shared';

function PatchBenchmark() {
  const { data, loading } = useBenchmarkFile('jsonpatch');

  if (!data) return <BenchmarkFallback loading={loading} name="jsonpatch" />;

  // speedup of the compiled applier (first column) over the naive
  // clone-and-interpret baseline (last column), across both apply tables
  const speedups = data.tables
    .filter((table) => table.columns.length > 1)
    .flatMap((table) => table.rows
      .filter((row) => row.results[0] != null && row.results[row.results.length - 1] != null)
      .map((row) => row.results[row.results.length - 1] / row.results[0]));
  const span = speedups.length > 0 ? [Math.min(...speedups), Math.max(...speedups)] : null;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="json-patch-tests"
          value={`${data.conformance.pass}/${data.conformance.total}`}
          sub="official RFC 6902 vectors replayed before timing anything"
          tone={data.conformance.pass === data.conformance.total ? 'good' : 'default'}
        />
        <StatCard
          label="Compiled vs naive"
          value={span ? `${formatRatio(span[0])}–${formatRatio(span[1])}` : '—'}
          sub="faster than clone-and-interpret, patch and merge combined"
          tone="good"
        />
        <StatCard
          label="Compile cost"
          value={formatNs(data.compile.jaren.ns / data.compile.jaren.patches)}
          sub={`per patch (${data.compile.jaren.patches} patches, ${data.compile.jaren.ops} ops in ${formatNs(data.compile.jaren.ns)})`}
        />
        <StatCard
          label="Atomicity"
          value="free"
          sub="copy-on-write never touches the input; a failing op leaves nothing behind"
        />
      </div>

      {data.tables.map((table) => (
        <PatchTable key={table.key} table={table} iterations={data.iterations} />
      ))}

      <MethodologyCard>
        <p>
          Compiled appliers (<code className="bg-muted px-1 rounded">compileJSONPatch</code>,{' '}
          <code className="bg-muted px-1 rounded">compileMergePatch</code>) against a naive
          clone-and-interpret implementation inlined in the tool — the shape most patch libraries ship:{' '}
          <code className="bg-muted px-1 rounded">structuredClone</code> the document, then re-parse every pointer and
          dispatch every operation per application. The copy-on-write applier instead clones only the spine it writes
          through, once per region — which is why the &quot;one spine, many ops&quot; scenario widens the gap on the
          200-line document. The <em>mutate</em> column applies in place (its clone cost is measured separately and
          subtracted); the <em>one-shot</em> column re-compiles per application, bounding what compile-once buys.
          Before timing anything the tool replays all {data.conformance.total} official{' '}
          <a className="underline" href="https://github.com/json-patch/json-patch-tests" target="_blank" rel="noopener noreferrer">json-patch-tests</a>{' '}
          vectors. {data.iterations.toLocaleString()} iterations per cell (naive cells at 1/10th).
        </p>
        <p>
          Reproduce: <code className="bg-muted px-1 rounded">npm run benchmark:jsonpatch</code>
        </p>
      </MethodologyCard>
    </div>
  );
}

function PatchTable({ table, iterations }) {
  const hasBaseline = table.columns.length > 1;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">
          {table.title}
          <span className="ml-2 font-normal text-muted-foreground">({iterations.toLocaleString()} iterations, ns/op)</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th className="text-left py-2 pr-2 font-medium">Scenario</th>
                {table.columns.map((column) => (
                  <th key={column} className="text-right py-2 px-2 font-medium">{column}</th>
                ))}
                {hasBaseline && <th className="text-right py-2 pl-2 font-medium">vs naive</th>}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row) => (
                <tr key={row.name} className="border-b last:border-0 hover:bg-muted/40">
                  <td className="py-2 pr-2">
                    <div className="text-[13px]">{row.name}</div>
                    {row.ops !== undefined && (
                      <code className="text-xs text-muted-foreground">{row.ops} operations</code>
                    )}
                  </td>
                  {row.results.map((ns, i) => (
                    <td
                      key={i}
                      className={`py-2 px-2 text-right font-mono tabular-nums whitespace-nowrap ${i === 0 ? 'font-semibold' : 'text-muted-foreground'}`}
                    >
                      {ns == null ? 'n/a' : formatNs(ns)}
                    </td>
                  ))}
                  {hasBaseline && (
                    <td className="py-2 pl-2 text-right">
                      {row.results[row.results.length - 1] != null
                        ? <RatioBadge ratio={row.results[row.results.length - 1] / row.results[0]} rival="the naive baseline" compact />
                        : <span className="text-xs text-muted-foreground">—</span>}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

PatchTable.propTypes = {
  table: PropTypes.object.isRequired,
  iterations: PropTypes.number.isRequired,
};

export { PatchBenchmark };
