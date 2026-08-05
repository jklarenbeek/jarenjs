//@ts-check
/**
 * @file Entity types from models (D17): build an EMIT MODEL DOCUMENT
 * — the published contract from EMIT-FORMAT.md — that renders entity
 * interfaces, input variants and the typed-store metadata from the
 * same model document the runtime validates against.
 *
 * The seam (EMIT-FORMAT §4.1, recorded here as the order demanded):
 * the schema compiler is INJECTED (`options.compile` is
 * `compileEmitModel` from `@jarenjs/emit`), called with
 * `extensions: ['x-entity']` so the vocabulary rides the member nodes
 * verbatim; this module then post-processes the MODEL DOCUMENT —
 * replacing relation member types with references, flipping
 * optionality, adding declarations — and never renders a character of
 * TypeScript itself. Emit stays database-free, db stays
 * renderer-free, and the injection keeps `@jarenjs/emit` out of db's
 * dependency graph (the generator script wires the two).
 *
 * What the artifact says, deliberately:
 * - entity interfaces are CLOSED objects (excess-property checking is
 *   the point of generated types; the runtime validator stays
 *   authoritative for what a database accepts);
 * - relation members are optional references — present only when a
 *   graph load included them; `date-time`/`date` strings carry the
 *   `DateTime` brand so the linq date operators light up;
 * - the `<Name>Input` variant makes defaulted and generated members
 *   optional, drops to-one/to-many relation members (`create`/`add`
 *   refuse them), and types many-to-many members as key-or-document
 *   arrays (what `add()` accepts);
 * - `EntityMetaMap` carries doc/input/key/relations per entity — the
 *   generic typed-store surface (`@jarenjs/db/typed`) binds to it.
 */

import { normalizeEntities } from './model.js';

const primitive = (name) => ({ kind: 'primitive', primitive: name });
const ref = (name) => ({ kind: 'ref', ref: name });
const arrayOf = (items) => ({ kind: 'array', items });
const unionOf = (options) => ({ kind: 'union', options });
const literal = (value) => ({ kind: 'literal', value });
const member = (name, type, required, doc = []) =>
  ({ kind: 'member', name, type, required, constraints: [], doc });
const objectOf = (members) => ({ kind: 'object', members });
const declaration = (name, type, doc = []) =>
  ({ kind: 'declaration', name, type, constraints: [], doc });

/** The `DateTime` brand: structurally the linq brand, generated
 * inline so the artifact stands alone. */
const DATE_TIME_DECLARATION = declaration('DateTime', {
  kind: 'intersection',
  parts: [primitive('string'), objectOf([
    member('__jarenTag', literal('date-time'), true),
  ])],
}, ['An RFC 3339 string branded for the date operators;',
  'structurally identical to the @jarenjs/linq brand.']);

const keyTypeOf = (entity) => {
  const parts = entity.keys.map((key) =>
    primitive(entity.properties.get(key).type === 'string' ? 'string' : 'number'));
  if (parts.length === 1) return parts[0];
  return objectOf(entity.keys.map((key, i) => member(key, parts[i], true)));
};

/**
 * Build the emit-model document for a model's entities.
 * @param {any} model - a jaren-model document with `entities`
 * @param {{ compile: (schema: any, options?: any) => any,
 *   source?: string, reserved?: string[] }} options - `compile` is
 *   `compileEmitModel` (injected; see the header)
 * @returns {any} an EMIT-FORMAT `0.1` model document
 */
