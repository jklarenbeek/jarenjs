/**
 * Hand-authored declarations for `@jarenjs/linq/migration` — the
 * migration pen's type contract, on the line every pen keeps: the common
 * path precisely typed, the exotic path honestly `unknown`, nothing ever
 * a WRONG type.
 *
 * A transform is typed from the two model documents' phantoms. `from`
 * gives the OLD shape of the named table (`InferMeta<typeof
 * previous>[name]['doc']`), the value the callback is captured over;
 * `to` gives the NEW shape, which the callback's result must SPELL — a
 * member forgotten, mistyped or not in the new shape is a compile error,
 * and the honest top (`UnknownExpr`, a `get()`) is admitted wherever a
 * precise value is, because the runtime validator is the judge there.
 * From a JSON snapshot the old shape is `unknown` and the value the
 * honest top; the author annotates it (`(u: Expr<User>) => …`) from the
 * declaration `jaren-db snapshot --types` writes, or keeps the previous
 * model module beside the current one so the phantom is there. An
 * assertion's row is typed by the members the two shapes SHARE (a
 * precondition sees old rows, a postcondition new ones; what both agree
 * on is what neither lies about), annotated when one shape is meant.
 * Every claim here has a runtime twin in
 * `test/linq/migration-pen.test.js` and a compile-level pin in
 * `test/consumer/linq-migration.ts`.
 */

import type { BoolExpr, DateTime, ExprBase, MemberExpr, UnknownExpr } from './index.js';
import type { Json } from './schema.js';
import type { ModelDocument, InferMeta } from './model.js';
import type { Externals, RuleDocument, RuleOut, ValueOf } from './jslt.js';

// ————— the document —————

export interface DdlStep { readonly kind: 'ddl'; readonly sql: string; readonly note?: string }
export interface SqlStep { readonly kind: 'sql'; readonly sql: string; readonly note?: string }
export interface JsltStep {
  readonly kind: 'jslt';
  readonly collection: string;
  readonly stylesheet: readonly RuleDocument[];
  /** A planner placeholder; the runner refuses it (`JD0021`). The pen never sets or clears it. */
  readonly draft?: boolean;
  readonly note?: string;
}
export interface QueryStep {
  readonly kind: 'query';
  readonly collection: string;
  readonly assert: Json;
  readonly expect?: 'empty' | 'ebv';
  readonly note?: string;
}
export interface DeriveColumn {
  readonly name: string;
  readonly derive: 'geohash' | 'bbox' | 'vector';
  readonly precision?: number;
  readonly dims?: number;
  readonly component?: 'w' | 's' | 'e' | 'n';
  readonly segments: readonly object[];
}
export interface DeriveStep {
  readonly kind: 'derive';
  readonly collection: string;
  readonly columns: readonly DeriveColumn[];
  readonly note?: string;
}
export interface RebuildStep {
  readonly kind: 'rebuild';
  readonly table: string;
  readonly create: readonly string[];
  readonly copy: string;
  readonly indexes: readonly string[];
  readonly note?: string;
}
export type MigrationStep = DdlStep | SqlStep | JsltStep | QueryStep | DeriveStep | RebuildStep;

/** The `$migration` 0.1 document (MIGRATION-FORMAT §2). */
export interface MigrationDocument {
  readonly $migration: '0.1';
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly note?: string;
  readonly steps: readonly MigrationStep[];
}

// ————— what a model document types —————

/** The entities and collections a model document declares; any string
 * for a document the type cannot read (a JSON snapshot). */
export type DeclaredNames<M> = M extends ModelDocument<infer E, infer C>
  ? (unknown extends E ? string : keyof E & string) | (unknown extends C ? string : keyof C & string)
  : string;

/** The document shape of table `N` in a model — an entity's `doc`; the
 * honest `unknown` for a collection, a JSON snapshot, or a name the
 * model does not type. */
export type DocOf<M, N extends string> =
  [InferMeta<M>] extends [never] ? unknown
    : N extends keyof InferMeta<M>
      ? (InferMeta<M>[N] extends { doc: infer D } ? D : unknown)
      : unknown;

/** How a value of `T` is spelled in a transform's result: the value
 * itself, an expression yielding it, the honest top, or — for an object
 * — a literal spelling each member the same way; `unknown` admits
 * anything. */
export type Spell<T> = SpellPresent<Exclude<T, undefined>> | (undefined extends T ? undefined : never);
type SpellPresent<T> =
  unknown extends T ? unknown :
  [T] extends [DateTime] ? string | ExprBase<string> | UnknownExpr :
  [T] extends [readonly (infer E)[]] ? T | ExprBase<T> | UnknownExpr | readonly Spell<E>[] :
  [T] extends [object] ? T | ExprBase<T> | UnknownExpr | { readonly [K in keyof T]: Spell<T[K]> } :
  T | ExprBase<T> | UnknownExpr;

