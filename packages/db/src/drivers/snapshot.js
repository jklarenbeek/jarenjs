//@ts-check
/** Disk-backed SQLite snapshots shared by the Node and Bun bindings. */
import { DbCompileError } from '../errors.js';

/** Reserve a new destination and fill it through SQLite, never a JS image.
 * @param {string} target @param {() => any} write
 * @param {{progress?:Function}} [options] @returns {Promise<number>} */
export async function writeSqliteSnapshot(target, write, options) {
  if (typeof target !== 'string' || !target || target.includes('\0')) throw new TypeError('snapshot target must be a nonempty path');
  const fs = await import('node:fs/promises');
  const file = await fs.open(target, 'wx');
  let complete = false;
  try {
    await write();
    await file.sync();
    const header = new Uint8Array(100);
    const reader = await fs.open(target, 'r');
    try { await reader.read(header, 0, header.length, 0); }
    finally { await reader.close(); }
    const encoded = (header[16] << 8) | header[17];
    const pageSize = encoded === 1 ? 65536 : encoded;
    const size = (await file.stat()).size;
    const pages = size / pageSize;
    options?.progress?.({ totalPages: pages, remainingPages: 0 });
    complete = true;
    return pages;
  }
  finally {
    await file.close();
    if (!complete) await fs.rm(target, { force: true });
  }
}

/** Create a consistent, bounded-memory snapshot on a new path, including
 * committed WAL data. Does not open a model store or replace a target.
 * SQLite's page caches bound working memory; no serialize/hex image is built.
 * @param {any} connection @param {string} target
 * @returns {Promise<{path:string,pages:number}>} */
export async function snapshotDatabase(connection, target) {
  if (connection.dialect.name !== 'sqlite' || !connection.synchronous)
    throw new DbCompileError('JD0038', 'snapshotDatabase requires a synchronous SQLite connection');
  const write = () => connection.prepare('VACUUM INTO ?').run([target]);
  // Acquire ownership before asynchronous filesystem work. Acquiring it
  // afterwards would queue behind an outer transaction awaiting this call.
  const snapshot = () => writeSqliteSnapshot(target, write);
  const pages = await (typeof connection.exclusively === 'function'
    ? connection.exclusively(snapshot, 'a database snapshot') : snapshot());
  return { path: target, pages };
}
