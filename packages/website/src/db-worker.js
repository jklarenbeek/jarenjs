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
 * This file is the HOST, not the behaviour: the handler table lives in
 * `db-handlers.js` over an injected host, so the store rules — the live
 * registry, what a refused migration does to the model, who may recreate
 * the database — are held by a Node test instead of by a browser nobody
 * runs headless. What is genuinely browser-shaped stays here: the wasm
 * build, the OPFS pool, owner discovery, and the two transports.
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
 * message; the owner-discovery protocol keeps its own frames beside the
 * contract ones (they are distinguishable by shape).
 *
 * Live queries are `data.live`, a SUBSCRIBE operation: the handler
 * answers the store's `live()` as the stream binding's duck-typed
 * subscription, and the binding carries the snapshot and every
 * `{ patch, seq }` emission as push frames on whichever channel the
 * subscription arrived on. Any reopen ends those subscriptions, so the
 * store-changed notice below is what tells every tab to take them out
 * again — a live pane that silently stopped updating still looks live.
 */

import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { wasmDriver, sqlite3Handle } from '@jarenjs/db/wasm';
import { createJsltRegistry, mathPack, financePack, statsPack } from '@jarenjs/json/jslt';
import { compileContract } from '@jarenjs/contract';
import { servePort } from '@jarenjs/contract/port';

import contractDoc from './contracts/data.contract.json' with { type: 'json' };
import { createDataHandlers, wireError } from './db-handlers.js';

const CHANNEL = 'jaren-data-studio';
const POOL = 'jaren-data';
const DB_NAME = '/jaren-data-studio.db';

/** The lock an owner holds for its whole life. A lock is granted by the
 * BROWSER, not by the page, so it answers "is there an owner?" even while
 * that owner's event loop is busy — which a ping cannot. */
const OWNER_LOCK = 'jaren-data-studio-owner';

const contract = compileContract(contractDoc);

// The data studio mounts the operator packs (MODEL-FORMAT §8.1–8.2), so
// registered operators run over the store: finance/stats ($npv, $mean, …)
// in the query residual, and the math ops ($sqrt, $pow, …) pushed to
// SQLite as deterministic UDFs — the wasm build declares user functions.
// `explain()` shows which path each query took; `capabilities.operators`
// and `pushableOperators` report the vocabulary.
const OPERATORS = createJsltRegistry().use(mathPack).use(financePack).use(statsPack);

const context = {
  /** @type {any} */ sqlite3: null,
  /** @type {any} */ poolUtil: null,
  vfs: 'memory',
  isOwner: false,
};

const channel = new BroadcastChannel(CHANNEL);

/** Race a promise against a timeout so a hung OPFS install (some
 * engines never settle `installOpfsSAHPoolVfs`) cannot wedge boot. */
const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((_resolve, reject) =>
    setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
]);

/** Ask the channel whether an OPFS owner already exists — the fallback
 * for a host with no `LockManager`. A running owner answers its pong;
 * silence within the window means no owner, which is a guess: an owner
 * whose event loop is blocked cannot answer either. */
