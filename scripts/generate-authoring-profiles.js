//@ts-check
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { deriveAuthoringProfile, JSLT_AUTHORING_OPEN } from './lib/schema-profiles.js';
import { contentHash } from './lib/content-hash.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const QUERY = 'A Jaren query expression; validate against the full grammar and compile locally.';
/** Named grammar seams; external grammars have named refs in their canonical source. */
export const AUTHORING_PROFILES = [
  { grammar: 'model', package: 'db', open: {} },
  { grammar: 'query', package: 'json', open: { objectExpression: QUERY } },
  { grammar: 'jslt', package: 'json', open: JSLT_AUTHORING_OPEN },
  { grammar: 'app', package: 'app', open: { queryDocument: QUERY, stylesheetDocument: 'A JSLT stylesheet; validate and compile locally.' } },
  { grammar: 'fsm', package: 'flow', open: { queryDocument: QUERY } },
  { grammar: 'dag', package: 'flow', open: { queryDocument: QUERY, stylesheetDocument: 'A JSLT stylesheet; validate and compile locally.' } },
  { grammar: 'statechart', package: 'flow', open: { queryDocument: QUERY } },
  { grammar: 'workflow', package: 'flow', open: { queryDocument: QUERY, dagDocument: 'A Jaren DAG document; validate and compile with versioned tasks locally.' } },
];

/** Serialized decoder complexity, including referenced grammars in the full closure.
 * @param {any} schema */
export function schemaComplexity(schema) {
  let branches = 0;
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    for (const [key, value] of Object.entries(node)) {
      if (['anyOf', 'oneOf'].includes(key) && Array.isArray(value)) branches += value.length;
      walk(value);
    }
  };
  walk(schema);
  return { bytes: Buffer.byteLength(JSON.stringify(schema)), branches };
}

/** Derive artifacts and their provenance manifest. Check mode writes nothing.
 * @param {{ check?: boolean, root?: string }} [options] */
export function generateAuthoringProfiles(options = {}) {
  const root = options.root ?? ROOT;
  const drift = [];
  const rows = [];
  const save = (path, data) => {
    const expected = JSON.stringify(data, null, 2) + '\n';
    if (!options.check) writeFileSync(resolve(root, path), expected);
    else {
      let actual = '';
      try { actual = readFileSync(resolve(root, path), 'utf8'); } catch { /* Missing output is drift. */ }
      if (actual !== expected) drift.push(path);
    }
  };
  for (const entry of AUTHORING_PROFILES) {
    const base = `packages/${entry.package}/schemas/jaren-${entry.grammar}`;
    const source = JSON.parse(readFileSync(resolve(root, base + '.schema.json'), 'utf8'));
    const profile = deriveAuthoringProfile(source, { open: entry.open });
    const refs = new Map();
    const collect = (node) => {
      if (!node || typeof node !== 'object') return;
      if (typeof node.$ref === 'string' && node.$ref.startsWith('https://jarenjs.dev/schemas/')) {
        const name = node.$ref.split('/').at(-2);
        if (!refs.has(name)) {
          const owner = AUTHORING_PROFILES.find((profile) => `jaren-${profile.grammar}` === name)?.package ?? 'json';
          const schema = JSON.parse(readFileSync(resolve(root, `packages/${owner}/schemas/${name}.schema.json`), 'utf8'));
          refs.set(name, schema); collect(schema);
        }
      }
      Object.values(node).forEach(collect);
    };
    collect(source);
    const full = schemaComplexity(source);
    for (const ref of refs.values()) {
      const size = schemaComplexity(ref); full.bytes += size.bytes; full.branches += size.branches;
    }
    rows.push({ grammar: entry.grammar, sourceHash: contentHash(source), seamHash: contentHash(entry.open),
      profileHash: contentHash(profile), open: Object.keys(entry.open), full, profile: schemaComplexity(profile) });
    save(base + '.authoring.schema.json', profile);
  }
  save('benchmark/programmind-profiles.json', { version: 1, rows });
  return drift;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const drift = generateAuthoringProfiles({ check: process.argv.includes('--check') });
  if (drift.length) { console.error('Authoring profile drift:', drift.join(', ')); process.exitCode = 1; }
}
