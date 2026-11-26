//@ts-check
/**
 * @file `projectViewModel(state)` — the IDE's derivation boundary. Given
 * the `state.project` slice it derives everything the JSLT shell renders:
 * the file rail (from the engine's `describe`), the active file's editor
 * value and its coded errors, the docked error strip across every file,
 * and the stage — an assembled app document to mount, a run result to
 * show, or an inert note for a kind that has no editor of its own yet.
 * Pure: nothing here is stored back in state.
 */

import { pickAllowed } from '@jarenjs/core/array';
import { LAYOUT_DEFAULT } from '../project.js';
import { describe, assembleArtifacts } from '../assemble.js';
import { reconcileBuffer } from './host.js';
import { KIND_BADGE } from './editor.js';
import { studioTextOf, wordsBy } from '../messages.js';

/** The project's default name, as the engine and the saved document spell it. */
const UNTITLED = 'Untitled project';

/** The words of the IDE shell, once per catalog. */
const shellWords = wordsBy((t) => ({
  panes: t('studio/panes'), paneFiles: t('studio/project/pane-files'), paneEditor: t('studio/project/pane-editor'),
  paneStage: t('studio/project/pane-stage'), new: t('studio/project/new'), layout: t('studio/project/layout'),
  layoutSide: t('studio/project/layout-side'), layoutSideTitle: t('studio/project/layout-side-title'),
  layoutSwap: t('studio/project/layout-swap'), layoutSwapTitle: t('studio/project/layout-swap-title'),
  layoutStack: t('studio/project/layout-stack'), layoutStackTitle: t('studio/project/layout-stack-title'),
  autorun: t('studio/project/autorun'), run: t('studio/project/run'), files: t('studio/project/files'),
  addFile: t('studio/project/add-file'), addFileOption: t('studio/project/add-file-option'),
  fileName: t('studio/project/file-name'), conflict: t('studio/project/conflict'),
  conflictTake: t('studio/project/conflict-take'), conflictTakeTitle: t('studio/project/conflict-take-title'),
  routeInput: t('studio/project/route-input'), routeInputFile: t('studio/project/route-input-file'),
  routeInputDefault: t('studio/project/route-input-default'), routeModel: t('studio/project/route-model'),
  routeModelFile: t('studio/project/route-model-file'), routeModelMemory: t('studio/project/route-model-memory'),
  routeCollection: t('studio/project/route-collection'),
  routeCollectionPlaceholder: t('studio/project/route-collection-placeholder'),
  resize: t('studio/project/resize'), stage: t('studio/stage/head'), stageHint: t('studio/stage/hint'),
  // a rail row is its own rule, matched at its own node: it carries these
  rail: { errors: t('studio/project/file-errors'), warnings: t('studio/project/file-warnings'), delete: t('studio/project/file-delete'),
    deleteTitle: t('studio/project/file-delete-title') },
}));

/** What a kind of file is, in the reader's words (the engine's `role` is English). */
const roleOf = (t, kind, role) => (Object.hasOwn(KIND_BADGE, kind) ? t(`studio/role/${kind}`) : role);

/** The phone panes, in switcher order. */
const MOBILE_PANES = ['files', 'editor', 'stage'];

/** The stage the active file drives. */
function deriveStage(project, activeMeta, results, revision, committed, t) {
  if (activeMeta === null) return { kind: 'empty', note: t('studio/stage/empty') };
  if (committed?.store) return { kind: 'app', widget: 'studio-data', mount: committed };
  if (committed?.kind === 'app' || ['app', 'fsm', 'dag'].includes(activeMeta.kind)) {
    // A host that runs the app live commits the LAST-GOOD assembled
    // document (with its own reboot revision). That wins over the current
    // text: a parse error in the editor must never blank the stage — the
    // last good frame stays until the next VALID commit replaces it.
    if (committed !== null && committed.doc) {
      return { kind: 'app', widget: (committed.kind ?? activeMeta.kind) === 'app' ? 'studio-stage' : 'studio-flow', mount: committed };
    }
    const artifact = assembleArtifacts(project).artifacts.find((a) => a.name === activeMeta.name);
    if (artifact === undefined || !activeMeta.valid) {
      return { kind: 'boot-failed', note: t('studio/stage/boot-failed', { name: activeMeta.name }) };
    }
    // the reference-stable mount is memoized by the host at wiring time;
    // here it is the data: the assembled document + the reboot revision
    return { kind: 'app', widget: activeMeta.kind === 'app' ? 'studio-stage' : 'studio-flow', mount: { name: activeMeta.name, kind: activeMeta.kind, doc: artifact.doc, revision } };
  }
  if (activeMeta.kind === 'jslt' || activeMeta.kind === 'query' || activeMeta.kind === 'schema'
    || activeMeta.kind === 'contract') {
    // the host runs the file (a transform, a schema validating the data
    // file, or a contract's describe()/OpenAPI projections) and stores
    // its render nodes; the stage renders them in `ui` mode, or a hint
    // until the first run lands
    const result = results[activeMeta.name] ?? null;
    return { kind: 'result', ran: result !== null, nodes: result?.nodes ?? [] };
  }
  if (activeMeta.kind === 'state' || activeMeta.kind === 'data') {
    return { kind: 'inert', note: t('studio/stage/input') };
  }
  return { kind: 'inert', note: t('studio/stage/press-run', { role: roleOf(t, activeMeta.kind, activeMeta.role) }) };
}

