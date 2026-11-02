//@ts-check
/**
 * @file The JSON report a fixture child process writes as its last stdout
 * line. A child that dies before writing it (a crash, a signal, a launch
 * error) fails the test with what it left behind, never with a JSON parse
 * error that hides the child's own diagnosis.
 */

import assert from 'node:assert/strict';

/**
 * Parse the report a child wrote as its last stdout line. When no report
 * parses, fail naming the child's exit status, signal, launch error, stderr
 * and stdout.
 * @param {{ status: number | null, signal: string | null, error?: Error,
 *   stdout: string, stderr: string }} run - a `spawnSync` result read as text
 * @returns {any} the parsed report
 */
export function childReport(run) {
  const stdout = String(run.stdout ?? '').trim();
  try {
    return JSON.parse(stdout.split('\n').at(-1) ?? '');
  }
  catch {
    const launch = run.error ? `, launch error: ${run.error.message}` : '';
    return assert.fail(`the child wrote no JSON report as its last stdout line `
      + `(exit status ${run.status}, signal ${run.signal}${launch})\n`
      + `stderr:\n${String(run.stderr ?? '').trimEnd() || '(empty)'}\n`
      + `stdout:\n${stdout || '(empty)'}`);
  }
}
