// @jarenjs/linq/migration — the type half: a transform is typed from the
// two model documents' phantoms — the OLD row is what the callback sees,
// the NEW row is what its result must spell (a dropped, mistyped or
// foreign member does not compile; the honest top is admitted where a
// precise value is, because the validator judges at run time); from a
// JSON snapshot the row is the honest top, annotated when a shape is
// meant; a table name is one the target declares; a stylesheet's output
// must be the new row; an assertion's row is the members both shapes
// share. The runtime twins live in test/linq/migration-pen.test.js.
import { defineMigration, fromPlanned } from '@jarenjs/linq/migration';
import type { DocOf, Migration, MigrationDocument, MigrationStep, Spell } from '@jarenjs/linq/migration';
import { stylesheet, rule } from '@jarenjs/linq/jslt';
import type { Expr, UnknownExpr } from '@jarenjs/linq';
import { model as v1 } from '../db/fixtures/models/v1.js';
import { model as v2 } from '../db/fixtures/models/v2.js';

/** Identical types, in both directions — the strict check, not assignability. */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

type OldUser = DocOf<typeof v1, 'User'>;
type NewUser = DocOf<typeof v2, 'User'>;
const oldUser: Equals<OldUser, { id: string; name: string; age?: number }> = true;
const newUser: Equals<NewUser, { id: string; name: string; age?: number; handle: string; bio?: string }> = true;
void [oldUser, newUser];

// ——— the typed transform: the old row in, the new row out ———
const handles = defineMigration({ id: '0002-handles', from: v1, to: v2 })
  .ddl('ALTER TABLE "User" ADD COLUMN "handle" TEXT')
  .transform('User', (u, x) => ({ id: u.id, name: u.name, age: u.age, handle: u.name.lower(), bio: x.path }))
  .assert('User', (u) => u.name.isEmpty());
const doc: MigrationDocument = handles.document;
const steps: readonly MigrationStep[] = doc.steps;
void [doc, steps];
// @ts-expect-error — the value is the OLD row: `handle` is v2's, not v1's
void defineMigration({ id: 'x', from: v1, to: v2 }).transform('User', (u) => ({ id: u.id, name: u.name, handle: u.handle }));
// @ts-expect-error — a result that drops a required member of the NEW row
void defineMigration({ id: 'x', from: v1, to: v2 }).transform('User', (u) => ({ id: u.id, name: u.name }));
// @ts-expect-error — a member of the wrong type
void defineMigration({ id: 'x', from: v1, to: v2 }).transform('User', (u) => ({ id: u.id, name: u.name, handle: u.age }));
// a member the new row does not have: caught on a direct annotation of the
// spelling — a contextually typed callback result is not excess-checked by
// TypeScript, so there the closed target schema refuses it at run time
declare const spelt: Expr<OldUser>;
// @ts-expect-error — `nick` is not a member of v2's row
const extra: Spell<NewUser> = { id: spelt.id, name: spelt.name, handle: spelt.name, nick: spelt.name };
void extra;
// @ts-expect-error — a table the target model does not declare
void defineMigration({ id: 'x', from: v1, to: v2 }).transform('Post', (u) => u);
// the identity spells a widening; a narrowing does not compile
void defineMigration({ id: 'x', from: v1, to: v1 }).transform('User', (u) => u);
// @ts-expect-error — v1's row lacks v2's required `handle`
void defineMigration({ id: 'x', from: v1, to: v2 }).transform('User', (u) => u);
// the honest top is admitted where a precise value is: the validator judges at run time
void defineMigration({ id: 'x', from: v1, to: v2 }).transform('User', (u) => ({ id: u.id, name: u.name, handle: u.get('legacyHandle') }));

// ——— a stylesheet's output must be the new row; a hand-written rules array is the honest top ———
const sheet = stylesheet([rule('$', (u: Expr<OldUser>) => ({ id: u.id, name: u.name, age: u.age, handle: u.name.lower() }))]);
void defineMigration({ id: 'x', from: v1, to: v2 }).transform('User', sheet);
// @ts-expect-error — the stylesheet's output lacks `handle`
void defineMigration({ id: 'x', from: v1, to: v2 }).transform('User', stylesheet([rule('$', (u: Expr<OldUser>) => ({ id: u.id, name: u.name }))]));
void defineMigration({ id: 'x', from: v1, to: v2 }).transform('User', { $jslt: '0.1', rules: [{ match: '$', body: { id: '$.id' } }] });
void defineMigration({ id: 'x', from: v1, to: v2 }).transform('User', [{ match: '$', body: { id: '$.id' } }]);
void defineMigration({ id: 'x', from: v1, to: v2 }).transform('User', []);
// @ts-expect-error — a typed rule whose output is not the new row
void defineMigration({ id: 'x', from: v1, to: v2 }).transform('User', [rule('$', (u: Expr<OldUser>) => ({ id: u.id }))]);

// ——— from a JSON snapshot: the row is the honest top, annotated when a shape is meant ———
declare const snapshot: { $model: '0.1'; entities: Record<string, unknown> };
void defineMigration({ id: 'x', from: snapshot, to: v2 }).transform('User', (u) => {
  const top: Equals<typeof u, UnknownExpr> = true;
  void top;
  return { id: u.get('id'), name: u.get('name'), handle: u.get('name').lower() };
});
void defineMigration({ id: 'x', from: snapshot, to: v2 }).transform('User', (u: Expr<OldUser>) => ({ id: u.id, name: u.name, handle: u.name.lower() }));
// a JSON target admits any table and any row
void defineMigration({ id: 'x', from: v1, to: snapshot }).transform('Anything', (u) => ({ whatever: u.get('name') }));

// ——— fromPlanned: the models type the transforms; without them the honest top ———
declare const planned: MigrationDocument;
void fromPlanned(planned, { from: v1, to: v2 }).transform('User', (u) => ({ id: u.id, name: u.name, handle: u.name.lower() }));
// @ts-expect-error — the models type the transform here too
void fromPlanned(planned, { from: v1, to: v2 }).transform('User', (u) => ({ id: u.id }));
void fromPlanned(planned).transform('users', (u) => ({ anything: u.get('x') }));

// ——— assert: the members the two shapes share; annotate for one shape ———
void defineMigration({ id: 'x', from: v1, to: v2 }).assert('User', (u) => u.name.isEmpty());
// @ts-expect-error — `handle` is only in v2; the shared members type the row
void defineMigration({ id: 'x', from: v1, to: v2 }).assert('User', (u) => u.handle.isEmpty());
void defineMigration({ id: 'x', from: v1, to: v2 }).assert('User', (u: Expr<NewUser>) => u.handle.isEmpty(), { expect: 'empty' });
// @ts-expect-error — expect is one of two
void defineMigration({ id: 'x', from: v1, to: v2 }).assert('User', (u) => u.name.isEmpty(), { expect: 'none' });

// ——— the surface, named ———
const typed: Migration<typeof v1, typeof v2> = handles;
void typed;
