// @jarenjs/linq/schema — the type half of the three-way agreement.
//
// For every corpus entry the pen's `Infer<>` is proven EQUAL (not merely
// assignable) to emit's generated declaration for the document the pen
// emitted, and `Input<>` to the accepted twin where normalization derives
// one; valid instances are assignable and structurally invalid ones are
// pinned with @ts-expect-error. The builders are the corpus's own exports
// (allowJs), so the runtime gate and this file read the same objects.
// The runtime twins live in test/linq/schema-pen.test.js.
import * as s from '@jarenjs/linq/schema';
import type { Infer, Input, BooleanBuilder, NamedBuilder, NullBuilder } from '@jarenjs/linq/schema';
import { NeverBuilder, SchemaBuilder, createFactories } from '@jarenjs/linq/schema';
import type * as G from './linq-schema-generated.js';
import { from } from '@jarenjs/linq';
import type { DateTime, Sequence } from '@jarenjs/linq';
import type { ToolDef } from '@jarenjs/ai/toolbox';
import {
  Account, Strict, Config, Id, Exact, Empty, Job, Scalars, Literals, Enums, Nullables,
  StringRules, NumberRules, Dates, ArrayRules, Tuples, Dict, Either, Shape, Both, Node,
  Linked, Conditional, Wrapped, Members, Patterned, Keyed, Derived, Invoice, Order,
  Coerced, Level, Annotated,
} from '../linq/schema-corpus.js';

/** Identical types, in both directions — the strict check, not assignability. */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

