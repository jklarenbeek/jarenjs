//@ts-check
/**
 * @file The data studio's boundary: the same data layer that runs in
 * Node and Bun, running in the browser. An OWNER tab spawns the
 * dedicated worker (`../db-worker.js`) that holds the sole SQLite
 * connection over the header-free OPFS SAH-pool VFS; a SECOND tab is
 * refused by OPFS exclusivity (the coded JD2061) and downgrades to a
 * CLIENT whose requests travel a `BroadcastChannel` to the owner —
 * LIVE-FORMAT §11 made concrete, with the whole protocol on the
 * @jarenjs/contract PORT binding over the studio's own contract
 * document (`../contracts/data.contract.json`). The binding's
 * client-scoped request ids are what make two client tabs on the one
 * shared channel unable to cross-settle, whatever they fire
 * concurrently; the live query is `client.subscribe` over the stream
 * binding — the snapshot and every `{ patch, seq }` emission arrive as
 * push frames, this boundary applies the patches with
 * `@jarenjs/json/patch` (copy-on-write, the one diff format end to
 * end), and a departing tab's `pagehide` stops the subscription so the
 * owner releases the registration.
 *
 * The page stays a stylesheet; JavaScript lives here: the transport,
 * the effects, and the exported view model (the boundary-exports
 * convention the Flow and Game pages already follow — recorded as THE
 * convention for new pages).
 */

import { pickAllowed } from '@jarenjs/core/array';
import { applyJSONPatch } from '@jarenjs/json/patch';
import { compileContract } from '@jarenjs/contract';
import { openPortClient } from '@jarenjs/contract/port';

import contractDoc from '../contracts/data.contract.json' with { type: 'json' };

const CHANNEL = 'jaren-data-studio';

/** The studio's operation contract — the same document the worker serves. */
const contract = compileContract(contractDoc);

/** The phone panes, in switcher order. */
const DATA_PANES = ['store', 'query', 'live'];

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
 * The transport: a contract PORT client over the own worker (owner) or
 * the shared channel (client). `request` unwraps the binding's D6
 * outcome into the value-or-throw shape the effects consume — a
 * declared `db` failure surfaces the store's own code and message from
 * its details; `subscribe` is the client's stream half, passed through.
 */
function createTransport() {
  /** @type {ReturnType<typeof openPortClient> | null} */
  let client = null;
  /** @type {Worker | null} */
  let worker = null;

  /** @param {any} outcome */
  const unwrap = (outcome) => {
    if (outcome.ok) return outcome.value;
    const details = outcome.error.details;
    const dbError = details !== null && typeof details === 'object' && typeof details.message === 'string';
    const error = new Error(dbError ? details.message : outcome.error.message);
    /** @type {any} */ (error).code = dbError ? details.code : outcome.error.code;
    throw error;
  };

  const request = async (op, args) => unwrap(await /** @type {NonNullable<typeof client>} */ (client).invoke(op, args));

  /** @param {any} input @param {any} callbacks */
  const subscribe = (input, callbacks) => /** @type {NonNullable<typeof client>} */ (client).subscribe('data.live', input, callbacks);

  const boot = async () => {
    worker = new Worker(new URL('../db-worker.js', import.meta.url),
      { type: 'module' });
    // the wasm build + first store open is real work: give init room
    client = openPortClient(contract, { channel: worker, timeoutMs: 30_000 });
    const status = await request('data.init', null);
    if (status.topology !== 'client') {
      // 'owner' (holds the OPFS pool) or 'memory' (OPFS absent — a
      // standalone in-memory store): either way this worker IS the
      // connection; an owner also serves the channel for client tabs.
      return status;
    }
    // another context owns the pool: downgrade to a CLIENT over the
    // channel; this direct worker has nothing to hold, so it dies.
    client.close();
    worker.terminate();
    worker = null;
    client = openPortClient(contract, { channel: new BroadcastChannel(CHANNEL), timeoutMs: 30_000 });
    return status;
  };

  return { boot, request, subscribe };
}

/**
 * The runtime: effects plus the exported view model.
 * @param {{ }} [_env]
 */
