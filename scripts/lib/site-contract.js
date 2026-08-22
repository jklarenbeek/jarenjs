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
import { JarenValidator } from '@jarenjs/validate';

/** The document's repo-relative home, as messages name it. */
export const SITE_CONTRACT_PATH = 'packages/website/src/contracts/site.contract.json';

const DOC_URL = new URL(`../../${SITE_CONTRACT_PATH}`, import.meta.url);

/** @type {any} */
let compiled = null;

/** @type {any} */
let document = null;

/** The document as JSON, read at most once per process. */
function siteDocument() {
  if (document === null) document = JSON.parse(readFileSync(DOC_URL, 'utf8'));
  return document;
}

/**
 * The compiled site contract, compiled at most once per process — the
 * generators call this per payload and compilation is the expensive half.
 * @returns {any}
 */
export function siteContract() {
  if (compiled === null) compiled = compileContract(siteDocument());
  return compiled;
}

/**
 * The `$defs` member that declares one benchmark suite's payload.
 * `bench.suite` answers exactly one of them, so a generator writing a
 * suite file can be held to ITS shape rather than to the whole union —
 * which is the difference between a refusal that names the member at
 * fault and one that lists twenty-one ways the payload is not something
 * else. The name is derived from the suite key, and the website test
 * suite pairs the two sets so neither can grow a member alone.
 * @param {string} suite - a suite key, e.g. `'long-horizon'`.
 * @returns {string}
 */
export function suiteShapeName(suite) {
  return `Suite${suite.split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('')}`;
}

/** @type {Map<string, (value: unknown) => any>} */
const suiteValidators = new Map();

/**
 * The compiled validator for one suite's declared shape.
 * @param {string} suite
 * @returns {(value: unknown) => any}
 * @throws {Error} when the document declares no shape for that suite.
 */
function suiteValidator(suite) {
  let validate = suiteValidators.get(suite);
  if (validate === undefined) {
    const doc = siteDocument();
    const name = suiteShapeName(suite);
    if (doc.$defs?.[name] === undefined) {
      throw new Error(`${SITE_CONTRACT_PATH} declares no shape '${name}' for the '${suite}' suite.`
        + ' A published suite needs its shape in the same document the browser reads it through:'
        + ' add it to $defs and to the oneOf of operations/bench.suite/output.');
    }
    validate = new JarenValidator({ skipErrors: false, collectErrors: true })
      .compile({ $ref: `#/$defs/${name}`, $defs: doc.$defs });
    suiteValidators.set(suite, validate);
  }
  return validate;
}

/**
 * Prove one benchmark suite's payload against the shape this document
 * declares for it, or refuse to let it be written. `bench.suite` reads
 * every suite through the same document, so a member the generator adds,
 * renames or retypes has to land with the contract change — the point
 * being that it is caught here, at the write, rather than as a wrong
 * render weeks later.
 * @param {string} suite - the suite key the file is named for.
 * @param {unknown} value - the payload about to be serialized.
 * @param {string} target - the file the caller is about to write.
 * @returns {unknown} the payload, unchanged.
 * @throws {Error} naming the `JC` code, the shape and every failing path.
 */
export function assertSuiteOutput(suite, value, target) {
  const name = suiteShapeName(suite);
  const result = suiteValidator(suite)(value);
  if (result.valid === true) return value;
  const errors = Array.isArray(result.errors) ? result.errors : [];
  throw new Error(
    `JC2010: the payload for ${target} fails the '${name}' shape of 'bench.suite'`
    + ` (${SITE_CONTRACT_PATH}/$defs/${name})\n`
    + `${errors.map(line).join('\n')}\n`
    + 'The generator and the browser read this suite through the same document:'
    + ' change the contract in the same commit as the payload, or fix the payload.');
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
