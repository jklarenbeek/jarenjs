#!/usr/bin/env node
//@ts-check
/**
 * @file The `jaren-contract` command: compile a contract document and
 * print or write one of its projections — `describe` (the `describe()`
 * summary), `public` (the public projection), `openapi`, `types`
 * (TypeScript declarations), `docs` (Markdown) — with `--check` to fail
 * CI when a written artifact has drifted from what the document projects
 * today; plus `diff --from a.json --to b.json`, the classified change
 * report (docs/CONTRACT-FORMAT.md §13), whose `--fail-on <classes>`
 * makes it a compatibility gate. Exit codes: 0 current/written (diff:
 * no failing class), 1 drift under `--check` (diff: a `--fail-on` class
 * is non-empty), 2 a usage error, an unreadable document or a compile
 * refusal (printed as `code docPath message`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { compileContract } from './compile.js';
import { ContractCompileError, ContractHostError } from './errors.js';
import { diffContracts } from './diff.js';
import { publicProjection } from './public.js';
import { toOpenApi } from './project/openapi.js';
import { toTypeScript } from './project/typescript.js';
import { toMarkdown } from './project/markdown.js';

const USAGE = `jaren-contract — projections of a jaren-contract document

Usage:
  jaren-contract <command> --contract <file> [--out <dir|file>] [--check] [options]
  jaren-contract diff --from <file> --to <file> [--fail-on <class,…>]

Commands:
  describe   The describe() summary (JSON): every operation's resolved binding and policy
  public     The public projection (JSON): itself a $contract document — what a client needs, what the revision hashes
  openapi    An OpenAPI 3.1 document (JSON)
  types      TypeScript declarations (.d.ts): operation types, Operations, Client, Handlers
  docs       Markdown reference documentation
  diff       The classified changes from --from to --to (JSON: breaking, additive, neutral, unknown)

Options:
  --contract <file>     The $contract document (required except for diff)
  --out <dir|file>      Write here instead of printing; a directory gets <id>.<ext>
  --check               Do not write; exit 1 when the file at --out differs (for CI)
  --info-title <text>   openapi: the info.title (default: the contract id)
  --info-version <text> openapi: the info.version (default: the contract version)
  --lenient             openapi: drop and report keywords the projection would refuse
  --from <file>         diff: the contract consumers hold today
  --to <file>           diff: the contract they would meet
  --fail-on <class,…>   diff: exit 1 when any named class (breaking, additive, neutral, unknown) is non-empty
  --help                This text

Exit codes: 0 current or written (diff: no failing class), 1 drift under
--check (diff: a --fail-on class is non-empty), 2 a usage error, an
unreadable document, or a compile refusal (printed as code docPath message).

Examples:
  jaren-contract describe --contract shop.json
  jaren-contract openapi --contract shop.json --out api/ --info-title Shop
  jaren-contract types --contract shop.json --out src/shop.d.ts --check
  jaren-contract diff --from api/v1.json --to api/v2.json --fail-on breaking
`;

const COMMANDS = /** @type {const} */ ({
  describe: { extension: '.describe.json' },
  public: { extension: '.public.json' },
  openapi: { extension: '.openapi.json' },
  types: { extension: '.d.ts' },
  docs: { extension: '.md' },
});

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const options = {
    command: /** @type {string | null} */ (null), contract: /** @type {string | null} */ (null),
    out: /** @type {string | null} */ (null), check: false, help: false, lenient: false,
    infoTitle: /** @type {string | null} */ (null), infoVersion: /** @type {string | null} */ (null),
    from: /** @type {string | null} */ (null), to: /** @type {string | null} */ (null),
    failOn: /** @type {string | null} */ (null),
  };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--contract': options.contract = argv[++i] ?? null; break;
      case '--from': options.from = argv[++i] ?? null; break;
      case '--to': options.to = argv[++i] ?? null; break;
      case '--fail-on': options.failOn = argv[++i] ?? null; break;
      case '--out': options.out = argv[++i] ?? null; break;
      case '--check': options.check = true; break;
      case '--lenient': options.lenient = true; break;
      case '--info-title': options.infoTitle = argv[++i] ?? null; break;
      case '--info-version': options.infoVersion = argv[++i] ?? null; break;
      case '--help': case '-h': options.help = true; break;
      default:
        if (argv[i].startsWith('-')) throw new Error(`unknown option: ${argv[i]}`);
        if (options.command !== null) throw new Error(`unexpected argument: ${argv[i]}`);
        options.command = argv[i];
    }
  }
  return options;
}

/**
 * Write, or in `--check` mode compare and report. Returns true when the
 * file on disk already matches (the same messages as jaren-emit).
 * @param {string} file
 * @param {string} content
 * @param {boolean} check
 */
