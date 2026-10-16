// The answers a strict consumer reads without a cast: a check's outcome
// keeps the error type its answer carries, a guarded refiner's result is
// discriminated by `ok` and names its stage as a literal, and a
// collect-mode validator's result is discriminated by `valid`.
import { checkOutcome, composeChecks } from '@jarenjs/core/check';
import type { CheckOutcome, CheckError, UnnamedCheckError } from '@jarenjs/core/check';
import { createGuardedRefiner } from '@jarenjs/core/guarded';
import type { GuardedFailure, GuardedStage } from '@jarenjs/core/guarded';
import { JarenValidator } from '@jarenjs/validate';
import type { ValidationError } from '@jarenjs/validate';

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const same = <A, B>(proof: Equals<A, B>): void => void proof;

// ——— checkOutcome / composeChecks ———

declare const collected: { valid: boolean, errors: ValidationError[] };
const read = checkOutcome(collected);
same<typeof read, CheckOutcome<ValidationError>>(true);
if (!read.valid) {
  const first = read.errors[0];
  // an invalid answer that named no error is the one coded JG2001 error
  if ('instancePath' in first) { const at: string = first.instancePath; void at; }
  else { const code: 'JG2001' = first.code; const path: '' = first.docPath; void [code, path]; }
  // @ts-expect-error an error is an object, not a number
  const wrong: number = first;
}
// a bare boolean names no errors: an invalid answer is the coded one only
const bare = checkOutcome(false);
same<typeof bare, CheckOutcome<never>>(true);
if (!bare.valid) { const only: UnnamedCheckError[] = bare.errors; void only; }
// an answer whose type does not say carries errors of unknown type
declare const opaque: unknown;
const unread = checkOutcome(opaque);
same<typeof unread, CheckOutcome<unknown>>(true);
// @ts-expect-error an unknown error must be narrowed before it is read
void unread.errors[0].code;
// a promise is refused (JG0001): its outcome is never read
// @ts-expect-error a thenable answer has no `valid`
void checkOutcome(Promise.resolve(true)).valid;

const odd = { valid: false, errors: [{ code: 'ODD', docPath: '', message: 'odd' }] } as const;
const composed = composeChecks((n: number) => n > 0, (n: number) => (n % 2 === 0 ? true : odd));
const verdict = composed(3);
if (!verdict.valid) {
  const e = verdict.errors[0];
  const code: 'ODD' | 'JG2001' = e.code;
  void code;
}
// the documented error members a repair loop reads
const loose: CheckError = { code: 'X', docPath: '/a', instancePath: '', message: 'm', params: {} };
void loose;
// @ts-expect-error a CheckError's members are the documented ones
const looser: CheckError = { code: 1 };

// ——— createGuardedRefiner ———

type Doc = { count: number };
type Patch = { add: number };
const refiner = createGuardedRefiner({
  read: async (): Promise<Doc> => ({ count: 1 }),
  validateProposal: (patch: Patch) => Number.isInteger(patch.add),
  apply: (doc, patch) => ({ count: doc.count + patch.add }),
  validateCandidate: (next) => (next.count >= 0 ? true : { valid: false, errors: [{ code: 'NEGATIVE', message: 'below zero' }] }),
  planCommit: (next) => ({ plan: { write: next.count } }),
  commit: async (plan, context) => ({ written: plan.write, before: context.previous.count }),
});
const committed = await refiner.commit({ add: 2 });
if (committed.ok) {
  same<typeof committed.value, { written: number, before: number }>(true);
} else {
  const stage: 'validation' | 'snapshot' | 'commit' = committed.stage;
  void stage;
  if (committed.stage === 'validation') {
    const e = committed.errors[0];
    if ('stage' in e) { const failed: GuardedStage = e.stage; void failed; }
  } else {
    const failure: GuardedFailure = committed.errors[0];
    const cause: unknown = committed.cause;
    void [failure, cause];
  }
}
const prepared = refiner.prepare({ count: 1 }, { add: 1 });
if (prepared.valid) { const write: number = prepared.plan.write; const next: number = prepared.next.count; void [write, next]; }
// @ts-expect-error a proposal is what validateProposal accepts
void refiner.commit({ add: 'two' });
// @ts-expect-error only a commit failure carries a cause; narrow the stage first
if (!committed.ok) void committed.cause;

// ——— a collect-mode validator ———

const collect = new JarenValidator({ collectErrors: true }).compile({ type: 'string' });
const result = collect(1);
if (result.valid) { const none: [] = result.errors; void none; }
else { const keyword: string = result.errors[0].keyword; void keyword; }
// @ts-expect-error a valid answer names no error
if (result.valid) void result.errors[0];
