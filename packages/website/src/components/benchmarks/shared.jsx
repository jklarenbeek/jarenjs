import { useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { Card, CardContent, CardHeader, CardTitle } from '@components/ui/card';
import { Badge } from '@components/ui/badge';
import { cn, formatNs, formatRatio } from '@lib/utils';
import { Loader2, Info, TerminalSquare } from 'lucide-react';

/**
 * Shared building blocks for the benchmark drill-downs.
 *
 * Color rules (see src/index.css --viz-* tokens): blue is the "Jaren
 * faster" arm and the Jaren series, red the "competitor faster" arm,
 * green the competitor series in paired-bar contexts. Color never
 * carries a value alone — every mark has its number printed next to it.
 */

//#region stat tiles

function StatCard({ label, value, sub, tone = 'default' }) {
  return (
    <Card>
      <CardContent className="pt-5 pb-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <p
          className={cn(
            'text-2xl font-bold mt-1',
            tone === 'good' && 'text-[var(--viz-faster)]',
            tone === 'bad' && 'text-[var(--viz-slower)]',
          )}
        >
          {value}
        </p>
        {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
      </CardContent>
    </Card>
  );
}

StatCard.propTypes = {
  label: PropTypes.string.isRequired,
  value: PropTypes.node.isRequired,
  sub: PropTypes.node,
  tone: PropTypes.oneOf(['default', 'good', 'bad']),
};

//#endregion

//#region ratio marks

/**
 * A ratio pill. ratio > 1 = Jaren faster (blue), < 1 = competitor faster
 * (red). The direction word makes the color redundant, never load-bearing.
 */
function RatioBadge({ ratio, rival = 'rival', compact = false }) {
  if (ratio == null || !Number.isFinite(ratio)) {
    return <Badge variant="outline" className="font-mono text-xs">n/a</Badge>;
  }
  const jarenFaster = ratio >= 1;
  const display = jarenFaster ? ratio : 1 / ratio;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium font-mono whitespace-nowrap',
        jarenFaster
          ? 'bg-[var(--viz-faster)]/10 text-[var(--viz-faster)]'
          : 'bg-[var(--viz-slower)]/10 text-[var(--viz-slower)]',
      )}
      title={jarenFaster
        ? `Jaren is ${formatRatio(display)} faster than ${rival} here`
        : `${rival} is ${formatRatio(display)} faster than Jaren here`}
    >
      {formatRatio(display)}
      {!compact && <span className="font-sans font-normal">{jarenFaster ? 'faster' : 'slower'}</span>}
    </span>
  );
}

RatioBadge.propTypes = {
  ratio: PropTypes.number,
  rival: PropTypes.string,
  compact: PropTypes.bool,
};

/**
 * Log-scale diverging bar centered on 1x. The right arm (blue) grows with
 * how much faster Jaren is, the left arm (red) with how much faster the
 * competitor is. maxLog caps the scale (e.g. 64x fills the arm).
 */
function DivergingBar({ ratio, maxLog = 6, className }) {
  if (ratio == null || !Number.isFinite(ratio) || ratio <= 0) {
    return <div className={cn('h-2 rounded-full bg-[var(--viz-track)]', className)} />;
  }
  const log = Math.log2(ratio);
  const half = Math.min(Math.abs(log) / maxLog, 1) * 50;
  const jarenFaster = log >= 0;
  return (
    <div
      className={cn('relative h-2 rounded-full bg-[var(--viz-track)] overflow-hidden', className)}
      role="img"
      aria-label={jarenFaster
        ? `Jaren ${formatRatio(ratio)} faster`
        : `Competitor ${formatRatio(1 / ratio)} faster`}
    >
      <div
        className="absolute top-0 h-full"
        style={jarenFaster
          ? { left: '50%', width: `${half}%`, background: 'var(--viz-faster)', borderRadius: '0 4px 4px 0' }
          : { right: '50%', width: `${half}%`, background: 'var(--viz-slower)', borderRadius: '4px 0 0 4px' }}
      />
      <div className="absolute top-0 left-1/2 h-full w-px bg-[var(--viz-midline)]" />
    </div>
  );
}

