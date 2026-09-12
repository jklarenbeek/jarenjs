//@ts-check
/** Data operations and store lifecycle, independent of any route or SQLite initializer. */
import { equalsJson } from '@jarenjs/core/object';
import { applyJSONPatch } from '@jarenjs/json/patch';
import { createTransport } from './transport.js';
import { bootFailure } from './boot-stages.js';
/** The live query the right pane maintains. */
const LIVE_QUERY = [{ $for: { it: '$[*]' }, $return: '$it' }];


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

/** The executor this tab is, as a disagreement names it. */


/**
 * Whether one oracle answer is the one the engine recorded: the empty
 * sequence crosses as a flag (null is an answer), everything else as
 * JSON, compared structurally.
 * @param {any} entry - a corpus entry, as the site ships it
 * @param {{ answer: any, empty: boolean }} outcome
 */
const agrees = (entry, outcome) => (entry.empty === true
  ? outcome.empty === true
  : outcome.empty === false && equalsJson(outcome.answer, entry.expected));

/** What the engine recorded, spelled for a report line. */
const recorded = (/** @type {any} */ entry) => (entry.empty === true
  ? 'the empty sequence' : JSON.stringify(entry.expected));

/**
 * The runtime: effects plus the exported view model.
 * @param {any} env - explicit seed documents, transport, lifecycle and optional worked examples.
 */
