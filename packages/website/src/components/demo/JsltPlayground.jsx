import { useMemo, useState } from 'react';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import { createTypeTestCompiler } from '@jarenjs/validate/query';
import { JsonEditor } from './JsonEditor';
import { ExampleChips, TimingBadges, ResultCard, describeEngineError } from './playgroundShared';
import { Badge } from '@components/ui/badge';
import { jsltExamples } from '@lib/playgroundExamples';

const compileTypeTest = createTypeTestCompiler();

/**
 * JSLT stylesheet playground. The headline feature is visible live: when
 * a transform changes nothing, the output IS the input (===), not a copy.
 */
function JsltPlayground() {
  const [stylesheet, setStylesheet] = useState(jsltExamples[1].stylesheet);
  const [document, setDocument] = useState(jsltExamples[1].document);
  const [revision, setRevision] = useState(0);

  const compiled = useMemo(() => {
    try {
      const start = performance.now();
      const transform = compileJsltStylesheet(stylesheet, { compileTypeTest });
      return { transform, compileMs: performance.now() - start, error: null };
    } catch (err) {
      return { transform: null, compileMs: null, error: err };
    }
  }, [stylesheet]);

  const result = useMemo(() => {
    if (!compiled.transform) return null;
    try {
      const start = performance.now();
      const value = compiled.transform(document);
      return { value, runMs: performance.now() - start, shared: value === document, error: null };
    } catch (err) {
      return { value: undefined, runMs: null, shared: false, error: err };
    }
  }, [compiled, document]);

  const loadExample = (example) => {
    setStylesheet(example.stylesheet);
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
      <ExampleChips examples={jsltExamples} onLoad={loadExample} />

      <div className="grid lg:grid-cols-2 gap-6 items-start">
        <div className="space-y-6">
          <JsonEditor
            title="JSLT stylesheet"
            value={stylesheet}
            revision={revision}
            onChange={setStylesheet}
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

        <ResultCard
          title="Output"
          error={error}
          badges={(
            <div className="flex items-center gap-2">
              {result?.shared && (
                <Badge
                  variant="success"
                  title="The transform proved nothing changed and returned the input object itself (output === input) — no copy was made"
                >
                  === input (shared)
                </Badge>
              )}
              <TimingBadges compileMs={compiled.compileMs} runMs={result?.runMs} />
            </div>
          )}
          value={error ? undefined : result?.value}
        />
      </div>

      <p className="text-xs text-muted-foreground">
        JSLT is recursive template dispatch for JSON — XSLT&apos;s idea with JSON&apos;s pieces: JSONPath matches{' '}
        <em>position</em>, JSON Schema matches <em>shape</em> (see the schema-annotate example), query documents
        produce the output. Watch the <code className="bg-muted px-1 rounded">=== input</code> badge: rules that
        change nothing share subtrees instead of copying them, and the identity stylesheet returns the input
        reference in nanoseconds regardless of document size.
      </p>
    </div>
  );
}

export { JsltPlayground };
