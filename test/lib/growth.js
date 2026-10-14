//@ts-check
/**
 * Growth-ratio timing for the "linear in input" and "logarithmic in input"
 * contracts: how much longer a run takes on a larger input than on a
 * smaller one. Linear work grows with the input; work that rescans the rest
 * of the text from every position grows with its square. A test names the
 * two ratios it must tell apart (for an eightfold step: about 8 and about
 * 64) and puts its limit near their geometric mean, about 23, where
 * instrumented coverage and a loaded host cannot reach it from the honest
 * side and the defect cannot fall under it.
 *
 * A run is repeated until it has used at least `minMs` of wall clock, so a
 * sub-millisecond run is measured rather than rounded. Within one
 * comparison the two sizes are timed alternately, three times each, and
 * the fastest of each kept: a loaded host only ever slows a run down, and
 * alternating keeps a drifting clock from favouring one size. The verdict
 * is the median of up to three comparisons, so one disturbed comparison
 * can neither fail a linear run nor pass a quadratic one.
 *
 * `run` must do the work every call: a call whose result is remembered
 * (a cached layout, a compiled form) times the lookup and not the work. A
 * run that needs fresh state builds it inside `run`, or takes it from the
 * input it is handed.
 */

/**
 * Milliseconds per call of `run`, averaged over at least `minMs`.
 * @param {() => unknown} run
 * @param {number} minMs
 * @returns {number}
 */
function perRun(run, minMs) {
  let iterations = 0;
  const start = performance.now();
  let elapsed = 0;
  do {
    run();
    iterations++;
    elapsed = performance.now() - start;
  } while (elapsed < minMs);
  return elapsed / iterations;
}

/**
 * Milliseconds per call of an asynchronous `run`, averaged over at least `minMs`.
 * @param {() => unknown} run
 * @param {number} minMs
 * @returns {Promise<number>}
 */
async function perRunAsync(run, minMs) {
  let iterations = 0;
  const start = performance.now();
  let elapsed = 0;
  do {
    await run();
    iterations++;
    elapsed = performance.now() - start;
  } while (elapsed < minMs);
  return elapsed / iterations;
}

/**
 * The comparisons of one growth measurement, as a generator that yields
 * every timing it needs and is handed the milliseconds back, so the
 * synchronous and the asynchronous measurement share one procedure.
 * @param {number} limit
 * @returns {Generator<'small' | 'large', number, number>}
 */
function* verdict(limit) {
  /** @type {number[]} */
  const ratios = [];
  while (ratios.length < 3) {
    let fastSmall = Infinity;
    let fastLarge = Infinity;
    for (let round = 0; round < 3; round++) {
      fastSmall = Math.min(fastSmall, yield 'small');
      fastLarge = Math.min(fastLarge, yield 'large');
    }
    ratios.push(fastLarge / fastSmall);
    const under = ratios.filter((ratio) => ratio < limit).length;
    if (under >= 2 || ratios.length - under >= 2) break;
  }
  // two ratios agree on their side of the limit; of three, the median decides
  ratios.sort((a, b) => a - b);
  return ratios[Math.floor((ratios.length - 1) / 2)];
}

/**
 * The growth of `run` from `small` to `large`, as the median ratio of up to
 * three comparisons: two that agree on which side of `limit` they fall
 * decide it.
 * @template T
 * @param {(input: T) => unknown} run
 * @param {T} small
 * @param {T} large
 * @param {{ limit?: number, minMs?: number }} [options]
 * @returns {number} the time on `large` divided by the time on `small`
 */
export function growthRatio(run, small, large, { limit = 3, minMs = 20 } = {}) {
  run(small);
  run(large);
  const plan = verdict(limit);
  let step = plan.next(0);
  while (!step.done) step = plan.next(perRun(() => run(step.value === 'small' ? small : large), minMs));
  return step.value;
}

/**
 * {@link growthRatio} for a `run` that returns a promise.
 * @template T
 * @param {(input: T) => unknown} run
 * @param {T} small
 * @param {T} large
 * @param {{ limit?: number, minMs?: number }} [options]
 * @returns {Promise<number>} the time on `large` divided by the time on `small`
 */
export async function growthRatioAsync(run, small, large, { limit = 3, minMs = 20 } = {}) {
  await run(small);
  await run(large);
  const plan = verdict(limit);
  let step = plan.next(0);
  while (!step.done) step = plan.next(await perRunAsync(() => run(step.value === 'small' ? small : large), minMs));
  return step.value;
}
