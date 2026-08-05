//@ts-check
/**
 * The data studio — mode 'data', dispatched with `$.ui.data` (derived
 * by boundaries/data.js — the boundary-exports convention). The THIRD
 * studio, built on the extracted kit: both editors are the kit's
 * `editorTextarea`, errors are its `errorLine`. Left: the model
 * document and the store's honest status (topology, VFS, durability).
 * Middle: the query document with results and `explain()` — the
 * pushdown made visible. Right: a live query maintaining as rows are
 * inserted, and the worked migration with its shadow verification.
 */
import { editorTextarea, errorLine } from './studio-kit.js';

const statusCard =
  ['div', { class: 'card pg-card data-status' },
    ['h3', {}, 'Store'],
    ['p', { class: 'data-badges' },
      ['span', { class: 'badge' }, 'topology: ', ['strong', { class: 'data-topology' }, '$.topology']],
      ['span', { class: 'badge' }, 'vfs: ', ['strong', { class: 'data-vfs' }, '$.vfs']],
      ['span', { class: 'badge' }, 'capture: ', ['strong', {}, '$.capture']],
      ['span', { class: 'badge' }, 'sqlite ', '$.version'],
    ],
    ['p', { class: 'muted data-durability' }, '$.durability'],
    { $if: ['$.refusal',
      ['p', { class: 'muted data-refusal' },
        ['code', {}, '$.refusal.code'], ' — ', '$.refusal.message']] },
    ['details', { class: 'details-card', open: true },
      ['summary', {}, 'Model (jaren-model JSON)'],
      editorTextarea({ value: '$.modelText', action: 'data/model-text', rows: 14 }),
      ['button', { class: 'btn small', type: 'button', on: { click: 'data/open' } },
        'Recreate store from model'],
    ],
  ];

const queryCard =
  ['div', { class: 'card pg-card data-query' },
    ['h3', {}, 'Query'],
    editorTextarea({ value: '$.queryText', action: 'data/query-text', rows: 8 }),
    ['p', {},
      ['button', { class: 'btn small primary', type: 'button', on: { click: 'data/run' } },
        'Run + explain'],
      ['input', {
        class: 'data-insert-title', type: 'text', placeholder: 'new note title… (enter inserts)',
        value: '$.insertDraft', on: { change: 'data/insert' },
      }]],
    { $if: ['$.explain',
      ['details', { class: 'details-card', open: true },
        ['summary', {}, 'explain() — the pushdown, visible'],
        ['pre', { class: 'code-block data-explain-sql' }, ['code', {}, '$.explain.sql']],
        ['p', { class: 'muted' }, 'params: ', ['code', {}, '$.explain.params']],
        ['p', { class: 'muted' }, 'indexes: ', ['code', { class: 'data-explain-indexes' }, '$.explain.indexes']],
        ['p', { class: 'muted' }, 'residual: ', ['code', {}, '$.explain.residual']],
      ]] },
    ['details', { class: 'details-card', open: true },
      ['summary', {}, 'Results'],
      ['pre', { class: 'code-block clamp data-results' }, ['code', {}, '$.resultsJson']],
    ],
  ];

const liveCard =
  ['div', { class: 'card pg-card data-live' },
    ['h3', {}, 'Live query'],
    ['p', { class: 'muted' },
      'Maintained incrementally (strategy ',
      ['code', {}, '$.liveStrategy'],
      '); rows update as writes commit — RFC 6902 patches end to end.'],
    ['p', { class: 'data-live-count' }, '$.liveSummary'],
    ['pre', { class: 'code-block clamp data-live-rows' }, ['code', {}, '$.liveJson']],
    ['h3', {}, 'Migration'],
    ['p', { class: 'muted' },
      'Plan a model change, verify it on a SHADOW database, apply it — in the browser.'],
    ['button', { class: 'btn small', type: 'button', on: { click: 'data/migrate' } },
      'Add a title index (plan → shadow → apply)'],
    { $if: ['$.migration',
      ['div', { class: 'data-migration' },
        ['p', {}, 'planned steps:'],
        ['pre', { class: 'code-block clamp data-migration-steps' },
          ['code', {}, '$.migrationSteps']],
        ['p', { class: 'data-migration-applied' }, '$.migrationSummary'],
      ]] },
  ];

export const DATA_RULES = [
  {
    match: '$.ui.data', mode: 'data',
    body: ['section', { class: 'page data-page' },
      ['h1', {}, 'Data'],
      ['p', { class: 'lead' },
        'The same store, the same queries, the same live updates as Node and Bun — running here, in your browser, on the official SQLite wasm build. One tab owns the connection; more tabs become clients.'],
      { $if: ['$.error', errorLine('$.error')] },
      { $if: [{ $eq: ['$.status', 'boot'] },
        ['p', { class: 'muted data-booting' }, 'Loading the SQLite wasm build…']] },
      ['div', { class: 'data-grid' },
        statusCard,
        queryCard,
        liveCard,
      ],
    ],
  },
];
