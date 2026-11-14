//@ts-check
import { pickAllowed } from '@jarenjs/core/array';
import { compileJSONPointer, JSONPOINTER_NOTHING } from '@jarenjs/json/pointer';
import { studioTextOf, wordsBy } from '../../messages.js';
const DATA_PANES = ['store', 'query', 'live', 'trip'];
/** One compiled key getter per pointer the models have named: the row
 * list is rebuilt on every live event, and compiling per render would
 * pay for the pointer over and over. */
const keyGetters = new Map();

/** @param {string} pointer */
function keyGetter(pointer) {
  let get = keyGetters.get(pointer);
  if (get === undefined) {
    get = compileJSONPointer(pointer);
    keyGetters.set(pointer, get);
  }
  return get;
}

/**
 * The stored documents as a deletable list. The key comes from the
 * pointer the MODEL declares, not from a member name written here, so a
 * reader who renames the key in the model pane still gets rows they can
 * remove. A document the pointer misses is listed without a key and its
 * control is left out — a delete with nothing to address would be a
 * button that quietly does nothing.
 * @param {any[]} rows
 * @param {string} pointer
 */
function rowList(rows, pointer, w) {
  const get = keyGetter(pointer);
  return rows.map((doc, index) => {
    const key = get(doc);
    const found = key !== JSONPOINTER_NOTHING;
    return {
      index,
      text: JSON.stringify(doc),
      // a row is its own rule, matched at its own node: it carries its words
      w,
      ...(found ? { key } : {}),
    };
  });
}

/** The words of the Data studio's panes, once per catalog. */
const dataWords = wordsBy((t) => ({
  ownerOnly: t('studio/data/owner-only'), store: t('studio/data/store'), topology: t('studio/data/topology'),
  capture: t('studio/data/capture'), operators: t('studio/data/operators'), oracleTitle: t('studio/data/oracle-title'),
  oracleRun: t('studio/data/oracle-run'), oracleJson: t('studio/data/oracle-json'),
  operatorsTitle: t('studio/data/operators-title'), modelTitle: t('studio/data/model-title'),
  recreate: t('studio/data/recreate'), documents: t('studio/data/documents'), query: t('studio/data/query'),
  runExplain: t('studio/data/run-explain'), explainTitle: t('studio/data/explain-title'), params: t('studio/data/params'),
  indexes: t('studio/data/indexes'), residual: t('studio/data/residual'), results: t('studio/data/results'),
  tryOperator: t('studio/data/try-operator'), live: t('studio/data/live'), liveRegs: t('studio/data/live-regs'),
  migration: t('studio/data/migration'), migrationLead: t('studio/data/migration-lead'), migrate: t('studio/data/migrate'),
  planned: t('studio/data/planned'), trip: t('studio/data/trip'), tripRun: t('studio/data/trip-run'),
  tripExplain: t('studio/data/trip-explain'), prefilters: t('studio/data/prefilters'), narrative: t('studio/data/narrative'),
  tripResult: t('studio/data/trip-result'), tripStylesheet: t('studio/data/trip-stylesheet'),
  tripModel: t('studio/data/trip-model'), tripQuery: t('studio/data/trip-query'), tripEmits: t('studio/data/trip-emits'),
  panes: t('studio/panes'), paneStore: t('studio/data/pane-store'), paneQuery: t('studio/data/pane-query'),
  paneLive: t('studio/data/pane-live'), paneTrip: t('studio/data/pane-trip'), booting: t('studio/data/booting'),
  bootFailed: t('studio/data/boot-failed'), bootRetry: t('studio/data/boot-retry'),
  row: { deleteDocument: t('studio/data/delete-document') },
}));

const STAGE = '\u0001', MESSAGE = '\u0002';
/**
 * The boot refusal's sentence split around its two elements (the stage's
 * code, the message), in the order the reader's language puts its words;
 * a translation that drops or reorders the two shows its words first.
 * @param {(id: string, params?: Record<string, unknown>) => string} t
 * @returns {{ before: string, between: string, after: string }}
 */
