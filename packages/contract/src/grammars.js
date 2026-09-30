//@ts-check
/**
 * @file The naming grammars of a `$contract` document (docs/CONTRACT-FORMAT.md
 * §3.1) — one table, as anchored regular-expression sources: the compiler
 * checks the contract id, operation ids and declared codes against it,
 * `contractTools` checks tool names, the path parser's identifier check is
 * the `pathVariable` grammar, the documents print it, and
 * `@jarenjs/linq/contract` mirrors it (linq depends on core and json only,
 * so it carries copies a test holds to this table).
 */

export const CONTRACT_GRAMMARS = Object.freeze({
  /** The contract `id`: an identifier that may carry hyphens. */
  contractId: '^[A-Za-z_][A-Za-z0-9_-]*$',
  /** An operation id: dotted lowercase words (`product.save`). */
  operationId: '^[a-z][a-z0-9]*(\\.[a-z][a-z0-9]*)*$',
  /** A declared error code: lowercase words of letters, digits, hyphens
   * and underscores, dotted for namespacing (`ai.rate-limited`). A `/` is
   * refused, because message ids are `contract/error/<code>`; lowercase-first
   * keeps a declared code from ever spelling a binding's `JC…` code. */
  errorCode: '^[a-z][a-z0-9_-]*(\\.[a-z][a-z0-9_-]*)*$',
  /** A path variable name (`{id}`). */
  pathVariable: '^[A-Za-z_][A-Za-z0-9_]*$',
  /** A tool name: OpenAI's function-name constraint, which WebMCP's satisfies. */
  toolName: '^[a-zA-Z0-9_-]{1,64}$',
});
