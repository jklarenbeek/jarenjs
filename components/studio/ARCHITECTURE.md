# @jarenjs/studio — architecture

## Two layers, one-way

`@jarenjs/studio` follows the suite's component convention: an **engine**
(`src/*`, headless) and a **component** (`src/component/*`, the IDE
widget). The boundary is one-way — the component imports the engine, never
the reverse.

Unlike a render-only component (`calc`/`md`/`mermaid`, whose engine sees
only `@jarenjs/core` + `@jarenjs/view`), the studio's engine is a
**validator / assembler**: it must know the suite's grammars, so it
imports `@jarenjs/{validate, json, app, flow, db}` (their schemas and
compilers) — but nothing of the DOM or `@jarenjs/app`'s runtime. It sits
near the top of the dependency arrow, just below the website; nothing it
imports imports it, so there is no cycle.

## The project is a thin envelope

The document (`jaren-project`, PROJECT-FORMAT.md) is `{ files, active,
layout }`. The envelope alone is schema-gated. Each file's `text` is
validated against **its own kind grammar at its own boundary** — there is
no composed meta-schema. That is the load-bearing decision: the published
`jaren-query`/`jaren-jslt` grammars are closed (their operators
enumerated), so a data query with a host-registered operator (`$npv`)
could never validate against one composed gate. Compiling each `jslt` /
`query` file *with the operator registry* accepts registered operators
and yields the engine's own coded errors with JSON Pointers — the honest
per-file boundary, not a shortcut.

## `classifyChange` — the reboot decision as data

The IDE's hardest UX problem is that re-booting a nested `@jarenjs/app` on
every edit destroys the running app's state. The engine keeps the *data*
for that decision headless and tested: `classifyChange(prev, next)`
compares a **structural key** — an `app` document minus its `state`, via
the suite's collision-free `semanticKey` — and reports `structural` / `state-only` /
`none` per artifact. The component's policy (hot-dispatch a state-only
edit, reboot a structural one) reads this; the split keeps the policy
thin and the datum proven.

## Assembly and file boundaries

`resolveProjectFile` follows explicit `imports`, substitutes absent named
members and records the dependency chain in `sourceFiles`. Cycles, missing
sources and conflicting definitions are coded refusals. `describe` validates
assembled artifacts and caches their validation inputs by immutable file-list
identity, so a typing-buffer or chrome render does not recompile a split app.
`writeProjectArtifact` disassembles edits back into source files; unchanged
files retain their identity and text. Renaming rewrites execution and import
references together.

Flow and model validation compiles or plans the document without acquiring
host capabilities. Host-proposed candidates use this same acceptance gate and must match the captured document revision before publication. The `/export` entry is a headless ZIP writer accepting runtime
assets from its host; it has no filesystem, fetch or DOM dependency.

## Files

- `src/project.js` — the model: `KINDS`, `LAYOUT_DEFAULT`, `parseProject`
  (envelope-gate + normalize), `fileOf`.
- `src/validate.js` — `validateFile`: per-kind dispatch; the composed app
  meta-schema + a headless render audit; jslt/query compiled with the
  operator packs. Memoized on the file's IDENTITY (a `createWeakCache`
  from `@jarenjs/core/cache`, keyed inside by registry): validating an
  app compiles its view and renders a frame, so re-deriving the view
  model per render would recompile the whole project — measured at ~110ms
  for a charts app, ~0.001ms cached. Files are immutable, so identity is
  a sound key; pass a fresh object to force a re-check.
- `src/assemble.js` — `assembleArtifacts`, `classifyChange`, `describe`.
- `src/errors.js` — `StudioError` on `@jarenjs/core`'s coded base;
  `STUDIO_CODES` (JS0001/JS0002/JS0003).
- `src/resolve.js` — import assembly, reference routing, rename and write-back.
- `src/skeletons.js` — the shared creation vocabulary and valid starter files.
- `src/export.js` — headless archive entry.
- `src/component/index.js` — `createStudioComponent`: composes the JSLT
  view + derivation + policies + engine surface into the shape a host
  mounts (`mode`, `rules`, `modes`, `viewModel`, `hostPolicy`,
  `reconcileBuffer`).
- `src/component/view.js` — the IDE as a JSLT view (one `project` mode,
  rules matched by absolute slice path `$.ui.project`): pen bar, file
  rail, editor + docked coded-error strip, run stage. The layout mode
  rides `data-mode`; a kind rides `data-badge`.
- `src/component/viewmodel.js` — `projectViewModel(state)`: the pure
  derivation from the engine (`describe`/`assemble`) — the rail, the
  active editor, the error strip, the stage (an app mount, a run result,
  or an inert note). The editor's value is the typing BUFFER reconciled
  against the committed text, never the committed text alone: the box is
  a CONTROLLED textarea, so whatever this derives is what the renderer
  reasserts after every settled pass, and deriving the (blur-deferred,
  therefore stale) file text would overwrite the user mid-keystroke.