function bootLine(t) {
  const text = t('studio/data/boot-stage', { stage: STAGE, message: MESSAGE });
  const at = text.indexOf(STAGE), to = text.indexOf(MESSAGE);
  // a translation that drops or reorders them keeps its words, first
  if (at < 0 || to < at) return { before: `${text.replaceAll(STAGE, '').replaceAll(MESSAGE, '')} `, between: ' ', after: '' };
  return { before: text.slice(0, at), between: text.slice(at + 1, to), after: text.slice(to + 1) };
}

/**
 * The oracle's verdict, as one line: what ran, what agreed, what was
 * left out by its marker — or why there is no verdict.
 * @param {any} oracle
 * @param {any} [messages] - the compiled catalog the line speaks (or a
 *   function answering it); English when absent
 * @returns {string}
 */
export function oracleSummary(oracle, messages) {
  if (oracle === null || oracle === undefined) return '';
  const t = studioTextOf(messages);
  if (oracle.status === 'running') return t('studio/data/oracle-running');
  if (oracle.status === 'error') return t('studio/data/oracle-failed', { message: oracle.message });
  const verdict = oracle.agreed === oracle.ran
    ? t('studio/data/oracle-agreed', { executor: oracle.executor, agreed: oracle.agreed, ran: oracle.ran })
    : t('studio/data/oracle-disagreed', { executor: oracle.executor, disagreed: oracle.ran - oracle.agreed, ran: oracle.ran });
  return t('studio/data/oracle-verdict', { verdict, entries: oracle.entries, mappings: oracle.mappings.join(', '),
    skipped: oracle.skipped.length });
}

/**
 * The page's view model — the boundary-exports convention.
 * @param {any} state
 * @param {any} [options] - the host's example (`trip`, `createRow`, …) and
 *   `messages`: the reader's compiled catalog (or a function answering
 *   it); English when absent
 */