export function createDataRuntime(env = {}) {
  const EXECUTOR = env.executor ?? 'sqlite';
  const buildTransport = env.transport ?? (() => createTransport(env.transportOptions));
  const DATA_MODEL = structuredClone(env.model), DATA_QUERY = structuredClone(env.query),
    SEEDS = structuredClone(env.seeds ?? []), TRIP_CSV = env.trip?.csv ?? '';
  /** @type {ReturnType<typeof createTransport> | null} */
  let transport = null;
  /** @type {{ stop: () => void } | null} */
  let liveSub = null;
  /** @type {any} */
  let liveDoc = null;
  let liveAvailable = true;
  let topology = 'boot', disposed = false, generation = 0;
  const lifecycleTarget = env.lifecycleTarget ?? globalThis;
  const releaseLive = () => liveSub?.stop();
  let activeModel = DATA_MODEL;
  /** The collection every effect works on: the model pane is EDITABLE,
   * so naming one literally makes editing the model produce a studio
   * that queries a collection the model no longer declares. It is the
   * first collection the open model declares, and it moves with it. */
  let collection = firstCollection(DATA_MODEL);

  /** A reopen notice and an attach response describe the same store. */
  const acceptStore = (opened = {}, dispatch) => {
    activeModel = opened.model ?? activeModel;
    collection = opened.collection ?? firstCollection(activeModel);
    liveAvailable = opened?.capabilities?.live !== false;
    dispatch('data/opened', {
      ...opened, collection, keyPointer: opened.keyPointer ?? keyPointerOf(activeModel, collection),
    });
  };

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
    if (!liveAvailable) { liveSub = null; return; }
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
          dispatch('data/error', { message: outcome.error.details?.message ?? outcome.error.message }),
        onEnd: (/** @type {{ reason: string }} */ info) =>
          dispatch('data/error', { message: `live stream ended (${info.reason})` }),
      });
  };

  /** Whether a store is there to talk to; an effect that needs one says
   * so instead of doing nothing (or throwing on an undefined answer).
   * @param {(name: string, payload?: any) => void} dispatch */
  const withStore = (dispatch) => {
    if (transport !== null) return true;
    dispatch('data/error', { message: 'the store is not booted — retry the boot first' });
    return false;
  };

  /** Destructive model changes belong to the tab holding the database. */
  const withOwner = (dispatch) => {
    if (!withStore(dispatch)) return false;
    if (topology === 'owner') return true;
    dispatch('data/error', { message: 'Only the owning tab can recreate or migrate the store.' });
    return false;
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
  // owner's wrapper releases once), so being told twice costs
  // nothing. The listener never calls `preventDefault`, so it cannot
  // raise the browser's "leave site?" prompt.
  lifecycleTarget.addEventListener?.('pagehide', releaseLive);
  lifecycleTarget.addEventListener?.('beforeunload', releaseLive);

  /**
   * The boot, as the closed protocol: every attempt ends in `ready` or in
   * the named `error` state, and a failed attempt tears its transport down
   * before the page hears of it, so a retry (or a reload) starts clean and
   * no worker, client, channel, listener or subscription outlives the
   * failure. A previous transport — a retry after an error — is closed
   * first, so exactly one transport ever exists.
   * @param {(name: string, payload?: any) => void} dispatch
   */
  const bootStore = async (dispatch, bootModel = DATA_MODEL) => {
    if (disposed) return;
    liveSub?.stop();
    liveSub = null;
    transport?.close();
    // the boot opens the SEED model: whatever a reopen moved the studio
    // onto, this attempt works on the seed model's first collection
    collection = firstCollection(bootModel);
    activeModel = bootModel;
    topology = 'boot';
    const booting = buildTransport();
    transport = booting;
    /** A later boot took over: this attempt is over and says nothing. */
    const superseded = () => transport !== booting;
    try {
      const status = await booting.boot();
      if (superseded()) return;
      topology = status.topology;
      liveAvailable = status.vfs !== 'indexeddb-snapshot';
      dispatch('data/status', status);
      // an owner (OPFS) and a standalone memory tab each hold their
      // OWN connection, so both open and seed; only a CLIENT attaches
      // to the connection the owner already holds (LIVE-FORMAT §11)
      if (status.topology !== 'client') {
        const opened = await booting.bounded('store-open',
          () => booting.request('data.open', { model: bootModel }));
        if (superseded()) return;
        acceptStore(opened, dispatch);
        for (const seedDoc of SEEDS) {
          await booting.request('data.insert',
            { collection, doc: seedDoc }).catch(() => {});
        }
      }
      else {
        // On the channel, open without reset only reads the owner's
        // current model and capabilities; it never reopens the store.
        const opened = await booting.bounded('store-open',
          () => booting.request('data.open', { model: bootModel }));
        if (superseded()) return;
        acceptStore(opened, dispatch);
      }
    }
    catch (error) {
      if (superseded()) return;
      const failure = bootFailure(booting.stage(), error);
      booting.close();
      transport = null;
      dispatch('data/boot-error', failure.toJSON());
      return;
    }
    if (superseded()) return;
    booting.settled();
    booting.faults((fault) => dispatch('data/error', { message: fault.message }));
    // any reopen — a recreate here, a migration anywhere — ends
    // every live registration on the store, so the owner announces
    // it and the pane takes its subscription out again. Without
    // this, a live pane keeps its last rows and goes on looking
    // live while nothing reaches it.
    booting.notices((notice) => {
      acceptStore(notice, dispatch);
      subscribeLive(dispatch);
      refreshRows(dispatch);
    });
    subscribeLive(dispatch);
    await refreshRows(dispatch);
  };

  const effects = {
    'data-boot': (_props, dispatch) => {
      // seed the editor panes with the starting documents
      dispatch('data/seed', {
        modelText: JSON.stringify(DATA_MODEL, null, 2),
        queryText: JSON.stringify(DATA_QUERY, null, 2),
        tripCsv: TRIP_CSV,
      });
      return bootStore(dispatch);
    },
    // a retry after a terminal boot error: the same protocol, from a
    // clean start — the failed transport was already released
    'data-retry': (_props, dispatch) => bootStore(dispatch),
    'data-resume': (_props, dispatch) => bootStore(dispatch, activeModel),
    'data-open': (props, dispatch) => {
      if (!withOwner(dispatch)) return Promise.resolve({ ok: false, error: 'Only the owning tab can recreate the store.' });
      const model = parse(props.text, 'model');
      if (!model.ok) {
        dispatch('data/error', { message: model.message });
        return Promise.resolve({ ok: false, error: model.message });
      }
      return transport?.request('data.open', { model: model.value, reset: true })
        .then((opened) => {
          acceptStore({ model: model.value, ...opened }, dispatch);
          subscribeLive(dispatch);
          return refreshRows(dispatch).then(() => ({ ok: true, model: model.value }));
        })
        .catch(error => { const message = String(error.message ?? error); dispatch('data/error', { message }); return { ok: false, error: message, code: error.code }; });
    },
    'data-insert': (props, dispatch) => {
      if (!withStore(dispatch)) return;
      const title = String(props?.title ?? '').trim();
      if (title === '') return;
      let doc;
      try { doc = env.createRow ? env.createRow(title) : JSON.parse(title); }
      catch (error) { dispatch('data/error', { message: `document: invalid JSON — ${error.message}` }); return; }
      transport?.request('data.insert', { collection, doc })
        .then(() => refreshRows(dispatch))
        .catch((error) => dispatch('data/error', { message: String(error.message ?? error) }));
    },
    // the write half the live pane makes visible: a removal arrives there
    // as an RFC 6902 remove, the same feed an insert arrives on
    'data-delete': (props, dispatch) => {
      if (!withStore(dispatch)) return;
      transport?.request('data.delete', { collection, key: props.key })
        .then(() => refreshRows(dispatch))
        .catch((error) => dispatch('data/error', { message: String(error.message ?? error) }));
    },
    'data-run': (props, dispatch) => {
      if (!withStore(dispatch)) return Promise.resolve({ ok: false, error: 'The store is not booted.' });
      const query = parse(props.text, 'query');
      if (!query.ok) { dispatch('data/error', { message: query.message }); return Promise.resolve({ ok: false, error: query.message }); }
      const args = { collection, document: query.value, ...(props.externals ? { externals: props.externals } : {}) };
      return Promise.all([transport.request('data.execute', args), transport.request('data.explain', args)])
        .then(([value, explain]) => {
          const results = Array.isArray(value) ? value : value == null ? [] : [value];
          const plan = { sql: explain.sql, params: explain.params, indexes: explain.indexes, residual: explain.residual };
          dispatch('data/results', { results, explain: plan });
          return { ok: true, result: value, explain: plan };
        })
        .catch(error => {
          const message = String(error.message ?? error); dispatch('data/error', { message });
          return { ok: false, error: message, code: error.code };
        });
    },
    // the third runner of the spatial corpus: every entry the site ships
    // (the committed fixture, projected for a store) runs through THIS
    // tab's wasm build in a throwaway in-memory store — under the model
    // with the derived indexes and the one without — and is compared
    // with what the JavaScript engine recorded. The e2e spec reads every
    // answer off the page and asserts it against the fixture on disk
    // itself; this effect executes, compares for the reader, and counts.
    // A store refusal on an entry is a DISAGREEMENT here, never a skip:
    // the only entries not run are the ones the corpus marks.
    'data-oracle': (_props, dispatch) => {
      if (env.corpus === undefined || transport === null) {
        dispatch('data/oracle', { status: 'error', message: 'the spatial corpus is not available here' });
        return;
      }
      dispatch('data/oracle', { status: 'running' });
      env.corpus()
        .then(async (loaded) => {
          if (!loaded.ok) throw new Error(loaded.reason);
          const corpus = loaded.value;
          const results = [];
          const disagreements = [];
          for (const [mapping, model] of Object.entries(corpus.mappings)) {
            for (const entry of corpus.entries) {
              const where = `${EXECUTOR} (${mapping}) disagreed on ${entry.name}`
                + ` — query ${JSON.stringify(entry.query)}`;
              let outcome;
              try {
                outcome = await /** @type {NonNullable<typeof transport>} */ (transport)
                  .request('data.oracle', {
                    model, collection: corpus.collection,
                    documents: entry.documents, query: entry.query,
                  });
              }
              catch (error) {
                const message = String(/** @type {any} */ (error).message ?? error);
                results.push({ mapping, name: entry.name, error: message, agreed: false });
                disagreements.push(`${where}: refused — ${message}`);
                continue;
              }
              const agreed = agrees(entry, outcome);
              results.push({ mapping, name: entry.name, answer: outcome.answer, empty: outcome.empty, agreed });
              if (!agreed) {
                disagreements.push(`${where}: recorded ${recorded(entry)}, answered `
                  + `${outcome.empty ? 'the empty sequence' : JSON.stringify(outcome.answer)}`);
              }
            }
          }
          dispatch('data/oracle', {
            status: 'done',
            executor: EXECUTOR,
            source: corpus.source,
            mappings: Object.keys(corpus.mappings),
            entries: corpus.entries.length,
            ran: results.length,
            agreed: results.filter((result) => result.agreed).length,
            skipped: corpus.skipped,
            disagreements,
            results,
          });
        })
        .catch((error) => dispatch('data/oracle',
          { status: 'error', message: String(error.message ?? error) }));
    },
    // the whole round trip, where a reader can watch it: the pure half
    // runs here (CSV → stylesheet → meta-schema → the linq document),
    // the store half runs in the worker over a throwaway store with the
    // derived spatial indexes, and its explain() comes back beside the
    // answer so the pushdown is visible next to the result it produced
    'data-trip': (props, dispatch) => {
      if (transport === null) {
        dispatch('data/trip', { status: 'error', message: 'the store is not ready yet' });
        return;
      }
      let trip;
      try {
        trip = env.trip.pipeline(String(props?.csv ?? ''));
      }
      catch (error) {
        dispatch('data/trip', { status: 'error', message: String(/** @type {any} */ (error).message ?? error) });
        return;
      }
      if (!trip.valid) {
        const first = trip.errors[0];
        dispatch('data/trip', {
          status: 'error',
          rows: trip.rows.length,
          message: `the stylesheet's output is not GeoJSON by the meta-schema`
            + (first === undefined ? '' : ` \u2014 ${first.instancePath || '/'}: ${first.message}`),
          errors: trip.errors,
        });
        return;
      }
      const counts = { rows: trip.rows.length, features: trip.documents.length };
      dispatch('data/trip', { status: 'running', ...counts });
      transport.request('data.oracle', {
        model: trip.model, collection: trip.collectionName, documents: trip.documents,
        query: trip.query, externals: trip.externals, explain: true,
      })
        .then((outcome) => dispatch('data/trip', {
          status: 'done',
          ...counts,
          query: trip.query,
          results: outcome.empty ? []
            : Array.isArray(outcome.answer) ? outcome.answer : [outcome.answer],
          explain: outcome.explain ?? null,
        }))
        .catch((error) => dispatch('data/trip',
          { status: 'error', ...counts, message: String(error.message ?? error) }));
    },
    'data-migrate': (_props, dispatch) => {
      if (!withOwner(dispatch)) return;
      // the worked migration: index the title member, shadow-verified.
      // The reopen it ends with drops every live registration, and the
      // owner's notice is what puts the pane's subscription back.
      if (!env.migration) { dispatch('data/error', { message: 'This host has no migration configured.' }); return; }
      const { to, id } = env.migration(activeModel, collection);
      return transport?.request('data.migrate', { to, id })
        .then((report) => {
          activeModel = to;
          dispatch('data/migrated', { report });
        })
        .catch((error) => dispatch('data/error', { message: String(error.message ?? error) }));
    },
  };

  let booted = false, seeded = false;
  function release() {
    generation++; liveSub?.stop(); liveSub = null; transport?.close(); transport = null; booted = false;
  }
  function dispose() {
    if (disposed) return;
    disposed = true; release();
    lifecycleTarget.removeEventListener?.('pagehide', releaseLive);
    lifecycleTarget.removeEventListener?.('beforeunload', releaseLive);
  }
  // Every asynchronous callback belongs to the activation that started it.
  // A departed route, disposed mount or replacement boot cannot publish late results.
  for (const [name, effect] of Object.entries(effects)) {
    effects[name] = (props, dispatch) => {
      if (disposed) return Promise.resolve({ ok: false, error: 'The Data editor is disposed.' });
      if (['data-boot', 'data-retry', 'data-resume'].includes(name)) generation++;
      const current = generation;
      return effect(props, (action, payload) => {
        if (!disposed && current === generation) dispatch(action, payload);
      });
    };
  }
  effects['data-boot'].dispose = dispose;
  const ownerSub = (_props, dispatch) => {
    if (disposed || booted) return;
    booted = true;
    dispatch(seeded ? 'data/resume' : 'data/boot'); seeded = true;
    return release;
  };
  return { effects, ownerSub, dispose };
}