- `src/component/host.js` — the two hard-problem policies, pure:
  `hostPolicy` (reboot vs. hot-update, from `classifyChange`) and
  `reconcileBuffer` (editor buffer ↔ document), both consumed live — the
  first by the stage widget, the second by the derivation above. A write
  arriving on a file whose buffer is dirty keeps the human's text and
  offers the incoming version as a conflict; neither side is dropped.
- `src/component/editor.js` — the baseline editor/rail vnode primitives +
  the concrete kind-badge map (colours in `styles/studio.css`).
- `styles/studio.css` — the three-mode grid, rail, editor, error strip,
  splitter, and the kind-badge palette (concrete blue/cyan/slate/green/
  amber constants — no purple/pink).
- `schemas/` — the `jaren-project` grammar + draft-07 twin.

## The live wiring (at the host)

The component is a factory, not a self-mounting widget: the host composes
its `rules`/`modes`/`viewModel` into the site document and registers the
DOM-touching widgets. The website mounts it live at
`#/project`:

- the **stage host** boots the active `app` file's assembled document as
  an isolated nested app, and applies the reboot-vs-hot-update policy —
  a structural change reboots, a state-only change hot-dispatches the new
  state with `app.setState` (a diff re-render, so the running app keeps
  scroll, focus and uncontrolled inputs — no reboot);
- the **edit loop** commits the last-good app mount, so an invalid edit
  keeps the previous frame on the stage. `layout.autorun: false` holds
  commits until Run; the toolbar toggle persists in the project layout;
- the **stage error** is the latest nested-app boot/runtime failure,
  displayed from `project.stageError` and cleared before a new boot;
- the **flow host** embeds the existing editor as a private app. Its local
  actions edit the assembled document; changes echo back without discarding
  selection or undo history. FSM document effects are logged, and DAG tasks
  come from the editor's local registry. Run generations and abort signals
  prevent a disposed run from publishing late output;
- the **model host** owns one private in-memory SQLite worker per model file.
  Explicit model references share that worker across queries. File switches
  stop subscriptions; project replacement, model deletion and app destruction
  release stores. Committed model/seed changes recreate them. The existing
  data operation contract supplies inserts, deletes, execution, explain and
  live streams. This host currently exposes collection operations;
- the **layout switcher** (pen bar) drives the three grid modes, and the
  drag **splitter** drives the grid's
  `--js-ratio` live and commits `layout.ratio` on pointer-up — also an
  ARIA `separator`, arrow-key resizable. It uses the vertical axis for
  stacked panes and restores the committed ratio on pointer cancellation.

The host's Download action serializes a complete `jaren-project` snapshot;
App JSON retains the separate single-app export. Neither includes transient
results, mounted runtime state or stage errors.

Offline ZIP adds a bundled standalone host. `generate-studio-offline.js`
builds it from the installed lockfile dependencies, copies local SQLite and
font assets and records their runtime versions. Browser tests unzip it,
serve it on localhost with external requests blocked and run an app and store
in Chromium, Firefox and WebKit. Authored external URLs remain the author's
responsibility; the exporter does not crawl them.

## One pane at a time on a phone

Below 1024 px the rail | editor | stage grid is one column showing a
single pane, picked by the `js-panebar` segmented bar — the suite's
one-pane protocol (DESIGN.md §5), which `@jarenjs/play` established and
all four studios now share. The live pane rides `data-pane` on `.jstudio`,
exactly as the layout mode rides `data-mode`, so the switch is one
attribute write and the stylesheet does the rest.

Three consequences are deliberate:

- **the panes stay mounted.** CSS hides them; the renderer never unmounts
  them. A hidden editor keeps its caret, its scroll and its typing buffer,
  and the nested app on a hidden stage keeps running rather than
  rebooting when the user comes back;
- **the splitter and the layout switcher are hidden there.** Both divide a
  screen showing two panes, and all three grid modes collapse to the same
  single column below the breakpoint, so neither has anything to do;
- **the pane is host chrome, not a project member.** It lives in the host's
  slice next to `buffer` and `dirty`, never in `layout` — `layout` is a
  `jaren-project` member that saves, shares and downloads with the
  document, and which pane a phone was showing is not a property of the
  project. The view model whitelists the value (`files` | `editor` |
  `stage`, anything else → `editor`), so a stale slice cannot blank the IDE.

Gestures whose answer lives in another pane carry the user across:
opening a project or template, and pressing Run, come forward to the
stage; picking a file in the rail or an error line in the strip goes to
the editor. On a desktop every pane is visible, so those patches are
invisible.

Everything above — the view, the derivation, the two policies — renders
and is tested without a DOM; the live stage, the layout modes, the
splitter's drag and the one-pane switching are browser-verified
(`e2e/project.spec.js`, `e2e/studio.spec.js`, `e2e/mobile.spec.js`). Both old
website surfaces are folded in: the playground's engine runners live on
as file kinds, and the app-authoring Studio is the `app` file kind — its
seed applications ship as single-`app`-file project templates and the
retired `#/studio` URL redirects to the project IDE.
