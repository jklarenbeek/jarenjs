//#region benchmark result files
// The `--output json --filepath` writers shared by the runners. The
// website-data pipeline captures these payloads into the tracked
// website benchmark JSONs, so member ORDER is part of the contract:
// callers pass `payload`/`data` with their members already in the
// order the file must carry.

import * as fs from 'fs';

/**
 * Write a single-mode JSON payload (the jsonpointer/formats shape).
 * @param {string} mode - The payload's `mode` discriminator
 * @param {object} payload - The mode-specific members, in file order
 * @param {{ output: string, filepath: string|null, iterations: number }} options
 */
export function writeJsonResults(mode, payload, options) {
  if (options.output === 'console' || options.filepath === null)
    return;

  const content = JSON.stringify({
    mode,
    date: new Date().toISOString(),
    node: process.version,
    iterations: options.iterations,
    ...payload,
  }, null, 2);

  fs.writeFileSync(options.filepath, content);
  console.log(`Results written to ${options.filepath}`);
}

/**
 * Write an engine-matrix payload as JSON or CSV (the jsonquery/jslt
 * shape).
 * @param {string} mode
 * @param {{ key: string, name: string }[]} engines
 * @param {object} data - `rows` plus mode-specific members
 * @param {{ output: string, filepath: string|null }} options
 */
export function writeEngineResults(mode, engines, data, options) {
  if (options.output === 'console' || options.filepath === null)
    return;

  let content;
  if (options.output === 'json') {
    content = JSON.stringify({
      mode,
      date: new Date().toISOString(),
      node: process.version,
      engines: engines.map((engine) => engine.name),
      ...data,
    }, null, 2);
  }
  else { // csv
    const lines = [[
      'document',
      'scenario',
      ...engines.map((engine) => `${engine.name} ns/op`),
    ].join(',')];
    for (const row of data.rows ?? []) {
      lines.push([
        JSON.stringify(row.document),
        JSON.stringify(row.scenario),
        ...engines.map((engine) => row.engines[engine.key] ?? ''),
      ].join(','));
    }
    content = lines.join('\n') + '\n';
  }

  fs.writeFileSync(options.filepath, content);
  console.log(`Results written to ${options.filepath}`);
}

//#endregion
