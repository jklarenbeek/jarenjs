import { useState, useMemo } from 'react';
import { Container } from '@components/layout/Container';
import { useBenchmarkData } from '@hooks/useBenchmarkData';
import { 
  OverviewChart, 
  SuiteChart, 
  DetailsTable,
  MetricsCard,
  DraftFilter
} from '@components/charts/BenchmarkChart';
import { Card, CardHeader, CardTitle, CardContent } from '@components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@components/ui/tabs';
import { 
  Loader2, 
  Activity, 
  Scale,
  Clock,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Zap,
  BarChart3,
  FileJson,
  List
} from 'lucide-react';
import { formatDuration } from '@lib/utils';

function Benchmarks() {
  const { data, loading } = useBenchmarkData();
  const [activeTab, setActiveTab] = useState('overview');
  const [selectedDrafts, setSelectedDrafts] = useState(new Set());

  // Get all available draft keys
  const draftKeys = useMemo(() => {
    if (!data?.byDraft) return [];
    return Object.keys(data.byDraft);
  }, [data]);

  // Initialize selected drafts when data loads
  useMemo(() => {
    if (draftKeys.length > 0 && selectedDrafts.size === 0) {
      setSelectedDrafts(new Set(draftKeys));
    }
  }, [draftKeys, selectedDrafts.size]);

  // Filter data based on selected drafts
  const filteredData = useMemo(() => {
    if (!data || selectedDrafts.size === 0) return null;

    // Filter byDraft
    const filteredByDraft = {};
    for (const key of selectedDrafts) {
      if (data.byDraft?.[key]) {
        filteredByDraft[key] = data.byDraft[key];
      }
    }

    // Filter bySuite - only include suites that belong to selected drafts
    const filteredBySuite = {};
    for (const [key, suite] of Object.entries(data.bySuite || {})) {
      // Check if this suite's draft is selected
      if (selectedDrafts.has(suite.draft)) {
        filteredBySuite[key] = suite;
      }
    }

    // Filter byDetails - only include details that belong to selected drafts
    const filteredByDetails = (data.byDetails || []).filter(
      detail => selectedDrafts.has(detail.draft)
    );

    // Filter slowestTests
    const filteredSlowestTests = (data.slowestTests || []).filter(
      test => selectedDrafts.has(test.draft)
    );

    // Recalculate summary based on filtered data
    const summary = {
      totalTests: 0,
      validTests: 0,
      totalWithErrors: 0,
      totalWithoutErrors: 0,
      jarenTotalTime: 0,
      ajvTotalTime: 0,
      jarenSuccessTime: 0,
      ajvSuccessTime: 0,
      jarenErrors: 0,
      ajvErrors: 0,
      jarenFailures: 0,
      ajvFailures: 0,
      jarenFaster: 0,
    };

    for (const draft of Object.values(filteredByDraft)) {
      summary.totalTests += draft.totalTests;
      summary.validTests += draft.validTests;
      summary.totalWithErrors += draft.testsWithErrors;
      summary.totalWithoutErrors += draft.totalTests - draft.testsWithErrors;
      summary.jarenTotalTime += draft.jarenTotalTime;
      summary.ajvTotalTime += draft.ajvTotalTime;
      summary.jarenSuccessTime += draft.jarenSuccessTime;
      summary.ajvSuccessTime += draft.ajvSuccessTime;
      summary.jarenErrors += draft.jarenErrors;
      summary.ajvErrors += draft.ajvErrors;
      summary.jarenFailures += draft.jarenFailures;
      summary.ajvFailures += draft.ajvFailures;
    }

    // Count jarenFaster from filtered details
    for (const detail of filteredByDetails) {
      if (detail.ratio > 1) {
        summary.jarenFaster++;
      }
    }

    // Calculate average ratio
    summary.averageRatio = filteredByDetails.length > 0
      ? (filteredByDetails.reduce((sum, d) => sum + d.ratio, 0) / filteredByDetails.length).toFixed(2)
      : '0.00';

    return {
      ...data,
      byDraft: filteredByDraft,
      bySuite: filteredBySuite,
      byDetails: filteredByDetails,
      slowestTests: filteredSlowestTests,
      summary,
    };
  }, [data, selectedDrafts]);

  // Get summary data from filtered data
  const summary = useMemo(() => {
    return filteredData?.summary || {};
  }, [filteredData]);

  // Get header stats based on active tab
  const headerStats = useMemo(() => {
    if (!filteredData) return null;

    const statsConfig = {
      overview: {
        title: 'Overall Performance',
        stats: [
          { 
            title: 'Average Ratio', 
            value: `${summary.averageRatio}x`, 
            subtitle: 'Jaren vs AJV',
            trend: parseFloat(summary.averageRatio) > 1 ? 'Faster' : 'Slower',
            trendUp: parseFloat(summary.averageRatio) > 1,
            icon: Scale 
          },
          { 
            title: 'Total Tests', 
            value: summary.totalTests, 
            subtitle: 'test cases run',
            icon: Activity 
          },
          { 
            title: 'Jaren Errors/Failures', 
            value: `${summary.jarenErrors || 0}/${summary.jarenFailures || 0}`, 
            subtitle: 'errors/failures',
            trend: (summary.jarenErrors || 0) === 0 ? 'Clean' : 'Has issues',
            trendUp: (summary.jarenErrors || 0) === 0,
            icon: summary.jarenErrors > 0 ? AlertTriangle : CheckCircle 
          },
          { 
            title: 'AJV Errors/Failures', 
            value: `${summary.ajvErrors || 0}/${summary.ajvFailures || 0}`, 
            subtitle: 'errors/failures',
            trend: (summary.ajvErrors || 0) === 0 ? 'Clean' : 'Has issues',
            trendUp: (summary.ajvErrors || 0) === 0,
            icon: summary.ajvErrors > 0 ? AlertTriangle : CheckCircle 
          },
        ]
      },
      suites: {
        title: 'Performance by Suite',
        stats: [
          { 
            title: 'Total Suites', 
            value: Object.keys(filteredData.bySuite || {}).length, 
            subtitle: 'test files',
            icon: FileJson 
          },
          { 
            title: 'Total Tests', 
            value: summary.totalTests, 
            subtitle: 'across all suites',
            icon: Activity 
          },
          { 
            title: 'Jaren Success Time', 
            value: formatDuration(summary.jarenSuccessTime || 0), 
            subtitle: 'total success time',
            icon: Zap 
          },
          { 
            title: 'AJV Success Time', 
            value: formatDuration(summary.ajvSuccessTime || 0), 
            subtitle: 'total success time',
            icon: Zap 
          },
        ]
      },
      details: {
        title: 'Detailed Test Results',
        stats: [
          { 
            title: 'Tests with Errors', 
            value: summary.totalWithErrors || 0, 
            subtitle: 'excluded from timing',
            trend: (summary.totalWithErrors || 0) === 0 ? 'All valid' : 'Some errors',
            trendUp: (summary.totalWithErrors || 0) === 0,
            icon: XCircle 
          },
          { 
            title: 'Valid Tests', 
            value: summary.totalWithoutErrors || 0, 
            subtitle: 'included in timing',
            icon: CheckCircle 
          },
          { 
            title: 'Jaren Total Time', 
            value: formatDuration(summary.jarenTotalTime || 0), 
            subtitle: 'all tests',
            icon: Clock 
          },
          { 
            title: 'AJV Total Time', 
            value: formatDuration(summary.ajvTotalTime || 0), 
            subtitle: 'all tests',
            icon: Clock 
          },
        ]
      }
    };

    return statsConfig[activeTab] || null;
  }, [activeTab, filteredData, summary]);

  if (loading) {
    return (
      <div className="py-20">
        <Container>
          <div className="flex flex-col items-center justify-center">
            <Loader2 className="h-12 w-12 animate-spin text-primary mb-4" />
            <p className="text-muted-foreground">Loading benchmark data...</p>
          </div>
        </Container>
      </div>
    );
  }

  // Get the icon for the header based on active tab
  const getHeaderIcon = () => {
    switch (activeTab) {
      case 'overview': return <BarChart3 className="h-5 w-5" />;
      case 'suites': return <FileJson className="h-5 w-5" />;
      case 'details': return <List className="h-5 w-5" />;
      default: return null;
    }
  };

  return (
    <div className="py-8">
      <Container>
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Benchmarks</h1>
          <p className="text-muted-foreground">
            Performance comparison between JarenJS and AJV across {summary.totalTests || 'all'} JSON Schema test suite cases.
          </p>
        </div>

        {/* Draft Filter - Moved to top */}
        {data?.byDraft && (
          <div className="mb-6">
            <DraftFilter
              data={data}
              selectedDrafts={selectedDrafts}
              onSelectionChange={setSelectedDrafts}
            />
          </div>
        )}

        {/* Dynamic Header Cards */}
        {headerStats && (
          <div className="mb-6">
            <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
              {getHeaderIcon()}
              {headerStats.title}
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              {headerStats.stats.map((stat, index) => (
                <MetricsCard key={index} {...stat} />
              ))}
            </div>
          </div>
        )}

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="mb-6">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="suites">By Suite</TabsTrigger>
            <TabsTrigger value="details">Details</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-6">
            <div className="grid lg:grid-cols-2 gap-6">
              <OverviewChart data={filteredData} />

              {/* Performance Insights */}
              <Card>
                <CardHeader>
                  <CardTitle className="text-lg">Performance Insights</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <h4 className="font-medium">Key Takeaways</h4>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      <li>• Jaren outperforms AJV in {summary.jarenFaster} out of {summary.totalTests} test cases</li>
                      <li>• Average speed ratio: {summary.averageRatio}x</li>
                      <li>• Jaren success time: {formatDuration(summary.jarenSuccessTime || 0)}</li>
                      <li>• AJV success time: {formatDuration(summary.ajvSuccessTime || 0)}</li>
                    </ul>
                  </div>

                  <div className="space-y-2">
                    <h4 className="font-medium">Error Summary</h4>
                    <ul className="text-sm text-muted-foreground space-y-1">
                      <li>• Jaren errors: {summary.jarenErrors || 0}, failures: {summary.jarenFailures || 0}</li>
                      <li>• AJV errors: {summary.ajvErrors || 0}, failures: {summary.ajvFailures || 0}</li>
                      <li>• Total tests with errors: {summary.totalWithErrors || 0}</li>
                    </ul>
                  </div>

                  <div className="space-y-2">
                    <h4 className="font-medium">Methodology</h4>
                    <p className="text-sm text-muted-foreground">
                      Benchmarks are run using the official JSON Schema Test Suite with 5000 iterations per test.
                      Results are measured in operations per second (ops/s). Ratio {'>'} 1 means Jaren is faster.
                      Success time represents total time for tests without errors.
                    </p>
                  </div>

                  {filteredData?.slowestTests && filteredData.slowestTests.length > 0 && (
                    <div className="space-y-2">
                      <h4 className="font-medium">Areas for Improvement</h4>
                      <div className="space-y-1">
                        {filteredData.slowestTests.slice(0, 3).map((test, i) => (
                          <div key={i} className="flex items-center justify-between text-sm">
                            <span className="truncate max-w-[200px]" title={test.name}>
                              {test.name}
                            </span>
                            <span className="text-amber-600 font-medium">{test.ratio.toFixed(1)}x</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="suites" className="space-y-6">
            <SuiteChart data={filteredData} />
          </TabsContent>

          <TabsContent value="details">
            <DetailsTable data={filteredData} />
          </TabsContent>
        </Tabs>
      </Container>
    </div>
  );
}

export { Benchmarks };
