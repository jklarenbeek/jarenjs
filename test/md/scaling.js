//@ts-check
/**
 * Growth-ratio timing for the parser's "linear in input" contract: how
 * much longer a run takes on a larger input than on a smaller one. Linear
 * work grows with the input; work that rescans the rest of the text from
 * every position grows with its square.
 *
 * A run is repeated until it has used at least `minMs` of wall clock, so a
 * sub-millisecond parse is measured rather than rounded. Within one
 * comparison the two sizes are timed alternately, three times each, and
 * the fastest of each kept — a loaded host only ever slows a run down, and
 * alternating keeps a drifting clock from favouring one size. The verdict
 * is the majority of up to three comparisons, so one disturbed comparison
 * can neither fail a linear parser nor pass a quadratic one.
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
 * One comparison: `time(large) / time(small)`, each the fastest of three
 * alternating measurements.
 * @param {(input: string) => unknown} run
 * @param {string} small
 * @param {string} large
 * @param {number} minMs
 * @returns {number}
 */
function compare(run, small, large, minMs) {
  let fastSmall = Infinity;
  let fastLarge = Infinity;
  for (let round = 0; round < 3; round++) {
    fastSmall = Math.min(fastSmall, perRun(() => run(small), minMs));
    fastLarge = Math.min(fastLarge, perRun(() => run(large), minMs));
  }
  return fastLarge / fastSmall;
}

/**
 * The verdict of up to three comparisons, as the median ratio: two that
 * agree on which side of `limit` they fall decide it.
 * @param {(input: string) => unknown} run
 * @param {string} small
 * @param {string} large
 * @param {{ limit?: number, minMs?: number }} [options]
 * @returns {number}
 */
export function growthRatio(run, small, large, { limit = 3, minMs = 20 } = {}) {
  run(small);
  run(large);
  /** @type {number[]} */
  const ratios = [];
  while (ratios.length < 3) {
    ratios.push(compare(run, small, large, minMs));
    const under = ratios.filter((ratio) => ratio < limit).length;
    if (under >= 2 || ratios.length - under >= 2) break;
  }
  // two ratios agree on their side of the limit; of three, the median decides
  ratios.sort((a, b) => a - b);
  return ratios[Math.floor((ratios.length - 1) / 2)];
}

/**
 * The depth of a vnode or AST value — arrays and objects each count one
 * level — measured with an explicit stack, so a tree too deep to recurse
 * over still has a depth.
 * @param {unknown} root
 * @returns {number}
 */
export function depthOf(root) {
  let max = 0;
  /** @type {[unknown, number][]} */
  const stack = [[root, 1]];
  while (stack.length > 0) {
    const [value, depth] = /** @type {[unknown, number]} */ (stack.pop());
    if (value === null || typeof value !== 'object') continue;
    if (depth > max) max = depth;
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      if (child !== null && typeof child === 'object') stack.push([child, depth + 1]);
    }
  }
  return max;
}