// ——— every corpus entry: Infer ≡ emit's declaration, Input ≡ the accepted twin ———
const accountOut: Equals<Infer<typeof Account>, G.Account> = true;
const accountIn: Equals<Input<typeof Account>, G.Account> = true;
const strictOut: Equals<Infer<typeof Strict>, G.Strict> = true;
const strictIn: Equals<Input<typeof Strict>, G.Strict> = true;
const configOut: Equals<Infer<typeof Config>, G.Config> = true;
const configIn: Equals<Input<typeof Config>, G.ConfigInput> = true;
const idOut: Equals<Infer<typeof Id>, G.Id> = true;
const idIn: Equals<Input<typeof Id>, G.Id> = true;
const exactOut: Equals<Infer<typeof Exact>, G.Exact> = true;
const exactIn: Equals<Input<typeof Exact>, G.Exact> = true;
const emptyOut: Equals<Infer<typeof Empty>, G.Empty> = true;
const emptyIn: Equals<Input<typeof Empty>, G.Empty> = true;
const jobOut: Equals<Infer<typeof Job>, G.Job> = true;
const jobIn: Equals<Input<typeof Job>, G.JobInput> = true;
const scalarsOut: Equals<Infer<typeof Scalars>, G.Scalars> = true;
const scalarsIn: Equals<Input<typeof Scalars>, G.Scalars> = true;
const literalsOut: Equals<Infer<typeof Literals>, G.Literals> = true;
const literalsIn: Equals<Input<typeof Literals>, G.Literals> = true;
const enumsOut: Equals<Infer<typeof Enums>, G.Enums> = true;
const enumsIn: Equals<Input<typeof Enums>, G.Enums> = true;
const nullablesOut: Equals<Infer<typeof Nullables>, G.Nullables> = true;
const nullablesIn: Equals<Input<typeof Nullables>, G.Nullables> = true;
const stringRulesOut: Equals<Infer<typeof StringRules>, G.StringRules> = true;
const stringRulesIn: Equals<Input<typeof StringRules>, G.StringRules> = true;
const numberRulesOut: Equals<Infer<typeof NumberRules>, G.NumberRules> = true;
const numberRulesIn: Equals<Input<typeof NumberRules>, G.NumberRules> = true;
const datesOut: Equals<Infer<typeof Dates>, G.Dates> = true;
const datesIn: Equals<Input<typeof Dates>, G.Dates> = true;
const arrayRulesOut: Equals<Infer<typeof ArrayRules>, G.ArrayRules> = true;
const arrayRulesIn: Equals<Input<typeof ArrayRules>, G.ArrayRules> = true;
const tuplesOut: Equals<Infer<typeof Tuples>, G.Tuples> = true;
const tuplesIn: Equals<Input<typeof Tuples>, G.Tuples> = true;
const dictOut: Equals<Infer<typeof Dict>, G.Dict> = true;
const dictIn: Equals<Input<typeof Dict>, G.Dict> = true;
const eitherOut: Equals<Infer<typeof Either>, G.Either> = true;
const eitherIn: Equals<Input<typeof Either>, G.Either> = true;
const shapeOut: Equals<Infer<typeof Shape>, G.Shape> = true;
const shapeIn: Equals<Input<typeof Shape>, G.Shape> = true;
const bothOut: Equals<Infer<typeof Both>, G.Both> = true;
const bothIn: Equals<Input<typeof Both>, G.Both> = true;
const treeOut: Equals<Infer<typeof Node>, G.Tree> = true;
const treeIn: Equals<Input<typeof Node>, G.Tree> = true;
const linkedOut: Equals<Infer<typeof Linked>, G.Linked> = true;
const linkedIn: Equals<Input<typeof Linked>, G.Linked> = true;
const conditionalOut: Equals<Infer<typeof Conditional>, G.Conditional> = true;
const conditionalIn: Equals<Input<typeof Conditional>, G.Conditional> = true;
const wrappedOut: Equals<Infer<typeof Wrapped>, G.Wrapped> = true;
const wrappedIn: Equals<Input<typeof Wrapped>, G.Wrapped> = true;
const membersOut: Equals<Infer<typeof Members>, G.Members> = true;
const membersIn: Equals<Input<typeof Members>, G.Members> = true;
const patternedOut: Equals<Infer<typeof Patterned>, G.Patterned> = true;
const patternedIn: Equals<Input<typeof Patterned>, G.Patterned> = true;
const keyedOut: Equals<Infer<typeof Keyed>, G.Keyed> = true;
const keyedIn: Equals<Input<typeof Keyed>, G.Keyed> = true;
const derivedOut: Equals<Infer<typeof Derived>, G.Derived> = true;
const derivedIn: Equals<Input<typeof Derived>, G.Derived> = true;
const invoiceOut: Equals<Infer<typeof Invoice>, G.Invoice> = true;
const invoiceIn: Equals<Input<typeof Invoice>, G.Invoice> = true;
const orderOut: Equals<Infer<typeof Order>, G.Order> = true;
const orderIn: Equals<Input<typeof Order>, G.Order> = true;
const coercedOut: Equals<Infer<typeof Coerced>, G.Coerced> = true;
const coercedIn: Equals<Input<typeof Coerced>, G.CoercedInput> = true;
const levelOut: Equals<Infer<typeof Level>, G.Level> = true;
const levelIn: Equals<Input<typeof Level>, G.LevelInput> = true;
const annotatedOut: Equals<Infer<typeof Annotated>, G.Annotated> = true;
const annotatedIn: Equals<Input<typeof Annotated>, G.Annotated> = true;
void [accountOut, accountIn, strictOut, strictIn, configOut, configIn, idOut, idIn,
  exactOut, exactIn, emptyOut, emptyIn, jobOut, jobIn, scalarsOut, scalarsIn,
  literalsOut, literalsIn, enumsOut, enumsIn, nullablesOut, nullablesIn,
  stringRulesOut, stringRulesIn, numberRulesOut, numberRulesIn, datesOut, datesIn,
  arrayRulesOut, arrayRulesIn, tuplesOut, tuplesIn, dictOut, dictIn, eitherOut,
  eitherIn, shapeOut, shapeIn, bothOut, bothIn, treeOut, treeIn, linkedOut, linkedIn,
  conditionalOut, conditionalIn, wrappedOut, wrappedIn, membersOut, membersIn,
  patternedOut, patternedIn, keyedOut, keyedIn, derivedOut, derivedIn, invoiceOut,
  invoiceIn, orderOut, orderIn, coercedOut, coercedIn, levelOut, levelIn, annotatedOut, annotatedIn];

// the brand: a date-formatted string IS the linq DateTime, so the date
// family lights up on a chain over the pen's shape
const brandOut: Equals<Infer<typeof Dates>['at'], DateTime> = true;
void brandOut;
const datesRows: Infer<typeof Dates>[] = [];
void from(datesRows).where((d) => d.at.year().ge(2020)).select((d) => d.at.startOf('month')).count();
// a check() rule sees the shape: members are typed, the externals are the two names
void s.object({ start: s.datetime(), end: s.datetime(), n: s.number() })
  .check((o, x) => o.start.le(o.end).and(o.n.gt(0)).and(x.path.eq('')))
  .check({ $le: ['$.start', '$.end'] });

