//@ts-check
/**
 * @file `projectViewModel(state)` — the IDE's derivation boundary. Given
 * the `state.project` slice it derives everything the JSLT shell renders:
 * the file rail (from the engine's `describe`), the active file's editor
 * value and its coded errors, the docked error strip across every file,
 * and the stage — an assembled app document to mount, a run result to
 * show, or an inert note for a kind whose rich editor is a later order.
 * Pure: nothing here is stored back in state.
 */

import { LAYOUT_DEFAULT } from '../project.js';
import { describe, assembleArtifacts } from '../assemble.js';
import { KIND_BADGE } from './editor.js';

/** The stage the active file drives. */
function deriveStage(project, activeMeta, results, revision) {
  if (activeMeta === null) return { kind: 'empty', note: 'Add a file to begin.' };
  if (activeMeta.kind === 'app') {
    const artifact = assembleArtifacts(project).artifacts.find((a) => a.name === activeMeta.name);
    if (artifact === undefined || !activeMeta.valid) {
      return { kind: 'boot-failed', note: `${activeMeta.name} does not boot yet — fix the file (the last good render stays).` };
    }
    // the reference-stable mount is memoized by the host at wiring time;
    // here it is the data: the assembled document + the reboot revision
    return { kind: 'app', mount: { doc: artifact.doc, revision } };
  }
  if (activeMeta.kind === 'jslt' || activeMeta.kind === 'query') {
    const result = results[activeMeta.name] ?? null;
    return { kind: 'result', ran: result !== null, result };
  }
  if (activeMeta.kind === 'state' || activeMeta.kind === 'data' || activeMeta.kind === 'schema') {
    return { kind: 'inert', note: 'An input — edit it as text; it feeds the app, a query or a validation.' };
  }
  // fsm / dag / model — their rich editors arrive in Orders 03–04
  return { kind: 'inert', note: `The ${activeMeta.role} editor arrives in a later order; edit it as text meanwhile.` };
}

/**
 * Derive the IDE view model from `state.project`.
 * @param {{ project: any }} state - the site state carrying the `project` slice
 * @param {{ operators?: { toOptions: () => any } }} [options]
 * @returns {any}
 */
export function projectViewModel(state, options = {}) {
  const slice = state.project ?? {};
  const project = {
    project: slice.project ?? '0.1',
    files: slice.files ?? [],
    active: slice.active ?? (slice.files?.[0]?.name ?? null),
    layout: { ...LAYOUT_DEFAULT, ...slice.layout },
  };
  const results = slice.results ?? {};
  const revision = slice.revision ?? 0;

  const d = describe(project, options);
  const activeName = project.active;
  const activeMeta = d.files.find((f) => f.name === activeName) ?? null;
  const activeFile = project.files.find((f) => f.name === activeName) ?? null;

  const rail = d.files.map((f) => ({
    name: f.name,
    kind: f.kind,
    role: f.role,
    badge: KIND_BADGE[f.kind] ?? 'json',
    valid: f.valid,
    active: f.name === activeName,
    artifact: f.artifact,
  }));

  // the docked strip: every file's coded errors, prefixed by file name,
  // so a broken file anywhere is visible and one click reaches it
  const problems = [];
  for (const f of d.files) {
    for (const e of f.errors) {
      problems.push({ file: f.name, code: e.code ?? '', message: e.message, docPath: e.docPath ?? '' });
    }
  }

  const editorValue = activeFile ? activeFile.text : '';
  return {
    name: slice.name ?? 'Untitled project',
    layout: project.layout,
    active: activeName,
    activeKind: activeMeta?.kind ?? null,
    activeValid: activeMeta?.valid ?? true,
    activeErrors: activeMeta?.errors ?? [],
    editorValue,
    lineCount: editorValue === '' ? 0 : editorValue.split('\n').length,
    rail,
    fileCount: project.files.length,
    problems,
    problemCount: problems.length,
    stage: deriveStage(project, activeMeta, results, revision),
    saveState: slice.dirty === true ? 'Unsaved ●' : 'Saved',
  };
}
