//@ts-check
/**
 * @file The data studio's boot as a closed, finite protocol. A browser
 * store boots through five stages — the worker starting, the SQLite
 * wasm build initializing, the OPFS pool being acquired, the topology
 * being decided, the first store open — and every one of them finishes
 * as a success or as a STABLE, NAMED failure: `{ code: 'DATA_BOOT',
 * stage, message }`. An outer deadline can say only that something
 * stopped; a named stage says which resource must be released and what
 * a consumer can report. So each stage carries its own budget, a stage
 * that overruns it fails under its own name, and a stage that settles
 * late changes nothing.
 *
 * This module is the pure half: the stage names, the budgets, the error
 * shape and the runner that attaches a timer to a stage and clears it
 * on either outcome. The page's transport and the worker announce their
 * stages through it; the browser-shaped work (a `Worker`, a
 * `BroadcastChannel`, the wasm module) stays in the boundary and the
 * worker, where Node cannot follow — which is why the runner takes its
 * timers as an injection and a test drives it with millisecond budgets.
 */

/** The five stages, in the order a boot passes through them. */
export const BOOT_STAGES = Object.freeze(['worker-start', 'sqlite-init', 'vfs-acquire', 'topology', 'store-open']);

/** The code every boot failure carries, whatever its stage. */
export const BOOT_ERROR_CODE = 'DATA_BOOT';

/**
 * The production budgets, in milliseconds: the wasm build and the first
 * store open are real work and get room; the pool install is bounded
 * where an engine has been seen never to settle it; a topology decision
 * is a lock probe or a ping window.
 * @type {Readonly<Record<string, number>>}
 */
export const DEFAULT_BOOT_BUDGETS = Object.freeze({
  'worker-start': 15_000,
  'sqlite-init': 30_000,
  'vfs-acquire': 8_000,
  'topology': 5_000,
  'store-open': 30_000,
});

/**
 * The one failure shape a boot can end in: the stage that failed, the
 * cause's message, and the fixed code.
 */
export class DataBootError extends Error {
  /**
   * @param {string} stage - one of {@link BOOT_STAGES}
   * @param {string} message - what happened, for a person
   * @param {unknown} [cause]
   */
  constructor(stage, message, cause = undefined) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DataBootError';
    /** @type {typeof BOOT_ERROR_CODE} */
    this.code = BOOT_ERROR_CODE;
    /** @type {string} */
    this.stage = stage;
  }

  /** The page-visible record: exactly `{ code, stage, message }`. */
  toJSON() {
    return { code: this.code, stage: this.stage, message: this.message };
  }
}

/**
 * Any failure as a boot failure under `stage`: a `DataBootError` keeps
 * the stage it already names, anything else is wrapped with its message.
 * @param {string} stage
 * @param {unknown} error
 * @returns {DataBootError}
 */
export function bootFailure(stage, error) {
  if (error instanceof DataBootError) return error;
  const raised = /** @type {any} */ (error);
  const message = typeof raised?.message === 'string' && raised.message.length > 0
    ? raised.message : String(error);
  return new DataBootError(stage, message, error);
}

/**
 * Resolve the budgets a boot runs under: the defaults, overridden per
 * stage by a positive finite number; anything else is ignored rather than
 * turned into a zero budget nobody meant.
 * @param {unknown} overrides - a partial `{ stage: ms }` record, or not
 * @returns {Readonly<Record<string, number>>}
 */
export function resolveBootBudgets(overrides) {
  const budgets = { ...DEFAULT_BOOT_BUDGETS };
  if (overrides !== null && typeof overrides === 'object') {
    for (const stage of BOOT_STAGES) {
      const value = /** @type {any} */ (overrides)[stage];
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) budgets[stage] = value;
    }
  }
  return Object.freeze(budgets);
}

/**
 * The stage runner. `run(stage, work)` starts `stage`'s timer, calls
 * `work(advance)` and settles ONCE: with the work's value, with the
 * work's failure named under the stage current at that moment, or —
 * when the current stage's budget runs out first — with a
 * `DataBootError` naming that stage. `advance(next)` moves the run to
 * a later stage: the previous timer is cleared and the next stage's
 * budget starts, so a multi-stage piece of work (the worker's init,
 * which announces its stages as it passes them) is bounded per stage
 * from the page. The timer is cleared on every outcome, and a late
 * settlement after a timeout is dropped: the failure a consumer saw is
 * the failure it keeps.
 *
 * @param {{ budgets?: Readonly<Record<string, number>>,
 *   setTimer?: (fn: () => void, ms: number) => any,
 *   clearTimer?: (handle: any) => void }} [options] - budgets per stage
 *   and the timer pair (the platform's by default)
 */
export function createStageRunner(options = {}) {
  const budgets = options.budgets ?? DEFAULT_BOOT_BUDGETS;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));

  /**
   * @param {string} stage
   * @param {(advance: (next: string) => void) => any} work
   * @returns {Promise<any>}
   */
  const run = (stage, work) => new Promise((resolve, reject) => {
    if (!BOOT_STAGES.includes(stage)) {
      reject(new TypeError(`a boot stage is one of ${BOOT_STAGES.join(', ')}, not '${stage}'`));
      return;
    }
    let current = stage;
    let settled = false;
    /** @type {any} */
    let timer = null;
    const stop = () => {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    };
    const arm = () => {
      stop();
      const budget = budgets[current];
      timer = setTimer(() => {
        timer = null;
        if (settled) return;
        settled = true;
        reject(new DataBootError(current, `${current} did not finish within ${budget} ms`));
      }, budget);
    };
    const advance = (/** @type {string} */ next) => {
      if (settled) return;
      if (!BOOT_STAGES.includes(next)) return;
      current = next;
      arm();
    };
    arm();
    let out;
    try {
      out = work(advance);
    }
    catch (error) {
      settled = true;
      stop();
      reject(bootFailure(current, error));
      return;
    }
    Promise.resolve(out).then(
      (value) => {
        if (settled) return;
        settled = true;
        stop();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        stop();
        reject(bootFailure(current, error));
      });
  });

  return Object.freeze({ run, budgets });
}
