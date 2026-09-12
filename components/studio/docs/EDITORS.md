# Shared editors and host services

Studio publishes the complete project, Flow and Data editors used by the Jaren
website. Their actions, views, controllers and resource lifetimes have one
implementation. A host supplies its own page, templates and execution services.
The root `@jarenjs/studio` entry remains a headless project engine.

| Public entry | What the host receives |
| --- | --- |
| `@jarenjs/studio/component` | Project mount, document/render host, project host, actions, controller and view pieces |
| `@jarenjs/studio/flow` | Flow mount, actions, diagram/text/inspector projections, controller, machine/DAG runtime and project-file widget |
| `@jarenjs/studio/data` | Data mount, actions, projections, controller, bounded transport and project-model worker ownership |
| `@jarenjs/studio/data/host` | Compiled operation contract, handler table, boot stages, storage selection and injected browser/project worker hosts |
| `@jarenjs/studio/contracts/data.contract.json` | The unchanged `jaren-data-studio` operation document |
| `@jarenjs/studio/styles/studio.css` | Project chrome, shared controls and embedded Flow styles |
| `@jarenjs/studio/styles/flow.css` | Standalone Flow chrome and shared controls |
| `@jarenjs/studio/styles/data.css` | Standalone Data chrome and shared controls |
| `@jarenjs/studio/styles/editor.css` | Scoped common controls and generated-form chrome |

The installed-host fixture in `test/consumer/studio-installed.js` composes all
three editors using public imports. The packed consumer gate runs it with real
Node and Bun SQLite drivers and bundles a separate browser host with private
SQLite initialization. It imports no website source.

## Operations and revisions

Every mount returns `read`, `validate`, `replace`, `apply`, `run`, `subscribe` and
`dispose`. Data additionally returns `ready`, which resolves to an actual boot
success or failure. The app that implements each editor stays private.

`read()` returns an isolated document and a string `revision`. Revisions describe
the current document, rather than a counter incremented by unrelated rendering.
`subscribe(listener)` observes document changes and returns an unsubscribe
function. Disposing twice is safe; disposal ends subscriptions, pending work and
owned runtimes. A disposed editor refuses publication and execution.

`validate(candidate)` uses the existing document validators and returns a
verdict and errors. `replace(candidate, { expectedRevision })` validates and then
checks the observed revision again inside the same queued transition used by
manual edits. A stale revision returns `{ ok: false, conflict: true }`. Invalid or
stale candidates preserve documents, results and typing buffers.
`apply(patch, { expectedRevision })` applies an RFC 6902 patch to the read document
and follows that same replacement path. Keep the returned candidate and errors
when publication is refused; obtain a fresh revision before trying again.

Project documents include the project name, files, active file and layout.
Uncommitted typing remains a separate buffer: an external file replacement keeps
that draft and the existing conflict UI. `run(name?)` selects the requested file
and uses the same host runners and result actions as the controls. It returns
settled transform, flow and model results, refusing stale results after edits.
An interactive app file acknowledges its requested stage restart. The injected
`projectData.execute(project, name)` owns model-query execution.

Flow documents are the `jaren-fsm` or `jaren-dag` value. Replacement retains an
undo entry, invalidates the previous run and clears structural selection. The
kind stays fixed while a document is open; templates open a new document.
`run({ input, event? })` uses the injected task registry or the mounted machine.
A DAG returns its settled output or failure. `event` sends a machine event
through the same sandbox used by the run controls.

Data documents contain `{ model, query }`. `read()` also returns `buffers`
(`modelText` and `queryText`), results and the query plan. Its revision includes
both raw buffers, so even an unfinished JSON edit prevents a stale replacement.
Replacing the document edits those buffers. It does not recreate a database.
`run({ operation: 'query', externals })` executes and explains against the open
store. `run({ operation: 'open' })` explicitly recreates the model through the
existing owner-only operation. A client or memory topology retains the same
recreation refusal as the manual UI. Data accepts JSON row input by default;
a host can inject its existing `createRow(text)` convenience function.

## Project and Flow hosts

`createStudioDocumentHost({ markdown, diagram, templates? })` validates and audits
app documents and provides the form/chart/Markdown/diagram render widgets. The
host supplies its Markdown and diagram rendering policy.
`createProjectHost({ loadDocument, runQuery, runJslt, runValidation, operators? })`
provides the stage, splitter and project engine integration.

