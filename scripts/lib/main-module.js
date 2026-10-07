//@ts-check
/**
 * @file Whether a module is the program node was asked to run.
 *
 * A script that is also imported (by its tests, by another script) runs its
 * command-line half only when it is the entry point. Node loads the entry
 * point from its real path, so the module's `import.meta.url` names the real
 * file, while `process.argv[1]` keeps the path the caller gave (made absolute,
 * links intact). Compared unresolved, the two differ for a script run through
 * a symbolic link, and a gate run that way exits 0 having checked nothing.
 * Every script asks this one function instead, which resolves both sides.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Whether the module whose `import.meta.url` is given is the script node was
 * asked to run: `process.argv[1]` and the module's own file are the same file
 * once both are resolved to their real paths, so a run by a relative path or
 * through a symbolic link counts and an import does not.
 *
 * False, never a throw, when node was given no script file (`node -e`, a
 * program on stdin, the REPL) or when either side cannot be resolved (a URL
 * that is not a `file:` URL, a file that no longer exists).
 * @param {string} importMetaUrl - the calling module's `import.meta.url`
 * @returns {boolean}
 * @example
 * if (isMainModule(import.meta.url)) process.exitCode = main(process.argv.slice(2));
 */
export function isMainModule(importMetaUrl) {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(importMetaUrl));
  }
  catch {
    return false;
  }
}
