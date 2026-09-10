/** A controllable timer queue: time moves only when the test advances it. */
export const tick = () => new Promise((resolve) => setImmediate(resolve));

export function fakeClock() {
  let now = 0;
  const timers = new Set();
  return {
    now: () => now,
    random: () => 0,
    sleep(ms, signal) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(signal.reason); return; }
        const timer = { at: now + ms, resolve: () => { cleanup(); resolve(); } };
        const abort = () => { cleanup(); reject(signal.reason); };
        const cleanup = () => { timers.delete(timer); signal?.removeEventListener('abort', abort); };
        timers.add(timer);
        signal?.addEventListener('abort', abort, { once: true });
      });
    },
    async advance(ms) {
      now += ms;
      for (;;) {
        const due = [...timers].filter((timer) => timer.at <= now);
        if (!due.length) break;
        for (const timer of due) timer.resolve();
        await tick();
      }
      await tick();
    },
    pending: () => timers.size,
  };
}
