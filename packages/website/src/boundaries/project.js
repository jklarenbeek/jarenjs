//@ts-check
/**
 * The Project IDE boundary — the site's glue for `@jarenjs/studio`.
 *
 * The engine (parse / per-file validate / assemble / classify) and the
 * chrome (the JSLT view + the pure derivation + the two hard-problem
 * policies) live in the package; this boundary wires the DOM-touching
 * halves the package deliberately leaves open:
 *
 *  - `projectComponent` — the component instance, with the site's
 *    registered operator packs threaded in, so a `jslt`/`query` file that
 *    uses `$npv`/`$sqrt` validates green (per-file, on its own boundary).
 *  - `createProjectStageWidget` — the live stage: it boots the active
 *    `app` file's assembled document as an ISOLATED nested app (reusing
 *    the Studio boundary's `loadStudioDocument`), and on a commit applies
 *    the reboot-vs-hot-update policy — a structural change reboots, a
 *    state-only change hot-dispatches the new state into the running app
 *    with `app.setState` (no reboot; the user keeps scroll and inputs).
 *  - `commitProject` — the edit loop's pure step: given the live slice,
 *    produce the last-good `{ mount, revision }`. An invalid edit keeps
 *    the previous mount, so a parse error never blanks the stage.
 */

import { contentKey } from '@jarenjs/core/object';
import { createSplitterWidget } from '@jarenjs/app';
import { createStudioComponent } from '@jarenjs/studio/component';

import { loadStudioDocument } from './studio.js';
import { operatorRegistry, runEngine } from './engines.js';
import { runValidation } from './validator.js';
import { errorMessage, cards, error } from '../lib/nodes.js';
import { formatMsUnscaled } from '../lib/format.js';

/** The component, with the site's math/finance/stats packs mounted. */
export const projectComponent = createStudioComponent({ operators: operatorRegistry });

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
 * The edit loop's pure step: fold the live slice into the last-good
 * `{ mount, revision }` for the active `app` file. A valid structural
 * change bumps the revision (the widget reboots); a valid state-only
 * change keeps the revision but swaps the document (the widget
 * hot-updates); an invalid edit — or a non-app active file — keeps the
 * previous mount untouched (the last good frame stays on the stage).
 * @param {any} slice - the `state.project` slice
 * @returns {{ mount: { name: string, doc: any, revision: number } | null, revision: number }}
 */
export function commitProject(slice) {
  const mount = slice.mount ?? null;
  const revision = slice.revision ?? 0;
  const project = projectOf(slice);
  const active = project.active;
  const activeFile = project.files.find((f) => f.name === active);
  if (activeFile === undefined || activeFile.kind !== 'app') {
    return { mount, revision };
  }
  const verdict = projectComponent.validateFile(activeFile);
  if (!verdict.valid) return { mount, revision }; // last good frame stays

  let doc;
  try { doc = JSON.parse(activeFile.text); }
  catch { return { mount, revision }; }

  // classify against the last-good mount (a one-file project apiece), so
  // the policy the widget reads is the package's own tested datum
  const prevProject = mount && mount.name === active
    ? { files: [{ name: mount.name, kind: 'app', text: JSON.stringify(mount.doc) }] }
    : { files: [] };
  const nextProject = { files: [{ name: active, kind: 'app', text: activeFile.text }] };
  const policy = projectComponent.hostPolicy(prevProject, nextProject)[active] ?? 'reboot';

  if (policy === 'skip' && mount && mount.name === active) return { mount, revision };
  const nextRevision = policy === 'reboot' ? revision + 1 : revision;
  return { mount: { name: active, doc, revision: nextRevision }, revision: nextRevision };
}

/**
 * Run a transform file (`jslt` / `query`) exactly as the playground does:
 * pair it with the project's input (the first `data` file, else a `state`
 * file) and hand it to the same `runEngine` — so registered operators
 * ($npv, $sqrt, …) work and the result nodes are identical to the
 * playground's. Returns `{ nodes }` (render nodes for the `ui` mode), or
 * null for a kind that is not a runnable transform. `runEngine` catches
 * its own errors into error nodes, so this never throws.
 * @param {any} slice - the `state.project` slice
 * @param {string} name - the file to run
 * @returns {{ nodes: any[] } | null}
 */
export function runProjectFile(slice, name) {
  const project = projectOf(slice);
  const file = project.files.find((f) => f.name === name);
  if (file === undefined) return null;
  const input = project.files.find((f) => f.kind === 'data')
    ?? project.files.find((f) => f.kind === 'state');
  const dataText = input ? input.text : 'null';
  if (file.kind === 'query') return { nodes: runEngine('query', { query: file.text, data: dataText, externals: '' }) };
  if (file.kind === 'jslt') return { nodes: runEngine('jslt', { stylesheet: file.text, data: dataText }) };
  if (file.kind === 'schema') return { nodes: validateNodes(file.text, dataText) };
  return null;
}

/** Validate a data file against a schema file and render the report — the
 * playground's "validate" tab, folded into the stage: a valid/invalid
 * summary plus each error as its own coded node. */
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
export function createProjectStageWidget(env = {}) {
  const stateKeyOf = (doc) => (doc && typeof doc === 'object' ? contentKey(doc.state ?? null) : null);

  const boot = (handle, mount) => {
    const result = loadStudioDocument(mount.doc, {
      node: handle.host,
      document: handle.host.ownerDocument,
      schedule: env.schedule,
      onError: (err) => handle.emit({ action: 'project/stage-error', with: errorMessage(err) }),
    });
    handle.app = result.ok ? result.app : null;
    handle.revision = mount.revision;
    handle.stateKey = stateKeyOf(mount.doc);
    if (!result.ok) handle.emit({ action: 'project/stage-error', with: result.message });
  };
  const destroy = (handle) => {
    try { handle.app?.destroy(); }
    catch (err) { handle.emit({ action: 'project/stage-error', with: errorMessage(err) }); }
    handle.app = null;
  };

  return {
    mount(host, props, emit) {
      const handle = { host, emit, app: null, revision: null, stateKey: null };
      boot(handle, props);
      return handle;
    },
    update(handle, props, prevProps) {
      if (props === prevProps) return;
      // a structural change bumped the revision → destroy + reboot
      if (props.revision !== handle.revision) {
        destroy(handle);
        boot(handle, props);
        return;
      }
      // same revision, new document → a state-only edit → hot-dispatch it
      // into the RUNNING app (no reboot: scroll, focus and uncontrolled
      // inputs survive the diff re-render)
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
export function createProjectSplitterWidget() {
  return createSplitterWidget({
    grid: '.jstudio', rail: '.js-rail', cssVar: '--js-ratio', action: 'project/layout-ratio',
  });
}
