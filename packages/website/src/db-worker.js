//@ts-check
/**
 * @file The data studio's OWNER worker (LIVE-FORMAT §11): one context
 * holds the sole connection. The worker loads the official SQLite
 * wasm build, tries the header-free OPFS SAH-pool VFS (GitHub Pages
 * cannot set COOP/COEP, so the SharedArrayBuffer VFS family is out
 * for this host) and falls back to in-memory with the durability
 * difference REPORTED, not hidden. The oo1 API is synchronous in a
 * dedicated worker, which is exactly what keeps journal capture and
 * live queries working unchanged.
 *
 * Two transports, one dispatch: `postMessage` serves the owning tab;
 * a `BroadcastChannel` serves CLIENT tabs — their requests run on
 * this same store and their live registrations stream back over the
 * channel. A second tab's attempt to install the pool is refused by
 * OPFS exclusivity; the refusal surfaces as the coded JD2061 and the
 * tab downgrades to a client.
 */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { openStore, migrate, planModelMigration } from '@jarenjs/db';
import { wasmDriver, sqlite3Handle } from '@jarenjs/db/wasm';

const CHANNEL = 'jaren-data-studio';
const POOL = 'jaren-data';
const DB_NAME = '/jaren-data-studio.db';

const state = {
  /** @type {any} */ sqlite3: null,
  /** @type {any} */ poolUtil: null,
  vfs: 'memory',
  isOwner: false,
  /** @type {any} */ store: null,
  /** @type {any} */ model: null,
  /** @type {Map<string, any>} */ lives: new Map(),
  liveSeq: 0,
};

const channel = new BroadcastChannel(CHANNEL);

/** Serialize an error for the wire, keeping the coded contract. */
const wireError = (error) => ({
  code: /** @type {any} */ (error)?.code,
  message: String(/** @type {any} */ (error)?.message ?? error),
});

/** Race a promise against a timeout so a hung OPFS install (some
 * engines never settle `installOpfsSAHPoolVfs`) cannot wedge boot. */
const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_resolve, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
]);

/** Ask the channel whether an OPFS owner already exists (§11). A
 * running owner answers its pong; silence within the window means no
 * owner, so a failed OPFS install is "absent", not "held". */
function pingForOwner(ms = 600) {
  return new Promise((resolve) => {
    const token = `ping-${state.sqlite3.version.libVersion}-${Math.floor(ms)}`;
    const onPong = (event) => {
      if (event.data?.pong === token) {
        channel.removeEventListener('message', onPong);
        resolve(true);
      }
    };
    channel.addEventListener('message', onPong);
    channel.postMessage({ ping: token });
    setTimeout(() => {
      channel.removeEventListener('message', onPong);
      resolve(false);
    }, ms);
  });
}

async function init() {
  state.sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
  try {
    state.poolUtil = await withTimeout(
      state.sqlite3.installOpfsSAHPoolVfs({ name: POOL }), 8_000, 'OPFS pool install');
    state.vfs = 'opfs-sahpool';
    state.isOwner = true;
    return { topology: 'owner', vfs: state.vfs, version: state.sqlite3.version.libVersion };
  }
  catch (error) {
    // OPFS could not be claimed: either another tab HOLDS it (an owner
    // exists — become a client) or it is ABSENT here (no owner — run a
    // standalone in-memory store). The channel ping tells them apart,
    // so neither case hangs.
    state.poolUtil = null;
    state.vfs = 'memory';
    const ownerExists = await pingForOwner();
    if (ownerExists) {
      return {
        topology: 'client', vfs: 'opfs-sahpool',
        version: state.sqlite3.version.libVersion,
        refusal: {
          code: 'JD2061',
          message: `another context owns the database (${wireError(error).message}) `
            + '— this tab is a client of the owner over a BroadcastChannel',
        },
      };
    }
    return {
      topology: 'memory', vfs: 'memory',
      version: state.sqlite3.version.libVersion,
      refusal: {
        code: 'JD2061',
        message: 'OPFS is unavailable in this context — running a standalone '
          + 'in-memory store (no cross-tab owner)',
      },
    };
  }
}

