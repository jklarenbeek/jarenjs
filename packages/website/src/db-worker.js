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
 * The request/response path is the @jarenjs/contract PORT binding over
 * the studio's own contract document (`contracts/data.contract.json`):
 * one handler table serves TWO `servePort`s — the worker's own channel
 * (`self`) for the owning tab, and the `BroadcastChannel` for CLIENT
 * tabs, registered only once this context actually OWNS the pool so a
 * standalone in-memory tab can never answer another tab's requests.
 * Request ids are client-scoped by the binding, so two client tabs on
 * the shared channel can never cross-settle. A store rejection crosses
 * as the declared `db` failure carrying the store's own code and
 * message; the owner-discovery ping/pong keeps its token protocol
 * beside the contract frames (they are distinguishable by shape), and
 * live emissions ride the `push`/`clientPush` messages beside them
 * until the stream binding carries subscriptions.
 */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { openStore, migrate, planModelMigration } from '@jarenjs/db';
import { wasmDriver, sqlite3Handle } from '@jarenjs/db/wasm';
import { createJsltRegistry, mathPack, financePack, statsPack } from '@jarenjs/json/jslt';
import { compileContract, ContractFailure } from '@jarenjs/contract';
import { servePort } from '@jarenjs/contract/port';

import contractDoc from './contracts/data.contract.json' with { type: 'json' };

const CHANNEL = 'jaren-data-studio';
const POOL = 'jaren-data';
const DB_NAME = '/jaren-data-studio.db';

const contract = compileContract(contractDoc);

// The data studio mounts the operator packs (MODEL-FORMAT §8.1–8.2), so
// registered operators run over the store: finance/stats ($npv, $mean, …)
// in the query residual, and the math ops ($sqrt, $pow, …) pushed to
// SQLite as deterministic UDFs — the wasm build declares user functions.
// `explain()` shows which path each query took; `capabilities.operators`
// and `pushableOperators` report the vocabulary.
const OPERATORS = createJsltRegistry().use(mathPack).use(financePack).use(statsPack);

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

/** The details of the declared `db` failure — the store's own code and
 * message, `code: null` for an uncoded fault (details are JSON; no
 * member is ever `undefined`). */
const wireError = (error) => ({
  code: /** @type {any} */ (error)?.code ?? null,
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
    // only an actual owner serves the shared channel: a standalone
    // in-memory tab joining it too could answer a client whose owner is
    // another tab's store — the wrong data with a valid frame
    serveChannel();
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
    { driver: wasmDriver(handle), path, capture: true, operators: OPERATORS });
  return {
    vfs: state.vfs,
    capabilities: {
      version: state.store.capabilities.version,
      capture: state.store.capabilities.capture,
      live: state.store.capabilities.live,
      userFunctions: state.store.capabilities.userFunctions,
      operators: state.store.capabilities.operators,
      pushableOperators: state.store.capabilities.pushableOperators,
    },
  };
}

async function migrateTo(args) {
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
    state.store = await openStore(args.to, { driver, path, capture: true, operators: OPERATORS });
    state.lives.clear();
  }
  const note = /** @type {any} */ (applied).note;
  return {
    planned: rendered,
    losses: report?.losses ?? [],
    applied: applied.applied?.map((entry) => entry.id) ?? [],
    ...(note !== undefined ? { note } : {}),
  };
}

/**
 * The handler table of one transport: every store rejection crosses as
 * the declared `db` failure with the store's code and message (what the
 * old wire sent, now typed by the contract), so a genuine host bug is
 * the only thing that answers the binding's JC2070. `push` is the
 * transport's live-emission door — the one thing that differs between
 * the two servers, so each transport's live registrations emit on the
 * channel that made them (a client's on the broadcast channel, the
 * owner's on its own worker channel).
 * @param {(payload: any) => void} push
 */
function makeHandlers(push) {
  /** @param {(input: any) => any} fn */
  const guard = (fn) => async (/** @type {any} */ input) => {
    try {
      return await fn(input);
    }
    catch (error) {
      return ContractFailure('db', {}, wireError(error));
    }
  };
  return {
    'data.init': guard(() => init()),
    'data.open': guard((input) => open(input)),
    'data.insert': guard((input) => state.store.collection(input.collection).insert(input.doc)),
    'data.put': guard((input) => state.store.collection(input.collection).put(input.doc, input.key)),
    'data.delete': guard((input) => state.store.collection(input.collection).delete(input.key)),
    'data.rows': guard((input) => state.store.collection(input.collection)
      .execute([{ $for: { it: '$[*]' }, $return: '$it' }])),
    'data.execute': guard((input) => state.store.collection(input.collection)
      .execute(input.document, { externals: input.externals ?? {} })),
    'data.explain': guard((input) => state.store.collection(input.collection)
      .explain(input.document, { externals: input.externals ?? {} })),
    'data.live': guard(async (input) => {
      const live = await state.store.collection(input.collection).live(input.document);
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
    }),
    'data.live.close': guard((input) => {
      const entry = state.lives.get(input.liveId);
      if (entry !== undefined) {
        entry.stop();
        entry.live.close();
        state.lives.delete(input.liveId);
      }
      return true;
    }),
    'data.migrate': guard((input) => migrateTo(input)),
  };
}

// the owning tab's own requests arrive on the worker channel
servePort(contract, makeHandlers((payload) => globalThis.postMessage({ push: payload })),
  { channel: /** @type {any} */ (globalThis) });

let channelServed = false;
/** Client tabs reach the owner here — registered exactly once, on
 * becoming the owner; their live events broadcast back. */
function serveChannel() {
  if (channelServed) return;
  channelServed = true;
  servePort(contract, makeHandlers((payload) => channel.postMessage({ clientPush: payload })),
    { channel });
}

// answer an owner-discovery ping (§11) only while actually owning; the
// contract frames on this channel belong to servePort's own listener
channel.onmessage = (event) => {
  const message = event.data;
  if (message === null || typeof message !== 'object') return;
  if (message.ping !== undefined && state.isOwner) {
    channel.postMessage({ pong: message.ping });
  }
};

globalThis.postMessage({ ready: true });
