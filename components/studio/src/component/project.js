//@ts-check
/** Complete project-stage behavior over injected execution and preview services. */
import { resolveProjectFile, projectFileContext } from '../index.js';
import { contentKey, semanticKey } from '@jarenjs/core/object';
import { createSplitterWidget } from '@jarenjs/app';
import { createStudioComponent } from './index.js';

import { compileFsm, compileDag } from '@jarenjs/flow';
import { compileContract } from '@jarenjs/contract';
import { toOpenApi } from '@jarenjs/contract/project';

import { errorMessage, cards, error, code } from './shared/nodes.js';
import { Float64 } from '@jarenjs/core/math';
const formatMsUnscaled = value => `${Float64.roundToPrecision(value, 3)} ms`;


/** @param {{ operators?: any, loadDocument: Function, runQuery: Function, runJslt: Function, runValidation: Function }} options */
export function createProjectHost(options) {
const { operators: operatorRegistry, loadDocument: loadStudioDocument, runQuery, runJslt, runValidation } = options;
/** The component, with the site's math/finance/stats packs mounted. */
const projectComponent = createStudioComponent({ operators: operatorRegistry });

/** A normalized project view of the live slice (for the engine calls). */
function projectOf(slice) {
  return {
    project: slice.project ?? '0.1',
    files: slice.files ?? [],
    active: slice.active ?? (slice.files?.[0]?.name ?? null),
    layout: slice.layout,
  };
}

/**
 * The live slice as a persistable `jaren-project` document — what a save
 * or a share token carries (the IDE-only fields — mount, results, dirty —
 * stay behind).
 * @param {any} slice - the `state.project` slice
 */
function projectSnapshot(slice) {
  return { ...projectOf(slice), name: slice.name ?? 'Untitled project' };
}

/**
 * The project's designated `app` file — the one the Studio contracts
 * (external document operations, the app download) operate on: the
 * active file when it is an app, else the first app file, else null.
 * @param {any} slice - the `state.project` slice
 * @returns {{ name: string, kind: string, text: string } | null}
 */
function projectAppFile(slice) {
  const files = slice.files ?? [];
  const active = files.find((f) => f.name === slice.active);
  if (active !== undefined && active.kind === 'app') return active;
  return files.find((f) => f.kind === 'app') ?? null;
}

/**
 * The edit loop's pure step: fold the live slice into the last-good
 * `{ mount, revision }` for the active `app` file. A valid structural
 * change bumps the revision (the widget reboots); a valid state-only
 * change keeps the revision but swaps the document (the widget
 * hot-updates); an invalid edit — or a non-app active file — keeps the
 * previous mount untouched (the last good frame stays on the stage).
 * @param {any} slice - the `state.project` slice
 * @returns {{ mount: any, revision: number }}
 */
function commitProject(slice) {
  const mount = slice.mount ?? null;
  const revision = slice.revision ?? 0;
  const project = projectOf(slice);
  let active = project.active;
  let activeFile = project.files.find((f) => f.name === active);
  if (!activeFile) return { mount, revision };
  // Editing an imported fragment keeps its owning app visible and live.
  if (!['app', 'fsm', 'dag', 'model'].includes(activeFile.kind) && !activeFile.model) {
    const owners = project.files.filter((f) => f.kind === 'app' && f.imports
      && Object.values(f.imports).includes(active));
    if (owners.length !== 1) return { mount, revision };
    activeFile = owners[0]; active = activeFile.name;
  }
  let resolved;
  try { resolved = resolveProjectFile(project, active); }
  catch { return { mount, revision }; }
  const assembledFile = { ...activeFile, text: JSON.stringify(resolved.doc) };
  const verdicts = projectComponent.describe(project).files;
  if (!verdicts.find((f) => f.name === active)?.valid) return { mount, revision };
  let input = null;
  let context;
  try {
    context = projectFileContext(project, activeFile);
    if (context.model && !verdicts.find((f) => f.name === context.model.name)?.valid) return { mount, revision };
    const usesInput = ['fsm', 'dag'].includes(activeFile.kind)
      || (activeFile.kind === 'model' && activeFile.input !== undefined);
    if (context.input && usesInput)
      input = JSON.parse(context.input.text);
  }
  catch { return { mount, revision }; }
  const isStore = activeFile.kind === 'model' || activeFile.model !== undefined;
  const doc = resolved.doc;
  const prevProject = mount && mount.name === active
    ? { files: [{ name: mount.name, kind: mount.kind ?? 'app', text: JSON.stringify(mount.doc) }] }
    : { files: [] };
  const nextProject = { files: [{ name: active, kind: activeFile.kind, text: assembledFile.text }] };
  const policy = projectComponent.hostPolicy(prevProject, nextProject)[active] ?? 'reboot';
  if (policy === 'skip' && mount && mount.name === active
    && (!isStore || mount.files === project.files) && semanticKey(mount.input ?? null) === semanticKey(input))
    return { mount, revision };
  const nextRevision = policy === 'reboot' ? revision + 1 : revision;
  return { mount: { name: active, kind: activeFile.kind, doc, input,
    sourceFiles: resolved.sourceFiles, ...(isStore ? { files: project.files, store: true } : {}),
    revision: nextRevision }, revision: nextRevision };
}

/**
 * Run a transform file (`jslt` / `query`): pair it with the project's
 * input (the first `data` file, else a `state` file) and hand it to the
 * shared transform runners — so registered operators ($npv, $sqrt, …)
 * work here exactly as in play. Returns `{ nodes }` (render nodes for
 * the `ui` mode), or null for a kind that is not a runnable transform.
 * The runners catch their own errors into error nodes, so this never
 * throws.
 * @param {any} slice - the `state.project` slice
 * @param {string} name - the file to run
 * @param {{ model?: (project: any, name: string) => Promise<any> }} [options]
 * @returns {{ nodes: any[] } | Promise<{ nodes: any[] }> | null}
 */
function runProjectFile(slice, name, options = {}) {
  const project = projectOf(slice);
  const file = project.files.find((f) => f.name === name);
  if (file === undefined) return null;
  if (file.kind === 'model' || file.model !== undefined) {
    if (!options.model) return null;
    return options.model(project, name).then((result) => ({ nodes: [
      code('Result', JSON.stringify(result.result, null, 2)), code('Query plan', JSON.stringify(result.plan, null, 2)),
    ] }), (err) => ({ nodes: [error(err, 'Model run')] }));
  }
  let input;
  try { ({ input } = projectFileContext(project, file)); }
  catch (err) { return { nodes: [error(err, 'Project reference')] }; }
  const dataText = input ? input.text : 'null';
  if (file.kind === 'fsm' || file.kind === 'dag') {
    try {
      const doc = resolveProjectFile(project, name).doc;
      const data = JSON.parse(dataText);
      if (file.kind === 'dag') return compileDag(doc).run(data).then(
        (output) => ({ nodes: [code('DAG output', JSON.stringify(output, null, 2) ?? '(empty sequence)')] }),
        (err) => ({ nodes: [error(err, 'DAG run')] }));
      const machine = compileFsm(doc);
      let state = machine.initial;
      const trace = [];
      for (const event of data?.events ?? []) {
        const result = machine.step(state, typeof event === 'string' ? event : event.event,
          { context: data?.context ?? null, payload: typeof event === 'string' ? null : event.payload });
        trace.push(result); state = result.state;
      }
      return { nodes: [code('Machine run', JSON.stringify({ state, events: state === null ? [] : machine.events(state), trace }, null, 2))] };
    }
    catch (err) { return { nodes: [error(err, 'Flow run')] }; }
  }
  if (file.kind === 'query') return { nodes: runQuery({ query: file.text, data: dataText, externals: '' }) };
  if (file.kind === 'jslt') return { nodes: runJslt({ stylesheet: file.text, data: dataText }) };
  if (file.kind === 'schema') return { nodes: validateNodes(file.text, dataText) };
  if (file.kind === 'contract') return { nodes: contractNodes(file.text) };
  return null;
}

/**
 * A `contract` file's stage: compile it and show the projections a
 * consumer reads — `describe()` (resolved bindings + policy) and the
 * OpenAPI 3.1 document. A compile refusal renders as the coded error
 * node with its `JC00xx` and docPath (the same diagnosis the file rail
 * shows), never a throw.
 * @param {string} text - the contract file's text
 */
function contractNodes(text) {
  let doc;
  try { doc = JSON.parse(text); }
  catch (err) { return [error({ message: errorMessage(err) }, 'Invalid JSON')]; }
  let contract;
  try { contract = compileContract(doc); }
  catch (err) { return [error(/** @type {any} */ (err), 'Contract refusal')]; }
  const description = contract.describe();
  // lenient: a keyword the OpenAPI dialect cannot carry is dropped and
  // COUNTED (the card says so) instead of refusing the whole pane — the
  // strict mode is the CLI's job, the stage's job is to show the file
  const openapi = toOpenApi(contract, {
    lenient: true,
    info: {
      title: typeof doc.id === 'string' ? doc.id : 'contract',
      version: typeof doc.version === 'string' ? doc.version : '0',
    },
  });
  return [
    cards([
      { title: 'Operations', value: String(description.operations.length) },
      ...(openapi.dropped.length > 0 ? [{ title: 'OpenAPI dropped', value: String(openapi.dropped.length) }] : []),
    ]),
    code('describe()', JSON.stringify(description, null, 2)),
    code('OpenAPI 3.1', JSON.stringify(openapi.document, null, 2)),
  ];
}

/** Validate a data file against a schema file and render the report on
 * the stage: a valid/invalid summary plus each error as its own coded
 * node. */
function validateNodes(schemaText, dataText) {
  let data;
  try { data = JSON.parse(dataText); }
  catch (err) { return [error({ message: `data: ${errorMessage(err)}` }, 'Invalid JSON')]; }
  const r = runValidation(schemaText, data);
  if (r.schemaError !== null) return [error({ message: r.schemaError }, 'Schema error')];
  const nodes = [cards([
    { title: r.valid ? 'Valid' : 'Invalid', value: r.valid ? '✓' : `${r.errors.length} error${r.errors.length === 1 ? '' : 's'}` },
    { title: 'Draft', value: r.draft },
    { title: 'Compile', value: formatMsUnscaled(r.compileMs) },
    { title: 'Validate', value: formatMsUnscaled(r.validateMs) },
  ])];
  for (const e of r.errors) {
    nodes.push(error({
      message: e.message,
      dataPath: e.instancePath === '' ? '(root)' : e.instancePath,
      code: e.keyword !== '' ? e.keyword : undefined,
    }, 'Validation error'));
  }
  return nodes;
}

/**
 * The live stage host widget (`studio-stage`): boot the active app file's
 * assembled document as an isolated nested app, then apply the
 * reboot-vs-hot-update policy on every commit.
 * @param {{ schedule?: (flush: () => void) => void }} [env]
 */
function createProjectStageWidget(env = {}) {
  const stateKeyOf = (doc) => (doc && typeof doc === 'object' ? contentKey(doc.state ?? null) : null);
  // the document minus its state — the same datum classifyChange keys on.
  // The widget re-derives it defensively: two commits can race in at the
  // SAME revision with different documents (a project/open interleaving
  // with a route-arrival commit), and hot-dispatching one document's
  // state into another document's running view renders garbage.
  const shapeKeyOf = (doc) => (doc && typeof doc === 'object' ? contentKey({ ...doc, state: null }) : null);

  const boot = (handle, mount) => {
    handle.emit({ action: 'project/stage-error', with: null });
    const result = loadStudioDocument(mount.doc, {
      node: handle.host,
      document: handle.host.ownerDocument,
      schedule: env.schedule,
      onError: (err) => handle.emit({ action: 'project/stage-error', with: errorMessage(err) }),
    });
    handle.app = result.ok ? result.app : null;
    handle.revision = mount.revision;
    handle.stateKey = stateKeyOf(mount.doc);
    handle.shapeKey = shapeKeyOf(mount.doc);
    if (!result.ok) handle.emit({ action: 'project/stage-error', with: result.message });
  };
  const destroy = (handle) => {
    try { handle.app?.destroy(); }
    catch (err) { handle.emit({ action: 'project/stage-error', with: errorMessage(err) }); }
    handle.app = null;
  };

  return {
    mount(host, props, emit) {
      const handle = { host, emit, app: null, revision: null, stateKey: null, shapeKey: null };
      boot(handle, props);
      return handle;
    },
    update(handle, props, prevProps) {
      if (props === prevProps) return;
      // a structural change bumped the revision — or a raced-in commit
      // swapped the document's shape at the same revision → destroy + reboot
      if (props.revision !== handle.revision || shapeKeyOf(props.doc) !== handle.shapeKey) {
        destroy(handle);
        boot(handle, props);
        return;
      }
      // same revision, same shape, new document → a state-only edit →
      // hot-dispatch it into the RUNNING app (no reboot: scroll, focus and
      // uncontrolled inputs survive the diff re-render)
      const key = stateKeyOf(props.doc);
      if (handle.app !== null && key !== handle.stateKey) {
        handle.app.setState(props.doc.state);
        handle.stateKey = key;
      }
    },
    unmount(handle) {
      destroy(handle);
    },
  };
}

/**
 * The Studio's drag splitter (`studio-splitter`): the shared
 * `createSplitterWidget` bound to the studio grid — a handle over the
 * editor|stage boundary that drives `--js-ratio` live during a drag and
 * commits `project/layout-ratio` on pointer-UP (keyboard-resizable as an
 * ARIA separator). The reusable widget lives in `@jarenjs/app`; play binds
 * the same factory to its own grid.
 */
function createProjectSplitterWidget() {
  return createSplitterWidget({
    grid: '.jstudio', rail: '.js-rail', cssVar: '--js-ratio', action: 'project/layout-ratio',
  });
}

return { projectComponent, projectSnapshot, projectAppFile, commitProject, runProjectFile, createProjectStageWidget, createProjectSplitterWidget };
}
