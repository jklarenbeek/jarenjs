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
import { equalsJson } from '@jarenjs/core/object';
import { applyJSONPatch } from '@jarenjs/json/patch';
import { compileJSONPointer, JSONPOINTER_NOTHING } from '@jarenjs/json/pointer';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import { compileContract } from '@jarenjs/contract';
import { openPortClient } from '@jarenjs/contract/port';
import { parseCsv } from '@jarenjs/josl';
import { JarenValidator } from '@jarenjs/validate';
import { from } from '@jarenjs/linq';
import { compileChart } from '@jarenjs/charts';
import { getFormatInfo } from '@jarenjs/forms';

import { OUR_SCHEMA_OPTIONS } from '../lib/schema-options.js';
import contractDoc from '../contracts/data.contract.json' with { type: 'json' };
import geojsonSchema from '@jarenjs/json/schemas/geojson.schema.json' with { type: 'json' };

const CHANNEL = 'jaren-data-studio';

/** The studio's operation contract — the same document the worker serves. */
const contract = compileContract(contractDoc);

/** The phone panes, in switcher order. */
const DATA_PANES = ['store', 'query', 'live', 'trip'];

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

//#region the spatial round trip — CSV to a map, in this tab

/**
 * The CSV the round trip starts from: five cities, three of them inside
 * the region below. The same rows the repository's own round-trip test
 * reads, so what the page shows is what the suite proves.
 */
export const TRIP_CSV = [
  'name,lon,lat,pop',
  'Amsterdam,4.9041,52.3676,921402',
  'Utrecht,5.1214,52.0907,361699',
  'Rotterdam,4.4777,51.9244,651446',
  'Paris,2.3522,48.8566,2102650',
  'Berlin,13.4050,52.5200,3677472',
].join('\n');

/**
 * CSV rows → a `FeatureCollection`, as a JSLT stylesheet and no code.
 * `coordinates` and `features` need the ARRAY CONSTRUCTOR (`[…]`): a
 * two-item sequence in member position is `JQ2001`, and the brackets
 * are what make an array of it.
 */
export const TRIP_STYLESHEET = [{
  match: '$',
  body: {
    type: 'FeatureCollection',
    features: [{
      $for: { r: '$[*]' },
      $return: {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: ['$r.lon', '$r.lat'] },
        properties: { name: '$r.name', pop: '$r.pop' },
      },
    }],
  },
}];

/** The region the query asks about: a box over the Netherlands. */
export const TRIP_REGION = {
  type: 'Polygon',
  coordinates: [[[3.3, 50.7], [7.3, 50.7], [7.3, 53.6], [3.3, 53.6], [3.3, 50.7]]],
};

/** The collection the features are stored in. */
export const TRIP_COLLECTION = 'places';

/**
 * The model the throwaway store opens on: one collection of Features,
 * keyed by rowid, with BOTH derived spatial index kinds over the
 * geometry. The geohash cell is what a cell probe seeks; the bounding
 * box is what `$within` pushes — the planner promotes a containment
 * predicate onto the box columns and refines exactly in the engine.
 */
export const TRIP_MODEL = {
  $model: '0.1',
  collections: {
    [TRIP_COLLECTION]: {
      schema: {
        type: 'object',
        properties: {
          type: { type: 'string' },
          geometry: { type: 'object' },
          properties: { type: 'object' },
        },
      },
      key: null,
      identity: 'integer',
      indexes: [
        { name: 'by_cell', path: '$.geometry', derive: 'geohash', precision: 5 },
        { name: 'by_box', path: '$.geometry', derive: 'bbox' },
      ],
    },
  },
};

/**
 * The query, written through `@jarenjs/linq`: the features whose
 * geometry lies within the region, the region bound at call time so the
 * one compiled document serves any region — the shape a spatial index
 * is probed with.
 * @param {any} source
 */
export const tripChain = (source) => from(source)
  .params({ region: TRIP_REGION })
  .where((f, q) => f.geometry.within(q.region));

/** The chain, as the page shows it beside the document it emits. */
export const TRIP_CHAIN_TEXT = [
  'from(places)',
  '  .params({ region })',
  '  .where((f, q) => f.geometry.within(q.region))',
].join('\n');

/** The stylesheet, compiled once. */
const toGeoJson = compileJsltStylesheet(TRIP_STYLESHEET);

/** The portable GeoJSON meta-schema, compiled once. */
const validateGeoJson = new JarenValidator(OUR_SCHEMA_OPTIONS).compile(geojsonSchema);

/**
 * The round trip's pure half: CSV text → typed rows → a
 * `FeatureCollection` through the stylesheet → the meta-schema's
 * verdict → the documents, the model, the query document and its
 * externals a store executes. Nothing here touches a store; the effect
 * posts the result to `data.oracle` and the Node suite runs the same
 * output through the handler table.
 * @param {string} csvText
 * @returns {{ rows: any[], collection: any, valid: boolean, errors: any[],
 *   documents: any[], model: any, collectionName: string, query: any, externals: any }}
 */
