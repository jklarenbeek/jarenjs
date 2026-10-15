//@ts-check
/**
 * Live set and remaining host resources of one combined journey, in a process
 * of its own. Copied beside the consumer modules, it runs the same public
 * journey with the same injected seams as the timed run and only observes
 * those seams: a forced collection at each phase boundary, the host's
 * resource list before the workload and after teardown, then whether the
 * event loop drains. Timings are never read from this process.
 */

/** The forced full collection this host offers, or a refusal: a raw heap
 * reading counts unreachable garbage, so it never stands in for a live set.
 * @param {any} [scope] the global object to read the collector from
 * @returns {() => void}
 */
export function forcedCollection(scope = globalThis) {
  if (typeof scope.Bun?.gc === 'function') return () => { scope.Bun.gc(true); scope.Bun.gc(true); };
  if (typeof scope.gc === 'function') return () => { scope.gc(); scope.gc(); };
  throw new Error('A live-set measurement needs a forced collection: run Node with --expose-gc');
}

/** Record the live set after a forced collection at each named boundary.
 * @param {() => void} collect @param {() => number} heapUsed */
export function createLiveSampler(collect, heapUsed) {
  /** @type {{ phase: string, bytes: number }[]} */
  const samples = [];
  return {
    samples,
    /** @param {string} phase */
    sample(phase) { collect(); samples.push({ phase, bytes: heapUsed() }); },
    peak() {
      if (samples.length === 0) throw new Error('no live-set sample was taken');
      return samples.reduce((best, row) => row.bytes > best.bytes ? row : best);
    },
  };
}

/** Resources present after teardown that the baseline did not hold, as a multiset.
 * @param {string[]} baseline @param {string[]} after */
export function remainingResources(baseline, after) {
  const remaining = [...after];
  for (const name of baseline) {
    const index = remaining.indexOf(name);
    if (index >= 0) remaining.splice(index, 1);
  }
  return remaining;
}

/** A loop that stays alive after teardown holds at least one resource even when
 * the host's list names none (Bun's list is always empty).
 * @param {string[]} remaining @param {boolean} drained */
export function remainingHandleCount(remaining, drained) {
  return drained ? remaining.length : Math.max(remaining.length, 1);
}

/** Sample after each awaited application call the journey makes.
 * @param {any} app @param {(phase: string) => void} sample */
export function observeApplication(app, sample) {
  /** @param {string} phase @param {(...args: any[]) => any} call */
  const after = (phase, call) => async (/** @type {any[]} */ ...args) => { const value = await call(...args); sample(phase); return value; };
  return { ...app,
    migrateSaved: after('migrateSaved', app.migrateSaved), query: after('query', app.query), saveRule: after('saveRule', app.saveRule),
    rows: after('rows', app.rows), preview: after('preview', app.preview), ingest: after('ingest', app.ingest),
    prepare: after('prepare', app.prepare), close: after('close', app.close),
    command: { ...app.command, execute: after('command.execute', app.command.execute) },
    runner: { ...app.runner, run: after('runner.run', app.runner.run) } };
}

/** Resolve after the loop drains (true) or as soon as anything keeps it alive (false).
 * Call it outside a pending top-level await: Bun counts an unsettled module
 * evaluation as keeping the loop alive. */
export function loopDrains() {
  return new Promise((resolve) => {
    const alive = setTimeout(() => resolve(false), 1);
    alive.unref();
    process.once('beforeExit', () => { clearTimeout(alive); resolve(true); });
  });
}

async function main() {
  const collect = forcedCollection();
  const [phase, id, path] = process.argv.slice(-3);
  const { readFileSync, appendFileSync } = await import('node:fs');
  const input = JSON.parse(readFileSync(new URL('./resources-input.json', import.meta.url), 'utf8'));
  const definition = input.consumers.find((/** @type {any} */ value) => value.id === id);
  if (!definition || phase !== 'all' || !path) throw new Error('Invalid resource journey arguments');
  const live = createLiveSampler(collect, () => process.memoryUsage().heapUsed);
  // The standard streams belong to the host: the report is written to one, and
  // loading node:assert opens the other. Open both before the baseline.
  const standardStreams = [process.stdout, process.stderr].map((stream) => stream.constructor.name);
  const baseline = process.getActiveResourcesInfo();
  const [{ nodeDriver }, { bunDriver }, { openAdoption }, { adoptionRule }, { seedAdoptionFile }, { adoptionRows }, { runAdoptionJourney }] = await Promise.all([
    import('@jarenjs/db/node'), import('@jarenjs/db/bun'), import('./adoption.js'), import('./adoption-model.js'),
    import('./adoption-fixture.js'), import('./adoption-rows.js'), import('./journey.js')]);
  live.sample('start');
  const rows = adoptionRows(definition);
  live.sample('rows');
  const result = await runAdoptionJourney({ adoptionRule, driver: process.versions.bun ? bunDriver() : nodeDriver(), path, definition, rows,
    originals: input.originals, phase,
    seedAdoptionFile: async (/** @type {any} */ options) => { await seedAdoptionFile(options); live.sample('seed'); },
    openAdoption: async (/** @type {any} */ options) => { const app = await openAdoption(options); live.sample('open'); return observeApplication(app, live.sample); },
    remote: (/** @type {any} */ request) => appendFileSync(path + '.remote', JSON.stringify({ url: request.url, body: request.body }) + '\n', { flush: true }) });
  live.sample('teardown');
  await new Promise((resolve) => setImmediate(resolve));
  const after = process.getActiveResourcesInfo(), remaining = remainingResources(baseline, after);
  const drained = await loopDrains();
  const peak = live.peak();
  console.log(JSON.stringify({ consumer: result.consumer, rows: result.rows, phase, searchHash: result.searchHash,
    runtime: process.versions.bun ?? process.version, peakLiveHeapBytes: peak.bytes, peakPhase: peak.phase, samples: live.samples,
    resources: { standardStreams, baseline, afterTeardown: after, remaining, drained }, remainingHandles: remainingHandleCount(remaining, drained) }));
  if (!drained) process.exit(0);
}

if (import.meta.main) main().catch((error) => { console.error(error); process.exitCode = 1; });