// ——— valid instances are assignable; structurally invalid ones are not ———
const strictValid: Infer<typeof Strict> = { kind: 'a' };
// @ts-expect-error — a closed object rejects an extra member
const strictExtra: Infer<typeof Strict> = { kind: 'a', extra: 1 };
const accountValid: Infer<typeof Account> = { id: 'abc', extra: true };
// @ts-expect-error — a wrong member type
const accountBad: Infer<typeof Account> = { id: 42 };
const configIn1: Input<typeof Config> = { name: 'a' };
// @ts-expect-error — after normalization the defaulted member is present
const configOut1: Infer<typeof Config> = { name: 'a' };
const coercedIn1: Input<typeof Coerced> = { port: '80', name: ' a ' };
// @ts-expect-error — the transport form is not the normalized shape
const coercedOut1: Infer<typeof Coerced> = { port: '80', name: 'a', ratio: 1 };
const shapeValid: Infer<typeof Shape> = { kind: 'circle', r: 1 };
// @ts-expect-error — the discriminator picks the arm
const shapeBad: Infer<typeof Shape> = { kind: 'circle', side: 2 };
const treeValid: Infer<typeof Node> = { label: 'root', children: [{ label: 'kid', children: [] }] };
// @ts-expect-error — recursion is typed all the way down
const treeBad: Infer<typeof Node> = { label: 'root', children: [{ notALabel: true }] };
const tuplesValid: Infer<typeof Tuples> = { open: ['a', 1, 'anything'], tail: ['a', true], exact: ['a', 1] };
// @ts-expect-error — a closed tuple has no rest
const tuplesBad: Infer<typeof Tuples> = { open: ['a', 1], tail: ['a'], exact: ['a', 1, 2] };
const patternedValid: Infer<typeof Patterned> = { id: 'a', 'x-1': 2 };
// the index signature carries the pattern values widened over the members
// (emit's rule), so a string under a pattern key is type-valid and
// schema-invalid — the honest widening the corpus records; a boolean is not
const patternedWidened: Infer<typeof Patterned> = { id: 'a', 'x-1': 'no' };
// @ts-expect-error — the index signature is number | string
const patternedBad: Infer<typeof Patterned> = { id: 'a', 'x-1': true };
const emptyValid: Infer<typeof Empty> = {};
// @ts-expect-error — a closed empty object is Record<string, never>
const emptyBad: Infer<typeof Empty> = { a: 1 };
const wrappedValid: Infer<typeof Wrapped> = { meta: { a: 'x', b: 1 }, anything: null };
// @ts-expect-error — never() admits nothing
const wrappedBad: Infer<typeof Wrapped> = { meta: {}, anything: 1, nothing: 1 };
void [strictValid, strictExtra, accountValid, accountBad, configIn1, configOut1, coercedIn1,
  coercedOut1, shapeValid, shapeBad, treeValid, treeBad, tuplesValid, tuplesBad,
  patternedValid, patternedWidened, patternedBad, emptyValid, emptyBad, wrappedValid, wrappedBad];

// ——— the negatives: each pinned so it FAILS the build if it ever starts compiling ———
// @ts-expect-error — a string constraint takes a number
void s.string().min('x');
// @ts-expect-error — a pen-owned keyword cannot pass through meta()
void s.object({}).meta({ type: 'x' });
// @ts-expect-error — lazy() demands a NAMED builder
void s.lazy(() => s.string());
// @ts-expect-error — trim() is a string method; a number carries no whitespace
void s.number().trim();
// @ts-expect-error — pick() names members the object has
void s.object({ a: s.string() }).pick(['zzz']);
// @ts-expect-error — a default is a value of the member's own type
void s.integer().default('three');
// @ts-expect-error — a check rule reads the shape it guards
void s.object({ n: s.number() }).check((o) => o.m.exists());
// @ts-expect-error — the externals are root and path, nothing else
void s.object({ n: s.number() }).check((o, x) => o.n.eq(x.limit));

