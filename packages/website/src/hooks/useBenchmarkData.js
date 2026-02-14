import { useState, useEffect } from 'react';

/**
 * Custom hook for loading benchmark data
 * @returns {Object} - Benchmark data state
 */
export function useBenchmarkData() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadBenchmarks() {
      try {
        // Try to load the results.json file
        const response = await fetch('/jarenjs/results.json');
        if (!response.ok) {
          // If file doesn't exist, use mock data for demo
          setData(getMockBenchmarkData());
          setLoading(false);
          return;
        }
        const results = await response.json();
        setData(processBenchmarkData(results));
      } catch {
        // Use mock data on error
        setData(getMockBenchmarkData());
      } finally {
        setLoading(false);
      }
    }

    loadBenchmarks();
  }, []);

  return { data, loading, error: null };
}

/**
 * Process raw benchmark data for visualization
 * @param {Object} raw - Raw benchmark results
 * @returns {Object} - Processed data
 */
function processBenchmarkData(raw) {
  if (!raw || !raw.results) {
    return getMockBenchmarkData();
  }

  const results = raw.results.map(r => ({
    ...r,
    // Determine errors and failures
    jarenError: r.jarenError || null,
    ajvError: r.ajvError || null,
    jarenFailed: r.jarenFailed || r.jarenFailures > 0 || false,
    ajvFailed: r.ajvFailed || r.ajvFailures > 0 || false,
    // A test is "successful" if it has no errors
    hasError: !!(r.jarenError || r.ajvError),
  }));

  const resultsWithErrors = results.filter(r => r.hasError);
  const resultsWithoutErrors = results.filter(r => !r.hasError);

  // Calculate overall metrics
  const overall = calculateMetrics(results, 'overall');

  // Group by draft and calculate metrics
  const byDraft = groupByDraft(results);

  // Group by suite and calculate metrics
  const bySuite = groupBySuite(results);

  // Get drafts from metadata or infer from results
  const drafts = raw.metadata?.drafts || [...new Set(results.map(r => r.draft).filter(Boolean))];

  return {
    summary: {
      totalTests: results.length,
      totalWithErrors: resultsWithErrors.length,
      totalWithoutErrors: resultsWithoutErrors.length,
      averageRatio: overall.avgRatio.toFixed(2),
      jarenFaster: overall.jarenFaster,
      ajvFaster: overall.ajvFaster,
      similar: overall.similar,
      drafts: drafts,
      // Overall timing metrics
      jarenTotalTime: overall.jarenTotalTime,
      ajvTotalTime: overall.ajvTotalTime,
      jarenSuccessTime: overall.jarenSuccessTime,
      ajvSuccessTime: overall.ajvSuccessTime,
      // Error counts
      jarenErrors: overall.jarenErrors,
      ajvErrors: overall.ajvErrors,
      jarenFailures: overall.jarenFailures,
      ajvFailures: overall.ajvFailures,
    },
    byDraft,
    bySuite,
    // Details sorted by time difference rate (ratio)
    byDetails: results
      .slice()
      .sort((a, b) => Math.abs(b.ratio - 1) - Math.abs(a.ratio - 1)),
    slowestTests: results
      .filter(r => !r.hasError && r.ratio > 1)
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, 10),
    fastestTests: results
      .filter(r => !r.hasError && r.ratio < 1)
      .sort((a, b) => a.ratio - b.ratio)
      .slice(0, 10),
    allResults: results,
    errors: resultsWithErrors,
  };
}

/**
 * Calculate metrics for a set of results
 * @param {Array} results - Benchmark results
 * @param {string} name - Name of the group
 * @returns {Object} - Calculated metrics
 */
