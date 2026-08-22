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
import { compileJSONPointer, JSONPOINTER_NOTHING } from '@jarenjs/json/pointer';
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

  /** @type {((notice: any) => void) | null} */
  let onNotice = null;
  /** The owner's store-changed notices travel beside the contract frames
   * on whichever transport this tab ended up on, and are told apart by
   * shape — the same arrangement the owner-discovery frames use. */
  const listen = (/** @type {any} */ target) => {
    target.addEventListener('message', (/** @type {any} */ event) => {
      const message = event.data;
      if (message === null || typeof message !== 'object' || message.store === undefined) return;
      onNotice?.(message);
    });
  };

  const boot = async () => {
    worker = new Worker(new URL('../db-worker.js', import.meta.url),
      { type: 'module' });
    // the wasm build + first store open is real work: give init room
    client = openPortClient(contract, { channel: worker, timeoutMs: 30_000 });
    listen(worker);
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
    const shared = new BroadcastChannel(CHANNEL);
    listen(shared);
    client = openPortClient(contract, { channel: shared, timeoutMs: 30_000 });
    return status;
  };

  return {
    boot,
    request,
    subscribe,
    /** @param {(notice: any) => void} cb */
    notices: (cb) => { onNotice = cb; },
  };
}

/**
 * The collection an opened model puts the studio on: the first one it
 * declares. A model with none is a refusal the store itself raises, so
 * this only has to answer honestly for a model that has one.
 * @param {any} model
 * @returns {string}
 */
const firstCollection = (model) => Object.keys(model?.collections ?? {})[0] ?? '';

/**
 * The key pointer a model declares for one of its collections — how a
 * row list names the document a delete is about. Models declare it; the
 * store's own default is `/id`.
 * @param {any} model
 * @param {string} name
 * @returns {string}
 */
const keyPointerOf = (model, name) => model?.collections?.[name]?.key ?? '/id';

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
  /** The collection every effect works on: the model pane is EDITABLE,
   * so naming one literally makes editing the model produce a studio
   * that queries a collection the model no longer declares. It is the
   * first collection the open model declares, and it moves with it. */
  let collection = firstCollection(DATA_MODEL);

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
   * registration count is refreshed (the status surface). It follows the
   * ACTIVE collection, so a reopened model takes the pane with it.
   * @param {(name: string, payload?: any) => void} dispatch
   */
  const subscribeLive = (dispatch) => {
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

  /** Re-read the collection into the store pane.
   * @param {(name: string, payload?: any) => void} dispatch */
  const refreshRows = (dispatch) => transport?.request('data.rows', { collection })
    .then((rows) => dispatch('data/rows', { rows }))
    .catch((error) => dispatch('data/error', { message: String(error.message ?? error) }));

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
                { collection, doc: seedDoc }).catch(() => {});
            }
          }
          // any reopen — a recreate here, a migration anywhere — ends
          // every live registration on the store, so the owner announces
          // it and the pane takes its subscription out again. Without
          // this, a live pane keeps its last rows and goes on looking
          // live while nothing reaches it.
          transport.notices(() => {
            subscribeLive(dispatch);
            refreshRows(dispatch);
          });
          subscribeLive(dispatch);
          await refreshRows(dispatch);
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
          collection = firstCollection(model.value);
          dispatch('data/opened', {
            ...opened, collection, keyPointer: keyPointerOf(model.value, collection),
          });
          subscribeLive(dispatch);
          return refreshRows(dispatch);
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
      transport?.request('data.insert', { collection, doc })
        .then(() => refreshRows(dispatch))
        .catch((error) => dispatch('data/error', { message: String(error.message ?? error) }));
    },
    // the write half the live pane makes visible: a removal arrives there
    // as an RFC 6902 remove, the same feed an insert arrives on
    'data-delete': (props, dispatch) => {
      transport?.request('data.delete', { collection, key: props.key })
        .then(() => refreshRows(dispatch))
        .catch((error) => dispatch('data/error', { message: String(error.message ?? error) }));
    },
    'data-run': (props, dispatch) => {
      const query = parse(props.text, 'query');
      if (!query.ok) {
        dispatch('data/error', { message: query.message });
        return;
      }
      Promise.all([
        transport?.request('data.execute', { collection, document: query.value }),
        transport?.request('data.explain', { collection, document: query.value }),
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
      // the worked migration: index the title member, shadow-verified.
      // The reopen it ends with drops every live registration, and the
      // owner's notice is what puts the pane's subscription back.
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
 * The page's view model — the boundary-exports convention.
 * @param {any} state
 */
export function dataViewModel(state) {
  const data = state.data;
  return {
    collection: data.collection,
    insertPlaceholder: `new ${data.collection} title… (enter inserts)`,
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
    error: data.error,
    // the phone pane (Store · Query · Live)
    mobilePane: pickAllowed(data.mobilePane, DATA_PANES, 'query'),
  };
}
