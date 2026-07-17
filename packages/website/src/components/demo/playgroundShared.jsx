import PropTypes from 'prop-types';
import { Card, CardHeader, CardTitle, CardContent } from '@components/ui/card';
import { Badge } from '@components/ui/badge';
import { CheckCircle2, AlertCircle } from 'lucide-react';
import { cn } from '@lib/utils';

/** Row of example-loader chips, shared by every engine playground. */
function ExampleChips({ examples, onLoad, label = 'Examples:' }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      {examples.map((example, i) => (
        <button
          key={example.name}
          onClick={() => onLoad(example, i)}
          className="text-xs px-2.5 py-1 rounded-full bg-muted hover:bg-primary/10 hover:text-primary transition-colors"
        >
          {example.name}
        </button>
      ))}
    </div>
  );
}

ExampleChips.propTypes = {
  examples: PropTypes.array.isRequired,
  onLoad: PropTypes.func.isRequired,
  label: PropTypes.string,
};

/** Compile/run timing chips. Values in milliseconds. */
function TimingBadges({ compileMs, runMs }) {
  const fmt = (ms) => (ms < 0.05 ? '<0.05' : ms.toFixed(ms < 1 ? 2 : 1));
  return (
    <span className="inline-flex gap-1.5">
      {compileMs != null && (
        <Badge variant="outline" title="Time to compile (once)">compile {fmt(compileMs)}ms</Badge>
      )}
      {runMs != null && (
        <Badge variant="outline" title="Time to run against the document">run {fmt(runMs)}ms</Badge>
      )}
    </span>
  );
}

TimingBadges.propTypes = {
  compileMs: PropTypes.number,
  runMs: PropTypes.number,
};

/**
 * Result panel: pretty-printed JSON output with a status header. `error`
 * takes over the panel when set ({ title, message, detail }).
 */
function ResultCard({ title = 'Result', ok = true, error, badges, children, value }) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <CardTitle className="text-base flex items-center gap-2">
            {title}
            {error ? (
              <Badge variant="destructive"><AlertCircle className="h-3 w-3 mr-1" />{error.title ?? 'Error'}</Badge>
            ) : ok ? (
              <Badge variant="success"><CheckCircle2 className="h-3 w-3 mr-1" />OK</Badge>
            ) : null}
          </CardTitle>
          {badges}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? (
          <div className="text-sm text-destructive space-y-1">
            <p className="font-medium whitespace-pre-wrap break-words">{error.message}</p>
            {error.detail && (
              <pre className="text-xs bg-destructive/5 border border-destructive/20 rounded-md p-2 overflow-x-auto whitespace-pre-wrap">{error.detail}</pre>
            )}
          </div>
        ) : (
          <>
            {children}
            {value !== undefined && (
              <pre className={cn('text-sm font-mono bg-muted/50 border rounded-md p-3 overflow-auto max-h-96')}>
                <code>{JSON.stringify(value, null, 2) ?? 'undefined'}</code>
              </pre>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

ResultCard.propTypes = {
  title: PropTypes.node,
  ok: PropTypes.bool,
  error: PropTypes.shape({
    title: PropTypes.string,
    message: PropTypes.string,
    detail: PropTypes.string,
  }),
  badges: PropTypes.node,
  children: PropTypes.node,
  value: PropTypes.any,
};

/** Format a Jaren compile/runtime error into the ResultCard error shape. */
function describeEngineError(err, fallbackTitle) {
  if (err == null) return null;
  const parts = [];
  if (err.code) parts.push(`code: ${err.code}`);
  if (err.docPath !== undefined && err.docPath !== null) parts.push(`docPath: ${err.docPath === '' ? '"" (document root)' : err.docPath}`);
  if (err.dataPath !== undefined && err.dataPath !== null) parts.push(`dataPath: ${err.dataPath === '' ? '"" (document root)' : err.dataPath}`);
  if (typeof err.position === 'number') parts.push(`position: ${err.position}`);
  return {
    title: err.code ?? fallbackTitle ?? err.name ?? 'Error',
    message: err.message,
    detail: parts.length > 0 ? parts.join('\n') : undefined,
  };
}

export { ExampleChips, TimingBadges, ResultCard, describeEngineError };
