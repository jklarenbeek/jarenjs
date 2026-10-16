//@ts-check
import { checkOutcome } from './check.js';
import { isThenable } from './function.js';
/** @import { CheckErrorsOf, UnnamedCheckError } from './check.js' */

const copy = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const failure = (error, stage) => ({ code: error?.code ?? 'GUARDED',
  docPath: error?.docPath ?? '', message: error?.message ?? String(error), stage });

/**
 * The stage a failure record names: the hook that threw, or the snapshot,
 * commit or restore step that failed.
 * @typedef {'shape' | 'apply' | 'candidate' | 'plan' | 'snapshot' | 'commit' | 'restore'} GuardedStage
 */

/**
 * The record a thrown value is reported as. Its `code`, `docPath` and
 * `message` are the thrown value's own (strings for an `Error` or a
 * `CodedError`): `code` is `'GUARDED'` and `docPath` is `''` when it has
 * none, and `message` is the value as a string when it has no message.
 * @typedef {{ code: string, docPath: string, message: string, stage: GuardedStage }} GuardedFailure
 */

/**
 * What `commit` receives from `planCommit`'s answer `R`: its `plan`
 * member when that is set, the answer itself otherwise. An answer
 * `{ valid: false }` is a refusal and is never committed.
 * @template R
 * @typedef {R extends { readonly valid: false } ? never
 *   : R extends { readonly plan: infer X } ? Exclude<X, null | undefined> | (X extends null | undefined ? R : never)
 *   : R} GuardedPlanOf
 */

/**
 * A preparation `planCommit` refused by answering `{ valid: false }`: its
 * `errors` member passes on as it is (`undefined` when it has none).
 * @template R
 * @typedef {R extends { readonly valid: false }
 *   ? { valid: false, errors: 'errors' extends keyof R ? R['errors' & keyof R] : undefined }
 *   : never} GuardedPlanRefusal
 */

/**
 * The answer of `prepare` and `prepareAsync`. Every value in it is a JSON
 * clone. `E` is an error the shape or candidate check named, the one
 * `JG2001` error a check that named none is reported as, a
 * {@link GuardedFailure} for a throw, or `applyFailure`'s answer for a
 * throw from `apply`.
 * @template N, R, E
 * @typedef {{ valid: true, errors: [], next: N, plan: GuardedPlanOf<R> }
 *   | { valid: false, errors: E[] } | GuardedPlanRefusal<R>} GuardedPrepared
 */

/**
 * The answer of `commit` and `commitPrepared`, discriminated by `ok`; a
 * failure names its `stage`. `I` is the `errors` member of the refused
 * preparation.
 * @template V, S, I
 * @typedef {{ ok: true, value: V, snapshot: S | null }
 *   | { ok: false, stage: 'validation', errors: I }
 *   | { ok: false, stage: 'snapshot', cause: unknown, errors: [GuardedFailure] }
 *   | { ok: false, stage: 'commit', cause: unknown, snapshot: S | null, restoreError?: unknown,
 *     errors: GuardedFailure[] }} GuardedCommit
 */

/**
 * The hooks a guarded refiner runs. `D` is the document `read` answers,
 * `P` the proposal `validateProposal` accepts, `N` the next document
 * `apply` answers, `R` `planCommit`'s answer, `V` `commit`'s answer and
 * `S` `snapshot`'s token. Each hook may answer a promise, which
 * `prepareAsync` and `commit` await and `prepare` refuses.
 * @template D, P, N, R, V, S, VP, VC, A
 * Each type is read from the one hook that produces it (`D` from `read`,
 * `P` from `validateProposal`'s parameter, `N` from `apply`, `R` from
 * `planCommit`, `V` from `commit`, `S` from `snapshot`); the hooks that
 * receive it are typed by it.
 * @typedef {{ read(): D | PromiseLike<D>,
 *   validateProposal(proposal: P): VP,
 *   apply(document: NoInfer<D>, proposal: NoInfer<P>): N | PromiseLike<N>,
 *   validateCandidate(next: NoInfer<N>, previous: NoInfer<D>): VC,
 *   planCommit(next: NoInfer<N>, previous: NoInfer<D>): R | PromiseLike<R>,
 *   commit(plan: NoInfer<GuardedPlanOf<R>>,
 *     context: { previous: NoInfer<D>, next: NoInfer<N>, snapshot: NoInfer<S> | null }): V | PromiseLike<V>,
 *   snapshot?(): S | PromiseLike<S>, restore?(token: NoInfer<S>): unknown,
 *   applyFailure?(error: unknown): A }} GuardedRefinerOptions
 */

/**
 * The errors a preparation refused with, from the hooks' own answers.
 * @template VP, VC, A
 * @typedef {CheckErrorsOf<Awaited<VP>> | CheckErrorsOf<Awaited<VC>> | UnnamedCheckError | GuardedFailure | A} GuardedError
 */

