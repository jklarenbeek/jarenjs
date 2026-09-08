//@ts-check
/** JTLT's segment grammar composes JSLT query and match definitions verbatim. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { downlevelDraft07 } from '../test/json/schema-artifact-helpers.js';

const root = resolve(import.meta.dirname, '..');

/** Derive the canonical grammar and its mechanically equivalent draft-07 twin. */
export function jtltSchemaArtifacts() {
  const jslt = JSON.parse(readFileSync(resolve(root, 'packages/json/schemas/jaren-jslt.schema.json'), 'utf8'));
  const ref = (name) => ({ $ref: `#/$defs/${name}` });
  const phrase = (name) => ({ type: 'object', properties: { [name]: ref('queryDocument') }, required: [name], additionalProperties: false });
  const defs = {
    ...jslt.$defs,
    rule: {
      ...jslt.$defs.rule,
      description: 'A JTLT rule: JSLT matching and modes, a segment-list body, and priorities above the reserved built-in band.',
      properties: { ...jslt.$defs.rule.properties, priority: { type: 'number', exclusiveMinimum: -1e307 }, body: ref('segmentList') },
    },
    segmentList: { type: 'array', items: ref('segment') },
    segment: {
      description: 'Literal or interpolated strings, recursively nested lists, raw/JSON phrases, and query objects containing a dollar-prefixed key. Runtime compilation resolves path syntax, hooks and expression semantics.',
      anyOf: [
        { type: 'string' }, ref('segmentList'), ref('rawSegment'), ref('jsonSegment'),
        { allOf: [ref('queryDocument'), { type: 'object', not: { propertyNames: { pattern: '^[^$]' } } }] },
      ],
    },
    rawSegment: phrase('$raw'),
    jsonSegment: phrase('$json'),
  };
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://jarenjs.dev/schemas/jaren-jtlt/0.1',
    title: 'Jaren JTLT 0.1 template',
    description: 'The closed JTLT envelope and segment vocabulary, composing the JSLT query grammar. Format assertions are optional; compileJtltStylesheet is authoritative for registered path functions, schema hooks and runtime output.',
    oneOf: [
      { type: 'array', items: ref('rule') },
      { type: 'object', properties: { $jtlt: { const: '0.1' }, output: { enum: ['text', 'xml'] }, rules: { type: 'array', items: ref('rule') } }, required: ['$jtlt', 'rules'], additionalProperties: false },
    ],
    $defs: {},
  };
  // Keep only definitions reachable from this grammar; unrelated JSLT envelopes
  // must not inflate a template artifact or appear to be another accepted root.
  const reached = new Set();
  const visit = (node) => {
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string' && value.startsWith('#/$defs/')) {
        const name = value.slice(8);
        if (!Object.hasOwn(defs, name)) throw new Error(`Missing JTLT definition: ${name}`);
        if (!reached.has(name)) { reached.add(name); visit(defs[name]); }
      }
      else visit(value);
    }
  };
  visit(schema.oneOf);
  schema.$defs = Object.fromEntries([...reached].map((name) => [name, defs[name]]));
  return { latest: schema, draft07: downlevelDraft07(schema) };
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const { latest, draft07 } = jtltSchemaArtifacts();
  for (const [suffix, schema] of [['schema', latest], ['draft-07.schema', draft07]])
    writeFileSync(resolve(root, `packages/json/schemas/jaren-jtlt.${suffix}.json`), JSON.stringify(schema, null, 2) + '\n');
}
