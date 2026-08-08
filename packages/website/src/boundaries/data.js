//@ts-check
/**
 * @file The data studio's boundary: the same data layer that runs in
 * Node and Bun, running in the browser. An OWNER tab spawns the
 * dedicated worker (`../db-worker.js`) that holds the sole SQLite
 * connection over the header-free OPFS SAH-pool VFS; a SECOND tab is
 * refused by OPFS exclusivity (the coded JD2061) and downgrades to a
 * CLIENT whose requests and live registrations travel a
 * `BroadcastChannel` to the owner — LIVE-FORMAT §11 made concrete.
 *
 * The page stays a stylesheet; JavaScript lives here: the transport,
 * the effects, and the exported view model (the boundary-exports
 * convention the Flow and Game pages already follow — recorded as THE
 * convention for new pages).
 */

const CHANNEL = 'jaren-data-studio';

/** The seed model the page boots with (editable in the left pane). */
export const DATA_MODEL = {
  $model: '0.1',
  collections: {
    notes: {
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          points: { type: 'integer' },
        },
      },
      key: '/id',
      indexes: [{ name: 'by_points', path: '$.points' }],
    },
  },
};

/** The seed query (editable in the middle pane). The bare FLWOR
 * (not an array pack) plans natively, so `explain()` shows the
 * by_points index the pushdown chose — the whole point of the pane. */
export const DATA_QUERY = {
  $for: { it: '$[*]' },
  $where: { $gt: ['$it.points', 10] },
  $return: '$it',
};

/** The live query the right pane maintains. */
const LIVE_QUERY = [{ $for: { it: '$[*]' }, $return: '$it' }];

const SEEDS = [
  { id: 'n1', title: 'first note', points: 5 },
  { id: 'n2', title: 'important', points: 40 },
  { id: 'n3', title: 'urgent', points: 25 },
];

/**
 * The transport: talk to the own worker (owner) or the channel
 * (client). One in-flight map serves both.
 * @param {{ onPush: (payload: any) => void,
 *   onStatus: (status: any) => void }} hooks
 */
