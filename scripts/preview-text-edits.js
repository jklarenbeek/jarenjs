//@ts-check
/** Preview JSON-supplied file edits; validate JavaScript through an owned Node process. */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { compileTextEdits, applyTextEdits } from '@jarenjs/core/text/edits';
import { createGuardedRefiner } from '@jarenjs/core/guarded';
import { createProcessExecutor } from '@jarenjs/core/process-node';

/** No target files are written. The host supplies hashes and owns later persistence.
 * @param {import('@jarenjs/core/text/edits').TextFile[]} files
 * @param {import('@jarenjs/core/text/edits').TextEdit[]} edits */
export async function previewTextEdits(files, edits) {
  const executor = createProcessExecutor({ cwd: process.cwd(),
    allow: { syntax: { argv0: process.execPath, args: [/--check/, /--input-type=module/] } },
    timeoutMs: 5000, graceMs: 250, maxStdoutBytes: 4096, maxStderrBytes: 8192 });
  const refiner = createGuardedRefiner({
    read: async () => files, validateProposal: Array.isArray,
    apply(previous, proposal) {
      const compiled = compileTextEdits(previous, proposal);
      if (!compiled.valid) throw new Error(JSON.stringify(compiled.withheld));
      return applyTextEdits(previous, compiled.hunks);
    },
    async validateCandidate(next) {
      for (const file of next.files.filter(file => /\.(m?js)$/.test(file.path))) {
        const result = await executor.run({ name: 'syntax', args: ['--check', '--input-type=module'], input: file.text });
        if (result.exitCode !== 0 || result.settlement !== 'closed')
          return { valid: false, errors: [{ code: 'SYNTAX', docPath: file.path, message: result.stderr || result.refused || result.reason || 'process did not settle' }] };
      }
      return true;
    },
    planCommit: next => next, commit: async plan => plan,
  });
  try { return await refiner.prepareAsync(files, edits); }
  finally { await executor.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const result = await previewTextEdits(input.files, input.edits);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.valid) process.exitCode = 1;
}
