//@ts-check
/** The browser storage ladder reports every observed fallback. */

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
    catch (error) { failures.push({ vfs, reason: String(error?.message ?? error) }); }
  }
  return { vfs: 'memory', durable: false, failures };
}
