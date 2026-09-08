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
 * Fourth: the spatial round trip — CSV to a map through the stylesheet,
 * the meta-schema, a throwaway store with derived spatial indexes, a
 * linq `$within` and its `explain()`, in this tab.
 *
 * Below the breakpoint those four become one pane at a time behind the
 * shared segmented switcher (Store · Query · Live · Round trip),
 * defaulting to the query — the pane a reader of this page came for.
 */
import { editorTextarea, errorLine, paneSwitcher } from './studio-kit.js';

const ownerDisabled = { $or: [{ $ne: ['$.topology', 'owner'] }, { $ne: ['$.status', 'ready'] }] };
const ownerReason = { $if: [{ $ne: ['$.topology', 'owner'] },
  ['p', { class: 'muted data-owner-reason' }, 'Only the owning tab can recreate or migrate the store.']] };

const statusCard =
  ['div', { class: 'card pg-card data-status' },
    ['h3', {}, 'Store'],
    ['p', { class: 'data-badges' },
      ['span', { class: 'badge' }, 'topology: ', ['strong', { class: 'data-topology' }, '$.topology']],
      ['span', { class: 'badge' }, 'vfs: ', ['strong', { class: 'data-vfs' }, '$.vfs']],
      ['span', { class: 'badge' }, 'capture: ', ['strong', {}, '$.capture']],
      ['span', { class: 'badge' }, 'sqlite ', '$.version'],
      ['span', { class: 'badge' }, 'operators: ', ['strong', { class: 'data-operators' }, '$.operatorSummary']],
    ],
    ['p', { class: 'muted data-durability' }, '$.durability'],
    ['details', { class: 'details-card data-oracle' },
      ['summary', {}, 'Spatial agreement \u2014 the same plans as Node'],
      ['p', { class: 'muted' },
        'This store runs the same spatial plans as Node. The committed spatial corpus \u2014 the entries the JavaScript engine recorded its answers for \u2014 runs here through SQLite compiled to wasm, one throwaway in-memory store per entry, with and without the derived spatial indexes, and every answer is compared with the recorded one. The same corpus holds the Node driver to the engine in the test suite; this tab is the third executor, and the test suite drives this button in Chromium, Firefox and WebKit. It proves execution, not durability: where OPFS is absent the store is in-memory, which is a property of the host, not of the suite.'],
      ['button', { class: 'btn small data-oracle-run', type: 'button', on: { click: 'data/oracle-run' } },
        'Run the spatial corpus'],
      { $if: ['$.oracle',
        ['div', { class: 'data-oracle-report', 'data-status': '$.oracle.status' },
          ['p', { class: 'data-oracle-summary' }, '$.oracleSummary'],
          { $if: ['$.oracleDisagreed',
            ['pre', { class: 'code-block clamp data-oracle-disagreements' },
              ['code', {}, '$.oracleDisagreements']]] },
          { $if: ['$.oracleDone',
            ['details', { class: 'details-card' },
              ['summary', {}, 'Every answer, as JSON'],
              ['pre', { class: 'code-block clamp data-oracle-results' },
                ['code', {}, '$.oracleResultsJson']]]] },
        ]] },
    ],
    ['details', { class: 'details-card' },
      ['summary', {}, 'Registered operators (host opt-in)'],
      ['p', { class: 'muted' }, 'This studio mounts the math / finance / stats packs, so queries here may use $sqrt, $npv, $mean, $stddev, $percentile and more. The pushable-scalar subset (math) runs inside SQLite as deterministic UDFs; finance and stats fold a series in the query residual — explain() shows which.'],
      ['pre', { class: 'code-block clamp' }, ['code', {}, '$.operatorList']],
    ],
    { $if: ['$.refusal',
      ['p', { class: 'muted data-refusal' },
        ['code', {}, '$.refusal.code'], ' — ', '$.refusal.message']] },
    ['details', { class: 'details-card', open: true },
      ['summary', {}, 'Model (jaren-model JSON)'],
      editorTextarea({ value: '$.modelText', action: 'data/model-text', rows: 14 }),
      ['button', { class: 'btn small', type: 'button', disabled: ownerDisabled, on: { click: 'data/open' } },
        'Recreate store from model'],
      ownerReason,
      ['p', { class: 'muted' },
        'Recreating unlinks the database the owning tab holds, so only that tab can do it: a client tab is refused, with the store\u2019s own coded message.'],
    ],
    ['details', { class: 'details-card', open: true },
      ['summary', {}, 'Documents'],
      ['p', { class: 'muted data-row-summary' }, '$.rowSummary'],
      ['ul', { class: 'data-rows' }, [{ $apply: '$.rowList[*]' }]],
    ],
  ];

