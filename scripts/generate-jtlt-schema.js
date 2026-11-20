//@ts-check
/** JTLT's segment grammar composes JSLT query and match definitions verbatim. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { downlevelDraft07 } from '../test/json/schema-artifact-helpers.js';
import { isMainModule } from './lib/main-module.js';

const root = resolve(import.meta.dirname, '..');
const ref = (name) => ({ $ref: `#/$defs/${name}` });
const dollar = (name) => typeof name === 'string' && name.startsWith('$');
/** The definitions this grammar adds to the JSLT ones it copies. */
const ADDED = ['segmentList', 'segment', 'querySegment', 'operatorPhrase', 'rawSegment', 'jsonSegment'];

/**
 * The segment that is a query object, as two definitions a strict
 * structured-output profile can carry: `querySegment`, the version envelope
 * or an operator phrase, and `operatorPhrase`, every alternative of
 * `objectExpression` but the map constructor, in the query grammar's own
 * order. A phrase the query grammar gains is a segment with no edit here.
 *
 * Those are the query documents that are objects holding a `$`-prefixed key,
 * and exactly those only while the query grammar partitions objects by such
 * keys. The partition is checked where it is read, so a reshaped grammar
 * throws instead of drifting: a query document is the envelope or an
 * expression; no expression but an object expression is an object; the map
 * constructor refuses every `$`-prefixed key; the envelope and every other
 * alternative need one.
 * @param {Record<string, any>} defs - The JSLT definitions: the query grammar and `$apply`
 * @returns {{ querySegment: object, operatorPhrase: object }}
 */
function querySegmentDefs(defs) {
  const changed = (what) => new TypeError(`query schema contract changed: ${what}`);
  /** The definitions a `oneOf` of references names. */
  const alternatives = (name) => (Array.isArray(defs[name]?.oneOf) ? defs[name].oneOf : [{}]).map((branch) => {
    const target = Object.keys(branch).length === 1 && typeof branch.$ref === 'string' && branch.$ref.startsWith('#/$defs/') ? branch.$ref.slice(8) : '';
    if (!Object.hasOwn(defs, target)) throw changed(`$defs.${name}.oneOf is not a list of references to definitions`);
    return target;
  });
  if (alternatives('queryDocument').join() !== 'versionEnvelope,expression')
    throw changed('$defs.queryDocument is not the version envelope or an expression');
  const expressions = alternatives('expression');
  if (!expressions.includes('objectExpression')
    || expressions.some((name) => name !== 'objectExpression' && (defs[name].type === undefined || [defs[name].type].flat().includes('object'))))
    throw changed('$defs.expression admits an object that is no $defs.objectExpression');
  const phrases = alternatives('objectExpression').filter((name) => name !== 'mapConstructor');
  if (phrases.length !== defs.objectExpression.oneOf.length - 1 || defs.mapConstructor.type !== 'object' || defs.mapConstructor.patternProperties?.['^\\$'] !== false)
    throw changed('$defs.mapConstructor is not the one object expression that refuses every $-prefixed key');
  for (const name of ['versionEnvelope', ...phrases]) {
    const def = defs[name];
    const needsOne = def.type === 'object' && ((Array.isArray(def.required) && def.required.some(dollar))
      || (def.minProperties >= 1 && Array.isArray(def.propertyNames?.enum) && def.propertyNames.enum.every(dollar)));
    if (!needsOne) throw changed(`$defs.${name} admits an object without a $-prefixed key`);
  }
  return {
    querySegment: {
      description: 'A query object as a segment: the version envelope or an operator phrase, which are the query documents that are objects holding a $-prefixed key. A map constructor holds none and is no segment (TL0004).',
      oneOf: [ref('versionEnvelope'), ref('operatorPhrase')],
    },
    operatorPhrase: {
      description: 'An object expression whose keys are $-prefixed: every alternative of objectExpression but the map constructor.',
      oneOf: phrases.map(ref),
    },
  };
}

/**
 * Derive the canonical grammar and its mechanically equivalent draft-07 twin.
 * @param {{ $defs: Record<string, any> }} [jslt] - The JSLT grammar the definitions are copied from; the committed one by default
 * @returns {{ latest: object, draft07: object }}
 * @throws {TypeError} When the query grammar the JSLT one embeds no longer has the shape the segment vocabulary is read from
 */
export function jtltSchemaArtifacts(jslt = JSON.parse(readFileSync(resolve(root, 'packages/json/schemas/jaren-jslt.schema.json'), 'utf8'))) {
  const taken = ADDED.find((name) => Object.hasOwn(jslt.$defs, name));
  if (taken !== undefined) throw new TypeError(`JSLT schema contract changed: $defs.${taken} already exists`);
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
      // The order of the branches carries no answer: a validator reads them
      // all, and a strict profile's maps read a value through the branch
      // whose original accepts it, whichever comes first.
      anyOf: [{ type: 'string' }, ref('segmentList'), ref('querySegment'), ref('rawSegment'), ref('jsonSegment')],
    },
    ...querySegmentDefs(jslt.$defs),
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

if (isMainModule(import.meta.url)) {
  const { latest, draft07 } = jtltSchemaArtifacts();
  for (const [suffix, schema] of [['schema', latest], ['draft-07.schema', draft07]])
    writeFileSync(resolve(root, `packages/json/schemas/jaren-jtlt.${suffix}.json`), JSON.stringify(schema, null, 2) + '\n');
}
