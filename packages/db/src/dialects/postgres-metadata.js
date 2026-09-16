//@ts-check
/** Catalog verification shared by engine-owned PostgreSQL tables. */

/** Verify engine-owned infrastructure without creating or repairing it.
 * @param {any} connection @param {any} schema @param {string} label @returns {Promise<any[]>} */
export async function verifyPostgresTables(connection, schema, label) {
  const dialect = connection.dialect;
  const namespace = (await (await connection.prepare('SELECT current_schema() AS name')).get()).name;
  const rows = await (await connection.prepare(dialect.introspect.catalog())).all();
  const objects = rows.filter((row) => row.schema === namespace)
    .map((row) => ({ ...row, metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata }));
  for (const table of schema.tables) {
    const owned = objects.filter((row) => row.owner === table.name);
    const relation = owned.find((row) => row.type === 'table' && row.name === table.name);
    const columns = owned.filter((row) => row.type === 'column');
    const key = owned.find((row) => row.type === 'constraint' && row.metadata.kind === 'p');
    if (relation?.metadata.kind !== 'r' || columns.length !== table.columns.length
      || JSON.stringify(key?.metadata.columns) !== JSON.stringify(table.keys)
      || key.metadata.deferrable || !key.metadata.validated)
      throw new Error(`existing ${label} table ${table.name} needs an explicit schema migration`);
    for (const [name, type, constraints] of table.columns) {
      const column = columns.find((row) => row.name === name);
      const m = column?.metadata;
      const expectedDefault = constraints.includes('DEFAULT ') ? constraints.split('DEFAULT ')[1] : null;
      const actualDefault = column?.sql?.replace(/::(?:text|numeric)$/, '') ?? null;
      if (!m || dialect.comparableColumnType(m.type) !== dialect.comparableColumnType(type)
        || m.typeKind !== 'b' || m.generated || m.identity
        || m.nullable !== !(constraints.includes('NOT NULL') || table.keys.includes(name))
        || actualDefault !== expectedDefault || (type.startsWith('TEXT') && m.collation !== 'C'))
        throw new Error(`existing ${label} column ${table.name}.${name} needs an explicit schema migration`);
    }
    const primary = owned.find((row) => row.type === 'index' && row.metadata.primary);
    if (!primary?.metadata.valid || !primary.metadata.ready)
      throw new Error(`existing ${label} primary key ${table.name} is unavailable`);
  }
  return objects;
}
