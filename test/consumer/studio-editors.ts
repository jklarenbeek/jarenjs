import { createProjectHost, createStudioDocumentHost, mountStudioEditor } from '@jarenjs/studio/component';
import { mountFlowEditor } from '@jarenjs/studio/flow';
import { mountDataEditor, createTransport } from '@jarenjs/studio/data';
import { createBrowserDataWorker, createProjectDataWorker, dataContractDocument } from '@jarenjs/studio/data/host';

const documentHost = createStudioDocumentHost({ markdown: source => ['p', {}, source], diagram: source => ['pre', {}, source] });
const host = createProjectHost({ loadDocument: documentHost.loadStudioDocument,
  runQuery: () => [], runJslt: () => [], runValidation: () => ({ valid: true, errors: [] }) });
const project = mountStudioEditor(null, { host, project: { project: '0.1', name: 'Example', files: [{ name: 'data', kind: 'data', text: '{}' }], active: 'data' } });
const stageRevision: number = project.read().stageRevision; void stageRevision;
void project.run(undefined, { restart: false });
// @ts-expect-error restart is boolean
void project.run(undefined, { restart: 'yes' });
const projectRevision: string = project.read().revision;
project.subscribe(snapshot => { const revision: string = snapshot.revision; void revision; });
void project.replace(project.read().document, { expectedRevision: projectRevision }).then(receipt => { const ok: boolean = receipt.ok; void ok; });
void project.apply([], { expectedRevision: projectRevision });
const flow = mountFlowEditor(null, { kind: 'fsm', document: { initial: 'a', states: ['a'], transitions: [] }, tasks: {} });
flow.subscribe(snapshot => { const revision: string = snapshot.revision; void revision; });
void flow.replace(flow.read().document, { expectedRevision: flow.read().revision });
void flow.run({ input: { events: [] } }).then(receipt => { const ok: boolean = receipt.ok; void ok; });
const data = mountDataEditor(null, { model: { $model: '0.1', collections: {} }, query: [], transport: () => createTransport({ spawnWorker: () => ({}), openChannel: () => ({}) }) });
data.subscribe(snapshot => { const revision: string = snapshot.revision; const buffer: string = snapshot.buffers.queryText; void [revision, buffer]; });
void data.replace(data.read().document, { expectedRevision: data.read().revision });
void data.run({ operation: 'query', externals: { limit: 4 } }).then(receipt => { const ok: boolean = receipt.ok; void ok; });
void data.setActive(false).then(receipt => { const ok: boolean = receipt.ok; void ok; });
void data.setActive(true);
// @ts-expect-error activation is boolean
void data.setActive(1);
// @ts-expect-error revisions are strings
void data.apply([], { expectedRevision: 2 });
// @ts-expect-error operation names are closed
void data.run({ operation: 'eval' });
// @ts-expect-error Flow document kinds are closed
void flow.replace({}, { expectedRevision: flow.read().revision, kind: 'graph' });
void createBrowserDataWorker; void createProjectDataWorker; void dataContractDocument;
project.dispose(); flow.dispose(); data.dispose();
