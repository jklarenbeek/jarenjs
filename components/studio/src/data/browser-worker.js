//@ts-check
/** Shared owner/client worker protocol. Hosts supply the concrete initializer and storage identity. */
import { wasmDriver, sqlite3Handle, indexedDbSnapshotHandle, openSnapshotStorage } from '@jarenjs/db/wasm';
import { servePort } from '@jarenjs/contract/port';
import { selectBrowserStorage, discoverStorageOwner } from './storage.js';
import { createDataHandlers } from './handlers.js';
import { dataContract } from './contract.js';
/**
 * The SQLite module is injected, like the handle consumed by @jarenjs/db/wasm.
 * No package import or worker URL is chosen by this component.
 * @param {{ initialize: () => Promise<any>, scope: any, createChannel: (name: string) => any,
 *   identity: { channel: string, pool: string, database: string, snapshots: string, lock: string }, operators?: any }} env
 * @returns {{ dispose: () => Promise<void> }}
 */
export function createBrowserDataWorker(env) {
const { channel: CHANNEL, pool: POOL, database: DB_NAME, snapshots: SNAPSHOTS, lock: OWNER_LOCK } = env.identity;
if ([CHANNEL, POOL, DB_NAME, SNAPSHOTS, OWNER_LOCK].some(value => typeof value !== 'string' || value.length === 0))
  throw new TypeError('Data storage requires explicit channel, pool, database, snapshots and lock identities.');
const OPERATORS = env.operators;
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

const channel = env.createChannel(CHANNEL);
let disposed = false, peerServer = null, initial = null;
const pings = new Set();
const current = () => { if (disposed) throw new Error('The Data worker is disposed.'); };

/** Announce the boot stage this worker is entering (`lib/boot-stages.js`):
 * the page bounds each stage from its side and names it on a timeout, so
 * an install some engines never settle fails as `vfs-acquire` — never as
 * an OPFS absence, which is a different answer with a different remedy. */
const enter = stage => { current(); env.scope.postMessage({ boot: stage }); };

/** Ask the channel whether an OPFS owner already exists — the fallback
 * for a host with no `LockManager`. A running owner answers its pong;
 * silence means only that no owner answered in this window. Without Web
 * Locks the storage-acquisition refusal and a longer retry decide the
 * next step; a busy owner cannot answer while SQLite runs synchronously. */
function pingForOwner(ms = 600) {
  return new Promise((resolve) => {
    const token = `ping-${env.scope.crypto.randomUUID()}`;
    const onPong = (event) => {
      if (event.data?.pong === token) {
        finish({ vfs: event.data.vfs });
      }
    };
    let timer;
    const finish = value => { clearTimeout(timer); channel.removeEventListener('message', onPong); pings.delete(stop); resolve(value); };
    const stop = () => finish(false); pings.add(stop);
    channel.addEventListener('message', onPong);
    timer = setTimeout(stop, ms);
    channel.postMessage({ ping: token });
  });
}

/** The host's lock manager, where it has one. */
const locks = () => env.scope.navigator?.locks;

/** Acquire the browser-owned lock before selecting any durable storage. */
function holdOwnerLock() {
  const manager = locks();
  if (manager === undefined) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    manager.request(OWNER_LOCK, { ifAvailable: true }, (lock) => {
      if (lock === null) { resolve(false); return; }
      if (disposed) { resolve(false); return; }
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

async function initialize() {
  current();
  enter('sqlite-init');
  context.sqlite3 = await env.initialize();
  current();
  enter('vfs-acquire');
  if (!(await holdOwnerLock())) {
    enter('topology');
    const owner = await pingForOwner();
    return { topology: 'client', vfs: owner?.vfs ?? 'owner-selected',
      version: context.sqlite3.version.libVersion,
      refusal: { code: 'JD2061', message: 'another context owns the database; this tab uses its connection over a BroadcastChannel' } };
  }
  current();
  const sqlite3 = context.sqlite3;
  const selected = await selectBrowserStorage({
    isolated: env.scope.crossOriginIsolated === true,
    sharedArrayBuffer: typeof env.scope.SharedArrayBuffer === 'function',
    sab: async () => {
      if (!sqlite3.capi.sqlite3_vfs_find('opfs') || typeof sqlite3.oo1.OpfsDb !== 'function')
        throw new Error('the SharedArrayBuffer OPFS VFS is not registered');
      const root = await env.scope.navigator.storage.getDirectory();
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
      if (disposed) context.poolUtil.pauseVfs?.();
      current();
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
        const storage = await openSnapshotStorage(env.scope.indexedDB, SNAPSHOTS);
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
  current();
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
  env.scope.postMessage(message);
}

const table = createDataHandlers({
  init: () => initial ??= initialize(),
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
const directServer = servePort(dataContract, table.handlers, { channel: env.scope });

let channelServed = false;
/** Client tabs reach the owner here — registered exactly once, on
 * becoming the owner; their subscriptions push back on this channel. */
function serveChannel() {
  if (channelServed) return;
  channelServed = true;
  peerServer = servePort(dataContract, table.clientHandlers, { channel });
}

// answer an owner-discovery ping (§11) only while actually owning; the
// contract frames on this channel belong to servePort's own listener
const onMessage = (event) => {
  const message = event.data;
  if (message === null || typeof message !== 'object') return;
  if (message.ping !== undefined && context.isOwner) {
    channel.postMessage({ pong: message.ping, vfs: context.vfs });
  }
};

channel.addEventListener('message', onMessage);
env.scope.postMessage({ ready: true });
let disposal = null;
return { dispose() {
  if (disposal) return disposal;
  disposed = true; context.isOwner = false;
  for (const stop of [...pings]) stop();
  directServer.close(); peerServer?.close(); channel.removeEventListener('message', onMessage); channel.close();
  disposal = table.dispose().finally(() => {
    try { context.poolUtil?.pauseVfs?.(); }
    finally { context.releaseOwner?.(); context.locked = false; }
  });
  return disposal;
} };

}
