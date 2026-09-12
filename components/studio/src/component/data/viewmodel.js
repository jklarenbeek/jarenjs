//@ts-check
import { pickAllowed } from '@jarenjs/core/array';
import { compileJSONPointer, JSONPOINTER_NOTHING } from '@jarenjs/json/pointer';
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
function rowList(rows, pointer) {
  const get = keyGetter(pointer);
  return rows.map((doc, index) => {
    const key = get(doc);
    const found = key !== JSONPOINTER_NOTHING;
    return {
      index,
      text: JSON.stringify(doc),
      ...(found ? { key } : {}),
    };
  });
}

/**
 * The oracle's verdict, as one line: what ran, what agreed, what was
 * left out by its marker — or why there is no verdict.
 * @param {any} oracle
 * @returns {string}
 */
export function oracleSummary(oracle) {
  if (oracle === null || oracle === undefined) return '';
  if (oracle.status === 'running') return 'running the spatial corpus through this tab\u2019s store\u2026';
  if (oracle.status === 'error') return `the spatial corpus could not run here: ${oracle.message}`;
  const verdict = oracle.agreed === oracle.ran
    ? `${oracle.executor} agreed with the engine on every entry: ${oracle.agreed} / ${oracle.ran}`
    : `${oracle.executor} DISAGREED with the engine on ${oracle.ran - oracle.agreed} of ${oracle.ran}`;
  return `${verdict} (${oracle.entries} entries \u00d7 ${oracle.mappings.join(', ')});`
    + ` ${oracle.skipped.length} engine-only entries left out by their marker`;
}

/**
 * The page's view model — the boundary-exports convention.
 * @param {any} state
 * @param {any} [options]
 */
export function dataViewModel(state, options = {}) {
  const TRIP_TEXTS = options.trip?.texts ?? {}, TRIP_CHAIN_TEXT = options.trip?.chainText ?? "";
  const tripSummary = options.trip?.summary ?? (() => ""), tripMap = options.trip?.map ?? (() => null);
  const data = state.data;
  return {
    collection: data.collection,
    insertPlaceholder: options.createRow ? `new ${data.collection} title… (enter inserts)` : 'new document as JSON… (enter inserts)',
    tripAvailable: !!options.trip,
    oracleAvailable: typeof options.corpus === 'function' || options.features?.oracle === true,
    migrationAvailable: typeof options.migration === 'function',
    status: data.status,
    boot: data.boot,
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
      ? `${data.operators.length} registered · ${data.pushableOperators.length} pushed to SQLite as UDFs`
      : data.topology === 'client' && data.capture === '—' ? 'the owner\'s (awaiting capabilities)'
        : data.status === 'ready' ? 'none registered' : '—',
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
    liveNote: data.vfs === 'indexeddb-snapshot' ? 'Live queries are unavailable while writes await durable snapshots. The Store pane refreshes after each write.' : '',
    durability: data.vfs === 'opfs-sab'
      ? 'persistent (OPFS with SharedArrayBuffer and cross-origin isolation)'
      : data.vfs === 'indexeddb-snapshot'
        ? 'persistent (atomic IndexedDB snapshots; writes await storage)'
        : data.vfs === 'opfs-sahpool'
      ? 'persistent (OPFS access-handle pool, no special headers)'
      : data.vfs === 'memory' ? 'in-memory (non-durable — persistent storage is unavailable; data lives until reload)'
        : 'not decided yet — the store has not booted',
    modelText: data.modelText,
    queryText: data.queryText,
    rows: data.rows,
    rowCount: data.rows.length,
    rowList: rowList(data.rows, data.keyPointer),
    rowSummary: `${data.rows.length} stored in ${data.collection}`,
    results: data.results,
    resultsJson: JSON.stringify(data.results, null, 1),
    explain: data.explain === null ? null : {
      sql: data.explain.sql,
      params: JSON.stringify(data.explain.params),
      indexes: data.explain.indexes.join(', ') || '(none)',
      residual: data.explain.residual === null
        ? 'none — fully pushed to SQL'
        : JSON.stringify(data.explain.residual.reasons?.map((reason) => reason.construct)),
    },
    live: data.live,
    liveSummary: `${data.live.rows.length} rows, seq ${data.live.seq ?? 0}`,
    liveRegs: data.live.regs === null ? '—' : String(data.live.regs),
    liveJson: JSON.stringify(data.live.rows, null, 1),
    insertDraft: data.insertDraft,
    migration: data.migration,
    migrationSteps: data.migration === null ? ''
      : data.migration.planned.join('\n'),
    migrationSummary: data.migration === null ? ''
      : `applied: ${data.migration.applied.length}`
        + (data.migration.note ? ` — ${data.migration.note}` : ''),
    // the spatial-corpus run: its verdict as one line, the disagreements
    // as lines that name the executor, the entry and the query, and every
    // answer as JSON for the reader (and the e2e spec) to check
    oracle: data.oracle,
    oracleDone: data.oracle?.status === 'done',
    oracleDisagreed: (data.oracle?.disagreements?.length ?? 0) > 0,
    oracleSummary: oracleSummary(data.oracle),
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
    tripIndexes: (data.trip.report?.explain?.indexes ?? []).join(', ') || '(none)',
    tripResidual: data.trip.report?.explain === undefined || data.trip.report?.explain === null ? ''
      : data.trip.report.explain.residual === null
        ? 'none \u2014 fully pushed to SQL'
        : JSON.stringify(data.trip.report.explain.residual.reasons?.map((reason) => reason.construct)),
    tripMap: tripMap(data.trip.report),
    error: data.error,
    // the phone pane (Store · Query · Live · Round trip)
    mobilePane: pickAllowed(data.mobilePane, DATA_PANES, 'query'),
  };
}
