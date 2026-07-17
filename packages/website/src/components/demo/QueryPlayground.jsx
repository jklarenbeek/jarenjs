import { useMemo, useState } from 'react';
import { compileJsonQuery } from '@jarenjs/json';
import { createTypeTestCompiler } from '@jarenjs/validate/query';
import { JsonEditor } from './JsonEditor';
import { ExampleChips, TimingBadges, ResultCard, describeEngineError } from './playgroundShared';
import { Badge } from '@components/ui/badge';
import { queryExamples } from '@lib/playgroundExamples';

// One hook for the session: compiles JSON Schema literals inside
// $valid/$assert/$as into boolean predicates using the real validator.
const compileTypeTest = createTypeTestCompiler();

/**
 * Jaren JSON Query playground: FLWOR, joins, grouping, quantifiers and
 * schema-typed operators, compiled once per edit and re-run per keystroke.
 */
function QueryPlayground() {
  const [query, setQuery] = useState(queryExamples[0].query);
  const [document, setDocument] = useState(queryExamples[0].document);
  const [externals, setExternals] = useState({});
  const [revision, setRevision] = useState(0);

  const compiled = useMemo(() => {
    try {
      const start = performance.now();
      const fn = compileJsonQuery(query, { compileTypeTest });
      return { fn, compileMs: performance.now() - start, error: null };
    } catch (err) {
      return { fn: null, compileMs: null, error: err };
    }
  }, [query]);

  const result = useMemo(() => {
    if (!compiled.fn) return null;
    try {
      const start = performance.now();
      const value = compiled.fn(document, externals);
      return { value, runMs: performance.now() - start, error: null };
    } catch (err) {
      return { value: undefined, runMs: null, error: err };
    }
  }, [compiled, document, externals]);

  const loadExample = (example) => {
    setQuery(example.query);
    setDocument(example.document);
    setExternals(example.externals ?? {});
    setRevision((r) => r + 1);
  };

  const needsExternals = (compiled.fn?.externals?.length ?? 0) > 0;
  const error = compiled.error
    ? describeEngineError(compiled.error, 'Compile error')
    : result?.error
      ? describeEngineError(result.error, 'Runtime error')
      : null;

  const itemCount = result?.value === undefined ? 0 : Array.isArray(result.value) ? result.value.length : 1;

  return (
    <div className="space-y-4">
      <ExampleChips examples={queryExamples} onLoad={loadExample} />

      <div className="grid lg:grid-cols-2 gap-6 items-start">
        <div className="space-y-6">
          <JsonEditor
            title="Query document"
            value={query}
            revision={revision}
            onChange={setQuery}
            minHeight={300}
          />
          {(needsExternals || Object.keys(externals).length > 0) && (
            <JsonEditor
              title={(
                <span>
                  Externals
                  {compiled.fn?.externals?.map((name) => (
                    <Badge key={name} variant="outline" className="ml-2 font-mono text-xs">${name}</Badge>
                  ))}
                </span>
              )}
              value={externals}
              revision={revision}
              onChange={setExternals}
              minHeight={100}
            />
          )}
        </div>

        <div className="space-y-6">
          <JsonEditor
            title="Document"
            value={document}
            revision={revision}
            onChange={setDocument}
            minHeight={300}
          />

          <ResultCard
            title="Result sequence"
            error={error}
            badges={(
              <div className="flex items-center gap-2">
                <Badge variant="secondary">{itemCount} item{itemCount === 1 ? '' : 's'}</Badge>
                <TimingBadges compileMs={compiled.compileMs} runMs={result?.runMs} />
              </div>
            )}
            value={error ? undefined : result?.value}
          >
            {!error && result?.value === undefined && (
              <p className="text-sm text-muted-foreground">Empty sequence.</p>
            )}
          </ResultCard>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        The Jaren JSON Query format is XQuery 3.1 semantics — FLWOR phrases, joins, grouping, quantifiers, a
        58-operator library — written as JSON documents with JSONPath leaves. Compile and runtime errors carry a stable{' '}
        <code className="bg-muted px-1 rounded">code</code> and a <code className="bg-muted px-1 rounded">docPath</code>{' '}
        JSON Pointer into the query document (try breaking one — e.g. misspell an operator for a &quot;did you mean&quot;).
        The <code className="bg-muted px-1 rounded">$valid</code> example type-checks items with a real compiled JSON
        Schema — the validator plugged in through the <code className="bg-muted px-1 rounded">compileTypeTest</code> hook.
      </p>
    </div>
  );
}

export { QueryPlayground };