/**
 * Derive the IDE view model from `state.project`.
 * @param {{ project: any }} state - the site state carrying the `project` slice
 * @param {{ operators?: { toOptions: () => any }, messages?: Parameters<typeof studioTextOf>[0] }} [options] -
 *   `messages`: the reader's compiled catalog (or a function answering
 *   it); English when absent
 * @returns {any}
 */
export function projectViewModel(state, options = {}) {
  const t = studioTextOf(options.messages);
  const words = shellWords(options.messages);
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
    roleLabel: roleOf(t, f.kind, f.role),
    w: words.rail,
    badge: KIND_BADGE[f.kind] ?? 'json',
    valid: f.valid,
    // a valid file can still carry warnings: the rail marks those apart
    warned: f.valid && f.warnings.length > 0,
    active: f.name === activeName,
    artifact: f.artifact,
  }));

  // the docked strip: every file's coded errors, then its warnings,
  // prefixed by file name, so a broken file anywhere is visible and one
  // click reaches it
  const problems = [];
  for (const f of d.files) {
    for (const e of f.errors) {
      problems.push({ file: f.name, code: e.code ?? '', message: e.message, docPath: e.docPath ?? '', warning: false });
    }
    for (const w of f.warnings) {
      problems.push({ file: f.name, code: w.code ?? '', message: w.message, docPath: w.docPath ?? '', warning: true });
    }
  }

  // the host's last-good committed app mount ({ name, doc, revision }),
  // used only while it is the active file — a reference-stable document
  // the stage widget reboots (revision change) or hot-updates (same
  // revision, new state) against
  const committed = (slice.mount && (slice.mount.name === activeName || slice.mount.sourceFiles?.includes(activeName))) ? slice.mount : null;

  // The editor's value is the typing BUFFER reconciled against the file's
  // committed text, never the committed text alone: the buffer is what the
  // user has typed but not yet committed (the commit lands on blur), and a
  // controlled textarea must be reasserted with THAT or the renderer
  // overwrites the user mid-edit. A write that lands on the file while the
  // buffer is dirty keeps the human's text and surfaces the incoming
  // version as a recoverable conflict — never a silent clobber, never a
  // hidden write.
  const committedText = activeFile ? activeFile.text : '';
  const buffer = (slice.buffer !== null && slice.buffer !== undefined
    && slice.buffer.file === activeName)
    ? { text: slice.buffer.text, dirty: slice.buffer.dirty === true }
    : { text: committedText, dirty: false };
  const reconciled = reconcileBuffer(buffer, committedText);
  const editorValue = reconciled.text;
  const name = slice.name ?? UNTITLED;
  const lineCount = editorValue === '' ? 0 : editorValue.split('\n').length;
  return {
    w: words,
    // the default name is the package's word; a name the reader gave is theirs
    name: name === UNTITLED ? t('studio/project/untitled') : name,
    // the incoming text a conflicting write carried, or null
    conflict: reconciled.conflict === null ? null : reconciled.conflict.incoming,
    layout: project.layout,
    // the splitter's committed handle position, as an integer percent for
    // aria-valuenow (the widget updates it live during a drag)
    ratioPct: Math.round((project.layout.ratio ?? 0.5) * 100),
    active: activeName,
    // the name field's own typing buffer, defaulting to the committed name.
    // It follows the active file, so switching files shows that file's name
    // rather than a half-typed rename of the previous one.
    renameDraft: (slice.renameDraft !== null && slice.renameDraft !== undefined
      && slice.renameDraft.file === activeName)
      ? slice.renameDraft.text
      : activeName,
    activeKind: activeMeta?.kind ?? null,
    routing: activeFile && ['query', 'jslt', 'schema', 'fsm', 'dag', 'model'].includes(activeFile.kind) ? {
      input: activeFile.input ?? '', model: activeFile.model ?? '', collection: activeFile.collection ?? '',
      canModel: activeFile.kind === 'query',
      hasInput: !activeFile.model, hasCollection: activeFile.kind === 'model' || !!activeFile.model,
      inputs: project.files.filter((f) => ['data', 'state'].includes(f.kind)).map((f) => f.name),
      models: project.files.filter((f) => f.kind === 'model').map((f) => f.name),
    } : null,
    activeValid: activeMeta?.valid ?? true,
    activeErrors: activeMeta?.errors ?? [],
    editorValue,
    lineCount,
    lineCountText: t('studio/project/line-count', { count: lineCount }),
    rail,
    fileCount: project.files.length,
    fileCountText: t('studio/project/file-count', { count: project.files.length }),
    problems,
    problemCount: problems.length,
    stage: deriveStage(project, activeMeta, results, revision, committed, t),
    stageError: slice.stageError ?? null,
    saveState: t((slice.dirty === true || reconciled.dirty) ? 'studio/project/unsaved' : 'studio/project/saved'),
    // the phone pane (Files · Editor · Stage). This is host chrome, not a
    // project member: `layout` travels with the saved document, which pane
    // a phone was showing does not.
    mobilePane: pickAllowed(slice.mobilePane, MOBILE_PANES, 'editor'),
  };
}
