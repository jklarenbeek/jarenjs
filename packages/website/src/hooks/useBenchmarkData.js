import { useState, useEffect } from 'react';

const BASE = `${import.meta.env.BASE_URL}benchmarks/`;

// Fetched files are cached for the session so switching benchmark tabs
// back and forth doesn't refetch. null = fetched and missing.
const cache = new Map();

async function fetchBenchmarkFile(name) {
  if (cache.has(name)) return cache.get(name);
  try {
    const response = await fetch(`${BASE}${name}.json`);
    if (!response.ok) {
      cache.set(name, null);
      return null;
    }
    const data = await response.json();
    cache.set(name, data);
    return data;
  } catch {
    cache.set(name, null);
    return null;
  }
}

/**
 * Loads one benchmark data file from public/benchmarks/.
 * @param {string} name - File basename: 'meta', 'validate', 'jsonpath',
 *   'jsonquery', 'jslt', 'jsonpointer', 'jsonpatch' or 'toml'
 * @returns {{ data: Object|null, loading: boolean }}
 */
export function useBenchmarkFile(name) {
  const [state, setState] = useState(() => ({
    data: cache.get(name) ?? null,
    loading: !cache.has(name),
  }));

  useEffect(() => {
    let alive = true;
    if (cache.has(name)) {
      setState({ data: cache.get(name), loading: false });
      return undefined;
    }
    setState({ data: null, loading: true });
    fetchBenchmarkFile(name).then((data) => {
      if (alive) setState({ data, loading: false });
    });
    return () => { alive = false; };
  }, [name]);

  return state;
}

/**
 * Derived per-suite grouping for the validator drill-down.
 * @param {Object} validate - The validate.json payload
 * @returns {Object|null}
 */
export function processValidateData(validate) {
  if (!validate?.results || !validate?.summary?.byDraft) return null;

  const results = validate.results.map((r) => ({
    ...r,
    hasError: false,
    // ratio > 1 means Jaren is faster (ratio = ajvTime / jarenTime)
    winner: r.ratio > 1 ? 'jaren' : r.ratio < 1 ? 'ajv' : 'tied',
  }));

  const errors = (validate.errors || []).map((e) => ({
    ...e,
    hasError: true,
    isSuccessTest: false,
    ratio: null,
    winner: null,
  }));

  return {
    metadata: validate.metadata,
    overall: validate.summary.overall,
    byDraft: validate.summary.byDraft,
    engineStats: validate.summary.engineStats,
    results,
    errors,
  };
}