function createTransport(hooks) {
  /** @type {Map<string, { resolve: Function, reject: Function, timer: any }>} */
  const pending = new Map();
  let seq = 0;
  /** @type {Worker | null} */
  let worker = null;
  /** @type {BroadcastChannel | null} */
  let channel = null;
  let mode = 'boot';

  const settle = (response) => {
    const entry = pending.get(response.id);
    if (entry === undefined) return;
    pending.delete(response.id);
    clearTimeout(entry.timer);
    if (response.ok) entry.resolve(response.value);
    else {
      const error = new Error(response.error.message);
      /** @type {any} */ (error).code = response.error.code;
      entry.reject(error);
    }
  };

  const request = (kind, args, timeoutMs = 15_000) => new Promise((resolve, reject) => {
    const id = `r${++seq}`;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`the ${mode === 'client' ? 'owner tab' : 'worker'} `
        + `did not answer '${kind}' within ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    const message = { id, kind, args };
    if (mode === 'client') channel?.postMessage({ clientReq: message });
    else worker?.postMessage(message);
  });

  const boot = async () => {
    worker = new Worker(new URL('../db-worker.js', import.meta.url),
      { type: 'module' });
    worker.onmessage = (event) => {
      const data = event.data;
      if (data?.ready === true) return;
      if (data?.push !== undefined) {
        hooks.onPush(data.push);
        return;
      }
      settle(data);
    };
    const status = await request('init', {}, 30_000);
    if (status.topology !== 'client') {
      // 'owner' (holds the OPFS pool) or 'memory' (OPFS absent — a
      // standalone in-memory store): either way this worker IS the
      // connection, and it already joined the channel to serve clients.
      mode = 'owner';
      return status;
    }
    // another context owns the pool: downgrade to a CLIENT over the
    // channel; this direct worker has nothing to hold, so it dies.
    worker.terminate();
    worker = null;
    mode = 'client';
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event) => {
      const data = event.data;
      if (data?.clientRes !== undefined) settle(data.clientRes);
      else if (data?.clientPush !== undefined) hooks.onPush(data.clientPush);
    };
    return status;
  };

  return { boot, request, mode: () => mode };
}

/**
 * The runtime: effects plus the exported view model.
 * @param {{ }} [_env]
 */
export function createDataRuntime(_env = {}) {
  /** @type {ReturnType<typeof createTransport> | null} */
  let transport = null;
  /** @type {string | null} */
  let liveId = null;

  const parse = (text, what) => {
    try {
      return { ok: true, value: JSON.parse(text) };
    }
    catch (error) {
      return { ok: false, message: `${what}: invalid JSON — ${/** @type {any} */ (error).message}` };
    }
  };

  const effects = {
    'data-boot': (_props, dispatch) => {
      transport = createTransport({
        onPush: (payload) => {
          if (payload.liveId !== liveId) return;
          dispatch('data/live-event', {
            rows: payload.event.rows, seq: payload.event.seq ?? null,
            error: payload.event.error?.message ?? null,
          });
        },
        onStatus: () => {},
      });
      // seed the editor panes with the starting documents
      dispatch('data/seed', {
        modelText: JSON.stringify(DATA_MODEL, null, 2),
        queryText: JSON.stringify(DATA_QUERY, null, 2),
      });
      transport.boot()
        .then(async (status) => {
          dispatch('data/status', status);
          // an owner (OPFS) and a standalone memory tab each hold their
          // OWN connection, so both open and seed; only a CLIENT attaches
          // to the connection the owner already holds (LIVE-FORMAT §11)
          if (status.topology !== 'client') {
            const opened = await transport.request('open', { model: DATA_MODEL });
            dispatch('data/opened', opened);
            for (const seedDoc of SEEDS) {
              await transport.request('insert',
                { collection: 'notes', doc: seedDoc }).catch(() => {});
            }
          }
          const live = await transport.request('live',
            { collection: 'notes', document: LIVE_QUERY });
          liveId = live.liveId;
          dispatch('data/live', { mode: live.mode, rows: live.rows });
          const rows = await transport.request('rows', { collection: 'notes' });
          dispatch('data/rows', { rows });
        })
        .catch((error) => dispatch('data/error', { message: String(error.message ?? error) }));
    },
    'data-open': (props, dispatch) => {
      const model = parse(props.text, 'model');
      if (!model.ok) {
        dispatch('data/error', { message: model.message });
        return;
      }
      transport?.request('open', { model: model.value, reset: true })
        .then(async (opened) => {
          dispatch('data/opened', opened);
          const live = await transport.request('live',
            { collection: Object.keys(model.value.collections)[0], document: LIVE_QUERY });
          liveId = live.liveId;
          dispatch('data/live', { mode: live.mode, rows: live.rows });
        })
        .catch((error) => dispatch('data/error', { message: String(error.message ?? error) }));
    },
    'data-insert': (props, dispatch) => {
      const title = String(props?.title ?? '').trim();
      if (title === '') return;
      const doc = {
        id: `n${Math.random().toString(36).slice(2, 8)}`,
        title,
        points: Math.floor(Math.random() * 50),
      };
      transport?.request('insert', { collection: 'notes', doc })
        .then(() => transport.request('rows', { collection: 'notes' }))
        .then((rows) => dispatch('data/rows', { rows }))
        .catch((error) => dispatch('data/error', { message: String(error.message ?? error) }));
    },
    'data-run': (props, dispatch) => {
      const query = parse(props.text, 'query');
      if (!query.ok) {
        dispatch('data/error', { message: query.message });
        return;
      }
      Promise.all([
        transport?.request('execute', { collection: 'notes', document: query.value }),
        transport?.request('explain', { collection: 'notes', document: query.value }),
      ])
        .then(([results, explain]) => dispatch('data/results', {
          results: Array.isArray(results) ? results
            : results === undefined ? [] : [results],
          explain: {
            sql: explain.sql,
            params: explain.params,
            indexes: explain.indexes,
            residual: explain.residual,
          },
        }))
        .catch((error) => dispatch('data/error', { message: String(error.message ?? error) }));
    },
    'data-migrate': (_props, dispatch) => {
      // the worked migration: index the title member, shadow-verified
      const to = JSON.parse(JSON.stringify(DATA_MODEL));
      to.collections.notes.indexes.push({ name: 'by_title', path: '$.title' });
      transport?.request('migrate', { to, id: 'add-title-index' })
        .then((report) => dispatch('data/migrated', { report }))
        .catch((error) => dispatch('data/error', { message: String(error.message ?? error) }));
    },
  };

  // the boot subscription (browser-only): fires once when #/data is
  // first reached. Lives here, in the coverage-excluded boundary,
  // because it constructs a Worker no headless test can host.
  let booted = false;
  const ownerSub = (_props, dispatch) => {
    if (booted) return;
    booted = true;
    dispatch('data/boot');
  };

  return { effects, ownerSub };
}

/**
 * The page's view model — the boundary-exports convention.
 * @param {any} state
 */
export function dataViewModel(state) {
  const data = state.data;
  return {
    status: data.status,
    topology: data.topology,
    vfs: data.vfs,
    version: data.version,
    capture: data.capture,
    operators: data.operators,
    pushableOperators: data.pushableOperators,
    operatorSummary: data.operators.length === 0
      ? 'none registered'
      : `${data.operators.length} registered · ${data.pushableOperators.length} pushed to SQLite as UDFs`,
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
    durability: data.vfs === 'opfs-sahpool'
      ? 'persistent (OPFS access-handle pool, no special headers)'
      : 'in-memory (OPFS unavailable here — data lives until reload)',
    modelText: data.modelText,
    queryText: data.queryText,
    rows: data.rows,
    rowCount: data.rows.length,
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
    liveStrategy: data.live.mode?.strategy ?? '—',
    liveSummary: `${data.live.rows.length} rows, seq ${data.live.seq ?? 0}`,
    liveJson: JSON.stringify(data.live.rows, null, 1),
    insertDraft: '',
    migration: data.migration,
    migrationSteps: data.migration === null ? ''
      : data.migration.planned.join('\n'),
    migrationSummary: data.migration === null ? ''
      : `applied: ${data.migration.applied.length}`
        + (data.migration.note ? ` — ${data.migration.note}` : ''),
    error: data.error,
    // the phone pane (Store · Query · Live); whitelisted, so a junk
    // value cannot blank the studio — it falls back to the query
    mobilePane: data.mobilePane === 'store' || data.mobilePane === 'live'
      ? data.mobilePane : 'query',
  };
}
