// A compile that refuses by throwing, made a check a strict consumer reads
// without a cast: the outcome is discriminated by `valid`, every error
// carries text `code`, `docPath` and `message`, and the check composes.
import { checkCompile, composeChecks } from '@jarenjs/core/check';
import type { CheckOutcome, CompileCheckError } from '@jarenjs/core/check';
import { compileJsonQuery } from '@jarenjs/json/query';

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const same = <A, B>(proof: Equals<A, B>): void => void proof;

const gate = checkCompile(compileJsonQuery, { fallbackCode: 'HOST0001' });
const outcome = gate({ a: { $bogus: 1 } });
same<typeof outcome, CheckOutcome<CompileCheckError>>(true);
if (!outcome.valid) {
  const first = outcome.errors[0];
  const code: string = first.code, docPath: string = first.docPath, message: string = first.message;
  void [code, docPath, message];
  // @ts-expect-error a compile error is located by docPath, not instancePath
  void first.instancePath;
}

// a host's own compile, composed after a boolean shape check
const isObject = (doc: unknown): boolean => typeof doc === 'object' && doc !== null;
const composed = composeChecks(isObject, checkCompile((doc: unknown) => { if (doc === null) throw new TypeError('null'); }, { fallbackCode: 'HOST0002' }));
const read = composed({});
if (!read.valid) { const code: string = read.errors[0].code; void code; }

// @ts-expect-error the fallback code is required
checkCompile(compileJsonQuery, {});
// @ts-expect-error the fallback code is text
checkCompile(compileJsonQuery, { fallbackCode: 1 });
// @ts-expect-error the options are required
checkCompile(compileJsonQuery);
