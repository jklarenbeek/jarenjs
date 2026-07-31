//@ts-check
/**
 * @file @jarenjs/flow — executable workflow documents over the
 * @jarenjs/json engines: the jaren-fsm finite-state-machine format
 * compiled to a pure step function. See README.md and
 * docs/FLOW-FORMAT.md.
 */

export { compileFsm, createFsmSession } from './fsm.js';
export { fsmToApp, fsmStateSchema } from './app.js';
export { FlowCompileError, FlowRuntimeError } from './errors.js';
