//@ts-check
/** Own physical client closure before an operator fixture removes its database. */

/** Register before the pool's first query. pg.Pool.end() can resolve while
 * removed clients are still closing; each client's end event settles that work.
 * @param {any} pool @param {number} [timeoutMs]
 * @returns {() => Promise<void>} */
export function ownPostgresPool(pool, timeoutMs = 5000) {
  const pending = new Set();
  const connected = client => {
    const ended = new Promise(resolve => client.once('end', () => {
      pending.delete(ended);
      resolve(undefined);
    }));
    pending.add(ended);
  };
  pool.on('connect', connected);
  let closing;
  return () => closing ??= (async () => {
    let timer;
    try {
      await Promise.race([
        (async () => { await pool.end(); await Promise.all(pending); })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('PostgreSQL pool clients did not close within the fixture deadline')), timeoutMs);
        }),
      ]);
    }
    finally { clearTimeout(timer); pool.off('connect', connected); }
  })();
}
