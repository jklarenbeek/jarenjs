import { useMemo, useState } from 'react';
import { compileJtltStylesheet } from '@jarenjs/json/jtlt';
import { createTypeTestCompiler } from '@jarenjs/validate/query';
import { JsonEditor } from './JsonEditor';
import { ExampleChips, TimingBadges, ResultCard, describeEngineError } from './playgroundShared';
import { Badge } from '@components/ui/badge';
import { jtltExamples } from '@lib/playgroundExamples';

const compileTypeTest = createTypeTestCompiler();

/**
 * JTLT template playground. The output panel shows the rendered STRING
 * (not JSON), and the compiled-to-JSLT stylesheet is one click away —
 * the front-end story made visible.
 */
function JtltPlayground() {
  const [template, setTemplate] = useState(jtltExamples[0].template);
  const [document, setDocument] = useState(jtltExamples[0].document);
  const [revision, setRevision] = useState(0);

  const compiled = useMemo(() => {
    try {
      const start = performance.now();
      const render = compileJtltStylesheet(template, { compileTypeTest });
      return { render, compileMs: performance.now() - start, error: null };
    } catch (err) {
      return { render: null, compileMs: null, error: err };
    }
  }, [template]);

  const result = useMemo(() => {
    if (!compiled.render) return null;
    try {
      const start = performance.now();
      const text = compiled.render(document);
      return { text, runMs: performance.now() - start, error: null };
    } catch (err) {
      return { text: null, runMs: null, error: err };
    }
  }, [compiled, document]);

  const loadExample = (example) => {
    setTemplate(example.template);
    setDocument(example.document);
    setRevision((r) => r + 1);
  };

  const error = compiled.error
    ? describeEngineError(compiled.error, 'Compile error')
    : result?.error
      ? describeEngineError(result.error, 'Runtime error')
      : null;

  return (
    <div className="space-y-4">
      <ExampleChips examples={jtltExamples} onLoad={loadExample} />

      <div className="grid lg:grid-cols-2 gap-6 items-start">
        <div className="space-y-6">
          <JsonEditor
            title="JTLT template"
            value={template}
            revision={revision}
            onChange={setTemplate}
            minHeight={300}
          />
          <JsonEditor
            title="Input document"
            value={document}
            revision={revision}
            onChange={setDocument}
            minHeight={220}
          />
        </div>

        <div className="space-y-4">
          <ResultCard
            title="Rendered text"
            error={error}
            badges={(
              <div className="flex items-center gap-2">
                {compiled.render && (
                  <Badge
                    variant="secondary"
                    title="The template's output method: text writes everything raw, xml escapes interpolated data while literal markup stays raw"
                  >
                    output: {compiled.render.output}
                  </Badge>
                )}
                <TimingBadges compileMs={compiled.compileMs} runMs={result?.runMs} />
              </div>
            )}
          >
            {!error && result != null && (
              <pre className="text-sm font-mono bg-muted/50 border rounded-md p-3 overflow-auto max-h-96 whitespace-pre-wrap break-words">
                {result.text === '' ? <span className="text-muted-foreground italic">(empty string)</span> : result.text}
              </pre>
            )}
          </ResultCard>

          {compiled.render && (
            <details className="rounded-lg border bg-card px-4 py-3">
              <summary className="text-sm font-medium cursor-pointer select-none">
                The compiled JSLT stylesheet
              </summary>
              <p className="text-xs text-muted-foreground mt-2 mb-2">
                JTLT is a front-end, not a second engine: your template desugars into this ordinary
                JSLT stylesheet (segments become tagged constructors, the XSLT-style built-in rules
                are appended per mode), and a writer serializes the dispatched result.
              </p>
              <pre className="text-xs font-mono bg-muted/50 border rounded-md p-3 overflow-auto max-h-72">
                <code>{JSON.stringify(compiled.render.stylesheet, null, 2)}</code>
              </pre>
            </details>
          )}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        JTLT points the JSLT dispatcher at <em>text</em>: rule bodies are segment lists — literal strings pass
        through raw, <code className="bg-muted px-1 rounded">$</code>-strings interpolate query results,{' '}
        <code className="bg-muted px-1 rounded">{'{"$apply": …}'}</code> splices other rules&apos; output. Under{' '}
        <code className="bg-muted px-1 rounded">&quot;output&quot;: &quot;xml&quot;</code> interpolated data is escaped while
        literal markup stays raw (the T4/XSLT contract); unmatched containers recurse and unmatched atoms emit
        their text, so <code className="bg-muted px-1 rounded">$apply</code> doubles as a value-of with rule
        override.
      </p>
    </div>
  );
}

export { JtltPlayground };
