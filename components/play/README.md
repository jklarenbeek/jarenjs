# @jarenjs/play

**A JSON-engine playground — understand an engine before you compose it.**

Pick an engine (JSONPath, JSON Pointer, JSON Patch, `$query`, JSLT,
markdown, mermaid, a `$contract` document, a JSON Schema emitted as
TypeScript, a fluent `@jarenjs/linq` chain, …), feed it a source input and
one or more datasets from a curated example library, and watch it run. Where `@jarenjs/studio` is for
building an application out of many files, `@jarenjs/play` is for
learning one engine standalone — a reference bench you experiment on first.

Two layers, the suite's convention:

- **the engine** (`@jarenjs/play`) — headless: an engine registry, a
  curated example library, and a pure `runExample(engineId, source, data)
  → { ok, panels, timing, error }`. Wraps the real shipped compilers; knows
  nothing of the DOM.
- **the component** (`@jarenjs/play/component`) — the playground UI, a
  `createPlayComponent()` factory (like `@jarenjs/calc`): a JSLT view
  (example rail, source editors, a dataset switcher, the run stage) the
  host composes.
- **the host kit** (`@jarenjs/play/host`) — what an embedding host
  composes around the component instead of writing it: the JSON Schema
  runner for the `validate` seam, the language catalogs loaded through the
  host's own `import()`s, the play slice and its reader-language rules, the
  session file and the generated form's actions
  ([Hosting play](#hosting-play)).

Play is a **student tool**: it opens calm — one clean result per run — and
drills deeper on demand. An engine's rich explainers (match cards, the
compiled program, a geometry-free AST, a canonical round-trip) are `deep`
result panels behind a quiet **"Explain ▸"** depth toggle: revealed beside
the answer on desktop, as a full-pane swap with a ← back on a phone. And
when a run fails, the error says **where**: the editor it is about is
marked invalid and its label carries the compiler's own location — the
rule of the stylesheet (`at /rules/0/match`), the token of the selector
(`at position 7`), the line of the document (`at line 2, column 5`) — so
the learner is pointed at the text to fix, not just told it is wrong
([PLAY-FORMAT §2](./docs/PLAY-FORMAT.md#2-the-result)).

## The model

An engine's inputs are heterogeneous — a selector needs one JSON document,
a patch needs a target, markdown needs no data at all. Each engine is a
**descriptor** (the panes it consumes + a pure `run`); each **example**
presets those panes plus a **list of datasets**:

```js
{ engine: 'path',
  source:   { selector: '$.store.book[*].title' },
  datasets: [ { label: 'store',   data: { data: '{ … }' } },
              { label: 'catalog', data: { data: '{ … }' } } ] }
```

The datasets list length is the whole story: **0** → the engine takes no
data (markdown/mermaid); **1** → one dataset; **N** → a switcher that runs
the *same* source over each shape. Adding an engine is a descriptor plus
examples — the picker, panes and switcher all derive from the descriptor.
An engine's option selects (a chart definition's notation, a patch's mode,
a kernel) carry what a switch does to the source, so a switch leaves source
the new choice runs: `switchOption` converts the chart definition, writes
the same change in the new patch mode, or loads the chosen kernel's example.
See [docs/PLAY-FORMAT.md](docs/PLAY-FORMAT.md) for descriptors and results,
and [ARCHITECTURE.md](ARCHITECTURE.md) for the state, action and run-loop
contract an embedding host supplies. Query, JSLT, JTLT and XQuery expose
an editable JSON externals pane; the JSON Schema engine an editable
referenced-schemas pane, so a schema can `$ref` another by `$id`. The Emit
engine takes a schema and no data: it compiles the schema to the type model
`@jarenjs/emit` publishes and renders it as TypeScript declarations or a
Markdown reference (the model rides behind the depth toggle), with option
selects for the target, open or closed objects, and the normalizer that makes
the accepted and normalized types differ.

Three engines show what the other packages are made of. The LINQ engine
reads a fluent `@jarenjs/linq` chain — `from(data).where((u) =>
u.age.gt(21)).orderBy((u) => u.name)` — as text, without `eval`, replays
it against the real chain and shows the query document it compiles to
beside that document's answer: the document is the thing a model learns to
author, and a JavaScript operator the chain cannot capture (`u.age > 21`)
is refused at its position, naming `.gt()`. The JSONX engine reads JSONX
(bigint, regexp, datetimes, `inf`/`nan`) as the JSON another engine's data
pane takes, and names each value JSON writes differently. The kernels
engine calls the `@jarenjs/core` geo, date, math and text functions the
`$query` operators run, over a JSON array of arguments, and drills down
into the operator document that runs the same kernel and whether the two
answers agree — compared only when both doors answer: where one refuses the
arguments (its code) or answers nothing (the kernel's `null`, the
operator's empty sequence) the card says so instead (`not compared —
$query refuses with JQ2001`).

Every word the playground writes is a message id of `playMessagesEn`
(`play/action/save`, `play/panel/output`, `play/where/root`, …): pass a
compiled locale catalog as `messages` to `runExample`, to
`createPlayComponent`, or to `viewModel(state, { messages })`, and the
chrome, the result panels and the playground's own refusals speak it, with
English for any id it lacks ([PLAY-FORMAT §5](./docs/PLAY-FORMAT.md#5-host-injected-seams-the-dependency-light-contract)).

Answers that changed (upgrade notes): the JSON Schema engine's `Messages`
choices are English followed by `@jarenjs/locales`' `LOCALE_NAMES`, in that
list's order (Português now before Deutsch), and so are its per-language
examples; the engine's `lead` line renders with `lang="en"`. A host `validate` runner now receives a
fourth argument, the parsed referenced schemas (`[]` when the pane is empty),
and must register them before compiling; a runner that ignores it still
answers as before. `runExample` answers `unknown engine` for
an id every object inherits (`constructor`, `__proto__`, `toString`), where it
failed with `engine.run is not a function`; a timing that is `NaN` or infinite
prints a dash, where it printed `NaN ms`. The JOSL engine's streaming-events
table writes each path as a JSON Pointer, `~` and `/` in a key escaped
(`/a~1b` for the key `a/b`), where it printed `/a/b`, the pointer of a
nested member. The kernels card's `Same answer` reads `not compared — …`
where one door refuses or answers nothing (`geohashEncode` without a
precision, an invalid I-Regexp), where it read `no`; an I-Regexp pattern
`null` or an array is no I-Regexp (`null`), as a number already was, where
it failed with a property-read `TypeError`.

## Hosting play

The website's `#/play` is a host built from `@jarenjs/play/host`; another
host composes the same pieces. Each is a pure function over JSON, with no
DOM, storage or bundler in it:

```js
import { createPlayComponent } from '@jarenjs/play/component';
import {
  createPlayCatalogs, createPackRequester, createPlayValidator, playDataForm,
  PLAY_START, loadExample, withPlayLocale, runPlay, switchPlayOption, sessionOf,
  playFormActions, PLAY_FORM_VIEW,
} from '@jarenjs/play/host';
import { stringFormats, numberFormats, dateTimeFormats, jsonFormats } from '@jarenjs/formats';
import { buildFormModel, buildFormViewModel, formChromeLabels } from '@jarenjs/forms';
import { FORM_NUMBER_VALUE, createFormView } from '@jarenjs/app';

// 1. The languages: the host's own loader, one literal import() per pack,
//    so a bundler splits one chunk per language and English loads none.
const LOADERS = { de: () => import('@jarenjs/locales/de').then((m) => m.de) };
const catalogs = createPlayCatalogs();
const packs = createPackRequester({
  catalogs,
  load: async (code) => (Object.hasOwn(LOADERS, code) ? LOADERS[code]() : null),
  onLoaded: (code) => console.log(`loaded ${code}`), // re-render and re-run here
});

// 2. The validator seam, and the component that runs through it.
const validator = createPlayValidator({
  catalogs,
  formats: [stringFormats, numberFormats, dateTimeFormats, jsonFormats],
  forms: { buildFormModel, buildFormViewModel, formChromeLabels },
});
const play = createPlayComponent({ validate: validator.validate });

// 3. A slice, run in the reader's language.
let lang = 'de';
let slice = { ...PLAY_START, ...loadExample('validate-invalid') };
await packs.request([lang]);                             // loaded de
const result = await runPlay(play, slice, { lang, catalogs });
result.ok;                                               // true
result.panels.map((p) => p.id);                          // ['errors', 'verdict']

/** @type {import('@jarenjs/play/host').PlayValidationReport} */
const report = validator.validate(slice.source.schema, JSON.parse(slice.data.data), lang, []);
report.valid;                                            // false
report.errors[0].message;                                // 'darf nicht weniger als 2 Zeichen enthalten'

// 4. The generated form, mounted beside the component's view model, in the
//    language the slice runs in; its view rules read it there.
const form = playDataForm(validator, withPlayLocale({ ...slice, dataView: 'form', dataValue: {} }, lang));
form.formLabels.addItem;                                 // 'Element hinzufügen'
const ui = { play: { ...play.viewModel({ play: slice }, { messages: catalogs.catalogFor(lang) }), ...form } };
const formRules = createFormView(PLAY_FORM_VIEW).map((rule) => ({ ...rule, mode: play.mode }));
const actions = playFormActions({ numberValue: FORM_NUMBER_VALUE }); // merged into the app's actions
Object.keys(actions).length;                             // 6

// 5. The reader picks a language on the Messages pane: it becomes theirs.
const picked = switchPlayOption(slice, 'locale', 'fr');
slice = { ...slice, ...picked };
lang = picked.lang ?? lang;                              // 'fr'
sessionOf(slice).config;                                 // {} (a session carries no language)
```

How to read it:

- **Languages.** `createPlayCatalogs()` keeps each loaded `@jarenjs/locales`
  pack compiled. `createPackRequester` asks the host's `load` for each
  language not yet loaded, once, and asks a failed one again only when the
  set of languages needed changes. The kit names no pack, so the host's
  bundler decides the chunks.
- **Validation.** `createPlayValidator` is the `validate` seam of
  [PLAY-FORMAT §5](./docs/PLAY-FORMAT.md#5-host-injected-seams-the-dependency-light-contract).
  It registers the referenced schemas before compiling, locates a broken one
  at the `schemas` pane, and keeps the parser's words (`schemaJsonReason`) for
  a host to word an unreadable schema in its reader's language. It localizes
  over copies and keeps the text a schema wrote (`inlineMessage`). It keeps
  the last compile hot, so `run`, `formView` and `formLabels` share it. The
  format sets and the form functions are the host's to hand in, so a host
  that renders no form imports no forms code.
- **The reader's language.** Only the reader sets it: `switchPlayOption` on
  the `locale` pane answers `lang`, and the host makes that its language.
  `withPlayLocale` (inside `runPlay`) runs every engine with a locale option
  in it. An example made to show one language (`loadExample` answers its
  `exampleLocale`) shows it for its own run. A session never carries a
  language (`sessionOf`), and a host that opens one clears `exampleLocale`.
- **Input guards.** `sessionToLoaded` and `sessionFromDocument` read a share
  token or file as safe defaults. `blankSession` and `withPlayLocale` look an
  engine up only by its own name, never by one every object inherits.
- **The generated form.** `playDataForm` answers `{ dataForm, formLabels }`
  for the validate engine's form pane, in the language the slice runs in (an
  example made to show one keeps it). `PLAY_FORM_VIEW` is the
  `createFormView` options that read them at `ui.play` and write through
  `playFormActions`.
- **Number text.** `playFormActions` writes a number control through the
  number expression the host hands in. Pass `@jarenjs/app`'s
  `FORM_NUMBER_VALUE`, so `.5`, `-.5` and `01` read as the standard form
  actions read them.

The example's other imports are the host's own:
`npm install @jarenjs/formats @jarenjs/forms @jarenjs/app` beside
`@jarenjs/play`. A host that renders no generated form needs only
`@jarenjs/play`.

## Exports

Every subpath a consumer can import, derived from the manifest by
`npm run docs:derive` (`npm run docs:check` fails when the two drift):

<!--fact:exports.play-->
| Import | Kind | Declarations |
|---|---|---|
| `@jarenjs/play` | JavaScript | declared |
| `@jarenjs/play/component` | JavaScript | declared |
| `@jarenjs/play/host` | JavaScript | declared |
| `@jarenjs/play/styles/play.css` | asset | — |
| `@jarenjs/play/package.json` | metadata | — |
<!--/fact-->

## Install

```
npm install @jarenjs/play
```

Zero third-party runtime dependencies — only other `@jarenjs/*` packages.
Node ≥ 24, ESM.
