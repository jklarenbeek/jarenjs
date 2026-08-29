// @jarenjs/linq/app and /forms — the type half. An app document carries
// the state shape and the declared action names as phantoms, so
// StateOf<> and ActionsOf<> read them back and bind<Action>('nope') does
// not compile. An action's payload is typed by its own declaration and
// its state by annotation (action() is evaluated before defineApp() sees
// the state builder); a form rule's document is typed the same way. The
// runtime twins live in test/linq/app-pen.test.js and forms-pen.test.js.
import {
  action, add, append, bind, defineApp, effect, remove, replace, sub, transition,
} from '@jarenjs/linq/app';
import type {
  ActionScope, ActionsOf, AppDocument, AppResult, Binding, EffectDeclaration, PatchOp,
  StateOf, SubDeclaration,
} from '@jarenjs/linq/app';
import { rule } from '@jarenjs/linq/jslt';
import * as s from '@jarenjs/linq/schema';
import type { Expr } from '@jarenjs/linq';
import type { Infer } from '@jarenjs/linq/schema';
import { JarenValidator } from '@jarenjs/validate';
import * as f from '@jarenjs/linq/forms';
import { assertOnSubmit, FormNeverBuilder } from '@jarenjs/linq/forms';
import type { RuleContext } from '@jarenjs/linq/forms';

/** Identical types, in both directions — the strict check, not assignability. */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

// ——— the state is a schema, and the app carries its shape ———
const State = s.object({
  todos: s.array(s.object({ text: s.string(), done: s.boolean().default(false) })).default([]),
  draft: s.string().default(''),
});
type State = Infer<typeof State>;

const Payload = s.object({ text: s.string() });

const todo = defineApp({
  state: State,
  view: [rule('$', (v: Expr<State>) => ['main', {},
    ['button', { on: { click: bind<Action>('todo/add', { payload: { text: v.draft } }) } }, 'add'],
    ['button', { on: { click: 'todo/clear' } }, 'clear'],
  ])],
  actions: {
    'todo/add': action((st: Expr<State>, x) => transition({
      patch: [append((c: Expr<State>) => c.todos, { text: x.payload.text, done: false })],
    }), { payload: Payload }),
    'todo/toggleAt': action((st: Expr<State>, x) => transition({
      patch: [replace((c: Expr<State>, y: ActionScope<{ i: number }>) =>
        c.todos.at(y.payload.i).done, true)],
    })),
    'todo/clear': action(() => transition({
      patch: [replace('/todos', [])],
      effects: [effect('save', { where: 'disk' })],
    })),
  },
  subs: [sub('interval', {
    with: { ms: 1000, tick: 'todo/clear' },
    when: (st: Expr<State>) => st.todos.all().count().gt(0),
  })],
});

type Action = 'todo/add' | 'todo/toggleAt' | 'todo/clear';

const stateShape: Equals<StateOf<typeof todo>, State> = true;
const actionNames: Equals<ActionsOf<typeof todo>, Action> = true;
const asDocument: AppDocument<State, Action> = todo.document;
void [stateShape, actionNames, asDocument];

// the document and the schema are two members, never merged
const document: AppDocument<State, Action> = todo.document;
const schema: unknown = todo.stateSchema;
// @ts-expect-error — the state schema is not a member of the document
const merged = todo.document.stateSchema;
void [document, schema, merged];

// ——— the state schema is typed by the OVERLOAD that answered it ———
// `defineApp({ state: <builder> })` can never answer null, so the one
// line every consumer writes — the line APP-PEN.md §5 shows — compiles
// with no narrow and no cast. It did not until AppResult carried the
// schema slot as its third phantom: one `JsonSchema | boolean | null`
// served all three overloads, and `null` is not a schema to compile.
const validateState = new JarenValidator().compile(todo.stateSchema);

// the overload with NO schema answers exactly `null`, and that is what a
// consumer has to handle — the union is not smeared across all three
const stateless = defineApp({ state: { n: 1 }, view: [] });
const noSchema: Equals<typeof stateless.stateSchema, null> = true;
// @ts-expect-error — there is no schema to compile on this overload
new JarenValidator().compile(stateless.stateSchema);
// a `schema:` beside a plain state puts one back
const beside = defineApp({ state: { n: 1 }, schema: s.object({ n: s.integer() }), view: [] });
const besideSchema: unknown = new JarenValidator().compile(beside.stateSchema);
// AppResult<State, Actions> still names any result, the slot defaulted
const anyResult: AppResult<unknown, string> = stateless;
void [validateState, noSchema, besideSchema, anyResult];

// ——— an action's payload is typed by its own declaration ———
const typedPayload = action((st: Expr<State>, x: ActionScope<Infer<typeof Payload>>) => transition({
  patch: [append((c: Expr<State>) => c.todos, { text: x.payload.text, done: false })],
}), { payload: Payload });
void typedPayload;

