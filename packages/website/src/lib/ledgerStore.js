//@ts-check
/** A whole-slot ledger adapter. Reload under the shared Web Lock before writes. */
const copy = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

/**
 * JSON slots must report failed writes by throwing or returning false. A legacy
 * slot that swallows errors cannot promise durability; status says unverified.
 * Web Locks serialize tabs using the same slot name. Without them the adapter
 * explicitly exposes only the four-method, single-writer contract.
 * @param {{ read: () => any, write: (data: any) => any, key?: string, reliable?: boolean }} slot
 * @param {{ locks?: any, name?: string, singleWriter?: boolean }} [options]
 */
export function createSlotLedgerStorage(slot, options = {}) {
  const locks = options.locks === undefined ? globalThis.window?.navigator?.locks : options.locks;
  const name = options.name ?? slot.key ?? 'jaren-ai-ledger';
  let cache = {};
  let error = null;
  let durable = slot.reliable === true ? 'durable' : 'unverified';
  const load = () => {
    const raw = slot.read();
    if (raw !== null && raw !== undefined && (typeof raw !== 'object' || Array.isArray(raw)))
      throw new TypeError('invalid ledger slot: expected a record map');
    cache = copy(raw ?? {});
    return cache;
  };
  const publish = (next) => {
    try {
      if (slot.write(next) === false) throw new Error('ledger storage write failed');
      cache = copy(next);
      error = null;
      durable = slot.reliable === true ? 'durable' : 'unverified';
    }
    catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      durable = 'failed';
      throw cause;
    }
  };
  const atomic = typeof locks?.request === 'function';
  // WebKit's process-local storage snapshots can remain stale even across a
  // locked task boundary. Elect one owner there instead of claiming coherence.
  const userAgent = globalThis.navigator?.userAgent ?? '';
  const singleWriter = options.singleWriter ?? (/AppleWebKit/.test(userAgent) && !/Chrome|Chromium|Edg/.test(userAgent));
  let ownership;
  let releaseOwner;
  let ownerRequest;
  const own = () => {
    if (!atomic || !singleWriter) return Promise.resolve();
    ownership ??= new Promise((resolve, reject) => {
      const held = new Promise((release) => { releaseOwner = release; });
      ownerRequest = locks.request(`ledger-owner:${name}`, { ifAvailable: true }, (lock) => {
        if (!lock) {
          reject(new Error('single-writer ledger: another tab owns this storage; close that tab before writing here'));
          return;
        }
        resolve();
        return held;
      });
      ownerRequest.catch(reject);
    });
    ownership.catch(() => { ownership = undefined; });
    return ownership;
  };
  // Firefox publishes localStorage snapshots at task boundaries. Keep the
  // lock until that publication completes, and enter a fresh task before read.
  const taskBoundary = () => new Promise((resolve) => setTimeout(resolve, 0));
  const locked = (fn) => atomic ? locks.request(`ledger:${name}`, async () => {
    await taskBoundary();
    try { return fn(); }
    finally { await taskBoundary(); }
  }) : Promise.resolve().then(fn);
  const mutate = async (prefix, transform) => {
    await own();
    return locked(() => {
    const matches = (key) => typeof prefix === 'string' ? key.startsWith(prefix)
      : (prefix.keys ?? []).includes(key) || (prefix.prefixes ?? []).some((part) => key.startsWith(part));
    const current = load();
    const scoped = Object.fromEntries(Object.keys(current).sort()
      .filter((key) => matches(key)).map((key) => [key, copy(current[key])]));
    const outcome = transform(scoped);
    if (!outcome || typeof outcome.then === 'function') throw new TypeError('mutate callback must be synchronous');
    if (outcome.next !== undefined) {
      const next = copy(outcome.next);
      if (Object.keys(next).some((key) => !matches(key))) throw new TypeError('mutation escaped its namespace');
      for (const key of Object.keys(current)) if (matches(key)) delete current[key];
      publish({ ...current, ...next });
    }
    return outcome.result;
    });
  };
  return {
    ...(atomic ? { mutate } : {}),
    status: () => ({ concurrency: atomic && !singleWriter ? 'atomic' : 'single-writer', durability: durable, error }),
    close: async () => { releaseOwner?.(); await ownerRequest; ownership = undefined; },
    get: async (key) => { await own(); return copy(load()[key]); },
    set: (key, value) => mutate('', (current) => ({ next: { ...current, [key]: copy(value) } })),
    delete: (key) => mutate('', (current) => {
      delete current[key];
      return { next: current };
    }),
    keys: async (prefix = '') => { await own(); return Object.keys(load()).filter((key) => key.startsWith(prefix)).sort(); },
  };
}