DivergingBar.propTypes = {
  ratio: PropTypes.number,
  maxLog: PropTypes.number,
  className: PropTypes.string,
};

/**
 * Two labeled horizontal time bars (Jaren vs one competitor), scaled to
 * the slower of the two. Times are printed — the bars only shape them.
 */
function PairedTimeBars({ jarenNs, rivalNs, jarenLabel = 'Jaren', rivalLabel }) {
  const max = Math.max(jarenNs ?? 0, rivalNs ?? 0) || 1;
  const row = (label, ns, color) => (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-28 shrink-0 truncate text-muted-foreground" title={label}>{label}</span>
      <div className="flex-1 h-2 rounded-full bg-[var(--viz-track)] overflow-hidden">
        {ns != null && (
          <div
            className="h-full rounded-full"
            style={{ width: `${Math.max((ns / max) * 100, 1)}%`, background: color }}
          />
        )}
      </div>
      <span className="w-20 shrink-0 text-right font-mono tabular-nums">{formatNs(ns)}</span>
    </div>
  );
  return (
    <div className="space-y-1.5">
      {row(jarenLabel, jarenNs, 'var(--viz-jaren)')}
      {row(rivalLabel, rivalNs, 'var(--viz-rival)')}
    </div>
  );
}

PairedTimeBars.propTypes = {
  jarenNs: PropTypes.number,
  rivalNs: PropTypes.number,
  jarenLabel: PropTypes.string,
  rivalLabel: PropTypes.string.isRequired,
};

//#endregion

//#region distribution

const HISTO_BUCKETS = [
  { label: '≤ ¼×', test: (r) => r <= 0.25 },
  { label: '¼–½×', test: (r) => r > 0.25 && r <= 0.5 },
  { label: '½–1×', test: (r) => r > 0.5 && r < 1 },
  { label: '1–2×', test: (r) => r >= 1 && r < 2 },
  { label: '2–4×', test: (r) => r >= 2 && r < 4 },
  { label: '≥ 4×', test: (r) => r >= 4 },
];

/**
 * Distribution of per-test speed ratios around the 1x midline. Left arm
 * (red) = competitor faster, right arm (blue) = Jaren faster.
 */
function RatioHistogram({ ratios, rival = 'the competitor' }) {
  const buckets = useMemo(() => HISTO_BUCKETS.map((bucket) => ({
    ...bucket,
    count: ratios.filter(bucket.test).length,
  })), [ratios]);
  const max = Math.max(...buckets.map((b) => b.count), 1);

  return (
    <div>
      <div className="flex items-end gap-1.5 h-28" role="img"
        aria-label={`Distribution of per-test speed ratios vs ${rival}`}>
        {buckets.map((bucket, i) => (
          <div key={bucket.label} className="flex-1 flex flex-col items-center justify-end gap-1 h-full"
            title={`${bucket.count} tests in ${bucket.label} (${i < 3 ? `${rival} faster` : 'Jaren faster'})`}>
            <span className="text-[10px] font-mono tabular-nums text-muted-foreground">{bucket.count}</span>
            <div
              className="w-full rounded-t-[4px]"
              style={{
                height: `${Math.max((bucket.count / max) * 100, 2)}%`,
                background: i < 3 ? 'var(--viz-slower)' : 'var(--viz-faster)',
              }}
            />
          </div>
        ))}
      </div>
      <div className="flex gap-1.5 mt-1 border-t pt-1">
        {buckets.map((bucket) => (
          <span key={bucket.label} className="flex-1 text-center text-[10px] text-muted-foreground">{bucket.label}</span>
        ))}
      </div>
      <div className="flex justify-between text-[11px] mt-1">
        <span className="text-[var(--viz-slower)]">← {rival} faster</span>
        <span className="text-[var(--viz-faster)]">Jaren faster →</span>
      </div>
    </div>
  );
}

