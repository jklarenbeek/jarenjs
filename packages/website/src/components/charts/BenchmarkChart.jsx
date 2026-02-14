import { useMemo } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@components/ui/card';
import { Badge } from '@components/ui/badge';
import { cn, formatDuration } from '@lib/utils';
import { FileJson, Zap } from 'lucide-react';
import PropTypes from 'prop-types';

// ==================== OVERVIEW COMPONENTS ====================

function OverviewChart({ data }) {
  const chartData = useMemo(() => {
    if (!data?.byDraft) return [];
    return Object.entries(data.byDraft).map(([name, draft]) => ({
      name: formatDraftName(name),
      key: name,
      ...draft,
    }));
  }, [data]);

  // Calculate overall totals
  const totals = useMemo(() => {
    if (!data?.byDraft) return null;
    return Object.values(data.byDraft).reduce(
      (acc, draft) => ({
        jarenTotalTime: acc.jarenTotalTime + draft.jarenTotalTime,
        ajvTotalTime: acc.ajvTotalTime + draft.ajvTotalTime,
        jarenSuccessTime: acc.jarenSuccessTime + draft.jarenSuccessTime,
        ajvSuccessTime: acc.ajvSuccessTime + draft.ajvSuccessTime,
        jarenErrors: acc.jarenErrors + draft.jarenErrors,
        ajvErrors: acc.ajvErrors + draft.ajvErrors,
        jarenFailures: acc.jarenFailures + draft.jarenFailures,
        ajvFailures: acc.ajvFailures + draft.ajvFailures,
        totalTests: acc.totalTests + draft.totalTests,
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
        totalTests: 0,
      }
    );
  }, [data]);

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
        {/* Overall Totals Summary */}
        {totals && (
          <div className="grid grid-cols-2 gap-4 mb-6 p-4 bg-muted/50 rounded-lg">
            <EngineSummary 
              name="JarenJS" 
              totalTime={totals.jarenTotalTime}
              successTime={totals.jarenSuccessTime}
              errors={totals.jarenErrors}
              failures={totals.jarenFailures}
              color="primary"
            />
            <EngineSummary 
              name="AJV" 
              totalTime={totals.ajvTotalTime}
              successTime={totals.ajvSuccessTime}
              errors={totals.ajvErrors}
              failures={totals.ajvFailures}
              color="secondary"
            />
          </div>
        )}

        {/* Per Draft Breakdown */}
        <div className="space-y-4">
          {chartData.map((draft) => (
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

function EngineSummary({ name, totalTime, successTime, errors, failures, color }) {
  return (
    <div className={cn("p-3 rounded-lg border", color === 'primary' ? 'border-primary/20 bg-primary/5' : 'border-secondary/20 bg-secondary/5')}> 
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
          <span className={cn("font-medium", errors > 0 ? 'text-red-600' : '')}>{errors}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Failures:</span>
          <span className={cn("font-medium", failures > 0 ? 'text-amber-600' : '')}>{failures}</span>
        </div>
      </div>
    </div>
  );
}

EngineSummary.propTypes = {
  name: PropTypes.string.isRequired,
  totalTime: PropTypes.number.isRequired,
  successTime: PropTypes.number.isRequired,
  errors: PropTypes.number.isRequired,
  failures: PropTypes.number.isRequired,
  color: PropTypes.string.isRequired,
};

function DraftOverviewCard({ data }) {
  const maxTime = Math.max(data.jarenTotalTime, data.ajvTotalTime) || 1;
  
  return (
    <div className="border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h4 className="font-medium">{data.name}</h4>
        <div className="flex gap-2">
          {data.testsWithErrors > 0 && (
            <Badge variant="destructive" className="text-xs">
              {data.testsWithErrors} errors
            </Badge>
          )}
          <Badge variant={data.avgRatio > 1 ? 'success' : 'warning'} className="text-xs">
            Avg: {data.avgRatio.toFixed(2)}x
          </Badge>
        </div>
      </div>
      
      <div className="space-y-3">
        {/* Jaren */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-primary" />
              Jaren
            </span>
            <span className="font-mono">{formatDuration(data.jarenTotalTime)}</span>
          </div>
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full"
              style={{ width: `${(data.jarenTotalTime / maxTime) * 100}%` }}
            />
          </div>
          <div className="flex gap-2 text-xs text-muted-foreground">
            <span>Success: {formatDuration(data.jarenSuccessTime)}</span>
            {data.jarenErrors > 0 && <span className="text-red-600">Errors: {data.jarenErrors}</span>}
            {data.jarenFailures > 0 && <span className="text-amber-600">Failures: {data.jarenFailures}</span>}
          </div>
        </div>

        {/* AJV */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-secondary" />
              AJV
            </span>
            <span className="font-mono">{formatDuration(data.ajvTotalTime)}</span>
          </div>
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-secondary rounded-full"
              style={{ width: `${(data.ajvTotalTime / maxTime) * 100}%` }}
            />
          </div>
          <div className="flex gap-2 text-xs text-muted-foreground">
            <span>Success: {formatDuration(data.ajvSuccessTime)}</span>
            {data.ajvErrors > 0 && <span className="text-red-600">Errors: {data.ajvErrors}</span>}
            {data.ajvFailures > 0 && <span className="text-amber-600">Failures: {data.ajvFailures}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

DraftOverviewCard.propTypes = {
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
    testsWithErrors: PropTypes.number.isRequired,
    avgRatio: PropTypes.number.isRequired,
  }).isRequired,
};

// ==================== BY SUITE COMPONENTS ====================

function SuiteChart({ data }) {
  const chartData = useMemo(() => {
    if (!data?.bySuite) return [];
    return Object.entries(data.bySuite)
      .map(([name, suite]) => ({
        name: name.replace(/^\//, ''),
        key: name,
        ...suite,
      }))
      .sort((a, b) => b.totalTests - a.totalTests); // Sort by number of tests
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
          <div className="flex items-center gap-2">
            {data.testsWithErrors > 0 && (
              <Badge variant="destructive" className="text-xs">
                {data.testsWithErrors} errors
              </Badge>
            )}
            <Badge variant={timeRatio > 1 ? 'success' : timeRatio < 1 ? 'warning' : 'secondary'} className="text-xs">
              {timeRatio.toFixed(2)}x
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="grid grid-cols-2 gap-6">
          {/* Jaren */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">JarenJS</span>
              <span className="font-mono text-sm">{formatDuration(data.jarenTotalTime)}</span>
            </div>
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full"
                style={{ width: `${(data.jarenTotalTime / maxTime) * 100}%` }}
              />
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
              <div>
                <span className="text-green-600 font-medium">{formatDuration(data.jarenSuccessTime)}</span>
                <span className="block">success time</span>
              </div>
              <div className="text-right">
                {data.jarenErrors > 0 && <div className="text-red-600">{data.jarenErrors} errors</div>}
                {data.jarenFailures > 0 && <div className="text-amber-600">{data.jarenFailures} failures</div>}
                {data.jarenErrors === 0 && data.jarenFailures === 0 && <span className="text-green-600">✓ All passed</span>}
              </div>
            </div>
          </div>

          {/* AJV */}
          <div className="space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">AJV</span>
              <span className="font-mono text-sm">{formatDuration(data.ajvTotalTime)}</span>
            </div>
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-secondary rounded-full"
                style={{ width: `${(data.ajvTotalTime / maxTime) * 100}%` }}
              />
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
              <div>
                <span className="text-green-600 font-medium">{formatDuration(data.ajvSuccessTime)}</span>
                <span className="block">success time</span>
              </div>
              <div className="text-right">
                {data.ajvErrors > 0 && <div className="text-red-600">{data.ajvErrors} errors</div>}
                {data.ajvFailures > 0 && <div className="text-amber-600">{data.ajvFailures} failures</div>}
                {data.ajvErrors === 0 && data.ajvFailures === 0 && <span className="text-green-600">✓ All passed</span>}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-3 pt-3 border-t text-xs text-muted-foreground flex justify-between">
          <span>{data.totalTests} tests</span>
          <span>{data.validTests} valid • {data.testsWithErrors} with errors</span>
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

// ==================== DETAILS COMPONENTS ====================

function DetailsTable({ data }) {
  const results = useMemo(() => {
    if (!data?.byDetails) return [];
    return data.byDetails;
  }, [data]);

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
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b">
                <th className="text-left py-2 px-2">Test</th>
                <th className="text-center py-2 px-2">Status</th>
                <th className="text-right py-2 px-2">Ratio</th>
                <th className="text-right py-2 px-2">Jaren Time</th>
                <th className="text-right py-2 px-2">AJV Time</th>
                <th className="text-right py-2 px-2">Success Time</th>
              </tr>
            </thead>
            <tbody>
              {results.map((result, index) => (
                <tr key={index} className="border-b last:border-0 hover:bg-muted/50">
                  <td className="py-2 px-2">
                    <div className="font-mono text-xs truncate max-w-[250px]" title={result.name}>
                      {result.name || result.description}
                    </div>
                    <div className="text-xs text-muted-foreground truncate max-w-[250px]">
                      {result.suite}
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
                    {formatDuration(result.jarenTotal || result.jarenTime)}
                  </td>
                  <td className="text-right py-2 px-2 font-mono">
                    {formatDuration(result.ajvTotal || result.ajvTime)}
                  </td>
                  <td className="text-right py-2 px-2">
                    {result.hasError ? (
                      <span className="text-red-600 text-xs">Has errors</span>
                    ) : (
                      <span className="text-green-600 font-mono text-xs">
                        {formatDuration((result.jarenTotal || result.jarenTime) + (result.ajvTotal || result.ajvTime))}
                      </span>
                    )}
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
        Error
      </Badge>
    );
  }
  if (result.jarenFailed || result.ajvFailed) {
    return (
      <Badge variant="warning" className="text-xs">
        Failed
      </Badge>
    );
  }
  return (
    <Badge variant="success" className="text-xs bg-green-100 text-green-800 hover:bg-green-100">
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

// ==================== LEGACY COMPONENTS (for backward compatibility) ====================

function BenchmarkChart({ data }) {
  return <OverviewChart data={data} />;
}

BenchmarkChart.propTypes = {
  data: PropTypes.object,
};

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

function ComparisonTable({ data }) {
  return <DetailsTable data={data} />;
}

ComparisonTable.propTypes = {
  data: PropTypes.object,
};

// ==================== UTILITY FUNCTIONS ====================

function formatDraftName(name) {
  const names = {
    draft7: 'Draft 07',
    draft2019: 'Draft 2019-09',
    'draft2019-09': 'Draft 2019-09',
    draft2020: 'Draft 2020-12',
    'draft2020-12': 'Draft 2020-12',
    other: 'Other Tests',
    unknown: 'Unknown',
  };
  return names[name] || name;
}

// ==================== EXPORTS ====================

export { 
  BenchmarkChart, 
  MetricsCard, 
  ComparisonTable,
  OverviewChart,
  SuiteChart,
  DetailsTable,
};
