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
        const response = await fetch('/jarenjs/results.json');
        if (!response.ok) {
          setData(getMockBenchmarkData());
          return;
        }
        const results = await response.json();
        setData(processBenchmarkData(results));
      } catch {
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
 * @param {Object} raw - Raw benchmark results from profiler.js
 * @returns {Object} - Processed data
 */
function processBenchmarkData(raw) {
  if (!raw?.results || !raw?.summary?.byDraft) {
    return getMockBenchmarkData();
  }

  // Normalize results with consistent field names
  const results = raw.results.map(r => ({
    ...r,
    hasError: !!(r.jarenError || r.ajvError),
    jarenFailed: r.jarenFailures > 0,
    ajvFailed: r.ajvFailures > 0,
  }));

  
  // Normalize errors array to have same structure as results
  const errors = (raw.errors || []).map(e => ({
    ...e,
    hasError: !!(e.jarenError || e.ajvError),
    jarenFailed: false,
    ajvFailed: false,
    jarenFailures: 0,
    ajvFailures: 0,
    jarenTotal: 0,
    ajvTotal: 0,
    jarenTime: 0,
    ajvTime: 0,
    ratio: 0,
    isSuccessTest: false,
    testCount: 1,
    assertions: 0,
  }));

  // Process byDraft from summary with timing data
  const byDraft = {};
  for (const [draft, stats] of Object.entries(raw.summary.byDraft)) {
    byDraft[draft] = {
      name: draft,
      ...stats,
      testsWithErrors: stats.totalTests - stats.validTests,
      jarenFaster: stats.all.jarenWins,
      ajvFaster: stats.all.ajvWins,
      similar: stats.all.tied,
      avgRatio: stats.all.avgRatio,
    };
  }

  // Process bySuite - include both results and errors
  const bySuite = groupBySuite(results, errors);

  // Calculate overall timing from summary
  const overall = raw.summary.overall;

  return {
    summary: {
      totalTests: raw.metadata.totalTests,
      totalWithErrors: raw.metadata.totalTests - raw.metadata.validTests,
      totalWithoutErrors: raw.metadata.validTests,
      averageRatio: overall.all.avgRatio.toFixed(2),
      jarenFaster: overall.all.jarenWins,
      ajvFaster: overall.all.ajvWins,
      similar: overall.all.tied,
      drafts: raw.metadata.drafts,
      jarenTotalTime: overall.jarenTotalTime,
      ajvTotalTime: overall.ajvTotalTime,
      jarenSuccessTime: overall.jarenSuccessTime,
      ajvSuccessTime: overall.ajvSuccessTime,
      jarenErrors: overall.jarenErrors,
      ajvErrors: overall.ajvErrors,
      jarenFailures: overall.jarenFailures,
      ajvFailures: overall.ajvFailures,
    },
    byDraft,
    bySuite,
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
    errors,
  };
}

/**
 * Group benchmark results by suite and draft
 * @param {Array} results - Benchmark results
 * @param {Array} errors - Error entries from errors array
 * @returns {Object} - Grouped results by suite-draft combination with metrics
 */
function groupBySuite(results, errors = []) {
  const groups = {};

  // Group by suite AND draft combination
  for (const result of results) {
    const suite = result.suite || 'unknown';
    const draft = result.draft || 'unknown';
    const key = `${suite}::${draft}`;
    
    if (!groups[key]) {
      groups[key] = {
        suite,
        draft,
        results: [],
      };
    }
    groups[key].results.push(result);
  }

  // Add error entries to existing groups or create new groups for error-only suites
  for (const error of errors) {
    const suite = error.suite || 'unknown';
    const draft = error.draft || 'unknown';
    const key = `${suite}::${draft}`;
    
    if (!groups[key]) {
      groups[key] = {
        suite,
        draft,
        results: [],
      };
    }
    groups[key].results.push(error);
  }

  const bySuite = {};
  for (const [key, group] of Object.entries(groups)) {
    const suiteResults = group.results;
    // Valid = no errors from either engine
    const validResults = suiteResults.filter(r => !r.jarenError && !r.ajvError);
    // Success = valid AND no failures (isSuccessTest flag from profiler)
    const successResults = validResults.filter(r => r.isSuccessTest);

    bySuite[key] = {
      name: group.suite.replace(/^\//, ''),
      suite: group.suite,
      draft: group.draft,
      totalTests: suiteResults.length,
      validTests: validResults.length,
      testsWithErrors: suiteResults.length - validResults.length,
      jarenTotalTime: suiteResults.reduce((sum, r) => sum + (r.jarenTotal || 0), 0),
      ajvTotalTime: suiteResults.reduce((sum, r) => sum + (r.ajvTotal || 0), 0),
      jarenSuccessTime: successResults.reduce((sum, r) => sum + (r.jarenTotal || 0), 0),
      ajvSuccessTime: successResults.reduce((sum, r) => sum + (r.ajvTotal || 0), 0),
      jarenErrors: suiteResults.filter(r => r.jarenError).length,
      ajvErrors: suiteResults.filter(r => r.ajvError).length,
      jarenFailures: validResults.filter(r => r.jarenFailures > 0).length,
      ajvFailures: validResults.filter(r => r.ajvFailures > 0).length,
      avgRatio: validResults.length > 0
        ? validResults.reduce((sum, r) => sum + r.ratio, 0) / validResults.length
        : 0,
    };
  }

  return bySuite;
}

/**
 * Get mock benchmark data for demo/development
 * @returns {Object} - Mock benchmark data
 */
function getMockBenchmarkData() {
  const drafts = ['draft7', 'draft2019-09', 'draft2020-12'];
  const suites = [
    '/type.json', '/string.json', '/number.json', '/object.json',
    '/array.json', '/ref.json', '/logic.json', '/format.json'
  ];
  const allResults = [];

  for (const draft of drafts) {
    for (const suite of suites) {
      for (let i = 0; i < 20; i++) {
        const ratio = 0.5 + Math.random() * 2;
        const jarenTime = 0.1 + Math.random() * 5;

        allResults.push({
          suite: `/${draft}${suite}`,
          draft,
          description: `Test case ${i} for ${suite}`,
          ratio,
          jarenTime,
          jarenTotal: jarenTime,
          ajvTime: jarenTime * ratio,
          ajvTotal: jarenTime * ratio,
          jarenError: null,
          ajvError: null,
          jarenFailures: 0,
          ajvFailures: 0,
          jarenFailed: false,
          ajvFailed: false,
          hasError: false,
          isSuccessTest: true,
          testCount: 1,
          assertions: Math.floor(Math.random() * 5) + 1,
        });
      }
    }
  }

  return processBenchmarkData({
    results: allResults,
    errors: [],
    metadata: { drafts, totalTests: allResults.length, validTests: allResults.length, successTests: allResults.length },
    summary: {
      overall: {
        jarenTotalTime: allResults.reduce((s, r) => s + r.jarenTotal, 0),
        ajvTotalTime: allResults.reduce((s, r) => s + r.ajvTotal, 0),
        jarenSuccessTime: allResults.reduce((s, r) => s + r.jarenTotal, 0),
        ajvSuccessTime: allResults.reduce((s, r) => s + r.ajvTotal, 0),
        jarenErrors: 0,
        ajvErrors: 0,
        jarenFailures: 0,
        ajvFailures: 0,
        all: {
          avgRatio: 1.2,
          minRatio: 0.5,
          maxRatio: 2.5,
          jarenWins: 300,
          tied: 50,
          ajvWins: 150,
        },
        successOnly: {
          avgRatio: 1.1,
          minRatio: 0.5,
          maxRatio: 2.0,
          jarenWins: 280,
          tied: 50,
          ajvWins: 120,
        },
      },
      byDraft: {
        draft7: {
          totalTests: 160,
          validTests: 160,
          successTests: 160,
          jarenTotalTime: 400,
          ajvTotalTime: 480,
          jarenSuccessTime: 400,
          ajvSuccessTime: 480,
          jarenErrors: 0,
          ajvErrors: 0,
          jarenFailures: 0,
          ajvFailures: 0,
          all: { avgRatio: 1.2, minRatio: 0.5, maxRatio: 2.5, jarenWins: 100, tied: 20, ajvWins: 40 },
          successOnly: { avgRatio: 1.1, minRatio: 0.5, maxRatio: 2.0, jarenWins: 95, tied: 20, ajvWins: 30 },
        },
        'draft2019-09': {
          totalTests: 160,
          validTests: 160,
          successTests: 160,
          jarenTotalTime: 400,
          ajvTotalTime: 480,
          jarenSuccessTime: 400,
          ajvSuccessTime: 480,
          jarenErrors: 0,
          ajvErrors: 0,
          jarenFailures: 0,
          ajvFailures: 0,
          all: { avgRatio: 1.15, minRatio: 0.6, maxRatio: 2.3, jarenWins: 100, tied: 15, ajvWins: 45 },
          successOnly: { avgRatio: 1.05, minRatio: 0.6, maxRatio: 1.8, jarenWins: 95, tied: 15, ajvWins: 35 },
        },
        'draft2020-12': {
          totalTests: 160,
          validTests: 160,
          successTests: 160,
          jarenTotalTime: 400,
          ajvTotalTime: 480,
          jarenSuccessTime: 400,
          ajvSuccessTime: 480,
          jarenErrors: 0,
          ajvErrors: 0,
          jarenFailures: 0,
          ajvFailures: 0,
          all: { avgRatio: 1.25, minRatio: 0.55, maxRatio: 2.7, jarenWins: 100, tied: 15, ajvWins: 45 },
          successOnly: { avgRatio: 1.15, minRatio: 0.55, maxRatio: 2.2, jarenWins: 90, tied: 15, ajvWins: 35 },
        },
      },
      engineStats: {
        jaren: {
          draft7: { passed: 160, failed: 0, errors: 0 },
          'draft2019-09': { passed: 160, failed: 0, errors: 0 },
          'draft2020-12': { passed: 160, failed: 0, errors: 0 },
        },
        ajv: {
          draft7: { passed: 160, failed: 0, errors: 0 },
          'draft2019-09': { passed: 160, failed: 0, errors: 0 },
          'draft2020-12': { passed: 160, failed: 0, errors: 0 },
        },
      },
    },
  });
}
