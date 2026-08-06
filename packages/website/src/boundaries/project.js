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
import { operatorRegistry, runEngine } from './engines.js';
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
  return null;
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
 * The drag splitter (`studio-splitter`): a pointer-capture handle over the
 * editor|stage boundary. It drives the grid's `--js-ratio` LIVE during a
 * drag (no dispatch — per-mousemove commits would flood the transaction
 * log and undo), and commits `project/layout-ratio` on pointer-UP only.
 * Keyboard-resizable as an ARIA separator (arrows ±5 %, Shift ±1 %,
 * Home/End). Every DOM call is guarded so the widget mounts harmlessly
 * over the headless stub too (there it is inert — the live drag is
 * browser-verified).
 */
export function createProjectSplitterWidget() {
  const clamp = (r) => Math.min(0.9, Math.max(0.1, r));
  return {
    mount(host, props, emit) {
      // pointermove/up ride the OWNER DOCUMENT for the span of a drag —
      // the robust splitter pattern: the pointer leaves the 10px handle
      // immediately, so listening on the handle alone (even with pointer
      // capture) drops the drag. Document listeners catch the move
      // everywhere and are torn off on pointer-up.
      const doc = host.ownerDocument ?? null;
      const gridOf = () => (typeof host.closest === 'function' ? host.closest('.jstudio') : null);
      const applyRatio = (r) => {
        gridOf()?.style?.setProperty?.('--js-ratio', String(r));
        host.setAttribute?.('aria-valuenow', String(Math.round(r * 100)));
      };
      // pointer x → the left content pane's share of the editor+stage span
      const ratioAt = (clientX) => {
        const g = gridOf();
        if (g === null) return handle.ratio;
        const rail = typeof g.querySelector === 'function' ? g.querySelector('.js-rail') : null;
        const box = g.getBoundingClientRect();
        const left = rail !== null ? rail.getBoundingClientRect().right : box.left;
        if (!(box.right > left)) return handle.ratio;
        return clamp((clientX - left) / (box.right - left));
      };
      const onMove = (e) => {
        if (!handle.dragging) return;
        e.preventDefault?.();
        handle.ratio = ratioAt(e.clientX);
        applyRatio(handle.ratio); // live only — the commit is on pointer-up
      };
      const onUp = () => {
        if (!handle.dragging) return;
        handle.dragging = false;
        doc?.removeEventListener?.('pointermove', onMove);
        doc?.removeEventListener?.('pointerup', onUp);
        emit({ action: 'project/layout-ratio', with: handle.ratio });
      };
      const onDown = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        handle.dragging = true;
        e.preventDefault?.();
        doc?.addEventListener?.('pointermove', onMove);
        doc?.addEventListener?.('pointerup', onUp);
      };
      const onKey = (e) => {
        const step = e.shiftKey ? 0.01 : 0.05;
        let next = null;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = clamp(handle.ratio - step);
        else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = clamp(handle.ratio + step);
        else if (e.key === 'Home') next = 0.1;
        else if (e.key === 'End') next = 0.9;
        if (next === null) return;
        e.preventDefault?.();
        handle.ratio = next;
        applyRatio(next);
        emit({ action: 'project/layout-ratio', with: next });
      };

      const handle = { host, doc, ratio: clamp(Number(props?.ratio ?? 0.5)), dragging: false, applyRatio, onMove, onUp };
      applyRatio(handle.ratio);
      host.addEventListener?.('pointerdown', onDown);
      host.addEventListener?.('keydown', onKey);
      handle.hostListeners = [['pointerdown', onDown], ['keydown', onKey]];
      return handle;
    },
    update(handle, props) {
      const r = clamp(Number(props?.ratio ?? 0.5));
      if (r !== handle.ratio && !handle.dragging) {
        handle.ratio = r;
        handle.applyRatio(r);
      }
    },
    unmount(handle) {
      for (const [type, fn] of handle.hostListeners) handle.host.removeEventListener?.(type, fn);
      handle.doc?.removeEventListener?.('pointermove', handle.onMove);
      handle.doc?.removeEventListener?.('pointerup', handle.onUp);
    },
  };
}