RatioHistogram.propTypes = {
  ratios: PropTypes.arrayOf(PropTypes.number).isRequired,
  rival: PropTypes.string,
};

//#endregion

//#region chrome

function MetaStrip({ meta, command }) {
  if (!meta) return null;
  const date = meta.generated ? new Date(meta.generated).toLocaleDateString() : null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {date && <span>Measured {date}</span>}
      {meta.node && <span>Node {meta.node}</span>}
      {meta.cpu && <span className="hidden sm:inline">{meta.cpu}</span>}
      {meta.quick && (
        <Badge variant="warning" className="text-[10px]">
          quick run — low iteration counts
        </Badge>
      )}
      {command && (
        <span className="inline-flex items-center gap-1 font-mono">
          <TerminalSquare className="h-3 w-3" />
          {command}
        </span>
      )}
    </div>
  );
}

MetaStrip.propTypes = {
  meta: PropTypes.object,
  command: PropTypes.string,
};

function MethodologyCard({ title = 'Methodology & honesty notes', children }) {
  return (
    <Card className="bg-muted/30">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Info className="h-4 w-4" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground space-y-2">
        {children}
      </CardContent>
    </Card>
  );
}

MethodologyCard.propTypes = {
  title: PropTypes.string,
  children: PropTypes.node,
};

function BenchmarkFallback({ loading, name }) {
  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="h-10 w-10 animate-spin mb-3 text-primary" />
        <p>Loading benchmark data…</p>
      </div>
    );
  }
  return (
    <Card>
      <CardContent className="py-12 text-center space-y-2">
        <p className="font-medium">No benchmark data found for this suite.</p>
        <p className="text-sm text-muted-foreground">
          Generate it from the repository root with
          {' '}<code className="bg-muted px-1.5 py-0.5 rounded">npm run benchmark:generate</code>
          {' '}(writes <code className="bg-muted px-1.5 py-0.5 rounded">public/benchmarks/{name}.json</code>).
        </p>
      </CardContent>
    </Card>
  );
}

BenchmarkFallback.propTypes = {
  loading: PropTypes.bool,
  name: PropTypes.string.isRequired,
};

/** Collapsible source viewer for scenario drill-downs. */
function SourceBlock({ label, source, language }) {
  const pretty = useMemo(() => {
    if (language !== 'json') return source;
    try {
      return JSON.stringify(JSON.parse(source), null, 2);
    } catch {
      return source;
    }
  }, [source, language]);

  return (
    <div>
      <p className="text-xs font-medium text-muted-foreground mb-1">{label}</p>
      <pre className="text-xs bg-muted/50 border rounded-md p-3 overflow-x-auto max-h-64">
        <code>{pretty}</code>
      </pre>
    </div>
  );
}

SourceBlock.propTypes = {
  label: PropTypes.string.isRequired,
  source: PropTypes.string.isRequired,
  language: PropTypes.string,
};

/** Search input shared by the drill-down tables. */
function SearchInput({ value, onChange, placeholder }) {
  return (
    <input
      type="search"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="text-sm px-3 py-1.5 rounded-md bg-background border border-input focus:outline-none focus:ring-2 focus:ring-ring w-full sm:w-64"
    />
  );
}

SearchInput.propTypes = {
  value: PropTypes.string.isRequired,
  onChange: PropTypes.func.isRequired,
  placeholder: PropTypes.string,
};

/** "Show more" pagination for long test tables. */
function useShowMore(items, step = 100) {
  const [limit, setLimit] = useState(step);
  const visible = items.slice(0, limit);
  const remaining = items.length - visible.length;
  const showMore = () => setLimit((l) => l + step);
  const reset = () => setLimit(step);
  return { visible, remaining, showMore, reset };
}

//#endregion

export {
  StatCard,
  RatioBadge,
  DivergingBar,
  PairedTimeBars,
  RatioHistogram,
  MetaStrip,
  MethodologyCard,
  BenchmarkFallback,
  SourceBlock,
  SearchInput,
  useShowMore,
};
