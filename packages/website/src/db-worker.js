//@ts-check
/**
 * @file The data studio's OWNER worker (LIVE-FORMAT §11): one context
 * holds the sole connection. Runtime probes select SharedArrayBuffer OPFS,
 * SAH-pool OPFS, atomic IndexedDB snapshots, or visibly non-durable memory.
 * Each durable path passes a disposable write/close/reopen probe.
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
import { wasmDriver, sqlite3Handle, indexedDbSnapshotHandle, openSnapshotStorage } from '@jarenjs/db/wasm';
import { selectBrowserStorage, discoverStorageOwner } from './lib/db-storage.js';
import { createJsltRegistry, mathPack, financePack, statsPack } from '@jarenjs/json/jslt';
import { compileContract } from '@jarenjs/contract';
import { servePort } from '@jarenjs/contract/port';

import contractDoc from './contracts/data.contract.json' with { type: 'json' };
import { createDataHandlers } from './db-handlers.js';

const CHANNEL = 'jaren-data-studio';
const POOL = 'jaren-data';
const DB_NAME = '/jaren-data-studio.db';
const SNAPSHOTS = 'jaren-data-studio-snapshots';

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
  locked: false,
  releaseOwner: null,
  handle: null,
  unlink: null,
};

const channel = new BroadcastChannel(CHANNEL);

/** Announce the boot stage this worker is entering (`lib/boot-stages.js`):
 * the page bounds each stage from its side and names it on a timeout, so
 * an install some engines never settle fails as `vfs-acquire` — never as
 * an OPFS absence, which is a different answer with a different remedy. */
const enter = (stage) => globalThis.postMessage({ boot: stage });

/** Ask the channel whether an OPFS owner already exists — the fallback
 * for a host with no `LockManager`. A running owner answers its pong;
 * silence means only that no owner answered in this window. Without Web
 * Locks the storage-acquisition refusal and a longer retry decide the
 * next step; a busy owner cannot answer while SQLite runs synchronously. */
function pingForOwner(ms = 600) {
  return new Promise((resolve) => {
    const token = `ping-${crypto.randomUUID()}`;
    const onPong = (event) => {
      if (event.data?.pong === token) {
        clearTimeout(timer);
        channel.removeEventListener('message', onPong);
        resolve({ vfs: event.data.vfs });
      }
    };
    channel.addEventListener('message', onPong);
    channel.postMessage({ ping: token });
    const timer = setTimeout(() => {
      channel.removeEventListener('message', onPong);
      resolve(false);
    }, ms);
  });
}

/** The host's lock manager, where it has one. */
const locks = () => /** @type {any} */ (globalThis).navigator?.locks;

/** Acquire the browser-owned lock before selecting any durable storage. */
function holdOwnerLock() {
  const manager = locks();
  if (manager === undefined) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    manager.request(OWNER_LOCK, { ifAvailable: true }, (lock) => {
      if (lock === null) { resolve(false); return; }
      context.locked = true;
      resolve(true);
      return new Promise((release) => { context.releaseOwner = release; });
    }).catch(reject);
  });
}

/** A disposable write/close/reopen proves the selected VFS, not its name. */
async function probeVfs(DbClass, vfs, unlink) {
  const path = `${DB_NAME}.probe`;
  let db;
  try {
    db = new DbClass(path, 'c');
    if (!context.sqlite3.capi.sqlite3_js_db_uses_vfs(db.pointer, vfs))
      throw new Error(`the opened database did not use ${vfs}`);
    db.exec('CREATE TABLE IF NOT EXISTS probe(n); DELETE FROM probe; INSERT INTO probe VALUES(73)');
    db.close();
    db = new DbClass(path, 'r');
    if (db.selectValue('SELECT n FROM probe') !== 73) throw new Error('VFS reopen did not preserve the probe');
  }
  finally { db?.close(); await unlink(path); }
}

