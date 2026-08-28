// @jarenjs/linq/jslt — the type half: a body's value is typed by the
// annotated first argument or by the rule's schema-pen match, its output
// is the unwrapped return with every apply() the honest top; root and
// path need no declaration; a declared parameter types through the
// annotated second argument exactly as params() types p, and an
// undeclared one does not compile; Stylesheet<In, Out> carries the first
// rule's phantoms, or the author's. The runtime twins live in
// test/linq/jslt-pen.test.js.
import { body, apply, op, rule, stylesheet } from '@jarenjs/linq/jslt';
import type { BodyDocument, Externals, Input, Output, Rule, Stylesheet } from '@jarenjs/linq/jslt';
import type { Expr, DateTime } from '@jarenjs/linq';
import * as s from '@jarenjs/linq/schema';
import type { Infer } from '@jarenjs/linq/schema';

/** Identical types, in both directions — the strict check, not assignability. */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

interface Chapter { heading: string }
interface Book { isbn: string; title: string; chapters: Chapter[]; published: DateTime }
interface Item { sku: string; price: number }

// ——— body(): the value by annotation, the output unwrapped, apply() the honest top ———
const bookBody = body((v: Expr<Book>) => ({
  title: v.title.upper(),
  year: v.published.year(),
  children: [apply(v.chapters.all())],
  n: apply(v.chapters.all()).count(),
}));
const bookIn: Equals<Input<typeof bookBody>, Book> = true;
const bookOut: Equals<Output<typeof bookBody>, { title: string; year: number; children: unknown[]; n: number }> = true;
const asDoc: BodyDocument<Book, { title: string; year: number; children: unknown[]; n: number }> = bookBody;
// an unannotated body is the honest top on both sides
const wide = body((v) => ({ any: v.get('whatever').get('deep'), all: v.all().sum() }));
const wideIn: Equals<Input<typeof wide>, unknown> = true;
const wideOut: Equals<Output<typeof wide>, { any: unknown; all: number }> = true;
// a scalar body
const scalar = body((v: Expr<Item>) => v.price.mul(1.21));
const scalarOut: Equals<Output<typeof scalar>, number> = true;
void [bookIn, bookOut, asDoc, wideIn, wideOut, scalarOut];

// ——— the externals: root and path need no declaration; a parameter is declared and typed through x ———
void body((v: Expr<Item>, x) => ({ sku: v.sku, at: x.path.length(), root: x.root }));
void body((v: Expr<Item>, x: Externals<{}, Book>) => ({ isbn: x.root.isbn.upper(), me: v.sku }));
const priced = body(
  (v: Expr<Item>, x: Externals<{ rate: number }>) => ({ amount: v.price.mul(x.rate), currency: x.root }),
  { externals: ['rate'] });
const pricedOut: Equals<Output<typeof priced>, { amount: number; currency: unknown }> = true;
// a declared name without an annotation is the honest top on x
void body((v: Expr<Item>, x) => ({ amount: x.rate.mul(v.price) }), { externals: ['rate'] });
void [pricedOut];

