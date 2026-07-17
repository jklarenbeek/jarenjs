import { useMemo, useState } from 'react';
import { parseXQuery } from '@jarenjs/json/xquery';
import { compileJsonQuery } from '@jarenjs/json';
import { JsonEditor } from './JsonEditor';
import { ExampleChips, TimingBadges, ResultCard, describeEngineError } from './playgroundShared';
import { Card, CardHeader, CardTitle, CardContent } from '@components/ui/card';
import { Textarea } from '@components/ui/textarea';
import { Badge } from '@components/ui/badge';
import { cn } from '@lib/utils';
import { xqueryExamples } from '@lib/playgroundExamples';

/**
 * XQuery text front-end playground: type XQuery 3.1, watch it become a
 * Jaren query document, and run that document against a JSON value with
 * $doc bound to it. Three panels, one pipeline.
 */
function XQueryPlayground() {
  const [text, setText] = useState(xqueryExamples[0].text);
  const [document, setDocument] = useState(xqueryExamples[0].document);
  const [revision, setRevision] = useState(0);

  const parsed = useMemo(() => {
    try {
      const start = performance.now();
      const doc = parseXQuery(text);
      return { doc, parseMs: performance.now() - start, error: null };
    } catch (err) {
      return { doc: null, parseMs: null, error: err };
    }
  }, [text]);

  const compiled = useMemo(() => {
    if (!parsed.doc) return null;
    try {
      return { fn: compileJsonQuery(parsed.doc), error: null };
    } catch (err) {
      return { fn: null, error: err };
    }
  }, [parsed]);

  const result = useMemo(() => {
    if (!compiled?.fn) return null;
    try {
      const start = performance.now();
      const externals = {};
      for (const name of compiled.fn.externals) {
        if (name === 'doc') externals.doc = document;
      }
      const value = compiled.fn(document, externals);
      return { value, runMs: performance.now() - start, error: null };
    } catch (err) {
      return { value: undefined, runMs: null, error: err };
    }
  }, [compiled, document]);

  const loadExample = (example) => {
    setText(example.text);
    setDocument(example.document);
    setRevision((r) => r + 1);
  };

  const unboundExternals = (compiled?.fn?.externals ?? []).filter((name) => name !== 'doc');

  const error = parsed.error
    ? describeEngineError(parsed.error, 'XQuery syntax error')
    : compiled?.error
      ? describeEngineError(compiled.error, 'Compile error')
      : result?.error
        ? describeEngineError(result.error, 'Runtime error')
        : null;

  return (
    <div className="space-y-4">
      <ExampleChips examples={xqueryExamples} onLoad={loadExample} />

      <div className="grid lg:grid-cols-2 gap-6 items-start">
        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">XQuery 3.1 (text subset)</CardTitle>
                {parsed.parseMs != null && <TimingBadges compileMs={parsed.parseMs} />}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                className={cn('font-mono text-sm resize-y min-h-44', parsed.error && 'border-destructive focus-visible:ring-destructive')}
                spellCheck={false}
                aria-label="XQuery editor"
              />
              <p className="text-xs text-muted-foreground">
                The document is reached through the free variable <code className="bg-muted px-1 rounded">$doc</code>{' '}
                (bound automatically here). Constructs outside the subset fail with a named{' '}
                <code className="bg-muted px-1 rounded">unsupported construct</code> error — try{' '}
                <code className="bg-muted px-1 rounded">{"//book"}</code>.
              </p>
            </CardContent>
          </Card>

          <JsonEditor
            title="Document ($doc)"
            value={document}
            revision={revision}
            onChange={setDocument}
            minHeight={200}
          />
        </div>

        <div className="space-y-6">
          <ResultCard
            title="Emitted query document"
            error={parsed.error ? error : null}
            badges={<Badge variant="outline" className="text-xs">parseXQuery(text)</Badge>}
            value={parsed.error ? undefined : parsed.doc}
          />

          {!parsed.error && (
            <ResultCard
              title="Result"
              error={error}
              badges={(
                <div className="flex items-center gap-2">
                  {unboundExternals.length > 0 && (
                    <Badge variant="warning" title="Free variables other than $doc are unbound in this playground">
                      unbound: {unboundExternals.map((n) => `$${n}`).join(', ')}
                    </Badge>
                  )}
                  <TimingBadges runMs={result?.runMs} />
                </div>
              )}
              value={error ? undefined : result?.value}
            >
              {!error && result?.value === undefined && (
                <p className="text-sm text-muted-foreground">Empty sequence.</p>
              )}
            </ResultCard>
          )}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        The same parser bridges Jaren to the W3C QT3 test suite: 31,821 official XQuery/XPath cases run through this
        front-end with zero unattributed failures. The emitted document is plain JSON — hand it to the query engine,
        embed it in a schema&apos;s <code className="bg-muted px-1 rounded">$query</code>, or store it.
      </p>
    </div>
  );
}

export { XQueryPlayground };
