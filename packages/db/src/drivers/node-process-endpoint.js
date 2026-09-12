//@ts-check
/** The child owns SQLite; only bounded protocol frames cross IPC. */
import { serveSqliteEndpoint } from './sqlite-endpoint.js';

process.once('message', (configuration) => {
  const port = {
    postMessage: (message) => { if (process.connected) process.send(message); },
    on: (name, listener) => process.on(name, listener),
    close: () => { if (process.connected) process.disconnect(); },
  };
  serveSqliteEndpoint(port, configuration);
});
process.once('disconnect', () => process.exit(0));