function writeOrCheck(file, content, check) {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (existing === content) return true;
  if (check) {
    console.error(existing === null ? `missing: ${file}` : `out of date: ${file}`);
    return false;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  console.log(`wrote ${file}`);
  return true;
}

/**
 * The output file: `--out` itself, or `<out>/<id><extension>` when it is
 * (or is spelled as) a directory.
 * @param {string} out
 * @param {string} id
 * @param {string} extension
 */
function outputFile(out, id, extension) {
  const isDir = out.endsWith('/') || out.endsWith(path.sep)
    || (fs.existsSync(out) && fs.statSync(out).isDirectory());
  return isDir ? path.join(out, id + extension) : out;
}

/**
 * @param {string} message
 * @param {boolean} [usage]
 */
function fail(message, usage = false) {
  console.error(`jaren-contract: ${message}`);
  if (usage) console.error(`\n${USAGE}`);
  process.exit(2);
}

/** The class names `--fail-on` may list. */
const DIFF_CLASSES = ['breaking', 'additive', 'neutral', 'unknown'];

/**
 * Read a contract document, exit 2 on an unreadable file.
 * @param {string} file
 * @param {string} flag
 */
function readDocument(file, flag) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  catch (error) {
    fail(`cannot read ${flag} '${file}': ${/** @type {Error} */ (error).message}`);
    return null; // unreachable — fail() exits
  }
}

/**
 * The `diff` command: classify the changes and print them; under
 * `--fail-on` exit 1 when a named class is non-empty.
 * @param {ReturnType<typeof parseArgs>} options
 */
function runDiff(options) {
  if (options.from === null || options.to === null) return fail('diff needs --from <file> and --to <file>', true);
  /** @type {string[]} */
  let failOn = [];
  if (options.failOn !== null) {
    failOn = options.failOn.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    for (const name of failOn) {
      if (!DIFF_CLASSES.includes(name)) return fail(`--fail-on '${name}' is not a change class (${DIFF_CLASSES.join(', ')})`, true);
    }
  }
  const from = readDocument(options.from, '--from');
  const to = readDocument(options.to, '--to');
  let diff;
  try {
    diff = diffContracts(from, to);
  }
  catch (error) {
    if (error instanceof ContractCompileError) return fail(`${error.code} ${error.docPath ?? ''} ${error.reason}`);
    throw error;
  }
  process.stdout.write(JSON.stringify(diff, null, 2) + '\n');
  const failing = failOn.filter((name) => diff[/** @type {keyof typeof diff} */ (name)].length > 0);
  if (failing.length > 0) {
    console.error(`diff: ${failing.map((name) => `${diff[/** @type {keyof typeof diff} */ (name)].length} ${name}`).join(', ')} change(s)`);
    process.exit(1);
  }
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv);
  }
  catch (error) {
    return fail(/** @type {Error} */ (error).message, true);
  }
  if (options.help) {
    console.log(USAGE);
    return;
  }
  if (options.command === 'diff') return runDiff(options);
  if (options.command === null || !Object.hasOwn(COMMANDS, options.command)) {
    return fail(options.command === null ? 'a command is required' : `unknown command '${options.command}'`, true);
  }
  const command = /** @type {keyof typeof COMMANDS} */ (options.command);
  if (options.contract === null) return fail('--contract <file> is required', true);
  if (options.check && options.out === null) return fail('--check needs --out', true);

  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(options.contract, 'utf8'));
  }
  catch (error) {
    return fail(`cannot read contract '${options.contract}': ${/** @type {Error} */ (error).message}`);
  }
  let rendered;
  try {
    const contract = compileContract(doc);
    switch (command) {
      case 'describe': rendered = JSON.stringify(contract.describe(), null, 2) + '\n'; break;
      case 'public': rendered = JSON.stringify(publicProjection(contract), null, 2) + '\n'; break;
      case 'openapi': {
        /** @type {Record<string, unknown>} */
        const info = {};
        if (options.infoTitle !== null) info.title = options.infoTitle;
        if (options.infoVersion !== null) info.version = options.infoVersion;
        const { document, dropped } = toOpenApi(contract, { info, lenient: options.lenient });
        for (const d of dropped) console.error(`dropped ${d.keyword} at ${d.docPath}: ${d.reason}`);
        rendered = JSON.stringify(document, null, 2) + '\n';
        break;
      }
      case 'types': rendered = toTypeScript(contract); break;
      case 'docs': rendered = toMarkdown(contract); break;
    }
    if (options.out === null) {
      process.stdout.write(rendered);
      return;
    }
    const file = outputFile(options.out, contract.id === null ? 'contract' : contract.id, COMMANDS[command].extension);
    if (!writeOrCheck(file, rendered, options.check)) {
      console.error('\nGenerated output is out of date. Run jaren-contract without --check.');
      process.exit(1);
    }
  }
  catch (error) {
    if (error instanceof ContractCompileError) {
      return fail(`${error.code} ${error.docPath ?? ''} ${error.reason}`);
    }
    if (error instanceof ContractHostError) return fail(`${error.code} ${error.reason}`);
    throw error;
  }
}

main();
