import { useMemo, useState } from 'react';
import { parseJosl, stringifyJosl, stringifyJsonx } from '@jarenjs/josl';
import { ExampleChips, TimingBadges, ResultCard } from './playgroundShared';
import { Card, CardHeader, CardTitle, CardContent } from '@components/ui/card';
import { Textarea } from '@components/ui/textarea';
import { Badge } from '@components/ui/badge';
import { cn } from '@lib/utils';
import { joslExamples } from '@lib/playgroundExamples';

const MODES = [
  { key: 'josl', label: 'JOSL' },
  { key: 'toml', label: 'strict TOML' },
];

function describeJoslError(err) {
  if (err == null) return null;
  const parts = [];
  if (typeof err.line === 'number') parts.push(`line: ${err.line}`);
  if (typeof err.column === 'number') parts.push(`column: ${err.column}`);
  if (err.hint) parts.push(`hint: ${err.hint}`);
  return {
    title: err.name ?? 'Error',
    message: err.message,
    detail: parts.length > 0 ? parts.join('\n') : undefined,
  };
}

/**
 * JOSL playground: TOML 1.0 + JavaScript's obvious value types, parsed
 * by the streaming reader. The output panel renders as JSONX (bigints,
 * regexps and datetimes stay first-class), the events panel shows the
 * document-order stream, and the round-trip panel writes the value back.
 */
function JoslPlayground() {
  const [text, setText] = useState(joslExamples[0].text);
  const [mode, setMode] = useState(joslExamples[0].mode);

  const parsed = useMemo(() => {
    const events = [];
    try {
      const start = performance.now();
      const value = parseJosl(text, {
        mode,
        onEvent: (e) => { if (events.length < 200) events.push(e); },
      });
      return { value, events, parseMs: performance.now() - start, error: null };
    } catch (err) {
      return { value: undefined, events, parseMs: null, error: err };
    }
  }, [text, mode]);

  const jsonxView = useMemo(() => {
    if (parsed.error) return null;
    try {
      return stringifyJsonx(parsed.value, { indent: 2 });
    } catch {
      return null;
    }
  }, [parsed]);

  const roundtrip = useMemo(() => {
    if (parsed.error) return null;
    try {
      return { text: stringifyJosl(parsed.value, { mode }), error: null };
    } catch (err) {
      return { text: null, error: err };
    }
  }, [parsed, mode]);

  const loadExample = (example) => {
    setText(example.text);
    setMode(example.mode);
  };

  const error = describeJoslError(parsed.error);

  return (
    <div className="space-y-4">
      <ExampleChips examples={joslExamples} onLoad={loadExample} />

      <div className="grid lg:grid-cols-2 gap-6 items-start">
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <CardTitle className="text-base">JOSL document</CardTitle>
              <div className="flex items-center gap-2">
                <span className="inline-flex rounded-full bg-muted p-0.5">
                  {MODES.map((m) => (
                    <button
                      key={m.key}
                      onClick={() => setMode(m.key)}
                      className={cn(
                        'text-xs px-2.5 py-1 rounded-full transition-colors',
                        mode === m.key ? 'bg-background shadow font-medium' : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {m.label}
                    </button>
                  ))}
                </span>
                {parsed.parseMs != null && <TimingBadges runMs={parsed.parseMs} />}
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              className={cn('font-mono text-sm resize-y min-h-96', parsed.error && 'border-destructive focus-visible:ring-destructive')}
              spellCheck={false}
              aria-label="JOSL editor"
            />
            <p className="text-xs text-muted-foreground">
              Every TOML 1.0 document is valid JOSL. The extensions —{' '}
              <code className="bg-muted px-1 rounded">null</code>,{' '}
              <code className="bg-muted px-1 rounded">123n</code>,{' '}
              <code className="bg-muted px-1 rounded">/regexp/i</code>, the{' '}
              <code className="bg-muted px-1 rounded">[[]]</code> root array — are rejected in strict TOML mode
              with a repair hint. Try switching modes on the first example.
            </p>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <ResultCard
            title="Parsed value"
            error={error}
            badges={<Badge variant="outline" className="text-xs">rendered as JSONX</Badge>}
          >
            {!error && jsonxView != null && (
              <pre className="text-sm font-mono bg-muted/50 border rounded-md p-3 overflow-auto max-h-96">
                <code>{jsonxView}</code>
              </pre>
            )}
          </ResultCard>

          {!error && (
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Document-order events</CardTitle>
                  <Badge variant="outline" className="text-xs">{parsed.events.length}{parsed.events.length === 200 ? '+' : ''} events</Badge>
                </div>
              </CardHeader>
              <CardContent>
                <div className="text-xs font-mono space-y-1 overflow-auto max-h-48">
                  {parsed.events.slice(0, 30).map((e, i) => (
                    <div key={i} className="flex gap-2 items-baseline">
                      <span className="text-muted-foreground w-20 shrink-0">{e.type}</span>
                      <span className="truncate">
                        /{e.path.join('/')}
                        {e.type === 'pair' && <span className="text-muted-foreground"> = {String(e.value)}</span>}
                      </span>
                    </div>
                  ))}
                  {parsed.events.length > 30 && (
                    <div className="text-muted-foreground">… {parsed.events.length - 30} more</div>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-3">
                  The streaming reader fires these in document order, with absolute JSON-Pointer-able paths, the
                  moment each line completes — chunks may split any token. The opposite of{' '}
                  <code className="bg-muted px-1 rounded">JSON.parse</code>&apos;s bottom-up reviver.
                </p>
              </CardContent>
            </Card>
          )}

          {!error && roundtrip != null && (
            <ResultCard
              title="Round-trip"
              error={describeJoslError(roundtrip.error)}
              badges={<Badge variant="outline" className="text-xs">stringifyJosl(value)</Badge>}
            >
              {roundtrip.text != null && (
                <pre className="text-sm font-mono bg-muted/50 border rounded-md p-3 overflow-auto max-h-64">
                  <code>{roundtrip.text}</code>
                </pre>
              )}
            </ResultCard>
          )}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        JOSL is a research experiment: a strict TOML 1.0 superset for LLM-to-LLM pipelines. In strict mode the
        same engine passes the complete official toml-test 1.0.0 suite — see the{' '}
        <a className="underline" href="https://github.com/jklarenbeek/jarenjs/blob/main/packages/josl/FORMAT.md" target="_blank" rel="noopener noreferrer">
          FORMAT.md
        </a>{' '}
        language definition.
      </p>
    </div>
  );
}

export { JoslPlayground };
