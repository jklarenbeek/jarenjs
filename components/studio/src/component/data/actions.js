//@ts-check
/** Shared Data transitions for composed and independently mounted editors. */
export const DATA_ACTIONS = {
  // the data studio (boundaries/data.js): boot the owner worker, edit
  // the model/query panes, run + explain, insert, live-event, migrate.
  // A patch-only action carries its changed paths to the O(k) renderer.
  'data/boot': { effects: [{ run: 'data-boot' }] },
  'data/seed': {
    patch: [
      { op: 'replace', path: '/data/modelText', value: '$payload.modelText' },
      { op: 'replace', path: '/data/queryText', value: '$payload.queryText' },
      { op: 'replace', path: '/data/trip/csv', value: '$payload.tripCsv' },
    ],
  },
  // the phone pane switcher (Store · Query · Live) — pure chrome; the
  // store, its live query and its worker are untouched by it
  'data/pane': { patch: [{ op: 'replace', path: '/data/mobilePane', value: '$payload' }] },
  'data/model-text': { patch: [{ op: 'replace', path: '/data/modelText', value: '$event.value' }] },
  'data/query-text': { patch: [{ op: 'replace', path: '/data/queryText', value: '$event.value' }] },
  'data/open': { effects: [{ run: 'data-open', with: { text: '$.data.modelText' } }] },
  'data/run': { effects: [{ run: 'data-run', with: { text: '$.data.queryText' } }] },
  // the title is published per keystroke and read back from state, not
  // from the commit event: a live-query render lands between typing and
  // blurring, and a controlled input whose buffer is not in state is
  // reset to it — silently, taking the insert with it
  'data/insert-draft': { patch: [{ op: 'replace', path: '/data/insertDraft', value: '$event.value' }] },
  'data/insert': {
    patch: [{ op: 'replace', path: '/data/insertDraft', value: '' }],
    effects: [{ run: 'data-insert', with: { title: '$event.value' } }],
  },
  // one stored document removed, by the key its own model declares
  'data/delete': { effects: [{ run: 'data-delete', with: { key: '$payload' } }] },
  'data/migrate': { effects: [{ run: 'data-migrate' }] },
  // the third runner of the spatial corpus, driven from the store pane;
  // the report replaces the last one, and `running` is what shows while
  // the entries are still crossing the worker
  'data/oracle-run': { effects: [{ run: 'data-oracle' }] },
  'data/oracle': { patch: [{ op: 'replace', path: '/data/oracle', value: '$payload' }] },
  // the spatial round trip, driven from the fourth card: the CSV is the
  // editable input, the report replaces the last one, and `running`
  // shows while the throwaway store is crossing the worker
  'data/trip-csv': { patch: [{ op: 'replace', path: '/data/trip/csv', value: '$event.value' }] },
  'data/trip-run': { effects: [{ run: 'data-trip', with: { csv: '$.data.trip.csv' } }] },
  'data/trip': { patch: [{ op: 'replace', path: '/data/trip/report', value: '$payload' }] },
  'data/status': {
    patch: [
      { op: 'replace', path: '/data/topology', value: '$payload.topology' },
      { op: 'replace', path: '/data/vfs', value: '$payload.vfs' },
      { op: 'replace', path: '/data/version', value: { $default: ['$payload.version', ''] } },
      { op: 'replace', path: '/data/refusal', value: { $default: ['$payload.refusal', null] } },
    ],
  },
  'data/opened': {
    patch: [
      { op: 'replace', path: '/data/status', value: 'ready' },
      // a reopen may have moved the studio onto another model's first
      // collection; the boot open stays on the seed model's
      { op: 'replace', path: '/data/collection',
        value: { $default: ['$payload.collection', '$.data.collection'] } },
      { op: 'replace', path: '/data/keyPointer',
        value: { $default: ['$payload.keyPointer', '$.data.keyPointer'] } },
      { op: 'replace', path: '/data/capture', value: '$payload.capabilities.capture' },
      { op: 'replace', path: '/data/version', value: '$payload.capabilities.version' },
      { op: 'replace', path: '/data/operators',
        value: { $default: ['$payload.capabilities.operators', []] } },
      { op: 'replace', path: '/data/pushableOperators',
        value: { $default: ['$payload.capabilities.pushableOperators', []] } },
    ],
  },
  'data/rows': { patch: [{ op: 'replace', path: '/data/rows', value: '$payload.rows' }] },
  'data/results': {
    patch: [
      { op: 'replace', path: '/data/results', value: '$payload.results' },
      { op: 'replace', path: '/data/explain', value: '$payload.explain' },
      { op: 'replace', path: '/data/error', value: null },
    ],
  },
  'data/live': {
    patch: [
      { op: 'replace', path: '/data/live/rows', value: '$payload.rows' },
      { op: 'replace', path: '/data/live/seq', value: null },
    ],
  },
  'data/live-event': {
    patch: [
      { op: 'replace', path: '/data/live/rows', value: '$payload.rows' },
      { op: 'replace', path: '/data/live/seq', value: '$payload.seq' },
    ],
  },
  // the owner's live-registration count (data.lives), refreshed by the
  // boundary after each of its own live events — how a departed tab's
  // released subscription becomes visible
  'data/lives': { patch: [{ op: 'replace', path: '/data/live/regs', value: '$payload.count' }] },
  'data/migrated': { patch: [{ op: 'replace', path: '/data/migration', value: '$payload.report' }] },
  'data/error': { patch: [{ op: 'replace', path: '/data/error', value: '$payload.message' }] },
  // the boot protocol's two terminal states beside `data/opened` (an
  // owner's or a memory tab's first open): a CLIENT tab is ready once it
  // is attached, and a failed stage is the named, stable error record
  'data/ready': { patch: [{ op: 'replace', path: '/data/status', value: 'ready' }] },
  'data/boot-error': {
    patch: [
      { op: 'replace', path: '/data/status', value: 'error' },
      { op: 'replace', path: '/data/boot', value: '$payload' },
      { op: 'replace', path: '/data/error', value: '$payload.message' },
      // nothing about the store is known after a failed boot
      { op: 'replace', path: '/data/topology', value: '—' },
      { op: 'replace', path: '/data/vfs', value: '—' },
      { op: 'replace', path: '/data/refusal', value: null },
    ],
  },
  'data/retry': {
    patch: [
      { op: 'replace', path: '/data/status', value: 'boot' },
      { op: 'replace', path: '/data/boot', value: null },
      { op: 'replace', path: '/data/error', value: null },
      { op: 'replace', path: '/data/topology', value: '—' },
      { op: 'replace', path: '/data/vfs', value: '—' },
      { op: 'replace', path: '/data/refusal', value: null },
    ],
    effects: [{ run: 'data-retry' }],
  },

};

DATA_ACTIONS['data/resume'] = { patch: [{ op: 'replace', path: '/data/status', value: 'boot' }], effects: [{ run: 'data-resume' }] };

DATA_ACTIONS['data/replace'] = { $if: [
  { $eq: [{ modelText: '$.data.modelText', queryText: '$.data.queryText' }, '$payload.expected'] },
  { patch: [
    { op: 'replace', path: '/data/modelText', value: '$payload.modelText' },
    { op: 'replace', path: '/data/queryText', value: '$payload.queryText' },
  ], effects: [{ run: 'data-accepted', with: '$payload.requestId' }] },
  { effects: [{ run: 'data-refused', with: '$payload.requestId' }] },
] };
DATA_ACTIONS['data/execute'] = { effects: [{ run: 'data-editor-run', with: {
  requestId: '$payload.requestId', operation: '$payload.operation', externals: '$payload.externals',
  text: { $if: [{ $eq: ['$payload.operation', 'open'] }, '$.data.modelText', '$.data.queryText'] },
} }] };
