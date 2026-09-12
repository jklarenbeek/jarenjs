//@ts-check
/** @typedef {{ document: any, revision: string, stageRevision: number }} ProjectSnapshot */
/** @typedef {{ ok: boolean, document?: any, revision?: string, conflict?: boolean, error?: string,
 * errors?: any[], valid?: boolean, total?: number, code?: string, result?: any, stale?: boolean, requested?: boolean }} EditorReceipt */
/** Project actions, effects, change feeds and candidate publication share one controller. */
import { semanticKey } from '@jarenjs/core/object';
import { applyJSONPatch } from '@jarenjs/json/patch';
import { renameProjectFile, writeProjectArtifact, resolveProjectFile, fileSkeleton } from '../index.js';

/** @param {{ getApp: () => any, host: any, projectData?: any, projectTemplate?: Function, download?: Function, exportProject?: Function, debounceMs?: number }} env */
export function createProjectController(env) {
  const { projectSnapshot, projectAppFile, commitProject, runProjectFile } = env.host;
  const projectData = env.projectData ?? { dispose() {}, sync() {} };
  let stopped = false, detach = null, timer = null, requestId = 0;
  const requests = new Map(), listeners = new Set();
  const copy = value => JSON.parse(JSON.stringify(value));
  /** @returns {ProjectSnapshot} */
  function read() {
    const document = projectSnapshot(env.getApp().getState().project);
    return { document: copy(document), revision: semanticKey(document), stageRevision: env.getApp().getState().project.revision };
  }
  function validate(candidate) {
    try {
      const { name = 'Untitled project', ...envelope } = copy(candidate);
      if (typeof name !== 'string') throw new TypeError('The project name must be a string.');
      const document = env.host.projectComponent.parseProject(envelope);
      const description = env.host.projectComponent.describe(document);
      const errors = description.files.flatMap(file => file.errors.map(error => ({ ...error, file: file.name })));
      return { valid: errors.length === 0, errors, total: errors.length, document: projectSnapshot({ ...document, name }) };
    }
    catch (error) { return { valid: false, errors: [{ code: error.code ?? 'JS0001', message: error.message, docPath: error.docPath ?? '' }], total: 1 }; }
  }
  function settle(id, ok) {
    const resolve = requests.get(id);
    if (!resolve) return;
    requests.delete(id);
    resolve({ ok, ...read(), ...(ok ? {} : { conflict: true, error: 'The project changed before the candidate could be applied.' }) });
  }
  /** Publish only a validated candidate against the caller's observed revision.
   * @param {any} candidate
   * @param {{ expectedRevision?: string }} [options]

   * @returns {Promise<EditorReceipt>}
   */
  function replace(candidate, { expectedRevision } = {}) {
    if (stopped) return Promise.resolve({ ok: false, error: 'The project editor is disposed.' });
    const previous = read();
    if (typeof expectedRevision !== 'string' || previous.revision !== expectedRevision)
      return Promise.resolve({ ok: false, conflict: true, error: 'The project revision changed.', ...previous });
    const checked = validate(candidate);
    if (!checked.valid) return Promise.resolve({ ok: false, ...checked });
    return new Promise(resolve => {
      const id = ++requestId; requests.set(id, resolve);
      try { env.getApp().dispatch('project/replace', { requestId: id, expected: previous.document, document: checked.document }); }
      catch (error) { requests.delete(id); resolve({ ok: false, error: error.message }); }
    });
  }
  /** @param {Parameters<typeof applyJSONPatch>[1]} patch @param {{ expectedRevision?: string }} [options]
   * @returns {Promise<EditorReceipt>}
   */
  function apply(patch, options) {
    try { return replace(applyJSONPatch(read().document, patch), options); }
    catch (error) { return Promise.resolve({ ok: false, error: error.message, code: error.code }); }
  }
  /** Run a file through the shared host. Computational runs return their settled
   * render result; interactive app files acknowledge their stage restart.
   * `restart: false` commits an interactive app through its normal hot-update
   * path, preserving local state when only document state changed.
   * @param {string} [name] @param {{ restart?: boolean }} [options]
   * @returns {Promise<EditorReceipt> | { error: string }} */
  function run(name = env.getApp().getState().project.active, options = {}) {
    if (stopped) return { error: 'The project editor is disposed.' };
    const app = env.getApp();
    if (!app.getState().project.files.some(file => file.name === name)) return { error: `Unknown project file '${name}'.` };
    const before = read();
    return new Promise(resolve => {
      const id = ++requestId; requests.set(id, resolve);
      app.dispatch('project/execute', { requestId: id, name, expectedRevision: before.revision, restart: options.restart !== false });
    });
  }
  /** @param {(snapshot: ProjectSnapshot) => void} listener */
  function subscribe(listener) {
    if (stopped) return () => {};
    listeners.add(listener); return () => listeners.delete(listener);
  }
  function commit() {
    const app = env.getApp(), state = app?.getState().project;
    if (!stopped && state) app.dispatch('project/committed', commitProject(state));
  }
  function runActive() {
    const app = env.getApp(), state = app?.getState().project;
    if (stopped || !state) return;
    const file = state.files.find(f => f.name === state.active);
    if (file && !file.model && ['query', 'jslt', 'schema', 'contract'].includes(file.kind))
      app.dispatch('project/result', { name: state.active, result: runProjectFile(state, state.active) });
  }
  function attach() {
    if (detach || stopped) return;
    let revision = read().revision;
    detach = env.getApp().subscribe((state, changes) => {
      if (stopped || (changes !== null && !changes.some(path => path === '/project' || path.startsWith('/project/')))) return;
      const current = read();
      if (revision !== current.revision) { revision = current.revision; for (const listener of listeners) listener(current); }
      if (changes === null) { projectData.sync(state.project, true); return; }
      if (changes.some(path => path === '/project/files' || path.startsWith('/project/files/')))
        projectData.sync(state.project, changes.includes('/project/project'));
      if (!changes.some(path => path === '/project/files' || path.startsWith('/project/files/') || path === '/project/active' || path === '/project/layout/autorun')) return;
      const run = () => { if (!stopped && env.getApp().getState().project.layout.autorun !== false) { commit(); runActive(); } };
      if ((env.debounceMs ?? 250) === 0) run();
      else { clearTimeout(timer); timer = setTimeout(run, env.debounceMs ?? 250); }
    });
  }
  function dispose() {
    if (stopped) return;
    stopped = true; clearTimeout(timer); detach?.(); detach = null; projectData.dispose(); listeners.clear();
    for (const resolve of requests.values()) resolve({ ok: false, error: 'The project editor is disposed.' });
    requests.clear();
  }
  const effects = {
    'project-accepted': id => settle(id, true),
    'project-refused': id => settle(id, false),
    'project-editor-run': async (props, dispatch) => {
      const finish = outcome => { const resolve = requests.get(props.requestId); requests.delete(props.requestId); resolve?.(outcome); };
      if (stopped) { finish({ ok: false, error: 'The project editor is disposed.' }); return; }
      if (read().revision !== props.expectedRevision) { finish({ ok: false, conflict: true, ...read() }); return; }
      const state = env.getApp().getState().project, file = state.files.find(f => f.name === props.name);
      dispatch('project/active', props.name);
      dispatch('project/pane', 'stage');
      if (file?.kind === 'app') {
        if (props.restart === false) dispatch('project/committed', commitProject(state));
        else dispatch('project/run');
        await Promise.resolve(); finish({ ok: true, requested: true, ...read() }); return;
      }
      try {
        const result = await runProjectFile(state, props.name, { model: projectData.execute });
        if (stopped) return;
        if (result === null) { finish({ ok: false, error: `File '${props.name}' has no result runner in this host.` }); return; }
        if (env.getApp().getState().project.files !== state.files) { finish({ ok: false, stale: true, result: copy(result) }); return; }
        dispatch('project/result', { name: props.name, result });
        finish({ ok: true, ...read(), result: copy(result) });
      }
      catch (error) { finish({ ok: false, error: error.message, code: error.code }); }
    },
    // the app-document download: the project's designated app file, under
    // the name Studio downloads always carried
    'project-download': (props, dispatch) => {
      const file = projectAppFile(env.getApp().getState().project);
      if (file === null) { dispatch('ide/shared', 'this project has no app document'); return; }
      let doc;
      try { doc = resolveProjectFile(env.getApp().getState().project, file.name).doc; }
      catch { dispatch('ide/shared', 'the app document is not valid JSON'); return; }
      const saved = env.download?.('jaren-studio-app.json', JSON.stringify(doc, null, 2));
      dispatch('ide/shared', saved === true ? 'document downloaded' : 'download unavailable here');
    },
    'project-eject': async (props, dispatch) => {
      try {
        dispatch('ide/shared', 'Preparing offline project…');
        const saved = await env.exportProject?.(projectSnapshot(env.getApp().getState().project));
        dispatch('ide/shared', saved ? 'offline project downloaded' : 'offline export unavailable here');
      }
      catch (error) { dispatch('ide/shared', error.message); }
    },
    'project-export': (props, dispatch) => {
      const snapshot = projectSnapshot(env.getApp().getState().project);
      const saved = env.download?.('jaren-project.json', JSON.stringify(snapshot, null, 2));
      dispatch('ide/shared', saved === true ? 'project downloaded' : 'download unavailable here');
    },

    // the Project IDE: the editor commits the ACTIVE file's text (rewriting
    // it by name — an array index a patch path cannot compute); explicit
    // Run force-restarts the app stage; a template card opens a project.
    'project-route': (props, dispatch) => {
      const p = env.getApp().getState().project;
      const files = p.files.map((f) => {
        if (f.name !== p.active) return f;
        const next = { ...f };
        if (props.value === '') delete next[props.member];
        else next[props.member] = props.value;
        if (props.member === 'model') delete next.collection;
        return next;
      });
      dispatch('project/files-set', { files });
    },
    'project-artifact-edit': (props, dispatch) => {
      const p = env.getApp().getState().project;
      let files;
      try { files = writeProjectArtifact(p, props.name, props.doc); }
      catch (error) { dispatch('project/stage-error', error.message); return; }
      dispatch('project/files-set', { files });
    },
    'project-edit': (props, dispatch) => {
      const p = env.getApp().getState().project;
      const files = p.files.map((f) => (f.name === p.active ? { ...f, text: props.text } : f));
      dispatch('project/files-set', { files });
    },
    'project-run': Object.assign((props, dispatch) => {
      const state = env.getApp().getState().project;
      const active = state.files.find((f) => f.name === state.active);
      const commit = commitProject(state);
      const fragment = commit.mount?.sourceFiles?.includes(state.active) && commit.mount.name !== state.active;
      // a transform / schema / contract file re-runs; an app file force-restarts
      if (active !== undefined && !fragment && !active.model && (active.kind === 'query' || active.kind === 'jslt' || active.kind === 'schema'
        || active.kind === 'contract')) {
        dispatch('project/result', { name: state.active, result: runProjectFile(state, state.active) });
        return;
      }
      const mount = commit.mount === null ? null : { ...commit.mount, revision: commit.mount.revision + 1 };
      dispatch('project/committed', { mount, revision: mount === null ? commit.revision : mount.revision });
    }, { dispose }),
    'project-template': (props, dispatch) => {
      const template = env.projectTemplate?.(props.id);
      if (template === undefined) return;
      dispatch('project/open', template);
      // commit NOW, computed from the template itself: the debounced edit
      // loop alone leaves a race where an edit inside the debounce window
      // supersedes the opening commit — the "last good frame" then never
      // existed and an invalid edit blanks the stage
      dispatch('project/committed', commitProject(template));
    },
    // file management (the files array is an array — index-by-name lives in
    // JS here, then a patch action lands the result)
    'project-add': (props, dispatch) => {
      const text = fileSkeleton(props.kind);
      if (text === null || text === undefined) return;
      const p = env.getApp().getState().project;
      let n = 1;
      let name = `${props.kind}-${n}.${props.kind}`;
      while (p.files.some((f) => f.name === name)) { n += 1; name = `${props.kind}-${n}.${props.kind}`; }
      dispatch('project/added', { files: [...p.files, { name, kind: props.kind, text }], active: name });
    },
    'project-delete': (props, dispatch) => {
      const p = env.getApp().getState().project;
      if (p.files.length <= 1) return; // never delete the last file
      const files = p.files.filter((f) => f.name !== props.name);
      if (files.length === p.files.length) return; // no such file
      const active = p.active === props.name ? files[0].name : p.active;
      dispatch('project/structural', { files, active });
    },
    'project-rename': (props, dispatch) => {
      const p = env.getApp().getState().project;
      const next = String(props.name ?? '').trim();
      if (next === '' || next === p.active || p.files.some((f) => f.name === next)) return;
      const files = renameProjectFile(p.files, p.active, next);
      dispatch('project/structural', { files, active: next });
    },
  };
  return { effects, attach, dispose, commit, runActive, read, validate, replace, apply, run, subscribe };
}
