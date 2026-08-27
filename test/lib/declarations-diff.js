//@ts-check
/**
 * @file Hand-authored declarations against the runtime: the VALUE
 * exports a `.d.ts` declares must be exactly the names the module
 * exports at runtime. The pinned TypeScript exposes no compiler API, so
 * the declaration side is read with a small resolver over the three
 * spellings a declaration file uses — `export declare const|function|
 * class NAME`, `export const|function|class NAME`, and an export list
 * `export { a, b as c }` — while `export type`/`interface` declare no
 * value and are ignored. Twenty-seven runtime exports of `@jarenjs/db`
 * once went undeclared and one declared name never existed; this is
 * what keeps that from happening again.
 */

import * as fs from 'node:fs';

/**
 * The value names a declaration file exports.
 * @param {string} file - path of the `.d.ts`
 * @returns {string[]} sorted, unique
 */
export function declaredValues(file) {
  const text = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const match of text.matchAll(/^export\s+(?:declare\s+)?(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(match[1]);
  }
  for (const match of text.matchAll(/^export\s+\{([^}]*)\}/gm)) {
    for (const entry of match[1].split(',')) {
      const trimmed = entry.trim();
      if (trimmed === '' || trimmed.startsWith('type ')) continue;
      const alias = trimmed.split(/\s+as\s+/);
      names.add((alias[1] ?? alias[0]).trim());
    }
  }
  return [...names].sort();
}

/**
 * The runtime's exported names.
 * @param {string} specifier - a bare package specifier or subpath
 * @returns {Promise<string[]>} sorted
 */
export async function runtimeValues(specifier) {
  const mod = await import(specifier);
  return Object.keys(mod).filter((name) => name !== 'default').sort();
}

/**
 * Compare one subpath's runtime with its declaration file.
 * @param {string} specifier
 * @param {string} file
 * @returns {Promise<{ undeclared: string[], phantom: string[] }>}
 *   `undeclared`: exported at runtime, absent from the `.d.ts`;
 *   `phantom`: declared as a value, absent at runtime
 */
export async function diffDeclarations(specifier, file) {
  const runtime = await runtimeValues(specifier);
  const declared = declaredValues(file);
  const declaredSet = new Set(declared);
  const runtimeSet = new Set(runtime);
  return {
    undeclared: runtime.filter((name) => !declaredSet.has(name)),
    phantom: declared.filter((name) => !runtimeSet.has(name)),
  };
}
