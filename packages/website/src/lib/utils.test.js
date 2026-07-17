import { describe, it, expect } from 'vitest';
import { formatNs, formatOps, formatRatio, formatDuration } from './utils';
import { processValidateData } from '../hooks/useBenchmarkData';

describe('formatNs', () => {
  it('picks the right unit', () => {
    expect(formatNs(37)).toBe('37 ns');
    expect(formatNs(1510)).toBe('1.51 µs');
    expect(formatNs(23_160_000)).toBe('23.16 ms');
    expect(formatNs(1.33e9)).toBe('1.33 s');
  });
  it('handles missing cells', () => {
    expect(formatNs(null)).toBe('n/a');
    expect(formatNs(undefined)).toBe('n/a');
  });
});

describe('formatOps', () => {
  it('derives ops/s from ns/op', () => {
    expect(formatOps(100)).toBe('10.0M ops/s');
    expect(formatOps(1e6)).toBe('1.0k ops/s');
    expect(formatOps(0)).toBe('');
  });
});

describe('formatRatio', () => {
  it('scales decimals with magnitude', () => {
    expect(formatRatio(1.2345)).toBe('1.23x');
    expect(formatRatio(18.72)).toBe('18.7x');
    expect(formatRatio(215.4)).toBe('215x');
    expect(formatRatio(null)).toBe('—');
  });
});

describe('formatDuration', () => {
  it('formats milliseconds', () => {
    expect(formatDuration(0.5)).toBe('500.00μs');
    expect(formatDuration(117)).toBe('117.00ms');
    expect(formatDuration(1500)).toBe('1.50s');
  });
});

describe('processValidateData', () => {
  // Pins the website ratio convention: ratio = ajvTime / jarenTime,
  // > 1 means Jaren is faster (website-data.js flips profiler.js's field).
  const payload = {
    metadata: { drafts: ['draft7'], iterations: 1000 },
    summary: { overall: {}, byDraft: { draft7: {} }, engineStats: {} },
    results: [
      { suite: '/a.json', draft: 'draft7', description: 'jaren wins', jarenTime: 0.001, ajvTime: 0.004, ratio: 4, isSuccessTest: true, jarenFailures: 0, ajvFailures: 0 },
      { suite: '/a.json', draft: 'draft7', description: 'ajv wins', jarenTime: 0.004, ajvTime: 0.001, ratio: 0.25, isSuccessTest: true, jarenFailures: 0, ajvFailures: 0 },
    ],
    errors: [],
  };

  it('assigns winners from the >1-is-Jaren-faster convention', () => {
    const data = processValidateData(payload);
    expect(data.results[0].winner).toBe('jaren');
    expect(data.results[1].winner).toBe('ajv');
  });

  it('returns null on malformed payloads', () => {
    expect(processValidateData(null)).toBeNull();
    expect(processValidateData({})).toBeNull();
  });
});