async function open(args) {
  if (state.store !== null) {
    await state.store.close();
    state.store = null;
    state.lives.clear();
  }
  const handle = state.vfs === 'opfs-sahpool'
    ? sqlite3Handle(state.sqlite3, { DbClass: state.poolUtil.OpfsSAHPoolDb })
    : sqlite3Handle(state.sqlite3);
  if (args.reset === true && state.poolUtil !== null) {
    state.poolUtil.unlink(DB_NAME);
  }
  const path = state.vfs === 'opfs-sahpool' ? DB_NAME : ':memory:';
  state.model = args.model;
  state.store = await openStore(args.model,
    { driver: wasmDriver(handle), path, capture: true });
  return {
    vfs: state.vfs,
    capabilities: {
      version: state.store.capabilities.version,
      capture: state.store.capabilities.capture,
      live: state.store.capabilities.live,
    },
  };
}

/** One request dispatch for BOTH transports. */
async function handle(kind, args, push) {
  switch (kind) {
    case 'init': return init();
    case 'open': return open(args);
    case 'insert':
      return state.store.collection(args.collection).insert(args.doc);
    case 'put':
      return state.store.collection(args.collection).put(args.doc, args.key);
    case 'delete':
      return state.store.collection(args.collection).delete(args.key);
    case 'rows':
      return state.store.collection(args.collection)
        .execute([{ $for: { it: '$[*]' }, $return: '$it' }]);
    case 'execute':
      return state.store.collection(args.collection)
        .execute(args.document, { externals: args.externals ?? {} });
    case 'explain':
      return state.store.collection(args.collection)
        .explain(args.document, { externals: args.externals ?? {} });
    case 'live': {
      const live = await state.store.collection(args.collection)
        .live(args.document);
      const liveId = `L${++state.liveSeq}`;
      const stop = live.subscribe((event) => {
        push({ liveId, event: {
          ...(event.patch !== undefined ? { patch: event.patch, seq: event.seq } : {}),
          ...(event.error !== undefined ? { error: wireError(event.error) } : {}),
          rows: live.result.rows,
        } });
      });
      state.lives.set(liveId, { live, stop });
      return { liveId, mode: live.mode, rows: live.result.rows };
    }
    case 'live-close': {
      const entry = state.lives.get(args.liveId);
      if (entry !== undefined) {
        entry.stop();
        entry.live.close();
        state.lives.delete(args.liveId);
      }
      return true;
    }
    case 'migrate': {
      const { migration, report } = planModelMigration(state.model, args.to,
        { dialect: state.store.dialect, id: args.id ?? 'studio-migration' });
      const rendered = migration.steps.map((step) => step.sql ?? step.kind);
      await state.store.close();
      state.store = null;
      const driver = wasmDriver(state.vfs === 'opfs-sahpool'
        ? sqlite3Handle(state.sqlite3, { DbClass: state.poolUtil.OpfsSAHPoolDb })
        : sqlite3Handle(state.sqlite3));
      const path = state.vfs === 'opfs-sahpool' ? DB_NAME : ':memory:';
      let applied;
      try {
        applied = state.vfs === 'opfs-sahpool'
          ? await migrate({ driver, path }, [migration],
            { baseline: state.model, model: args.to, shadow: true })
          : { applied: [], note: 'memory stores recreate instead of migrating' };
      }
      finally {
        state.model = args.to;
        state.store = await openStore(args.to, { driver, path, capture: true });
        state.lives.clear();
      }
      return {
        planned: rendered,
        losses: report?.losses ?? [],
        applied: applied.applied?.map((entry) => entry.id) ?? [],
        note: /** @type {any} */ (applied).note,
      };
    }
    default:
      throw new TypeError(`unknown request kind '${kind}'`);
  }
}

/** Serve one transport message. */
const serve = (message, respond, push) => {
  const { id, kind, args } = message;
  Promise.resolve()
    .then(() => handle(kind, args ?? {}, push))
    .then(
      (value) => respond({ id, ok: true, value }),
      (error) => respond({ id, ok: false, error: wireError(error) }));
};

globalThis.onmessage = (event) => {
  serve(event.data,
    (response) => globalThis.postMessage(response),
    (payload) => globalThis.postMessage({ push: payload }));
};

// client tabs reach the owner here; their live events broadcast back
channel.onmessage = (event) => {
  const message = event.data;
  if (message === null || typeof message !== 'object') return;
  // answer an owner-discovery ping (§11) only while actually owning
  if (message.ping !== undefined) {
    if (state.isOwner) channel.postMessage({ pong: message.ping });
    return;
  }
  if (message.clientReq === undefined || state.store === null) return;
  serve(message.clientReq,
    (response) => channel.postMessage({ clientRes: response }),
    (payload) => channel.postMessage({ clientPush: payload }));
};

globalThis.postMessage({ ready: true });