export function entityEmitModel(model, options) {
  const compile = options?.compile;
  if (typeof compile !== 'function')
    throw new TypeError("entityEmitModel needs { compile: compileEmitModel } injected");
  const entities = normalizeEntities(model);
  const entityNames = [...entities.keys()];

  // every entity name, input name and the brand are reserved up front
  // so nested-shape hints can never steal them
  const taken = [
    ...(options?.reserved ?? []),
    'DateTime', 'Entities', 'EntityInputs', 'EntityMetaMap',
    ...entityNames,
    ...entityNames.map((name) => `${name}Input`),
  ];

  /** @type {any[]} */
  const declarations = [];
  let usesDateTime = false;

  for (const entity of entities.values()) {
    const compiled = compile(entity.schema, {
      name: entity.name,
      extensions: ['x-entity'],
      openObjects: 'closed',
      reserved: taken.filter((name) => name !== entity.name),
    });
    for (const compiledDeclaration of compiled.declarations) {
      if (!taken.includes(compiledDeclaration.name))
        taken.push(compiledDeclaration.name);
    }

    const root = compiled.declarations
      .find((candidate) => candidate.name === entity.name);
    const others = compiled.declarations
      .filter((candidate) => candidate !== root);

    // post-process the entity's own members through the vocabulary
    for (const memberNode of root.type.members) {
      const property = entity.properties.get(memberNode.name);
      if (property === undefined) continue;
      if (property.relation !== undefined) {
        // the seam is load-bearing: a relation member is DETECTED by
        // the preserved keyword, resolved through the normalized model
        if (memberNode.extensions?.['x-entity']?.relation === undefined) continue;
        const relation = property.relation;
        const target = ref(relation.to);
        memberNode.type = relation.kind === 'oneToOne' ? target : arrayOf(target);
        memberNode.required = false;
        memberNode.doc = [
          `The ${relation.kind} relation to ${relation.to}; present only`,
          'when a graph load included it.'];
        continue;
      }
      if (property.type === 'string'
        && (property.format === 'date-time' || property.format === 'date')) {
        memberNode.type = ref('DateTime');
        usesDateTime = true;
      }
      if (property.version) {
        memberNode.doc = ['The optimistic-concurrency token (§11.5):',
          'engine-owned, bumped on every successful write.'];
      }
    }

    // the input variant: defaulted/generated members optional, to-one
    // and to-many members gone, many-to-many as key-or-document arrays
    const inputMembers = [];
    for (const memberNode of root.type.members) {
      const property = entity.properties.get(memberNode.name);
      if (property?.relation !== undefined) {
        if (property.relation.kind !== 'manyToMany') continue;
        const target = entities.get(property.relation.to);
        inputMembers.push(member(memberNode.name,
          arrayOf(unionOf([keyTypeOf(target), ref(property.relation.to)])),
          false,
          ['Membership rows to attach: target keys or documents.']));
        continue;
      }
      const inputMember = {
        ...memberNode,
        // a DateTime read is a plain string write: the brand
        // discriminates expressions, never blocks a caller's literal
        type: memberNode.type.ref === 'DateTime' ? primitive('string') : memberNode.type,
        required: property?.default !== undefined
          ? false
          : memberNode.required,
      };
      if (property?.default !== undefined) {
        inputMember.doc = [`Defaulted (${JSON.stringify(property.default)});`,
          'optional for a caller, present after the write.'];
      }
      inputMembers.push(inputMember);
    }

    declarations.push(...others, root,
      declaration(`${entity.name}Input`, objectOf(inputMembers),
        [`What create()/add() accept for ${entity.name}: defaulted and`,
          'generated members are optional; relation projections are not',
          'writable (many-to-many membership arrays are).']));
  }

  // the metadata the generic typed store binds to
  const metaFor = (entity) => objectOf([
    member('doc', ref(entity.name), true),
    member('input', ref(`${entity.name}Input`), true),
    member('key', keyTypeOf(entity), true),
    member('relations', objectOf(
      [...entity.properties.values()]
        .filter((property) => property.relation !== undefined)
        .map((property) => member(property.name, objectOf([
          member('entity', literal(property.relation.to), true),
          member('doc', ref(property.relation.to), true),
          member('many', literal(property.relation.kind !== 'oneToOne'), true),
        ]), true))), true),
  ]);
  declarations.push(
    declaration('Entities',
      objectOf(entityNames.map((name) => member(name, ref(name), true))),
      ['Entity name to document shape.']),
    declaration('EntityInputs',
      objectOf(entityNames.map((name) => member(name, ref(`${name}Input`), true))),
      ['Entity name to input shape.']),
    declaration('EntityMetaMap',
      objectOf(entityNames.map((name) => member(name, metaFor(entities.get(name)), true))),
      ['The typed-store binding: pass this to TypedStore<…> from',
        "'@jarenjs/db/typed'."]));

  if (usesDateTime) declarations.unshift(DATE_TIME_DECLARATION);

  return {
    $emit: '0.1',
    source: options?.source ?? null,
    root: null,
    declarations,
  };
}
