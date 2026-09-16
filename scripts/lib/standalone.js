//@ts-check
/** Compile one bundled CommonJS entry into a standalone Node or Bun executable. */
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

/** The caller owns bundling, relocation and execution assertions.
 * @param {string} bundle @param {string} binary @param {'node' | 'bun'} runtime
 * @param {{ bun?: string }} [options] */
export function compileStandalone(bundle, binary, runtime, options = {}) {
  if (runtime === 'bun') {
    execFileSync(options.bun ?? 'bun', ['build', '--compile', bundle, '--outfile', binary],
      { stdio: 'pipe', timeout: 120000 });
    return;
  }
  if (runtime !== 'node') throw new TypeError('standalone runtime must be node or bun');
  const directory = mkdtempSync(join(dirname(binary), '.sea-'));
  try {
    const config = join(directory, 'sea.json'), blob = join(directory, 'sea.blob');
    writeFileSync(config, JSON.stringify({ main: bundle, output: blob,
      disableExperimentalSEAWarning: true, useCodeCache: false, useSnapshot: false }));
    execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'pipe', timeout: 120000 });
    copyFileSync(process.execPath, binary);
    execFileSync('npx', ['--yes', 'postject@1.0.0-alpha.6', binary, 'NODE_SEA_BLOB', blob,
      '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'], { stdio: 'pipe', timeout: 120000 });
  }
  finally { rmSync(directory, { recursive: true, force: true }); }
}
