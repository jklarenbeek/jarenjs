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
   * @param {{ status?: number, attempts?: number, retryAfterMs?: number,
   *   cause?: unknown }} [meta] - transport metadata: the HTTP status
   *   (`0` for a network failure before any response), how many tries
   *   the client made, and the provider's `Retry-After` in ms
   */
  constructor(code, message, meta) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    if (meta !== undefined) {
      if (meta.status !== undefined) this.status = meta.status;
      if (meta.attempts !== undefined) this.attempts = meta.attempts;
      if (meta.retryAfterMs !== undefined) this.retryAfterMs = meta.retryAfterMs;
      if (meta.cause !== undefined) this.cause = meta.cause;
    }
  }
}
