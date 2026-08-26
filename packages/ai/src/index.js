//@ts-check
/**
 * @file @jarenjs/ai — browser-side AI that makes sense: one
 * OpenAI-compatible chat client for OpenRouter / Ollama / LM Studio
 * (bring your own key — no server, no proxy), an embeddings client over
 * the same providers behind one embedder seam, an incremental SSE
 * decoder, a JSON-Schema-validated toolbox guarded by Jaren itself, a
 * bounded agent loop, and WebMCP (`navigator.modelContext`)
 * registration of the very same tools. See README.md.
 */

export { AiError } from './errors.js';
export { PROVIDERS, resolveEndpoint, probeProvider } from './providers.js';
export { createSseDecoder } from './sse.js';
export { createChatClient, createStreamAccumulator } from './client.js';
export { createEmbeddingClient, probeEmbeddings, createHashEmbedder } from './embed.js';
export { createStructuredOutput } from './structured.js';
export { checkOutcome, composeChecks, invalidInput } from './check.js';
export { createToolbox, registerModelContext } from './toolbox.js';
export { createAgent, transcriptText } from './agent.js';
export {
  RECALL_TOOL_NAME, createRecallTool, roundSlotName, indexSlotName,
  slotRef, slotAddress, slotAddressesIn,
} from './recall.js';
export { createLedger, sameIdentity, describeIdentity } from './ledger.js';
export {
  createEnvironment, environmentTools, chunkSlotName, chunkFamily, CHUNK_KIND,
} from './environment.js';
export {
  compileProgram, programGate, createProgramRunner, createProgramAuthor, ProgramError,
  PROGRAM_EXAMPLE,
} from './program.js';
export {
  createLongHorizonAgent, createBudgetAccount, createTrajectory, resolveDepth, childScope,
  MAX_DEPTH, DEFAULT_DEPTH,
} from './recursive.js';
export {
  createStylesheetAuthor, stylesheetSystemMessage, stylesheetGates, compileGate, literalBodyGate,
  nonEmptyGate, runGate, unknownOperatorGate, grammarKeywords,
  operatorArities, operatorNames, operatorCrib, describePaths,
  STYLESHEET_EXAMPLE,
} from './stylesheet.js';
export {
  createSpatialAuthor, spatialGates, prefixProximityGate, planarArithmeticGate, spatialOperatorGate,
  spatialCrib, spatialIntent, spatialSystemMessage, describeSpatialPaths, coordinateMembers,
  SPATIAL_OPERATORS, SPATIAL_EXAMPLE,
} from './spatial.js';
export {
  createGeoToolbox, geoToolDefs, overlayRefusal, GEO_TOOL_NAMES, OVERLAY_TOOL_NAMES,
  GEOJSON_SCHEMA_ID,
} from './geo-tools.js';
export { createRefiner, describeTrajectory } from './refine.js';
export { createMemoryStorage } from './storage/memory.js';
export {
  LEDGER_SCHEMAS, GOAL_SCHEMA, MEMORY_SCHEMA, SKILL_SCHEMA, SLOT_SCHEMA,
} from './schemas/ledger.js';
export {
  REFINEMENT_PATCH_SCHEMA, refinementPatchSchema, REFINEMENT_PATH_PATTERN, DEFAULT_MAX_OPS,
  MEMORY_PROPOSAL_SCHEMA, SKILL_PROPOSAL_SCHEMA, PROGRESS_PROPOSAL_SCHEMA,
} from './schemas/patch.js';
export {
  PROGRAM_SCHEMA, programSchema, PROGRAM_OPS, MAX_STEPS, MAX_PROGRAM_CHARS, NAME_PATTERN,
} from './schemas/program.js';