export function createDataRuntime(_env = {}) {
  /** @type {ReturnType<typeof createTransport> | null} */
  let transport = null;
  /** @type {{ stop: () => void } | null} */
  let liveSub = null;
  /** @type {any} */
  let liveDoc = null;

  const parse = (text, what) => {
    try {
      return { ok: true, value: JSON.parse(text) };
    }
    catch (error) {
      return { ok: false, message: `${what}: invalid JSON — ${/** @type {any} */ (error).message}` };
    }
  };

  /**
   * (Re)subscribe the live pane over the stream binding: the snapshot
   * replaces the maintained document, each `{ patch, seq }` emission
   * applies copy-on-write, and after every live event the owner's
   * registration count is refreshed (the status surface).
   * @param {string} collection
   * @param {(name: string, payload?: any) => void} dispatch
   */
  const subscribeLive = (collection, dispatch) => {
    liveSub?.stop();
    const refreshRegistrations = () => {
      transport?.request('data.lives', null)
        .then((lives) => dispatch('data/lives', { count: lives.count }))
        .catch(() => {});
    };
    liveSub = /** @type {NonNullable<typeof transport>} */ (transport).subscribe(
      { collection, document: LIVE_QUERY },
      {
        onSnapshot: (/** @type {any} */ value) => {
          liveDoc = value;
          dispatch('data/live', { rows: value.rows });
          refreshRegistrations();
        },
        onPatch: (/** @type {{ patch: any[], seq: number }} */ emission) => {
          liveDoc = applyJSONPatch(liveDoc, emission.patch);
          dispatch('data/live-event', { rows: liveDoc.rows, seq: emission.seq });
          refreshRegistrations();
        },
        onError: (/** @type {any} */ outcome) =>
          dispatch('data/error', { message: outcome.error.message }),
        onEnd: (/** @type {{ reason: string }} */ info) =>
          dispatch('data/error', { message: `live stream ended (${info.reason})` }),
      });
  };

  // A departing tab releases its subscription so the owner's
  // registration is not leaked (the wire's unsubscribe frame). BOTH
  // teardown events are listened for because the engines disagree about
  // which one a closing tab gets: Firefox delivers `beforeunload` and no
  // `pagehide` at all, so a `pagehide`-only release leaks the owner's
  // registration forever there — the count never comes back down and
  // the store keeps feeding a subscription nobody reads. `stop()` is
  // idempotent on both sides (the client marks the stream stopped, the
  // owner's wrapper decrements once), so being told twice costs
  // nothing. The listener never calls `preventDefault`, so it cannot
  // raise the browser's "leave site?" prompt.
  if (typeof addEventListener === 'function') {
    const release = () => liveSub?.stop();
    addEventListener('pagehide', release);
    addEventListener('beforeunload', release);
  }

  const effects = {
    'data-boot': (_props, dispatch) => {
      transport = createTransport();
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
            const opened = await transport.request('data.open', { model: DATA_MODEL });
            dispatch('data/opened', opened);
            for (const seedDoc of SEEDS) {
              await transport.request('data.insert',
                { collection: 'notes', doc: seedDoc }).catch(() => {});
            }
          }
          subscribeLive('notes', dispatch);
          const rows = await transport.request('data.rows', { collection: 'notes' });
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
      transport?.request('data.open', { model: model.value, reset: true })
        .then((opened) => {
          dispatch('data/opened', opened);
          subscribeLive(Object.keys(model.value.collections)[0], dispatch);
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
      transport?.request('data.insert', { collection: 'notes', doc })
        .then(() => transport.request('data.rows', { collection: 'notes' }))
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
        transport?.request('data.execute', { collection: 'notes', document: query.value }),
        transport?.request('data.explain', { collection: 'notes', document: query.value }),
      ])
        .then(([results, explain]) => dispatch('data/results', {
          // an empty sequence crosses the JSON wire as null (undefined
          // is not a JSON value), so both spellings mean "no rows"
          results: Array.isArray(results) ? results
            : results === undefined || results === null ? [] : [results],
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
      transport?.request('data.migrate', { to, id: 'add-title-index' })
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
    error: data.error,
    // the phone pane (Store · Query · Live)
    mobilePane: pickAllowed(data.mobilePane, DATA_PANES, 'query'),
  };
}
