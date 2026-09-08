//@ts-check
/** The browser storage ladder reports every observed fallback. */

/** An OPFS acquisition refusal is different from an unavailable API.
 * Wrapped host errors retain that distinction through their cause.
 * @param {any} error @returns {boolean}
 */
function accessHandleHeld(error) {
  const seen = new Set();
  while (error !== null && typeof error === 'object' && !seen.has(error)) {
    if (error.name === 'NoModificationAllowedError') return true;
    seen.add(error);
    error = error.cause;
  }
  return false;
}

/** @param {{ isolated: boolean, sharedArrayBuffer: boolean,
 *   sab: () => Promise<any>, sah: () => Promise<any>, indexedDB: () => Promise<any> }} probes
 * @returns {Promise<any>}
 */
export async function selectBrowserStorage(probes) {
  const failures = [];
  for (const [vfs, probe] of [
    ['opfs-sab', probes.sab], ['opfs-sahpool', probes.sah], ['indexeddb-snapshot', probes.indexedDB],
  ]) {
    if (vfs === 'opfs-sab' && (!probes.isolated || !probes.sharedArrayBuffer)) {
      failures.push({ vfs, reason: !probes.isolated ? 'cross-origin isolation is unavailable' : 'SharedArrayBuffer is unavailable' });
      continue;
    }
    try {
      const adapter = await probe();
      return { ...adapter, vfs, durable: true, failures };
    }
    catch (error) {
      failures.push({ vfs, reason: String(error?.message ?? error) });
      if (vfs.startsWith('opfs-') && accessHandleHeld(error))
        return { vfs: 'owner-selected', durable: false, held: true, failures };
    }
  }
  return { vfs: 'memory', durable: false, failures };
}

/** Discover a peer after storage acquisition failed without a Web Lock.
 * Silence says only that no peer answered in time. When OPFS reported a
 * held handle, it cannot authorize a private memory fallback.
 * @param {{ held?: boolean }} selected
 * @param {(ms: number) => Promise<false | { vfs: string }>} ping
 * @returns {Promise<false | { vfs: string }>}
 */
export async function discoverStorageOwner(selected, ping) {
  const owner = await ping(600) || await ping(3000);
  if (owner) return owner;
  if (selected.held) {
    const error = new Error('OPFS refused an access handle because it is held by another context;'
      + ' no studio owner answered within either discovery window. Close the other context or retry when it is idle.');
    /** @type {any} */ (error).code = 'JD2061';
    throw error;
  }
  return false;
}
