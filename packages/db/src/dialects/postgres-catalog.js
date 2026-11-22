//@ts-check
/** Source-preserving PostgreSQL catalog inventory. OIDs join catalog rows but
 * never become portable object identities or serialized migration checksums. */
import { postgresDependencies } from './postgres-dependencies.js';

/** Every object is scoped by its namespace; source programs stay native SQL.
 * @param {string} namespace - trusted SQL predicate over n.nspname
 * @returns {string} */
export function postgresCatalog(namespace) {
  return `WITH relations AS (
    SELECT c.*, n.nspname AS schema FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE ${namespace}
  ), ${postgresDependencies(namespace)}, objects AS (
    SELECT 'schema' AS type,n.nspname::text AS name,n.nspname::text AS owner,n.nspname::text AS schema,NULL::text AS sql,
      pg_catalog.jsonb_build_object('owner',pg_catalog.pg_get_userbyid(n.nspowner),'acl',n.nspacl::text,
        'encoding',pg_catalog.pg_encoding_to_char(d.encoding),'collation',d.datcollate,'ctype',d.datctype,
        'localeProvider',d.datlocprovider,'collationVersion',d.datcollversion) AS metadata
    FROM pg_catalog.pg_namespace n CROSS JOIN pg_catalog.pg_database d
    WHERE ${namespace} AND d.datname=current_database()
    UNION ALL
    SELECT 'dependency',pg_catalog.jsonb_build_array(dependent,referenced,deptype)::text,owner,schema,external_sql,
      pg_catalog.jsonb_build_object('dependent',dependent,'referenced',referenced,'kind',deptype,
        'referencedSql',referenced_sql,'extension',extension_name,'extensionVersion',extension_version,'extensionSchema',extension_schema)
    FROM edges
    UNION ALL
    SELECT CASE WHEN c.relkind IN ('v','m') THEN 'view' ELSE 'table' END AS type,
      c.relname AS name, c.relname AS owner, c.schema,
      CASE WHEN c.relkind IN ('v','m') THEN pg_catalog.pg_get_viewdef(c.oid, true) ELSE NULL END AS sql,
      pg_catalog.jsonb_build_object('kind',c.relkind,'owner',pg_catalog.pg_get_userbyid(c.relowner),
        'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,'persistence',c.relpersistence,
        'partition',pg_catalog.pg_get_expr(c.relpartbound,c.oid),'partitionKey',pg_catalog.pg_get_partkeydef(c.oid),'options',c.reloptions,
        'inherits',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('schema',pn.nspname,'name',pc.relname) ORDER BY h.inhseqno)
          FROM pg_catalog.pg_inherits h JOIN pg_catalog.pg_class pc ON pc.oid=h.inhparent
          JOIN pg_catalog.pg_namespace pn ON pn.oid=pc.relnamespace WHERE h.inhrelid=c.oid),
        'acl',c.relacl::text,'replicaIdentity',c.relreplident,'accessMethod',am.amname) AS metadata
    FROM relations c LEFT JOIN pg_catalog.pg_am am ON am.oid=c.relam
    WHERE c.relkind IN ('r','p','v','m','f')
    UNION ALL
    SELECT 'column', a.attname, c.relname, c.schema, pg_catalog.pg_get_expr(d.adbin,d.adrelid),
      pg_catalog.jsonb_build_object('ordinal',a.attnum,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),
        'typeSchema',tn.nspname,'typeName',t.typname,'typeKind',t.typtype,
        'nullable',NOT a.attnotnull,'identity',a.attidentity,'generated',a.attgenerated,
        'collationSchema',cn.nspname,'collation',co.collname,'collationDeterministic',co.collisdeterministic,
        'storage',a.attstorage,'compression',a.attcompression,'acl',a.attacl::text)
    FROM relations c JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
    JOIN pg_catalog.pg_type t ON t.oid=a.atttypid JOIN pg_catalog.pg_namespace tn ON tn.oid=t.typnamespace
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation
    LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=co.collnamespace
    WHERE c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped
    UNION ALL
    SELECT 'constraint', k.conname, c.relname, c.schema, pg_catalog.pg_get_constraintdef(k.oid,true),
      pg_catalog.jsonb_build_object('kind',k.contype,'deferrable',k.condeferrable,
        'initiallyDeferred',k.condeferred,'validated',k.convalidated,'noInherit',k.connoinherit,
        'columns',(SELECT pg_catalog.jsonb_agg(a.attname ORDER BY part.ord)
          FROM unnest(k.conkey) WITH ORDINALITY part(num,ord)
          JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=part.num),
        'targetSchema',tn.nspname,'targetTable',tc.relname,
        'targetColumns',(SELECT pg_catalog.jsonb_agg(a.attname ORDER BY part.ord)
          FROM unnest(k.confkey) WITH ORDINALITY part(num,ord)
          JOIN pg_catalog.pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=part.num))
    FROM relations c JOIN pg_catalog.pg_constraint k ON k.conrelid=c.oid
    LEFT JOIN pg_catalog.pg_class tc ON tc.oid=k.confrelid
    LEFT JOIN pg_catalog.pg_namespace tn ON tn.oid=tc.relnamespace
    UNION ALL
    SELECT 'index', ci.relname, c.relname, c.schema, pg_catalog.pg_get_indexdef(i.indexrelid),
      pg_catalog.jsonb_build_object('method',am.amname,'unique',i.indisunique,'primary',i.indisprimary,
        'exclusion',i.indisexclusion,'valid',i.indisvalid,'ready',i.indisready,
        'nullsNotDistinct',i.indnullsnotdistinct,'keyCount',i.indnkeyatts,'options',ci.reloptions,
        'predicate',pg_catalog.pg_get_expr(i.indpred,i.indrelid),
        'expressions',pg_catalog.pg_get_expr(i.indexprs,i.indrelid),
        'opclasses',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'schema',ns.nspname,'name',op.opcname,'default',op.opcdefault) ORDER BY part.ord)
          FROM unnest(i.indclass::oid[]) WITH ORDINALITY part(id,ord)
          JOIN pg_catalog.pg_opclass op ON op.oid=part.id JOIN pg_catalog.pg_namespace ns ON ns.oid=op.opcnamespace))
    FROM relations c JOIN pg_catalog.pg_index i ON i.indrelid=c.oid
    JOIN pg_catalog.pg_class ci ON ci.oid=i.indexrelid JOIN pg_catalog.pg_am am ON am.oid=ci.relam
    UNION ALL
    SELECT 'trigger', t.tgname, c.relname, c.schema, pg_catalog.pg_get_triggerdef(t.oid,true),
      pg_catalog.jsonb_build_object('enabled',t.tgenabled,'deferrable',t.tgdeferrable,
        'initiallyDeferred',t.tginitdeferred,'functionSchema',pn.nspname,'function',p.proname,
        'arguments',pg_catalog.pg_get_function_identity_arguments(p.oid))
    FROM relations c JOIN pg_catalog.pg_trigger t ON t.tgrelid=c.oid
    JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace
    WHERE NOT t.tgisinternal
    UNION ALL
    SELECT 'policy', p.polname, c.relname, c.schema, NULL,
      pg_catalog.jsonb_build_object('command',p.polcmd,'permissive',p.polpermissive,
        'roles',(SELECT pg_catalog.jsonb_agg(CASE WHEN role=0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(role) END ORDER BY role)
          FROM unnest(p.polroles) role),
        'using',pg_catalog.pg_get_expr(p.polqual,p.polrelid),
        'check',pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid))
    FROM relations c JOIN pg_catalog.pg_policy p ON p.polrelid=c.oid
    UNION ALL
    SELECT 'sequence', c.relname, COALESCE(tc.relname,c.relname), c.schema, NULL,
      pg_catalog.jsonb_build_object('type',pg_catalog.format_type(s.seqtypid,NULL),
        'start',s.seqstart::text,'increment',s.seqincrement::text,'min',s.seqmin::text,'max',s.seqmax::text,
        'cache',s.seqcache::text,'cycle',s.seqcycle,'owner',pg_catalog.pg_get_userbyid(c.relowner),
        'tableSchema',tn.nspname,'table',tc.relname,'column',a.attname,'dependency',d.deptype,'acl',c.relacl::text)
    FROM relations c JOIN pg_catalog.pg_sequence s ON s.seqrelid=c.oid
    LEFT JOIN pg_catalog.pg_depend d ON d.classid='pg_catalog.pg_class'::regclass AND d.objid=c.oid
      AND d.refclassid='pg_catalog.pg_class'::regclass AND d.deptype IN ('a','i')
    LEFT JOIN pg_catalog.pg_class tc ON tc.oid=d.refobjid
    LEFT JOIN pg_catalog.pg_namespace tn ON tn.oid=tc.relnamespace
    LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=d.refobjid AND a.attnum=d.refobjsubid
    UNION ALL
    SELECT 'function', p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')',
      p.proname, n.nspname, CASE WHEN p.prokind IN ('f','p') THEN pg_catalog.pg_get_functiondef(p.oid) ELSE NULL END,
      pg_catalog.jsonb_build_object('kind',p.prokind,'language',l.lanname,
        'owner',pg_catalog.pg_get_userbyid(p.proowner),'securityDefiner',p.prosecdef,
        'volatility',p.provolatile,'parallel',p.proparallel,'config',p.proconfig,'acl',p.proacl::text,
        'extension',(SELECT e.extname FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_extension e ON e.oid=d.refobjid
          WHERE d.classid='pg_catalog.pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e'))
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE ${namespace}
    UNION ALL
    SELECT 'type', t.typname, t.typname, n.nspname, NULL,
      pg_catalog.jsonb_build_object('kind',t.typtype,'owner',pg_catalog.pg_get_userbyid(t.typowner),
        'base',pg_catalog.format_type(t.typbasetype,t.typtypmod),'notNull',t.typnotnull,'default',t.typdefault,
        'constraints',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',k.conname,
          'sql',pg_catalog.pg_get_constraintdef(k.oid,true),'validated',k.convalidated) ORDER BY k.conname)
          FROM pg_catalog.pg_constraint k WHERE k.contypid=t.oid),
        'attributes',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',a.attname,
          'type',pg_catalog.format_type(a.atttypid,a.atttypmod)) ORDER BY a.attnum)
          FROM pg_catalog.pg_attribute a WHERE a.attrelid=t.typrelid AND a.attnum>0 AND NOT a.attisdropped),
        'range',(SELECT pg_catalog.jsonb_build_object('subtype',pg_catalog.format_type(r.rngsubtype,NULL),
          'multirange',pg_catalog.format_type(r.rngmultitypid,NULL),'collation',r.rngcollation::regcollation::text,
          'canonical',r.rngcanonical::regprocedure::text,'difference',r.rngsubdiff::regprocedure::text,
          'opclassSchema',ons.nspname,'opclass',op.opcname)
          FROM pg_catalog.pg_range r JOIN pg_catalog.pg_opclass op ON op.oid=r.rngsubopc
          JOIN pg_catalog.pg_namespace ons ON ons.oid=op.opcnamespace WHERE r.rngtypid=t.oid OR r.rngmultitypid=t.oid),
        'enum',(SELECT pg_catalog.jsonb_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_catalog.pg_enum e WHERE e.enumtypid=t.oid),
        'extension',(SELECT e.extname FROM pg_catalog.pg_depend d JOIN pg_catalog.pg_extension e ON e.oid=d.refobjid
          WHERE d.classid='pg_catalog.pg_type'::regclass AND d.objid=t.oid AND d.deptype='e'))
    FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
    WHERE ${namespace} AND (t.typrelid=0 OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=t.typrelid AND c.relkind='c')) AND t.typelem=0
  ) SELECT type,name,owner,schema,sql,metadata::text AS metadata FROM objects ORDER BY schema,type,owner,name`;
}

