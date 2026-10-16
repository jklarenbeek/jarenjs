// A collect-mode validator narrows the instance it validated: its `narrow`
// answers the same `{ valid, errors }` with the instance on the valid
// branch as `value`, typed by the `T` the caller compiled with, so a strict
// consumer reads it as `T` with no type guard or cast of its own.
import { JarenValidator } from '@jarenjs/validate';
import type { CompiledCollector, NarrowedResult, ValidationError } from '@jarenjs/validate';

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const same = <A, B>(proof: Equals<A, B>): void => void proof;

interface User { name: string, age?: number }
const userSchema = { type: 'object', required: ['name'], properties: { name: { type: 'string' }, age: { type: 'integer' } } };

const check = new JarenValidator({ collectErrors: true }).compile<User>(userSchema);
same<typeof check, CompiledCollector<User>>(true);

declare const input: unknown;
const checked = check.narrow(input);
same<typeof checked, NarrowedResult<User>>(true);
if (checked.valid) {
  const user: User = checked.value;
  const name: string = checked.value.name;
  const none: [] = checked.errors;
  void user; void name; void none;
}
else {
  const errors: ValidationError[] = checked.errors;
  void errors;
}

// the plain call keeps its answer, which carries no instance
const plain = check(input);
// @ts-expect-error the plain collect-mode answer carries no value
if (plain.valid) void plain.value;

// @ts-expect-error an invalid answer carries no value
if (!checked.valid) void checked.value;

// @ts-expect-error the value is read only on the valid branch
void checked.value;

// @ts-expect-error the value is the T the caller compiled with
if (checked.valid) { const n: number = checked.value; void n; }

// without T the value is unknown, not any
const untyped = new JarenValidator({ collectErrors: true }).compile({ type: 'string' }).narrow('x');
if (untyped.valid) same<typeof untyped.value, unknown>(true);

// the boolean mode is the type guard itself and has no narrow
const guard = new JarenValidator().compile<User>(userSchema);
// @ts-expect-error a boolean-mode validator has no narrow
void guard.narrow;
