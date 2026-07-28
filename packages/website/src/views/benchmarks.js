//@ts-check
/**
 * The benchmarks page — mode 'benchmarks', dispatched with `$.ui.bench`
 * as the current node. The page is thin: suite tabs are deep-linkable
 * links, the body is whatever kind-nodes the bench boundary derived,
 * rendered by the generic 'ui' mode.
 */

import { tabRule } from './ui.js';

export const BENCH_RULES = [
  {
    match: '$.ui.bench', mode: 'benchmarks',
    body: ['div', { class: 'page container' },
      ['h1', {}, 'Benchmarks'],
      ['p', { class: 'page-lead' },
        'Measured, not claimed: every number regenerates from the benchmark workspace with npm run benchmark:generate. Ratios above 1 mean Jaren is faster.'],
      ['nav', { class: 'tabs' }, [{ $apply: '$.suites[*]' }]],
      ['div', { class: 'bench-body' }, [{ $apply: ['$.nodes[*]', 'ui'] }]],
    ],
  },
  tabRule('$.ui.bench.suites[*]', 'benchmarks'),
];