function pingForOwner(ms = 600) {
  return new Promise((resolve) => {
    const token = `ping-${context.sqlite3.version.libVersion}-${Math.floor(ms)}`;
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

/** The host's lock manager, where it has one. */
const locks = () => /** @type {any} */ (globalThis).navigator?.locks;

/**
 * Whether another context already owns the database.
 *
 * A blocked owner used to read as no owner at all: `pingForOwner` treats
 * silence as absence, and an owner running a large migration or a long
 * query cannot answer inside the window. The second tab then concluded it
 * could take ownership, failed to install a pool that was already held,
 * and ran a private in-memory store — a studio that looks live and shares
 * nothing. A Web Lock is held by the browser rather than answered by the
 * page, so a busy owner still holds it, and `ifAvailable` reports that
 * without waiting for anyone.
 * @returns {Promise<boolean>}
 */
async function ownerExists() {
  const manager = locks();
  if (manager === undefined) return pingForOwner();
  let held = false;
  await manager.request(OWNER_LOCK, { ifAvailable: true },
    (/** @type {any} */ lock) => { held = lock === null; });
  return held;
}

/** Take the owner lock and never give it back: this context is the owner
 * for as long as it lives, and releasing it would invite a second one. */
function holdOwnerLock() {
  const manager = locks();
  if (manager === undefined) return;
  manager.request(OWNER_LOCK, { mode: 'exclusive' },
    () => new Promise(() => {})).catch(() => {});
}

async function init() {
  context.sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
  try {
    context.poolUtil = await withTimeout(
      context.sqlite3.installOpfsSAHPoolVfs({ name: POOL }), 8_000, 'OPFS pool install');
    context.vfs = 'opfs-sahpool';
    context.isOwner = true;
    holdOwnerLock();
    // only an actual owner serves the shared channel: a standalone
    // in-memory tab joining it too could answer a client whose owner is
    // another tab's store — the wrong data with a valid frame
    serveChannel();
    return { topology: 'owner', vfs: context.vfs, version: context.sqlite3.version.libVersion };
  }
  catch (error) {
    // OPFS could not be claimed: either another tab HOLDS it (an owner
    // exists — become a client) or it is ABSENT here (no owner — run a
    // standalone in-memory store). Owner discovery tells them apart, so
    // neither case hangs.
    context.poolUtil = null;
    context.vfs = 'memory';
    if (await ownerExists()) {
      return {
        topology: 'client', vfs: 'opfs-sahpool',
        version: context.sqlite3.version.libVersion,
        refusal: {
          code: 'JD2061',
          message: `another context owns the database (${wireError(error).message}) `
            + '— this tab is a client of the owner over a BroadcastChannel',
        },
      };
    }
    return {
      topology: 'memory', vfs: 'memory',
      version: context.sqlite3.version.libVersion,
      refusal: {
        code: 'JD2061',
        message: 'OPFS is unavailable in this context — running a standalone '
          + 'in-memory store (no cross-tab owner)',
      },
    };
  }
}

/** Every reopen drops the live registrations of every tab, so every tab
 * is told. The notice travels beside the contract frames on both
 * transports and is distinguishable by shape, exactly as the
 * owner-discovery frames are. */
function announce(notice) {
  const message = { ...notice, channel: CHANNEL };
  channel.postMessage(message);
  globalThis.postMessage(message);
}

const { handlers, clientHandlers } = createDataHandlers({
  init,
  makeDriver: () => wasmDriver(context.vfs === 'opfs-sahpool'
    ? sqlite3Handle(context.sqlite3, { DbClass: context.poolUtil.OpfsSAHPoolDb })
    : sqlite3Handle(context.sqlite3)),
  path: () => (context.vfs === 'opfs-sahpool' ? DB_NAME : ':memory:'),
  vfs: () => context.vfs,
  durable: () => context.vfs === 'opfs-sahpool',
  unlink: () => {
    if (context.poolUtil !== null) context.poolUtil.unlink(DB_NAME);
  },
  announce,
  operators: OPERATORS,
});

// the owning tab's own requests arrive on the worker channel
servePort(contract, handlers, { channel: /** @type {any} */ (globalThis) });

let channelServed = false;
/** Client tabs reach the owner here — registered exactly once, on
 * becoming the owner; their subscriptions push back on this channel. */
function serveChannel() {
  if (channelServed) return;
  channelServed = true;
  servePort(contract, clientHandlers, { channel });
}

// answer an owner-discovery ping (§11) only while actually owning; the
// contract frames on this channel belong to servePort's own listener
channel.onmessage = (event) => {
  const message = event.data;
  if (message === null || typeof message !== 'object') return;
  if (message.ping !== undefined && context.isOwner) {
    channel.postMessage({ pong: message.ping });
  }
};

globalThis.postMessage({ ready: true });
