//@ts-check
/**
 * @file @jarenjs/ai — browser-side AI that makes sense: one
 * OpenAI-compatible chat client for OpenRouter / Ollama / LM Studio
 * (bring your own key — no server, no proxy), an incremental SSE
 * decoder, a JSON-Schema-validated toolbox guarded by Jaren itself, a
 * bounded agent loop, and WebMCP (`navigator.modelContext`)
 * registration of the very same tools. See README.md.
 */

export { AiError } from './errors.js';
export { PROVIDERS, resolveEndpoint, probeProvider } from './providers.js';
export { createSseDecoder } from './sse.js';
export { createChatClient, createStreamAccumulator } from './client.js';
export { createStructuredOutput } from './structured.js';
export { checkOutcome, composeChecks } from './check.js';
export { createToolbox, registerModelContext } from './toolbox.js';
export { createAgent } from './agent.js';