action((st: Expr<State>, x: ActionScope<Infer<typeof Payload>>) => transition({
  // @ts-expect-error — the payload declares `text`, not `title`
  patch: [append((c: Expr<State>) => c.todos, { text: x.payload.title, done: false })],
}), { payload: Payload });

action((st: Expr<State>) => transition({
  // @ts-expect-error — the state declares `todos`, not `items`
  patch: [replace((c: Expr<State>) => c.items, [])],
}));

// ——— an event field the binding requested is bound on $event ———
const withFields = action((st: Expr<State>, x) => transition({
  state: x.event.shiftKey,
}), { event: ['shiftKey', 'ctrlKey'] as const });
void withFields;

action((st: Expr<State>, x) => transition({
  // @ts-expect-error — only the default slice and the requested fields are bound
  state: x.event.altKey,
}), { event: ['shiftKey'] as const });

// ——— a bind() to an undeclared action does not compile ———
const good: Binding<Action> = bind<Action>('todo/add');
// @ts-expect-error — 'nope' is not one of the declared action names
const bad = bind<Action>('nope');
// @ts-expect-error — the same, read back off the app itself
const alsoBad = bind<ActionsOf<typeof todo>>('nope');
void [good, bad, alsoBad];

// ——— the pieces are what they say they are ———
const op: PatchOp = add('/a', 1);
const dropped: PatchOp = remove('/a');
const fx: EffectDeclaration<'save'> = effect('save');
const entry: SubDeclaration<'interval'> = sub('interval', { with: { ms: 10 } });
const fxName: Equals<typeof fx.run, 'save'> = true;
void [op, dropped, fx, entry, fxName];

// @ts-expect-error — transition() takes state, patch and effects, nothing else
transition({ nope: 1 });
// @ts-expect-error — a subscription's `with` is verbatim data, never a callback
sub('interval', { with: () => 1 });

// ——— the forms pen: a rule survives every chained method ———
const Invoice = f.object({
  company: f.string().optional(),
  vatId: f.string().optional().form<Doc>({
    visible: (c) => c.root.company.ne(''),
    assert: (c) => c.root.company.eq('').or(c.value.ne('')),
    message: 'VAT id is required for companies',
  }),
  lines: f.array(f.object({
    amount: f.number().form<Doc>({ assert: (c) => c.value.gt(0), message: 'positive' }),
  })).default([]),
});
type Doc = { company?: string; vatId?: string; lines: { amount: number }[] };

const invoiceShape: Equals<Infer<typeof Invoice>, {
  company?: string; vatId?: string; lines: { amount: number }[];
}> = true;
void invoiceShape;

// a rule is an ANNOTATION: the inferred shape is the schema pen's
const plain = s.object({ company: s.string().optional() });
const annotationOnly: Equals<Infer<typeof plain>, { company?: string }> = true;
void annotationOnly;

const submit: unknown = assertOnSubmit(Invoice);
void submit;

// @ts-expect-error — `preview` is derived from the field's format, never authored
f.string().form({ preview: { kind: 'map' } });
// @ts-expect-error — x-form is the pen's keyword; spell it through form()
f.string().meta({ 'x-form': { visible: '$.a' } });

f.string().form<Doc>({
  // @ts-expect-error — the document declares `company`, not `firm`
  visible: (c: RuleContext<Doc, string>) => c.root.firm.ne(''),
});

// ——— the declared surface and the runtime surface are one set ———
// FormNeverBuilder is a VALUE the forms pen really exports; it had no
// declaration until the census in test/linq/types.test.js held the two
// halves equal for every pen.
const isFormNever: boolean = f.never() instanceof FormNeverBuilder;
void isFormNever;

// never() ANSWERS the class the runtime builds — no cast — so the rule
// vocabulary it refuses at run time does not compile either. It used to
// be declared FormBuilder<never, never>, which carries form().
const formNever: FormNeverBuilder = f.never();
// @ts-expect-error — `false` carries no `x-form`; JL0102 at run time
f.never().form({ visible: (c) => c.value });
// @ts-expect-error — and no annotation of any name
f.never().meta({ deprecated: true });
// nullable() widens the node and hands back this pen's base builder,
// where both are legal again — the remedy the refusal names, under test
const widenedNever: unknown = f.never().nullable().form({ visible: (c) => c.value }).schema;
void [formNever, widenedNever];

// ——— a conditional carries a rule like any other node ———
// buildFormModel reads `x-form` off whatever schema it builds a field
// for, so a when() used as a MEMBER answers a field whose rules
// evaluate; FormWhenBuilder declared then()/else() and not form().
const gated = f.object({
  kind: f.string(),
  gate: f.when(f.object({ kind: f.literal('a') })).then(f.object({ extra: f.string() }))
    .form<{ kind: string }>({ visible: (c) => c.root.kind.eq('a'), message: 'gated' }),
});
// @ts-expect-error — x-form is the pen's keyword here too, not meta()'s
f.when(f.string()).meta({ 'x-form': { visible: '$.a' } });
void gated;
