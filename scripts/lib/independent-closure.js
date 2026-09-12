//@ts-check
/** Verify repository independence, including private tooling and indirect imports. */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tokenizer } from 'acorn';

const forbidden = value => typeof value === 'string' && /(?:@tangleai\/|(?:^|[/:\\])tangleai(?:[/:\\]|$)|@jarenjs\/ai(?:[\s/'"@]|$)|@jarenjs\/linq\/ai(?:[\s/'"]|$)|@jarenjs\/studio\/author(?:[\s/'"]|$))/.test(value);
const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'bundledDependencies', 'bundleDependencies'];

/** No install, network, source mutation, or historical-prose matching.
 * @param {string} root
 * @param {{files?: string[]}} [options]
 * @returns {string[]} actionable refusals
 */
export function checkIndependentClosure(root, options = {}) {
  const errors = [];
  const sourceFiles = options.files ?? execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean);
  const manifests = new Set(['package.json', ...sourceFiles.filter(file => file.endsWith('/package.json'))]);
  for (const file of manifests) {
    if (!existsSync(join(root, file))) continue;
    const manifest = JSON.parse(readFileSync(join(root, file), 'utf8'));
    for (const section of sections) {
      const entries = Array.isArray(manifest[section]) ? manifest[section].map(name => [name, name]) : Object.entries(manifest[section] ?? {});
      for (const [name, version] of entries)
        if (forbidden(name) || forbidden(version)) errors.push(`${file}: ${section}.${name} reaches the retired/foreign AI closure`);
    }
    const inspect = (value, path) => {
      if (typeof value === 'string' && forbidden(value)) errors.push(`${file}: ${path} reaches the retired/foreign AI closure`);
      else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) inspect(child, `${path}.${key}`);
    };
    for (const key of ['scripts', 'exports', 'imports', 'main', 'module', 'types', 'bin', 'overrides', 'resolutions']) inspect(manifest[key], key);
  }
  const lockPath = join(root, 'package-lock.json');
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    for (const [path, entry] of Object.entries(lock.packages ?? {})) {
      if (forbidden(path) || forbidden(entry.resolved) || forbidden(entry.name)) errors.push(`package-lock.json: ${path} reaches the retired/foreign AI closure`);
      for (const section of sections) for (const [name, version] of Object.entries(entry[section] ?? {}))
        if (forbidden(name) || forbidden(version)) errors.push(`package-lock.json: ${path}.${section}.${name} reaches the retired/foreign AI closure`);
    }
  }
  for (const file of sourceFiles) {
    if (!/\.(?:[cm]?[jt]s|tsx|jsx)$/.test(file) || !existsSync(join(root, file))) continue;
    const source = readFileSync(join(root, file), 'utf8');
    // Tokenization accepts TypeScript annotations without executing or erasing type imports.
    const comments = [];
    const tokens = [...tokenizer(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true, onComment: comments })];
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index], next = tokens[index + 1];
      const word = token.value ?? token.type.label;
      const bare = word === 'import' && next?.type.label === 'string';
      const from = word === 'from' && next?.type.label === 'string';
      const call = ['import', 'require'].includes(word) && next?.type.label === '(' && tokens[index + 2]?.type.label === 'string';
      const target = bare || from ? next.value : call ? tokens[index + 2].value : undefined;
      if (forbidden(target)) errors.push(`${relative(root, join(root, file))}:${token.loc.start.line} imports ${target}`);
    }
    // Type imports in checked JS comments are declaration dependencies too.
    for (const comment of comments.filter(comment => comment.type === 'Block' && comment.value.startsWith('*'))) for (const match of comment.value.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g))
      if (forbidden(match[1])) errors.push(`${file}: JSDoc imports ${match[1]}`);
  }
  return [...new Set(errors)];
}