/** How the reading session spells a backslash in a plain string, as the dialect's per-table reads report it. */
const CONFORMING = "(SELECT s.setting FROM pg_settings AS s WHERE s.name = 'standard_conforming_strings')";

/** An index's shape apart from each key's order, as a model declares one: a
 * B-tree keyed under its columns' own collations and their types' default
 * operator classes, every column a key (an INCLUDE column is carried, not
 * keyed), nulls distinct, checked at once — what the plan creates. A plain
 * index also keys every column ascending, `NULLS LAST`. */
export const INDEX_SHAPE = "am.amname = 'btree' AND NOT i.indnullsnotdistinct AND i.indimmediate AND i.indnkeyatts = i.indnatts "
  + 'AND NOT EXISTS (SELECT 1 FROM unnest(i.indclass::oid[]) AS c(opclass) '
  + 'JOIN pg_opclass oc ON oc.oid = c.opclass WHERE NOT oc.opcdefault) '
  + 'AND NOT EXISTS (SELECT 1 FROM unnest(i.indcollation::oid[], i.indkey::int2[]) AS k(coll, attnum) '
  + 'JOIN pg_attribute ka ON ka.attrelid = i.indrelid AND ka.attnum = k.attnum WHERE k.coll <> ka.attcollation)';

/**
 * PostgreSQL's catalog reads over a set of tables at once: each answers the
 * rows its per-table twin in the dialect's `introspect` answers, in the same
 * order and the same columns, for every table `$1` (a JSON array of names)
 * lists, each row led by the table it belongs to (`jaren_owner`; the index
 * for an index's own reads). One plain query each, where the per-table reads
 * took one each per table.
 * @param {string} namespace - trusted SQL predicate over n.nspname
 * @returns {Readonly<Record<string, () => string>>}
 */
