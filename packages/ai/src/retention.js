//@ts-check
import { JarenValidator } from '@jarenjs/validate';
import { GOAL_SCHEMA } from './schemas/ledger.js';
import { checkOutcome } from './check.js';
const checkpointCheck = new JarenValidator({ collectErrors: true, skipErrors: false, unknownFormats: 'ignore' }).compile(GOAL_SCHEMA.properties.checkpoint);

/** Serialized UTF-8 bytes, including JSON escaping and punctuation. */
export const jsonBytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;

/**
 * Exact whole-map accounting. Braces belong to overhead; each member owns its
 * leading comma. Archive metadata, contents, reports and tombstones stay visible.
 * @param {Record<string, any>} records
 */
export function ledgerFootprint(records) {
  const classes = {};
  Object.keys(records).sort().forEach((key, index) => {
    let kind = 'other';
    if (key.startsWith('ai/snap/')) kind = 'snapshots';
    else if (key.startsWith('ai/counters/')) kind = 'counters';
    else if (key.startsWith('ai/state/memory/')) kind = 'memories';
    else if (key.startsWith('ai/state/skill/')) kind = 'skills';
    else if (key.startsWith('ai/state/goal/')) kind = 'goals';
    else if (key.startsWith('ai/state/evicted/') || key.startsWith('ai/state/retention/')) kind = 'retention';
    else if (key.startsWith('ai/state/slot/')) kind = records[key]?.kind?.startsWith('agent-round') ? 'archives' : 'slots';
    else if (key.startsWith('ai/state/slot-content/')) {
      const name = key.slice('ai/state/slot-content/'.length);
      kind = records[`ai/state/slot/${name}`]?.kind?.startsWith('agent-round') ? 'archives' : 'slots';
    }
    const entry = classes[kind] ??= { bytes: 0, items: 0 };
    entry.bytes += jsonBytes(key) + 1 + jsonBytes(records[key]) + (index ? 1 : 0);
    entry.items++;
  });
  return { bytes: 2 + Object.values(classes).reduce((n, entry) => n + entry.bytes, 0), overhead: 2, classes };
}

/** Lossless checkpoint: repeated note/evidence pairs share a dictionary entry. */
export function checkpointProgress(goal) {
  const records = [], sources = [];
  const add = (source, record) => {
    if (typeof source?.id !== 'string' || source.id === '' || !record) throw new TypeError('checkpoint needs identified source entries');
    let index = records.findIndex((held) => held.note === record.note && held.evidence === record.evidence);
    if (index < 0) { index = records.length; records.push({ note: record.note, evidence: record.evidence }); }
    sources.push({ id: source.id, at: source.at, record: index });
  };
  for (const source of goal.checkpoint?.sources ?? []) add(source, goal.checkpoint.records[source.record]);
  for (const entry of goal.progress) add(entry, entry);
  return { version: 1, sources, records };
}

/** Validate exact source coverage and evidence, including prior checkpoints. */
export function validateCheckpoint(checkpoint, goal) {
  const shape = checkOutcome(checkpointCheck(checkpoint));
  if (!shape.valid) return { valid: false, errors: shape.errors.map((error) => ({ ...error,
    code: 'GOAL_CHECKPOINT', docPath: `/checkpoint${error.instancePath ?? ''}` })) };
  let expected;
  try { expected = checkpointProgress(goal); }
  catch { return { valid: false, errors: [{ code: 'GOAL_CHECKPOINT', docPath: '/goal', message: 'invalid checkpoint source goal' }] }; }
  const errors = [];
  const add = (path, message) => errors.push({ code: 'GOAL_CHECKPOINT', docPath: path, instancePath: path, message });
  if (checkpoint?.version !== 1 || !Array.isArray(checkpoint?.sources) || !Array.isArray(checkpoint?.records))
    add('/checkpoint', 'expected a versioned checkpoint with sources and records');
  else {
    const sources = new Map(expected.sources.map((source) => [source.id, source]));
    const seen = new Set();
    checkpoint.sources.forEach((source, index) => {
      const held = sources.get(source?.id), record = checkpoint.records[source?.record];
      if (!held || seen.has(source.id) || source.at !== held.at || !Number.isSafeInteger(source.record)
        || (record?.note !== expected.records[held.record].note || record?.evidence !== expected.records[held.record].evidence))
        add(`/checkpoint/sources/${index}`, 'source is invented, duplicated or changes its note/evidence');
      seen.add(source?.id);
    });
    if (seen.size !== sources.size || [...sources.keys()].some((id) => !seen.has(id)))
      add('/checkpoint/sources', 'every retired source id must remain covered');
    if (checkpoint.records.some((_, index) => !checkpoint.sources.some((source) => source.record === index)))
      add('/checkpoint/records', 'unreferenced checkpoint record');
  }
  return { valid: errors.length === 0, errors };
}

/** Complete goal context. No excerpting or silent clipping of evidence. */
export function goalPrompt(goal) {
  const progress = Array.isArray(goal.progress) ? goal.progress : [];
  const lines = ['## Your objective (persistent, across sessions)', goal.objective];
  if (goal.checkpoint) lines.push('', 'Validated checkpoint — this work is DONE, do not repeat it:', JSON.stringify(goal.checkpoint));
  if (progress.length) {
    lines.push('', `Progress recorded so far (${progress.length} entr${progress.length === 1 ? 'y' : 'ies'}) — this work is DONE, do not repeat it:`);
    for (const entry of progress) lines.push(`- [${entry.at}] ${entry.note} (evidence: ${entry.evidence})`);
  }
  return lines.join('\n');
}
