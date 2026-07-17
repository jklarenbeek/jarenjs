import { useMemo, useState } from 'react';
import { compileJSONPath } from '@jarenjs/json';
import { JsonEditor } from './JsonEditor';
import { ExampleChips, TimingBadges, ResultCard, describeEngineError } from './playgroundShared';
import { Input } from '@components/ui/input';
import { Badge } from '@components/ui/badge';
import { pathExamples } from '@lib/playgroundExamples';

/**
 * Live RFC 9535 JSONPath playground: one compiled query, values and
 * normalized paths side by side.
 */
function PathPlayground() {
  const [selector, setSelector] = useState(pathExamples[0].selector);
  const [document, setDocument] = useState(pathExamples[0].document);
  const [revision, setRevision] = useState(0);
  const [showPaths, setShowPaths] = useState(true);

  const compiled = useMemo(() => {
    try {
      const start = performance.now();
      const query = compileJSONPath(selector);
      return { query, compileMs: performance.now() - start, error: null };
    } catch (err) {
      return { query: null, compileMs: null, error: err };
    }
  }, [selector]);

  const result = useMemo(() => {
    if (!compiled.query) return null;
    try {
      const start = performance.now();
      // query.nodes(data) -> [{ path, value }, ...] with normalized paths
      const nodes = compiled.query.nodes(document);
      return { nodes, runMs: performance.now() - start, error: null };
    } catch (err) {
      return { nodes: null, runMs: null, error: err };
    }
  }, [compiled, document]);

  const loadExample = (example) => {
    setSelector(example.selector);
    setDocument(example.document);
    setRevision((r) => r + 1);
  };

  const error = compiled.error
    ? describeEngineError(compiled.error, 'Syntax error')
    : result?.error
      ? describeEngineError(result.error, 'Runtime error')
      : null;

  return (
    <div className="space-y-4">
      <ExampleChips examples={pathExamples} onLoad={loadExample} />

      <div className="space-y-2">
        <label htmlFor="jsonpath-selector" className="text-sm font-medium">JSONPath selector</label>
        <Input
          id="jsonpath-selector"
          value={selector}
          onChange={(e) => setSelector(e.target.value)}
          className="font-mono"
          placeholder="$.store.book[?@.price < 10].title"
          spellCheck={false}
        />
        {compiled.error?.position !== undefined && (
          <pre className="text-xs text-destructive font-mono leading-tight">
            {selector + '\n' + ' '.repeat(Math.max(compiled.error.position, 0)) + '^'}
          </pre>
        )}
      </div>

      <div className="grid lg:grid-cols-2 gap-6 items-start">
        <JsonEditor
          title="Document"
          value={document}
          revision={revision}
          onChange={setDocument}
          minHeight={420}
        />

        <ResultCard
          title="Nodelist"
          error={error}
          badges={(
            <div className="flex items-center gap-2">
              {result?.nodes && <Badge variant="secondary">{result.nodes.length} node{result.nodes.length === 1 ? '' : 's'}</Badge>}
              <TimingBadges compileMs={compiled.compileMs} runMs={result?.runMs} />
              <label className="flex items-center gap-1.5 text-xs">
                <input type="checkbox" checked={showPaths} onChange={(e) => setShowPaths(e.target.checked)} className="rounded" />
                normalized paths
              </label>
            </div>
          )}
        >
          {result?.nodes && (
            showPaths ? (
              <div className="space-y-2 max-h-96 overflow-auto">
                {result.nodes.length === 0 && (
                  <p className="text-sm text-muted-foreground">Empty nodelist — the selector matched nothing.</p>
                )}
                {result.nodes.map((node, i) => (
                  <div key={i} className="border rounded-md p-2 bg-muted/30">
                    <code className="text-xs text-primary break-all">{node.path}</code>
                    <pre className="text-sm font-mono mt-1 overflow-x-auto"><code>{JSON.stringify(node.value)}</code></pre>
                  </div>
                ))}
              </div>
            ) : (
              <pre className="text-sm font-mono bg-muted/50 border rounded-md p-3 overflow-auto max-h-96">
                <code>{JSON.stringify(result.nodes.map((node) => node.value), null, 2)}</code>
              </pre>
            )
          )}
        </ResultCard>
      </div>

      <p className="text-xs text-muted-foreground">
        Fully compliant with RFC 9535 — all 703 tests of the official compliance suite, normalized paths included.
        The selector compiles once into a specialized closure; typing in the document re-runs the compiled query only.
      </p>
    </div>
  );
}

export { PathPlayground };
