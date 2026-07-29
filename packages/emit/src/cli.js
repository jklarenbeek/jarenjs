#!/usr/bin/env node
//#region the jaren-emit command
// Nobody wires a code generator through its API by hand, so the CLI is what
// makes this adoptable: point it at a directory of schemas, get a directory
// of declarations, and put the command in `prebuild`.

import * as fs from 'fs';
import * as path from 'path';

import { compileEmitModel } from './model.js';
import { renderTypeScript } from './typescript.js';
import { renderMarkdown } from './markdown.js';

const TARGETS = {
  typescript: { render: renderTypeScript, extension: '.d.ts' },
  markdown: { render: renderMarkdown, extension: '.md' },
};

const USAGE = `jaren-emit — build-time artifacts from JSON Schema

Usage:
  jaren-emit --schema <file|dir> --out <dir> [options]

Options:
  --schema <path>   A .json schema file, or a directory of them (required)
  --out <dir>       Where to write the generated files (required)
  --target <name>   typescript (default) or markdown
  --name <Name>     Root declaration name for a single schema (default: file name)
  --bundle <file>   Write every schema into one output file instead of one each
  --check           Do not write; exit 1 if any output would differ (for CI)
  --defaults        Emit accepted/normalized variants for schema defaults
  --coerce          Emit accepted/normalized variants for type coercion
  --suffix <s>      Name for the accepted variant (default: Input)
  --help            This text

The --defaults/--coerce flags mirror the compileNormalizer options of the same
name. With either on, a type whose shape differs before and after normalizing
gains a second declaration: Config is what you have afterwards, ConfigInput is
what a caller may hand in.

Examples:
  jaren-emit --schema ./schemas --out ./src/types
  jaren-emit --schema ./schemas/user.json --out ./types --name User
  jaren-emit --schema ./schemas --out ./src/types --check
`;

function parseArgs(argv) {
  const options = {
    schema: null, out: null, target: 'typescript',
    name: null, bundle: null, check: false, help: false,
    defaults: false, coerce: false, suffix: 'Input',
  };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--schema': options.schema = argv[++i]; break;
      case '--out': options.out = argv[++i]; break;
      case '--target': options.target = argv[++i]; break;
      case '--name': options.name = argv[++i]; break;
      case '--bundle': options.bundle = argv[++i]; break;
      case '--check': options.check = true; break;
      case '--defaults': options.defaults = true; break;
      case '--coerce': options.coerce = true; break;
      case '--suffix': options.suffix = argv[++i]; break;
      case '--help': case '-h': options.help = true; break;
      default:
        throw new Error(`unknown option: ${argv[i]}`);
    }
  }
  return options;
}

/** Every `.json` file the `--schema` path names, in sorted order so the
 * output is the same whatever the filesystem feels like returning. */
function collectSchemaFiles(target) {
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return [target];
  return fs.readdirSync(target)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => path.join(target, f));
}

/** PascalCase the file's base name, so `user-account.json` becomes
 * `UserAccount` — the name a reader would have chosen. */
function nameFromFile(file) {
  const base = path.basename(file).replace(/\.schema\.json$|\.json$/, '');
  return base.split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join('') || 'Root';
}

/** Write, or in `--check` mode compare and report. Returns true when the
 * file on disk already matches. */
function writeOrCheck(file, content, check) {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (existing === content) return true;
  if (check) {
    console.error(existing === null
      ? `missing: ${file}`
      : `out of date: ${file}`);
    return false;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  console.log(`wrote ${file}`);
  return true;
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv);
  }
  catch (error) {
    console.error(error.message);
    console.error(USAGE);
    process.exit(2);
    return;
  }

  if (options.help) {
    console.log(USAGE);
    return;
  }
  if (options.schema === null || options.out === null) {
    console.error('both --schema and --out are required\n');
    console.error(USAGE);
    process.exit(2);
    return;
  }
  const target = TARGETS[options.target];
  if (target === undefined) {
    console.error(`unknown target '${options.target}'; expected one of ${Object.keys(TARGETS).join(', ')}`);
    process.exit(2);
    return;
  }

  const files = collectSchemaFiles(options.schema);
  if (files.length === 0) {
    console.error(`no .json schemas under ${options.schema}`);
    process.exit(2);
    return;
  }

  // Only pass normalize options when at least one is on: a null here is what
  // tells the model to emit a single declaration per type rather than a pair.
  const normalizeOptions = options.defaults || options.coerce
    ? { useDefaults: options.defaults, coerceTypes: options.coerce }
    : null;

  let ok = true;
  const bundled = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
    const name = options.name ?? nameFromFile(file);
    const model = compileEmitModel(schema, {
      name, source: path.basename(file),
      normalize: normalizeOptions, variantSuffix: options.suffix,
    });
    if (options.bundle !== null) {
      bundled.push(...model.declarations);
      continue;
    }
    const out = path.join(options.out, nameFromFile(file) + target.extension);
    ok = writeOrCheck(out, target.render(model), options.check) && ok;
  }

  if (options.bundle !== null) {
    const model = { $emit: '0.1', source: options.schema, root: null, declarations: bundled };
    const out = path.join(options.out, options.bundle);
    ok = writeOrCheck(out, target.render(model), options.check) && ok;
  }

  if (!ok) {
    console.error('\nGenerated output is out of date. Run jaren-emit without --check.');
    process.exit(1);
  }
}

main();

//#endregion
