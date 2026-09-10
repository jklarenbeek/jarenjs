//@ts-check
/** Standalone project runner: local assets only, no website services. */
import './styles.css';
import '@jarenjs/md/styles/md.css';
import '@jarenjs/mermaid/styles/mermaid.css';
import '@jarenjs/charts/styles/charts.css';
import '@jarenjs/studio/styles/studio.css';
import { createApp } from '@jarenjs/app';
import { resolveProjectFile, projectFileContext, describe, writeProjectArtifact } from '@jarenjs/studio';
import { createProjectStageWidget, runProjectFile } from './boundaries/project.js';
import { createProjectFlowWidget } from './boundaries/project-flow.js';
import { createProjectDataRuntime } from './boundaries/project-data.js';
import { UI_RULES } from './views/ui.js';

const project = await (await fetch(new URL('../project.json', import.meta.url))).json();
const data = createProjectDataRuntime({ createWorker: () =>
  new Worker(new URL('./project-db-worker.js', import.meta.url), { type: 'module' }) });
const app = createApp({ state: { active: project.active, error: null, revision: 0 },
  actions: {
    select: { patch: [{ op: 'replace', path: '/active', value: '$event.value' }] },
    'project/artifact-edit': { effects: [{ run: 'edit-file', with: '$payload' }] },
    refresh: { patch: [{ op: 'replace', path: '/revision', value: { $add: ['$.revision', 1] } }] },
    'project/stage-error': { patch: [{ op: 'replace', path: '/error', value: '$payload' }] },
  },
  view: { $jslt: '0.1', modes: { ui: { unmatched: 'error' } }, rules: [
    { match: '$', body: ['div', { class: 'container offline-project' },
      ['h1', {}, 'Jaren project'], ['label', {}, 'File ',
        ['select', { 'aria-label': 'Project file', value: '$.active', on: { change: 'select' } },
          [{ $for: { file: '$.files[*]' }, $return: ['option', { value: '$file.name' }, '$file.name'] }]]],
      ['p', { role: 'status' }, '$.error'], '$.stage',
      [{ $apply: ['$.nodes[*]', 'ui'] }],
    ] }, ...UI_RULES,
  ] },
}, {
  effects: { 'edit-file': (payload, dispatch) => {
    project.files = writeProjectArtifact(project, payload.name, payload.doc); dispatch('refresh');
  } },
  node: document.getElementById('app'), widgets: {
    app: createProjectStageWidget(), flow: createProjectFlowWidget(), data: data.widget,
  },
  viewModel: (state) => {
    const file = project.files.find((f) => f.name === state.active) ?? project.files[0];
    const base = { ...state, files: project.files, stage: '', nodes: [] };
    if (!file) return base;
    try {
      const verdict = describe(project).files.find((f) => f.name === file.name);
      if (!verdict.valid) return { ...base, error: verdict.errors.map((e) => e.message).join('\n') };
      const { doc } = resolveProjectFile(project, file.name);
      const context = projectFileContext(project, file);
      const usesInput = ['fsm', 'dag'].includes(file.kind) || (file.kind === 'model' && file.input !== undefined);
      const input = context.input && usesInput
        ? JSON.parse(context.input.text) : null;
      const widget = file.model || file.kind === 'model' ? 'data'
        : file.kind === 'app' ? 'app' : ['fsm', 'dag'].includes(file.kind) ? 'flow' : null;
      if (widget) return { ...base, stage: ['jaren-widget', { name: widget, key: file.name,
        props: { name: file.name, kind: file.kind, doc, input, revision: 1, files: project.files } }] };
      const result = runProjectFile(project, file.name);
      return result && !('then' in result) ? { ...base, nodes: result.nodes } : { ...base, stage: ['pre', {}, file.text] };
    }
    catch (error) { return { ...base, error: error.message }; }
  },
});
window.addEventListener('pagehide', () => { app.destroy(); data.dispose(); }, { once: true });