export function tripPipeline(csvText) {
  const rows = parseCsv(csvText, { headers: true, typed: true });
  const collection = toGeoJson(rows);
  const outcome = /** @type {any} */ (validateGeoJson(collection));
  const valid = typeof outcome === 'object' && outcome !== null ? outcome.valid === true : outcome === true;
  const errors = valid ? [] : (outcome?.errors ?? []).slice(0, 8).map((/** @type {any} */ e) =>
    ({ instancePath: e.instancePath ?? '', message: e.message ?? 'invalid' }));
  const documents = valid ? collection.features : [];
  return {
    rows,
    collection,
    valid,
    errors,
    documents,
    model: TRIP_MODEL,
    collectionName: TRIP_COLLECTION,
    query: tripChain(documents).toDocument(),
    externals: { region: TRIP_REGION },
  };
}

/**
 * The preview renderers THIS host has, by the `kind` a format's preview
 * hint names (`@jarenjs/forms`' `getFormatInfo('geojson').preview` is
 * `{ kind: 'map' }`). The hint is data; the renderer is the host's —
 * here `@jarenjs/charts`' map type, which `@jarenjs/forms` may not
 * import. A kind this host has no renderer for draws nothing.
 * @type {Record<string, (features: any, title: string) => any>}
 */
const PREVIEW_RENDERERS = {
  map: (features, title) => compileChart(
    { type: 'map', title, aspect: 1.6, label: 'name' }, { features }, { theme: 'host' }).toVnode(),
};

/**
 * Render a format's preview hint, or nothing: the "host that understands
 * `preview`" half of the forms contract. `null` for no hint and for a
 * kind this host cannot draw.
 * @param {{ kind: string } | null | undefined} preview
 * @param {any} features - a `FeatureCollection`, `Feature` or geometry
 * @param {string} title
 */
export function previewVnode(preview, features, title) {
  const render = preview === null || preview === undefined ? undefined : PREVIEW_RENDERERS[preview.kind];
  return render === undefined ? null : render(features, title);
}

/** One map per report: the view model is rebuilt on every render. */
const tripMaps = new WeakMap();

/**
 * The map of a finished round trip: the region as a ring, the matched
 * features as dots — drawn through the `geojson` format's preview hint.
 * @param {any} report
 */
function tripMap(report) {
  if (report === null || report.status !== 'done') return null;
  let vnode = tripMaps.get(report);
  if (vnode === undefined) {
    const features = {
      type: 'FeatureCollection',
      features: [
        { type: 'Feature', properties: { name: 'the region' }, geometry: TRIP_REGION },
        ...report.results,
      ],
    };
    vnode = previewVnode(getFormatInfo('geojson')?.preview, features, 'Inside the region');
    tripMaps.set(report, vnode);
  }
  return vnode;
}

/**
 * The round trip's verdict, as one line.
 * @param {any} report
 */
export function tripSummary(report) {
  if (report === null || report === undefined) return '';
  if (report.status === 'running') return `${report.rows} CSV rows \u2192 ${report.features} features, valid GeoJSON \u2014 running the query in a throwaway store\u2026`;
  if (report.status === 'error') return `the round trip stopped: ${report.message}`;
  return `${report.rows} CSV rows \u2192 ${report.features} features (valid GeoJSON) \u2192 stored with derived spatial indexes \u2192 ${report.results.length} inside the region`;
}

//#endregion

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

/** The executor this tab is, as a disagreement names it. */
const EXECUTOR = 'sqlite-wasm';

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
 * @param {{ site?: { request: (op: string, input?: any) => Promise<any> } }} [env] -
 *   `site` is the site's data plane, through which the spatial-corpus
 *   artifact is read (`site.corpus`).
 */
export function createDataRuntime(env = {}) {
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
        tripCsv: TRIP_CSV,
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
      if (env.site === undefined || transport === null) {
        dispatch('data/oracle', { status: 'error', message: 'the spatial corpus is not available here' });
        return;
      }
      dispatch('data/oracle', { status: 'running' });
      env.site.request('site.corpus')
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
        trip = tripPipeline(String(props?.csv ?? ''));
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

/** The round trip's constant documents, as the page prints them. */
const TRIP_TEXTS = Object.freeze({
  stylesheet: JSON.stringify(TRIP_STYLESHEET, null, 2),
  model: JSON.stringify(TRIP_MODEL, null, 2),
  query: JSON.stringify(tripChain([]).toDocument(), null, 1),
  region: JSON.stringify(TRIP_REGION),
});
