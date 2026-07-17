import PropTypes from 'prop-types';
import { Card, CardContent, CardHeader, CardTitle } from '@components/ui/card';
import { useBenchmarkFile } from '@hooks/useBenchmarkData';
import { formatNs, formatRatio } from '@lib/utils';
import { StatCard, RatioBadge, MethodologyCard, BenchmarkFallback } from './shared';

function PointerBenchmark() {
  const { data, loading } = useBenchmarkFile('jsonpointer');

  if (!data) return <BenchmarkFallback loading={loading} name="jsonpointer" />;

  const speedups = data.tables.flatMap((table) => table.rows
    .filter((row) => row.results[0] != null && row.results[1] != null)
    .map((row) => row.results[1] / row.results[0]));
  const span = speedups.length > 0 ? [Math.min(...speedups), Math.max(...speedups)] : null;

  const absolute = data.tables.find((t) => t.key === 'absolute');
  const npmWins = absolute
    ? absolute.rows.filter((row) => row.results[2] != null && row.results[0] < row.results[2]).length
    : 0;
  const npmComparable = absolute
    ? absolute.rows.filter((row) => row.results[2] != null).length
    : 0;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Compiled vs interpretive"
          value={span ? `${formatRatio(span[0])}–${formatRatio(span[1])}` : '—'}
          sub="faster than the resolver it replaced"
          tone="good"
        />
        <StatCard
          label="vs jsonpointer (npm)"
          value={`${npmWins} of ${npmComparable}`}
          sub="scenarios where Jaren's compiled getter wins"
          tone={npmWins === npmComparable ? 'good' : 'default'}
        />
        <StatCard
          label="Compile cost"
          value={formatNs(data.compile.jaren.ns / data.compile.jaren.pointers)}
          sub={`per pointer (${data.compile.jaren.pointers} pointers in ${formatNs(data.compile.jaren.ns)})`}
        />
        <StatCard
          label="Allocation"
          value="zero"
          sub="resolution allocates nothing; misses return a shared sentinel"
        />
      </div>

      {data.tables.map((table) => (
        <PointerTable key={table.key} table={table} iterations={data.iterations} />
      ))}

      <MethodologyCard>
        <p>
          Compiled getters (<code className="bg-muted px-1 rounded">compileJSONPointer</code>,{' '}
          <code className="bg-muted px-1 rounded">compileRelativeJSONPointer</code>,{' '}
          <code className="bg-muted px-1 rounded">compileDataRef</code>) against the historical interpretive resolver
          (inlined verbatim as it shipped before the rewrite) and the{' '}
          <a className="underline" href="https://www.npmjs.com/package/jsonpointer" target="_blank" rel="noopener noreferrer">jsonpointer</a>{' '}
          npm package. The relative scenarios mirror the validator&apos;s <code className="bg-muted px-1 rounded">$data</code> hot
          path: a compile-time-constant ref resolved at a realistic instance depth. {data.iterations.toLocaleString()} iterations per cell.
        </p>
        <p>
          Reproduce: <code className="bg-muted px-1 rounded">npm run benchmark:jsonpointer</code>
        </p>
      </MethodologyCard>
    </div>
  );
}

function PointerTable({ table, iterations }) {
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
                <th className="text-right py-2 pl-2 font-medium">vs legacy</th>
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row) => (
                <tr key={row.name} className="border-b last:border-0 hover:bg-muted/40">
                  <td className="py-2 pr-2">
                    <div className="text-[13px]">{row.name}</div>
                    {row.pointer !== undefined && (
                      <code className="text-xs text-muted-foreground">
                        {row.pointer === '' ? '"" (root)' : row.pointer}
                        {row.dataPath ? ` @ ${row.dataPath}` : ''}
                      </code>
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
                  <td className="py-2 pl-2 text-right">
                    {row.results[1] != null
                      ? <RatioBadge ratio={row.results[1] / row.results[0]} rival="the legacy resolver" compact />
                      : <span className="text-xs text-muted-foreground">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

PointerTable.propTypes = {
  table: PropTypes.object.isRequired,
  iterations: PropTypes.number.isRequired,
};

export { PointerBenchmark };
