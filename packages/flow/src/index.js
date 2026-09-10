//@ts-check
/**
 * @file @jarenjs/flow — executable workflow documents over the
 * @jarenjs/json engines: the jaren-fsm finite-state-machine format
 * compiled to a pure step function. See README.md and
 * docs/FLOW-FORMAT.md.
 */

export { compileFsm, createFsmSession } from './fsm.js';
export { fsmToApp, fsmStateSchema } from './app.js';
export { compileDag } from './dag.js';
export { compileStatechart, createStatechartSession } from './statechart.js';
export { lowerWorkflow, compileWorkflow } from './workflow.js';
export { createIngestion } from './ingest.js';
export { snapshotFsm, resumeFsmSession, createDurableFsmSession } from './persist.js';
export { FlowCompileError, FlowRuntimeError, FLOW_CODES } from './errors.js';

/** @typedef {import('./statechart.js').StatechartState} StatechartState */
/** @typedef {import('./statechart.js').StatechartResult} StatechartResult */
/** @typedef {import('./statechart.js').CompiledStatechart} CompiledStatechart */
/** @typedef {import('./workflow.js').LoweredWorkflow} LoweredWorkflow */
/** @typedef {import('./workflow.js').WorkflowSnapshot} WorkflowSnapshot */
/** @typedef {import('./workflow.js').WorkflowStore} WorkflowStore */
/** @typedef {import('./workflow.js').WorkflowResult} WorkflowResult */
/** @typedef {import('./workflow.js').CompiledWorkflow} CompiledWorkflow */
