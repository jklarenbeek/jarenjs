import { useMemo, useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@components/ui/card';
import { Badge } from '@components/ui/badge';
import { cn, formatDuration } from '@lib/utils';
import { FileJson, Zap, CheckCircle, XCircle, AlertTriangle } from 'lucide-react';
import PropTypes from 'prop-types';

// ==================== OVERVIEW COMPONENTS ====================

function OverviewChart({ data }) {
  const [selectedDrafts, setSelectedDrafts] = useState(new Set());

  const chartData = useMemo(() => {
    if (!data?.byDraft) return [];
    return Object.entries(data.byDraft).map(([key, draft]) => ({
      key,
      name: formatDraftName(key),
      ...draft,
    }));
  }, [data]);

  // Initialize selected drafts when data loads
  useMemo(() => {
    if (chartData.length > 0 && selectedDrafts.size === 0) {
      setSelectedDrafts(new Set(chartData.map(d => d.key)));
    }
  }, [chartData, selectedDrafts.size]);

  const toggleDraft = (draftKey) => {
    setSelectedDrafts(prev => {
      const next = new Set(prev);
      if (next.has(draftKey)) {
        next.delete(draftKey);
      } else {
        next.add(draftKey);
      }
      return next;
    });
  };

  const selectAll = () => setSelectedDrafts(new Set(chartData.map(d => d.key)));
  const selectNone = () => setSelectedDrafts(new Set());

  const filteredChartData = useMemo(() => {
    return chartData.filter(d => selectedDrafts.has(d.key));
  }, [chartData, selectedDrafts]);

  const totals = useMemo(() => {
    if (!data?.byDraft || selectedDrafts.size === 0) return null;
    return filteredChartData.reduce(
      (acc, draft) => ({
        jarenTotalTime: acc.jarenTotalTime + draft.jarenTotalTime,
        ajvTotalTime: acc.ajvTotalTime + draft.ajvTotalTime,
        jarenSuccessTime: acc.jarenSuccessTime + draft.jarenSuccessTime,
        ajvSuccessTime: acc.ajvSuccessTime + draft.ajvSuccessTime,
        jarenErrors: acc.jarenErrors + draft.jarenErrors,
        ajvErrors: acc.ajvErrors + draft.ajvErrors,
        jarenFailures: acc.jarenFailures + draft.jarenFailures,
        ajvFailures: acc.ajvFailures + draft.ajvFailures,
      }),
      {
        jarenTotalTime: 0,
        ajvTotalTime: 0,
        jarenSuccessTime: 0,
        ajvSuccessTime: 0,
        jarenErrors: 0,
        ajvErrors: 0,
        jarenFailures: 0,
        ajvFailures: 0,
      }
    );
  }, [filteredChartData, selectedDrafts.size]);

  if (!data || chartData.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          No benchmark data available
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Performance Overview by Draft</CardTitle>
      </CardHeader>
      <CardContent>
        {/* Draft Selection Buttons */}
        <div className="mb-4 p-3 bg-muted/30 rounded-lg">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm text-muted-foreground">Filter drafts:</span>
            <div className="flex gap-2">
              <button
                onClick={selectAll}
                className="text-xs px-2 py-1 rounded bg-muted hover:bg-muted/80 transition-colors"
              >
                Select All
              </button>
              <button
                onClick={selectNone}
                className="text-xs px-2 py-1 rounded bg-muted hover:bg-muted/80 transition-colors"
              >
                Select None
              </button>
            </div>
          </div>
          <div className="flex gap-2 flex-wrap">
            {chartData.map((draft) => (
              <button
                key={draft.key}
                onClick={() => toggleDraft(draft.key)}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-sm font-medium transition-all",
                  selectedDrafts.has(draft.key)
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                )}
              >
                {draft.name}
                <span className="ml-1.5 text-xs opacity-80">
                  ({draft.totalTests})
                </span>
              </button>
            ))}
          </div>
          <div className="mt-2 text-xs text-muted-foreground">
            Showing {filteredChartData.length} of {chartData.length} drafts
          </div>
        </div>

        {/* Aggregated Totals for Selected Drafts */}
        {totals && (
          <div className="grid grid-cols-2 gap-4 mb-6 p-4 bg-muted/50 rounded-lg">
            <EngineSummary
              name="JarenJS"
              {...totals}
              timeKey="jaren"
              color="primary"
            />
            <EngineSummary
              name="AJV"
              {...totals}
              timeKey="ajv"
              color="secondary"
            />
          </div>
        )}

        {/* Selected Draft Cards */}
        <div className="space-y-4">
          {filteredChartData.map((draft) => (
            <DraftOverviewCard key={draft.key} data={draft} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

OverviewChart.propTypes = {
  data: PropTypes.shape({
    byDraft: PropTypes.object,
  }),
};

function EngineSummary({ name, timeKey, color, ...totals }) {
  const totalTime = totals[`${timeKey}TotalTime`];
  const successTime = totals[`${timeKey}SuccessTime`];
  const errors = totals[`${timeKey}Errors`];
  const failures = totals[`${timeKey}Failures`];

  return (
    <div className={cn(
      "p-3 rounded-lg border",
      color === 'primary' ? 'border-primary/20 bg-primary/5' : 'border-secondary/20 bg-secondary/5'
    )}>
      <h4 className="font-semibold mb-2">{name}</h4>
      <div className="space-y-1 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Total Time:</span>
          <span className="font-medium">{formatDuration(totalTime)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Success Time:</span>
          <span className="font-medium text-green-600">{formatDuration(successTime)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Errors:</span>
          <span className={cn("font-medium", errors > 0 && 'text-red-600')}>{errors}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Failures:</span>
          <span className={cn("font-medium", failures > 0 && 'text-amber-600')}>{failures}</span>
        </div>
      </div>
    </div>
  );
}

EngineSummary.propTypes = {
  name: PropTypes.string.isRequired,
  timeKey: PropTypes.string.isRequired,
  color: PropTypes.string.isRequired,
};

function DraftOverviewCard({ data }) {
  const maxTime = Math.max(data.jarenTotalTime, data.ajvTotalTime) || 1;

  return (
    <div className="border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h4 className="font-medium">{data.name}</h4>
        <div className="flex gap-2 flex-wrap">
          <Badge variant="outline" className="text-xs">
            {data.totalTests} tests
          </Badge>
          <Badge variant="secondary" className="text-xs">
            {data.validTests} valid
          </Badge>
          {data.testsWithErrors > 0 && (
            <Badge variant="destructive" className="text-xs">
              {data.testsWithErrors} with issues
            </Badge>
          )}
          <Badge variant={data.avgRatio > 1 ? 'success' : 'warning'} className="text-xs">
            Avg: {data.avgRatio.toFixed(2)}x
          </Badge>
        </div>
      </div>

      <div className="space-y-3">
        <EngineBarDetailed
          name="Jaren"
          totalTime={data.jarenTotalTime}
          successTime={data.jarenSuccessTime}
          maxTime={maxTime}
          errors={data.jarenErrors}
          failures={data.jarenFailures}
          color="primary"
        />
        <EngineBarDetailed
          name="AJV"
          totalTime={data.ajvTotalTime}
          successTime={data.ajvSuccessTime}
          maxTime={maxTime}
          errors={data.ajvErrors}
          failures={data.ajvFailures}
          color="secondary"
        />
      </div>
    </div>
  );
}

DraftOverviewCard.propTypes = {
  data: PropTypes.shape({
    name: PropTypes.string.isRequired,
    totalTests: PropTypes.number.isRequired,
    validTests: PropTypes.number.isRequired,
    testsWithErrors: PropTypes.number.isRequired,
    jarenTotalTime: PropTypes.number.isRequired,
    ajvTotalTime: PropTypes.number.isRequired,
    jarenSuccessTime: PropTypes.number.isRequired,
    ajvSuccessTime: PropTypes.number.isRequired,
    jarenErrors: PropTypes.number.isRequired,
    ajvErrors: PropTypes.number.isRequired,
    jarenFailures: PropTypes.number.isRequired,
    ajvFailures: PropTypes.number.isRequired,
    avgRatio: PropTypes.number.isRequired,
  }).isRequired,
};

function EngineBarDetailed({ name, totalTime, successTime, maxTime, errors, failures, color }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground flex items-center gap-1">
          <span className={cn("w-2 h-2 rounded-full", color === 'primary' ? 'bg-primary' : 'bg-secondary')} />
          {name}
        </span>
        <div className="flex gap-2">
          {errors > 0 && (
            <Badge variant="destructive" className="text-[10px] px-1 py-0">
              <XCircle className="w-3 h-3 mr-0.5" />
              {errors}
            </Badge>
          )}
          {failures > 0 && (
            <Badge variant="warning" className="text-[10px] px-1 py-0">
              <AlertTriangle className="w-3 h-3 mr-0.5" />
              {failures}
            </Badge>
          )}
          <span className="font-mono">{formatDuration(totalTime)}</span>
        </div>
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div
          className={cn("h-full rounded-full", color === 'primary' ? 'bg-primary' : 'bg-secondary')}
          style={{ width: `${(totalTime / maxTime) * 100}%` }}
        />
      </div>
      <div className="flex gap-3 text-xs text-muted-foreground">
        <span>Total: <span className="font-medium">{formatDuration(totalTime)}</span></span>
        <span className="text-green-600">Success: <span className="font-medium">{formatDuration(successTime)}</span></span>
        {errors > 0 && <span className="text-red-600">Errors: {errors}</span>}
        {failures > 0 && <span className="text-amber-600">Failures: {failures}</span>}
      </div>
    </div>
  );
}

EngineBarDetailed.propTypes = {
  name: PropTypes.string.isRequired,
  totalTime: PropTypes.number.isRequired,
  successTime: PropTypes.number.isRequired,
  maxTime: PropTypes.number.isRequired,
  errors: PropTypes.number.isRequired,
  failures: PropTypes.number.isRequired,
  color: PropTypes.string.isRequired,
};

// ==================== BY SUITE COMPONENTS ====================

function SuiteChart({ data }) {
  const chartData = useMemo(() => {
    if (!data?.bySuite) return [];
    return Object.entries(data.bySuite)
      .map(([key, suite]) => ({
        key,
        ...suite,
      }))
      .sort((a, b) => b.totalTests - a.totalTests);
  }, [data]);

  if (!data || chartData.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          No suite data available
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {chartData.map((suite) => (
        <SuiteCard key={suite.key} data={suite} />
      ))}
    </div>
  );
}

SuiteChart.propTypes = {
  data: PropTypes.shape({
    bySuite: PropTypes.object,
  }),
};

function SuiteCard({ data }) {
  const maxTime = Math.max(data.jarenTotalTime, data.ajvTotalTime) || 1;
  const timeRatio = data.ajvTotalTime / data.jarenTotalTime;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileJson className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">{data.name}</CardTitle>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className="text-xs">
              {data.totalTests} tests
            </Badge>
            {data.testsWithErrors > 0 && (
              <Badge variant="destructive" className="text-xs">
                {data.testsWithErrors} with issues
              </Badge>
            )}
            <Badge
              variant={timeRatio > 1 ? 'success' : timeRatio < 1 ? 'warning' : 'secondary'}
              className="text-xs"
            >
              {timeRatio.toFixed(2)}x
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="grid grid-cols-2 gap-6">
          <EngineSuiteStats
            name="JarenJS"
            data={data}
            maxTime={maxTime}
            timeKey="jaren"
          />
          <EngineSuiteStats
            name="AJV"
            data={data}
            maxTime={maxTime}
            timeKey="ajv"
          />
        </div>

        <div className="mt-3 pt-3 border-t text-xs text-muted-foreground flex justify-between">
          <span>{data.totalTests} tests total</span>
          <span>{data.validTests} valid • {data.testsWithErrors} with issues</span>
        </div>
      </CardContent>
    </Card>
  );
}

SuiteCard.propTypes = {
  data: PropTypes.shape({
    name: PropTypes.string.isRequired,
    jarenTotalTime: PropTypes.number.isRequired,
    ajvTotalTime: PropTypes.number.isRequired,
    jarenSuccessTime: PropTypes.number.isRequired,
    ajvSuccessTime: PropTypes.number.isRequired,
    jarenErrors: PropTypes.number.isRequired,
    ajvErrors: PropTypes.number.isRequired,
    jarenFailures: PropTypes.number.isRequired,
    ajvFailures: PropTypes.number.isRequired,
    totalTests: PropTypes.number.isRequired,
    validTests: PropTypes.number.isRequired,
    testsWithErrors: PropTypes.number.isRequired,
  }).isRequired,
};

function EngineSuiteStats({ name, data, maxTime, timeKey }) {
  const time = data[`${timeKey}TotalTime`];
  const successTime = data[`${timeKey}SuccessTime`];
  const errors = data[`${timeKey}Errors`];
  const failures = data[`${timeKey}Failures`];
  const isPrimary = timeKey === 'jaren';

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">{name}</span>
        <div className="flex gap-1">
          {errors > 0 && (
            <Badge variant="destructive" className="text-[10px] px-1">
              {errors} err
            </Badge>
          )}
          {failures > 0 && (
            <Badge variant="warning" className="text-[10px] px-1">
              {failures} fail
            </Badge>
          )}
          <span className="font-mono text-sm">{formatDuration(time)}</span>
        </div>
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div
          className={cn("h-full rounded-full", isPrimary ? 'bg-primary' : 'bg-secondary')}
          style={{ width: `${(time / maxTime) * 100}%` }}
        />
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
        <div>
          <span className="block">Total: <span className="font-medium">{formatDuration(time)}</span></span>
          <span className="text-green-600">Success: <span className="font-medium">{formatDuration(successTime)}</span></span>
        </div>
        <div className="text-right">
          {errors > 0 && <div className="text-red-600">{errors} errors</div>}
          {failures > 0 && <div className="text-amber-600">{failures} failures</div>}
          {errors === 0 && failures === 0 && (
            <span className="text-green-600 flex items-center justify-end gap-1">
              <CheckCircle className="w-3 h-3" />
              All passed
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

EngineSuiteStats.propTypes = {
  name: PropTypes.string.isRequired,
  data: PropTypes.object.isRequired,
  maxTime: PropTypes.number.isRequired,
  timeKey: PropTypes.string.isRequired,
};

// ==================== DETAILS COMPONENTS ====================

function DetailsTable({ data }) {
  const results = useMemo(() => {
    return data?.byDetails || [];
  }, [data]);

  const { validResults, errorResults } = useMemo(() => ({
    validResults: results.filter(r => !r.hasError),
    errorResults: results.filter(r => r.hasError),
  }), [results]);

  if (!data || results.length === 0) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          No detailed data available
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Detailed Results by Time Difference</CardTitle>
        <p className="text-sm text-muted-foreground">
          Sorted by absolute ratio difference from 1.0 (largest differences first)
        </p>
      </CardHeader>
      <CardContent>
        {/* Summary Stats */}
        <div className="mb-4 p-3 bg-muted/50 rounded-lg flex gap-4 text-sm">
          <div>
            <span className="text-muted-foreground">Total:</span>
            <span className="font-medium ml-1">{results.length}</span>
          </div>
          <div>
            <span className="text-green-600">Valid:</span>
            <span className="font-medium ml-1">{validResults.length}</span>
          </div>
          <div>
            <span className="text-red-600">With Issues:</span>
            <span className="font-medium ml-1">{errorResults.length}</span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-left py-2 px-2">Test</th>
                <th className="text-center py-2 px-2">Status</th>
                <th className="text-right py-2 px-2">Ratio</th>
                <th className="text-right py-2 px-2">Total Time</th>
                <th className="text-right py-2 px-2">Success Time</th>
                <th className="text-right py-2 px-2">Combined</th>
              </tr>
            </thead>
            <tbody>
              {results.map((result, index) => (
                <tr key={index} className="border-b last:border-0 hover:bg-muted/50">
                  <td className="py-2 px-2">
                    <div className="font-mono text-xs truncate max-w-[250px]" title={result.description}>
                      {result.description}
                    </div>
                    <div className="text-xs text-muted-foreground truncate max-w-[250px]">
                      {result.suite}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Draft: {result.draft}
                    </div>
                  </td>
                  <td className="py-2 px-2 text-center">
                    <StatusBadge result={result} />
                  </td>
                  <td className={cn(
                    'text-right py-2 px-2 font-medium',
                    result.ratio > 1 ? 'text-green-600' : 'text-amber-600'
                  )}>
                    {result.ratio.toFixed(2)}x
                  </td>
                  <td className="text-right py-2 px-2 font-mono">
                    {formatDuration(result.jarenTotal)}
                  </td>
                  <td className="text-right py-2 px-2 font-mono text-green-600">
                    {result.isSuccessTest ? formatDuration(result.jarenTotal) : '-'}
                  </td>
                  <td className="text-right py-2 px-2 font-mono text-xs">
                    {formatDuration(result.jarenTotal + result.ajvTotal)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

DetailsTable.propTypes = {
  data: PropTypes.shape({
    byDetails: PropTypes.array,
  }),
};

function StatusBadge({ result }) {
  if (result.jarenError || result.ajvError) {
    return (
      <Badge variant="destructive" className="text-xs">
        <XCircle className="w-3 h-3 mr-1" />
        Error
      </Badge>
    );
  }
  if (result.jarenFailed || result.ajvFailed) {
    return (
      <Badge variant="warning" className="text-xs">
        <AlertTriangle className="w-3 h-3 mr-1" />
        Failed
      </Badge>
    );
  }
  return (
    <Badge variant="success" className="text-xs bg-green-100 text-green-800 hover:bg-green-100">
      <CheckCircle className="w-3 h-3 mr-1" />
      Pass
    </Badge>
  );
}

StatusBadge.propTypes = {
  result: PropTypes.shape({
    jarenError: PropTypes.string,
    ajvError: PropTypes.string,
    jarenFailed: PropTypes.bool,
    ajvFailed: PropTypes.bool,
    hasError: PropTypes.bool,
  }).isRequired,
};

// ==================== METRICS CARD ====================

function MetricsCard({ title, value, subtitle, trend, trendUp, icon: Icon }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{title}</p>
            <p className="text-3xl font-bold mt-1">{value}</p>
            {subtitle && (
              <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>
            )}
            {trend && (
              <p className={cn(
                'text-sm mt-2 font-medium',
                trendUp ? 'text-green-600' : 'text-amber-600'
              )}>
                {trendUp ? '↑' : '↓'} {trend}
              </p>
            )}
          </div>
          {Icon && (
            <div className="p-2 bg-muted rounded-lg">
              <Icon className="h-5 w-5 text-muted-foreground" />
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

MetricsCard.propTypes = {
  title: PropTypes.string.isRequired,
  value: PropTypes.oneOfType([PropTypes.string, PropTypes.number]).isRequired,
  subtitle: PropTypes.string,
  trend: PropTypes.string,
  trendUp: PropTypes.bool,
  icon: PropTypes.elementType,
};

// ==================== UTILITY FUNCTIONS ====================

function formatDraftName(name) {
  const names = {
    draft7: 'Draft 07',
    'draft2019-09': 'Draft 2019-09',
    'draft2020-12': 'Draft 2020-12',
  };
  return names[name] || name;
}

// ==================== EXPORTS ====================

export {
  OverviewChart,
  SuiteChart,
  DetailsTable,
  MetricsCard,
};