function calculateMetrics(results, name) {
  const validResults = results.filter(r => !r.hasError);
  const withErrors = results.filter(r => r.hasError);

  // Timing calculations
  const jarenTotalTime = results.reduce((sum, r) => sum + (r.jarenTotal || r.jarenTime || 0), 0);
  const ajvTotalTime = results.reduce((sum, r) => sum + (r.ajvTotal || r.ajvTime || 0), 0);
  
  // Success-time: time for tests without errors
  const jarenSuccessTime = validResults.reduce((sum, r) => sum + (r.jarenTotal || r.jarenTime || 0), 0);
  const ajvSuccessTime = validResults.reduce((sum, r) => sum + (r.ajvTotal || r.ajvTime || 0), 0);

  // Error/failure counts
  const jarenErrors = withErrors.filter(r => r.jarenError).length;
  const ajvErrors = withErrors.filter(r => r.ajvError).length;
  const jarenFailures = results.filter(r => r.jarenFailed).length;
  const ajvFailures = results.filter(r => r.ajvFailed).length;

  // Performance metrics
  const ratios = validResults.map(r => r.ratio);
  const avgRatio = ratios.length > 0 
    ? ratios.reduce((a, b) => a + b, 0) / ratios.length 
    : 0;
  
  const jarenFaster = validResults.filter(r => r.ratio < 0.9).length;
  const ajvFaster = validResults.filter(r => r.ratio > 1.1).length;
  const similar = validResults.filter(r => r.ratio >= 0.9 && r.ratio <= 1.1).length;

  return {
    name,
    totalTests: results.length,
    validTests: validResults.length,
    testsWithErrors: withErrors.length,
    jarenTotalTime,
    ajvTotalTime,
    jarenSuccessTime,
    ajvSuccessTime,
    jarenErrors,
    ajvErrors,
    jarenFailures,
    ajvFailures,
    avgRatio,
    jarenFaster,
    ajvFaster,
    similar,
  };
}

/**
 * Group benchmark results by draft version
 * @param {Array} results - Benchmark results
 * @returns {Object} - Grouped results by draft with metrics
 */
function groupByDraft(results) {
  const groups = {};
  
  results.forEach(result => {
    // Extract draft from suite or name
    let draft = result.draft;
    if (!draft && result.suite) {
      const match = result.suite.match(/(draft\d+|draft\d{4}-\d{2})/);
      draft = match ? match[1] : 'unknown';
    }
    if (!draft) draft = 'unknown';
    
    if (!groups[draft]) {
      groups[draft] = [];
    }
    groups[draft].push(result);
  });
  
  // Calculate metrics for each draft
  const byDraft = {};
  for (const [draft, draftResults] of Object.entries(groups)) {
    byDraft[draft] = calculateMetrics(draftResults, draft);
  }
  
  return byDraft;
}

/**
 * Group benchmark results by suite (file)
 * @param {Array} results - Benchmark results
 * @returns {Object} - Grouped results by suite with metrics
 */
function groupBySuite(results) {
  const groups = {};
  
  results.forEach(result => {
    const suite = result.suite || result.file || 'unknown';
    if (!groups[suite]) {
      groups[suite] = [];
    }
    groups[suite].push(result);
  });
  
  // Calculate metrics for each suite
  const bySuite = {};
  for (const [suite, suiteResults] of Object.entries(groups)) {
    bySuite[suite] = calculateMetrics(suiteResults, suite);
  }
  
  return bySuite;
}

/**
 * Get mock benchmark data for demo/development
 * @returns {Object} - Mock benchmark data
 */
function getMockBenchmarkData() {
  // Generate mock results that look like real profiler output
  const drafts = ['draft7', 'draft2019-09', 'draft2020-12'];
  const suites = [
    '/type.json', '/string.json', '/number.json', '/object.json', 
    '/array.json', '/ref.json', '/logic.json', '/format.json'
  ];
  const allResults = [];
  
  drafts.forEach(draft => {
    suites.forEach(suite => {
      // Generate ~20 tests per suite per draft
      for (let i = 0; i < 20; i++) {
        const hasError = Math.random() < 0.05; // 5% error rate
        const hasFailure = !hasError && Math.random() < 0.1; // 10% failure rate (of non-errors)
        const ratio = 0.3 + Math.random() * 2.5; // Random ratio between 0.3 and 2.8
        const jarenTime = 0.1 + Math.random() * 5;
        const ajvTime = jarenTime * ratio;
        
        allResults.push({
          name: `${draft}_${suite.replace(/[^a-z]/g, '')}_test_${i}`,
          suite: `/${draft}${suite}`,
          draft: draft,
          description: `Test case ${i} for ${suite}`,
          ratio: ratio,
          jarenTime: jarenTime,
          jarenTotal: jarenTime,
          ajvTime: ajvTime,
          ajvTotal: ajvTime,
          jarenError: hasError && Math.random() < 0.5 ? 'Mock error' : null,
          ajvError: hasError && Math.random() < 0.5 ? 'Mock error' : null,
          jarenFailed: hasFailure,
          ajvFailed: hasFailure && Math.random() < 0.5,
          testCount: 1,
          assertions: Math.floor(Math.random() * 5) + 1,
        });
      }
    });
  });
  
  // Process the mock data
  return processBenchmarkData({ results: allResults, metadata: { drafts } });
}
