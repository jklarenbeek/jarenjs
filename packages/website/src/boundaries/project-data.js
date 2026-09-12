//@ts-check
import { createProjectDataRuntime as runtime } from '@jarenjs/studio/data';
export const createProjectDataRuntime = (options = {}) => runtime({ ...options,
  createWorker: options.createWorker ?? (() => new Worker(new URL('../project-db-worker.js', import.meta.url), { type: 'module' })),
});