// ——— rule(): the schema-pen match types the value; a body document carries its phantoms ———
// (closed builders: an open() object's members are the honest top on the chain, as ofType() reads them)
const Book = s.object({ isbn: s.string(), title: s.string(), chapters: s.array(s.object({ heading: s.string() })) });
const ChapterS = s.object({ heading: s.string() });
const bookRule = rule({ schema: Book }, (v) => ({ title: v.title, children: [apply(v.chapters.all())] }));
const bookRuleIn: Equals<Input<typeof bookRule>, Infer<typeof Book>> = true;
const bookRuleOut: Equals<Output<typeof bookRule>, { title: string; children: unknown[] }> = true;
const chapterRule = rule({ schema: ChapterS }, (v) => ({ name: v.heading }));
const chapterOut: Equals<Output<typeof chapterRule>, { name: string }> = true;
// a callback rule may annotate its value too; a path match alone is the honest top
const annotated = rule('$.items[*]', (v: Expr<Item>) => ({ sku: v.sku }));
const annotatedIn: Equals<Input<typeof annotated>, Item> = true;
const wideRule = rule('$..price', (v) => v.mul(1.21));
const wideRuleIn: Equals<Input<typeof wideRule>, unknown> = true;
const wideRuleOut: Equals<Output<typeof wideRule>, unknown> = true;
// a body() document hands its phantoms to the rule; an untyped body takes the match's
const fromBody = rule(null, bookBody, { mode: 'render', priority: 2 });
const fromBodyIn: Equals<Input<typeof fromBody>, Book> = true;
const fromMatch = rule({ schema: Book }, body((v) => v.get('title')));
const fromMatchIn: Equals<Input<typeof fromMatch>, Infer<typeof Book>> = true;
const fromMatchOut: Equals<Output<typeof fromMatch>, unknown> = true;
// a hand-written body: nothing is inferred
const hand: Rule<unknown, unknown> = rule('$', { $mul: ['$', 2] });
void [bookRuleIn, bookRuleOut, chapterOut, annotatedIn, wideRuleIn, wideRuleOut, fromBodyIn, fromMatchIn, fromMatchOut, hand];

// ——— stylesheet(): the FIRST rule's phantoms, or the author's ———
const sheet = stylesheet([bookRule, chapterRule], { unmatched: 'share', modes: { toc: { unmatched: 'error' } } });
const sheetIn: Equals<Input<typeof sheet>, Infer<typeof Book>> = true;
const sheetOut: Equals<Output<typeof sheet>, { title: string; children: unknown[] }> = true;
const ok: Stylesheet<Infer<typeof Book>, { title: string; children: unknown[] }> = sheet;
// the acceptance pin: a body returning { name: v.heading } types Out as { name: string } …
const chapters = stylesheet([chapterRule]);
const chaptersOut: Equals<Output<typeof chapters>, { name: string }> = true;
const chaptersOk: Stylesheet<Infer<typeof ChapterS>, { name: string }> = chapters;
// … and the stylesheet is not a Stylesheet<In, { name: number }>
// @ts-expect-error — the output phantom is the rule's, and it says string
const chaptersBad: Stylesheet<Infer<typeof ChapterS>, { name: number }> = chapters;
// the author's annotation wins where dispatch makes the output unknowable
const annotatedSheet = stylesheet<Book, { title: string; children: { name: string }[] }>([bookRule, chapterRule]);
const annotatedOut: Equals<Output<typeof annotatedSheet>, { title: string; children: { name: string }[] }> = true;
// the bare-array form is the rules themselves
const bare = [wideRule];
const bareOut: Equals<Output<(typeof bare)[0]>, unknown> = true;
void [sheetIn, sheetOut, ok, chaptersOut, chaptersOk, chaptersBad, annotatedOut, bareOut];

// ——— the negatives: each pinned so it FAILS the build if it ever starts compiling ———
// @ts-expect-error — an external the body did not declare
void body((v: Expr<Item>, x) => v.price.mul(x.rate));
// @ts-expect-error — the annotation names 'rate' but the declaration does not
void body((v: Expr<Item>, x: Externals<{ rate: number }>) => x.rate, { externals: ['limit'] });
// @ts-expect-error — a typed parameter takes its own kind
void body((v: Expr<Item>, x: Externals<{ rate: number }>) => x.rate.upper(), { externals: ['rate'] });
// @ts-expect-error — a body reads the shape it was written over
void body((v: Expr<Item>) => v.pirce);
// @ts-expect-error — the schema match types the value
void rule({ schema: Book }, (v) => v.titel);
// @ts-expect-error — a mode is a string
void rule('$', (v) => v, { mode: 1 });
// @ts-expect-error — a priority is a number
void rule('$', (v) => v, { priority: 'high' });
// @ts-expect-error — a disposition is one of three
void stylesheet([], { unmatched: 'copy' });
// @ts-expect-error — an operator name starts with $
void body((v: Expr<Item>) => op('npv', [v.price]));
// @ts-expect-error — a mode argument is a literal string, never an expression
void body((v: Expr<Book>) => [apply(v.chapters.all(), v.title)]);
