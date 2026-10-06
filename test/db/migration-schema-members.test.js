//@ts-check
/** Schema member names remain JSON data while migration mapping hints are removed. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { planModelMigration, shapeHash, sqliteDialect, createModelShape, migrate, migrationHistory, normalizeEntities } from '@jarenjs/db';
import { defineMigration, fromPlanned } from '@jarenjs/linq/migration';

function model(name, annotation = false) {
  const document = JSON.parse('{"$model":"0.1","entities":{"Record":{"schema":{"type":"object","properties":{"key":{"type":"string","x-entity":{"key":true}}}}}}}');
  const target = annotation ? document.entities.Record.schema : document.entities.Record.schema.properties;
  Object.defineProperty(target, name, { value: annotation ? { annotation: true } : { type: 'string' },
    enumerable: true, writable: true, configurable: true });
  return document;
}

for (const name of ['ordinary', 'constructor', '__proto__', 'x-rename', 'x-entity']) {
  it(`keeps the own ${name} property through a no-op model plan`, async () => {
    const input = model(name), before = JSON.stringify(input), fingerprint = shapeHash(input);
    const plan = planModelMigration(input, input, { dialect: sqliteDialect, id: 'unchanged' });
    assert.deepEqual(plan.migration.steps, []);
    assert.deepEqual(plan.report.schemaChanged, []);
    assert.deepEqual(plan.report.drafts, []);
    assert.equal(plan.migration.from, fingerprint);
    assert.equal(plan.migration.to, fingerprint);
    const endpoint = JSON.parse(plan.migration.identity.from);
    assert.equal(Object.hasOwn(endpoint.entities.Record.schema.properties, name), true);
    assert.deepEqual(endpoint.entities.Record.schema.properties[name], { type: 'string' });
    assert.deepEqual(fromPlanned(plan.migration, { from: input, to: input }).document, plan.migration);
    assert.equal(JSON.stringify(input), before);
    const driver = process.versions.bun ? (await import('@jarenjs/db/bun')).bunDriver()
      : (await import('@jarenjs/db/node')).nodeDriver();
    const connection = await driver.open(':memory:');
    try { await createModelShape(connection, input); }
    finally { await connection.close(); }
  });

  it(`keeps a narrowing of own ${name} visible to the draft and exact endpoint rules`, () => {
    const before = model(name), after = structuredClone(before);
    after.entities.Record.schema.properties[name].maxLength = 9;
    const snapshots = [JSON.stringify(before), JSON.stringify(after)];
    const plan = planModelMigration(before, after, { dialect: sqliteDialect, id: 'narrow' });
    assert.deepEqual(plan.report.schemaChanged, ['Record']);
    assert.deepEqual(plan.report.drafts, ['Record']);
    assert.equal(plan.migration.steps.length, 1);
    assert.equal(plan.migration.steps[0].kind, 'jslt');
    assert.equal(plan.migration.steps[0].draft, true);
    assert.deepEqual(plan.migration.identity, defineMigration({ id: 'narrow', from: before, to: after }).document.identity);
    assert.notEqual(plan.migration.identity.from, plan.migration.identity.to);
    assert.equal(Object.hasOwn(JSON.parse(plan.migration.identity.to).entities.Record.schema.properties, name), true);
    assert.deepEqual(fromPlanned(plan.migration, { from: before, to: after }).document, plan.migration);
    assert.deepEqual([JSON.stringify(before), JSON.stringify(after)], snapshots);
  });
}

for (const name of ['x-rename', 'x-entity'])
  it(`refuses ${name} narrowing before accepting old rows or writing a receipt`, async () => {
    const before = model(name), after = structuredClone(before);
    after.entities.Record.schema.properties[name].maxLength = 3;
    const plan = planModelMigration(before, after, { dialect: sqliteDialect, id: 'narrow' });
    const driver = process.versions.bun ? (await import('@jarenjs/db/bun')).bunDriver()
      : (await import('@jarenjs/db/node')).nodeDriver();
    const connection = await driver.open(':memory:');
    try {
      await createModelShape(connection, before);
      const put = await connection.prepare(`INSERT INTO "Record" ("key", "${name}", "doc") VALUES (?, ?, jsonb(?))`);
      try { await put.run(['kept', 'too long', '{}']); }
      finally { await put.finalize?.(); }
      const history = await migrationHistory({ connection });
      for (let run = 0; run < 2; run++) {
        await assert.rejects(async () => migrate({ connection }, [plan.migration], {
          baseline: before, model: after, shadow: false, shadowDriver: driver,
        }), { code: 'JD0021' });
        assert.deepEqual(await migrationHistory({ connection }), history);
      }
      const get = await connection.prepare(`SELECT "key", "${name}" AS value FROM "Record"`);
      try { assert.deepEqual((await get.all([])).map((row) => ({ ...row })), [{ key: 'kept', value: 'too long' }]); }
      finally { await get.finalize?.(); }
    }
    finally { await connection.close(); }
  });

for (const name of ['x-rename', 'x-entity']) for (const keyword of ['const', 'enum'])
  it(`preserves ordinary ${name} data inside ${keyword} when comparing entity schemas`, () => {
    const before = model('payload');
    const literal = { [name]: 'first' };
    before.entities.Record.schema.properties.payload = {
      type: 'object', [keyword]: keyword === 'const' ? literal : [literal],
    };
    const after = structuredClone(before);
    const changed = after.entities.Record.schema.properties.payload[keyword];
    (keyword === 'const' ? changed : changed[0])[name] = 'second';
    const plan = planModelMigration(before, after, { dialect: sqliteDialect, id: 'literal' });
    assert.deepEqual(plan.report.schemaChanged, ['Record']);
    assert.deepEqual(plan.report.drafts, ['Record']);
    assert.equal(plan.migration.steps[0].draft, true);
    assert.deepEqual(plan.migration.identity, defineMigration({ id: 'literal', from: before, to: after }).document.identity);
  });

it('retains every definition name while stripping real mapping annotations in its referenced schema', () => {
  for (const vocabulary of ['$defs', 'definitions']) for (const name of ['x-rename', 'x-entity', '__proto__']) {
    const before = model('value');
    before.entities.Record.schema[vocabulary] = { [name]: { type: 'string' } };
    before.entities.Record.schema.properties.value = { $ref: `#/${vocabulary}/${name}` };
    const after = structuredClone(before);
    after.entities.Record.schema[vocabulary][name].maxLength = 9;
    const narrowed = planModelMigration(before, after, { dialect: sqliteDialect, id: 'definition' });
    assert.deepEqual(narrowed.report.drafts, ['Record']);
    assert.equal(Object.hasOwn(JSON.parse(narrowed.migration.identity.to).entities.Record.schema[vocabulary], name), true);
    const mapped = structuredClone(before);
    mapped.entities.Record.schema[vocabulary][name]['x-entity'] = { index: true };
    const indexed = planModelMigration(before, mapped, { dialect: sqliteDialect, id: 'mapping-only' });
    assert.deepEqual(indexed.report.schemaChanged, []);
    assert.deepEqual(indexed.report.drafts, []);
    assert.equal(indexed.migration.steps.some((step) => step.kind === 'ddl'), true);
  }
});

it('keeps legitimate top-level and allOf mapping-only changes free of transform drafts', () => {
  const before = model('value');
  for (const indirect of [false, true]) {
    const after = structuredClone(before);
    after.entities.Record.schema.properties.value = indirect
      ? { allOf: [{ type: 'string' }, { 'x-entity': { index: true } }] }
      : { type: 'string', 'x-entity': { index: true } };
    // The allOf spelling is present on both sides; only the mapping directive changes.
    const from = structuredClone(before);
    if (indirect) from.entities.Record.schema.properties.value = { allOf: [{ type: 'string' }, {}] };
    const plan = planModelMigration(from, after, { dialect: sqliteDialect, id: 'mapping' });
    assert.deepEqual(plan.report.schemaChanged, []);
    assert.deepEqual(plan.report.drafts, []);
    assert.equal(plan.migration.steps.some((step) => step.kind === 'ddl'), true);
  }
});

for (const name of ['ordinary-annotation', '__proto__'])
  it(`keeps own schema annotation ${name} without changing its prototype`, () => {
    const input = model(name, true), snapshot = JSON.stringify(input);
    const plan = planModelMigration(input, input, { dialect: sqliteDialect, id: 'annotation' });
    assert.deepEqual(plan.migration.steps, []);
    const endpoint = JSON.parse(plan.migration.identity.from).entities.Record.schema;
    assert.equal(Object.hasOwn(endpoint, name), true);
    assert.deepEqual(endpoint[name], { annotation: true });
    assert.equal(Object.getPrototypeOf(endpoint), Object.prototype);
    assert.equal(Object.getPrototypeOf(input.entities.Record.schema), Object.prototype);
    assert.equal(JSON.stringify(input), snapshot);
  });

const literalSchemas = {
  const: { type: 'object', const: { 'x-entity': 7 } },
  enum: { type: 'object', enum: [{ 'x-entity': 7 }] },
  default: { type: 'object', default: { 'x-entity': 7 } },
  examples: { type: 'object', examples: [{ 'x-entity': 7 }] },
  annotation: { type: 'object', 'x-note': { 'x-entity': 7, items: { 'x-entity': 8 } } },
  properties: { type: 'object', properties: { 'x-entity': { type: 'string' } } },
  patternProperties: { type: 'object', patternProperties: { 'x-entity': { type: 'string' } } },
  dependencies: { type: 'object', dependencies: { 'x-entity': ['x-rename'] } },
  dependentRequired: { type: 'object', dependentRequired: { 'x-entity': ['x-rename'] } },
};
for (const [context, schema] of Object.entries(literalSchemas))
  it(`accepts x-entity data in ${context} without treating it as a mapping directive`, async () => {
    const input = model('payload');
    input.entities.Record.schema.properties.payload = schema;
    const snapshot = JSON.stringify(input);
    const driver = process.versions.bun ? (await import('@jarenjs/db/bun')).bunDriver()
      : (await import('@jarenjs/db/node')).nodeDriver();
    const connection = await driver.open(':memory:');
    try { await createModelShape(connection, input); }
    finally { await connection.close(); }
    const plan = planModelMigration(input, input, { dialect: sqliteDialect, id: 'literal-data' });
    assert.deepEqual(plan.migration.steps, []);
    assert.deepEqual(plan.report.schemaChanged, []);
    assert.deepEqual(JSON.parse(plan.migration.identity.from).entities.Record.schema.properties.payload, schema);
    assert.deepEqual(fromPlanned(plan.migration, { from: input, to: input }).document, plan.migration);
    assert.equal(JSON.stringify(input), snapshot);
  });

it('retains nested data member names while refusing real unread mapping blocks at their exact paths', () => {
  const block = { type: 'string', 'x-entity': { index: true } };
  const cases = [
    [{ properties: { 'x-entity': block } }, 'properties/x-entity'],
    [{ patternProperties: { 'x-entity': block } }, 'patternProperties/x-entity'],
    [{ dependentSchemas: { 'x-entity': block } }, 'dependentSchemas/x-entity'],
    [{ dependencies: { 'x-entity': block } }, 'dependencies/x-entity'],
    [{ items: block }, 'items'],
    [{ items: [block] }, 'items/0'],
    [{ prefixItems: [block] }, 'prefixItems/0'],
    [{ additionalItems: block }, 'additionalItems'],
    [{ contains: block }, 'contains'],
    [{ unevaluatedItems: block }, 'unevaluatedItems'],
    [{ additionalProperties: block }, 'additionalProperties'],
    [{ propertyNames: block }, 'propertyNames'],
    [{ unevaluatedProperties: block }, 'unevaluatedProperties'],
    [{ not: block }, 'not'],
    [{ oneOf: [block] }, 'oneOf/0'],
    [{ anyOf: [block] }, 'anyOf/0'],
    [{ if: block }, 'if'],
    [{ then: block }, 'then'],
    [{ else: block }, 'else'],
    [{ contentSchema: block }, 'contentSchema'],
    [{ $defs: { unused: block } }, '$defs/unused'],
    [{ definitions: { unused: block } }, 'definitions/unused'],
    [{ allOf: [{ items: block }] }, 'allOf/0/items'],
    [{ properties: { nested: { $defs: { named: block } } } }, 'properties/nested/$defs/named'],
  ];
  for (const [schema, location] of cases) {
    const input = model('payload');
    input.entities.Record.schema.properties.payload = { type: 'object', ...schema };
    const check = (error) => {
      assert.equal(error.code, 'JD0030', String(location));
      assert.equal(error.docPath, `/entities/Record/schema/properties/payload/${location}/x-entity`);
      assert.match(error.message, /a nested block is never read/);
      return true;
    };
    assert.throws(() => normalizeEntities(input), check);
    assert.throws(() => planModelMigration(input, input, { dialect: sqliteDialect, id: 'unread' }), check);
  }
});