// ——— the chain accepts a builder where a document was, and types the element ———
const rows: unknown[] = [];
const typedByPen: Sequence<Infer<typeof Strict>> = from(rows).ofType(Strict);
const kinds: string[] = typedByPen.select((r) => r.kind).toArray();
const castByPen: Sequence<Infer<typeof Account>> = from(rows).cast(Account);
const stillAsserted: Sequence<unknown> = from(rows).ofType({ type: 'number' });
const explicitlyAsserted: Sequence<number> = from(rows).ofType<number>({ type: 'number' });
void [typedByPen, kinds, castByPen, stillAsserted, explicitlyAsserted];

// ——— the AI tie-in: a pen document is a tool's inputSchema, and execute
// takes Infer<> of the same builder — proven without any import in linq ———
const User = s.object({ id: s.string().uuid(), name: s.string().min(1), age: s.integer().optional() });
const userTool: ToolDef = {
  name: 'user.create',
  description: 'Create a user',
  inputSchema: User.schema,
  execute: (input: Infer<typeof User>) => ({ created: input.id, name: input.name.toUpperCase() }),
};
void userTool;

// ——— the surface, named ———
const named: NamedBuilder<{ id: string }> = s.named('Ref', s.object({ id: s.string() }));
const asBase: SchemaBuilder<{ id: string }> = named;
const doc: unknown = s.document(User, { draft: '2020-12' });
const json: string = JSON.stringify(User);
const isOne: boolean = s.isSchemaBuilder(User);
const unwrapped: unknown = s.schemaOf(User);
void [asBase, doc, json, isOne, unwrapped];

// ——— the declared surface and the runtime surface are one set ———
// The census in test/linq/types.test.js holds these two halves equal;
// these are the compile-level pins for the names it moved. The three
// builders below are TYPES (`boolean()`, `nil()` and `named()` all
// answer a plain SchemaBuilder at run time, so there is no class), and
// the two names below them are VALUES the module really exports.
const flag: BooleanBuilder = s.boolean();
const nothing: NullBuilder = s.nil();
void [flag, nothing, named];

// never() ANSWERS a NeverBuilder — no cast: the factory used to be
// declared SchemaBuilder<never, never>, so a caller who wanted the class
// the runtime really builds had to assert it, and every method this class
// refuses type-checked on the way through.
const never: NeverBuilder = s.never();
const isNever: boolean = s.never() instanceof NeverBuilder;
// nullable() widens what `false` admits, so it hands back the base
// builder: the annotations JL0102 refuses below are legal after it, and
// that is the remedy the refusal names — under test, because a message
// that names a way out needs a way out that works.
const widened: SchemaBuilder<never | null, never | null> = never.nullable();
const annotated: unknown = never.nullable().title('t').describe('d').schema;
// before nullable(), each refusal is a COMPILE error and not merely a
// `never` return: a method declared only `: never` still type-checks at
// its call site, so the parameter is `never` too and nothing is
// assignable to it. Each line below is what JL0102 does at run time.
// @ts-expect-error — `false` carries no `title`
never.title('t');
// @ts-expect-error — `false` carries no `description`
never.describe('d');
// @ts-expect-error — `false` carries no annotation of any name
never.meta({ deprecated: true });
// @ts-expect-error — `false` carries no `default`
never.default(0);
// @ts-expect-error — `false` carries no `examples`
never.example(0);
// @ts-expect-error — `false` carries no `errorMessage`
never.message('m');
// @ts-expect-error — nothing reaches a check on `false`
never.check((v) => v);
// the pen wiring, called the way ./model and ./forms call it
const pen = createFactories({
  Base: SchemaBuilder, String: SchemaBuilder, Number: SchemaBuilder,
  Array: SchemaBuilder, Tuple: SchemaBuilder, Object: SchemaBuilder,
  When: SchemaBuilder, Never: NeverBuilder,
});
const hasString: boolean = typeof pen.string === 'function';
void [never, isNever, hasString, widened, annotated];

// A type is not a value: importing one as a value is the mistake the
// census now makes impossible to ship.
// @ts-expect-error BooleanBuilder is exported as a type only
void s.BooleanBuilder;
// @ts-expect-error NullBuilder is exported as a type only
void s.NullBuilder;
// @ts-expect-error NamedBuilder is exported as a type only
void s.NamedBuilder;