export function postgresNamespaceReads(namespace) {
  const wanted = (/** @type {string} */ relation) => `${relation}.relname IN (SELECT pg_catalog.jsonb_array_elements_text($1::jsonb))`;
  const action = (/** @type {string} */ column) => `CASE ${column} `
    + "WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' "
    + "WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' ELSE 'NO ACTION' END";
  return Object.freeze({
    tableExists: () =>
      'SELECT c.relname AS jaren_owner, c.relname AS name, (SELECT k.conname FROM pg_constraint k '
      + `WHERE k.conrelid = c.oid AND k.contype = 'p') AS "key" FROM pg_class c `
      + 'JOIN pg_namespace n ON n.oid = c.relnamespace '
      + `WHERE c.relkind IN ('r', 'p') AND ${namespace} AND ${wanted('c')}`,
    columns: () =>
      'SELECT c.relname AS jaren_owner, a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, '
      + "CASE WHEN a.attgenerated <> '' THEN 1 ELSE 0 END AS hidden, "
      + 'CASE WHEN a.attnotnull THEN 1 ELSE 0 END AS not_null, '
      + 'pg_get_expr(d.adbin, d.adrelid) AS default_value, n.nspname AS schema, '
      + "CASE a.attidentity WHEN 'a' THEN 'always' WHEN 'd' THEN 'by-default' ELSE '' END AS identity, "
      + 'a.attgenerated AS generated_kind, ty.typtype AS type_kind, tn.nspname AS type_schema, ty.typname AS type_name, '
      + `co.collname AS collation, ${CONFORMING} AS conforming `
      + 'FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid '
      + 'JOIN pg_type ty ON ty.oid = a.atttypid JOIN pg_namespace tn ON tn.oid = ty.typnamespace '
      + 'LEFT JOIN pg_collation co ON co.oid = a.attcollation '
      + 'LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum '
      + 'JOIN pg_namespace n ON n.oid = c.relnamespace '
      + `WHERE ${wanted('c')} AND ${namespace} `
      + 'AND a.attnum > 0 AND NOT a.attisdropped ORDER BY c.relname, a.attnum',
    indexes: () =>
      'SELECT ct.relname AS jaren_owner, ci.relname AS name, CASE WHEN i.indisunique THEN 1 ELSE 0 END AS uniq, '
      + "CASE WHEN i.indisprimary THEN 'pk' ELSE 'c' END AS origin, "
      + 'CASE WHEN i.indpred IS NULL THEN 0 ELSE 1 END AS partial, '
      + 'pg_get_expr(i.indpred, i.indrelid) AS predicate, '
      + `${CONFORMING} AS conforming, `
      + `CASE WHEN ${INDEX_SHAPE} AND NOT EXISTS (SELECT 1 FROM unnest(i.indoption::int2[]) AS o(flags) WHERE o.flags <> 0) `
      + 'THEN 1 ELSE 0 END AS plain, '
      // the same index but for each key's order (`key_options`, the engine's
      // flags per key: 0 ascending, 2 ascending `NULLS FIRST`), which an index
      // the store creates `ordered` keys its columns by
      + `CASE WHEN ${INDEX_SHAPE} THEN 1 ELSE 0 END AS shaped, `
      + "pg_catalog.array_to_string(i.indoption::int2[], ',') AS key_options "
      + 'FROM pg_index i JOIN pg_class ci ON ci.oid = i.indexrelid JOIN pg_am am ON am.oid = ci.relam '
      + 'JOIN pg_class ct ON ct.oid = i.indrelid '
      + 'JOIN pg_namespace n ON n.oid = ct.relnamespace '
      + `WHERE ${wanted('ct')} AND ${namespace} `
      + 'ORDER BY ct.relname, ci.relname',
    indexColumns: () =>
      'SELECT ci.relname AS jaren_owner, a.attname AS name FROM pg_index i '
      + 'JOIN pg_class ci ON ci.oid = i.indexrelid '
      + 'JOIN pg_namespace n ON n.oid = ci.relnamespace '
      + 'JOIN pg_class ct ON ct.oid = i.indrelid '
      + 'CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord) '
      + 'LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum '
      + `WHERE ${wanted('ct')} AND ${namespace} ORDER BY ci.relname, k.ord`,
    indexKeyColumns: () =>
      'SELECT ci.relname AS jaren_owner, a.attname AS name, pg_get_indexdef(i.indexrelid, k.ord::int, false) AS term, '
      + '(SELECT co.collisdeterministic FROM pg_collation co WHERE co.oid = i.indcollation[(k.ord - 1)::int]) AS deterministic FROM pg_index i '
      + 'JOIN pg_class ci ON ci.oid = i.indexrelid '
      + 'JOIN pg_namespace n ON n.oid = ci.relnamespace '
      + 'JOIN pg_class ct ON ct.oid = i.indrelid '
      + 'CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord) '
      + 'LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum '
      + `WHERE ${wanted('ct')} AND ${namespace} AND k.ord <= i.indnkeyatts ORDER BY ci.relname, k.ord`,
    generated: () =>
      'SELECT c.relname AS jaren_owner, a.attname AS name, pg_get_expr(d.adbin, d.adrelid) AS expression '
      + 'FROM pg_attrdef d '
      + 'JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum '
      + 'JOIN pg_class c ON c.oid = d.adrelid '
      + 'JOIN pg_namespace n ON n.oid = c.relnamespace '
      + `WHERE ${wanted('c')} AND ${namespace} `
      + "AND a.attgenerated <> '' ORDER BY c.relname, a.attnum",
    checks: () =>
      'SELECT ct.relname AS jaren_owner, c.conname AS name, pg_get_expr(c.conbin, c.conrelid) AS expression, '
      + 'CASE WHEN c.convalidated THEN 1 ELSE 0 END AS validated, '
      + `${CONFORMING} AS conforming, `
      + 'EXISTS (SELECT 1 FROM pg_attribute ca JOIN pg_collation co ON co.oid = ca.attcollation '
      + 'WHERE ca.attrelid = c.conrelid AND ca.attnum = ANY(c.conkey) '
      + 'AND NOT co.collisdeterministic) AS unsafe_collation '
      + 'FROM pg_constraint c JOIN pg_class ct ON ct.oid = c.conrelid '
      + 'JOIN pg_namespace n ON n.oid = ct.relnamespace '
      + `WHERE c.contype = 'c' AND ${wanted('ct')} AND ${namespace} `
      + 'ORDER BY ct.relname, c.conname',
    foreignKeyList: () =>
      'SELECT ct.relname AS jaren_owner, tt.relname AS target, sa.attname AS source_column, '
      + `ta.attname AS target_column, ${action('c.confdeltype')} AS on_delete, `
      + `${action('c.confupdtype')} AS on_update, c.conname AS id, k.ord - 1 AS seq `
      + 'FROM pg_constraint c JOIN pg_class ct ON ct.oid = c.conrelid '
      + 'JOIN pg_namespace n ON n.oid = ct.relnamespace '
      + 'JOIN pg_class tt ON tt.oid = c.confrelid '
      + 'CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS k(src, tgt, ord) '
      + 'JOIN pg_attribute sa ON sa.attrelid = c.conrelid AND sa.attnum = k.src '
      + 'JOIN pg_attribute ta ON ta.attrelid = c.confrelid AND ta.attnum = k.tgt '
      + `WHERE c.contype = 'f' AND ${wanted('ct')} AND ${namespace} `
      + 'ORDER BY ct.relname, c.conname, k.ord',
  });
}
