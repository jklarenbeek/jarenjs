//@ts-check
/**
 * @file What a tracked file must not carry.
 *
 * A raw control byte in source or a document: git calls a file with a NUL
 * binary, so review tools stop diffing and grepping it, and an editor that
 * strips control characters silently changes the string that held one. An
 * escape (`'\0'`, `'\x1f'`) says the same thing as text.
 *
 * An absolute home-directory path: a machine's private layout, published
 * with whatever artifact recorded it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TRACKED = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  .split('\0').filter(Boolean);

/** Source and documentation: what a reviewer diffs and greps. */
const SOURCE = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.md']);

/**
 * A tracked file's bytes, or null for what is not a file in this checkout:
 * a submodule (git lists its path) or a path deleted in the working tree.
 * @param {string} path @returns {Buffer | null}
 */
function bytesOf(path) {
  try {
    const full = join(ROOT, path);
    return statSync(full).isFile() ? readFileSync(full) : null;
  }
  catch {
    return null;
  }
}

/** A C0 control byte other than tab, line feed and carriage return. DEL is not one: JSON may carry it raw. */
const isControl = (/** @type {number} */ byte) => byte < 0x09 || byte === 0x0b || byte === 0x0c || (byte >= 0x0e && byte < 0x20);

describe('tracked files', () => {
  it('no source file or document carries a raw control byte where an escape is meant', () => {
    /** @type {string[]} */
    const found = [];
    let scanned = 0;
    for (const path of TRACKED) {
      if (!SOURCE.has(extname(path))) continue;
      const data = bytesOf(path);
      if (data === null) continue;
      scanned++;
      for (let i = 0; i < data.length; i++) {
        if (!isControl(data[i])) continue;
        const line = data.subarray(0, i).toString('latin1').split('\n').length;
        found.push(`${path}:${line} 0x${data[i].toString(16).padStart(2, '0')}`);
      }
    }
    assert.ok(scanned > 1000, `scanned ${scanned} files`);
    assert.deepStrictEqual(found, []);
  });

  it('no tracked text records an absolute home-directory path', () => {
    /** @type {string[]} */
    const found = [];
    for (const path of TRACKED) {
      const data = bytesOf(path);
      // a NUL in the first 8000 bytes is git's own test for a binary file
      if (data === null || (data.subarray(0, 8000).includes(0) && !SOURCE.has(extname(path)))) continue;
      const home = /\/(?:home|Users)\/[a-z_][a-z0-9_.-]*\//.exec(data.toString('utf8'));
      if (home !== null) found.push(`${path}: ${home[0]}`);
    }
    assert.deepStrictEqual(found, []);
  });
});
