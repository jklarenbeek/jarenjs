import { useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { Card, CardContent, CardHeader, CardTitle } from '@components/ui/card';
import { Badge } from '@components/ui/badge';
import { cn, formatNs, formatOps, formatRatio } from '@lib/utils';
import { RatioBadge, SourceBlock } from './shared';
import { Code2, ChevronDown } from 'lucide-react';

/**
 * Scenario × document-size drill-down shared by the JSON Query and JSLT
 * benchmark tabs (their data files have the same shape). Each scenario
 * card shows every engine's time at the selected document size and can
 * unfold the actual program each engine ran — so "what is being measured"
 * is one click away.
 */
function ScenarioMatrix({ data, engineMeta, naNote }) {
  const documents = useMemo(
    () => [...new Set(data.rows.map((row) => row.document))],
    [data.rows]);
  const [doc, setDoc] = useState(documents[documents.length - 1] ?? null);

  const rowFor = (scenarioKey) => data.rows.find(
    (row) => row.scenario === scenarioKey && row.document === doc);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">Document size:</span>
        {documents.map((label) => (
          <button
            key={label}
            onClick={() => setDoc(label)}
            className={cn(
              'px-3 py-1 rounded-lg text-sm font-medium transition-all',
              doc === label
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'bg-muted text-muted-foreground hover:bg-muted/80',
            )}
          >
            {label.replace('bookstore ', '').replace('(', '').replace(')', '')}
          </button>
        ))}
      </div>

      {data.scenarios.map((scenario) => (
        <ScenarioCard
          key={scenario.key}
          scenario={scenario}
          row={rowFor(scenario.key)}
          engineMeta={engineMeta}
          naNote={naNote}
        />
      ))}
    </div>
  );
}

ScenarioMatrix.propTypes = {
  data: PropTypes.object.isRequired,
  engineMeta: PropTypes.array.isRequired,
  naNote: PropTypes.objectOf(PropTypes.string),
};

function ScenarioCard({ scenario, row, engineMeta, naNote }) {
  const [showSources, setShowSources] = useState(false);
  const jarenNs = row?.engines?.jaren;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">{scenario.title}</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">{scenario.description}</p>
          </div>
          {Object.keys(scenario.sources ?? {}).length > 0 && (
            <button
              onClick={() => setShowSources((s) => !s)}
              className="shrink-0 inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md border bg-muted/30 hover:bg-muted transition-colors"
              aria-expanded={showSources}
            >
              <Code2 className="h-3.5 w-3.5" />
              the programs
              <ChevronDown className={cn('h-3 w-3 transition-transform', showSources && 'rotate-180')} />
            </button>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-4">
        {row?.capped !== undefined ? (
          <p className="text-sm text-muted-foreground border rounded-md px-3 py-2 bg-muted/30">
            Skipped at this size — a naive O(n·m) join in <em>every</em> engine; measured at {row.capped.toLocaleString()} books instead (select the smaller document).
          </p>
        ) : (
          <div className="grid sm:grid-cols-3 gap-3">
            {engineMeta.map((engine) => {
              const ns = row?.engines?.[engine.key];
              const isJaren = engine.key === 'jaren';
              const ratio = !isJaren && ns != null && jarenNs != null ? ns / jarenNs : null;
              return (
                <div
                  key={engine.key}
                  className={cn(
                    'rounded-lg border p-3',
                    isJaren && 'border-[var(--viz-jaren)]/40 bg-[var(--viz-jaren)]/5',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium truncate" title={engine.label}>{engine.label}</span>
                    {!isJaren && ns != null && <RatioBadge ratio={ratio} rival={engine.label} compact />}
                  </div>
                  {ns == null ? (
                    <p className="text-sm text-muted-foreground mt-1" title={naNote?.[engine.key]}>
                      n/a{naNote?.[engine.key] ? ` — ${naNote[engine.key]}` : ''}
                    </p>
                  ) : (
                    <>
                      <p className="text-xl font-bold font-mono tabular-nums mt-1">{formatNs(ns)}</p>
                      <p className="text-xs text-muted-foreground">{formatOps(ns)}</p>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {showSources && (
          <div className="grid md:grid-cols-2 gap-3 border-t pt-3">
            {engineMeta.map((engine) => {
              const source = scenario.sources?.[engine.key];
              if (source === undefined) return null;
              return (
                <SourceBlock
                  key={engine.key}
                  label={engine.sourceLabel ?? engine.label}
                  source={source}
                  language={engine.sourceLanguage}
                />
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

ScenarioCard.propTypes = {
  scenario: PropTypes.object.isRequired,
  row: PropTypes.object,
  engineMeta: PropTypes.array.isRequired,
  naNote: PropTypes.objectOf(PropTypes.string),
};

function CompileCard({ compile, engineMeta, note }) {
  if (!compile) return null;
  const jarenNs = compile.results.jaren;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">Compile time per program</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid sm:grid-cols-3 gap-3">
          {engineMeta.map((engine) => {
            const ns = compile.results[engine.key];
            if (ns === undefined) return null;
            const isJaren = engine.key === 'jaren';
            return (
              <div key={engine.key} className={cn('rounded-lg border p-3', isJaren && 'border-[var(--viz-jaren)]/40 bg-[var(--viz-jaren)]/5')}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-medium">{engine.label}</span>
                  {!isJaren && ns != null && jarenNs != null && (
                    <Badge variant="outline" className="font-mono text-[10px]">{formatRatio(ns / jarenNs)} vs Jaren</Badge>
                  )}
                </div>
                <p className="text-xl font-bold font-mono tabular-nums mt-1">{ns == null ? 'n/a' : formatNs(ns)}</p>
              </div>
            );
          })}
        </div>
        {note && <p className="text-xs text-muted-foreground mt-3">{note}</p>}
      </CardContent>
    </Card>
  );
}

CompileCard.propTypes = {
  compile: PropTypes.object,
  engineMeta: PropTypes.array.isRequired,
  note: PropTypes.node,
};

export { ScenarioMatrix, CompileCard };
