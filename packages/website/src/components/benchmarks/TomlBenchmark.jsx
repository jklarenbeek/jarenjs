import PropTypes from 'prop-types';
import { Card, CardContent, CardHeader, CardTitle } from '@components/ui/card';
import { Badge } from '@components/ui/badge';
import { useBenchmarkFile } from '@hooks/useBenchmarkData';
import { StatCard, MethodologyCard, BenchmarkFallback } from './shared';

const fmtMs = (ms) => (ms == null ? 'n/a' : `${ms.toFixed(ms < 1 ? 3 : 2)} ms`);
const fmtPct = (c) => `${((c.pass / c.total) * 100).toFixed(1)}%`;

/**
 * JOSL strict-TOML benchmark: the official toml-test suite as the
 * conformance gate, then parse/stringify throughput against the other
 * JS TOML parsers. Research package — honesty over marketing: the
 * compliance table and the speed table tell one story together.
 */
function TomlBenchmark() {
  const { data, loading } = useBenchmarkFile('toml');

  if (!data) return <BenchmarkFallback loading={loading} name="toml" />;

  const jaren = data.compliance.jaren;
  const rivals = data.engines.filter((e) => e !== 'jaren');
  const bestRival = rivals.reduce((best, e) => {
    const c = data.compliance[e];
    return c != null && (best == null || c.pass > data.compliance[best].pass) ? e : best;
  }, null);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="toml-test 1.0.0"
          value={`${jaren.pass}/${jaren.total}`}
          sub="official suite, valid + invalid cases — the only engine here at 100%"
          tone={jaren.pass === jaren.total ? 'good' : 'default'}
        />
        <StatCard
          label="Best contender"
          value={bestRival ? fmtPct(data.compliance[bestRival]) : '—'}
          sub={bestRival ? `${bestRival} — every other engine accepts invalid or rejects valid documents` : ''}
        />
        <StatCard
          label="Streaming"
          value="chunk-safe"
          sub="the only parser in this table that consumes chunks which may split any token"
          tone="good"
        />
        <StatCard
          label="Typed verification"
          value="npm run test:josl"
          sub="integers, floats and all four datetime flavours verified per valid case"
        />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">
            Compliance — accept/reject over {jaren.total} official cases
            <span className="ml-2 font-normal text-muted-foreground">
              ({data.cases.valid} valid, {data.cases.invalid} invalid)
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs text-muted-foreground">
                  <th className="text-left py-2 pr-2 font-medium">Engine</th>
                  <th className="text-right py-2 px-2 font-medium">Pass</th>
                  <th className="text-right py-2 pl-2 font-medium">Rate</th>
                </tr>
              </thead>
              <tbody>
                {data.engines.map((engine) => {
                  const c = data.compliance[engine];
                  if (c == null) return null;
                  const full = c.pass === c.total;
                  return (
                    <tr key={engine} className="border-b last:border-0 hover:bg-muted/40">
                      <td className={`py-2 pr-2 ${engine === 'jaren' ? 'font-semibold' : ''}`}>{engine}</td>
                      <td className="py-2 px-2 text-right font-mono tabular-nums">{c.pass}/{c.total}</td>
                      <td className="py-2 pl-2 text-right">
                        <Badge variant={full ? 'success' : 'outline'} className="text-xs">{fmtPct(c)}</Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {data.profile && (
        <>
          <ProfileTable
            title="Parse"
            rows={data.profile.parse}
            engines={data.engines}
            iterations={data.profile.iterations}
          />
          <ProfileTable
            title="Stringify"
            rows={[{ name: '1k-record document', results: data.profile.stringify }]}
            engines={data.engines.filter((e) => data.profile.stringify[e] !== undefined)}
            iterations={data.profile.iterations}
          />
        </>
      )}

      <MethodologyCard>
        <p>
          Compliance here is accept/reject semantics over the official{' '}
          <a className="underline" href="https://github.com/toml-lang/toml-test" target="_blank" rel="noopener noreferrer">toml-test</a>{' '}
          1.0.0 case list (a git submodule): every valid document must parse, every invalid one must throw. Jaren
          additionally verifies the <em>typed values</em> — integers, floats, all four datetime flavours — in the
          repository test suite. The speed table is honest about the trade: smol-toml&apos;s single-pass,
          whole-string parser is faster on raw throughput, while Jaren&apos;s reader is built around a chunk-feedable
          streaming cutter (a second pass over every character) and is the only engine here that is both fully
          compliant and incremental. The single-walk scanner that closes the gap is on the roadmap.
        </p>
        <p>
          Reproduce: <code className="bg-muted px-1 rounded">npm run benchmark:toml</code> (add{' '}
          <code className="bg-muted px-1 rounded">--profile</code> for the speed table).
        </p>
      </MethodologyCard>
    </div>
  );
}

function ProfileTable({ title, rows, engines, iterations }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">
          {title}
          <span className="ml-2 font-normal text-muted-foreground">({iterations} iterations, ms per pass)</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground">
                <th className="text-left py-2 pr-2 font-medium">Corpus</th>
                {engines.map((engine) => (
                  <th key={engine} className="text-right py-2 px-2 font-medium">{engine}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.name} className="border-b last:border-0 hover:bg-muted/40">
                  <td className="py-2 pr-2 text-[13px]">{row.name}</td>
                  {engines.map((engine) => {
                    const ms = row.results[engine];
                    const base = row.results.jaren;
                    return (
                      <td
                        key={engine}
                        className={`py-2 px-2 text-right font-mono tabular-nums whitespace-nowrap ${engine === 'jaren' ? 'font-semibold' : 'text-muted-foreground'}`}
                      >
                        {fmtMs(ms)}
                        {engine !== 'jaren' && ms != null && base != null && (
                          <span className="ml-1 text-xs">({(ms / base).toFixed(2)}x)</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

ProfileTable.propTypes = {
  title: PropTypes.string.isRequired,
  rows: PropTypes.array.isRequired,
  engines: PropTypes.array.isRequired,
  iterations: PropTypes.number.isRequired,
};

export { TomlBenchmark };