Pass that host to `mountStudioEditor(node, { project, host, ... })`. Optional
services include template lookup, template cards, downloads, offline export,
scheduling and a `projectData` runtime. The mount includes the shared embedded
Flow widget; a supplied project Data runtime contributes its model/query widget.
`createProjectDataRuntime({ createWorker })` owns one worker per committed model
and seed identity. Switching files releases the view subscription, while model
changes, deletion, replacement and disposal retire the owning worker.

`mountFlowEditor(node, { kind, document, input?, tasks?, template?, templates? })`
uses the same diagram, inspector, text round-trip policy, history and run runtime
as the project-file widget. Task functions are explicit host services. Document
machine effects are recorded by the sandbox, rather than acquiring host effects.
Both mounts accept scheduling and error-reporting services.

## Data transport, initialization and identity

`mountDataEditor(node, { model, query, transport, ... })` accepts a factory that
creates a fresh transport. `createTransport({ spawnWorker, openChannel,
openClient?, budgets?, setTimer?, clearTimer? })` implements the operation port,
five bounded boot stages, owner-to-client handoff, live stream and cleanup.
Its default port client uses the exported Data contract. It chooses no worker
URL or channel name. Failed boots release their resources; retries start fresh.
Leaving a composed route releases its transport; returning resumes without
re-seeding the text buffers. Lifecycle listeners are removed on disposal.

The browser host imports its chosen SQLite initializer and calls
`createBrowserDataWorker({ initialize, scope, createChannel, identity, operators? })`.
The published code does not import that initializer. `initialize()` returns the
SQLite module accepted by the existing `@jarenjs/db/wasm` adapters.
The `identity` record explicitly names **all five** storage resources:
`channel`, `pool`, `database`, `snapshots` and `lock`. Use the same identity only
for tabs intentionally sharing a store. Independent applications and datasets
must supply distinct identities. The host factory proves durable VFS candidates
with a write/close/reopen probe and retains visible fallback/refusal reporting.
Its disposal pauses an acquired pool without deleting stored files.

`createProjectDataWorker({ initialize, scope, operators? })` serves the same
contract over an isolated in-memory store. It acquires no shared database,
channel or storage identity. The public handler constructor remains
`createDataHandlers(DataHost)`, so Node, Bun and other driver hosts can serve the
operation contract directly without a browser or a SQLite WASM initializer.

The Jaren website keeps its existing `jaren-data-studio` channel,
`jaren-data` pool, `/jaren-data-studio.db` database,
`jaren-data-studio-snapshots` snapshots and `jaren-data-studio-owner` lock.
Its private app owns `@sqlite.org/sqlite-wasm` and Vite asset handling. Another
private app must explicitly provide and declare that bootstrap dependency;
Studio's published dependency graph contains only Jaren packages.

Optional `corpus`, `trip`, `migration` and `createRow` services carry host examples.
The corresponding controls appear when configured. Their data and preview
functions remain host-owned. A corpus report names the configured `executor`
(default `sqlite`); a host using the browser adapter can name `sqlite-wasm`.

## Composing and styling

Existing app hosts can merge the exported actions, view rules and viewmodels
and attach the corresponding controller to their app lifecycle. They use the
same component implementations as the mount helpers. Their private app handles
routing; external callers receive only the controller's document operations.

Import the styles explicitly. Flow and Data selectors are scoped to each
editor; project selectors retain the existing `jstudio`/`js-*` vocabulary.
Controls inherit the host's color, font, spacing and motion tokens and provide
standalone fallbacks. The host owns page gutters, theme tokens, worker assets
and the available viewport height. The established 1024/760 breakpoints,
44px phone controls and reduced-motion behavior travel with the editors.

A mounted Data editor also exposes `setActive(boolean)`. Await
`setActive(false)` when a host route leaves to release its worker, live query
and ownership without losing incomplete model/query text. `setActive(true)`
reopens the last accepted model, preserves the raw editing buffers and resolves
when boot settles; `ready` always refers to that activation. Repeated activation
is idempotent, inactive runs return a refusal, and `dispose()` is terminal.

Data model, query and round-trip text buffers publish every input event. Live
store updates cannot replace uncommitted typing; model recreation and query
execution still require their explicit operations.

Project snapshots expose both a semantic document `revision` for candidate publication and a numeric `stageRevision` for the mounted app. `run(name)` explicitly restarts an interactive app; `run(name, { restart: false })` uses normal commit behavior, preserving the stage for state-only edits and rebuilding it after structural changes.
