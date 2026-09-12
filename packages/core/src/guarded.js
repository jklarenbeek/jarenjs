//@ts-check
import { checkOutcome } from './check.js';

const copy = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const failure = (error, stage) => ({ code: error?.code ?? 'GUARDED',
  docPath: error?.docPath ?? '', message: error?.message ?? String(error), stage });

/**
 * Guard edits to any JSON document using injected, synchronous validation and
 * planning. Neither apply nor a validator receives the reader's original object.
 * Commit owns atomic persistence (or snapshot/restore on a single writer).
 * A failed restore is attempted once and retains both diagnostic causes.
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

  /** Validate and plan without mutating the source or proposal. */
  function prepare(document, proposal) {
    let stage = 'shape';
    try {
      const patch = copy(proposal);
      const shape = checkOutcome(options.validateProposal(patch));
      if (!shape.valid) return { valid: false, errors: shape.errors };
      const previous = copy(document);
      stage = 'apply';
      const next = options.apply(copy(previous), patch);
      stage = 'candidate';
      const candidate = checkOutcome(options.validateCandidate(copy(next), copy(previous)));
      if (!candidate.valid) return { valid: false, errors: candidate.errors };
      stage = 'plan';
      const planned = options.planCommit(copy(next), copy(previous));
      if (planned?.valid === false) return { valid: false, errors: planned.errors };
      return { valid: true, errors: [], next, plan: planned?.plan ?? planned };
    }
    catch (error) {
      return { valid: false, errors: [stage === 'apply' && options.applyFailure
        ? options.applyFailure(error) : failure(error, stage)] };
    }
  }

  /** Commit a prepared candidate; callers must serialize any external writers. */
  async function commitPrepared(previous, prepared) {
    if (!prepared.valid) return { ok: false, stage: 'validation', errors: prepared.errors };
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
      return commitPrepared(previous, prepare(previous, captured));
    });
    pending = result.then(() => undefined, () => undefined);
    return result;
  }
  return { prepare, commitPrepared, commit };
}
