//@ts-check
import { checkOutcome } from './check.js';
import { isThenable } from './function.js';

const copy = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const failure = (error, stage) => ({ code: error?.code ?? 'GUARDED',
  docPath: error?.docPath ?? '', message: error?.message ?? String(error), stage });

/**
 * Guard JSON edits with cloned inputs and serialized commits. prepare is
 * synchronous; prepareAsync and commit await validation and planning hooks.
 * Commit owns atomic persistence (or snapshot/restore on a single writer).
 * @param {{ read: () => Promise<any>, validateProposal: (proposal: any) => any,
 *   apply: (document: any, proposal: any) => any,
 *   validateCandidate: (next: any, previous: any) => any,
 *   planCommit: (next: any, previous: any) => any,
 *   commit: (plan: any, context: { previous: any, next: any, snapshot: any }) => Promise<any>,
 *   snapshot?: () => Promise<any>, restore?: (token: any) => Promise<any>,
 *   applyFailure?: (error: any) => any }} options
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
