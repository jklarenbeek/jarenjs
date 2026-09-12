/** Node/Bun qualification of the independently installed component closure. */
import { MessageChannel } from 'node:worker_threads';
import { servePort } from '@jarenjs/contract/port';
import { nodeDriver } from '@jarenjs/db/node';
import { bunDriver } from '@jarenjs/db/bun';
import { createDataHandlers, dataContract } from '@jarenjs/studio/data/host';
import { createTransport } from '@jarenjs/studio/data';
import { createStubHost, serialize } from '../view/dom.stub.js';
import { mountInstalledEditors, qualifyInstalledEditors } from './studio-installed.js';
const releases = [];
const spawnWorker = () => {
  const { port1, port2 } = new MessageChannel();
  const driver = () => globalThis.Bun ? bunDriver() : nodeDriver();
  const table = createDataHandlers({ init: async () => ({ topology: 'memory', vfs: 'memory', version: '3' }),
    makeDriver: driver, makeScratchDriver: driver, path: () => ':memory:', vfs: () => 'memory', durable: () => false,
    unlink() {}, announce: notice => port1.postMessage(notice), operators: undefined,
  });
  const server = servePort(dataContract, table.handlers, { channel: port1 });
  let closed = false;
  port2.terminate = () => { if (closed) return; closed = true; server.close(); port1.close(); port2.close(); releases.push(table.dispose()); };
  queueMicrotask(() => port1.postMessage({ ready: true })); return port2;
};
const { container } = createStubHost();
const editors = mountInstalledEditors(container, { schedule: f => f(), createProjectWorker: spawnWorker,
  transport: () => createTransport({ spawnWorker, openChannel() { throw new Error('An isolated store cannot join a peer.'); } }),
});
try {
  await qualifyInstalledEditors(editors);
  if (!serialize(container).includes('installed')) throw new Error('The installed view did not render the accepted document.');
}
finally { editors.dispose(); await Promise.all(releases); }
if (container.childNodes.some(node => node.tagName === 'section' && node.childNodes.length > 0)) throw new Error('An editor survived disposal.');