/**
 * A guarded refiner: the four entry points over one set of hooks.
 * @template D, P, N, R, V, S, VP, VC, A
 * @typedef {{ prepare(document: D, proposal: P): GuardedPrepared<N, R, GuardedError<VP, VC, A>>,
 *   prepareAsync(document: D, proposal: P): Promise<GuardedPrepared<N, R, GuardedError<VP, VC, A>>>,
 *   commitPrepared(previous: D, prepared: GuardedPrepared<N, R, GuardedError<VP, VC, A>>):
 *     Promise<GuardedCommit<V, S, Extract<GuardedPrepared<N, R, GuardedError<VP, VC, A>>, { valid: false }>['errors']>>,
 *   commit(proposal: P):
 *     Promise<GuardedCommit<V, S, Extract<GuardedPrepared<N, R, GuardedError<VP, VC, A>>, { valid: false }>['errors']>> }} GuardedRefiner
 */

/**
 * Guard JSON edits with cloned inputs and serialized commits. prepare is
 * synchronous; prepareAsync and commit await validation and planning hooks.
 * Commit owns atomic persistence (or snapshot/restore on a single writer).
 * @template D, N, R, V, [P=unknown], [S=never], [VP=unknown], [VC=unknown], [A=never]
 * @param {GuardedRefinerOptions<D, P, N, R, V, S, VP, VC, A>} options
 * @returns {GuardedRefiner<D, P, N, R, V, S, VP, VC, A>}
 */
export function createGuardedRefiner(options) {
  for (const name of ['read', 'validateProposal', 'apply', 'validateCandidate', 'planCommit', 'commit'])
    if (typeof options[name] !== 'function') throw new TypeError(`guarded refiner needs ${name}`);
  if (Boolean(options.snapshot) !== Boolean(options.restore))
    throw new TypeError('snapshot and restore must be supplied together');
  let pending = Promise.resolve();

  // One staged transition serves both preparation modes. The runner decides
  // whether a suspension is allowed, never which checks to omit.
  function* stages(document, proposal) {
    const previous = copy(document), patch = copy(proposal);
    const shape = checkOutcome(yield { stage: 'shape', run: () => options.validateProposal(patch) });
    if (!shape.valid) return shape;
    const next = yield { stage: 'apply', run: () => options.apply(copy(previous), patch) };
    const candidate = checkOutcome(yield { stage: 'candidate', run: () => options.validateCandidate(copy(next), copy(previous)) });
    if (!candidate.valid) return candidate;
    const planned = yield { stage: 'plan', run: () => options.planCommit(copy(next), copy(previous)) };
    if (planned?.valid === false) return { valid: false, errors: planned.errors };
    return { valid: true, errors: [], next: copy(next), plan: copy(planned?.plan ?? planned) };
  }

  function prepareWith(document, proposal, asynchronous) {
    let stage = 'shape';
    const iterator = stages(document, proposal);
    const failed = error => ({ valid: false, errors: [stage === 'apply' && options.applyFailure
      ? options.applyFailure(error) : failure(error, stage)] });
    function step(value) {
      try {
        const item = iterator.next(value);
        if (item.done) return item.value;
        stage = item.value.stage;
        const answer = item.value.run();
        if (isThenable(answer)) {
          if (!asynchronous) {
            Promise.resolve(answer).catch(() => {});
            throw new TypeError('asynchronous hook requires prepareAsync or commit');
          }
          return Promise.resolve(answer).then(step, failed);
        }
        return step(answer);
      }
      catch (error) { return failed(error); }
    }
    return step(undefined);
  }

  /** Validate and plan synchronously; thenables are refused, never committed. */
  function prepare(document, proposal) { return prepareWith(document, proposal, false); }

  /** Validate and plan while awaiting asynchronous hooks on cloned inputs. */
  async function prepareAsync(document, proposal) { return prepareWith(document, proposal, true); }

  /** Commit a prepared candidate; callers must serialize any external writers. */
  async function commitPrepared(previous, prepared) {
    if (!prepared.valid) return { ok: false, stage: 'validation', errors: prepared.errors };
    // Capture before snapshot can suspend; the caller cannot retarget a plan
    // after validation by changing an object while persistence is preparing.
    previous = copy(previous);
    prepared = copy(prepared);
    let token;
    try { token = options.snapshot ? await options.snapshot() : null; }
    catch (error) { return { ok: false, stage: 'snapshot', cause: error, errors: [failure(error, 'snapshot')] }; }
    try {
      const value = await options.commit(copy(prepared.plan), {
        previous: copy(previous), next: copy(prepared.next), snapshot: token,
      });
      return { ok: true, value, snapshot: token };
    }
    catch (cause) {
      let restoreError;
      if (options.restore) {
        try {
          const restored = await options.restore(token);
          if (restored?.error !== undefined) throw new Error(restored.error);
        }
        catch (error) { restoreError = error; }
      }
      return { ok: false, stage: 'commit', cause, snapshot: token,
        ...(restoreError === undefined ? {} : { restoreError }),
        errors: [failure(cause, 'commit'), ...(restoreError === undefined ? [] : [failure(restoreError, 'restore')])] };
    }
  }

  /** Read, prepare and commit one proposal, serialized with this engine's peers. */
  function commit(proposal) {
    const captured = copy(proposal);
    const result = pending.then(async () => {
      const previous = await options.read();
      return commitPrepared(previous, await prepareAsync(previous, captured));
    });
    pending = result.then(() => undefined, () => undefined);
    return result;
  }
  return { prepare, prepareAsync, commitPrepared, commit };
}
