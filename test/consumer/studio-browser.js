/* global Worker */
import '@jarenjs/studio/styles/studio.css';
import '@jarenjs/studio/styles/data.css';
import { createTransport } from '@jarenjs/studio/data';
import { mountInstalledEditors, qualifyInstalledEditors } from './studio-installed.js';
const editors = mountInstalledEditors(globalThis.document.getElementById('editors'), {
  lifecycleTarget: globalThis,
  createProjectWorker: () => new Worker(new URL('./studio-project-worker.js', import.meta.url), { type: 'module' }),
  transport: () => createTransport({
    spawnWorker: () => new Worker(new URL('./studio-data-worker.js', import.meta.url), { type: 'module' }),
    openChannel: () => new BroadcastChannel('jaren-installed-editor-data'),
  }),
});
globalThis.editors = editors;
qualifyInstalledEditors(editors).then(result => {
  globalThis.editorReceipt = result; globalThis.document.getElementById('status').textContent = 'Installed editors passed';
}, error => { globalThis.document.getElementById('status').textContent = String(error); throw error; });
