//@ts-check
/**
 * The @jarenjs/ai error type. Every failure the package itself raises
 * carries a stable code, like the rest of the suite:
 *
 *   AI0001 — invalid configuration or request (caller error)
 *   AI0002 — the provider answered with an HTTP error status
 *   AI0003 — the provider answered with a malformed payload
 *
 * Tool execution and the agent loop never throw for content-level
 * problems (an unknown tool, invalid tool input, a tool that throws) —
 * those come back as `{ error }` results the model can read and
 * recover from. AiError is reserved for the transport and for misuse.
 */

export class AiError extends Error {
  /**
   * @param {string} code - stable error code ('AI0001' | 'AI0002' | 'AI0003')
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'AiError';
    this.code = code;
  }
}