async function init() {
  enter('sqlite-init');
  context.sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: () => {} });
  enter('vfs-acquire');
  if (!(await holdOwnerLock())) {
    enter('topology');
    const owner = await pingForOwner();
    return { topology: 'client', vfs: owner?.vfs ?? 'owner-selected',
      version: context.sqlite3.version.libVersion,
      refusal: { code: 'JD2061', message: 'another context owns the database; this tab uses its connection over a BroadcastChannel' } };
  }
  const sqlite3 = context.sqlite3;
  const selected = await selectBrowserStorage({
    isolated: globalThis.crossOriginIsolated === true,
    sharedArrayBuffer: typeof SharedArrayBuffer === 'function',
    sab: async () => {
      if (!sqlite3.capi.sqlite3_vfs_find('opfs') || typeof sqlite3.oo1.OpfsDb !== 'function')
        throw new Error('the SharedArrayBuffer OPFS VFS is not registered');
      const root = await globalThis.navigator.storage.getDirectory();
      // The pinned build removes its private sqlite3.opfs helper after
      // initialization. Delete closed files through the public storage API.
      const unlink = async (path) => {
        for (const suffix of ['', '-journal', '-wal', '-shm']) {
          try { await root.removeEntry(path.replace(/^\//, '') + suffix); }
          catch (error) { if (error.name !== 'NotFoundError') throw error; }
        }
      };
      await probeVfs(sqlite3.oo1.OpfsDb, 'opfs', unlink);
      return { handle: sqlite3Handle(sqlite3, { DbClass: sqlite3.oo1.OpfsDb }), unlink };
    },
    sah: async () => {
      context.poolUtil = await sqlite3.installOpfsSAHPoolVfs({ name: POOL });
      const unlink = (path) => context.poolUtil.unlink(path);
      await probeVfs(context.poolUtil.OpfsSAHPoolDb, context.poolUtil.vfsName, unlink);
      return { handle: sqlite3Handle(sqlite3, { DbClass: context.poolUtil.OpfsSAHPoolDb }), unlink };
    },
    indexedDB: async () => {
      if (!context.locked) throw new Error('IndexedDB snapshots require an observed exclusive Web Lock');
      const handle = indexedDbSnapshotHandle(sqlite3, { name: SNAPSHOTS });
      const driver = wasmDriver(handle);
      const path = `${DB_NAME}.probe`;
      let db;
      const unlink = async (key) => {
        const storage = await openSnapshotStorage(globalThis.indexedDB, SNAPSHOTS);
        try { await storage.remove(key); } finally { storage.close(); }
      };
      try {
        db = await driver.open(path);
        await db.exec('CREATE TABLE IF NOT EXISTS probe(n); DELETE FROM probe; INSERT INTO probe VALUES(73)');
        await db.close();
        db = await driver.open(path);
        if ((await (await db.prepare('SELECT n FROM probe')).get()).n !== 73)
          throw new Error('IndexedDB reopen did not preserve the probe');
      }
      finally { await db?.close(); await unlink(path); }
      return { handle, unlink };
    },
  });
  enter('topology');
  if (selected.held || (!selected.durable && !context.locked)) {
    const owner = await discoverStorageOwner(selected, pingForOwner);
    if (owner) {
      context.releaseOwner?.();
      context.locked = false;
      return { topology: 'client', vfs: owner.vfs, version: sqlite3.version.libVersion,
        refusal: { code: 'JD2061', message: 'another context answered as the database owner; this tab uses its connection over a BroadcastChannel' } };
    }
  }
  context.vfs = selected.vfs;
  context.handle = selected.handle ?? sqlite3Handle(sqlite3);
  context.unlink = selected.unlink ?? (() => {});
  context.isOwner = selected.durable;
  if (context.isOwner) serveChannel();
  else { context.releaseOwner?.(); context.locked = false; }
  const fallback = selected.failures.map((entry) => `${entry.vfs}: ${entry.reason}`).join('; ');
  return { topology: selected.durable ? 'owner' : 'memory', vfs: selected.vfs,
    durable: selected.durable, failures: selected.failures, version: sqlite3.version.libVersion,
    ...(fallback ? { refusal: { code: 'JD2061', message: `${fallback}. Selected ${selected.vfs}`
      + (selected.durable ? ' (persistent).' : ' (non-durable; data lasts until reload).') } } : {}) };
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
  makeDriver: () => wasmDriver(context.handle),
  // the oracle's throwaway store is always a plain in-memory database,
  // whichever VFS this context settled on: the pool's class is for the
  // one database it holds, and the corpus needs execution, not persistence
  makeScratchDriver: () => wasmDriver(sqlite3Handle(context.sqlite3)),
  path: () => (context.vfs === 'memory' ? ':memory:' : DB_NAME),
  vfs: () => context.vfs,
  durable: () => context.vfs !== 'memory',
  unlink: () => context.unlink(DB_NAME),
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
    channel.postMessage({ pong: message.ping, vfs: context.vfs });
  }
};

globalThis.postMessage({ ready: true });
