/** An independent application: every editor and worker service comes from public package entries. */
import { fileSkeleton } from '@jarenjs/studio';
import { createStudioDocumentHost, createProjectHost, mountStudioEditor, code } from '@jarenjs/studio/component';
import { mountFlowEditor } from '@jarenjs/studio/flow';
import { mountDataEditor, createProjectDataRuntime } from '@jarenjs/studio/data';
import { compileJsonQuery } from '@jarenjs/json';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import { JarenValidator } from '@jarenjs/validate';
export const model = { $model: '0.1', collections: { items: { schema: { type: 'object', properties: { id: { type: 'string' }, value: { type: 'integer' } } }, key: '/id' } } };
export const query = [{ $for: { item: '$[*]' }, $return: '$item' }];
export function mountInstalledEditors(root, options) {
  const section = name => {
    const node = root.ownerDocument.createElement('section'); node.setAttribute('id', name);
    const title = root.ownerDocument.createElement('h2'); title.textContent = name;
    root.appendChild(title); root.appendChild(node); return node;
  };
  const documentHost = createStudioDocumentHost({ markdown: source => ['p', {}, source], diagram: source => ['pre', {}, source] });
  const host = createProjectHost({ loadDocument: documentHost.loadStudioDocument,
    runQuery: ({ query, data }) => [code('Query', JSON.stringify(compileJsonQuery(JSON.parse(query))(JSON.parse(data))))],
    runJslt: ({ stylesheet, data }) => [code('Stylesheet', JSON.stringify(compileJsltStylesheet(JSON.parse(stylesheet))(JSON.parse(data))))],
    runValidation: ({ schema, data }) => ({ valid: new JarenValidator().compile(JSON.parse(schema))(JSON.parse(data)), errors: [] }),
  });
  const projectData = createProjectDataRuntime({ createWorker: options.createProjectWorker });
  const project = mountStudioEditor(section('project'), { host, projectData, schedule: options.schedule, debounceMs: 0,
    project: { project: '0.1', name: 'Installed project', files: [{ name: 'app', kind: 'app', text: fileSkeleton('app') }], active: 'app' },
  });
  const flow = mountFlowEditor(section('flow'), { kind: 'fsm', document: JSON.parse(fileSkeleton('fsm')), schedule: options.schedule });
  const data = mountDataEditor(section('data'), { model, query, transport: options.transport,
    seeds: [{ id: 'installed', value: 24 }], schedule: options.schedule, lifecycleTarget: options.lifecycleTarget ?? {},
  });
  return { project, flow, data, dispose() { project.dispose(); flow.dispose(); data.dispose(); } };
}
export async function qualifyInstalledEditors(editors) {
  if (!(await editors.data.ready).ok) throw new Error('The installed Data host did not boot.');
  const result = await editors.data.run();
  if (!result.ok || result.result?.[0]?.value !== 24 || !result.explain.sql.includes('SELECT')) throw new Error('The installed driver did not execute and explain the query.');
  const p = editors.project.read();
  if (!(await editors.project.apply([{ op: 'replace', path: '/name', value: 'Published components' }], { expectedRevision: p.revision })).ok) throw new Error('Project publication failed.');
  const f = editors.flow.read();
  if (!(await editors.flow.apply([{ op: 'add', path: '/states/-', value: 'installed' }], { expectedRevision: f.revision })).ok) throw new Error('Flow publication failed.');
  const stale = await editors.flow.replace(f.document, { expectedRevision: f.revision });
  if (!stale.conflict) throw new Error('The installed editor accepted a stale revision.');
  return { value: result.result[0].value, sql: result.explain.sql, project: editors.project.read().document.name };
}
