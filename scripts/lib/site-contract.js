//@ts-check
/**
 * The site's data-plane contract, on the build side.
 *
 * `packages/website/src/contracts/site.contract.json` is the one place
 * the shapes of the site's own artifacts are written down, and the
 * browser already reads every one of them through it. This module is the
 * other end of that grammar: the generators that WRITE those artifacts
 * prove their payload against the very same compiled document before it
 * reaches disk, so a shape can no longer drift into a file and be
 * discovered by a reader.
 *
 * The document stays where it lives — a website source file, imported by
 * `packages/website/src/boundaries/site.js` for the browser. Nothing
 * here imports the website; the contract is read as JSON and compiled
 * with `@jarenjs/contract` directly, which is also what keeps this
 * usable from the benchmark workspace.
 *
 * A refusal here is deliberately loud: `JC2010` is the code the contract
 * pipeline itself raises when a value fails the output schema of its
 * operation, so the generator's message names the same fault the browser
 * would report (as a `JC2070` contract refusal) had the file shipped.
 */

import { readFileSync } from 'node:fs';

import { compileContract } from '@jarenjs/contract';

/** The document's repo-relative home, as messages name it. */
export const SITE_CONTRACT_PATH = 'packages/website/src/contracts/site.contract.json';

const DOC_URL = new URL(`../../${SITE_CONTRACT_PATH}`, import.meta.url);

/** @type {any} */
let compiled = null;

/**
 * The compiled site contract, compiled at most once per process — the
 * generators call this per payload and compilation is the expensive half.
 * @returns {any}
 */
export function siteContract() {
  if (compiled === null) {
    compiled = compileContract(JSON.parse(readFileSync(DOC_URL, 'utf8')));
  }
  return compiled;
}

/**
 * One validation error, as a line a reader can act on: where in the
 * payload, and which keyword refused it.
 * @param {any} error
 * @returns {string}
 */
function line(error) {
  const at = typeof error?.instancePath === 'string' && error.instancePath !== ''
    ? error.instancePath
    : '(root)';
  const keyword = typeof error?.keyword === 'string' ? error.keyword : 'invalid';
  const message = typeof error?.message === 'string' ? `: ${error.message}` : '';
  return `  ${at} — ${keyword}${message}`;
}

/**
 * Check a payload against the output schema an operation declares.
 * @param {string} op - the operation id, e.g. `'site.packages'`.
 * @param {unknown} value
 * @returns {{ valid: boolean, errors: any[] }}
 */
export function checkSiteOutput(op, value) {
  const contract = siteContract();
  const operation = contract.operations[op];
  if (operation === undefined) {
    throw new Error(`${SITE_CONTRACT_PATH} declares no operation '${op}'`);
  }
  const result = operation.output.validate(value);
  if (typeof result === 'boolean') return { valid: result, errors: [] };
  return { valid: result.valid === true, errors: Array.isArray(result.errors) ? result.errors : [] };
}

/**
 * Prove a payload against its operation's output schema, or refuse to
 * let it be written. The generator and the browser declare that shape in
 * ONE document, so this is not a second opinion — it is the same
 * validator, run before the file exists rather than after it shipped.
 * @param {string} op - the operation the site reads this artifact through.
 * @param {unknown} value - the payload about to be serialized.
 * @param {string} target - the file the caller is about to write, for the message.
 * @returns {unknown} the payload, unchanged, so a caller can wrap the write.
 * @throws {Error} naming the `JC` code, the contract member and every failing path.
 */
export function assertSiteOutput(op, value, target) {
  const { valid, errors } = checkSiteOutput(op, value);
  if (valid) return value;
  const where = `/operations/${op}/output`;
  throw new Error(
    `JC2010: the payload for ${target} fails the output schema of '${op}'`
    + ` (${SITE_CONTRACT_PATH}${where})\n`
    + `${errors.map(line).join('\n')}\n`
    + 'The generator and the browser read this artifact through the same document:'
    + ' change the contract in the same commit as the payload, or fix the payload.');
}
