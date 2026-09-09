//@ts-check
import { jsonBytes } from './retention.js';
const SLOT = 'ai/state/slot/', CONTENT = 'ai/state/slot-content/';
const EVICTED = 'ai/state/evicted/', REPORT = 'ai/state/retention/archive';
const archived = (value) => value?.kind === 'agent-round' || value?.kind === 'agent-round-index';

/** Exact bytes of the archive sub-map, including durable loss metadata. */
export function archiveFootprint(records) {
  const names = Object.keys(records).filter((key) => key.startsWith(SLOT) && archived(records[key]));
  const keys = new Set(names.flatMap((key) => [key, `${CONTENT}${records[key].name}`]));
  for (const key of Object.keys(records)) if (key.startsWith(EVICTED) || key === REPORT) keys.add(key);
  return { items: names.length, bytes: jsonBytes(Object.fromEntries([...keys].sort().map((key) => [key, records[key]]))) };
}

/** Plan deterministic oldest-unreferenced eviction, or refuse without mutation. */
export function retainArchives(current, added, limits, options = {}) {
  const next = structuredClone(current);
  const protectedNames = new Set([...(options.protectedNames ?? []), ...added.map((entry) => entry.slot.name)]);
  const references = JSON.stringify(Object.entries(current).filter(([key]) =>
    key.startsWith('ai/state/memory/') || key.startsWith('ai/state/goal/')))
    + (options.referenceText ?? '');
  for (const { slot, text } of added) {
    next[`${SLOT}${slot.name}`] = slot;
    next[`${CONTENT}${slot.name}`] = text;
    delete next[`${EVICTED}${slot.name}`];
  }
  const evicted = [];
  const report = { version: 1, policy: 'oldest-unreferenced', evicted,
    written: added.map((entry) => entry.slot.name) };
  next[REPORT] = report;
  const candidates = Object.entries(next).filter(([key, slot]) => key.startsWith(SLOT) && archived(slot)
    && !slot.pinned && !protectedNames.has(slot.name) && !references.includes(slot.name))
    .sort(([, a], [, b]) => a.at < b.at ? -1 : a.at > b.at ? 1 : a.name < b.name ? -1 : 1);
  const fits = () => {
    const footprint = archiveFootprint(next);
    return footprint.items <= (limits.maxItems ?? Infinity) && footprint.bytes <= (limits.maxBytes ?? Infinity);
  };
  for (const [, slot] of candidates) {
    if (fits()) break;
    const keys = [`${SLOT}${slot.name}`, `${CONTENT}${slot.name}`];
    const bytes = jsonBytes(Object.fromEntries(keys.map((key) => [key, next[key]])));
    const tombstone = { version: 1, name: slot.name, status: 'evicted', bytes, reason: 'archive-budget' };
    for (const key of keys) delete next[key];
    next[`${EVICTED}${slot.name}`] = tombstone;
    evicted.push(tombstone);
  }
  if (!fits()) return { error: 'archive budget cannot preserve protected addresses and loss metadata',
    code: 'ARCHIVE_BUDGET', retention: { refused: true, limits, current: archiveFootprint(current), attempted: archiveFootprint(next) } };
  return { next, report, footprint: archiveFootprint(next) };
}
