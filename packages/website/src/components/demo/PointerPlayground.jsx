import { useMemo, useState } from 'react';
import {
  compileJSONPointer,
  compileRelativeJSONPointer,
  JSONPOINTER_NOTHING,
} from '@jarenjs/json';
import { JsonEditor } from './JsonEditor';
import { ExampleChips, TimingBadges, ResultCard, describeEngineError } from './playgroundShared';
import { Input } from '@components/ui/input';
import { Badge } from '@components/ui/badge';
import { cn } from '@lib/utils';
import { pointerExamples } from '@lib/playgroundExamples';

/**
 * RFC 6901 JSON Pointer playground, including relative pointers (the
 * draft the validator's $data keyword walks with).
 */
function PointerPlayground() {
  const [mode, setMode] = useState(pointerExamples[0].mode);
  const [pointer, setPointer] = useState(pointerExamples[0].pointer);
  const [location, setLocation] = useState('/store/book/0/title');
  const [document, setDocument] = useState(pointerExamples[0].document);
  const [revision, setRevision] = useState(0);

  const outcome = useMemo(() => {
    try {
      const start = performance.now();
      const getter = mode === 'absolute'
        ? compileJSONPointer(pointer)
        : compileRelativeJSONPointer(pointer);
      const compileMs = performance.now() - start;

      const runStart = performance.now();
      const value = mode === 'absolute' ? getter(document) : getter(document, location);
      const runMs = performance.now() - runStart;
      return { value, compileMs, runMs, error: null };
    } catch (err) {
      return { value: undefined, compileMs: null, runMs: null, error: err };
    }
  }, [mode, pointer, location, document]);

  const loadExample = (example) => {
    setMode(example.mode);
    setPointer(example.pointer);
    if (example.location) setLocation(example.location);
    setDocument(example.document);
    setRevision((r) => r + 1);
  };

  const notFound = !outcome.error && outcome.value === JSONPOINTER_NOTHING;
  const error = describeEngineError(outcome.error, 'Syntax error');

  return (
    <div className="space-y-4">
      <ExampleChips examples={pointerExamples} onLoad={loadExample} />

      <div className="flex flex-wrap gap-3 items-end">
        <div className="flex rounded-lg border overflow-hidden">
          {['absolute', 'relative'].map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={cn(
                'px-3 py-1.5 text-sm font-medium transition-colors',
                mode === m ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/70',
              )}
            >
              {m}
            </button>
          ))}
        </div>
        <div className="flex-1 min-w-48 space-y-1">
          <label htmlFor="pointer-input" className="text-xs font-medium text-muted-foreground">
            {mode === 'absolute' ? 'JSON Pointer (RFC 6901)' : 'Relative JSON Pointer'}
          </label>
          <Input
            id="pointer-input"
            value={pointer}
            onChange={(e) => setPointer(e.target.value)}
            className="font-mono"
            placeholder={mode === 'absolute' ? '/store/book/0/title' : '1/price'}
            spellCheck={false}
          />
        </div>
        {mode === 'relative' && (
          <div className="flex-1 min-w-48 space-y-1">
            <label htmlFor="pointer-location" className="text-xs font-medium text-muted-foreground">
              Evaluated from location (absolute pointer)
            </label>
            <Input
              id="pointer-location"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              className="font-mono"
              placeholder="/store/book/0/title"
              spellCheck={false}
            />
          </div>
        )}
      </div>

      <div className="grid lg:grid-cols-2 gap-6 items-start">
        <JsonEditor
          title="Document"
          value={document}
          revision={revision}
          onChange={setDocument}
          minHeight={360}
        />

        <ResultCard
          title="Value"
          error={error}
          ok={!notFound}
          badges={(
            <div className="flex items-center gap-2">
              {notFound && <Badge variant="warning">not found</Badge>}
              <TimingBadges compileMs={outcome.compileMs} runMs={outcome.runMs} />
            </div>
          )}
          value={error || notFound ? undefined : outcome.value}
        >
          {notFound && (
            <p className="text-sm text-muted-foreground">
              The pointer resolves to nothing. Compiled getters return a shared <code className="bg-muted px-1 rounded">NOTHING</code>{' '}
              sentinel instead of throwing or allocating — this is the zero-allocation miss path the validator&apos;s{' '}
              <code className="bg-muted px-1 rounded">$data</code> keyword relies on.
            </p>
          )}
        </ResultCard>
      </div>

      <p className="text-xs text-muted-foreground">
        Pointers compile to specialized getters (0, 1, 2 segments are unrolled) with member names pre-decoded and
        array indexes pre-parsed — 12–16× faster than interpretive resolution. Relative pointers are the{' '}
        <code className="bg-muted px-1 rounded">$data</code> hot path: <code className="bg-muted px-1 rounded">1/price</code>{' '}
        means &quot;up one level from the location, then down <code className="bg-muted px-1 rounded">/price</code>&quot;;{' '}
        <code className="bg-muted px-1 rounded">0#</code> names the key you are standing on.
      </p>
    </div>
  );
}

export { PointerPlayground };
