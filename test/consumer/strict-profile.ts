// A strict consumer derives a strict structured-output profile and reads it
// with no cast: the profile document is a record a provider request takes,
// both maps take and give `unknown` (the original's validator narrows what
// `fromProfile` returns to the caller's `T`), and a refusal is a coded
// `SchemaCompileError`.
import { JarenValidator, SchemaCompileError } from '@jarenjs/validate';
import { deriveStrictProfile, relaxSchema, type StrictProfile } from '@jarenjs/validate/strict-profile';

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const same = <A, B>(proof: Equals<A, B>): void => void proof;

interface Patch { ops: Array<{ op: 'add' | 'remove', path: string, value?: string }> }
const patchSchema = {
  type: 'object', required: ['ops'],
  properties: { ops: { type: 'array', items: { type: 'object', required: ['op', 'path'], properties: {
    op: { enum: ['add', 'remove'] }, path: { type: 'string' }, value: { type: 'string' },
  } } } },
};

const strict = deriveStrictProfile(patchSchema, { references: [] });
same<typeof strict, StrictProfile>(true);
const request: { schema: Record<string, unknown>, strict: true } = { schema: strict.schema, strict: true };
void request;

declare const answer: unknown;
const filled: unknown = strict.toProfile({ ops: [] });
void filled;
const check = new JarenValidator({ collectErrors: true }).compile<Patch>(patchSchema);
const checked = check.narrow(strict.fromProfile(answer));
if (checked.valid) {
  const patch: Patch = checked.value;
  void patch;
}

const relaxed: object | boolean = relaxSchema(patchSchema, {
  keywords: new Set(['format', 'pattern']),
  note: (keyword: string, value: unknown) => `(${keyword} ${String(value)} relaxed)`,
});
void relaxed;

try { deriveStrictProfile({ type: 'object' }); }
catch (error) {
  if (error instanceof SchemaCompileError) {
    const code: string = error.code;
    void code;
  }
}

// @ts-expect-error references is an array of schema documents
deriveStrictProfile(patchSchema, { references: {} });
// @ts-expect-error relaxSchema needs the note that restates a keyword
relaxSchema(patchSchema, { keywords: ['format'] });
