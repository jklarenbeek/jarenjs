//@ts-check
import { createFlowRuntime as createRuntime, flowPageViewModel as viewModel } from '@jarenjs/studio/flow';
import { flowTemplate, FLOW_TEMPLATES } from '../content/flowTemplates.js';
export { memberAt, flowText, textLossReason } from '@jarenjs/studio/flow';
/** A signal-aware pause for the demo task registry. */
function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('aborted')); return; }
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    }, { once: true });
  });
}

/** The dag demo registry — pure and local, no network. */
const DEMO_TASKS = {
  lookup: async ({ input }, signal) => {
    await wait(350, signal);
    return (Array.isArray(input) ? input : []).map((r) => ({ ...r, region: 'eu' }));
  },
};


export const createFlowRuntime = (env = {}) => createRuntime({ template: flowTemplate, tasks: DEMO_TASKS, ...env });
export const flowPageViewModel = flow => viewModel(flow, FLOW_TEMPLATES);
