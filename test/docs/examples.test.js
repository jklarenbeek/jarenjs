//@ts-check
/**
 * @file Documentation examples that claim to be JavaScript, held to it.
 *
 * A fence labelled `js` is code a reader pastes into a `.js` or `.mjs`
 * file, where TypeScript-only syntax (`import type`, a `type` alias, an
 * `interface`) is a SyntaxError — so an example that needs it is labelled
 * `ts`. Two examples are held tighter, because each once printed code that
 * could not run as written: the HOWTO's multiple-drafts example is RUN, and
 * the live app binding is PARSED as a module. And a reader runs one HOWTO
 * example, not the page, so every one imports the package names it uses.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Linter } from 'eslint';

import { fencesOf } from '../../scripts/check-documents.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (/** @type {string} */ rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The fence labels of code a reader pastes into a JavaScript file. */
const JAVASCRIPT = ['js', 'javascript', 'mjs', 'cjs', 'jsx'];

/**
 * The names an example binds from a package rather than a module of its own:
 * the names a reader has to import before the example means anything.
 * @param {string} code
 * @returns {string[]}
 */
function packageBindings(code) {
  /** @type {string[]} */
  const names = [];
  for (const [, clause, specifier] of code.matchAll(/^[ \t]*import\s+([^'";]+?)\s+from\s*['"]([^'"]+)['"]/gm)) {
    if (specifier.startsWith('.') || specifier.startsWith('/')) continue;
    for (const member of /\{([^}]*)\}/.exec(clause)?.[1].split(',') ?? []) {
      const local = member.trim().split(/\s+as\s+/).pop();
      if (local) names.push(local);
    }
    const rest = clause.replace(/\{[^}]*\}/, '');
    const namespace = /\*\s*as\s+([\w$]+)/.exec(rest);
    if (namespace !== null) names.push(namespace[1]);
    const fallback = /^\s*([\w$]+)\s*(?:,|$)/.exec(rest);
    if (fallback !== null) names.push(fallback[1]);
  }
  return names;
}

/** Statements only TypeScript parses, at the start of a line. */
const TYPESCRIPT_ONLY = /^\s*(?:import\s+type\s|export\s+type\s|(?:export\s+)?type\s+[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\s*=|(?:export\s+)?interface\s+[A-Za-z_$][\w$]*\s*(?:<[^>]*>)?\s*(?:extends\s|\{))/m;

/**
 * The first fence in one of `langs` after `heading`.
 * @param {string} file @param {string} heading @param {string[]} langs
 * @returns {string}
 */
function fenceAfter(file, heading, langs) {
  const text = read(file);
  const at = text.indexOf(heading);
  assert.ok(at >= 0, `${file} no longer has the heading '${heading}'`);
  const fence = fencesOf(text.slice(at)).find((candidate) => langs.includes(candidate.lang));
  assert.ok(fence !== undefined, `${file}: no ${langs.join('/')} fence after '${heading}'`);
  return fence.body;
}

/**
 * Run one fence as a module where bare `@jarenjs/*` specifiers resolve as a
 * consumer's do, and answer its named bindings.
 * @param {string} code @param {string[]} names
 * @returns {Promise<any>}
 */
async function run(code, names) {
  const dir = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.cache-docs-examples-'));
  try {
    const file = path.join(dir, 'example.mjs');
    fs.writeFileSync(file, `${code}\nexport { ${names.join(', ')} };\n`);
    return await import(pathToFileURL(file).href);
  }
  finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('documentation examples', () => {
  it('no fence labelled js carries TypeScript-only syntax', () => {
    const documents = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '*.md'],
      { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
      .filter((file) => !file.startsWith('test/') && fs.existsSync(path.join(ROOT, file)));
    /** @type {string[]} */
    const found = [];
    let fences = 0;
    for (const file of documents) {
      for (const fence of fencesOf(read(file))) {
        if (!JAVASCRIPT.includes(fence.lang)) continue;
        fences++;
        const match = TYPESCRIPT_ONLY.exec(fence.body);
        if (match !== null) found.push(`${file}:${fence.line} ${match[0].trim()}`);
      }
    }
    assert.ok(fences > 100, `scanned ${fences} js fences`);
    assert.deepStrictEqual(found, []);
  });

  it('the HOWTO multiple-drafts example runs as printed, one validator per draft', async () => {
    const code = fenceAfter('docs/HOWTO.md', '### Multiple Schema Versions', ['js', 'javascript']);
    const { validate7, validate2019 } = await run(code, ['validate7', 'validate2019']);
    // draft 7 resolves `definitions`, 2019-09 resolves `$defs`: each to a string
    assert.deepStrictEqual([validate7('ada'), validate7(7), validate2019('ada'), validate2019(7)], [true, false, true, false]);
  });

  it('every HOWTO example imports the package names it uses', () => {
    const file = 'docs/HOWTO.md';
    const fences = fencesOf(read(file)).filter((fence) => JAVASCRIPT.includes(fence.lang));
    // a name one example imports from a package is a name every example
    // that uses it imports too; a reader's own values (`jaren`, `schema`,
    // `data`) are left to the prose around them
    const imported = new Set(fences.flatMap((fence) => packageBindings(fence.body)));
    assert.ok(imported.has('JarenValidator') && imported.has('queryJson'), [...imported].join(' '));
    const linter = new Linter();
    /** @type {string[]} */
    const missing = [];
    /** @type {string[]} */
    const unread = [];
    for (const fence of fences) {
      const messages = linter.verify(fence.body,
        { languageOptions: { ecmaVersion: 'latest', sourceType: 'module' }, rules: { 'no-undef': 'error' } });
      if (messages.some((message) => message.fatal)) {
        unread.push(fence.body.split('\n')[0]);
        continue;
      }
      for (const message of messages) {
        const name = message.ruleId === 'no-undef' ? /^'(.+)' is not defined\.$/.exec(message.message)?.[1] : undefined;
        if (name !== undefined && imported.has(name)) missing.push(`${file}:${fence.line + message.line} ${name}`);
      }
    }
    assert.deepStrictEqual(missing, []);
    // the examples no parser reads, so the check above cannot either: two
    // modules in one fence, a before/after pair, an elided function body
    assert.deepStrictEqual(unread, [
      '// schemas.js - Compile at module load time',
      '// This doesn\'t create an own property!',
      'jaren.addFormat(\'my-format\', (schemaObj, jsonSchema) => {',
      '// validation.js',
    ]);
  });

  it('the HOWTO format and reference recipes that import what they use run as printed', async () => {
    for (const heading of ['### Available Formats', '### Selective Format Loading', '#### External Schema References', '### 4. Selective Format Loading']) {
      const code = fenceAfter('docs/HOWTO.md', heading, ['js', 'javascript']);
      await assert.doesNotReject(run(code, []), heading);
    }
  });

  it('the live app binding example parses as a module', () => {
    const code = fenceAfter('packages/db/docs/LIVE-FORMAT.md', '## 10. The app binding', ['js']);
    const dir = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.cache-docs-examples-'));
    try {
      const file = path.join(dir, 'binding.mjs');
      fs.writeFileSync(file, `${code}\n`);
      const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      assert.strictEqual(checked.status, 0, checked.stderr);
    }
    finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
