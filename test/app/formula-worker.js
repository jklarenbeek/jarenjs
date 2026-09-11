import { parentPort } from 'node:worker_threads';
parentPort.on('message', (message) => {
  if (message.payload.runaway) { while (true) { /* Deliberately noncooperative host helper. */ } }
  parentPort.postMessage({ ...message, result: { kind: 'value', value: 3 } });
});