export function dataViewModel(state, options = {}) {
  const t = studioTextOf(options.messages);
  const w = dataWords(options.messages);
  const TRIP_TEXTS = options.trip?.texts ?? {}, TRIP_CHAIN_TEXT = options.trip?.chainText ?? "";
  const tripSummary = options.trip?.summary ?? (() => ""), tripMap = options.trip?.map ?? (() => null);
  const data = state.data;
  return {
    w,
    collection: data.collection,
    insertPlaceholder: options.createRow ? t('studio/data/insert-title', { collection: data.collection }) : t('studio/data/insert-json'),
    tripAvailable: !!options.trip,
    oracleAvailable: typeof options.corpus === 'function' || options.features?.oracle === true,
    migrationAvailable: typeof options.migration === 'function',
    status: data.status,
    boot: data.boot,
    bootLine: data.status === 'error' ? bootLine(t) : null,
    // an operational error line shows beside a booted studio; a boot
    // failure is rendered by its own card instead
    plainError: data.status === 'error' ? null : data.error,
    topology: data.topology,
    vfs: data.vfs,
    version: data.version,
    capture: data.capture,
    operators: data.operators,
    pushableOperators: data.pushableOperators,
    operatorSummary: data.operators.length > 0
      ? t('studio/data/operators-summary', { count: data.operators.length, pushed: data.pushableOperators.length })
      : data.topology === 'client' && data.capture === '—' ? t('studio/data/operators-awaiting')
        : data.status === 'ready' ? t('studio/data/operators-none') : '—',
    operatorList: data.operators.join(' ') || '—',
    // a copyable query that exercises both paths: $sqrt is a pushable
    // scalar (a wasm UDF — watch explain() show jaren_p_ in the SQL),
    // $mean folds a series in the residual (explain names it)
    operatorSample: JSON.stringify({
      $for: { it: '$[*]' },
      $where: { $gt: [{ $sqrt: '$it.points' }, 4] },
      $return: '$it',
    }, null, 2),
    refusal: data.refusal,
    // a verdict only once the topology is known: during the boot, and
    // after a boot failure, nothing about OPFS has been learned
    liveNote: data.vfs === 'indexeddb-snapshot' ? t('studio/data/live-unavailable') : '',
    durability: t(data.vfs === 'opfs-sab'
      ? 'studio/data/durable-sab'
      : data.vfs === 'indexeddb-snapshot'
        ? 'studio/data/durable-snapshot'
        : data.vfs === 'opfs-sahpool'
      ? 'studio/data/durable-sahpool'
      : data.vfs === 'memory' ? 'studio/data/durable-memory'
        : 'studio/data/durable-undecided'),
    modelText: data.modelText,
    queryText: data.queryText,
    rows: data.rows,
    rowCount: data.rows.length,
    rowList: rowList(data.rows, data.keyPointer, w.row),
    rowSummary: t('studio/data/rows-stored', { count: data.rows.length, collection: data.collection }),
    results: data.results,
    resultsJson: JSON.stringify(data.results, null, 1),
    explain: data.explain === null ? null : {
      sql: data.explain.sql,
      params: JSON.stringify(data.explain.params),
      indexes: data.explain.indexes.join(', ') || t('studio/data/no-indexes'),
      residual: data.explain.residual === null
        ? t('studio/data/no-residual')
        : JSON.stringify(data.explain.residual.reasons?.map((reason) => reason.construct)),
    },
    live: data.live,
    liveSummary: t('studio/data/live-summary', { count: data.live.rows.length, seq: data.live.seq ?? 0 }),
    liveRegs: data.live.regs === null ? '—' : String(data.live.regs),
    liveJson: JSON.stringify(data.live.rows, null, 1),
    insertDraft: data.insertDraft,
    migration: data.migration,
    migrationSteps: data.migration === null ? ''
      : data.migration.planned.join('\n'),
    migrationSummary: data.migration === null ? ''
      : t('studio/data/applied', { count: data.migration.applied.length })
        + (data.migration.note ? ` — ${data.migration.note}` : ''),
    // the spatial-corpus run: its verdict as one line, the disagreements
    // as lines that name the executor, the entry and the query, and every
    // answer as JSON for the reader (and the e2e spec) to check
    oracle: data.oracle,
    oracleDone: data.oracle?.status === 'done',
    oracleDisagreed: (data.oracle?.disagreements?.length ?? 0) > 0,
    oracleSummary: oracleSummary(data.oracle, options.messages),
    oracleDisagreements: (data.oracle?.disagreements ?? []).join('\n'),
    oracleResultsJson: data.oracle?.status === 'done' ? JSON.stringify({
      executor: data.oracle.executor,
      vfs: data.vfs,
      source: data.oracle.source,
      ran: data.oracle.ran,
      agreed: data.oracle.agreed,
      skipped: data.oracle.skipped,
      results: data.oracle.results,
    }) : '',
    // the spatial round trip: the editable CSV, the constant halves a
    // reader can open (the stylesheet, the model, the chain and the
    // document it emits), and the report — its explain() members named
    // one by one so the two stages are legible, and the map drawn
    // through the geojson format's preview hint
    tripCsv: data.trip.csv,
    tripStylesheet: TRIP_TEXTS.stylesheet,
    tripModel: TRIP_TEXTS.model,
    tripChain: TRIP_CHAIN_TEXT,
    tripQuery: TRIP_TEXTS.query,
    tripRegion: TRIP_TEXTS.region,
    trip: data.trip.report,
    tripStatus: data.trip.report?.status ?? 'idle',
    tripDone: data.trip.report?.status === 'done',
    tripSummary: tripSummary(data.trip.report),
    tripResultsJson: data.trip.report?.status === 'done'
      ? JSON.stringify(data.trip.report.results, null, 1) : '',
    tripExplainSql: data.trip.report?.explain?.sql ?? '',
    tripPrefilters: JSON.stringify(data.trip.report?.explain?.prefilters ?? []),
    tripNarrative: data.trip.report?.explain?.scanNarrative ?? '',
    tripIndexes: (data.trip.report?.explain?.indexes ?? []).join(', ') || t('studio/data/no-indexes'),
    tripResidual: data.trip.report?.explain === undefined || data.trip.report?.explain === null ? ''
      : data.trip.report.explain.residual === null
        ? t('studio/data/no-residual')
        : JSON.stringify(data.trip.report.explain.residual.reasons?.map((reason) => reason.construct)),
    tripMap: tripMap(data.trip.report),
    error: data.error,
    // the phone pane (Store · Query · Live · Round trip)
    mobilePane: pickAllowed(data.mobilePane, DATA_PANES, 'query'),
  };
}