/** A rules array's verdict: a typed first rule must produce the new
 * shape; a hand-written rule (`unknown` out) is the honest top. */
export type RulesFor<R extends readonly RuleDocument[], New> =
  unknown extends RuleOut<R[0]> ? unknown : RuleOut<R[0]> extends New ? unknown : never;

/** Any stylesheet envelope: the JSLT pen's (phantoms and all) or a hand-written one. */
export type StylesheetLike = { readonly $jslt: '0.1'; readonly rules: readonly RuleDocument[] };

/** A stylesheet's verdict: a typed one must produce the new shape; an
 * untyped or hand-written one is the honest top. */
export type SheetFor<S, New> = S extends { readonly __out: infer O }
  ? (unknown extends O ? unknown : O extends New ? unknown : never)
  : unknown;

export interface AssertOptions {
  /** `'empty'` (the default, absent from the document): no row may
   * satisfy the predicate — it names the violation; `'ebv'`: the matching
   * rows are the witness. */
  readonly expect?: 'empty' | 'ebv';
}

// ————— the builder —————

/** The migration under construction: immutable, every method a new
 * builder; `.document`/`toJSON()` the deep-frozen document. */
export class Migration<From = unknown, To = unknown> {
  private constructor();
  /** One rendered DDL statement (`ddl`). */
  ddl(sql: string, note?: string): Migration<From, To>;
  /** One data statement spelled directly (`sql`, MIGRATION-FORMAT §9.4). */
  sql(sql: string, note?: string): Migration<From, To>;
  /** A `jslt` step: one root rule captured over the OLD row (`root`/`path`
   * as externals), whose result spells the NEW row. Over a planned
   * document it replaces the draft for `name`; otherwise it is appended
   * for a table the target declares. */
  transform<N extends DeclaredNames<To>, V extends ExprBase<unknown> = MemberExpr<DocOf<From, N>>>(
    name: N,
    rule: (row: V, x: Externals<{}, ValueOf<V>>) => Spell<DocOf<To, N>>,
  ): Migration<From, To>;
  /** A `stylesheet(…)` document — its output must be the new row when it
   * is typed; a hand-written envelope is the honest top. A disposition or
   * a mode table cannot ride in a `jslt` step (`JL0102`). */
  transform<N extends DeclaredNames<To>, S extends StylesheetLike>(
    name: N,
    stylesheet: S & SheetFor<S, DocOf<To, N>>,
  ): Migration<From, To>;
  /** A rules array: a typed first rule must produce the new row; a
   * hand-written rule is the honest top. */
  transform<N extends DeclaredNames<To>, const R extends readonly RuleDocument[]>(
    name: N,
    rules: R & RulesFor<R, DocOf<To, N>>,
  ): Migration<From, To>;
  /** A `query` step over `name`'s rows: the predicate names the VIOLATION
   * (`expect: 'empty'`, the default) or the witness (`'ebv'`); the row is
   * the members the two shapes share, annotated when one shape is meant. */
  assert<N extends DeclaredNames<To>, V extends ExprBase<unknown> = MemberExpr<DocOf<From, N> | DocOf<To, N>>>(
    name: N,
    predicate: (row: V) => BoolExpr | boolean,
    options?: AssertOptions,
  ): Migration<From, To>;
  /** A query document over the rows, verbatim. */
  assert<N extends DeclaredNames<To>>(name: N, query: Json, options?: AssertOptions): Migration<From, To>;
  /** A backfill of stored derived columns (`derive`, §2.1). */
  derive<N extends DeclaredNames<To>>(name: N, columns: readonly DeriveColumn[]): Migration<From, To>;
  /** Any planner-emitted step, verbatim — the escape that keeps `rebuild` authorable. */
  step(raw: MigrationStep): Migration<From, To>;
  readonly document: MigrationDocument;
  toJSON(): MigrationDocument;
}

export interface MigrationSpec<From, To> {
  readonly id: string;
  /** The model the store is at: a model document (the pen's or a JSON snapshot). */
  readonly from: From;
  /** The model the code carries. */
  readonly to: To;
  readonly note?: string;
}

/** A migration between two model documents; `from`/`to` are their shape hashes. */
export function defineMigration<From extends object, To extends object>(spec: MigrationSpec<From, To>): Migration<From, To>;

/** A planner's document, taken up so a typed `transform` replaces the
 * draft it left; `from`/`to` type the transforms and are checked against
 * the document's hashes (`JL0102` when they are not the planned models). */
export function fromPlanned<From = unknown, To = unknown>(
  document: MigrationDocument | Json,
  options?: { readonly from?: From; readonly to?: To },
): Migration<From, To>;
