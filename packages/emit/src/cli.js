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
import { buildImportMap } from './importmap.js';

const TARGETS = {
  typescript: { render: renderTypeScript, extension: '.d.ts' },
  markdown: { render: renderMarkdown, extension: '.md' },
};

const USAGE = `jaren-emit — build-time artifacts from JSON Schema

Usage:
  jaren-emit --schema <file|dir> --out <dir> [options]
  jaren-emit importmap --packages <names> [importmap options]

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

importmap options — serve installed packages unbundled:
  --packages <a,b>     Package names, comma separated; a bare name is a suite
                       package (app is @jarenjs/app). Their dependencies follow.
  --prefix <url>       The URL root/node_modules is served under (default /node_modules/)
  --root <dir>         The directory holding node_modules (default .)
  --conditions <a,b>   Export conditions, in preference (default browser,import,default)
  --files              Print the files a server must serve, one per line,
                       instead of the import map
  --allow-duplicates   Print even when a package is installed more than once

The import map is printed to stdout. A package installed twice, or an import
the map cannot resolve, is reported on stderr with exit code 1.

Examples:
  jaren-emit --schema ./schemas --out ./src/types
  jaren-emit --schema ./schemas/user.json --out ./types --name User
  jaren-emit --schema ./schemas --out ./src/types --check
  jaren-emit importmap --packages app,view --prefix /vendor/ > importmap.json
`;

/**
 * The importmap subcommand: options in, the map (or the file list) out.
 * @param {string[]} argv - the arguments after `importmap`
 * @returns {number} the exit code
 */
function importmapCommand(argv) {
  const options = { packages: /** @type {string[] | null} */ (null), prefix: '/node_modules/', root: '.',
    conditions: /** @type {string[] | undefined} */ (undefined), files: false, allowDuplicates: false };
  for (let i = 0; i < argv.length; i++) {
    const value = () => {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new Error(`${argv[i]} requires a value`);
      i++;
      return next;
    };
    switch (argv[i]) {
      case '--packages': options.packages = value().split(',').map((name) => name.trim()).filter(Boolean); break;
      case '--prefix': options.prefix = value(); break;
      case '--root': options.root = value(); break;
      case '--conditions': options.conditions = value().split(',').map((name) => name.trim()).filter(Boolean); break;
      case '--files': options.files = true; break;
      case '--allow-duplicates': options.allowDuplicates = true; break;
      case '--help': case '-h': console.log(USAGE); return 0;
      default: throw new Error(`unknown importmap option: ${argv[i]}`);
    }
  }
  if (options.packages === null || options.packages.length === 0) throw new Error('importmap needs --packages');
  const result = buildImportMap({ packages: options.packages, root: options.root, prefix: options.prefix,
    ...(options.conditions === undefined ? {} : { conditions: options.conditions }) });
  let failed = false;
  for (const { name, paths } of result.duplicates) {
    console.error(`${options.allowDuplicates ? 'warning' : 'error'}: ${name} is installed more than once: ${paths.join(', ')}`);
    if (!options.allowDuplicates) failed = true;
  }
  for (const { specifier, from } of result.unresolved) {
    console.error(`error: ${from} imports ${specifier}, which the map does not resolve`);
    failed = true;
  }
  if (failed) {
    if (result.duplicates.length > 0 && !options.allowDuplicates) {
      console.error('a package installed twice runs twice in the browser; dedupe the install, or pass --allow-duplicates to serve the copy nearest the root');
    }
    return 1;
  }
  process.stdout.write(options.files ? result.files.join('\n') + '\n'
    : JSON.stringify({ imports: result.imports }, null, 2) + '\n');
  return 0;
}

function parseArgs(argv) {
  const options = {
    schema: null, out: null, target: 'typescript',
    name: null, bundle: null, check: false, help: false,
    defaults: false, coerce: false, suffix: 'Input',
  };
  for (let i = 2; i < argv.length; i++) {
    const value = () => {
      const option = argv[i];
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-'))
        throw new Error(`${option} requires a value`);
      i++;
      return next;
    };
    switch (argv[i]) {
      case '--schema': options.schema = value(); break;
      case '--out': options.out = value(); break;
      case '--target': options.target = value(); break;
      case '--name': options.name = value(); break;
      case '--bundle': options.bundle = value(); break;
      case '--check': options.check = true; break;
      case '--defaults': options.defaults = true; break;
      case '--coerce': options.coerce = true; break;
      case '--suffix': options.suffix = value(); break;
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
  if (process.argv[2] === 'importmap') {
    try {
      process.exitCode = importmapCommand(process.argv.slice(3));
    }
    catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      console.error(USAGE);
      process.exitCode = 2;
    }
    return;
  }
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

  // Validate the whole output plan before writing: different schema names
  // can collapse onto the same PascalCase filename.
  if (options.bundle === null) {
    const destinations = new Map();
    for (const file of files) {
      const out = path.join(options.out, nameFromFile(file) + target.extension);
      const destination = process.platform === 'win32' ? out.toLowerCase() : out;
      const previous = destinations.get(destination);
      if (previous !== undefined) {
        console.error(`output collision: '${previous}' and '${file}' both write '${out}'`);
        process.exit(2);
        return;
      }
      destinations.set(destination, file);
    }
  }

  // Only pass normalize options when at least one is on: a null here is what
  // tells the model to emit a single declaration per type rather than a pair.
  const normalizeOptions = options.defaults || options.coerce
    ? { useDefaults: options.defaults, coerceTypes: options.coerce }
    : null;

  let ok = true;
  const bundled = [];
  // Bundling concatenates declarations into ONE file, so each model must
  // avoid every name its predecessors used — two schemas that both declare
  // `$defs.Id` would otherwise collide as duplicate identifiers. The files
  // are processed in sorted order, so the renames are deterministic.
  const reserved = [];
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
    const name = options.name ?? nameFromFile(file);
    const model = compileEmitModel(schema, {
      name, source: path.basename(file),
      normalize: normalizeOptions, variantSuffix: options.suffix,
      reserved: options.bundle !== null ? reserved : undefined,
    });
    if (options.bundle !== null) {
      bundled.push(...model.declarations);
      for (const declaration of model.declarations) reserved.push(declaration.name);
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

try {
  main();
}
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}

//#endregion
