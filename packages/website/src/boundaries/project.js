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
import { createStudioComponent } from '@jarenjs/studio/component';

import { loadStudioDocument } from './studio.js';
import { operatorRegistry } from './engines.js';
import { errorMessage } from '../lib/nodes.js';

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