/** One stored document: what it holds, and the delete the live pane
 * shows arriving as an RFC 6902 remove. A row whose key pointer found
 * nothing carries no control — there would be nothing to address. */
const documentRow = {
  match: '$.ui.data.rowList[*]', mode: 'data',
  body: ['li', { class: 'data-row' },
    ['code', {}, '$.text'],
    { $if: [{ $exists: '$.key' },
      ['button', {
        type: 'button', class: 'btn small data-row-delete', title: 'Delete this document',
        on: { click: { action: 'data/delete', with: '$.key' } },
      }, '\u00d7']] },
  ],
};

const queryCard =
  ['div', { class: 'card pg-card data-query' },
    ['h3', {}, 'Query'],
    editorTextarea({ value: '$.queryText', action: 'data/query-text', rows: 8 }),
    ['p', {},
      ['button', {
        class: 'btn small primary', type: 'button',
        disabled: { $ne: ['$.status', 'ready'] }, on: { click: 'data/run' },
      },
        'Run + explain'],
      // every keystroke is published, then Enter or blur commits: this
      // page re-renders on each live-query event, and a controlled input
      // whose buffer is not in state is reset by that render mid-typing
      ['input', {
        class: 'data-insert-title', type: 'text',
        value: '$.insertDraft', placeholder: '$.insertPlaceholder',
        disabled: { $ne: ['$.status', 'ready'] },
        on: { input: 'data/insert-draft', change: 'data/insert' },
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
    ['details', { class: 'details-card' },
      ['summary', {}, 'Try a registered operator'],
      ['p', { class: 'muted' }, 'The sqrt operator is a pushable scalar — paste this, Run, and watch explain() show a jaren_p_ UDF in the SQL (SQLite does the filtering). A finance or stats operator, such as mean over a series, runs in the residual instead, and explain() names it.'],
      ['pre', { class: 'code-block' }, ['code', {}, '$.operatorSample']],
    ],
  ];

const liveCard =
  ['div', { class: 'card pg-card data-live' },
    ['h3', {}, 'Live query'],
    { $if: ['$.liveNote', ['p', { class: 'muted data-live-note' }, '$.liveNote']] },
    ['p', { class: 'muted' },
      'A subscribe operation over the contract stream binding: the snapshot, then RFC 6902 patches as writes commit — one diff format end to end.'],
    ['p', { class: 'data-live-count' }, '$.liveSummary'],
    ['p', { class: 'muted data-live-regs' }, 'live registrations on the store: ', ['strong', {}, '$.liveRegs']],
    ['pre', { class: 'code-block clamp data-live-rows' }, ['code', {}, '$.liveJson']],
    ['h3', {}, 'Migration'],
    ['p', { class: 'muted' },
      'Plan a model change, verify it on a SHADOW database, apply it — in the browser.'],
    ['button', { class: 'btn small', type: 'button', disabled: ownerDisabled, on: { click: 'data/migrate' } },
      'Add a title index (plan → shadow → apply)'],
    ownerReason,
    { $if: ['$.migration',
      ['div', { class: 'data-migration' },
        ['p', {}, 'planned steps:'],
        ['pre', { class: 'code-block clamp data-migration-steps' },
          ['code', {}, '$.migrationSteps']],
        ['p', { class: 'data-migration-applied' }, '$.migrationSummary'],
      ]] },
  ];

/**
 * The round trip, where a reader can watch it: every stage is a
 * document the page prints, the store stage is explained beside its
 * answer, and the answer is drawn. The map is what the `geojson`
 * format's preview hint asks a host for; this host has a renderer.
 */
const tripCard =
  ['div', { class: 'card pg-card data-trip' },
    ['h3', {}, 'Round trip'],
    ['p', { class: 'muted' },
      'CSV in, a map out, in this tab. The rows become a FeatureCollection through a JSLT stylesheet, the collection is judged by the GeoJSON meta-schema, stored in a throwaway collection with derived spatial indexes, queried with a $within written through @jarenjs/linq, and explain() shows the two-stage plan \u2014 the bounding box the index seeks and the exact refinement the engine keeps \u2014 before the result is drawn.'],
    editorTextarea({ value: '$.tripCsv', action: 'data/trip-csv', rows: 7 }),
    ['p', {},
      ['button', { class: 'btn small primary data-trip-run', type: 'button', on: { click: 'data/trip-run' } },
        'Run the round trip']],
    { $if: ['$.trip',
      ['div', { class: 'data-trip-report', 'data-status': '$.tripStatus' },
        ['p', { class: 'data-trip-summary' }, '$.tripSummary'],
        { $if: ['$.tripDone',
          ['div', {},
            ['details', { class: 'details-card', open: true },
              ['summary', {}, 'explain() \u2014 the two-stage spatial plan'],
              ['pre', { class: 'code-block data-trip-sql' }, ['code', {}, '$.tripExplainSql']],
              ['p', { class: 'muted' }, 'pre-filters: ', ['code', { class: 'data-trip-prefilters' }, '$.tripPrefilters']],
              ['p', { class: 'muted' }, 'scan narrative: ', ['code', { class: 'data-trip-narrative' }, '$.tripNarrative']],
              ['p', { class: 'muted' }, 'indexes: ', ['code', { class: 'data-trip-indexes' }, '$.tripIndexes']],
              ['p', { class: 'muted' }, 'residual: ', ['code', { class: 'data-trip-residual' }, '$.tripResidual']],
            ],
            { $if: ['$.tripMap', ['div', { class: 'chart-card data-trip-map' }, '$.tripMap']] },
            ['details', { class: 'details-card' },
              ['summary', {}, 'The result \u2014 the features inside the region, as stored'],
              ['pre', { class: 'code-block clamp data-trip-results' }, ['code', {}, '$.tripResultsJson']]],
          ]] },
      ]] },
    ['details', { class: 'details-card' },
      ['summary', {}, 'The stylesheet \u2014 CSV rows to a FeatureCollection, no code'],
      ['pre', { class: 'code-block clamp' }, ['code', {}, '$.tripStylesheet']]],
    ['details', { class: 'details-card' },
      ['summary', {}, 'The model \u2014 derived spatial indexes over the geometry'],
      ['pre', { class: 'code-block clamp' }, ['code', {}, '$.tripModel']]],
    ['details', { class: 'details-card' },
      ['summary', {}, 'The query \u2014 written through @jarenjs/linq'],
      ['pre', { class: 'code-block' }, ['code', {}, '$.tripChain']],
      ['p', { class: 'muted' }, 'emits this document, with the region bound as an external:'],
      ['pre', { class: 'code-block data-trip-query' }, ['code', {}, '$.tripQuery']],
      ['pre', { class: 'code-block clamp' }, ['code', {}, '$.tripRegion']]],
  ];

export const DATA_RULES = [
  documentRow,
  {
    match: '$.ui.data', mode: 'data',
    // `container` for the gutters the other studios have: without it this
    // page ran edge-to-edge, into the notch, at every width
    body: ['section', { class: 'page container data-page' },
      ['h1', {}, 'Data'],
      ['p', { class: 'lead' },
        'The same store, the same queries, the same live updates as Node and Bun — running here, in your browser, on the official SQLite wasm build. One tab owns the connection; more tabs become clients.'],
      { $if: [{ $eq: ['$.status', 'boot'] },
        ['p', { class: 'muted data-booting' }, 'Loading the SQLite wasm build…']] },
      // the boot's terminal failure: the stage that failed is what a
      // reader can report, and the retry starts the protocol over
      { $if: [{ $eq: ['$.status', 'error'] },
        ['div', { class: 'card pg-card data-boot-error', role: 'alert' },
          ['p', {},
            ['strong', {}, 'The store did not boot.'], ' Stage ',
            ['code', { class: 'data-boot-stage' }, '$.boot.stage'], ' failed: ',
            ['span', { class: 'data-boot-message' }, '$.boot.message']],
          ['button', { class: 'btn small data-boot-retry', type: 'button', on: { click: 'data/retry' } },
            'Retry the boot']]] },
      { $if: ['$.plainError', errorLine('$.plainError')] },
      ['div', { class: 'data-grid', 'data-pane': '$.mobilePane' },
        paneSwitcher({
          class: 'data-panebar', pane: '$.mobilePane', action: 'data/pane',
          panes: [['store', 'Store'], ['query', 'Query'], ['live', 'Live'], ['trip', 'Round trip']],
        }),
        statusCard,
        queryCard,
        liveCard,
        tripCard,
      ],
    ],
  },
];
